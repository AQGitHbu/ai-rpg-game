# 完整小故事 P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家在正式规则、持久化与真实 AI 生成链路中完成“破庙来信”小故事，并证明旧事、人物动机和具体选择能共同影响过程与终局。

**Architecture:** 继承 main 的 Entity、事件、Context Compiler 和完整叙事包；补齐正式原文历史、浅层 Thread、可执行互动条件及双向检索。必要时单独进行角色私密判断，再由整场作者生成统一候选；正文与未提交提案共同修订，规则和 A/B 两次原子提交保证事实成立。

**Tech Stack:** TypeScript 5.8、Next.js 16、React 19、Vitest 3、SQLite/@libsql/client，消费现有 `@ai-game/ai-transport` 与日志 API；不新增运行时依赖。

## Global Constraints

- 唯一总设计：[架构 Spec](../specs/2026-09-12-narrative-architecture-design.md)；现状与旧实验：[基准报告](../reports/2026-09-12-narrative-architecture-baseline.md)。本文件只展开 P1，不实施 P2–P4。
- 文档审查发现与修正依据见 [P1 Plan 审查报告](../reports/2026-09-12-narrative-p1-plan-review.md)；审查通过不代替功能测试或剧情验收。
- 起点 main `ca189eb12011d493f21bb50652fbfe1324387599`，分支 `codex/narrative-architecture`，worktree `.worktrees/narrative-architecture/`。staged `3edcee4d` 只作定向参考，不整体移植。
- 本 Plan 是用户指定的独立任务，不改 `docs/agent/current-phase.json`，不执行旧 Plan5；勾选和验收证据只在本 Plan 维护。
- “质量与游戏性优先于 token、调用数和耗时。”不把接口数量、调用减少或局部文案评分作为架构成功证据。
- “P1 不做完整世界模拟、组织经济、任意组件热挂载、通用脚本语言、开放式长篇、装备成长、交易系统、完整 misinformation/谣言传播或向量数据库。”
- “规则已结算结果不可被后续循环改写”；“AI 失败显式重试，确定性内容只用于规则反馈和显式 fixture”。
- 四类信息是职责划分，不要求四个数据库或四次模型调用。权威状态归 Entity，实际经历归 History，未收束问题归 Story State，稳定设定归 Game Definition。
- 开局保持一个地点、一个 NPC 的最小切片；P1 全程最多三个地点、三个 NPC、一件唯一交付物，使用现有短篇三幕。
- 目标是 8–16 次有意义选择；不为回合数注水。验收单路线最多 24 次有效玩家动作，超出记未完成。
- A 结算玩家行动，B 批准并发布实际场景；任何网络调用均不占用数据库事务。B 失败不能重放 A。
- 只执行本 Task 需要的系统阅读；修改共享消费边界前读共享流程，不改 foundation、`docs/共同规范/` 或公共 package。
- 本次文档编写不执行实现或付费 API。后续执行本 Plan 时，live 严格受 Task 9 的预登记与预算约束；不得自动追加样本。

---

## 交付顺序与停止条件

| 里程碑 | Task | 可玩/可核验交付 | 进入下一里程碑的条件 |
| --- | --- | --- | --- |
| P1-A 规则与历史闭环 | 1–4 | 正式仓储与 bundle 消费链跑完离线三幕；私下、公开、先验身份、主动退出均有合法终局 | 条件与后果真实落盘、重载不丢失，不能靠测试直接修改状态推进 |
| P1-B 真实生成接入 | 5–8 | 检索→角色判断→整场候选→审批→恢复→UI 串通 | 权限、候选修订、事务故障及正式装配测试通过 |
| P1-C 完整旅程验收 | 9–10 | 固定六条 live 路线及一次 UI 完整游玩，保留完整证据 | Spec A1–A10、质量门槛及全部六条终局通过 |

按 Task 顺序执行，每个 Task 自带测试与提交。出现“规则无法表达本故事的关键选择”时，先修正本 Plan/Spec 的具体契约，不能绕过规则写 fixture，不能增加润色器掩盖失败。P1-C 未过，保留失败分母与根因，暂停扩展 P2；新一批实验须另行明确范围。

## 文件责任与接口约定

下列新增文件均由对应 Task 创建，不是当前已实现入口。修改文件以函数/类型定位，避免计划中的行号随前置 Task 漂移。后文使用现有 `WorldState`、`StoryState`、`Action`、`EntityId`、`EventId`、`NarrativeJobId`、`NarrativeBundleSource`、`GameRecord`、`GameRepository`，分别从其现有 domain/application 文件导入；测试使用真实品牌 ID 构造器，禁止以 `as unknown as` 拼装合法世界。

| 单元 | 新文件及职责 | 主要既有承载点 |
| --- | --- | --- |
| 正式历史 | `domain/narrativeHistory.ts` 保存实际输入/展示及引用 | `storyState.ts`、`performTurn.ts`、`consumeNarrativeBundle.ts` |
| 有序表达 | `domain/sceneExpression.ts` 定义正文顺序与实际听众 | bundle parser/approval、History、展示投影 |
| 互动契约 | `domain/storyInteraction.ts` 类型；`gameplay/rpg/storyInteraction/resolveStoryInteraction.ts` 条件与效果 | Entity 组件、`approvedChoice.ts`、规则引擎 |
| 持续局势 | `domain/storyThreads.ts`；`gameplay/rpg/storyThreads/advanceStoryThreads.ts` | StoryState、Quest/Goal/Promise 引用 |
| 双向检索 | `gameplay/rpg/narrativeMemory/retrieveStoryEvidence.ts` | 现有 memory 检索、Entity 投影、Context Compiler |
| 角色判断 | `application/npcDeliberationSource.ts`、`application/projectNpcDeliberation.ts`、`server/ai/liveNpcDeliberationSource.ts` | `npcSpeechAuthority.ts` |
| 场景审阅 | `application/narrativeCandidateReview.ts`、`server/ai/liveNarrativeCandidateReview.ts` | bundle source、审批和修订循环 |
| 恢复控制 | `domain/narrativeGenerationAttempt.ts` | pending job、SQLite CAS、composition root |
| 旅程验证 | `application/testing/templeLetterJourney.testutil.ts`、对应离线/live runner；`scripts/narrativeP1Journey.mjs` | 正式创建/行动/生成/读模型 API |

所有 `domain/`、`application/` 和 `gameplay/` 路径在此表中相对 `src/game/`。每个新增 domain 契约提供接受 `unknown` 的运行时解析，错误仅含稳定 code/path；JSON 不经解析不能视为类型合法。

## P1-A：先完成有后果的小故事

### Task 1：实际表达成为可持久、可回滚的 History

**阅读：** Spec §4、§5.1、§8、§12；[开发规范](../../游戏开发规范.md)、[连续性与记忆](../../agent/剧情连续性与结构化记忆.md)、[实体状态](../../agent/实体与组件世界状态.md)。

**Files:**

- Create: `src/game/domain/narrativeHistory.ts`、`src/game/domain/narrativeHistory.test.ts`。
- Create: `src/game/domain/sceneExpression.ts`、`src/game/domain/sceneExpression.test.ts`。
- Create: `src/game/application/consumeNarrativeBundle.test.ts`（main 尚无同名独立测试）。
- Modify: `src/game/domain/narrativeBundle.ts`、`src/game/domain/preparedContinuation.ts`、`src/game/application/narrativeBundleSource.ts`、`src/game/application/approveNarrativeBundle.ts`、`src/game/application/npcSpeechAuthority.ts`、`src/game/application/server/ai/liveNarrativeBundleSource.ts`、`src/game/application/gameSessionView.ts`。
- Modify: `src/game/domain/storyState.ts`、`src/game/domain/worldState.ts`、`src/game/application/performTurn.ts`、`src/game/application/consumeNarrativeBundle.ts`、`src/game/application/generatePendingNarrativeBundle.ts`、`src/game/application/createGame.ts`。
- Modify: `src/game/application/server/persistence/storyStatePersistenceValidation.ts`、`src/game/application/server/persistence/worldStatePersistenceValidation.ts`、`src/game/gameplay/rpg/ruleEngine/battleResolver.ts`、`src/game/gameplay/rpg/ruleEngine/advanceBattle.ts`。
- Test: 对应持久化 validator 测试、`src/game/application/server/persistence/sqliteGameRepository.test.ts`、`src/game/application/consumeNarrativeBundle.test.ts`、`src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`。
- Docs: 原位更新连续性与记忆、实体状态、[战斗与结局](../../agent/战斗与结局.md)中本 Task 已实现的契约。

