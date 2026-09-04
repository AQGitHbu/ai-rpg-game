# Hierarchical Living Outline and Story Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在短篇/中篇仍能完整通关、玩家决策后一次生成并逐步消费的前提下，建立有事件证据、可嵌套、可修订的 Living Outline，让已发生经历、当前任务、长期未决问题和未来意图分别有明确归属。

**Architecture:** Story Contract 保持稳定；`StoryState.outline` 保存初始计划、追加的受控修订与可重建进度。domain 定义封闭协议，gameplay 从真实 Event/Quest 推进 Arc/Milestone/Thread，application 审批 AI 的有限规划提案；同一 `NarrativeBundleSource.generate` 响应以独立 `outlineUpdate` 子对象携带修订，和世界增量、当前场景一起审批、一次 CAS 落库。计划不是未来事实，也不成为第二套任务引擎。

**Tech Stack:** 当前仓库 TypeScript 5.8.3、Vitest 3.1.4、Next.js 16.2.10、SQLite JSON/CAS、Entity Store v2、WorldState v5、Narrative Context Compiler；不新增依赖、provider 角色、API 或共享 package。

**Spec:** `docs/superpowers/specs/2026-08-23-long-form-narrative-entity-memory-architecture.md`，重点 §3、§8、§10、§11.3、§14 Plan 5；NAR-10、NAR-11、NAR-14、NAR-17。

## Global Constraints

- 总 Spec：“玩家能改变计划，但不能改写过去。”已提交 Event、已达到里程碑、已完成剧情弧和已履行承诺不能被普通生成覆盖。
- 总 Spec：“三幕式是可选且可嵌套的结构策略之一”；支持 `three_act / five_act / mystery / quest / custom`，不是把 `currentAct` 改名为 Arc。
- 总 Spec：“每个重构阶段结束后，短篇和中篇都必须能从新游戏完整玩到结局”；本 Plan 不开放 `long/open`，不承诺十小时能力。
- 战斗失败/撤退恢复战前 Entity Store、ledger、memory、outline 与叙事队列；失败尝试不得成为永久大纲依据。
- 当前生产约束优先于 dated Spec 的旧运行链描述：开局是一次 initialization；正式选择/焦点 NPC 自定义输入走一次 decision bundle；移动、调查、取物、赠物、战斗与展示消费不增加 provider 调用。
- `outlineUpdate` 是独立、有限、可单独解析的提案协议，只复用同一个网络响应容器；不新建后台 outline provider，不建立第二个 ensure/存档写回入口。
- 生产 AI 失败仍显式 failed/manual retry；不以规则生成的剧情、fixture 或默认台词冒充 AI 成功。保留上一次已批准计划不等于生成一份 fallback 剧情。
- 权威顺序保持 `rule → state → event → plan → memory → lore`；计划不能改变 Action 成败、任务目标、关系数值、知识披露、敌人属性或结局选择。
- 只修改 `ai-rpg-game`；不改 `.foundation` 或 sibling 仓库，不创建通用图框架/共享 package。若实际触发共享基础设施边界，停止相应扩展并按 AGENTS 路由处理。
- 实施前读根 AGENTS、游戏设计/开发规范、Agent 索引、当前开发阶段及本文列出的相关 agent 文档。参考文档不是实现依据。
- Plan5 实施使用 `codex/hierarchical-living-outline-story-threads` / `.worktrees/hierarchical-living-outline-story-threads`；本次 Plan4 修复在 main，不能因此将 Plan5 也直接在 main 实施。
- StoryState 在 Task 5 从 v8 升 v9；WorldState 保持 v5、EntityStore 保持 v2、record version 保持 1。旧 Story v1–v8 明确 `UNSUPPORTED_RECORD`，未知未来版本 `VERSION_MISMATCH`；不静默重建旧存档，不自动清档。
- 不修改 `StoryContract.targetActs: 3 | 5`、现有短/中篇预算、世界具象化的目标链策略或战斗数值。计划里的 `phase` 与游戏里的 `currentAct` 不是同一个概念。

---

## 0. 状态与最新代码基线

> 状态：待执行

本文只规划 Plan5，不包含本轮已完成的 Plan4 修复任务。

基线为 2026-09-04 main（`80a0b4c` 后本轮 Plan4 复核修复）。执行前以实际 main 文件核对，不能按旧 Plan 中已删除的文件创建兼容入口。

| 已核实事实 | Plan5 必须如何接入 |
|---|---|
| `StoryState` v8 只有 Contract、数值幕/张力、`unresolvedThreads: string[]`、memory；没有真实 Arc/Thread 对象 | 新增独立 outline，不声称旧字符串数组已具备线程生命周期 |
| `advanceStoryProgression` 按主线 Quest.stage/完成状态推进幕并设置 EvolutionNeed | 保留游戏执行权威；outline 记录/约束叙事意图，不取代 Quest resolver |
| 生产 continuation 是 `narrativeBundle`；旧 `PreparedContinuationState` 仅 offline fixture 使用 | 两者的状态提交都要同步 outline；新 AI 协议只接生产 bundle |
| `generatePendingNarrativeBundle` 最多四次完整尝试，成功后调用 `repository.applyState` 一次 | 不按旧文档寻找已经删除的 `sceneWriteBack.ts`；在现有 retry/CAS 内加入规划审批 |
| `materializeWorldDelta` 返回 preview + drafts，可能提前创建下一幕 Quest，reveal 不提前释放 | “实体已创建”不等于“角色已经见到”，更不等于未来 Arc 已执行 |
| Event payload 为封闭 union；NPC 来源使用 Event ID；memory 从 ledger 重建 | Thread/Milestone 只能引用合法 Event，不用 actionId、正文或数组下标代替证据 |
| 本轮修复了 payload 完整校验、重试回合号比较、前因/物品召回与本轮/历史隔离；bundle 消费现在记录 presented Event | 新增 payload 必须同步 `eventPayloadValidation.ts`；本 Plan 不需要新增世界 Event 类型 |
| `mediumActJourney.test.ts` 当前只证明中篇初始化/首次决策，不是完整五幕通关 | Task 10 新建生产 bundle 完整旅程；不拿文件名当完成证明 |

### 0.1 每个阶段结束后能玩什么

整个 Plan5 完成后，玩家仍可创建短/中篇、双选项/自由输入、探索、取物/赠物、对话、战斗、失败重赛、恢复存档并抵达结局。增加的是跨幕中心问题、旧线索/承诺的可追踪性，以及玩家行为改变近未来方向的能力。

不新增玩家菜单、支线任务玩法、休整/成长系统或长篇入口。Task 1–4 是未接运行时的纯增量模块，游戏不变；Task 5 完成 schema 与规则投影整批切换，游戏仍可通关；Task 6–9 逐步加入 AI 修订和 prompt 约束，不能留下需要“下一 Task 才能玩”的提交。

## 明确边界

- **本 Plan：** 保存结构功能、前置里程碑、赌注/问题、线程、未来方向与批准修订；让 scene/world prompt 读到它们。
- **Plan6：** 用这些输入真正选择 scene intent、安排场景类型轮换、转折/高潮、战斗的戏剧功能，并调整世界目标链。Plan5 不增加 `ScenePlan`，不强制某个回合发生战斗。
- **Plan7：** 分段 ledger、快照、归档、索引表、context fingerprint 与非线性长局成本。Plan5 的内存重建仍允许扫描完整短/中篇 ledger。
- **Plan8：** 十小时 Campaign、长期预算与真实长局验收。

## 1. 设计决策

### 1.1 三种权威必须分开

1. `StoryContract`：本局中心冲突和两个结局方向，初始化后不接受 outline 指令修改。
2. `OutlineDefinition`：批准的叙事计划，回答“准备围绕哪些问题、用怎样的结构继续”，不是已经发生的事实。
3. `OutlineProgress`：从当前规则事实和真实 Event 派生的“哪些节点激活、达到或关闭”。AI 不提交 status、phase 游标、completedAt 或 endingAllowed。

Outline 与 Episode 的重建语义不同：Episode 全部来自 Event；AI 创作的未来方向不能从规则事件猜出来。outline 初始定义和批准修订是计划的持久化源，进度才是可重建投影；不把 AI 大纲伪装成世界事件。

### 1.2 嵌套而不绑死幕数

结构层级固定允许 `campaign → chapter → quest → scene_sequence`，最大深度 4；父子模板可以不同，也可以都是三幕式。执行绑定由规则生成：campaign 对应全局契约；chapter 对应现有游戏 stage；quest 对应真实 Quest ID；scene_sequence 对应该 Quest 的目标范围。

campaign 三幕式可以包含五个 chapter，而每个 chapter 又选择三幕式/谜题结构。`currentAct=4` 表示游戏进入第四个主线阶段，不表示 campaign 有第四个三幕式 phase。

初始只创建根和无实体的阶段需求；实际 Quest/Sequence Arc 只在 Quest 已审批创建后绑定。预具象化的下一幕处于 planned，不因 store 中已存在 NPC/敌人就把相关经历标成已发生。

### 1.3 滚动窗口

