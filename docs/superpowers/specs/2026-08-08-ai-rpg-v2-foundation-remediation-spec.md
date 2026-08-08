# AI RPG v2 架构底座修复 Spec

> 文档版本：v1.0  
> 日期：2026-08-08  
> 状态：审查完成，待确认并拆分实现 Plan  
> 修改仓库：仅 `ai-rpg-game`（`sharedInfrastructureChangeAllowed: false`，零 foundation 改动）  
> 上游目标架构：`docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md`  
> 产品参考：`docs/设想/AI实时演算RPG_核心规则与运行架构总纲_v0.1.md`  
> 文档定位：对 v2 目标架构和当前实现进行底座级修正。发生冲突时，本 Spec 在本次修复范围内优先。

---

## 1. 背景与结论

v2 已经建立了正确的主要方向：World State / Story State 双状态、规则独占正式事实、AI 候选需要审批、CAS 防并发重复、异步场景生成、NPC 结构化记忆和不预生成剧情树。

但当前架构还缺少连接这些模块的核心因果对象：

- 一次玩家操作没有被持久化为完整的“回合结果”；
- 异步 SceneGenerator 无法恢复本次真实 Action、玩家原话和 ResolvedEvent；
- 两个固定 NPC 选项缺少可区分的规则语义；
- 自定义 NPC 输入绕过 ActionConverter 和 RuleEngine；
- AI 事件提议只有描述，没有可审批、可执行的领域效果；
- 开局世界契约不足以生成和验证一条可完成、多结局的剧情图。

因此当前 v2 可能做到“每次生成的文字不同”，但不能保证“玩家不同选择造成不同的结构化世界历史和后续可用行动”。在修复本 Spec 的 P0 项之前，不应继续扩展 Prompt、NPC 数量、地图规模、美术资产或更多上层玩法。

---

## 2. 产品目标与成功定义

### 2.1 核心玩家循环

NPC 对话场景默认向玩家提供：

1. 两个经服务端审批的固定对话选择；
2. 一个自定义文本输入入口；
3. 每次选择都进入同一条回合流水线；
4. 规则结果提交后，由 AI 生成紧扣该结果的下一场景；
5. 新场景继续提供新的固定选择和自定义输入，直到故事进入可解释的结局。

世界行动场景可以提供移动、调查、取得物品、战斗、休息等固定选择，但同样必须使用统一回合流水线。

### 2.2 “每局故事不同”的可验证定义

故事差异不能只依赖模型措辞或随机采样。对于相同开局 seed：

- 玩家选择不同的固定选项后，最迟在当前回合提交时产生不同的结构化回合记录；
- 差异必须进入以下至少一项：领域事件、NPC 记忆/关系、已知事实、任务状态、资源状态、候选事件、伏笔、后续合法行动或结局资格；
- 后续 SceneGenerator 必须读取这份差异，而不是重新猜测玩家刚才做了什么；
- 回放同一 Interaction 序列时，规则状态和领域事件必须确定性一致；
- AI 表达可以变化，但不得改变规则已确认的事实。

### 2.3 非目标

本 Spec 不要求：

- 无限开放世界；
- 每个 NPC 独立常驻 Agent；
- 多 Agent 每回合协商；
- 复杂经济、技能、装备或随机战斗；
- 图片、语音或流式 UI；
- 迁移旧 v1 GameState + ScenarioBlueprint 存档；
- 在本阶段抽取新的 `@ai-game/*` 共享 package。

---

## 3. 当前问题总表