**Interfaces:** 消费实际规则 Event 与实际发布场景；产出 `StoryState.history: NarrativeHistory` 及纯函数 `appendHistory(history: NarrativeHistory, entries: readonly HistoryEntry[]): NarrativeHistory`。定义于新 domain 文件：

```ts
type HistoryEntry = Readonly<{
  id: string; // 服务端按 jobId/sceneId/kind/ordinal 铸造，不能由 AI 指定
  segmentId: string; // 同一行动 A 与其响应 B 共用稳定交互段 ID
  sequence: number; // 实际提交顺序，重试不重新分配
  actionId: string | null;
  jobId: NarrativeJobId | null;
  sceneId: string;
  revision: number;
  turnNumber: number;
  kind: "player_choice" | "player_freeform" | "narration" | "npc_line" | "shown_choice";
  text: string;
  speakerId: EntityId | null;
  audienceIds: readonly EntityId[];
  entityIds: readonly EntityId[];
  factIds: readonly FactId[];
  eventIds: readonly EventId[];
  choiceToken: string | null;
}>;
type NarrativeHistory = Readonly<{ entries: readonly HistoryEntry[] }>;
```

`shown_choice` 只表示展示，不能生成动作 Event 或被检索当成玩家言行。旁白只有玩家可读，不自动成为所有在场 NPC 的知识。所有原文完整保留；既有 NPC history 上限仍只是派生视图上限。

先将 **Bundle 契约 1→2**，在 Task 1 冻结有序表达，而不是到 Task 7 才让 History 猜听众。`BundleSceneProposal` 用必填 `expressions: readonly SceneExpressionProposal[]` 替代三个独立正文入口 `segments/npcLine/npcDialogues`；choices/objectiveLink 等非正文字段保留。新文件定义：

```ts
type SceneExpressionProposal =
  | Readonly<{ kind: "narration"; beatId: string; text: string;
      referencedEntityIds: readonly string[] }>
  | Readonly<{ kind: "npc_line"; npcId: string; audienceIds: readonly string[];
      text: string; emotion: NarrativeEmotion; answeredBeatIds: readonly string[];
      usedFactIds: readonly string[]; usedEventIds: readonly string[] }>;
```

数组位置是唯一表达顺序。字符串引用允许已有 ID 或现有开局/具象化符号表中的 local key，approval 必须解析，禁止品牌强转跳过实体存在/权限校验。`NarrativeEmotion` 复用 domain/narrative。批准结果为 `ApprovedSceneExpression`：与上述联合对应，但 NPC、audience、fact、event 引用分别是已解析的 `NpcId`、`EntityId`、`FactId`、`EventId`，旁白引用为 `EntityId[]`；除此没有第二份作者正文。

服务端逐段校验说话者自知及披露权限、听众存在/同场/交流通道，并在预览状态中按顺序传播可靠披露；只有早于本段且确实对该 NPC 披露的事实可供后段引用，未经核实的陈述维持 suspected。默认对话通道只包含玩家与焦点 NPC，同场第三人不自动听见。明确公开交流可列其他实际在场 NPC；不能以“public”代指全部未具象化角色。若 UI 仍使用旧 segments/npcLine DTO，则只从 expressions 派生兼容展示，不持久化第二份正文，不能重排对白。

- [ ] 写 `appendHistory` 测试：同 ID 同内容重入零追加；同 ID 不同内容报冲突；不同 NPC 的 audience 不合并。以下是最小无 fixture 用例，其他用真实品牌 ID 构造器创建 entry：

```ts
expect(appendHistory({ entries: [] }, [])).toEqual({ entries: [] });
expect(appendHistory({ entries: [entry] }, [entry]).entries).toHaveLength(1);
expect(() => appendHistory({ entries: [entry] }, [{ ...entry, text: "改写" }]))
  .toThrow("HISTORY_ID_CONFLICT");
```

- [ ] 运行 `npx vitest run src/game/domain/narrativeHistory.test.ts`，确认缺少契约/行为导致失败。
- [ ] 实现确定性去重与冲突拒绝，保留追加顺序：

```ts
const previous = byId.get(entry.id);
if (previous && !sameHistoryEntry(previous, entry)) {
  throw new Error("HISTORY_ID_CONFLICT");
}
if (!previous) result.push(entry);
```

`sameHistoryEntry(a: HistoryEntry, b: HistoryEntry): boolean` 是本文件私有字段比较函数；数组按存储顺序比较，不以文本相同跨 ID 去重。

- [ ] A 在 `performTurn` 原有 CAS 内写 exact chosen label 或玩家原文；B 和开局仅在实际发布/消费处写序幕、旁白、对白与两个展示选项。生成成功但未消费的 continuation 不写 History。自由输入长期历史保存入口校验通过的完整原文，不使用 pending job 的 200 字摘要替代；原入口长度上限保持一致。
- [ ] 更新 opening、decision 的 parser/source schema 与全部已有 fixture 至有序 expressions；生产 source 仍为单作者，Task 1 不增加模型调用。History、知识变化 Event 与 UI 顺序均来自同一批准表达结果。写同场第三人未听私聊、第二句不能预知第三句披露、失败候选零知识写回的集成测试。
- [ ] Story schema 从 8 升至 **10**（与 staged 的 9 不声称兼容）；World schema 从 6 升至 **7**。各 parser/constructor/fixture 一并更新，旧版本明确拒绝，不自动伪造历史。`BattleStartSnapshot` 加 History 快照，失败/撤退按现有回退边界恢复；审计日志可以保留失败尝试，实际 History 不保留已回滚经历。
- [ ] 写并运行 SQLite 重开连接、B 写入失败、未消费 continuation、战斗回滚测试；执行 `npm run typecheck` 和上述受影响测试，预期全过。新局空历史及开局发布均有覆盖。
- [ ] 更新系统文档，只暂存本 Task 文件；提交 `feat: persist actual narrative history across turns and reloads`。

**验收：** 真实选择原句与对白重载后可按事件追溯；A/B 每次提交内部状态和历史一致。此时不增加摘要、检索或角色调用。

### Task 2：把具体选项绑定到可裁决条件与后果

**阅读：** Spec §4.3、§6.2–§6.4、§9；[NPC 系统](../../agent/NPC人格知识与关系图.md)、[行动裁决](../../agent/行动裁决.md)、[任务推进](../../agent/探索与任务推进.md)。

**Files:**