- 历史：只投影带 Event 依据的已达到节点；保留原 ID，不改写。
- 当前：当前 chapter、当前 Quest/Sequence、相关已存在实体和最多 6 条相关 Thread。
- 下一 chapter：最多一个具体方向、4 个待完成 milestone 和 4 个实体槽位；有需要才细化。
- 远期：只有 Contract 的中心冲突、抽象结局方向和阶段需求；不预写远期人物、地点或剧情正文。

玩家改变未来的可验证表现：同 seed 下 `support/challenge/refuse/offer_help` 等真实事件可成为修订原因，批准修订改变下一 chapter 的方向/结构或未来槽位；已完成节点与旧 Event deep-equal。当前自定义输入统一映射中性 ask 的事实保持不变，不能在 Plan5 偷加本地关键词判定“偏航”。

### 1.4 Thread 不是额外的通关锁

`main_conflict` 仅由规则创建并拥有，映射当前主线完成门槛；AI 不能创建新的强制结束条件。其他 question/clue/promise/threat/relationship_conflict 都是叙事线程，默认不阻塞结局。

关闭线程必须符合明确的 evidence predicate，不是“存在任意一个 eventId 就算解决”。`abandoned`、`superseded` 与 `resolved` 是不同结果；结局时未完成可选线程保留为有原因的未兑现/放弃，不伪装全部兑现。

NPC commitment 仍由 NPC 组件拥有；promise Thread 仅引用同一 commitment 的证据与状态，不能另写第二份债务/承诺。关闭剧情线程也不能提升关系 stage 或写 NPC knowledge。

### 1.5 受限修订，与已有生成包同生共死

decision 顶层新增必填 `outlineUpdate: OutlineRevisionProposal | null`，其余字段保留。opening 顶层新增小型 `outlineSeed`；两个子协议都有独立 parser，任何未知字段/越权状态/非法引用拒绝整包。

`null` 表示沿用已批准方向，不是缺字段兼容、不是假装产生新计划。规则进度无论是否有修订都会更新。正文/世界增量若依赖非法修订，不能只丢修订而接受其余内容；整个 attempt 失败，沿用原有 bounded content repair 和同 job 手动重试。

不增加 AI 调用，最多四次 attempt 的边界不变。Plan6 场景规划未接入前，outline 指令也不能更改当包 descriptors、合法选项或未来已经批准的续接步骤。

## 2. Canonical contracts

以下字段和值域是实施合同；新增模块不使用开放 `Record<string, unknown>` 作为持久化业务模型。parser 的临时 unknown 对象不受此限制。

### 2.1 定义与状态

```ts
type ArcId = string & { readonly __arcId: unique symbol };
type MilestoneId = string & { readonly __milestoneId: unique symbol };
type StoryThreadId = string & { readonly __storyThreadId: unique symbol };
type OutlineSlotId = string & { readonly __outlineSlotId: unique symbol };
type ArcScope = "campaign" | "chapter" | "quest" | "scene_sequence";
type ArcStructure = "three_act" | "five_act" | "mystery" | "quest" | "custom";
type DramaticFunction = "setup" | "development" | "reversal" | "climax" | "resolution";
type OutlineRef =
  | Readonly<{ kind: "entity"; entityId: EntityId }>
  | Readonly<{ kind: "slot"; slotId: OutlineSlotId }>;
type ArcBinding =
  | Readonly<{ kind: "campaign" }>
  | Readonly<{ kind: "chapter"; stage: number }>
  | Readonly<{ kind: "quest"; questId: QuestId }>
  | Readonly<{ kind: "scene_sequence"; questId: QuestId; fromObjective: number; toObjectiveInclusive: number }>;
type OutlineArc = Readonly<{
  arcId: ArcId; parentArcId: ArcId | null; scope: ArcScope;
  structure: ArcStructure; customPhases: readonly DramaticFunction[];
  dramaticQuestion: string; direction: string; binding: ArcBinding;
}>;
type OutlineSlot = Readonly<{
  slotId: OutlineSlotId; arcId: ArcId;
  entityKind: "npc" | "location" | "item" | "enemy" | "fact" | "quest" | "faction";
  role: "contact" | "obstacle" | "evidence" | "destination" | "resource";
  requirement: string;
}>;
type EvidencePredicate =
  | Readonly<{ kind: "fact_discovered"; fact: OutlineRef }>
  | Readonly<{ kind: "location_visited"; location: OutlineRef }>
  | Readonly<{ kind: "item_obtained"; item: OutlineRef }>
  | Readonly<{ kind: "enemy_defeated"; enemy: OutlineRef }>
  | Readonly<{ kind: "npc_dialogue_completed"; npc: OutlineRef }>
  | Readonly<{ kind: "quest_completed"; quest: OutlineRef }>
  | Readonly<{ kind: "relationship_signal"; fromNpc: OutlineRef; target: OutlineRef; signal: RelationshipSignal }>
  | Readonly<{ kind: "mainline_ready" }>
  | Readonly<{ kind: "ending_reached" }>;
type OutlineMilestone = Readonly<{
  milestoneId: MilestoneId; arcId: ArcId; function: DramaticFunction;
  prerequisiteIds: readonly MilestoneId[]; condition: EvidencePredicate;
}>;
type StoryThread = Readonly<{
  threadId: StoryThreadId; arcId: ArcId;
  kind: "main_conflict" | "question" | "clue" | "promise" | "threat" | "relationship_conflict";
  question: string; participantRefs: readonly OutlineRef[]; priority: 1 | 2 | 3;
  openedByEventIds: readonly EventId[]; resolution: EvidencePredicate;
  commitmentRef: Readonly<{ npcId: NpcId; targetId: EntityId; commitmentId: string }> | null;
}>;
type OutlineDefinition = Readonly<{
  rootArcId: ArcId;
  arcs: readonly OutlineArc[]; milestones: readonly OutlineMilestone[];
  threads: readonly StoryThread[]; slots: readonly OutlineSlot[];
}>;
type OutlineNodeProgress = Readonly<{
  status: "planned" | "active" | "resolved" | "abandoned" | "superseded";
  supportingEventIds: readonly EventId[];
}>;
type OutlineProgress = Readonly<{
  reducedThroughSequence: number;
  arcs: readonly Readonly<{ arcId: ArcId; phaseIndex: number; phase: DramaticFunction; state: OutlineNodeProgress }>[];
  milestones: readonly Readonly<{ milestoneId: MilestoneId; state: OutlineNodeProgress }>[];
  threads: readonly Readonly<{ threadId: StoryThreadId; state: OutlineNodeProgress }>[];
  bindings: readonly Readonly<{ slotId: OutlineSlotId; entityId: EntityId; sourceEventId: EventId }>[];
}>;
type LivingOutlineState = Readonly<{
  version: 1;
  initial: OutlineDefinition;
  revisions: readonly ApprovedOutlineRevision[];
  progress: OutlineProgress;
}>;
```

使用具名 brand 转换 `asArcId/asMilestoneId/asStoryThreadId/asOutlineSlotId`；ID 只由服务端铸造。规则节点 ID：`arc:campaign`、`arc:chapter:<stage>`、`arc:quest:<questId>`、`arc:sequence:<questId>:<from>:<to>`、`thread:main`、`milestone:<arcId>:<ordinal>`。AI 新节点通过当前 jobId + proposal 内唯一 localKey 铸造；不能以数组下标或显示名作为跨修订身份。

`initial` 与 `revisions` 是唯一计划源；effective definition 由 `applyOutlineOperations` 顺序重放。`progress` 是缓存，读取存档时重算比较；不另存一份可独立修改的 currentDefinition。

规则生成的 Quest/Sequence 绑定通过 `projectExecutionArcs` 基于当前 Entity Store 合入 effective view，不写入 AI 初始定义，也不把未创建任务编号当实体 ID。chapter 的抽象 stage 可预分配，允许范围只有 `1..contract.targetActs`。

### 2.2 提案、批准与修订