| 优先级 | 问题 | 当前后果 | 主要位置 |
|---|---|---|---|
| P0 | 异步场景丢失本回合因果 | SceneGenerator 收到伪造的 `success + observe`，行动类型、失败状态和玩家原话丢失 | `performActionV2.ts`、`generatePendingSceneV2.ts` |
| P0 | 自定义 NPC 输入绕过主流水线 | 不经过 ActionConverter、RuleEngine、NPC 记忆和事件账本；玩家文本没有可靠进入 AI 场景 | `handleNpcDialogueV2.ts` |
| P0 | 固定对话选项缺少规则语义 | “相信/质疑/威胁”可能都退化为同一个 `talk { npcId }`，形成伪选择 | `domain/action.ts`、`resolveByType.ts` |
| P0 | AI 候选事件不可执行 | 审批只消耗预算并增加张力，不产生正式领域事件或世界变化 | `approveCandidateEvents.ts` |
| P0 | 开局契约不足且默认主线可能不可达 | 世界源不生成事实/任务图/敌人/结局知识；第二地点被锁定但任务要求访问 | `createGameV2.ts`、`v2SourceFactory.ts` |
| P0 | 行动提交和叙事 pending 分成两次 CAS | 世界已改变但 pending 写入失败时，本回合没有对应场景 | `performActionV2.ts` |
| P0 | Expansion 成功路径不排队场景 | 世界扩展和动作成功后直接返回，叙事链断裂 | `performActionV2.ts` |
| P1 | `actionKey` 暴露客户端且由 AI 自由生成 | 选项文案可能与真实 Action 不一致；违反 opaque token 边界 | `gameSessionViewV2.ts`、`viewAdapterV2.ts`、`v2SourceFactory.ts` |
| P1 | 生产 ExpansionSource 仍是 fixture | 开启 AI 后运行时世界扩展仍不是实时 AI 提议 | `compositionRootV2.ts`、`server/ai/expansionSource.ts` |
| P1 | Expansion 触发条件不完整 | 只处理实体不存在，未实现低张力、任务缺口、优先复用和预算耗尽收束 | `expansionTrigger.ts` |
| P1 | Expansion 应用不完整 | 新地点不解锁；新物品不挂到地点；批量 ID 可能冲突；重演算可能继续失败 | `approveExpansion.ts`、`applyExpansion.ts` |
| P1 | 故事推进与结局顺序不闭合 | 先检查结局、后更新幕和 endingAllowed；默认任务无 stage，可能无法进入目标幕 | `ruleEngine/index.ts`、`advanceStoryProgression.ts`、`resolveEnding.ts` |
| P1 | 任务 reconciliation 不处理完整图 | 完成任务后没有统一应用 `onSuccess` 解锁/收束，也缺少失败转换闭环 | `ruleEngine/reconcileQuests.ts` |
| P1 | NPC 记忆只覆盖粗粒度 talk | 重复 talk 仍可获得同类关系变化；自定义输入不进历史；对话立场没有结构化结果 | `resolveByType.ts`、`updateNpcMemory.ts` |
| P1 | NPC 知识隔离未进入 v2 场景 prompt | live 场景仅提供在场 NPC 名称和角色，没有 known/hidden/forbidden fact cards | `v2SourceFactory.ts` |
| P1 | Action 声明、服务端路由和 UI 词汇不一致 | union 已声明 use/give/interact/accept/narrative choice 等类型，但 validator/resolver/choice parser 未闭合；`attack`/`start_battle` 等命名也有漂移 | `domain/action.ts`、`validateAction.ts`、`resolveByType.ts`、`buildChoiceMap.ts`、`viewAdapterV2.ts` |
| P1 | 接受但无状态变化的行动没有领域记录 | explore/rest/freeform 可能返回 success，却不产生事件；rest 也未按 spec 降低张力，回放无法证明玩家做过什么 | `resolveByType.ts`、`updateStoryMetrics.ts` |
| P1 | AI 开局输出缺少完整规则校验 | 当前主要依赖类型断言和少量非空检查，引用错误可能进入正式 World State | `v2SourceFactory.ts`、`createGameV2.ts` |
| P1 | SceneSource 接口接收完整双状态 | 任意 source 都可读取无关事实和其他 NPC 私密知识，最小权限只靠实现自觉 | `sceneSource.ts` |
| P1 | 兜底场景不完全确定性 | `Date.now()` 参与 sceneId，破坏相同输入回放一致性 | `deterministicSceneSource.ts` |
| P1 | 回合号错误地借用 eventLedger 长度 | 一回合可产生多个事件，事件数不能代表 turn | `resolveByType.ts`、场景与候选事件生成逻辑 |
| P1 | 版本概念混用 | DB revision、schema version、eventLedger length 和 ResolvedEvent.stateVersion 未明确区分 | domain/application 多处 |
| P1 | Read model 可能泄露隐藏信息 | 未发现事实文本可能通过任务目标展示；同一场景选项被投影到所有 NPC | `gameSessionViewV2.ts`、`viewAdapterV2.ts` |
| P1 | API 输入校验不足 | route 对 Interaction 直接类型断言；未知 kind、空文本、超长文本可能进入用例 | `app/api/v2/game/actions/route.ts` |
| P2 | eventLedger 随整份 JSON 每回合重写 | 短篇可接受，长篇会产生 O(n) 状态写入和存档膨胀 | v2 SQLite repository |
| P2 | v1/v2 实现和 agent 文档长期并存 | 后续 Agent 容易修错链路或把旧实现事实当成 v2 事实 | `docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md` |
| P2 | 现有回归未验证故事分化和可结局 | 测试覆盖模块成功，但没有证明同 seed 分支分化、长链连续性和双结局可达 | v2 offline regression tests |

### 3.1 稳定需求编号

后续实现 Plan 和提交说明必须引用以下编号，避免只按文件拆任务而遗漏跨层闭环：

| 编号 | 必须实现的能力 |
|---|---|
| FND-01 | 真实 Action、规则结果和玩家原话通过 TurnResolution/PendingNarrativeJob 保持因果连续 |
| FND-02 | 固定选择与自定义输入统一进入 performTurn |
| FND-03 | NPC 固定选择具有规则可区分的 dialogueAct/topic 语义 |
| FND-04 | ApprovedChoice 服务端绑定，客户端只收到 opaque token |
| FND-05 | EventCandidate 经审批后编译为真实领域事件和状态变化 |
| FND-06 | 开局世界、任务图、地点解锁和多结局经过可达性验证 |
| FND-07 | 任务、幕、伏笔、节奏和结局按固定顺序在同一回合收敛 |
| FND-08 | NPC 记忆、知识传播和 SceneGenerationContext 满足最小权限 |
| FND-09 | Expansion 具备 live source、完整触发、复用、审批、应用和重演算闭环 |
| FND-10 | AI 世界/场景输出和 HTTP 输入均经过完整 schema/invariant 审批 |
| FND-11 | 单次规则 CAS、可恢复 pending、确定性 fallback 和明确版本语义 |
| FND-12 | 同 seed 分叉旅程证明结构化故事分化并可抵达不同结局 |

每个实现 Plan 必须说明覆盖哪些 FND 编号、哪些留给后续 Plan，并为本 Plan 覆盖的编号给出可运行的验收测试。

---

## 4. 根因：缺少回合事务模型

当前流水线把一次玩家操作拆散为：

```text
Action → next state → CAS
                  → 再次 CAS 写 pending
                  → ensure 时重新拼一个伪 ResolvedEvent
                  → SceneGenerator
```

正确的底层单位不应是零散的 Action、ResolvedEvent 或 Scene，而应是一个完整的 `TurnResolution`。它负责回答：

- 玩家做了什么；
- 规则认为结果是什么；
- 本回合产生了哪些有序领域事件；
- 哪些效果被拒绝；
- 哪些 AI 提议被批准；
- 新状态是什么；
- 异步叙事必须表现哪一组已确认事实。