- Create: `src/game/domain/storyInteraction.ts`、对应 `.test.ts`；`src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.ts`、对应 `.test.ts`。
- Modify: `src/game/domain/action.ts`、`src/game/domain/approvedChoice.ts`、`src/game/domain/entity/entityCore.ts`、`src/game/domain/entity/entityComponents.ts`、`src/game/domain/entity/entityRecord.ts`、`src/game/domain/entity/npcComponents.ts`、`src/game/domain/entity/entityStore.ts`。
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`、`src/game/gameplay/rpg/dialogue/dialogueResolution.ts`、`src/game/gameplay/rpg/ruleEngine/validateAction.ts`、`src/game/gameplay/rpg/ruleEngine/resolveByType.ts`、`src/game/application/actionConverter.ts`、`src/game/application/buildChoiceMap.ts`。
- Modify: `src/game/domain/events.ts`、`src/game/domain/eventPayloadValidation.ts`、`src/game/domain/resolvedEvent.ts`；互动结算、目标/承诺变化与实际告知的事件 payload/转换随功能一起更新，不只修改最终状态。
- Modify: `src/game/gameplay/rpg/narrativeBundle/descriptors.ts`、`src/game/domain/narrativeBundle.ts`、`src/game/application/narrativeBundleSource.ts`、`src/game/application/approveNarrativeBundle.ts`、`src/game/application/consumeNarrativeBundle.ts`。
- Modify: `src/game/domain/openingGenerationCandidate.ts`、`src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`、`src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts`、`src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`、`src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`；最小互动创建/具象化入口在本 Task 接通，不等待 Task 6。
- Test: `approvedChoice.test.ts`、`entityMutation.test.ts`、`buildChoiceMap.test.ts`、`performTurn.test.ts`（均位于其生产文件旁）。
- Docs: NPC 系统、行动裁决、实体状态中的互动、认知、别名和版本契约。

**Interfaces:** `TalkAction.interactionId?: string` 引用服务端已批准互动；该字段进入 action 重建、语义摘要及 choice token，不能只保留 label。新增 `resolveStoryInteraction(worldState: WorldState, action: Extract<Action, {type: "talk"}>, deps: ResolveDeps): ResolveResult`，复用 `ruleEngine/resolveByType.ts` 当前导出的 `ResolveDeps` 和 `ResolveResult`（仅 type import，消除运行时互相导入）。普通 talk 无 interactionId 仍走原规则；缺失引用、前提不满足、非法效果返回 blocked 或明确失败，不部分更新。

`ResolveDeps` 已提供 `turnId/actionId/turnNumber/now`；成功结果必须包含 `nextWorldState/drafts/feedback/status/stateChanges/facts`，与普通 talk 管线一致。`eventIdFor(deps.turnId, eventKey)` 预铸知识/承诺来源，统一回合提交器实际追加 drafts；resolver 不提前自行写 eventLedger，也不只返回最后状态。

互动存放在 NPC 的可选 `interactions` 组件，保存定义，不复制运行状态。先实现有限操作与条件：

```ts
type StoryCondition =
  | { kind: "has_item"; itemId: ItemId; ownerId: EntityId }
  | { kind: "knows_fact"; actorId: EntityId; factId: FactId }
  | { kind: "promise_status"; npcId: NpcId; promiseId: string;
      status: "open" | "fulfilled" | "broken" | "released" }
  | { kind: "goal_status"; npcId: NpcId; goalId: string;
      status: "active" | "blocked" | "completed" | "abandoned" };
type StoryInteraction = Readonly<{
  id: string;
  npcId: NpcId;
  operation: "promise_confidentiality" | "request_introduction"
    | "request_verification" | "share_known_fact";
  condition: readonly StoryCondition[]; // 全部满足
  factIds: readonly FactId[];
  goalIds: readonly string[];
  promiseId: string | null;
  audienceIds: readonly EntityId[]; // 行动者以外实际听众，批准时确定
  evidenceEventIds: readonly EventId[];
}>;
```

新增 `StoryInteractionProposal = Omit<StoryInteraction, "id"> & { proposalKey: string }`，这是解析符号引用后的内部提案；wire 中 ID 位置为字符串，使用同一候选符号表解析成内部引用。`proposalKey` 只在本候选内唯一，服务端按 job/候选/局部 key 铸造正式 interactionId，AI 不能指定正式新 ID。

`NarrativeBundleProposal` 与 opening proposal 增加 `interactionProposals` 数组；Task 1 的 Bundle2 parser 同步增加严格字段。流程固定为 **解析提案→在候选预览世界校验/编译互动→descriptor 生成带 interactionId 的 candidate→按 proposal 的 candidateId 绑定 label→ApprovedChoice→B 原子安装互动与场景→玩家选择后 A 执行互动**。已存在互动的候选沿用正式 ID；新提案可用 `interaction:<proposalKey>` 引用，服务器在该候选内解析，不能跨候选复用。descriptor 必须从真实互动和当前条件生成候选，不再固定只提供 support/challenge；自由输入提出的新核验策略走同一入口。原始 AI Action/条件效果不能直接进入注册表。

在 Task 2 增加正式 source/approval 集成测试：fixture 返回新核验提案与 candidateId，最终 registry 的 action 必须携带已铸 interactionId；选中经 performTurn 生效，未选中不执行核验。此测试先于 Task 4 的完整旅程，确保离线链路无需借用未来 Task 的功能。

`ItemId/NpcId/FactId` 从 `domain/worldEntity.ts` 导入。`request_introduction` 和 `request_verification` 只产生有来源的许可/核验事实，实体 Fact 表示是否已获许可；不新增另一份 permission 布尔表。`share_known_fact` 必须明确事实及实际听众，不能把玩家已知自动广播。`give_item` 仍是唯一交付动作，不能藏入 talk 的效果。

`factIds` 的操作语义固定：promise_confidentiality 指保密对象；request_introduction 指该 NPC 有权提供的引荐事实；request_verification 指已建立来源且该 NPC 能见证的核验事实；share_known_fact 指行动者已知、实际对该 NPC 说出的事实。前三项不得凭新提案自授能力，handler 必须检查开局/实际具象化建立的来源及 NPC 知识。解析通过不等于操作获准。核验结果本身是本次成功操作 Event 的结果；其证明材料必须先存在。

事件契约随 resolver 一起实现：每次成功互动至少有 `story_interaction_resolved` draft；新增核验/引荐结果有带 evidenceEventIds 的事实变化；实际告知有逐听众知识变化；承诺/目标改变各有独立 change draft。稳定 eventKey 使用 interactionId、效果种类、目标 ID，后续 draft 的 causeKeys 引用本次互动，跨回合依据保留 EventId。每个 knowledge/promise/goal 的 supportingEventId 必须解析到本批 draft 或原 ledger，漏事件或错引用整次拒绝。测试断言状态变化与 drafts/stateChanges/facts 对齐，重载可追溯、履约无重复。

既有 promise 增加可选 `resolution: { fulfilledWhen: readonly StoryCondition[]; brokenWhen: readonly StoryCondition[]; sourceEventIds: readonly EventId[] }`。空条件集合不触发；同回合双方条件均满足时 broken 优先；现有 status 值域与关系 signal 保持不变。P1 新建可执行承诺必须带 resolution，历史纯叙述承诺不由文本猜条件。

- [ ] 写 RED：同 NPC、dialogueAct、topic 而不同 interactionId 的两项生成不同 token；篡改 ID/旧 token 拒绝；条件不满足零 mutation。测试使用 `createApprovedChoice` 既有输入 fixture 增加两个 ID，不绕过其合法性检查。
- [ ] 运行 `npx vitest run src/game/domain/approvedChoice.test.ts src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.test.ts`，确认失败。
- [ ] 实现 token/批准动作链携带 interactionId；服务端仅从当前已批准 choice map 解析定义，客户端字段与 AI 文案不构成授权。规则核心使用现有组件读写：

```ts
if (!interaction.condition.every(condition =>
  evaluateStoryCondition(worldState, condition))) {
  return { ok: true, nextWorldState: worldState, drafts: [],
    feedback: "当前条件不满足。", status: "blocked", stateChanges: [], facts: [] };
}
```

产出 `evaluateStoryCondition(world: WorldState, condition: StoryCondition): boolean` 供 Task 3 复用。缺失实体、失效生命周期或引用不属于该 NPC 一律 false；具体效果只由四种 operation 的服务端 handler 生成，不接受 AI 数值 delta 或任意 patch。

- [ ] EntityStore 版本 **2→3**；`EntityCore.aliases` 保存带来源和作用域的称呼 `{text, observerIds, evidenceEventIds}`，空 observerIds 仅用于已有公开名称的明确同义称呼。给 player_character 添加最小知识组件，NPC 继续使用现有 knowledge，避免从全局 discovered 推定每个人知道。补 NPC goals 的受控状态 mutation，复用现有 promise/debt 及关系 signal。
- [ ] 为新承诺添加机器可判定的履行/违背条件与证据引用，状态仍仅维护在现有 NPC relationship promise；秘密承诺只有在明确选择时创建。公开告知使其违背一次；fulfilled/broken/released 不再次兑现。开局/动态创建 parser、投影及 mutation validator 随 Entity3 原子更新。
- [ ] 验证四个 operation 的合法/非法来源、目标不存在、重复履行、实际听众、同名别名不合并、物品唯一 owner；运行相关规则、Entity、choice 测试及 `npm run typecheck`。
- [ ] 更新系统文档并提交 `feat: bind story choices to validated interaction consequences`。

**验收：** “私下请求引荐”和“公开询问”可有不同前提、实际知识后果；换两句 label 不算分支。

### Task 3：让目标、承诺和三幕收束持续驱动故事

**阅读：** Spec §4.3、§6.1、§9；任务推进、战斗与结局；[MVP 玩家规则](../../策划文档/AI生成RPG_MVP.md)。

**Files:**

- Create: `src/game/domain/storyThreads.ts`、对应 `.test.ts`；`src/game/gameplay/rpg/storyThreads/advanceStoryThreads.ts`、对应 `.test.ts`。
- Modify: `src/game/domain/storyState.ts`、`src/game/domain/worldState.ts`、`src/game/domain/storyContract.ts`、`src/game/domain/openingGenerationCandidate.ts`、`src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`、`src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts`。
- Modify: `src/game/domain/action.ts`、`src/game/domain/approvedChoice.ts`、`src/game/domain/events.ts`、`src/game/domain/eventPayloadValidation.ts`、`src/game/gameplay/rpg/ruleEngine/validateAction.ts`、`src/game/gameplay/rpg/ruleEngine/resolveByType.ts`、`src/game/gameplay/rpg/narrativeBundle/descriptors.ts`；退出必须有正式 Action/候选/事件入口。
- Modify: `src/game/application/performTurn.ts`、`src/game/domain/pendingNarrativeJob.ts`、`src/game/application/server/persistence/storyStatePersistenceValidation.ts`、`src/game/application/generatePendingNarrativeBundle.ts`；Test: 对应 performTurn、pending job、generator 测试，接通退出的有限生成边界。
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`、`src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts`、`src/game/gameplay/rpg/ruleEngine/resolveEnding.ts`、`src/game/gameplay/rpg/narrativeBundle/endingDecision.ts`、`src/game/gameplay/rpg/ruleEngine/battleResolver.ts`。
- Test: 上述规则测试和两个 persistence validator 测试；Docs: 任务推进、连续性与记忆、战斗与结局、MVP 玩家规则。