```ts
type OutlineSeedProposal = Readonly<{
  structure: ArcStructure;
  customPhases: readonly DramaticFunction[];
  nextDirection: string;
}>;
type OutlineRevisionReason = "player_choice" | "thread_evidence" | "chapter_boundary" | "world_materialized";
type ProposedOutlineOperation =
  | Readonly<{ kind: "revise_future_arc"; arcId: string; direction: string; structure: ArcStructure; customPhases: readonly DramaticFunction[] }>
  | Readonly<{ kind: "add_slot"; localKey: string; arcId: string; entityKind: OutlineSlot["entityKind"]; role: OutlineSlot["role"]; requirement: string }>
  | Readonly<{ kind: "bind_slot"; slotId: string; entityRef: string }>
  | Readonly<{ kind: "add_milestone"; localKey: string; arcId: string; function: DramaticFunction; prerequisiteIds: readonly string[]; condition: EvidencePredicate }>
  | Readonly<{ kind: "open_thread"; localKey: string; arcId: string; threadKind: Exclude<StoryThread["kind"], "main_conflict">; question: string; participantRefs: readonly OutlineRef[]; priority: 1 | 2 | 3; openedByEventIds: readonly string[]; resolution: EvidencePredicate; commitmentRef: StoryThread["commitmentRef"] }>
  | Readonly<{ kind: "retire_thread"; threadId: string; outcome: "abandoned" | "superseded"; replacementThreadId: string | null; reasonEventId: string }>;
type OutlineRevisionProposal = Readonly<{
  baseRevision: number;
  reason: OutlineRevisionReason;
  sourceEventIds: readonly string[];
  operations: readonly ProposedOutlineOperation[];
}>;
type ApprovedOutlineOperation =
  | Readonly<{ kind: "revise_future_arc"; arcId: ArcId; direction: string; structure: ArcStructure; customPhases: readonly DramaticFunction[] }>
  | Readonly<{ kind: "add_slot"; slot: OutlineSlot }>
  | Readonly<{ kind: "bind_slot"; slotId: OutlineSlotId; entityId: EntityId; sourceEventId: EventId }>
  | Readonly<{ kind: "add_milestone"; milestone: OutlineMilestone }>
  | Readonly<{ kind: "open_thread"; thread: StoryThread }>
  | Readonly<{ kind: "retire_thread"; threadId: StoryThreadId; outcome: "abandoned" | "superseded"; replacementThreadId: StoryThreadId | null; reasonEventId: EventId }>;
type ApprovedOutlineRevision = Readonly<{
  revisionId: string; revision: number; jobId: NarrativeJobId;
  sourceEventIds: readonly EventId[]; basedOnSequence: number;
  reason: OutlineRevisionReason;
  operations: readonly ApprovedOutlineOperation[];
}>;
type OutlineErrorCode =
  | "invalid_outline_shape" | "outline_reference_invalid" | "outline_cycle"
  | "outline_budget_exceeded" | "outline_revision_stale" | "outline_history_frozen"
  | "outline_evidence_invalid" | "outline_scope_forbidden" | "outline_binding_conflict";
type OutlineResult<T> = Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: OutlineErrorCode; path: string }>;
```

上面 branded 类型出现在 proposal 子结构中只表达字段语义；parser 从 unknown 校验并转换品牌，不认为 provider 的 TS 类型可信。provider 的 localKey 使用 `[a-z][a-z0-9_]{0,31}`，同提案引用写成 `@local.<localKey>`，只允许引用前面已创建的节点。批准 operations 按独立类型重建，把 localKey/`@local.*`/`@new.*` 全部换成服务端 ID，绝不持久化符号或 provider 对象引用。bind_slot 的 sourceEventId 取该实体创建的 initialization/blueprint_expanded Event；已存在实体也必须能在已提交 ledger 中定位来源。

`baseRevision` 等于 `outline.revisions.length`，与 GameRecord.revision 不同。`revisionId = outline:<jobId>`：同 job 同内容重试零追加，不同内容返回 `outline_revision_stale`；CAS 冲突仍由 repository 拒绝，不自动重演玩家行动。

### 2.3 预算与错误策略

| 项目 | 上限/规则 |
|---|---|
| outline Arc 深度 | 4；父 scope 必须恰好是相邻上层，唯一 campaign root |
| 自定义结构 | 2–7 个 DramaticFunction；以 setup 开始、resolution 结束；允许 development/reversal 重复 |
| 单提案 operations | 1–8；`null` 才表示没有更新，空 operations 拒绝 |
| 单修订 sourceEventIds | 1–8；去重且全部来自当前合法 evidence window |
| 初始计划＋修订后总量 | arcs 48、milestones 128、threads 32、slots 32 |
| 近未来 | 最多一个下一 chapter；未绑定 slots 最多 4；可激活 milestone 最多 4 |
| 文本长度 | question/direction/requirement 各 1–240 字；不保存场景原文或玩家原文 |
| 修订条数 | short 64 / medium 128；达到上限停止提议新修订，但规则进度和游戏继续 |
| Context | 当前 Arc 链最多 4、相关 Thread 6、下一 chapter 1、历史里程碑 4；8k 总预算不变 |

预算耗尽时上下文声明 `outlineUpdate=null`，不是拒绝后续玩家回合。到达结局不依赖可选线程数量；任何无法解析的非 null 提案仍严格拒绝，不能在预算耗尽时偷偷接受它。

### 2.4 证据政策（不是通用 DSL）

- 所有 predicate 都匹配 Event **payload 的实际目标**，不能只匹配 envelope 的宽泛参与者或 event kind。`fact_discovered` 对应相同 FactId；`quest_completed` 对应相同 QuestId；`enemy_defeated` 必须来自胜利链。
- Thread 的解决证据必须晚于其 opening 证据；同一个事件不能同时作为“新提出问题”和“后来已解决”的依据。规则预先满足的 Quest objective 可以引用更早的真实事件，但明确标为既有证据，不重新发 Event。
- `promise` 必须有 commitmentRef，匹配 NPC 组件中该 commitment 的 `fulfilled` 与 `kept_promise` 证据；其他 commitment 状态只能 open/abandoned，不得按一次 support 判履约。
- `threat` 仅接受目标敌人击败或关联 Quest 完成；`clue` 仅接受明确 Fact 发现/关联 Quest 完成；`relationship_conflict` 只引用已有关系事件及目标边，不产生关系变化；`question` 仅允许明确 NPC dialogue completion / Fact / Quest 证据。
- `mainline_ready`、`ending_reached` predicate 只能由规则 scaffold 创建。AI open_thread/add_milestone 提交它们返回 `outline_scope_forbidden`。
- scene presented、blueprint expanded、candidate approved 本身不证明“敌人已击败/承诺已兑现”；`world_materialized` 可以解释新槽位绑定，但不是剧情完成证据。
- `retire_thread` 不允许 main_conflict；abandoned 要求相关 NPC 的真实 refuse 交互、相关 Quest failed，或规则结局关闭；superseded 要求同范围真实 replacementThreadId 和事件原因，不能自替代/循环。
- sourceEventIds 来自本 job.domainEventIds、其直接原因、当前相关线程既有证据和本次批准的 world materialization Event。不能任意抓一条古老 Event 为玩家当前偏航背书。
- 查询玩家行为只读规则 dialogueAct。当前自由输入没有结构化拒绝证据时，不能通过匹配输入文字强行放弃线程。

## 3. 文件与职责

```text
src/game/domain/
  livingOutline.ts                  类型、ID、预算常量
  livingOutlineValidation.ts        严格 schema、图/层级/范围 invariant
  outlineProposal.ts                opening seed 与 revision 子协议 parser
  storyState.ts                     v9 + outline；legacy 字段仍有明确投影归属
src/game/gameplay/rpg/storyOutline/
  index.ts                          唯一玩法 facade
  structureTemplates.ts             模板功能序列，不生成文字剧情
  outlineEvidence.ts                封闭 predicate 与真实 Event/组件证据匹配
  executionArcs.ts                  Quest/stage/reveal → 规则绑定 Arc
  outlineProgress.ts                纯 progress 重建、当前 Arc 链
  outlineOperations.ts              顺序应用批准操作；不做 provider 审批
  outlineBootstrap.ts               Contract → 初始结构 scaffold
  outlineWindow.ts                  当前/下一/远期与相关 Thread 窗口
src/game/application/
  approveOutlineRevision.ts          不可信规划提案 → 受控批准修订
  reconcileStoryOutline.ts           state/scene CAS 前的协调入口
  prepareNarrativeBundleCommit.ts    已审批包 + outline 审批 → 完整待提交状态
  outlineContextProjection.ts        最小权限的 plan cards 与引用
  testing/livingOutlineJourney.test.ts
  testing/livingOutlineJourney.testutil.ts
src/game/application/server/ai/narrativeContext/
  outlineNarrativeContext.ts         cards → 现有 ContextBlock，无新编译器
src/game/application/server/persistence/
  storyStatePersistenceValidation.ts v9 内容/引用/progress 校验
```

每个新模块有同目录 `.test.ts`；不把内部实现塞入 `domain/index.ts`。新 gameplay facade 登记进 `src/dependencyBoundaries.test.ts` 的 FACADES，跨系统只经 facade 导入。

## 4. 实施启动

- [ ] 在 main 检查 `git status --short --branch`、`npm run phase:status`、`git worktree list`。本轮 Plan4 修复必须先落在可复现 main 基线上；工作区有未提交用户修改时不能自动 stash/覆盖。
- [ ] 确认机器阶段是 `hierarchical-living-outline-story-threads / planned / not_started`，唯一 Plan 指向本文，`sharedInfrastructureChangeAllowed=false`。
- [ ] 提交已确认的计划/阶段指针后执行 `npm run phase:start`，在目标 worktree 运行 `npm run handoff:check`。不把“文档已写”标为 implemented，不在本次撰写 Plan 的任务里自动启动实施。

---

### Task 1: 建立封闭领域协议与图校验

**Files:** Create `src/game/domain/livingOutline.ts`、`livingOutlineValidation.ts` 及各自同目录测试；Create `src/game/domain/testing/outlineFixture.testutil.ts`。

**Interfaces:** Consumes 现有 `EntityId / EventId / QuestId / StoryContract`。Produces：

```ts
parseLivingOutlineState(raw: unknown): OutlineResult<LivingOutlineState>;
validateOutlineDefinition(definition: OutlineDefinition): OutlineResult<OutlineDefinition>;
asArcId(raw: string): ArcId;
asMilestoneId(raw: string): MilestoneId;
asStoryThreadId(raw: string): StoryThreadId;
asOutlineSlotId(raw: string): OutlineSlotId;
```