本 Spec 将 `TurnResolution` 和 `PendingNarrativeJob` 作为 v2.1 的核心修正。

---

## 5. 修正后的顶层架构

### 5.1 主循环

```text
Interaction
→ ActionConverter
→ validateAction
→ resolveAction 初判
→ [条件触发] ExpansionProposer AI 提议
→ approveExpansion（纯规则）
→ [最多一次] 基于临时扩展状态重演算
→ reconcileQuests
→ updateNpcMemory / propagateKnownFacts
→ activateEligibleCandidateEvents
→ updateStoryProgression / pacing / ending eligibility
→ resolveEnding
→ TurnResolution
→ 单次 StateCommit CAS：World State + Story State + eventLedger + PendingNarrativeJob
→ SceneGenerator 异步读取 PendingNarrativeJob 的不可变上下文
→ approveScenePackage：事实、知识、选项和引用校验
→ SceneWriteBack CAS：currentScene + ApprovedChoiceRegistry + candidateEventPool，清除 pending job
→ Client 只获得展示数据和 opaque choiceToken
```

### 5.2 每回合 AI 调用预算

| 路径 | AI 调用 |
|---|---|
| 固定选择，无扩展 | 1 次 SceneGenerator |
| 固定选择，需要扩展 | 1 次 ExpansionProposer + 1 次 SceneGenerator |
| 自定义文本，可规则预分类 | 1 次 SceneGenerator |
| 自定义文本，需要模型解析 | 1 次轻量 ActionConverter + 1 次 SceneGenerator |
| 自定义文本且需要扩展 | ActionConverter + ExpansionProposer + SceneGenerator |

SceneGenerator 仍然是一次场景调用，不恢复 v1 的 Director/Writer/NPC 三次串行调用。

---

## 6. 核心状态和版本语义

### 6.1 四种版本/序号必须分离

| 字段 | 含义 | 更新时机 |
|---|---|---|
| `WorldState.version` | World State schema 版本 | 仅 schema 升级 |
| `StoryState.version` | Story State schema 版本 | 仅 schema 升级 |
| `GameRecord.revision` | 数据库 CAS 版本 | 每次合法写入 +1 |
| `StoryState.turnNumber` | 已提交的玩家回合数 | 每次成功提交一个 TurnResolution +1 |

禁止再使用 `eventLedger.length` 作为 turn 或 stateVersion。`ResolvedEvent.stateVersion` 应改名为 `basedOnRevision` 或从 ResolvedEvent 移除，由 `TurnResolution` 明确记录 `baseRevision` 和 `committedRevision`。

### 6.2 World State 内部的定义/运行时边界

World State 仍是唯一世界事实源，不恢复独立可变 Blueprint。但 Entity Entry 应显式区分定义与运行时字段，避免“定义不可变”只停留在约定：

```ts
type NpcEntry = {
  readonly definition: {
    readonly id: NpcId
    readonly name: string
    readonly role: string
    readonly description: string
    readonly tags: readonly string[]
    readonly hiddenFactIds: readonly FactId[]
  }
  readonly runtime: {
    readonly locationId: LocationId
    readonly alive: boolean
    readonly met: boolean
    readonly memory: NpcMemory
  }
}
```

地点、物品、敌人采用同类结构。运行时可变字段至少包括：NPC 当前地点/存活、地点当前可拾取物、物品所有权、敌人状态。已有定义字段只能通过明确的世界演化事件改变，不允许 application 直接散落地复制修改。

若第一阶段暂不执行完整字段迁移，也必须先引入集中纯函数 facade，禁止上层直接修改 Entry 内部字段。

### 6.3 Story State 新增回合与 pending job

```ts
type StoryState = {
  readonly version: 3
  readonly turnNumber: number
  // 既有节奏、预算、伏笔、候选池等字段
  readonly narrative: NarrativeRuntimeState
}

type NarrativeRuntimeState = {
  readonly mode: "ai" | "offline"
  readonly currentScene: NarrativeSceneState | null
  readonly generation:
    | { readonly status: "idle" }
    | {
        readonly status: "pending"
        readonly job: PendingNarrativeJob
      }
}
```

---

## 7. Interaction、Action 与对话语义

### 7.1 所有输入统一进入 Interaction

```ts
type Interaction =
  | {
      readonly kind: "fixed_choice"
      readonly choiceToken: string
    }
  | {
      readonly kind: "free_text"
      readonly text: string
      readonly targetNpcId?: NpcId
    }
```

NPC 自定义输入端点可以作为 HTTP 兼容入口保留，但其内部必须调用统一的 `performTurn`，不得直接写 narrative pending。

### 7.2 固定对话选项必须携带规则可识别的语义

```ts
type DialogueAct =
  | "ask"
  | "support"
  | "challenge"
  | "threaten"
  | "deceive"
  | "offer"
  | "refuse"
  | "reassure"

type TalkAction = {
  readonly type: "talk"
  readonly npcId: NpcId
  readonly dialogueAct: DialogueAct
  readonly topic?:
    | { readonly kind: "fact"; readonly factId: FactId }
    | { readonly kind: "quest"; readonly questId: QuestId }
    | { readonly kind: "thread"; readonly threadId: ThreadId }
    | { readonly kind: "general" }
  readonly utterance?: string
}
```

规则只读取 `dialogueAct`、topic、关系、知识和能力；`utterance` 只供叙事表现，不得声明结果。

### 7.3 自定义输入转换

自定义输入按以下顺序处理：