**Interfaces:** 消费 Task 2 的 `StoryCondition`/`evaluateStoryCondition`；产出 `StoryState.threads: readonly StoryThread[]` 与 `advanceStoryThreads(input: { worldState: WorldState; threads: readonly StoryThread[]; eventIds: readonly EventId[] }): readonly StoryThread[]`。

```ts
type StoryThread = Readonly<{
  id: string;
  kind: "conflict" | "question" | "commitment_followup";
  participantIds: readonly EntityId[];
  causeEventIds: readonly EventId[];
  questIds: readonly QuestId[];
  goalRefs: readonly { npcId: NpcId; goalId: string }[];
  promiseRefs: readonly { npcId: NpcId; promiseId: string }[];
  question: string;
  status: "open" | "advanced" | "resolved" | "abandoned";
  evidenceEventIds: readonly EventId[];
  closure: readonly StoryCondition[];
  tentativeDirections: readonly string[];
}>;
```

`QuestId` 导入现有 worldEntity；`closure` 为空不得自动 resolved。`unresolvedThreads` 仅保留由 threads 派生的兼容投影，消费者逐项改读真实 Thread；不允许两处独立更新。新线程状态与 goal/promise/Quest 状态不同，不能复制为第二份任务状态。

在 Action union 增加 `AbandonQuestAction = Readonly<{type: "abandon_quest"; questId: QuestId}>`。只有当前未结束、可放弃的主 Quest 可生成该动作的 opaque choice；明确选择后 A 写 `quest_abandoned` Event、推进目标/承诺状态，B 创作相应退出终局。`resolveByType` 复用完整 ResolveResult；批准动作、token 重建、descriptor 和动作白名单全部更新。普通 move、talk/refuse 或自由输入“我走了”不能隐式放弃。该动作只放弃任务，不顺便销毁/转移信筒；归还必须先选原有 give_item。

`performTurn` 当前只把 talk 识别为正式叙事选择，必须显式增加 **当前 registry/revision 证明过的 abandon_quest** 分支，走现有 `commitResolution`（内部创建 pending job 并 CAS），不落入非决策 continuation 消费。`classifyProviderDecisionBoundary` 对此返回 `narrative_choice`；兼容 pending 的 generationKind/sceneRequestKind 增加唯一合法配对 `story_exit/story_exit`，actionSummary 增加 `{kind: "abandon_quest", questId}`，focusNpcId 可空，不伪造 NPC 对话。A 只标记任务/承诺的事实结果与 pending；最终展示必须等待 B，不能因任务已 abandoned 就被 ensure 的“已结束”短路拦截。此例外同步到总 Spec §8.2，普通移动/战斗触发范围不扩大。

- [ ] 写 RED：事件解决核验问题但未交付时不能结束主任务；承诺离场/reload 仍生效；公开暴露后即使最后选择“相信”也不能恢复保密成功结局。
- [ ] 运行 `npx vitest run src/game/gameplay/rpg/storyThreads/advanceStoryThreads.test.ts src/game/gameplay/rpg/ruleEngine/resolveEnding.test.ts`。
- [ ] 实现有证据的推进与终局条件；使用新证据触发 closure 检查：

```ts
const resolved = thread.closure.length > 0 && thread.closure.every(
  condition => evaluateStoryCondition(worldState, condition),
);
```

只有相关 eventIds/引用状态改变才追加证据；未发生的 tentativeDirections 不生成事实。被明确放弃的主线进入代价明确的 exit 结局，不当作成功交付。

- [ ] 开局编译固定交付物 owner、递送目标、接应身份的核验证据来源以及交付/退出判定。稳定故事定义存 `StoryContract`，其中未来角色用本地角色 key，具象化时再绑定实体 ID；不提前创建离场 NPC，不容许悬空 ID。新增有限互动定义必须受 Task 2 操作和证据校验约束。
- [ ] 明确主动退出：已交付接应人走完成，不再接受 abandon_quest；归还委托人后明确选择 abandon_quest，按约解除承诺并结束；仍持有信筒时明确选择 abandon_quest，保留持有和违约事实并结束。单纯移动离场仍可返回履约。结束画面可显示原 trust/doubt 立场，但结局事实由累计状态决定。
- [ ] 写退出正式集成测试：选中 abandon_quest 后 A 已落盘且状态 pending；B 失败仍保留退出事实，手动重试只生成同 job 的退出终局；不会重复弃约/发物品，旧退出 token 零写入。无焦点 NPC 时同样可生成终局，普通导航不新增 provider 请求。
- [ ] BattleStartSnapshot 补 threads 和本 Task 新增的可变 Story State；Entity3 已包含目标/承诺/知识，随 Entity 快照恢复。更新 Story10/World7 parser 的本分支最终形状；前置 Task 的开发存档不承诺迁移，每个验收 fixture 新建独立存档。
- [ ] 跑线程、Quest、终局、回滚、持久化测试及 typecheck；更新文档并提交 `feat: advance story threads and endings from committed consequences`。

**验收：** 三幕推进有规则证据，最后一句话不能清除前面的泄密、归还或违约。

### Task 4：正式链路跑完离线“破庙来信”

**阅读：** Spec §9、§11；[运行时 AI](../../agent/运行时AI导演与场景表演.md)的 bundle 创建/消费入口。

**Files:**

- Create: `src/game/application/testing/templeLetterJourney.testutil.ts`、`src/game/application/testing/templeLetterJourney.test.ts`。
- Modify: `src/game/domain/testing/worldStateFixture.testutil.ts`（仅适配新 schema）；`src/game/application/performTurn.test.ts`、`src/game/application/generatePendingNarrativeBundle.test.ts`。
- Modify: 本 Plan 的 P1-A 验收记录；该 Task 不新增生产 fixture 开关。

**Interfaces:** 测试工具导出：

```ts
type TempleRoute = "private" | "public" | "verify_first" | "exit_return" | "exit_keep";
type TempleJourneyResult = Readonly<{
  ended: boolean;
  route: TempleRoute;
  snapshots: readonly GameRecord[];
  actionCount: number;
  itemOwnerAtEnd: EntityId | null;
  publicExposure: boolean;
  promiseStatus: "absent" | "open" | "fulfilled" | "broken" | "released";
}>;
// 每次调用创建独立临时 SQLite；结束时关闭连接，不触碰开发存档。
function runTempleLetterJourney(route: TempleRoute): Promise<TempleJourneyResult>;
function createTempleLetterBundleSource(): NarrativeBundleSource;
```