- [ ] **Step 1 — 先写失败测试与最小 fixture。** `outlineFixture.testutil.ts` 导出 `minimalOutlineDefinition()`：单个 campaign root，`dramaticQuestion/direction="查清商队失踪"`，three_act/customPhases=[]，其他数组为空。构造 root 时只能使用 §2 的真实字段。

```ts
it("rejects a self-parent instead of accepting a cyclic arc", () => {
  const definition = minimalOutlineDefinition();
  const root = definition.arcs[0]!;
  expect(validateOutlineDefinition({ ...definition, arcs: [{ ...root, parentArcId: root.arcId }] }))
    .toMatchObject({ ok: false, code: "outline_cycle" });
});
it("rejects arbitrary state patches", () => {
  expect(parseLivingOutlineState({ version: 1, patch: { endingAllowed: true } }).ok).toBe(false);
});
```

- [ ] **Step 2 — Run** `npm test -- src/game/domain/livingOutline.test.ts src/game/domain/livingOutlineValidation.test.ts`；Expected FAIL：新导出/验证不存在。
- [ ] **Step 3 — 实现 §2 的全部类型、品牌与 exact-key validators。** 对每层逐字段重建，先 shape 后 graph，不在错误 shape 上递归；使用 visiting/visited 两集合检查 parent 和 prerequisite 图：

```ts
const visit = (id: string): boolean => {
  if (visiting.has(id)) return false;
  if (visited.has(id)) return true;
  visiting.add(id);
  for (const next of adjacency.get(id) ?? []) if (!visit(next)) return false;
  visiting.delete(id);
  visited.add(id);
  return true;
};
```

对所有 Arc/Milestone/Thread/Slot 做 ID 唯一、parent/ref 存在、邻接 scope、最大深度、predicate 引用 kind、非法 integer/NaN、customPhases、上限和重复数组校验。`__proto__` 等键不得通过原型链识别为合法 discriminant。`revisions` revision 从 1 连续递增，progress cursor 最低 -1；此 Task 不接 StoryState，因此不影响游戏。

- [ ] **Step 4 — Run** 同一 targeted 命令＋`npm run typecheck`，Expected PASS。增补 duplicate root、未知 parent、跨 scope、milestone 循环、空 ID、未知字段/状态、超上限和合法嵌套四层表驱动用例。
- [ ] **Step 5 — Commit** `git add src/game/domain/livingOutline* src/game/domain/testing/outlineFixture.testutil.ts && git commit -m "feat(outline): define bounded hierarchical planning contracts"`。

### Task 2: 模板、证据与进度纯函数

**Files:** Create `src/game/gameplay/rpg/storyOutline/{index,structureTemplates,outlineEvidence,outlineProgress}.ts` 及同目录测试；Modify `src/dependencyBoundaries.test.ts`。

**Interfaces:** Consumes §2 定义、Event ledger、Entity Store。Produces：

```ts
type OutlineExecution = Readonly<{ currentAct: number; targetActs: number; endingAllowed: boolean }>;
type OutlineEvidenceContext = Readonly<{
  worldState: WorldState; execution: OutlineExecution;
  bindings: OutlineProgress["bindings"];
}>;
structurePhases(structure: ArcStructure, customPhases: readonly DramaticFunction[]): readonly DramaticFunction[];
matchOutlineEvidence(condition: EvidencePredicate, context: OutlineEvidenceContext): readonly EventId[];
rebuildOutlineProgress(input: Readonly<{
  definition: OutlineDefinition; revisions: readonly ApprovedOutlineRevision[];
  worldState: WorldState; execution: OutlineExecution;
}>): OutlineResult<OutlineProgress>;
```

- [ ] **Step 1 — 写失败测试。** 使用 `makeCommittedEvent` 与 `createWorldStateFixture` 构造真实目标及 Event，不能只填假的 supportingEventIds。

```ts
it("does not complete a battle milestone from scene presentation", () => {
  const context = evidenceFixture("narrative_scene_presented");
  expect(matchOutlineEvidence({ kind: "enemy_defeated", enemy: context.enemyRef }, context)).toEqual([]);
});
it("allows different templates at adjacent depths", () => {
  expect(structurePhases("three_act", [])).toEqual(["setup", "development", "resolution"]);
  expect(structurePhases("mystery", [])).toEqual(["setup", "development", "reversal", "climax", "resolution"]);
});
```

`evidenceFixture(kind)` 在本 Task 的 `outlineEvidence.test.ts` 定义，返回 `{worldState,execution,bindings,enemyRef}`；先创建地点/敌人，再用该 kind 的完整合法 payload。不得在测试里修改敌人击败数组而不同步 Entity Store。

- [ ] **Step 2 — Run** `npm test -- src/game/gameplay/rpg/storyOutline`；Expected FAIL。
- [ ] **Step 3 — 实现固定模板与 §2.4 证据策略。** five_act=`setup/development/reversal/climax/resolution`，quest=`setup/development/climax/resolution`，three_act=`setup/development/resolution`；三幕内部高潮由嵌套 milestone 表达，不硬把 development 改成高潮。custom 使用已验证数组。

```ts
case "enemy_defeated": {
  const enemyId = resolveOutlineRef(condition.enemy, context.bindings);
  if (enemyId === null) return [];
  return context.worldState.eventLedger.filter((event) =>
    event.payload.type === "enemy_defeated" && event.payload.enemyId === enemyId,
  ).map((event) => event.eventId);
}
```

本模块私有 `resolveOutlineRef(ref,bindings): EntityId|null`：entity 直接返回；slot 只查已批准 binding，未绑定返回 null。其余 predicate 逐个显式 switch，不以 `JSON.stringify(payload).includes(id)` 匹配。

按 prerequisite 拓扑顺序归约 milestone；不满足前置或所属 chapter 尚未释放保持 planned，已激活且无结果 active，匹配真实结果 resolved。AI 新 milestone 只允许匹配创建修订边界之后的 Event；规则 objective milestone 可以引用既有证据。Milestone.function 是戏剧用途标签，不要求每个标签都出现在父模板里，因此三幕中的 climax milestone 合法。

`phaseIndex` 使 custom 的重复 development/reversal 可区分，`phase=structurePhases(...)[phaseIndex]`。Sequence/Quest 用已完成规则 objectives 比例、chapter 用真实主 Quest 的 objective 比例、campaign 用已完成 chapter 比例，把进度映射到模板前 N−1 个 phase：`min(N-2, floor(completed/total*(N-1)))`；未激活节点 index=0，只有真实执行完成才进入最后的 resolution。零 objective 不自动完成，依赖明确 Quest completed Event；campaign 只在 ending Event 后 resolved。纯 AI milestone 不是第二套游戏通关门槛；任务完成时无证据的可选 milestone 标 abandoned 而非假称 resolved。此结构 phase 不证明文学高潮已出现，真正节奏选择属于 Plan6。

Quest failed 标 abandoned。Thread 无结果 active、有符合类型且晚于 opening 的结果 resolved；retire 只来自已批准 revision，规则结局清理标 abandoned。修订重放不能让已经 resolved 的历史节点退回 active。

- [ ] **Step 4 — Run** targeted＋`npm run test:boundaries`＋`npm run typecheck`，Expected PASS。测试覆盖错目标、错误事件 kind、future cause、未绑定槽位、乱序前置、重复归约、已达到节点不退回、对方关系边不能履行本边承诺。
- [ ] **Step 5 — Commit** `git add src/game/gameplay/rpg/storyOutline src/dependencyBoundaries.test.ts && git commit -m "feat(outline): derive arc and thread progress from rule evidence"`。

### Task 3: 开局 scaffold、实际任务绑定与滚动窗口

**Files:** Create `src/game/gameplay/rpg/storyOutline/{outlineBootstrap,executionArcs,outlineWindow}.ts` 及测试；Modify facade `index.ts`。

**Interfaces:**

```ts
createInitialOutline(input: Readonly<{ contract: StoryContract; seed: OutlineSeedProposal }>): LivingOutlineState;
projectExecutionArcs(input: Readonly<{ definition: OutlineDefinition; worldState: WorldState; execution: OutlineExecution }>): OutlineDefinition;
type OutlineWindow = Readonly<{
  activeArcIds: readonly ArcId[]; nextArcId: ArcId | null;
  threadIds: readonly StoryThreadId[]; historicalMilestoneIds: readonly MilestoneId[];
  unboundSlotIds: readonly OutlineSlotId[];
}>;
selectOutlineWindow(input: Readonly<{
  definition: OutlineDefinition; progress: OutlineProgress; execution: OutlineExecution;
  focusEntityIds: readonly EntityId[];
}>): OutlineWindow;
```

- [ ] **Step 1 — 写失败测试。**

```ts
it("does not activate an already materialized next-stage quest", () => {
  const fixture = stagedQuestOutlineFixture();
  const definition = projectExecutionArcs(fixture);
  const result = rebuildOutlineProgress({ ...fixture, definition, revisions: [] });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  expect(result.value.arcs.find((arc) => arc.arcId === "arc:quest:quest_next")?.state.status).toBe("planned");
});
```

`stagedQuestOutlineFixture()` 在 executionArcs 同目录测试定义：用最小 world fixture 创建 stage=1 active Quest 与 stage=2 已创建 Quest，execution.currentAct=1；不伪造 quest_next 已完成事件。