1. 校验长度、目标 NPC、当前场景和 revision；
2. 纯规则预分类；
3. 未命中时调用轻量 `IntentParserSource`；
4. 输出封闭 Action；
5. 无法归类时输出 `freeform`；
6. `freeform` 不产生实质世界效果，但必须产生一个结构化、无原文泄漏的 `player_intent_expressed` 回合事件，供当前场景回应和审计；
7. 玩家原文进入本回合 PendingNarrativeJob，场景写回后可丢弃；长期 NPC 记忆只保存规则生成的摘要，不保存无限原文。

生产 composition root 必须注入 live/fixture `IntentParserSource`，不能只在测试存在。

---

## 8. ApprovedChoice 与服务端选项注册表

### 8.1 AI 不得直接决定可执行 actionKey

SceneGenerator 可以：

- 从规则给出的合法候选中选择；
- 为候选生成自然语言标签；
- 对 NPC 对话提出结构化 `DialogueChoiceProposal`。

SceneGenerator 不可以：

- 自由构造客户端 actionKey；
- 引用不存在或当前不可用的实体；
- 用“救下孩子”的标签绑定 `explore`；
- 把未审批世界变化写入选项。

### 8.2 服务端结构

```ts
type ApprovedChoice = {
  readonly choiceToken: string
  readonly sceneId: string
  readonly basedOnRevision: number
  readonly label: string
  readonly action: Action
  readonly semanticSummary: string
}

type NarrativeSceneState = {
  // presentation fields
  readonly choices: readonly [
    Pick<ApprovedChoice, "choiceToken" | "label">,
    Pick<ApprovedChoice, "choiceToken" | "label">
  ]
  readonly choiceRegistry: readonly ApprovedChoice[] // server persistence only，不进入 read model
}
```

实际实现可把 registry 独立存于 narrative runtime，但必须与 sceneId 和 revision 绑定。消费后旧 token 因 revision/scene 不匹配而失效。

### 8.3 客户端契约

客户端只能获得：

```ts
type ChoiceView = {
  readonly choiceToken: string
  readonly label: string
  readonly hint?: string
}
```

必须从 `GameSessionViewV2` 移除 `actionKey`。客户端不得从字符串解析 Action，也不得把同一场景的两个选项无条件投影到所有 NPC。

---

## 9. TurnResolution 与原子 StateCommit

### 9.1 TurnResolution

```ts
type TurnResolution = {
  readonly turnId: string
  readonly actionId: string
  readonly baseRevision: number
  readonly turnNumber: number
  readonly interactionKind: Interaction["kind"]
  readonly action: Action
  readonly primaryResult: ResolvedEvent
  readonly domainEvents: readonly GameEvent[]
  readonly approvedExpansions: readonly ApprovedExpansion[]
  readonly activatedCandidateEvents: readonly ActivatedCandidateEvent[]
  readonly rejectedEffects: readonly RejectedEffect[]
  readonly nextWorldState: WorldState
  readonly nextStoryState: StoryState
}
```

`domainEvents` 是有序的完整事件列表；`primaryResult` 表达玩家行动结果。任务完成、关系变化、事实传播、候选事件激活和结局均应出现在 `domainEvents`，不能只放进字符串 `triggeredEvents`。

### 9.2 PendingNarrativeJob

```ts
type PendingNarrativeJob = {
  readonly jobId: string
  readonly turnId: string
  readonly actionId: string
  readonly basedOnRevision: number
  readonly turnNumber: number
  readonly actionSummary: StructuredActionSummary
  readonly utterance?: string
  readonly resolvedEvent: ResolvedEvent
  readonly domainEventRange: {
    readonly fromLedgerIndex: number
    readonly toLedgerIndexExclusive: number
  }
  readonly focusNpcId?: NpcId
  readonly requestedAt: string
}
```

PendingNarrativeJob 必须足以在进程重启后恢复场景生成，不能依赖内存缓存或重新推断。

`basedOnRevision` 表示包含该 job 的规则提交完成后的 revision，即 `expectedRevision + 1`。SceneWriteBack 默认只接受当前 record revision 与该值一致的结果；若发生白名单展示字段并发写入，必须执行显式安全 rebase，而不是模糊比较 eventLedger 长度。

### 9.3 单次规则写入

一次成功玩家回合只能有一次 StateCommit：

```text
CAS expectedRevision
→ World State 新状态
→ Story State 新状态（含 turnNumber + pending job）
→ eventLedger 追加
→ revision +1
```

不能先提交世界事实，再单独提交 pending。若无法建立 PendingNarrativeJob，则整次回合不提交。

`ack_prologue` 是幂等展示标记，可以继续作为例外写入，但必须与正在生成的 job 有明确 CAS/rebase 策略，不能造成永久 pending 或无界重复 AI 调用。

---

## 10. SceneGenerator 最小上下文与审批

### 10.1 SceneSource 不再接收完整 WorldState / StoryState

application 必须先构建最小 DTO：

```ts
type SceneGenerationContext = {
  readonly job: PendingNarrativeJob
  readonly playerSummary: PlayerSceneSummary
  readonly location: LocationSceneCard
  readonly publicWorldFacts: readonly FactCard[]
  readonly sceneVisibleFacts: readonly FactCard[]
  readonly presentNpcs: readonly NpcSceneContext[]
  readonly story: {
    readonly currentAct: number
    readonly targetActs: number
    readonly tension: number
    readonly nextPacingNeed: PacingNeed
    readonly remainingBudget: BudgetSummary
    readonly unresolvedThreadSummaries: readonly string[]
  }
  readonly recentBeats: readonly RecentBeat[]
  readonly legalActionCandidates: readonly LegalActionCandidate[]
  readonly worldConstraints: readonly string[]
}
```

### 10.2 NPC 最小知识上下文

每个 `NpcSceneContext` 只能包含：