source 同时覆盖 opening 与 decision，输出真实提案类型。runner 只能经 `createGame`、`performTurn`、`generatePendingNarrativeBundle`、正式读模型/choice map 与 SQLite API 行进；快照仅只读观察。禁止调用 legacy scene fixture 冒充 bundle，禁止在回合间 `applyState` 注入预期答案。

- [ ] 写五路线测试（交付三种，退出两种）和可供读者直接运行的断言：

```ts
for (const route of ["private", "public", "verify_first", "exit_return", "exit_keep"] as const) {
  it(`completes ${route} through production turn APIs`, async () => {
    const result = await runTempleLetterJourney(route);
    expect(result.ended).toBe(true);
    expect(result.actionCount).toBeLessThanOrEqual(24);
    expect(result.snapshots.length).toBeGreaterThan(3);
  });
}
```

- [ ] 运行 `npx vitest run src/game/application/testing/templeLetterJourney.test.ts`，确认未具备完整路径时失败。
- [ ] 实现 fixture source 的有限状态场景：破庙接信→客栈选择渠道→渡口验证/交付→结局。角色 key 解析为正式具象化后的 ID；同一信息只在来源成立后使用。稳定 fixture 的对白只存在测试文件。
- [ ] 私下路线创建保密承诺换引荐；公开路线不要求先许保密承诺，通过既有证据核验；verify_first 在自由输入后停在持有信筒状态，生成真实 request_verification 选项，选中并核验成功后仍需显式 give_item；exit_return 经 give_item 归还后选择 abandon_quest，exit_keep 保持 owner 为玩家并选择 abandon_quest。另测普通离场及自由输入“我走了”均不结束游戏。
- [ ] 增加中途离场、关闭并重开 SQLite、返回履约用例；断言私下/公开结局在 exposure、知识分布和许可来源上不同，give_item 仅发生一次，选项未选中零状态变化。对话自由输入默认中性 talk，不能据字符串自动传信或完成核验。
- [ ] 运行本旅程、performTurn、bundle 消费及 SQLite 测试，全部通过后执行 `npm run typecheck`；记录 P1-A 是否通过并提交 `test: complete the temple letter story through production rules`。

**P1-A gate：** 五条离线路线都有完整终局，规则与原文历史能解释差异。若只能靠不断新增故事专用 if 分支才能前进，停止进入 P1-B，先缩减/修正规则契约。

## P1-B：让真实 AI 使用这些能力

### Task 5：双向证据检索与持续对话指代

**阅读：** Spec §5.2–§5.5；连续性与记忆；[ST 参考](../../设想/SillyTavern_Architecture_Analysis_for_AI_RPG.md)中关键词、作用域、递归与编译部分。

**Files:**

- Create: `src/game/gameplay/rpg/narrativeMemory/retrieveStoryEvidence.ts`、对应 `.test.ts`。
- Modify: `src/game/gameplay/rpg/narrativeMemory/retrieveNarrativeMemory.ts`、`src/game/application/entityContextProjection.ts`、`src/game/application/server/ai/narrativeContext/index.ts`、`src/game/domain/storyState.ts`、`src/game/application/server/persistence/storyStatePersistenceValidation.ts`。
- Test: 既有 `retrieveNarrativeMemory.test.ts`、`entityContextProjection.test.ts`；Create: `src/game/application/testing/storyEvidenceJourney.test.ts`。
- Docs: 连续性与记忆；不为派生索引新增持久权威系统文档。

**Interfaces:** 导出以下类型和 `retrieveStoryEvidence(input: EvidenceQuery): EvidenceSelection`：

```ts
type EvidenceQuery = Readonly<{
  worldState: WorldState;
  storyState: StoryState;
  observerId: EntityId;
  text: string;
  actionEntityIds: readonly EntityId[];
  focusEntityIds: readonly EntityId[];
}>;
type EvidenceSelection = Readonly<{
  entityIds: readonly EntityId[];
  eventIds: readonly EventId[];
  historyIds: readonly string[];
  ambiguousEntityIds: readonly EntityId[];
  manifest: readonly { ref: string; reason: string; mandatory: boolean }[];
}>;
```

持续话题存 `StoryState.dialogueFocus: {npcId: NpcId; entityIds: readonly EntityId[]; eventIds: readonly EventId[]} | null`。同一谈话中保留对象引用并重新加载其当前状态；换主交谈对象、移动离场或显式换题时更新/清空。战斗回滚快照同样包含此引用状态。

- [ ] 用 Task 4 source 形成真实事件/原话，再让关键事件退出最近四场窗口；写直接别名、经历描述、“他当时说了什么”、否定句“两人都不是老板”、两个相似帮助者的测试。禁止把名字直接藏在描述 query 内使测试失去意义。
- [ ] 运行 `npx vitest run src/game/gameplay/rpg/narrativeMemory/retrieveStoryEvidence.test.ts src/game/application/testing/storyEvidenceJourney.test.ts`，确认旧检索不足导致失败。
- [ ] 实现两条入口合流：ID/已知别名→实体→事件；原文/经历词→History/Event→参与者。中文使用标准 Unicode 归一化、名称/已登记别名匹配及字词片段打分，不引入分词依赖；泛称单独不能唯一命中。排序按显式 action 引用、活跃 thread/承诺、确切称呼/经历、因果相关、近期；实体和因果补充最多一跳。
- [ ] 对候选先做 observer 可知/可感知过滤，不能由隐藏别名命中泄露存在。明确追问与活跃承诺证据标 mandatory；预算无法装入时报明确上下文失败，不静默删除。编译时 manifest 仅记录 ID/原因，不混入私密正文：

```ts
const required = selection.manifest.filter(item => item.mandatory);
expect(required.some(item => item.ref === oldHistoryId)).toBe(true);
expect(selection.ambiguousEntityIds).toHaveLength(2);
```

测试里的 `oldHistoryId` 从 runner 真实 History 选取；ambiguity 是独立双候选用例。代词缺少唯一 focus 时保留消歧候选，不静默选第一项，也不创建新 NPC。

- [ ] compiler 按 History 引用装入真实原话；显示选项与实际对白分槽。重载 focus、目标状态变化后重新读取、长间隔 recall 均测试通过；运行 memory、projection、compiler、persistence、battle 测试及 typecheck。
- [ ] 更新文档并提交 `feat: retrieve story evidence by entities experiences and active threads`。

**验收：** A4/A5 可用原始证据而非摘要证明；检索权限与角色知识保持一致。

### Task 6：角色自知、行为提议与本次披露分离

**阅读：** Spec §5、§7；NPC 系统、世界具象化；现有 `npcSpeechAuthority.ts`。

**Files:**

- Create: `src/game/application/npcDeliberationSource.ts`、`src/game/application/projectNpcDeliberation.ts`、对应 `.test.ts`；`src/game/application/server/ai/liveNpcDeliberationSource.ts`、对应 `.test.ts`。
- Modify: `src/game/application/npcSpeechAuthority.ts`、`src/game/application/narrativeBundleSource.ts`、`src/game/application/server/ai/rpgAiClient.ts`、`src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`、`src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`。
- Docs: NPC 系统、[世界具象化](../../agent/世界动态具象化.md)、[设计原则](../../游戏设计原则.md)中本 Task 实际开放的局部补充。

**Interfaces:** Task 5 证据按单 NPC 投影；新 application source 定义：

```ts
type NpcDeliberationInput = Readonly<{
  npcId: NpcId;
  jobId: NarrativeJobId;
  candidateVersion: number;
  privateContext: string;
}>;
type NpcDeliberationProposal = Readonly<{
  npcId: NpcId;
  goalIds: readonly string[];
  response: "cooperate" | "refuse" | "question" | "offer_condition";
  evidenceEventIds: readonly EventId[];
  discloseFactIds: readonly FactId[];
  interactionProposals: readonly StoryInteractionProposal[];
}>;
interface NpcDeliberationSource {
  generate(input: NpcDeliberationInput): Promise<
    { ok: true; proposal: NpcDeliberationProposal }
    | { ok: false; code: "PROVIDER_FAILURE" | "INVALID_PROPOSAL" }
  >;
}
```