- [ ] **Step 2 — Run** `npm test -- src/game/gameplay/rpg/storyOutline`；Expected FAIL。
- [ ] **Step 3 — 实现规则 ID 与绑定。** 初始根 question 取 Contract.centralConflict；chapter 只保存 stage 与中心问题，下一 chapter direction 取批准 seed.nextDirection，其余 direction 只指向 Contract 抽象方向。`thread:main` 的 resolution=`mainline_ready`，由规则拥有。生成 Quest Arc 时按 `quest.stage` 找 chapter，sequence 范围来自真实 objectives；当前 stage 的 active Quest 才能激活。

```ts
const questArcId = asArcId(`arc:quest:${quest.id}`);
const sequenceArcId = asArcId(`arc:sequence:${quest.id}:0:${quest.objectives.length - 1}`);
```

零目标 Quest 不生成 sequence。模板继承只做默认值，已经批准给下一 chapter 的独立模板不被父模板覆盖。每个实际 objective 使用对应 predicate 生成稳定 milestone，prerequisites 链按已批准目标顺序；不重排 objectives。窗口按显式相关参与者、priority、opening 事件年龄、ID 稳定排序，排除已 resolved/abandoned 的 Thread，仅另取 4 个历史 milestone。

- [ ] **Step 4 — Run** targeted＋typecheck，Expected PASS。用 campaign 三幕/五 chapter/子 chapter mystery fixture 证明层级与游戏幕数解耦；未创建实体只出现 slot，不出现在世界索引或地图。
- [ ] **Step 5 — Commit** `git add src/game/gameplay/rpg/storyOutline && git commit -m "feat(outline): bind real quests and select rolling planning windows"`。

### Task 4: 受控修订 parser、审批和不可变历史

**Files:** Create `src/game/domain/outlineProposal.ts`、`src/game/application/approveOutlineRevision.ts`、`src/game/gameplay/rpg/storyOutline/outlineOperations.ts` 及各自测试；Modify storyOutline facade。

**Interfaces:**

```ts
parseOutlineSeedProposal(raw: unknown): OutlineResult<OutlineSeedProposal>;
parseOutlineRevisionProposal(raw: unknown): OutlineResult<OutlineRevisionProposal>;
applyOutlineOperations(definition: OutlineDefinition, revision: ApprovedOutlineRevision): OutlineResult<OutlineDefinition>;
effectiveOutlineDefinition(state: LivingOutlineState): OutlineResult<OutlineDefinition>;
approveOutlineRevision(input: Readonly<{
  proposal: OutlineRevisionProposal; outline: LivingOutlineState;
  worldState: WorldState; execution: OutlineExecution; job: PendingNarrativeJob;
  allowedEventIds: readonly EventId[];
  symbolBindings: ReadonlyMap<string, EntityId>;
}>): OutlineResult<ApprovedOutlineRevision>;
```

- [ ] **Step 1 — 写失败测试。**

```ts
it("does not revise an active or completed arc", () => {
  const fixture = revisionFixture();
  const result = approveOutlineRevision({
    ...fixture,
    proposal: { ...fixture.proposal, operations: [{
      kind: "revise_future_arc", arcId: "arc:chapter:1", direction: "抹去刚才的选择",
      structure: "three_act", customPhases: [],
    }] },
  });
  expect(result).toMatchObject({ ok: false, code: "outline_history_frozen" });
});
```

`revisionFixture()` 在 application 同目录测试创建：一条已提交且参与者明确的 NPC interaction、currentAct=1、初始 two-layer outline、真实 PendingNarrativeJob.domainEventIds；proposal 指向 planned chapter:2。使用现有 `createPendingNarrativeJob` 合同，不手工省略 mandatoryBeats/objectiveTransition。

- [ ] **Step 2 — Run** `npm test -- src/game/domain/outlineProposal.test.ts src/game/application/approveOutlineRevision.test.ts src/game/gameplay/rpg/storyOutline/outlineOperations.test.ts`；Expected FAIL。
- [ ] **Step 3 — 实现 exact parser 和整批审批。**

```ts
// 同 job 的规范内容幂等检查必须在 baseRevision 检查之前完成。
if (input.proposal.baseRevision !== input.outline.revisions.length) {
  return { ok: false, code: "outline_revision_stale", path: "baseRevision" };
}
const permitted = new Set(input.allowedEventIds);
if (input.proposal.sourceEventIds.some((id) => !permitted.has(id as EventId))) {
  return { ok: false, code: "outline_evidence_invalid", path: "sourceEventIds" };
}
```

每个操作逐个检查 §2.4：未来修订仅 next chapter；slot kind 与实际 entity kind 一致，`@new.*` 只能经 symbolBindings 解析到已审批 preview 实体；绑定一经批准永不换绑。新增 slot/milestone/thread 的 arcId 仅允许 current/next **chapter**，Quest/Sequence 是规则投影节点，AI 不编辑它们；不创建历史 Arc，不修改 Contract，不改变已批准 descriptor/Quest。操作先作用于本地拷贝，整批 graph/ref/预算验证通过才返回 revision；失败不泄漏前面几个操作的部分效果。

`applyOutlineOperations` 按封闭 switch 重建数组：revise 替换指定未来 Arc 的 direction/structure；add_* 追加服务端 ID 节点；bind/retire 保留在 revision 操作中供 progress 归约。effectiveDefinition 从 initial 起按 revision 顺序 fold；不改 initial 对象。同 job 同操作内容返回既有 revision；字面对象键序不应影响等价性，比较重建后的规范字段。

- [ ] **Step 4 — Run** targeted＋boundaries＋typecheck，Expected PASS。硬断言修改历史、错误 NPC 证据、任意旧 Event 冒充当前选择、假 slot、新 ID、主线关闭、未来 cause、超预算、同 job 冲突、原输入深冻结、两操作中第二个失败零修改。
- [ ] **Step 5 — Commit** `git add src/game/domain/outlineProposal* src/game/application/approveOutlineRevision* src/game/gameplay/rpg/storyOutline && git commit -m "feat(outline): approve causal future-only plan revisions"`。

### Task 5: StoryState v9 原子切换与持久化完整性

**Files:** Modify `src/game/domain/storyState.ts`、`storyState.test.ts`；Create `src/game/application/reconcileStoryOutline.ts` 与测试；Modify `stateCommit.ts`、`generatePendingNarrativeBundle.ts`、`generatePendingScene.ts`、`createGame.ts`；Modify `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`；Modify `src/game/application/server/persistence/{storyStatePersistenceValidation,sqliteGameRepository}.ts` 与对应测试；同步该变更涉及的 fixture。

同时 Modify `src/game/gameplay/rpg/storyOutline/{outlineProgress,index}.ts` 及测试，提前提供主线兼容投影，避免直到 Task8 才改变 v9 存档字段含义。

**Interfaces:**

```ts
reconcileStoryOutline(input: Readonly<{ worldState: WorldState; storyState: StoryState }>): OutlineResult<LivingOutlineState>;
projectUnresolvedMainThreadIds(outline: LivingOutlineState): readonly string[];
```

Consumes `effectiveOutlineDefinition → projectExecutionArcs → rebuildOutlineProgress`；Produces 可校验的 `StoryState.outline`。不修改 World Event union，不给计划修订编造世界 Event。

- [ ] **Step 1 — 写失败测试。**

```ts
it("rejects a forged milestone cache rather than silently repairing a save", () => {
  const fixture = persistableOutlineFixture();
  const forged = {
    ...fixture.storyState,
    outline: { ...fixture.storyState.outline, progress: {
      ...fixture.storyState.outline.progress,
      milestones: fixture.storyState.outline.progress.milestones.map((entry, index) =>
        index === 0 ? { ...entry, state: { status: "resolved" as const, supportingEventIds: [] } } : entry),
    } },
  };
  expect(parsePersistableStoryState(forged, fixture.worldState).ok).toBe(false);
});
```

`persistableOutlineFixture()` 在 persistence 测试用现有 `buildTestState` 创建 store/ledger，再用本 Task reconcile 生成合法 outline；若使用 readonly 类型，构造新的嵌套对象替换而不是通过强制断言绕过编译。

- [ ] **Step 2 — Run** `npm test -- src/game/application/server/persistence/storyStatePersistenceValidation.test.ts src/game/application/reconcileStoryOutline.test.ts`；Expected FAIL。
- [ ] **Step 3 — 整批 schema cutover，不能提交半切换。** `STORY_STATE_SCHEMA_VERSION=9`，classifier 旧版本加 8，REQUIRED_STORY_KEYS 加 outline。`CreateInitialStoryStateInput` 新增必填 `contract: StoryContract` 和 `outline: LivingOutlineState`，删除当前空 centralConflict 默认契约；domain 只接收值，禁止反向 import gameplay。opening compiler 用实际 candidate.storyContract 和规则 seed 调用 storyOutline facade 的 createInitialOutline，再传入 domain factory；规则 seed 的 nextDirection 取契约 centralConflict，不另编剧情。全部测试调用点提供合法最小 contract/outline（domain 测试使用纯 domain fixture），不能把空契约藏在默认参数中。Task6 才将规则 seed 换为批准的 opening seed。