- 该 NPC 的公开档案；
- 该 NPC 的 `knownFactIds` 对应事实卡；
- 该 NPC 自己的 hidden facts；
- 当前场景可见事实；
- 自己最近 N 条规则摘要；
- relationship、emotion、goals；
- 明确的 `forbiddenKnowledge` ID 列表或摘要。

不得包含其他 NPC 私密记忆、完整 World State、完整 eventLedger 或未授权秘密正文。

### 10.3 场景审批

AI 返回后必须经过纯审批：

1. schema、长度、枚举和引用校验；
2. narration/dialogue 与 ResolvedEvent 状态一致性；
3. NPC 使用事实必须属于其允许集合；
4. 选项必须映射合法候选，或通过 DialogueChoiceProposal 审批；
5. 两个选项不能语义重复；
6. 选项不得提前宣布成功结果；
7. EventCandidate 逐条校验；
8. 审批失败时整场使用确定性 fallback，不拼接半合法内容。

确定性 fallback 的 sceneId、choiceToken 必须从 jobId/turnId/seed 纯函数派生，禁止使用 `Date.now()` 或随机数。

---

## 11. AI 候选事件的正式生命周期

### 11.1 EventCandidate 必须结构化

```ts
type EventCandidate = {
  readonly id: EventCandidateId
  readonly kind:
    | "npc_reveals_fact"
    | "npc_changes_stance"
    | "hostile_force_acts"
    | "enemy_appears"
    | "thread_complicates"
    | "thread_resolves"
    | "location_state_changes"
  readonly involvedEntityIds: readonly string[]
  readonly prerequisiteFactIds: readonly FactId[]
  readonly proposedEffects: readonly ProposedEffect[]
  readonly intendedPacing: PacingNeed
  readonly reason: string
  readonly proposedAtTurn: number
  readonly expiresAtTurn: number
}
```

自由自然语言 `description` 可以保留用于诊断，但不能作为审批和执行的唯一依据。

### 11.2 审批与执行顺序

为了不让上一场景的候选事件使玩家刚点击的已批准选项突然失效，候选事件采用“玩家行动优先”的确定性顺序：

1. 先根据当前 revision 解析并裁决玩家选择；
2. 再从 candidateEventPool 中最多批准规定数量的反应事件；
3. 规则把批准候选编译为 `GameEvent[]` 和 next state；
4. 玩家行动与反应事件共同进入同一个 TurnResolution；
5. SceneGenerator 可以表现主行动和一个焦点反应，其余事件进入 recentBeats。

审批通过必须产生实际领域事件或明确的结构化状态变化。仅增加 tension 不算事件被执行。

### 11.3 候选池约束

- FIFO 上限 8；
- 每条有过期 turn；
- ID 去重；
- 每回合最多批准 1 条（MVP）；
- 预算不足、前提失效、实体死亡或信息冲突时明确拒绝；
- 批准、拒绝、过期均进入结构化审计事件；
- SceneWriteBack 只能追加候选，不能直接激活候选或修改 World State。

---

## 12. 世界初始化与可完成剧情图

### 12.1 WorldGenerationSource 完整输出

开局候选至少包含：

- 世界约束、公开事实和隐藏事实；
- 玩家定义与起始资源；
- 3–5 个主地点和可选隐藏地点；
- 4–6 个核心 NPC；
- 每个 NPC 的初始 known/hidden facts、goals；
- 物品、敌人和阵营；
- 与 `targetActs` 对应的主线任务骨架；
- 0–2 个支线；
- 至少两个语义不同的结局；
- 起始地点、起始 NPC、起始任务和主线 thread；
- 每条任务/结局引用的实体。

不能在 AI 生成后由 `createGameV2` 再硬编码一条与题材无关的默认主线作为正常路径。确定性 fallback 世界可以使用模板，但必须同样通过完整 validator。

### 12.2 开局 validator

进入正式状态前必须验证：

- ID 唯一；
- 所有引用存在；
- 地点图从起点可达；
- locked 地点有至少一个明确可达的解锁规则；
- 主线任务 stage 覆盖目标幕数或具有明确的 act 映射策略；
- 第一幕至少有一个可执行目标；
- 每个后续主线任务都有前置解锁路径；
- 任务目标可由现有实体或已声明的扩展槽满足；
- 至少两个结局条件可从任务图到达；
- NPC known/hidden facts 引用合法且不矛盾；
- opening 计数和 hard limit 合法；
- 玩家起始位置、背包和可行动作合法。

失败后允许一次机械修复或一次 AI 修复；仍失败必须进入已验证的确定性 fallback。

### 12.3 地点锁定和解锁

已生成但 locked 的地点不是 ExpansionProposer 的职责。必须有纯规则解锁机制，例如：

- 任务完成；
- 事实发现；
- NPC 提供路线；
- 物品/权限满足；
- 候选事件批准后产生 `location_unlocked`。

ExpansionProposer 只负责世界中尚不存在且确实无法复用的实体。

---

## 13. 任务、节奏和结局的固定顺序

### 13.1 单回合规则顺序

```text
resolve primary action
→ propagate facts / update NPC memory
→ reconcile quest objectives
→ apply quest onSuccess/onFailure（含解锁后续任务）
→ activate candidate events
→ update tension and story progress
→ advance currentAct
→ update unresolvedThreads
→ derive endingAllowed
→ resolve ending
→ derive nextPacingNeed
```

禁止在 `endingAllowed` 更新前调用 `resolveEnding`。

### 13.2 storyProgress

`storyProgress` 不应固定“每完成任意任务 +10”。应由主线 stage、已完成主线目标比例和关键事实覆盖率确定性推导。支线可以影响张力、关系和资源，但不能让玩家通过刷支线直接进入结局。

### 13.3 unresolvedThreads