`projectNpcDeliberation(input: { worldState: WorldState; storyState: StoryState; npcId: NpcId; jobId: NarrativeJobId; candidateVersion: number }): NpcDeliberationInput`。输出只含该 NPC 的自知、目标与观察。source 不输出持久“思维链”，不写状态。

- [ ] 写 RED：老板知道行踪但接应人不知；私密事实可影响老板选择拒绝，却不出现在作者 prompt、玩家文案和公共 manifest。接应人实际听到后才新增带事件来源的知识。
- [ ] 运行 `npx vitest run src/game/application/projectNpcDeliberation.test.ts src/game/application/server/ai/liveNpcDeliberationSource.test.ts src/game/application/npcSpeechAuthority.test.ts`。
- [ ] 实现按 NPC 分离的调用输入，只有“角色反应涉及条件披露、冲突目标或新互动”时启用，普通问候复用现有显式规则。P1 每版候选至多两个实际参与 NPC 各调用一次，不创建旁白/选项润色调用。
- [ ] 对 disclosure 再走服务端权限判断；获准 outward projection 只含反应、可公开依据和可披露 factIds，不能把 privateContext 交给整场作者。审阅可在受控审计范围看到权限边界，但其 pass 不改变边界。
- [ ] interactionProposals 复用 Task 2 已接通的四种操作及编译/descriptor 入口，本 Task 只增加 NPC AI 提议来源；经当前目标、事实来源与所有权检查后才进入未提交候选，不能自授引荐资格。动态世界继续使用 P1-A 已实现的局部 fact/互动和既定后续角色具象化；未来步骤不提交当前知识。Task 1 的有序表达和实际受众是唯一披露写回来源，不根据 NPC 提案中“打算告知”提前传播。
- [ ] AI 请求仍使用已有 `narrative_bundle` 传输/审计 role，RPG 日志另记 purpose=`npc_deliberation`，不扩 foundation 的 role enum。测试 private prompt 独立、拒绝越权、依据失效、新角色初始知识来源，再运行边界检查/typecheck。
- [ ] 更新文档并提交 `feat: separate private npc deliberation from public disclosure`。

**验收：** NPC 可以因秘密而行动，但玩家及另一 NPC 不凭空知道秘密；新增许可必须有依据。

### Task 7：整场候选与未提交提案共同修订

**阅读：** Spec §7、§8；运行时 AI；Task 2/6 接口，不读旧三路润色实现作为前置依赖。

**Files:**

- Create: `src/game/application/narrativeCandidateReview.ts`、`src/game/application/server/ai/liveNarrativeCandidateReview.ts`，各自对应 `.test.ts`。
- Modify: `src/game/domain/narrativeBundle.ts`、`src/game/application/narrativeBundleSource.ts`、`src/game/application/approveNarrativeBundle.ts`、`src/game/application/generatePendingNarrativeBundle.ts`、`src/game/application/createGame.ts`、`src/game/application/aiGenerationRetry.ts`、`src/game/application/server/ai/liveNarrativeBundleSource.ts`。
- Test: 上述审批/source/generator/createGame 测试；Docs: 运行时 AI、设计原则中整场生成与有限修订契约。

**Interfaces:** 保留 `NarrativeBundleSource.generate(context)` 的统一 opening/decision 出口；在 context/候选 envelope 增加 `candidateVersion`、`candidateHash` 和 outward NPC 提议，沿用 Task 1 已启用的 **Bundle2**。`currentScene.expressions` 仍是一个有序正文源；其 choices 使用 Task 2 已接通的互动编译/descriptor/批准动作身份，本 Task 不再首次引入这些基础能力。

```ts
type CandidateDefect = Readonly<{
  candidateVersion: number;
  candidateHash: string;
  scope: "scene" | "proposal" | "npc_behavior";
  code: "MISSED_INPUT" | "UNSUPPORTED_FACT" | "DISCLOSURE"
    | "ACTION_MISMATCH" | "BROKEN_CAUSALITY";
  path: string;
  reason: string;
}>;
type CandidateReviewResult =
  | { ok: true; candidateVersion: number; candidateHash: string }
  | { ok: false; candidateVersion: number; candidateHash: string; defects: readonly CandidateDefect[] }
  | { ok: false; candidateVersion: number; candidateHash: string; failure: "PROVIDER_FAILURE" | "UNCERTAIN" };
```

`reviewNarrativeCandidate(input: { context: NarrativeBundleSourceContext; proposal: NarrativeBundleProposal | OpeningNarrativeBundleProposal; candidateVersion: number; candidateHash: string }): Promise<CandidateReviewResult>` 是 `NarrativeCandidateReviewer` 接口的方法，类型在 application 文件导出；live factory 依赖既有 `RpgAiClient`。hash 由服务端对规范化完整候选（含互动、受众与 NPC outward 依据）计算，不采用 AI 自报值；review 只给缺陷，不写 mutation，不授知识。

审阅故障的 `failure` 分支直接进入显式失败；有缺陷的分支只有非空 defects 才能继续修订。通过必须显式 `ok: true` 并匹配版本和 hash，不能把空数组、解析失败或缺少结论推定通过。

- [ ] 写三组注入失败：第一稿漏玩家“先核验”条件；第一稿发明未建立的验真器；第一稿公开受保护身份。第二稿允许重写正文与相关新互动，已提交行动/事实原样保留。模拟 reviewer 网络失败必须失败，不能被当作空缺陷 pass。
- [ ] 运行 `npx vitest run src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/narrativeCandidateReview.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts`。
- [ ] 实现单候选循环：结构/规则预检→一项逻辑语义审阅→最终版本与规则复核→B。初稿加两次修订，最多 **3 个候选版本**；内容错误回到拥有缺陷的候选，不把未提交 proposal 早早冻结。
- [ ] 任意正文、NPC outward 依据或 proposal 内容变化都会使旧审阅失效：

```ts
if (review.candidateVersion !== candidateVersion || review.candidateHash !== candidateHash) {
  return { ok: false, code: "STALE_CANDIDATE_REVIEW" };
}
```

此错误由审批结果 union 显式增加，不映射成通过。结构校验失败不花一次语义审阅；每版最多一次审阅逻辑请求，传输重试由 Task 8 的统一计数约束。

- [ ] opening 同样通过完整候选/审阅，但不为不存在的已物化 NPC 调用角色判断；初始化角色目标、证据与场景须共同一致。P1 保留 descriptors 所需的最小 continuation，覆盖本次决策后至下一正式决策/已获准终局之间的移动、交付等规则消费；不能默认只产 currentScene 而让这些动作无内容可消费。每个实际场景仍只有一份有序正文，未来步骤未消费不写事实/History，不预写后续整篇，不新增单位 DAG。用真实 bundle parser/approval 测试缺必要 continuation 明确拒绝。
- [ ] 去掉生产入口对旧独立 polish/legacy scene source 的依赖；自由输入原句、上一行动后果、未解决问题与候选动作条件在作者上下文中一并存在。语义审阅关注整场因果与输入回应，不以字词黑名单替代判断。
- [ ] 运行 opening、approval、generator、source、bundle parser 测试及 typecheck；更新文档并提交 `feat: revise whole scene candidates with their uncommitted proposals`。

**验收：** A7 三类错误能修到正确候选；没有“规则提案已锁死，只能换措辞”的路径。

### Task 8：持久尝试、并发隔离、正式装配与 UI 恢复

**阅读：** Spec §8；运行时 AI、项目脚手架的存档隔离说明；只定向参考 staged 的 CAS/持久任务修复。

**Files:**

- Create: `src/game/domain/narrativeGenerationAttempt.ts`、对应 `.test.ts`；`src/game/application/testing/narrativeRecoveryJourney.test.ts`。
- Create: `src/game/application/server/ai/narrativeRequestClient.ts`、`src/game/application/server/ai/narrativeRequestClient.test.ts`；按 purpose 选择 RPG 本地 policy、计数、取消与审计，不扩共享 transport role。
- Modify: `src/game/domain/pendingNarrativeJob.ts`、`src/game/application/server/persistence/gameRepository.ts`、`src/game/application/server/persistence/sqliteGameRepository.ts`、`src/game/application/server/persistence/storyStatePersistenceValidation.ts`。
- Modify: `src/game/application/generatePendingNarrativeBundle.ts`、`src/game/application/createGame.ts`、`src/game/application/consumeNarrativeBundle.ts`、`src/game/application/server/compositionRoot.ts`、`src/game/application/gameSessionView.ts`、`src/game/application/server/ai/rpgAiClient.ts`。
- Test: 对应 SQLite、compositionRoot、gameSessionView、createGame、generator 测试；Docs: 运行时 AI、连续性与记忆、MVP 玩家规则中的失败/恢复。