```ts
const definition = effectiveOutlineDefinition(input.storyState.outline);
if (!definition.ok) return definition;
const execution = {
  currentAct: input.storyState.currentAct,
  targetActs: input.storyState.targetActs,
  endingAllowed: input.storyState.endingAllowed,
};
const expanded = projectExecutionArcs({ definition: definition.value, worldState: input.worldState, execution });
const progress = rebuildOutlineProgress({ definition: expanded, revisions: input.storyState.outline.revisions, worldState: input.worldState, execution });
if (!progress.ok) return progress;
return { ok: true, value: { ...input.storyState.outline, progress: progress.value } };
```

stateCommit 与 provider 成功 CAS 必须在 **最终 ledger** 上 reconcile memory 和 outline。reconcile 失败返回稳定基础设施/状态不合法结果，不能带半份状态调用 repo。SQLite parser 签名从 `(unknown, ledger)` 改为 `(unknown, worldState)`，内部仍用 worldState.eventLedger 重建 memory，并用实际 store 检查 outline 绑定/谓词引用/progress；全部 create/replace/read/write 调用同步。

同一 cutover 将初始主线 ID 固定为 `thread:main`，移除 `mainThreadId` 可选输入，更新全部调用点。最终保存时 `unresolvedThreads=projectUnresolvedMainThreadIds(outline)`，parser 校验该数组等于派生值；旧推进器暂时只在局部计算中操作该单一主线 ID，不写入第二套持久化线程。Task8 再去掉这一中间步骤，不改变 v9 字段意义。

`parsePersistableStoryState` 不能只验证 `outline` 外层 object：严格解析 initial/revisions，顺序重放并检查历史操作结构、ID、来源及冻结节点约束，所有修订证据 sequence 不晚于 basedOnSequence，修订边界单调且不超过 ledger 尾部。历史修订做结构/provenance 审计，不用当前 NPC 位置/Quest stage 再执行一次当年的运行期审批（本 Plan 没有历史 world snapshot）；当前 world 用于最终实体引用校验与 progress 重算比较。World/Story/Entity/record 版本分类分别保留，不能都压成 corrupt。

扫描并迁移所有 `StoryState` literal 与 parser 调用：`rg -n 'StoryState|parsePersistableStoryState|version: 8' src/game`；不是把所有数字 8 机械替换为 9。checkpoint.storySnapshot 自然包含 outline，runtime parser 要检查嵌套快照的 outline shape；SQLite 再与 preBattleSnapshot ledger 交叉验证。

- [ ] **Step 4 — Run** domain/gameplay/application 子集、typecheck、boundaries 与现有全部 journey，Expected PASS；证明 schema 切换后的新短/中篇仍能结束。旧 v8 返回 UNSUPPORTED_RECORD，坏缓存/未来引用/错 kind 绑定稳定拒绝；CAS stale 零写入。
- [ ] **Step 5 — Commit** `git add src/game/domain src/game/gameplay/rpg/openingGeneration src/game/application && git commit -m "feat(outline): persist v9 causal outline state atomically"`。

### Task 6: 在同一个生成包内接入 opening seed 与 decision 修订

**Files:** Modify `src/game/domain/narrativeBundle.ts` 与测试；Modify `src/game/application/{narrativeBundleSource,createGame,generatePendingNarrativeBundle,approveNarrativeBundle}.ts` 与测试；Create `prepareNarrativeBundleCommit.ts` 与测试；Modify `src/game/application/server/ai/liveNarrativeBundleSource.ts` 与测试；Modify `src/game/application/testing/foundationJourney.testutil.ts` 和当前 opening/decision response fixture。

同时 Modify `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts` 及测试：新的必填字段、符号/证据白名单和基本输出合同必须与 parser 在本 Task 同时接入，不能等 Task7 才告诉 live provider 应返回什么。

**Interfaces:** `OpeningNarrativeBundleProposal.outlineSeed: OutlineSeedProposal`；`NarrativeBundleProposal.outlineUpdate: OutlineRevisionProposal|null`。Produces：

```ts
type PreparedNarrativeBundleCommit = Readonly<{ nextWorldState: WorldState; nextStoryState: StoryState }>;
prepareNarrativeBundleCommit(input: Readonly<{
  approved: ApprovedNarrativeBundle; outlineUpdate: OutlineRevisionProposal | null;
  worldState: WorldState; storyState: StoryState; job: PendingNarrativeJob; committedAt: string;
}>): OutlineResult<PreparedNarrativeBundleCommit>;
```

`ApprovedNarrativeBundle` 同时新增只读 `symbolBindings: ReadonlyMap<string, EntityId>`。当前审批并未返回符号表；在其内部已有的 approvedDelta 上，按 `@new.location/npc/item/enemy/fact/quest` 与对应 `minted*Ids[0]` 建立封闭映射，缺失的种类不入表，再返回副本。不得靠注释里“resolve symbols”假定已存在可复用 helper，不在下一层凭实体名称推导，不把 Map 写进存档。没有世界增量时返回空 Map。

- [ ] **Step 1 — 写失败测试。**

```ts
it("rejects the entire bundle when an outline update rewrites history", async () => {
  const fixture = pendingBundleOutlineFixture();
  const result = await generatePendingNarrativeBundle({ ...fixture.deps, source: fixture.invalidOutlineSource });
  expect(result).toMatchObject({ ok: false, code: "AI_RESPONSE_INVALID" });
  const after = await fixture.readRecord();
  expect(after.worldState.eventLedger).toEqual(fixture.before.worldState.eventLedger);
  expect(after.storyState.outline).toEqual(fixture.before.storyState.outline);
  expect(after.storyState.narrative.status).toBe("provider_failed");
});
```

`pendingBundleOutlineFixture()` 在现有 generatePendingNarrativeBundle 同目录测试从已存在的 pending fixture 扩展；`invalidOutlineSource` 每次返回同一合法 world/scene＋非法 current-arc revision，确保测试走满现有四次而不是第一次失败后换另一份 fixture。

- [ ] **Step 2 — Run** parser/source/createGame/generatePendingNarrativeBundle targeted，Expected FAIL。
- [ ] **Step 3 — 接入独立子协议，保留原生成/重试矩阵。** opening normalizer 和 top-level keys 加 outlineSeed，decision exact keys 加 outlineUpdate；normalizer 不丢字段、不合成缺失字段，显式 offline fixture 添加规则 scaffold seed 或 null。同步更新 live opening 与 decision 输出合同，包含 §2 完整提案结构、baseRevision、允许 chapter/Event ID、null 语义；Task7 只优化相关卡片组织，不补救本 Task 的协议缺项。opening 使用 seed 初始化已批准 Contract 的 outline，再一次保存 ready world/scene。

```ts
const committed = commitEventDrafts({
  ledger: input.worldState.eventLedger,
  drafts: input.approved.eventDrafts,
  source: { turnId: input.job.turnId, actionId: input.job.actionId, turnNumber: input.job.turnNumber, committedAt: input.committedAt },
  entityStore: input.approved.nextWorldState.entityStore,
});
if (!committed.ok) return { ok: false, code: "outline_evidence_invalid", path: "eventDrafts" };
const nextWorldState = { ...input.approved.nextWorldState, eventLedger: committed.ledger };
```

随后在 preview 上构建 current/next window、从本 job 与已批准 expanded Event 建 allowedEventIds、从 `ApprovedWorldDelta` 的 minted IDs 建 `symbolBindings`（不按名字猜）；approval 非 null revision 成功才追加。`prepareNarrativeBundleCommit` 返回 ready narrative + final memory + final outline，不调用 repository。

将此准备步骤放进 `runBoundedAttempts` 的 runAttempt：world/scene 或 outline 任一个失败都进入现有 repair。bounded 成功值改为 PreparedNarrativeBundleCommit；循环之后不再重复 commitEventDrafts/reconcile，直接一次 `repository.applyState`。`NarrativeBundleRejection` 增加 `outline_revision_rejected`，detail 只传 `OutlineErrorCode:path`，不回传私密正文。

- [ ] **Step 4 — Run** source/parser/approval/retry/createGame tests＋typecheck。锁定 initialization=1 logical generation，decision=1 logical generation；outline 失败无部分 world/scene 写入；同 job 重试无重复 revision；stale CAS 不写任何 revision。failed persist 本身按已有规则允许一次状态提交，不把它误算为剧情成功。
- [ ] **Step 5 — Commit** `git add src/game/domain/narrativeBundle* src/game/application && git commit -m "feat(outline): carry atomic planning revisions in narrative bundles"`。

### Task 7: 安全上下文投影与酒馆式定向注入

**Files:** Create `src/game/application/outlineContextProjection.ts` 与测试；Create `src/game/application/server/ai/narrativeContext/outlineNarrativeContext.ts` 与测试；Modify `narrativeBundleContext.ts`、`sceneNarrativeContext.ts`、`worldNarrativeContext.ts`、`sceneGenerationContext.ts` 及对应测试。

**Interfaces:**