- 开局 thread ID 必须与实际主线一致；
- 新 thread 只能由已批准事件或任务变化创建；
- thread 回收必须产生结构化事件；
- 不得出现初始化为 `main_thread`、后续却只删除 `act_1` 的命名不一致；
- `endingAllowed` 必须考虑强制 thread 和强制事件，而不是只看幕数和进度。

### 13.4 结局

- 结局 requirements 不得为空作为正常生成结果；
- 成功和失败结局都必须携带真实 outcome；
- 结局抵达后普通行动为空；
- 若最终行动同时满足结局条件，应在同一 TurnResolution 中抵达结局，不要求玩家再做一个无意义动作触发检查。

### 13.5 Action 集合和领域事件必须闭合

每个暴露在 `Action` union、ApprovedChoice 或客户端入口中的类型，都必须同时具备：

- 输入解析；
- choice registry 映射；
- validateAction 分支；
- resolver 分支；
- 领域事件；
- read model 表现；
- 单元和完整旅程测试。

暂未实现的 Action 不应提前出现在可生产选择集合中。命名必须统一，例如 v2 只能选择 `attack` 或 `start_battle` 其中一个作为正式 Action 名；战斗逃跑的 `flee`/`withdraw` 也只能在明确的 adapter 边界转换一次。

即使行动不产生实质世界变化，也必须留下安全、结构化的主事件：

- explore → `location_explored`；
- rest → `player_rested`，并按固定值更新 tension；
- freeform → `player_intent_expressed`，不保存越权效果或无限原文；
- blocked/invalid → 作为 TurnResolution 审计结果保存或返回，但不得伪装 success。

这样才能保证事件回放、故事分化判定和 SceneGenerator 因果上下文完整。

---

## 14. NPC 记忆、关系和知识传播

### 14.1 对话结果不能只看“是否 talk”

关系变化由以下结构化输入确定：

- 首次见面或重复交谈；
- `dialogueAct`；
- topic 是否属于 NPC known facts；
- 玩家是否说谎、威胁、帮助或交换资源；
- 当前关系档位和 NPC goals；
- 规则裁决结果。

重复点击同一 `talk` 不得持续获得首次见面奖励。

### 14.2 NpcInteraction

```ts
type NpcInteraction = {
  readonly turnNumber: number
  readonly actionId: string
  readonly locationId: LocationId
  readonly dialogueAct: DialogueAct | "freeform"
  readonly topicSummary: string
  readonly outcome: "positive" | "negative" | "neutral" | "mixed"
  readonly relationshipDelta: number
  readonly learnedFactIds: readonly FactId[]
  readonly summary: string // 规则生成，不是 AI 原文
}
```

历史保留最近 10 条；known/hidden facts 不裁剪。长期故事需要摘要时另行设计归档，不允许 AI 原文直接成为事实。

### 14.3 知识传播

FactChange 必须明确 audience 来源：

- 在场可见；
- 玩家明确告知；
- NPC 主动透露；
- 公共广播；
- 阵营共享。

不能简单把“当前地点所有已 met NPC”自动视为知道调查发现，除非事件定义其确实在场可见。

---

## 15. ExpansionProposer 修正

### 15.1 分层

- AI source 调用与条件编排属于 application；
- trigger 判定、优先复用、审批、ID 铸造、预算消耗和应用属于 pure gameplay；
- gameplay 不执行异步 AI 请求；
- server/ai 只实现 source adapter。

### 15.2 触发信号

必须实现：

1. 玩家目标实体不存在；
2. 持续低张力且没有可复用敌对势力；
3. 当前主线目标存在实体角色缺口；
4. 预算未耗尽且不处于 climax/resolve；
5. 优先复用失败后才允许新建。

### 15.3 应用完整性

- 新地点必须明确是否立即 unlocked；同回合重演算目标地点时必须立即 unlocked；
- 新物品必须挂到指定地点、NPC 或容器，否则不可取得；
- 新 NPC 的位置和地点索引必须一致；
- 新敌人必须有合法地点和遭遇方式；
- 同批次 ID 必须唯一，生成器不能仅依赖相同的 eventLedger 长度；
- item/enemy/fact 必须有各自预算或明确绑定事件预算，不能无上限创建；
- 所有引用在整批 proposal 合并后再次验证；
- 重演算最多一次；失败后已批准实体是否提交必须由触发类型决定，并返回明确结果，不能忽略 commit 失败。

### 15.4 生产 source

AI 配置有效时注入 live ExpansionSource；无配置时注入确定性 fixture。两者走完全相同的审批和回归链路。

---

## 16. API、幂等和错误语义

### 16.1 输入白名单

v2 action route 必须显式解析 discriminated union：

- `fixed_choice` 只允许 `kind + choiceToken`；
- `free_text` 只允许 `kind + text + targetNpcId?`；
- 拒绝未知 kind、未知字段、空 token、空文本和超长文本；
- 自定义文本长度使用统一常量；
- targetNpcId 必须是字符串并在 use case 中校验存在/在场；
- expectedRevision 必须是非负整数。

### 16.2 actionId

- 客户端使用 UUID，而不是 `Date.now()`；
- actionId 仅用于审计和重试对账；
- CAS revision 仍是唯一防重屏障；
- actionId、turnId、jobId 必须贯穿规则结果、pending job、场景生成审计和日志 trace，但不向模型暴露无意义内部 ID。

### 16.3 HTTP 状态

- 400：输入非法；
- 404：无活动存档；
- 409：stale revision；
- 422 或稳定业务码：行动被规则拒绝；
- 503：基础设施/AI 暂不可用但无法 fallback；
- 500：损坏存档或未分类内部错误。

不能把所有失败统一映射为 409。

---

## 17. Read Model 与信息边界

### 17.1 不暴露内部行动和隐藏事实

`GameSessionViewV2` 禁止包含：