**Interfaces:** `PendingNarrativeJob.attempt: NarrativeGenerationAttempt`，定义如下；initial opening 未建立 GameRecord 时仍须使用初始化请求的独立 attempt 审计和原有 replace CAS，失败不得覆盖现存游戏。

```ts
type NarrativeGenerationAttempt = Readonly<{
  epoch: number; // 显式手动重试递增，jobId 不变
  candidateVersion: number; // 已预留的最后版本：0..3；0 表示尚未生成
  candidateHash: string | null; // 当前已返回候选的服务端摘要；不能代表尚无正文的版本
  leaseId: string | null;
  leaseExpiresAt: string | null;
  httpAttempts: number;
  status: "idle" | "running" | "failed";
}>;
```

`ApplyStateInput.expectedNarrativeJob` 扩展 `epoch`、`leaseId`、`candidateVersion`、`candidateHash` 作为 CAS 谓词；元数据更新可保持 revision，但必须匹配 job/status/epoch/lease 与操作所需的候选身份。B 同时匹配 gameplay revision 及完整候选身份。时钟/UUID 在 application/server 注入，domain 不读取。

P1 不建设可恢复的逐阶段候选仓库：**每次开始新的候选工作前，短 CAS 预留 candidateVersion+1 并清空 candidateHash，然后才执行角色判断/作者请求**。收到作者结果后记录其服务端 hash；进程失去内存中的候选时，该版本额度已经消耗，恢复只能预留下一个版本，不能再以相同版本创作新内容。版本 3 耗尽后转 failed，不能因租约回收获得第 4 份内容。传输重试只属于同一个尚未取得有效响应的逻辑请求；一旦收到可解析候选，不准以“重试”再采一份同版本正文。迟到响应受 lease/version 限制丢弃。

`narrativeRequestClient.ts` 导出 `NarrativeRequestPurpose = "author" | "npc_deliberation" | "review"` 与 `completeNarrativeRequest(input: { purpose: NarrativeRequestPurpose; messages: readonly AiMessage[]; auditContext: AiTextAuditContext; signal: AbortSignal }): Promise<AiCompletionResult>`（以 factory 注入现有 client/预算存储）。这些消息/返回/审计类型复用既有类型。factory 为三个 purpose 分别创建配置了 `narrative_bundle` policy 的现有 RpgAiClient 实例：author/NPC 240 秒，review 120 秒；审计记录 purpose。不能把三个 purpose 都交给同一个 role 默认 45 秒配置，却声称不同超时已生效。每次底层 HTTP 发送前经统一预留回调计数；不能只在 complete 外层计一次而漏掉 client 内部 retry。新增回调与取消只在 RPG client 内实现，公共包不变；底层若不能中止在途请求，调用者停止等待并 fence 掉迟到结果，审计明确标记取消不等于 provider 停止计费。

- [ ] 写正式 SQLite 并发测试：两个 ensure 同时读取 pending 只能一个获得租约；过期租约被回收后旧 worker 即使返回也不能提交；A 成功后 B 故障/重启保留物品与输入，重试只生成 B。
- [ ] 运行 `npx vitest run src/game/application/testing/narrativeRecoveryJourney.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts`，确认当前 revision-preserving 竞争路径失败。
- [ ] 实现单 job 租约而非细分任务图：获取/续期/释放均用短 CAS；请求前持久计数，租约 600 秒，每 60 秒续期；回收须确认已过期。手动重试 epoch+1，自动恢复同 epoch 不重置 candidateVersion/httpAttempts；在途 worker 始终受旧 lease fencing 限制。
- [ ] 增加作者返回后崩溃、审阅通过后/B 前崩溃测试：恢复生成必须使用更大版本；旧 hash 的 pass 不可用于新正文；耗尽三次预留后即使 HTTP 尚余预算也失败。对 HTTP 前崩溃同样不退回已预留版本，宁可显式重试，不能无法核对地重采。
- [ ] 所有 purpose 经同一 RPG client 包装器做 HTTP 预算、超时、取消和审计；作者/角色单次超时 240 秒，review 120 秒，传输最多两次尝试（包括首次）。取消后即使底层迟到仍禁止 B；不修改公共 transport 来实现本任务。
- [ ] 每个 epoch 最多 **24 次 HTTP**：3 个候选 ×（至多 2 个角色判断+1 个作者+1 个审阅）×2 传输尝试。opening 亦受此上限；请求前预留额度，崩溃后不退回，以免低估已发送调用。内容失败不会重启另一层四次循环。
- [ ] composition root 正式注入 Task 6/7 sources 与 reviewer；gameSessionView 复用已有 pending/failed/retry UI 展示。失败没有剧情替代文本；opaque choice token 保持唯一入口，旧 revision/未消费步骤仍零写入。初始化失败保留旧结束存档，不自动补一个开局。
- [ ] Task 6/7 的 live sources 改消费 purpose client，保留统一 domain/application source 接口；opening 同用 author purpose。尚无 GameRecord 的初始化中断记一次失败初始化，不能假装恢复已有 pending job；后续显式重开是新的初始化尝试，Task 9 正式批次不得用它替换 S1/S2 的失败分母。
- [ ] 测试三版耗尽、手动重试、取消、reload、异常 SQLite rollback、并发 ensure、战斗回退和未来步骤消费；运行 `npm run test:boundaries`、typecheck 与相关 tests。确认 DB 调用期间没有 await 网络。
- [ ] 更新文档并提交 `feat: recover narrative generation without replaying committed actions`。

**P1-B gate：** 正式装配的 fake transport 测试能完成 Task 4 故事；断网、迟到、过期 token 和重载均不能制造错误后果。此处 fake transport 只验证装配，不声称已验证 live 质量。

## P1-C：固定样本完整旅程验收

### Task 9：建立可复跑、不能挑样本的 live 旅程协议

**阅读：** Spec §11；[AI 环境](../../agent/AI环境.md)、现有 `scripts/phase4bAiSmoke.mjs` 的运行时装配与日志方式。不读取或输出 API key，不复用 main/staged 的存档。

**Files:**

- Create: `src/game/application/testing/narrativeP1LiveJourney.ts`、`src/game/application/testing/narrativeP1LiveJourney.test.ts`、`scripts/narrativeP1Journey.mjs`、`scripts/narrativeP1Journey.node-test.mjs`。
- Modify: `package.json`，添加 `journey:narrative:p1` 与 `test:narrative-p1-script`。
- Create: `docs/superpowers/reports/2026-09-12-narrative-p1-protocol.md`（在本 Task 实施时生成并冻结）；不在此计划编写轮填造模型名、输入哈希或成绩。

**Interfaces:** runner 导出 `runNarrativeP1Journey(input: { mode: "register" | "live" | "replay"; runId: string; protocolPath: string; artifactDirectory: string }): Promise<{ completedRoutes: number; plannedRoutes: 6; passed: boolean }>`。脚本支持 `--mode`、`--run-id`、`--protocol`、`--output`；register 零网络，live 必须读取已冻结协议，replay 零网络重放审计响应。通过标准为退出码 0，未完成/硬错误/协议违规为 1，参数或未登记为 2。

- [ ] 写 node 参数测试和 fake transport runner 测试：register 零请求；少一个开局不得把分母改成 3；第 1001 次 HTTP 被预算阻止；协议哈希/代码不符拒绝开始。运行 `node --test scripts/narrativeP1Journey.node-test.mjs` 与 runner 的 Vitest RED。
- [ ] 注册以下完整 `NewGameInput`，通过现有 `validateNewGameInput` 后冻结规范化 JSON；不让 runner 临时挑选题材、姓名、文风或另补隐含背景。故事工程约束由开局编译契约保障，不能只靠用户输入里一句“须支持”。