```ts
type OutlineContextCard = Readonly<{
  id: string; title: string; content: string; refs: readonly string[];
  retention: "mandatory" | "optional"; priority: number;
}>;
type OutlineContextProjection = Readonly<{
  revision: number; cards: readonly OutlineContextCard[];
  allowedArcIds: readonly ArcId[]; allowedEventIds: readonly EventId[];
  availableOperationKinds: readonly ProposedOutlineOperation["kind"][];
}>;
buildOutlineContextProjection(input: Readonly<{ worldState: WorldState; storyState: StoryState; job?: PendingNarrativeJob }>): OutlineResult<OutlineContextProjection>;
buildOutlineNarrativeContextBlocks(projection: OutlineContextProjection): readonly NarrativeContextBlock[];
```

- [ ] **Step 1 — 写失败测试。**

```ts
it("does not turn a future slot into a known NPC fact", () => {
  const fixture = outlinePrivacyFixture();
  const projected = buildOutlineContextProjection(fixture);
  expect(projected.ok).toBe(true);
  if (!projected.ok) throw new Error(projected.code);
  const text = projected.value.cards.map((card) => card.content).join("\n");
  expect(text).toContain("未来意图，不是已发生事实");
  expect(text).not.toContain("SECRET_FACT_BODY");
  expect(text).not.toContain("OTHER_NPC_PRIVATE_HISTORY");
});
```

`outlinePrivacyFixture()` 从实际 Entity Store + 未披露 Fact + 另一 NPC 私密 history 构造，放一个未绑定 slot；不得把占位 secret 只放在未传入 projector 的对象里。

- [ ] **Step 2 — Run** projection/context targeted，Expected FAIL。
- [ ] **Step 3 — 接入现有 slots/authority/预算，不另写 prompt 拼接器。**

```ts
return projection.cards.map((card) => ({
  id: card.id, title: card.title, content: card.content,
  slot: "director_guidance" as const, authority: "plan" as const,
  retention: card.retention, priority: card.priority,
  source: { kind: "living_outline", refs: card.refs },
}));
```

当前根/当前 Arc 链合并成一张 mandatory 小卡，最多 900 字；Thread 各一张 optional 卡，priority 760..755；next direction optional 730；历史 milestone optional 710。每张卡独立进入 compiler，使预算不足时可以逐条裁，不把六条 Thread 合并成一个“全选或全丢”大块。当前事实块仍比 plan 权威高，不使用与 state 相同的 conflictKey。

Thread 卡显示 question、状态、age、允许公开的实体/Fact ID、最多 3 个证据 ID；Fact 正文仍由既有安全 fact cards 提供。slot 显示“需要某类角色/地点”，不变成 NPC 可知信息，不自动添加到正文允许引用集。非焦点 NPC 的历史不因关联同一 thread 就全部注入。

将全量 outline/revisions 留在 server；manifest 仅 ID/slot/预算/来源，UI 不收到远期方向和隐藏槽位。opening prompt 只增加小型 seed 输出合同；decision prompt 给本轮允许操作、baseRevision、sourceEventIds 白名单及 `null` 语义。legacy scene/world 投影读取 outline，但不获得修改权限。

- [ ] **Step 4 — Run** targeted＋liveNarrativeBundleSource＋boundaries＋typecheck。断言 8k 预算不变、mandatory overflow 可观察、低优先级 Thread 独立 dropped、当前地点覆盖旧 Arc 位置、未授权 Event 引用不变成 NPC usedEventIds 许可。
- [ ] **Step 5 — Commit** `git add src/game/application && git commit -m "feat(outline): compile bounded plan and thread context cards"`。

### Task 8: 主线线程、结局与战斗回滚接线收口

**Files:** Modify `src/game/gameplay/rpg/ruleEngine/{advanceStoryProgression,resolveEnding}.ts` 与测试；Modify `src/game/domain/storyState.ts` 与测试；Modify `src/game/application/{performTurn,performBattleRound,consumeNarrativeBundle,stateCommit}.ts` 与测试；Modify `src/game/gameplay/rpg/storyOutline/outlineProgress.ts` 与测试。

**Interfaces:** 复用 Task5 已增加的 facade，不新增同义投影：

```ts
projectUnresolvedMainThreadIds(outline: LivingOutlineState): readonly string[];
```

仅返回未解决的 rule-owned `thread:main`，不能把所有可选 Thread 当结局锁；所有相关完整 Thread 由 outline projector 读取。

- [ ] **Step 1 — 写失败测试。** 在已有真实 performTurn 开战→失败/撤退→恢复测试中保存 before.outline，断言恢复 deep-equal，started/round/presented 的 Event ID 不出现在任何 outline evidence/revision；在 ending 测试放一个 active 可选 question，仍可结局。

```ts
expect(afterFailure.storyState.outline).toEqual(beforeBattle.storyState.outline);
expect(afterFailure.worldState.eventLedger).toEqual(beforeBattle.worldState.eventLedger);
expect(afterVictory.storyState.outline.progress.milestones.some((entry) =>
  entry.state.status === "resolved" && entry.state.supportingEventIds.includes(victoryEventId),
)).toBe(true);
```

- [ ] **Step 2 — Run** `npm test -- src/game/application/performTurn.test.ts src/game/application/performBattleRound.test.ts src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts src/game/gameplay/rpg/ruleEngine/resolveEnding.test.ts`；Expected FAIL 对新增 outline 断言。
- [ ] **Step 3 — 去掉第二份线程生命周期写入，保持游戏完成条件。** `advanceStoryProgression` 保留主 Quest、stage、storyProgress 和 evolution 规则；endingAllowed 仍按“终幕存在主 Quest＋全部已解决＋progress≥80”计算，不再先随机取 unresolvedThreads[0] 再删除。`resolveEnding` 依赖规则 endingAllowed/requirements/立场，不扫描可选 Thread。

```ts
const endingAllowed = currentAct >= ss.targetActs
  && currentActMainQuestExists && mainQuestsResolved && storyProgress >= 80;
```

reconcile 后 `unresolvedThreads=projectUnresolvedMainThreadIds(outline)`，成为只读兼容投影；主线 Thread 使用规则 mainline_ready，最终 campaign 使用 ending_reached。`derivePacingNeed` 不能把可选 Thread 未完成当成永不收束的理由。

检查 active battle fast path：目前它保留 beforeStoryState 而提交新 battle ledger；stateCommit 在最终 ledger 重建 outline。胜利后照常消费批准 bundle，更新 evidence；失败先整体恢复 checkpoint.storySnapshot，再 reconcile 恢复后的 ledger，不能用战中 outline 作为初始定义/修订来源。修订只在白名单 decision 发生，战斗期间不新建 revision。

- [ ] **Step 4 — Run** targeted＋短/中篇完整现有 journey＋typecheck。验证任意可选 Thread 不阻塞通关，预创建下一幕不能跳过当前 battle objective，战败后再胜利只留下胜利证据。
- [ ] **Step 5 — Commit** `git add src/game/domain/storyState* src/game/gameplay/rpg/ruleEngine src/game/gameplay/rpg/storyOutline src/game/application && git commit -m "feat(outline): preserve game completion and battle rollback semantics"`。

### Task 9: 稳定失败、审计与质量断言

**Files:** Modify `src/game/application/{prepareNarrativeBundleCommit,generatePendingNarrativeBundle,retryNarrativeGeneration}.test.ts`；Modify `src/game/application/server/ai/narrativeContext/outlineNarrativeContext.test.ts`；Modify `src/game/application/server/persistence/sqliteGameRepository.test.ts`。

**Interfaces:** 不新增外部 API 或日志基础设施；沿用 `NarrativeBundleRepair`、Context manifest、revision/jobId 与稳定失败码。

- [ ] **Step 1 — 写失败矩阵测试。**

```ts
it.each(["outline_revision_stale", "outline_history_frozen", "outline_evidence_invalid"] as const)(
  "returns the precise repair reason and writes no partial plan: %s", async (code) => {
    const run = await runOutlineRejectedAttempt(code);
    expect(run.repair.detail).toContain(code);
    expect(run.savedOutline).toEqual(run.beforeOutline);
    expect(run.savedLedger).toEqual(run.beforeLedger);
    expect(JSON.stringify(run.manifest)).not.toContain("PRIVATE_PLAYER_INPUT");
  },
);
```

本 Task 在 generatePendingNarrativeBundle 测试定义 `runOutlineRejectedAttempt(code)`，使用 Task6 的 pending fixture，逐个真实触发对应拒因；不能 mock approveOutlineRevision 直接返回期望码来代替集成验证。

- [ ] **Step 2 — Run** 上述四类 targeted test；Expected FAIL 缺失的 stale/retry/序列化回归。
- [ ] **Step 3 — 补齐真实边界需要的分支。** ensure 普通观察不重跑 failed；retry 使用同 jobId；重复成功 revision 零追加；同时有更新/序幕确认时保留 prologueShown 单调性。序列化前、读回、checkpoint 三处均拒绝错误 Event ID 和错误 predicate kind；不能仅检查 supportingEventIds 非空。

```ts
expect(reloaded.storyState.outline).toEqual(committed.storyState.outline);
expect(reloaded.storyState.outline.revisions.map((entry) => entry.revision))
  .toEqual(Array.from({ length: reloaded.storyState.outline.revisions.length }, (_, index) => index + 1));
```