- actionKey；
- ApprovedAction；
- FactId、QuestId、ThreadId 等内部 ID（除确为交互 token 所需）；
- 未发现事实正文；
- NPC hidden facts；
- candidateEventPool；
- PendingNarrativeJob；
- 模型 diagnostics 或生成原文。

任务目标涉及未发现事实时，应显示中性描述，例如“继续调查失踪原因”，不能直接显示事实正文。

### 17.2 NPC 对话投影

- 只有焦点 NPC 获得当前场景的两项对话选择；
- 其他在场 NPC 可以有台词，但不能自动复用焦点 NPC 的 choiceToken；
- 自定义输入只对当前焦点 NPC 开启；
- scene choice 和 NPC dialogue choice 必须在 read model 中显式区分。

---

## 18. 持久化与长局演进

### 18.1 MVP

短篇 MVP 可以继续在单条 record 中保存 World/Story JSON，但必须做到：

- 一次规则回合单次 CAS；
- scene writeback 只修改 narrative runtime 和 candidate pool；
- pending job 可重启恢复；
- 解析后执行完整 schema/invariant 校验，不能只做 JSON object 断言；
- 损坏状态安全失败，不自动重置。

### 18.2 长篇准备

当前把完整 eventLedger 放在 WorldState JSON 并每回合重写，无法自然扩展到长篇开放世界。后续达到长篇阶段前应迁移为：

- 独立 append-only event 表或分段 ledger；
- World/Story 保存当前快照和 ledger cursor；
- recentBeats/npcContacts 继续使用有界物化视图；
- 归档不改变回放顺序和事实语义。

此项为 P2，不阻塞短篇 v2.1 上线，但不得继续宣称现有 JSON ledger 已支持无限长局。

---

## 19. 模块边界目标

```text
src/game/domain/
  interaction.ts / action.ts
  turnResolution.ts
  pendingNarrativeJob.ts
  worldState.ts / storyState.ts
  events.ts / candidateEvent.ts

src/game/gameplay/rpg/
  ruleEngine/
  dialogue/
  quests/
  expansion/        # 纯 trigger/reuse/approve/apply
  candidateEvents/  # 纯 approve/compile/apply
  narrativeApproval/# 纯 scene/choice/knowledge 审批

src/game/application/
  performTurn.ts
  actionConverter.ts
  expansionProposer.ts
  stateCommit.ts
  generatePendingScene.ts
  sceneContext.ts
  sceneWriteBack.ts
  createGameV2.ts
  gameSessionViewV2.ts

src/game/application/server/
  ai/
    liveIntentParserSource.ts
    liveExpansionSource.ts
    liveWorldGenerationSource.ts
    liveSceneSource.ts
  persistence/
  compositionRootV2.ts
```

依赖方向保持：

```text
UI/API → application → gameplay → domain
application/server → AI / SQLite / environment
```

AI source port 可以定义在 application 或专门的 port 目录；pure gameplay 不得负责 `await source.propose()`。

---

## 20. 失败与并发规则

### 20.1 AI 失败

- ActionConverter AI 失败 → freeform；
- ExpansionProposer AI 失败 → 不扩展，继续初判结果或复用结果；
- SceneGenerator AI 失败 → 同一 PendingNarrativeJob 的确定性 fallback；
- fallback 不重复提交规则状态；
- AI 输出冲突 → 丢弃整场，记录脱敏分类，不修写 World State。

### 20.2 pending 恢复

- ensure 读取持久化 job；
- 相同 jobId 进程内单飞；
- provider 完成后以 basedOnRevision/current revision 进行 CAS；
- 仅允许明确白名单的展示字段并发 rebase（如 prologueShown）；
- 其它 stale 丢弃生成结果，并由最新 pending job 决定是否重试；
- 重试有界，不允许永久 pending；
- 最终 fallback 写回失败才报告 unavailable。

### 20.3 行动期间

- pending 时拒绝新的世界推进；
- `ack_prologue` 继续是唯一展示例外；
- 规则拒绝零写入；
- Expansion 审批失败不影响已有合法行动；
- commit 失败不得返回行动成功。

---

## 21. 迁移策略

### 21.1 存档

沿用上游 v2 决策：不迁移 v1 存档。当前 v2 尚未作为稳定正式存档发布时，推荐将本次修正作为新的 record/schema version，并要求重开 v2.1 新局。

不得在 repository 中用大量可选字段默默兼容一个因果不完整的 pending 状态；遇到旧 v2 pending 无 job 时，应：

- 开发环境提示清档；或
- 生成一个明确标记为 legacy-recovery 的安全观察 fallback，然后升级状态；
- 不得伪装为已正确恢复原行动结果。

### 21.2 v1 并行代码

实现期间 v1 可以保留作行为参考，但所有 `/api/v2/**`、`CurrentGameScreenV2` 和 v2 composition root 必须只走新流水线。v2.1 验收通过后再单独制定 v1 删除 Plan，不在本 Spec 内顺手大规模删除。

---

## 22. 推荐实施拆分

后续必须基于本 Spec 创建独立 Plan；建议按以下顺序实施，每阶段都可离线验证：

### R1：回合事务和原子 pending

- TurnResolution；
- PendingNarrativeJob；
- turnNumber / 版本语义；
- performActionV2 重构为 performTurn；
- 单次 StateCommit；
- SceneGenerator 消费真实 job；
- 修复 Expansion 成功路径叙事断链。

### R2：统一输入和 ApprovedChoice

- NPC 自定义输入并入 Interaction；
- TalkAction dialogueAct/topic；
- 服务端 choice registry；
- 移除客户端 actionKey；
- live/fixture IntentParserSource 注入；
- 严格 API discriminated union 校验。

### R3：完整开局世界和可达性 validator