```json
{
  "gameType": "wuxia",
  "characterName": "沈行",
  "characterIdentity": "曾受老信使帮助的过路旅人",
  "characterProfile": "愿意帮助他人，但在交付重要物品前会核实身份。",
  "personalityTags": ["谨慎", "守信"],
  "worldPremise": "江湖渡口附近有一座破庙和一间客栈。有人追查一份证词的来历，公开调查可能暴露老信使的行踪。",
  "storyOpening": "我在破庙得到老信使帮助，接受将唯一信筒交给渡口接应人的委托。我需要决定私下寻求引荐，还是通过公开渠道核验；也可以先核实接应人的身份再交付，或承担后果退出委托。",
  "narrativeStyle": "novel",
  "contentIntensity": "normal",
  "gameLength": "short"
}
```
- [ ] 冻结实际 `AI_MODEL` 非空值、API base（不含 key）、所有 purpose 的本地 policy thinking=`on`（wire 值 `thinking.type="enabled"`）、JSON 模式=`prompt_only`，作者/NPC/review 均不设置 `max_tokens`，temperature 不额外覆盖。register 只校验本地参数及已有 provider 能力声明，零网络不宣称已实测兼容；live 若 provider 拒绝参数，记配置失败，不静默切换。模型自称名称不能代替配置快照。
- [ ] 固定次数：两次独立初始化，依次为 S1、S2；每个获批开局按原样复制到三个独立测试数据库跑 private/public/verify_first，禁止重新生成角色替代失败。总 **6 条预定路线**；额外 exit 只算离线覆盖，不能替换失败 live。
- [ ] 固定选择政策：private 首选明确保密后获取引荐；public 不先承诺保密，询问公开渠道并核验；verify_first 在首个交付机会输入 **“我想先核实接应人的身份，再决定是否把信筒交给他。”**，先选核验、后显式交付。其他节点优先当前任务的合法推进项，两项同等时按屏幕顺序；通过获批 interaction/action 引用检查，不能用后门状态或预知后续文案选路。无匹配合法步骤记路线失败，保留场景。
- [ ] 固定预算：每路线最多 24 次有效动作、每 job 最多 3 个候选/epoch、24 次 HTTP/epoch；整批上限 **1000 次 HTTP、3 小时墙钟**（含自动重试和初始化，不含离线人工阅读）。单 job 最多一次显式人工重试，整批最多六次；runner 不代替人按重试。首次失败与重试后完成分栏，预算耗尽剩余路线记未完成。
- [ ] 产物落在 worktree 独立 `artifacts/narrative-p1/<runId>/`：协议及哈希、代码 commit/dirty diff 哈希、规范化输入、环境非密配置、两次开局、每步 before/after/revision、原文/选项/实际动作、provider 原始响应、每版缺陷和 disposition、HTTP/耗时计数、A1–A10 引用表。不得输出 key；私密角色资料仅保留在本地受控审计，不进入玩家 History。
- [ ] runner 复用正式 composition/SQLite，使用项目现有 TS runtime alias/server-only 装配方式，不建另一套生成实现。实现入口脚本与 package scripts：

```json
{
  "journey:narrative:p1": "node scripts/narrativeP1Journey.mjs",
  "test:narrative-p1-script": "node --test scripts/narrativeP1Journey.node-test.mjs"
}
```

- [ ] 运行脚本/runner 测试、typecheck、`npm run check:docs`；提交 `test: register bounded full-story narrative experiments`。协议中的代码版本指向最终待测提交，登记文件的纯记录变更不冒充实现变化。

**验收：** 实验前可检查要跑什么、怎样判失败、何时停止；失败开局和修订稿均无法从分母消失。

### Task 10：执行六条旅程、实机闭环与 P1 结论

**Files:**

- Create: `docs/superpowers/reports/2026-09-12-narrative-p1-acceptance.md`。
- Modify: 本 Plan 验收记录；受影响系统文档仅修正实际实现事实，必要时才登记新系统入口。
- 不为得到通过成绩直接修改已登记样本输入/评分门槛；实现若变化，先结束当前批并保留记录。

**Interfaces:** 消费 Task 9 协议和产物，输出可逐条追溯的 P1 结论；没有新增生产 API。

- [ ] 执行 `npm run accept`，这是进入 live 前一次完整验收；失败先处理，再冻结版本。旧阶段指针保持不动，`phase:status` 的旧计划状态不冒充本 P1 状态。
- [ ] 执行 register 零网络校验并人工核对输入/模型/预算，随后用同一 protocol 执行 live：

```powershell
npm run journey:narrative:p1 -- --mode=register --run-id=p1-01 --protocol=artifacts/narrative-p1/p1-01/protocol.json --output=artifacts/narrative-p1/p1-01
npm run journey:narrative:p1 -- --mode=live --run-id=p1-01 --protocol=artifacts/narrative-p1/p1-01/protocol.json --output=artifacts/narrative-p1/p1-01
```

register 生成的模型值/设置由可用环境读取并冻结；此命令块本身不是已执行证据。

- [ ] 实机 UI 至少完成其中一个实际存档从创建到终局，中途重载；可把一条预定路线以 UI 驱动完成并纳入同一 runner 记录，不能只播放已有终局截图。记录按钮/token、自由输入、失败重试可见性、重载前后状态与最终图文。
- [ ] 逐条核对 A1–A10。A7/A8/A9 的故障注入可用正式装配的离线证据，A1/A3/A6/A10 同时给 live 状态和原文；A2/A4/A5 至少有正式仓储旅程证据，若 live 未触发则明确标“离线验证”，不能宣称六条均覆盖所有行为。
- [ ] 人工阅读六条完整轨迹，分别按局部衔接、人物动机、因果/悬念、选择后果可感知、结局收束评分 1–5；每条路线五维均分 ≥4、每维 ≥3，无确认硬错误且六条全部到合法终局才通过。给出具体原文/事件引用，模型 pass 不代替人工判断。
- [ ] 报告列出每条的首次/修订/手动重试结果、全部失败类别、HTTP/时间和适用范围。未完成路线不填虚构质量分；同时明确总体门槛不通过。P1 通过也只证明该批小故事可行，不能声称优于 main 或可支持长篇。
- [ ] 完成文档事实归属复核、相对链接检查、`npm run check:docs`、`git diff --check`；提交 `docs: record complete story P1 acceptance evidence`。本 Task 不合并 main、不删除 staged/worktree。

**P1-C gate：** 六条完成、矩阵有证据、每条质量达到门槛，才开始讨论 P2 Plan。若失败，报告根因在规则、检索、权限、创作、审阅或运行的哪一层，不能继续无上限增加局部修补轮次。

## 覆盖核对与验收记录

| Spec 目标/验收 | 主要 Task | 核对证据 |
| --- | --- | --- |
| G1/G5、A1/A6/A10 | 2、3、4、9、10 | 具体动作契约、五条离线终局（含两种退出）、六条 live 完整路线 |
| G2、A7 | 6、7、10 | 输入回应、整场修订、逐路线人工阅读 |
| G3、A2/A4/A5 | 1、3、5 | 原话落盘、承诺重载、双向召回与长期证据 |
| G4/G6、A3 | 2、5、6 | player/NPC 认知、实际受众、私密判断与向外披露 |
| G7、A8/A9 | 1、7、8 | A/B 原子性、候选版本、租约/幂等、取消与未来步骤隔离 |
| Spec §9 小故事边界 | 3、4、9 | 三幕、延迟具象化、唯一 owner、核验证据与退出规则 |
| Spec §12/§13 | 1–3、5–8、10 | Entity3/World7/Story10/Bundle2、旧档拒绝、现行系统原位维护 |

执行者完成每个 gate 后将以下“未执行”替换为结论及报告相对链接，不追加按日期排列的进度流水：

- **P1-A：** 已完成。Task 1–4 已实现并提交；Task 4 五路线、SQLite 重载、普通离场/自由输入负向探针及相关规则回归证据见 [P1-A 验收报告](../reports/2026-09-13-narrative-architecture-p1-a.md)。
- **P1-B：** 未执行。
- **P1-C：** 未执行。
- **P1 总结论：** 未执行；本文件仅为实施计划。

P2 的检索摘要与中篇验证、P3 的丰富 Entity/世界行为、P4 的扩容与性能仍只维护在总 Spec，当前不生成它们的实施 Task。