审计只新增现有 manifest sourceKind=`living_outline` 和稳定拒绝 detail；不增加完整大纲/玩家正文日志副本，不改共享 logging package。

- [ ] **Step 4 — Run** application 子集＋boundaries＋typecheck，Expected PASS。
- [ ] **Step 5 — Commit** `git add src/game/application && git commit -m "test(outline): enforce atomic retries provenance and safe diagnostics"`。

### Task 10: 生产 Bundle 路径的完整短/中篇与选择分叉旅程

**Files:** Create `src/game/application/testing/livingOutlineJourney.test.ts`、`livingOutlineJourney.testutil.ts`；Modify `mediumActJourney.test.ts` 与相关 fixture；保留 `episodicMemoryJourney.test.ts`、`npcContinuityJourney.test.ts` 的独立回归。

**Interfaces:** 新 testutil 导出：

```ts
type LivingOutlineJourneyReport = Readonly<{
  record: GameRecord; successfulTurns: number; reloads: number;
  providerDecisionCalls: number; linearProviderCalls: number;
  openingEventIds: readonly EventId[]; revisedDirections: readonly string[];
  rollbackProved: boolean; recallProved: boolean; nestedTemplatesProved: boolean;
}>;
runLivingOutlineJourney(input: Readonly<{ length: "short" | "medium"; stance: "support" | "challenge"; seed: string }>): Promise<LivingOutlineJourneyReport>;
```

- [ ] **Step 1 — 写失败测试。**

```ts
it.each(["short", "medium"] as const)("finishes %s through real bundle approvals and SQLite reload", async (length) => {
  const result = await runLivingOutlineJourney({ length, stance: "support", seed: "outline-stable" });
  expect(result.record.worldState.ending).not.toBeNull();
  expect(result.record.storyState.currentAct).toBe(length === "short" ? 3 : 5);
  expect(result.successfulTurns).toBeGreaterThanOrEqual(length === "short" ? 15 : 24);
  expect(result.reloads).toBeGreaterThanOrEqual(4);
  expect(result.linearProviderCalls).toBe(0);
  expect(result.rollbackProved && result.recallProved && result.nestedTemplatesProved).toBe(true);
});
```

- [ ] **Step 2 — Run** `npm test -- src/game/application/testing/livingOutlineJourney.test.ts`；Expected FAIL。
- [ ] **Step 3 — 实现 fixture 驱动器。** 创建独占临时 SQLite repo；通过 `createGame` 建局，注入显式 deterministic `NarrativeBundleSource`，所有响应仍经过正式 parser/approve/prepare/CAS；提交 `projectGameSessionView` 真正下发的 opaque choices/free text，不直接伪造 ending、修改 currentAct 或注入已完成 outline。

每个回合：读取 view → 选 issued action → performTurn → 仅 pending 时 generatePendingNarrativeBundle → 读取并验证结果。固定与自由输入都至少两次；包括真实移动、取物/赠物、调查揭示、战斗失败恢复和重赛胜利。人工配置 fixture 的敌人强度属于测试初始材料，不能在战斗进行到一半时改 HP 伪造失败。

第 2–4 回合开启一条可选线索 Thread；12+ 回合后回访相关 NPC/物品/地点时验证它进入 plan/memory cards；此时当前位置/关系仍由 store authority 提供。至少一次拒绝/支持导致下一 chapter direction 不同，并保持已完成 Arc/Milestone/ledger 前缀相同。不同路线最终仍由规则立场得到两个结局方向。

```ts
const support = await runLivingOutlineJourney({ length: "medium", stance: "support", seed: "outline-fork" });
const challenge = await runLivingOutlineJourney({ length: "medium", stance: "challenge", seed: "outline-fork" });
expect(support.revisedDirections).not.toEqual(challenge.revisedDirections);
expect(support.record.worldState.ending?.endingId).not.toBe(challenge.record.worldState.ending?.endingId);
const replay = await runLivingOutlineJourney({ length: "medium", stance: "support", seed: "outline-fork" });
expect(replay.record.worldState).toEqual(support.record.worldState);
expect(replay.record.storyState).toEqual(support.record.storyState);
```

固定注入时间/job/action IDs，避免将随机 UUID 差异当剧情分叉。report 的布尔值必须由真实硬断言设置；循环有明确 120 successful-actions/240 battle-commands 上限，超限抛错；不允许 `if (!result.ok) break` 后仍给出通过报告。

- [ ] **Step 4 — Run** 新 journey＋所有既有 memory/NPC/grounding/divergence/foundation journeys＋typecheck，Expected PASS。`mediumActJourney` 的描述与真正覆盖范围一致，完整五幕证明来自新 journey。
- [ ] **Step 5 — Commit** `git add src/game/application/testing && git commit -m "test(outline): prove complete playable branches and long-gap thread continuity"`。

### Task 11: 文档、完整门禁与人工叙事质量验收

**Files:** Create `docs/agent/层级大纲与剧情线程.md`；Modify `docs/agent/剧情连续性与结构化记忆.md`、`运行时AI导演与场景表演.md`、`世界动态具象化.md`、`战斗与结局.md`、`当前开发阶段.md`、`current-phase.json`；Modify `docs/Agent文档索引.md`、`docs/游戏开发规范.md`、`docs/策划文档/AI生成RPG_MVP.md`。

- [ ] **Step 1 — 更新已实现事实。** 写清 v9、规则执行游标与叙事 phase 区别、批准计划/事件/progress 三种来源、nullable revision 协议、单次 bundle CAS、slot visibility、可选线程不挡结局、战败完整恢复。不得把本 Plan 的结构功能标记描述为 Plan6 已实现的高潮/战斗导演算法。
- [ ] **Step 2 — 完整离线验收。**

```bash
npm run check:standards
npm run typecheck
npm run lint
npm run test:boundaries
npm run test:fast
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
npm test
npm run test:foundation-journey
npm run journey:foundation
npm test -- src/game/application/testing/livingOutlineJourney.test.ts src/game/application/testing/episodicMemoryJourney.test.ts src/game/application/testing/npcContinuityJourney.test.ts src/game/application/testing/narrativeGroundingJourney.test.ts src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
npm run build
git diff --check
npm run phase:status
```

Expected 全部 PASS；baseline 已有 lint warnings 要单独记录，不产生新错误，不把真实 AI smoke 混进离线门禁。

- [ ] **Step 3 — 明确环境门禁后真实 AI 短/中篇验收。** 使用临时独立测试存档，不能清掉用户当前游戏。至少一次短篇和一次中篇走到结局；每局至少一次 free text，记录同一次生成包中 world/outline/scene 的成功审批。至少一次手动 retry、一次战败重赛；审计证明移动/取物/战斗没有额外 provider 调用。配置/权限不具备时明确标记“真实 AI 待验收”，不使用 fixture 假称真机通过。

人工检查：NPC anchors/知识没漂移；旧问题被自然承接；下一 chapter 修订反映真实玩家行为而不是事先写死；未实现槽位不在对白中当真人；不同模板嵌套不是为了填表强行扭曲剧情。文学质量不足只调输入卡/文本合同，不绕过证据闸门。

- [ ] **Step 4 — 标记 implemented / implemented 并提交验收事实。** 在功能分支执行 `git add docs src && git commit -m "docs(outline): document living outline and playable acceptance"`；真实 AI 未完成时不得写全部验收通过。
- [ ] **Step 5 — 回 main 统一合并收尾。** `npm run branch:merge -- codex/hierarchical-living-outline-story-threads`；完整通过后机器状态才写 `completed / merged`，不直接删除带 foundation 链接的 worktree。

## 5. 验收追踪与自检

| 需求/风险 | 覆盖任务 | 不可弱化的断言 |
|---|---|---|
| NAR-10 长期可修订大纲 | 1、3、4、6、10 | 玩家行为改变未来方向；旧 Event/已达到节点不变 |
| NAR-11 嵌套多结构 | 1、2、3、10 | 三幕 campaign 含多个 chapter；子模板独立、深度/循环受限 |
| NAR-14 战斗失败恢复 | 5、8、10 | snapshot 包含 outline；败局证据不存在，胜利有真实依据 |
| NAR-17 每阶段完整可玩 | 5、6、8、10、11 | 短/中篇都到真实 ending，optional Thread 不软锁 |
| 一次生成逐步消费 | 6、8、9、10 | 无新增 provider、路线/战斗只消费批准图 |
| 关系/知识权限 | 2、4、7 | plan 不写组件、不扩大 NPC disclosure/usedEventIds |
| 过去/当前/未来分离 | 2、4、7 | 未绑定 slot 不算真实实体；预创建任务不算已经历 |
| CAS/重试/恢复 | 5、6、9 | 无半提交、重复 revision、未来引用或静默修复 |
| 记忆与酒馆式上下文策略 | 3、7、10 | 定向相关激活＋独立块预算＋无正文 manifest，而非聊天全文注入 |

执行前自检：本文所有新函数均在 Interfaces 或对应步骤中声明；后续代码不能创造第二套同义 helper；测试 fixture 必须建立真实 Entity/Event 闭包。

**完成界限：** Plan5 交付的是可运行、可持久化、可审批、能影响下一次生成的长期叙事计划系统；不是单独存一个大纲 JSON，也不是提前实现长篇或自动保证文学高潮。