- 扩展 WorldGenerationCandidate；
- 世界/任务/知识/结局完整校验；
- 删除正常路径硬编码默认主线；
- 地点解锁机制；
- 修正任务、幕、伏笔和结局顺序。

### R4：AI 事件推动闭环

- 结构化 EventCandidate；
- 纯审批/编译/应用；
- 正式 GameEvent；
- 预算、过期和 rejection；
- live SceneSource 返回候选事件；
- 同回合 TurnResolution 集成。

### R5：NPC 知识、记忆和场景最小权限

- SceneGenerationContext DTO；
- NPC fact cards/forbidden knowledge；
- 对话语义关系规则；
- 自定义输入结构化记忆；
- 焦点 NPC 选项投影；
- 隐藏事实 read model 守卫。

### R6：Expansion 和长旅程收口

- application 层 live ExpansionProposer；
- 完整触发信号与优先复用；
- ID/引用/地点挂载/解锁修复；
- 同 seed 分化旅程；
- 多结局和 reload/replay；
- 文档索引和 agent 实现事实更新。

---

## 23. 必须新增的验收测试

### 23.1 回合因果

1. `move` 后 pending job 保存真实 `eventKind=travel`，ensure 生成 travel 场景；
2. `partial_success` 后 SceneSource 收到 partial_success，不能变成 success；
3. 自定义 NPC 文本进入 Action/utterance 和 pending job，SceneSource 可读取；
4. 进程重启后仅凭数据库可恢复同一个 job；
5. action commit 与 pending job 是同一次 revision 增长；
6. pending 构造失败时世界状态零写入；
7. Expansion + 重演算成功后仍产生 pending job。

### 23.2 选择真实性

同 seed 开两局：

- A 选择“相信 NPC”；
- B 选择“质疑 NPC”。

断言当前回合的 TurnResolution、NPC interactionHistory 或关系变化不同；下一场 SceneGenerationContext 也不同。只比较 narration 文本不同不算通过。

### 23.3 自定义输入防越权

- “我的等级升到 100”不改变属性；
- NPC 可以在场景中回应；
- pending job 记录受限原话；
- eventLedger 只记录安全结构摘要；
- 日志不记录玩家原文。

### 23.4 选项安全

- 客户端 JSON 不含 actionKey；
- 篡改/过期/跨 scene choiceToken 零写入；
- AI 生成不存在的目标时整场 fallback；
- 两个语义相同的选择被拒绝；
- 选项标签与 ApprovedAction 语义不一致时被拒绝。

### 23.5 世界和结局可达性

- 7 个题材 × short/medium/long 至少各一份离线 candidate 通过 validator；
- 从起点可完成第一幕；
- 所有 locked 主线地点存在解锁路径；
- 至少两个结局可通过不同结构化选择到达；
- 最终条件满足的同一回合立即写入 ending；
- reload 后状态、场景、choice registry 和 pending 恢复一致。

### 23.6 AI 事件推动

- SceneGenerator 提议事件但当前回合 World State 不变；
- 下一回合审批通过后生成正式 GameEvent 和状态变化；
- 前提失效/过期/预算耗尽时明确拒绝；
- 批准事件影响下一场上下文或后续合法行动；
- 不允许“只 tension +10、无领域事件”被算作成功激活。

### 23.7 NPC 知识隔离

- NPC context 不包含其他 NPC 私密事实；
- NPC 不可使用 unknown fact；
- 玩家明确告知后，规则传播 knownFactId，下一场才允许引用；
- 未发现事实正文不出现在 read model。

### 23.8 完整旅程

至少新增：

- 15 回合离线完整旅程；
- 途中包含两次 NPC 固定选择、一次自定义输入、一次失败/部分成功、一次地点解锁、一次候选事件、一次世界扩展、一次战斗和一个结局；
- reload 至少 3 次；
- 同一 fixture replay 的规则状态和事件序列完全一致；
- 分叉旅程最终得到不同结局或显著不同的世界状态。

---

## 24. 架构验收门禁

实现完成后至少运行：

```text
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:app
npm run test:components
npm run test:boundaries
npm run typecheck
npm run lint
npm test
npm run build
```

此外应新增单独的 v2.1 完整旅程命令，不能只依赖零散模块测试。

---

## 25. 完成定义

只有同时满足以下条件，才能认为 v2 架构底座修复完成：

1. 固定选项和自定义输入共用同一 performTurn 流水线；
2. 两个 NPC 固定选择在规则层具有不同结构化语义；
3. 每个成功回合一次 CAS 同时提交事实、事件和 PendingNarrativeJob；
4. SceneGenerator 不再伪造 ResolvedEvent，能准确表现本回合结果和玩家原话；
5. 客户端只收到 opaque choiceToken，不收到 actionKey；
6. AI 事件提议经下一回合规则审批后可以产生真实领域事件；
7. 开局世界通过完整引用、可达性、任务图、知识和多结局校验；
8. NPC 只依据自己的知识、关系、目标和交互历史回应；
9. 同 seed 不同选择产生可验证的结构化故事分化；
10. 完整旅程能够稳定推进并到达至少两个不同结局；
11. 离线 fixture、fallback、reload、CAS 冲突和进程重启全部可回归；
12. v2 实现事实同步更新到 `docs/agent/`、`docs/Agent文档索引.md` 和当前阶段入口。

---

## 26. 最终架构原则

本次修复完成后，项目必须满足：

> 玩家选择不是一段交给 AI 的提示词，而是一份经规则裁决、原子提交、可回放的回合事实。AI 只能基于这份事实继续创造下一步故事。

“每局不同”应来自玩家选择不断积累出的结构化状态分化；模型随机性只负责表达和创意，不能成为故事差异的唯一来源。
