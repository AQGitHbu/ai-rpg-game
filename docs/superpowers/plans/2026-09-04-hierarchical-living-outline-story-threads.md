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
- 实施前读根 AGENTS、开发规范、Agent 索引、阶段入口和本文全局约束；当前 Task 涉及哪些系统，再读对应 agent 文档与 Spec 章节。生产事实由当前系统文档和代码核实。
- Plan5 实施使用 `codex/hierarchical-living-outline-story-threads` / `.worktrees/hierarchical-living-outline-story-threads`；实现任务在目标 worktree 中执行。
- StoryState 在 Task 5 从 v8 升 v9；WorldState 保持 v5、EntityStore 保持 v2、record version 保持 1。旧 Story v1–v8 明确 `UNSUPPORTED_RECORD`，未知未来版本 `VERSION_MISMATCH`；不静默重建旧存档，不自动清档。
- 不修改 `StoryContract.targetActs: 3 | 5`、现有短/中篇预算、世界具象化的目标链策略或战斗数值。计划里的 `phase` 与游戏里的 `currentAct` 不是同一个概念。

---

## 0. 状态与代码接入基线

> 状态：待执行

本文规划层级大纲与剧情线程；任务勾选表示实施与验收进度。

执行前核对 main、目标分支与 worktree，确认工作区干净。下表提供接入定位；具体实现以当前源码与系统文档为准。

| 已核实事实 | Plan5 必须如何接入 |
|---|---|
| `StoryState` v8 只有 Contract、数值幕/张力、`unresolvedThreads: string[]`、memory；没有真实 Arc/Thread 对象 | 新增独立 outline，不声称旧字符串数组已具备线程生命周期 |
| `advanceStoryProgression` 按主线 Quest.stage/完成状态推进 `currentAct`，并写 `evolution.status`（`needs_next_act`/`needs_ending_pair`）；`EvolutionNeed` 由 `worldEvolution/deriveEvolutionNeed` 另行派生 | 保留游戏执行权威；outline 记录/约束叙事意图，不取代 Quest resolver |
| 生产 continuation 是 `narrativeBundle`；旧 `PreparedContinuationState` 仅 offline fixture 使用 | 两者的状态提交都要同步 outline；新 AI 协议只接生产 bundle |
| `generatePendingNarrativeBundle` 最多四次完整尝试（`MAX_NARRATIVE_BUNDLE_ATTEMPTS = 4`），成功后调用 `repository.applyState` 一次；四次全失败时另有一次 applyState 只为写 `provider_failed` | 不按旧文档寻找已经删除的 `sceneWriteBack.ts`（该文件已不存在，只剩 repository port 方法 `applySceneWriteBack`，仅被 test-only 的 `generatePendingScene` 调用）；在现有 retry/CAS 内加入规划审批 |
| **没有任何 journey 测试跑生产 bundle 路径。** `generatePendingNarrativeBundle` 的 import 方只有三处：生产装配 `compositionRoot.ts:22`（在 `:255` 作为 coordinator 执行体）、它自己的 `generatePendingNarrativeBundle.test.ts`、以及只做源码文本断言的 `providerTriggerBoundary.test.ts:21`。所有 journey 走的是 legacy 场景链：`foundationJourney.testutil.ts:208-220` 的 `advanceScene` 调 `generatePendingScene` + `createDeterministicSceneSource()`（`deterministicSceneSource.ts:63`，返回的是 `SceneSource`，与 `NarrativeBundleSource` 是两套协议），配合 `installPreparedContinuationForTest`（`npcContinuityJourney.testutil.ts:184`）安装 `PreparedContinuationState`。`createFixtureOpeningSource()`（`createGame.ts:639`）虽然是 `NarrativeBundleSource`，但 `:643` 对 `context.kind !== "opening"` 直接返回 `AI_CALL_FAILED`，所以它**只覆盖 opening，不覆盖 decision** | Task 5/8 拿 `npcContinuityJourney` 证明的结局可达性是 **legacy 链**的可达性（这也是 Task 5 必须同时改 `generatePendingScene.ts` 的原因）；它不能证明 `outlineUpdate` 修订协议在生产链上跑通。Task 10 的新 journey 是**第一个**驱动生产 bundle decision 路径的端到端测试，别把它当成对既有覆盖的补充 |
| `materializeWorldDelta` 返回 `ApprovedWorldDelta`（`mintedLocationIds/mintedNpcIds/mintedItemIds/mintedEnemyIds/mintedFactIds/mintedQuestIds/mintedEndingIds` + `previewWorldState` + `previewStoryState` + `eventDrafts`）；它可能提前物化下一幕 Quest，但只有 `stagedQuest.stage === ss.currentAct` 时才把 `reveal` 置为 `{questId, visibleObjectiveIndex: 0}` | “实体已创建”不等于“角色已经见到”，更不等于未来 Arc 已执行 |
| Event payload 为封闭 union；NPC 来源使用 Event ID；memory 从 ledger 重建 | Thread/Milestone 只能引用合法 Event，不用 actionId、正文或数组下标代替证据 |
| Event 校验覆盖 payload、回合号和因果顺序；检索隔离当前回合与历史，bundle 消费记录 presented Event | 新增 payload 必须同步 `eventPayloadValidation.ts`；本 Plan 不需要新增世界 Event 类型 |
| `compositionRoot.ts` 只构造一个 AI 源 `createNarrativeBundleSourceFactory → liveNarrativeBundleSource`；`liveScenePerformanceSource`/`createLiveWorldEvolutionSource` 只被 `sourceFactory.test.ts` 构造，`generatePendingScene` 只被测试与 testutil 导入，`sceneNarrativeContext`/`worldNarrativeContext`/`sceneGenerationContext` 都不在 bundle 生产路径上（bundle prompt 全部来自 `narrativeBundleContext.ts`） | Task 7 只改生产 bundle 投影，不为已离开生产路径的 legacy scene/world 编译器加 outline 卡 |
| `mediumActJourney.test.ts` 当前只证明中篇初始化/首次决策，不是完整五幕通关；唯一打到结局的现有旅程是 `npcContinuityJourney.test.ts`（中篇、`successfulRounds >= 18`、act 5、`ending` 非 null） | Task 10 新建生产 bundle 完整旅程；不拿文件名当完成证明，也不给短篇凭空设定未经验证的回合下限 |

### 0.1 每个阶段结束后能玩什么

整个 Plan5 完成后，玩家仍可创建短/中篇、双选项/自由输入、探索、取物/赠物、对话、战斗、失败重赛、恢复存档并抵达结局。增加的是跨幕中心问题、旧线索/承诺的可追踪性，以及玩家行为改变近未来方向的能力。

不新增玩家菜单、支线任务玩法、休整/成长系统或长篇入口。Task 1–4 是未接运行时的纯增量模块，游戏不变；Task 5 完成 schema 与规则投影整批切换，游戏仍可通关；Task 6–9 逐步加入 AI 修订和 prompt 约束，不能留下需要“下一 Task 才能玩”的提交。

## 明确边界

- **本 Plan：** 保存结构功能、前置里程碑、赌注/问题、线程、未来方向与批准修订；让生产 decision bundle 中负责场景与世界增量的同一份 Prompt 读到它们。不扩展 legacy scene/world source。
- **Plan6：** 用这些输入真正选择 scene intent、安排场景类型轮换、转折/高潮、战斗的戏剧功能，并调整世界目标链。Plan5 不增加 `ScenePlan`，不强制某个回合发生战斗。
- **Plan7：** 分段 ledger、快照、归档、索引表、context fingerprint 与非线性长局成本。Plan5 的内存重建仍允许扫描完整短/中篇 ledger。
- **Plan8：** 十小时 Campaign、长期预算与真实长局验收。

## 1. 设计决策

### 1.1 三种权威必须分开

1. `StoryContract`：本局中心冲突和两个结局方向，初始化后不接受 outline 指令修改。
2. `OutlineDefinition`：批准的叙事计划，回答“准备围绕哪些问题、用怎样的结构继续”，不是已经发生的事实。
3. `OutlineProgress`：从当前规则事实和真实 Event 派生的“哪些节点激活、达到或关闭”。AI 不提交 status、phase 游标、completedAt 或 endingAllowed。

Outline 与 Episode 的重建语义不同：Episode 全部来自 Event；AI 创作的未来方向不能从规则事件猜出来。outline 初始定义和批准修订是计划的持久化源，进度才是可重建投影；不把 AI 大纲伪装成世界事件。

与总 Spec §8.2 `StoryArc` 的字段对照（刻意拆分，不是漏项）：`arcId/parentArcId/scope/structure/dramaticQuestion` 一一对应；Spec 的 `premise` 落在 `OutlineArc.direction`；Spec 的 `phase` 与 `status` 移到 `OutlineProgress.arcs[].phase/phaseIndex` 与 `state.status`，因为它们是可从 Event 重算的投影，写进定义就会变成 AI 可篡改的第二真相源；Spec 的 `threadIds/milestoneIds` 改为 `StoryThread.arcId` 与 `OutlineMilestone.arcId` 的反向引用，避免同一关系存两份而失同步；Spec 的 `revision` 落在 `ApprovedOutlineRevision.revision`。`status` 值域从 Spec 的 `planned/active/resolved/abandoned` 扩为再加 `superseded`，用于 §1.4 要求的“被替代”与“被放弃”区分。

### 1.2 嵌套而不绑死幕数

结构层级固定允许 `campaign → chapter → quest → scene_sequence`，最大深度 4；父子模板可以不同，也可以都是三幕式。执行绑定由规则生成：campaign 对应全局契约；chapter 对应现有游戏 stage；quest 对应真实 Quest ID；scene_sequence 对应该 Quest 的目标范围。

campaign 三幕式可以包含五个 chapter，而每个 chapter 又选择三幕式/谜题结构。`currentAct=4` 表示游戏进入第四个主线阶段，不表示 campaign 有第四个三幕式 phase。

初始只创建根和无实体的阶段需求；实际 Quest/Sequence Arc 只在 Quest 已审批创建后绑定。预具象化的下一幕处于 planned，不因 store 中已存在 NPC/敌人就把相关经历标成已发生。

### 1.3 滚动窗口

- 历史：只投影带 Event 依据的已达到节点；保留原 ID，不改写。
- 当前：当前 chapter、当前 Quest/Sequence、相关已存在实体和最多 6 条相关 Thread。
- 下一 chapter：最多一个具体方向、4 个待完成 milestone 和 4 个实体槽位；有需要才细化。
- 远期：只有 Contract 的中心冲突、抽象结局方向和阶段需求；不预写远期人物、地点或剧情正文。

玩家改变未来的可验证表现：同 seed 下 `support/challenge/refuse/offer` 等真实事件可成为修订原因，批准修订改变下一 chapter 的方向/结构或未来槽位；已完成节点与旧 Event deep-equal。`DIALOGUE_ACTS` 的封闭值是 `ask | support | challenge | threaten | deceive | offer | refuse | reassure`——没有 `offer_help`（`offered_help` 只是 `RelationshipSignal`，不是对话行为）。当前自定义输入仍映射中性 ask；这只意味着它不能冒充结构化 refuse/support 证据，**不意味着自由输入不能改变未来方向**。AI 可以读取本轮 job 的玩家原话，以 player_choice 和本 job 的真实交互 Event 为来源提议未来修订，仍受相同范围/冻结/预算审批；不得据文字擅自关闭线程、改变关系或改写既成事实，也不新增本地关键词裁决。

### 1.4 Thread 不是额外的通关锁

`main_conflict` 仅由规则创建并拥有，映射当前主线完成门槛；AI 不能创建新的强制结束条件。其他 question/clue/promise/threat/relationship_conflict 都是叙事线程，默认不阻塞结局。

关闭线程必须符合明确的 evidence predicate，不是“存在任意一个 eventId 就算解决”。`abandoned`、`superseded` 与 `resolved` 是不同结果；结局时未完成可选线程保留为有原因的未兑现/放弃，不伪装全部兑现。

NPC commitment 仍由 NPC 组件拥有：它位于 entity store 的 `DirectedRelationshipEdge.commitments`（`npcComponents.ts`），标识字段是 `commitmentId`，`kind` 为 `debt | promise`，状态分别是 `open/fulfilled/forgiven/broken`（debt）与 `open/fulfilled/broken/released`（promise）。commitment 自身**没有** `target` 字段，对手方是所属 edge 的 `targetId: PlayerEntityId | NpcId`，边源是持有该组件的 NPC record。promise Thread 仅引用同一 commitment 的证据与状态，不能另写第二份债务/承诺。关闭剧情线程也不能提升关系 stage 或写 NPC knowledge。

### 1.5 受限修订，与已有生成包同生共死

decision 顶层新增必填 `outlineUpdate: OutlineRevisionProposal | null`，其余字段保留。opening 顶层新增小型 `outlineSeed`；两个子协议都有独立 parser，任何未知字段/越权状态/非法引用拒绝整包。

`null` 表示沿用已批准方向，不是缺字段兼容、不是假装产生新计划。规则进度无论是否有修订都会更新。正文/世界增量若依赖非法修订，不能只丢修订而接受其余内容；整个 attempt 失败，沿用原有 bounded content repair 和同 job 手动重试。

不增加 AI 调用，最多四次 attempt 的边界不变。Plan6 场景规划未接入前，outline 指令也不能更改当包 descriptors、合法选项或未来已经批准的续接步骤。

这同时对 Spec §11.3 做了一个明确取舍：§11.3 允许 outline 修订“在回合提交后的后台阶段运行”，只要下一次上下文投影前完成、或明确使用旧版本，且不出现半提交。本 Plan **不走后台阶段**——outline 修订与 worldDelta/scene 同属一个 narrative bundle，在同一次 `repository.applyState` CAS 内一起成功或一起失败。因此 §11.3 的两个分支中只用到“不得半提交”这一条，另一条（后台补齐、投影时可能读到旧版本）在本 Plan 不存在。执行时**不要**新增提交后的后台 outline updater，也不要为它加“投影时版本可能落后”的兼容读法；那会凭空造出 §11.3 允许但本设计刻意排除的第二种一致性模型。

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
  entityKind: "npc" | "location" | "item" | "enemy" | "fact" | "quest";
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
  commitmentRef: Readonly<{ npcId: NpcId; targetId: PlayerEntityId | NpcId; commitmentId: string }> | null;
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

§2.1 的 `string & { readonly __arcId: unique symbol }` 写法在本仓 TS 5.8.3 strict 下可编译且四个 brand 互不兼容；它与既有 idiom（`worldEntity.ts` 的 `BrandedId<Name>` 共享 `scenarioIdBrand`、`events.ts` 的 `[eventIdBrand]: unique symbol`）并存，实施时任选其一但同一模块内保持一致。注意 `EntityId` **不是** brand，而是 `entityCore.ts` 里八类 branded ID 的普通联合别名，`actionId` 是裸 `string`；`OutlineRef` 依赖 `EntityId` 时不要试图对它做 brand 转换。

`initial` 与 `revisions` 是唯一计划源；effective definition 由 `applyOutlineOperations` 顺序重放。`progress` 是缓存，读取存档时重算比较；不另存一份可独立修改的 currentDefinition。

规则生成的 Quest/Sequence 绑定通过 `projectExecutionArcs` 基于当前 Entity Store 合入 effective view，不写入 AI 初始定义，也不把未创建任务编号当实体 ID。chapter 的抽象 stage 可预分配，允许范围是 `1..execution.targetActs`（即 `storyState.targetActs`），**不是** `1..contract.targetActs`：`StoryContract.targetActs` 被类型锁死为 `3 | 5`（`openingGenerationCandidate.ts` 会拒绝其他值），而 `TARGET_ACTS.long = 8`，两者并非同一权威。当前生产 API（`src/app/api/game/route.ts:5` `const GAME_LENGTHS = new Set(["short", "medium"])`，`NewGameSetupForm.tsx:134-137` 的 `GAME_LENGTH_OPTIONS` 也只有短篇/中篇两项）使二者一致，但 stage 范围必须跟执行游标同源，否则将来开放 `long` 档时第 6–8 幕的 chapter 无法表示。`OutlineSlot.entityKind` 刻意不含 `faction`：全仓没有任何 faction 铸造路径（`WorldState.factions` 恒为 `[]`，`ApprovedWorldDelta` 无 `mintedFactionIds`，`NarrativeSymbolRef` 无 `@new.faction`），该槽位永远无法绑定，属于死抽象。

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

上面 branded 类型出现在 proposal 子结构中只表达字段语义；parser 从 unknown 校验并转换品牌，不认为 provider 的 TS 类型可信。provider 的 localKey 使用 `[a-z][a-z0-9_]{0,31}`，同提案引用写成 `@local.<localKey>`，只允许引用前面已创建的节点。批准 operations 按独立类型重建，把 localKey/`@local.*`/`@new.*` 全部换成服务端 ID，绝不持久化符号或 provider 对象引用。`@new.*` 的封闭白名单取自 `narrativeBundle.ts:57-67` 的 `NarrativeSymbolRef` 中六个 `@new.*`：`@new.location/npc/item/enemy/fact/quest`，分别对应 `ApprovedWorldDelta` 的 `mintedLocationIds/mintedNpcIds/mintedItemIds/mintedEnemyIds/mintedFactIds/mintedQuestIds`。**注意这不是一个已在运行的协议**：`NarrativeSymbolRef` 全仓只有那一处类型声明，没有任何消费方；`narrativeBundleContext.ts:363` 那行“符号引用白名单”只是 prompt 文本，而同一份输出契约里 currentScene/continuationScenes 只接受真实 ID（`npcId`/`questId`/`candidateId`/`beatId`），worldDelta 用的是 `locationRef:{kind:"new_location"}` 而不是 `@new.location`。也就是说仓里没有可复用的符号解析器，Plan 5 的 `symbolBindings` 是**第一个真实消费方**，不要去找现成 helper（见 Task 6）。bind_slot 的 sourceEventId 取该实体创建来源的 `game_initialized` 或 `blueprint_expanded` Event（**没有** `initialization` 这个 payload 类型，`"initialization"` 只是 `eventLedger.ts` 里的一个 episodeKey 字符串）；已存在实体也必须能在已提交 ledger 中定位来源。

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

predicate 与真实 payload 的封闭映射（字段名逐一核对 `events.ts`，不得凭记忆改）：

| predicate | 匹配的 payload `type` | 必须相等的 payload 字段 | 真实发射方 |
|---|---|---|---|
| `fact_discovered` | `fact_discovered` | `factId` | 调查/对话揭示 |
| `location_visited` | `location_visited` | `locationId` | `resolveByType.ts` 的 `move` 行动；candidate event 的 `location_state_changes` |
| `item_obtained` | `item_obtained` | `itemId`（payload 还带必填 `locationId`） | `take_item` 行动 |
| `enemy_defeated` | `enemy_defeated` | `enemyId` | `battleResolver.ts`：modern 路径按 `advanced.state.downedEnemyIds` 逐个发，legacy 路径在 `enemyHp <= 0` 胜利分支发 |
| `npc_dialogue_completed` | `npc_dialogue_completed` | `npcId` | `ruleEngine/index.ts`：同一 NPC 的对话会话 `turnCount >= DIALOGUE_REQUIRED_TURNS`（=2）且刚转为 completed 的那一次 |
| `quest_completed` | `quest_completed` | `questId` | `reconcileQuests.ts` 全部 objective 满足时 |
| `relationship_signal` | `npc_relationship_changed` | `fromNpcId` + `targetId` + `signal` | 对话（`dialogueResolution.ts`）、赠物、共同战斗、含 `talk_to_npc` 目标的任务完成 |
| `ending_reached` | `ending_reached` | 与 `worldState.ending.endingId` 相同（predicate 本身不带 endingId） | `resolveEnding.ts` |
| `mainline_ready` | 规则 `execution.endingAllowed` + 主线终止事件 | 当前主线 Quest 的 `questId`，必要时补真实 `ending_reached`；不是另算一套终幕 completed 条件 | `advanceStoryProgression` 提供可结束性；ledger 提供来源 |

`mainline_ready` 是零元 predicate，必须以 `execution.endingAllowed` 为唯一可结束性判断：为 false 就返回 `[]`；为 true 才按 sequence 收集已解决主线 Quest 的 `quest_completed/quest_failed` 来源，以及存在时与实际结局一致的 `ending_reached`。生产正常完成路径有真实 quest_completed；缺失全部来源的手造状态不能伪造 Event，要由 reconcile/persistence 返回 `outline_evidence_invalid`。不能仅凭“终幕 Quest completed”解决主线：当前幕尚未到终幕、其他主线未解决或 storyProgress 未达门槛时，规则仍可能禁止结束。也不能因当前没有 failed 的行动入口，就把领域已支持的 failed/closed 状态重新定义成未解决。outline 只读取规则结果、不反向控制 endingAllowed；Task8 必须验证同回合对齐。

- 所有 predicate 都匹配 Event **payload 的实际目标**，不能只匹配 envelope 的宽泛 `actorIds/targetIds` 或 event `kind`。envelope 与 payload 同名不同义时必须用 payload。
- `explore` 行动发的是 `location_explored`，**不满足** `location_visited`；`location_observed` 只来自已激活 candidate event 的 `hostile_force_acts`，与玩家移动无关。写测试时不要用 explore 去证明“到访”。
- `enemy_defeated` 不是“只来自胜利链”：modern 路径在整场结果为 withdraw 时也可能已经发出击倒事件。真正的保证在 application 层——`performBattleRound` 对 defeat/withdraw 用 `WorldState.battle.preBattleSnapshot`（`{entityStore, eventLedger}`）整体回滚，所以败局击倒事件不会留在持久化账本里。predicate 只需匹配 payload，不得自己再判胜负。
- Thread 的解决证据必须晚于其 opening 证据（比较 `CommittedNarrativeEvent.sequence`）；同一个事件不能同时作为“新提出问题”和“后来已解决”的依据。规则预先满足的 Quest objective 可以引用更早的真实事件，但明确标为既有证据，不重新发 Event。
- `promise` 必须有 commitmentRef，并且该引用指向 `kind === "promise"` 的实际 commitment。双重证据必须属于同一条边：组件中的该 commitment 为 fulfilled，账本中的 `npc_relationship_changed` 同时匹配 fromNpcId、targetId、kept_promise，且晚于 commitment 创建来源和 Thread opening。审批 open_thread 时 commitment 必须仍为 open，不能拿过去已履行的承诺新开一个线程再配任意 kept_promise。多个 open promise 并存时，要按现有 signal policy 的“第一个匹配且 open”顺序关联被履行对象，不能仅靠同边存在过 kept_promise 批量关闭线程；用两个 promise 的回归测试证明只关闭命中的那一个。当前 Event 没有 commitmentId，无法确定对应关系时保留未解决，不猜测。open/broken/released 不得称为 fulfilled，debt 的 forgiven 不属于 promise 状态。
- `threat` 仅接受目标敌人 `enemy_defeated` 或关联 Quest `quest_completed`；`clue` 仅接受明确 `fact_discovered` 或关联 Quest 完成；`relationship_conflict` 只引用已有 `npc_relationship_changed` 及其目标边，不产生关系变化；`question` 仅允许 `npc_dialogue_completed` / `fact_discovered` / `quest_completed` 三类证据。
- `mainline_ready`、`ending_reached` predicate 只能由规则 scaffold 创建。AI open_thread/add_milestone 提交它们返回 `outline_scope_forbidden`。
- `narrative_scene_presented`、`blueprint_expanded`、`candidate_event_approved` 本身不证明“敌人已击败/承诺已兑现”；`world_materialized` 可以解释新槽位绑定，但不是剧情完成证据。
- `retire_thread` 不允许 main_conflict。AI abandoned 只接受相关 NPC 的真实拒绝交互（npc_interaction_recorded/refuse 或同目标边 npc_relationship_changed/refused）；游戏结束时的清理由规则读取真实 ending_reached 执行，不依赖再调用 provider。Quest.closed **不是 Event**，当前 reconcileQuests 只在输入 Quest 已 failed 且 onFailure=closed 时写 closed，既不产生关闭事件，也不是独立的玩家失败入口；不能把 closed 与任意 reasonEventId 拼接成放弃证据。规则 Arc 可按当前 Quest.closed 派生 abandoned，但不得伪造历史来源或把它用于 AI retire。superseded 要求同范围真实 replacementThreadId 和事件原因，不能自替代/循环；resolved/abandoned/superseded 的历史线程均不可再次 retirement。
- provider 的 sourceEventIds 来自本 job.domainEventIds、它们的直接原因和当前相关线程的既有证据；不能任意抓一条古老 Event 为玩家当前偏航背书。响应后才铸造的 blueprint_expanded 只供服务端填绑定证明，见 Task6 的生成前白名单与生成后来源区分。
- 查询玩家行为只读规则 `dialogueAct`。当前自由输入没有结构化拒绝证据时（自由输入恒映射为 `ask`），不能通过匹配输入文字强行放弃线程。

这里的 dialogueAct 限制用于验证拒绝/履约等硬状态变化，不禁止 AI 理解本轮原话来调整未来计划。player_choice 接受固定选项和 npc_free_text 两种正式决策边界，但必须引用该 job 的真实交互 Event；审批不把语言理解结果升级为已发生世界事实，也不把玩家原文复制进大纲或审计日志。

## 3. 文件与职责

```text
src/game/domain/
  livingOutline.ts                  类型、ID、预算常量
  livingOutlineValidation.ts        严格 schema、图/层级/范围 invariant
  outlineProposal.ts                opening seed 与 revision 子协议 parser
  storyState.ts                     v9 + outline；legacy 字段仍有明确投影归属
  testing/storyStateFixture.testutil.ts 测试专用契约/outline 工厂，生产禁止导入
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
  outlineEvidenceWindow.ts           Prompt 与审批共享生成前证据白名单
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

FACADES 的三条自动盘点断言（`dependencyBoundaries.test.ts:539-565`）已核实为：`FACADES[].name` 排序后必须与 `src/game/gameplay/rpg` 下的目录名排序后完全相等；每个 facade 目录必须有 `index.ts`；每个声明的 `anchors[]` 必须有同名 `<anchor>.ts` 文件（**单向**——不要求目录里每个 `.ts` 都被登记为 anchor）。因此 `storyOutline` 目录与它的 FACADES 条目必须在同一次提交落地，且 anchor 只能声明该提交时已存在的文件：Task 2 登记 `structureTemplates/outlineEvidence/outlineProgress`，Task 3 追加 `outlineBootstrap/executionArcs/outlineWindow`，Task 4 追加 `outlineOperations`。深导入 `@/game/gameplay/rpg/storyOutline/<file>` 被规则禁止，gameplay 内部跨系统也只能走 facade 根。

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

**Files:** Create `src/game/gameplay/rpg/storyOutline/{index,structureTemplates,outlineEvidence,outlineProgress}.ts` 及同目录测试；Modify `src/dependencyBoundaries.test.ts`——在 FACADES 追加 `{ name: "storyOutline", path: "@/game/gameplay/rpg/storyOutline", anchors: ["structureTemplates", "outlineEvidence", "outlineProgress"] }`。目录名必须与 `name` 完全相等且本批就带 `index.ts`，否则 `test:boundaries` 的目录盘点断言（`dependencyBoundaries.test.ts:542-553`）当场失败；Task 3/4 再追加各自 anchor，不要在本批声明尚不存在的文件。

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

两个工厂的真实合同（已核实，别按猜的签名写）：

- `makeCommittedEvent(payload, overrides = {})` 来自 `src/game/domain/testing/committedEventFactory.ts`，是**位置参数**而不是单一 input 对象；默认填 `turnNumber: 0`、`actorIds: [PLAYER_ENTITY_ID]`、`outcome: "neutral"`、`salience: 50`、`causeEventIds: []`。它内部有模块级 `testSequence`/`testTurnCounter` 计数器，必须在 `beforeEach` 调 `resetTestEventSequence()`，否则跨用例的 `sequence` 会不连续而被账本校验拒绝。
- `createWorldStateFixture(input)` 来自 `src/game/domain/testing/worldStateFixture.testutil.ts`，必填 `generation` 与 `projection: EntityCompatibilityProjection`，内部走生产 `createWorldStateFromProjection`，因此 store 与兼容投影天然一致；同文件另有 `createWorldStateFixtureWith` 与 `updateWorldStateFixture` 可用于增量。
- 需要真实追加事件时用 `commitEventDrafts({ ledger, drafts, source, entityStore })`（`eventLedger.ts`）：`entityStore` 是**必填**，所有 actor/target/location/fact/quest 引用都会对照 store 校验，`source` 形状是 `{turnId, turnNumber, committedAt, actionId?}`，draft 用 `eventKey/episodeKey/causeKeys` 而不是 `eventId/causeEventIds`。

- [ ] **Step 2 — Run** `npm test -- src/game/gameplay/rpg/storyOutline`；Expected FAIL。
- [ ] **Step 3 — 实现固定模板与 §2.4 证据策略。** five_act=`setup/development/reversal/climax/resolution`，mystery=`setup/development/reversal/climax/resolution`，quest=`setup/development/climax/resolution`，three_act=`setup/development/resolution`；三幕内部高潮由嵌套 milestone 表达，不硬把 development 改成高潮。custom 使用已验证数组。`DramaticFunction` 只有五个值，所以 five_act 与 mystery 必然共享同一功能序列——这是刻意结果，不是漏写模板：两者的区别落在 milestone 语义（mystery 的 reversal 承担“错误线索/翻案”，five_act 的 reversal 承担“局势反转”）与可嵌套的子模板上。测试要显式断言这两个模板相等，把这个决定钉住，而不是留给后人当成 bug 去“修”。

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

Quest 的 failed/closed 是领域合法终态，规则投影可据当前状态标 abandoned；当前玩家流程没有把 Quest 写为 failed 的入口，不能因此虚构一条可游玩的任务失败路线，也不能删去持久化合法状态的处理。AI retirement 的证据要求另见 §2.4。Thread 有合格且晚于 opening 的结果才 resolved，终局清理只处理仍 active/planned 的可选 Thread；已经 resolved/abandoned/superseded 的节点必须保持原结果，不被终局清理覆盖。

- [ ] **Step 4 — Run** targeted＋`npm run test:boundaries`＋`npm run typecheck`，Expected PASS。测试覆盖错目标、错误事件 kind、future cause、未绑定槽位、乱序前置、重复归约、已达到节点不退回、对方关系边不能履行本边承诺。
- [ ] **Step 5 — Commit** `git add src/game/gameplay/rpg/storyOutline src/dependencyBoundaries.test.ts && git commit -m "feat(outline): derive arc and thread progress from rule evidence"`。

### Task 3: 开局 scaffold、实际任务绑定与滚动窗口

**Files:** Create `src/game/gameplay/rpg/storyOutline/{outlineBootstrap,executionArcs,outlineWindow}.ts` 及测试；Modify facade `index.ts`；Modify `src/dependencyBoundaries.test.ts`——把 Task 2 那条 `storyOutline` FACADES 条目的 `anchors` 追加为 `["structureTemplates", "outlineEvidence", "outlineProgress", "outlineBootstrap", "executionArcs", "outlineWindow"]`（Step 5 已经 `git add` 这个文件，别让它变成未描述的改动）。三个 anchor 文件本批同时创建，所以 `:557-563` 的 anchor 存在性断言当场就能过。

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

`createInitialOutline` 返回裸值，前提是 contract/seed 已验证；`structurePhases`、`projectExecutionArcs`、`selectOutlineWindow` 也返回裸值，所以它不是唯一例外。开局按 contract.targetActs 创建根、chapter 与 thread:main，运行时范围跟随 execution.targetActs；本 Plan 的短/中篇二者必须一致，不借 long/open 的旧占位值扩展支持范围。返回前验证 scaffold，内部不变量失败可 throw；provider 的非法 seed 必须先被 parser 拒绝，不得靠异常代替稳定提案错误。Task3 的测试用合法 typed seed 构造结构；Task4 再补非法 provider seed 的 parser 用例，不提前调用尚未实现的 parser。

```ts
const questArcId = asArcId(`arc:quest:${quest.id}`);
const sequenceArcId = asArcId(`arc:sequence:${quest.id}:0:${quest.objectives.length - 1}`);
```

零目标 Quest 不生成 sequence。模板继承只做默认值，已经批准给下一 chapter 的独立模板不被父模板覆盖。每个实际 objective 使用对应 predicate 生成稳定 milestone，prerequisites 链按已批准目标顺序；不重排 objectives。窗口按显式相关参与者、priority、opening 事件年龄、ID 稳定排序，排除已 resolved/abandoned 的 Thread，仅另取 4 个历史 milestone。

- [ ] **Step 4 — Run** targeted＋typecheck，Expected PASS。用“campaign 结构 three_act ＋ 5 个 chapter ＋ 其中一个 chapter 内嵌 mystery Quest Arc”的 fixture 证明层级与游戏幕数解耦。这里两个数字属于不同维度，别混：**campaign 的 `three_act` 是 3 个戏剧 phase**（setup/development/resolution），**chapter 数量必须等于 `execution.targetActs`**，因为 §2.1 把 chapter 的 stage 范围锁在 `1..execution.targetActs`。所以这个 fixture 必须是 `targetActs = 5` 的中篇局（campaign 用三幕结构、chapter stage 取 1..5），不能建成 `targetActs = 3` 却塞 5 个 chapter——那会直接违反 stage 范围校验，测试会以错误的理由失败。未创建实体只出现 slot，不出现在世界索引或地图。
- [ ] **Step 5 — Commit** `git add src/game/gameplay/rpg/storyOutline src/dependencyBoundaries.test.ts && git commit -m "feat(outline): bind real quests and select rolling planning windows"`。

### Task 4: 受控修订 parser、审批和不可变历史

**Files:** Create `src/game/domain/outlineProposal.ts`、`src/game/application/approveOutlineRevision.ts`、`src/game/gameplay/rpg/storyOutline/outlineOperations.ts` 及各自测试；Modify storyOutline facade `index.ts`；Modify `src/dependencyBoundaries.test.ts`——按 §3 的登记顺序把 `outlineOperations` 追加进 `storyOutline` 条目的 `anchors`（Step 5 的 `git add` 必须带上这个文件，否则这条改动会留在工作区）。

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
// 成功结果的重复提交先做规范内容比较，不重新执行状态审批或应用操作。
const retry = input.outline.revisions.find((entry) => entry.jobId === input.job.jobId);
if (retry !== undefined) {
  const before = effectiveOutlineDefinition({
    ...input.outline, revisions: input.outline.revisions.slice(0, retry.revision - 1),
  });
  if (!before.ok) return before;
  const candidate = normalizeOutlineRequest({
    proposal: input.proposal, jobId: input.job.jobId, definition: before.value,
    worldState: input.worldState, symbolBindings: input.symbolBindings,
  });
  return candidate.ok && input.proposal.baseRevision === retry.revision - 1
    && sameCanonicalRequest(retry, candidate.value)
    ? { ok: true, value: retry }
    : { ok: false, code: "outline_revision_stale", path: "revisionId" };
}
if (input.proposal.baseRevision !== input.outline.revisions.length) {
  return { ok: false, code: "outline_revision_stale", path: "baseRevision" };
}
const permitted = new Set(input.allowedEventIds);
if (input.proposal.sourceEventIds.some((id) => !permitted.has(id as EventId))) {
  return { ok: false, code: "outline_evidence_invalid", path: "sourceEventIds" };
}
```

本模块私有接口：

```ts
type NormalizedOutlineRequest = Pick<ApprovedOutlineRevision, "reason" | "sourceEventIds" | "operations">;
normalizeOutlineRequest(input: Readonly<{
  proposal: OutlineRevisionProposal; jobId: NarrativeJobId; definition: OutlineDefinition;
  worldState: WorldState; symbolBindings: ReadonlyMap<string, EntityId>;
}>): OutlineResult<NormalizedOutlineRequest>;
sameCanonicalRequest(left: NormalizedOutlineRequest, right: NormalizedOutlineRequest): boolean;
```

normalization 只做已解析字段重建、稳定 ID 铸造、引用解析与确定性来源定位；不检查“当前仍 planned”、当下预算，不插入节点，不修改组件。首次提交和重复提交复用这一转换，只有首次提交再做 scope/冻结/预算/证据窗口审批。重试应以该 revision 之前的定义转换，不能把已插入的 slot/thread 再审批一次。symbolBindings 必须由调用方保留并传回本次已批准世界增量的原映射，不从后续 job 的实体猜测符号关系。直接对已成功 job 再调用生产生成器仍返回 NOT_PENDING；这里保证的是携带原审批输入的纯函数重复提交语义，不新增存档重载后再次调用已完成 provider job 的路径。

比较覆盖 reason、完整 sourceEventIds 集合和有序 operations，不能只比 operations 从而漏掉改变的原因/证据；对象键序不影响比较，operation 顺序有语义不能排序。`path: "revisionId"` 与 `path: "baseRevision"` 分别表示同 job 内容冲突与新 job 版本过期。保留 §2.2 已定义的 revisionId 持久化字段。

每个操作逐个检查 §2.4：未来修订仅 next chapter；slot kind 与实际 entity kind 一致，`@new.*` 只能经 symbolBindings 解析到已审批 preview 实体；绑定一经批准永不换绑。新增 slot/milestone/thread 的 arcId 仅允许 current/next **chapter**，Quest/Sequence 是规则投影节点，AI 不编辑它们；不创建历史 Arc，不修改 Contract，不改变已批准 descriptor/Quest。操作先作用于本地拷贝，整批 graph/ref/预算验证通过才返回 revision；失败不泄漏前面几个操作的部分效果。

`applyOutlineOperations` 按封闭 switch 重建数组：revise 替换指定未来 Arc 的 direction/structure；add_* 追加服务端 ID 节点；bind/retire 保留在 revision 操作中供 progress 归约。effectiveDefinition 从 initial 起按 revision 顺序 fold；不改 initial 对象。同 job 同操作内容返回既有 revision；字面对象键序不应影响等价性，比较重建后的规范字段。

- [ ] **Step 4 — Run** targeted＋boundaries＋typecheck，Expected PASS。硬断言修改历史、错误 NPC 证据、任意旧 Event 冒充当前选择、假 slot、新 ID、主线关闭、未来 cause、超预算、原输入深冻结、两操作中第二个失败零修改。同 job 测试必须包含 add_slot/open_thread/bind_slot 已生效且 Arc 后来已激活的重试，仍返回既有 revision、零追加；仅改 reason、sourceEventIds、operations 或请求原 baseRevision 任一项，均返回 outline_revision_stale/revisionId。不得只用一个无新增节点的 revise 操作证明幂等。
- [ ] **Step 5 — Commit** `git add src/game/domain/outlineProposal* src/game/application/approveOutlineRevision* src/game/gameplay/rpg/storyOutline src/dependencyBoundaries.test.ts && git commit -m "feat(outline): approve causal future-only plan revisions"`。

### Task 5: StoryState v9 原子切换与持久化完整性

**Files:** Modify `src/game/domain/storyState.ts`、`storyState.test.ts`；Create `src/game/domain/testing/storyStateFixture.testutil.ts`；Create `src/game/application/reconcileStoryOutline.ts` 与测试；Modify `stateCommit.ts`、`generatePendingNarrativeBundle.ts`、`generatePendingScene.ts`、`createGame.ts`；Modify `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`；Modify `src/game/application/server/persistence/{storyStatePersistenceValidation,sqliteGameRepository}.ts` 与对应测试；Modify `src/game/domain/narrative.ts`；同步该变更涉及的 fixture。

两处已核实、容易漏改的位置：

- `src/game/domain/narrative.ts`：`BattleNarrativeCheckpointState.storySnapshot` 是 `Omit<StoryState, "narrative">`，所以它会**自动**多出 `outline` 字段；但 `isBattleCheckpoint` 目前只对 `storySnapshot` 做 `isRecord(...)`，不检查内部形状。要让 Step 3 承诺的“runtime parser 检查嵌套快照的 outline shape”成立，必须改 `isBattleCheckpoint`（或 `parseNarrativeRuntimeState` 里调用它的那条路径），否则坏快照会照旧通过。
- `src/game/application/server/persistence/sqliteGameRepository.ts`：parser 不是散调的。直接调用 `parsePersistableStoryState` 的是 `:153`、`:198`、`:458`、`:525`；另有私有 helper `serializeValidatedStoryState(value, ledger)` 在 `:266`、`:366` 被调用。改签名时这 6 处一起改，漏一处就是编译期才暴露的 half-cutover。

同时 Modify `src/game/gameplay/rpg/storyOutline/{outlineProgress,index}.ts` 及测试，提前提供主线兼容投影，避免直到 Task8 才改变 v9 存档字段含义。

**Interfaces:**

```ts
reconcileStoryOutline(input: Readonly<{ worldState: WorldState; storyState: StoryState }>): OutlineResult<LivingOutlineState>;
projectUnresolvedMainThreadIds(outline: LivingOutlineState): readonly string[];
```

Consumes `effectiveOutlineDefinition → projectExecutionArcs → rebuildOutlineProgress`；Produces 可校验的 `StoryState.outline`。不修改 World Event union，不给计划修订编造世界 Event。

- [ ] **Step 1 — 写失败测试。**

```ts
it("accepts a reconciled outline and rejects a forged milestone cache", () => {
  const fixture = persistableOutlineFixture();
  expect(parsePersistableStoryState(fixture.storyState, fixture.worldState)).toMatchObject({ ok: true });
  expect(fixture.storyState.outline.progress.milestones.length).toBeGreaterThan(0);
  expect(fixture.storyState.outline.progress.milestones[0]?.state.status).toBe("planned");

  const forged = {
    ...fixture.storyState,
    outline: { ...fixture.storyState.outline, progress: {
      ...fixture.storyState.outline.progress,
      milestones: fixture.storyState.outline.progress.milestones.map((entry, index) =>
        index === 0 ? { ...entry, state: { status: "resolved" as const, supportingEventIds: [] } } : entry),
    } },
  };
  expect(parsePersistableStoryState(forged, fixture.worldState)).toMatchObject({ ok: false, code: "INVALID_STORY_STATE" });
});
```

第一条正向断言不是凑数，它让第二条有意义。今天 `hasExactStoryKeys` 会把任何不在 `ALL_STORY_KEYS` 里的键判为 `INVALID_STORY_STATE`，所以只写负向断言时，一个带 `outline` 的 fixture 在**任何 outline 校验实现之前**就已经被 exact-key 检查拒掉——测试立刻变绿，绿的原因是“未知字段”，不是“伪造缓存被识破”。加上正向断言后，Step 2 的 Expected FAIL 才成立（正向那条会先失败）。

`persistableOutlineFixture()` 按文件用各自的既有工厂，**不要跨文件找 `buildTestState`**：它是 `sqliteGameRepository.test.ts:47` 的模块私有函数，没有 export。`storyStatePersistenceValidation.test.ts` 现有的构造方式是 `createInitialStoryState({ gameLength: "short", initialEntityCounts: {...}, initialNarrative: createFixtureNarrativeRuntimeState() })` 配 `makeCommittedEvent(payload)` 与 `rebuildEpisodicMemory(ledger)`；本 fixture 沿用这套，创建至少一个条件尚未满足的合法 milestone，再用本 Task 的 `reconcileStoryOutline` 生成合法 outline，避免对空数组 map 导致没有实际伪造。`sqliteGameRepository.test.ts` 那侧才用 `buildTestState()`。若使用 readonly 类型，构造新的嵌套对象替换而不是通过强制断言绕过编译。

签名说明：第二参数在 Step 3 之前是 `ledger: readonly CommittedNarrativeEvent[]`，Step 3 才改成 `worldState`。Step 1 写的是**改后**的调用形式，因此此刻是类型不匹配——vitest 只转译不类型检查，测试照常运行并失败，这是预期的；`npm run typecheck` 要到 Step 4 才绿。

- [ ] **Step 2 — Run** `npm test -- src/game/application/server/persistence/storyStatePersistenceValidation.test.ts src/game/application/reconcileStoryOutline.test.ts`；Expected FAIL。
- [ ] **Step 3 — 整批 schema cutover，不能提交半切换。** `STORY_STATE_SCHEMA_VERSION=9`，classifier 旧版本加 8，REQUIRED_STORY_KEYS 加 outline。`CreateInitialStoryStateInput` 新增必填 `contract: StoryContract` 和 `outline: LivingOutlineState`，删除当前空 centralConflict 默认契约；domain 只接收值，禁止反向 import gameplay。opening compiler 用实际 candidate.storyContract 和规则 seed 调用 storyOutline facade 的 createInitialOutline，再传入 domain factory；规则 seed 的 nextDirection 取契约 centralConflict，不另编剧情。执行时用 `rg -n 'createInitialStoryState\(' src` 盘点调用，按生产与测试分开迁移，不能按固定调用次数机械替换。

新增测试专用 `src/game/domain/testing/storyStateFixture.testutil.ts`，导出 `createDomainStoryStateFixture(input: Omit<CreateInitialStoryStateInput, "contract" | "outline"> & Partial<Pick<CreateInitialStoryStateInput, "contract" | "outline">>): StoryState`，提供非空最小契约及与它一致的 outline。只有 `.test.ts/.testutil.ts` 可使用它；生产 opening compiler 继续直接调用正式 createInitialStoryState 并传真实已批准 contract/outline，禁止导入 testing 工厂。测试 domain factory 本身的用例仍直接调用它，显式测试新增必填字段，不能一起替换从而失去覆盖。

四处已核实、必须一起改的字面量，漏一处就是静默半切换：

- `storyState.ts:15` `STORY_STATE_SCHEMA_VERSION = 8 → 9`；`:35` classifier 旧版本集合 `{1..7}` 加 `8`。
- `storyStatePersistenceValidation.ts:57` `isStoryShape` 里**另有一份硬编码** `value.version === 8`，与 `STORY_STATE_SCHEMA_VERSION` 不是同一处，必须同步改成 9；`:16-21` `REQUIRED_STORY_KEYS` 加 `"outline"`。
- `storyStatePersistenceValidation.test.ts:27` 现有断言 `version: 9 → VERSION_MISMATCH` 与 `version: 7 → UNSUPPORTED_RECORD` 会因 cutover 直接反义失败，两个字面量都要前移（9→10、7→8）。
- `advanceStoryProgression.ts:13` 的注释写着“compile 用 `thread_main`”，这是**过期注释**：`storyState.ts:112` 的默认值是 `"main_thread"`，而 `compileOpeningGenerationCandidate.ts:215` 根本不传 `mainThreadId`。按注释去搜 `thread_main` 会一无所获。本 Task 把初始主线 ID 统一成 `thread:main` 时，同时删掉这条注释。

`targetActs` 的一个已核实事实，影响 Task 8/10 的假设：生产路径的 `StoryState.targetActs` **永远只有 3 或 5**。`createInitialStoryState` 虽然写 `TARGET_ACTS[gameLength]`（`long = 8`），但 `compileOpeningGenerationCandidate.ts:223` 紧接着用 `candidate.storyContract.targetActs` 覆盖它，而 `parseOpeningGenerationCandidate`（`openingGenerationCandidate.ts:183`）与 `createGame.ts:582` 都把 targetActs 锁死在 `3 | 5`。所以 `TARGET_ACTS.long = 8` 在生产不可达，只有直接用 `createInitialStoryState({ gameLength: "long" })` 的测试能造出 8。outline 的 chapter stage 范围只读 `execution.targetActs`（见 §2.1），不要读 `contract.targetActs`，也不要在 Plan 5 里为 8 幕写专门分支。

Task6 才将规则 seed 换为批准的 opening seed。

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

更新投影数组后同次重算 derivePacingNeed，保证 endingAllowed 已为 true 时 nextPacingNeed 不因旧 unresolvedThreads 再滞后一回合。整个方向必须是“规则 endingAllowed → outline mainline_ready → 兼容数组/节奏”，禁止反向依赖形成循环。

改这个 ID 会波及两类已核实的读取方，必须一起看清：

- 源码读取方包括 intentContext、narrativeBundleContext、sceneGenerationContext 与 worldNarrativeContext，只有 narrativeBundleContext 属于当前生产 decision Prompt。现有 unresolvedThreads 本来就是字符串 ID，统一为 thread:main 不会丢失一份原本存在的丰富线程模型；Task7 是增加结构化内容，不应以“接受暂时变薄”为理由绕过契约回归。其他读取方只保持类型兼容，不新增 legacy outline 卡片。
- 测试字面量 `"thread_main"` 在 `src` 下有 **13 处**，集中在 `advanceStoryProgression.test.ts`。它们是直接构造 `unresolvedThreads` 数组、不经过 `mainThreadId`，所以删掉那个可选输入不会让它们编译失败，只会让它们与新的 `thread:main` 约定不一致。按新 ID 统一改写，不要留着两套字符串。

`parsePersistableStoryState` 不能只验证 `outline` 外层 object：严格解析 initial/revisions，顺序重放并检查历史操作结构、ID、来源及冻结节点约束，所有修订证据 sequence 不晚于 basedOnSequence，修订边界单调且不超过 ledger 尾部。历史修订做结构/provenance 审计，不用当前 NPC 位置/Quest stage 再执行一次当年的运行期审批（本 Plan 没有历史 world snapshot）；当前 world 用于最终实体引用校验与 progress 重算比较。World/Story/Entity/record 版本分类分别保留，不能都压成 corrupt。

扫描并迁移所有 `StoryState` literal 与 parser 调用：`rg -n 'StoryState|parsePersistableStoryState|version: 8' src/game`；本轮环境已确认有 rg 可执行文件，不是仅有 shell alias。若另一执行环境没有 rg 再用 grep，不把所有数字 8 机械替换为 9。checkpoint.storySnapshot 自然包含 outline，runtime parser 要检查嵌套快照的 outline shape；SQLite 再与 preBattleSnapshot 的 Entity Store/ledger 重建出的战前 WorldState 交叉验证，不能传战中世界去验证战前进度。

- [ ] **Step 4 — Run** domain/gameplay/application 子集、typecheck、boundaries 与现有全部 journey，Expected PASS。结局可达性只能拿现有唯一一条打到结局的 journey 证明：`src/game/application/testing/npcContinuityJourney.test.ts`（`gameLength: "medium"`、`targetActs` 5、`successfulRounds >= 18`、`currentAct === 5`、`ending` 非空）。注意这条 journey 跑的是 **legacy 场景链**（`playTurn` → `performTurn`，`advanceScene` → `generatePendingScene` + `createDeterministicSceneSource()`，战斗段用 `installPreparedContinuationForTest`），**不经过 `generatePendingNarrativeBundle`**（见 §0 新增那行）。这对本 Step 恰好是对的：Task 5 的产出是 schema cutover 与规则投影，`generatePendingScene.ts` 就在本 Task 的 Modify 列表里，所以它能证明“v9 存档在真实多回合推进与结局判定下不崩”；但它**证明不了** `outlineUpdate` 修订协议在生产 bundle 上跑通，那要等 Task 6/10。**仓库里没有任何短篇（3 幕）端到端通关测试**，所以本 Step 不得声称“短/中篇仍能结束”；短篇闭环要到 Task 10 才第一次建立，届时再回填这条断言。旧 v8 返回 UNSUPPORTED_RECORD，坏缓存/未来引用/错 kind 绑定稳定拒绝；CAS stale 零写入。
- [ ] **Step 5 — Commit** `git add src/game/domain src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/storyOutline src/game/application && git commit -m "feat(outline): persist v9 causal outline state atomically"`。

### Task 6: 在同一个生成包内接入 opening seed 与 decision 修订

**Files:** Modify `src/game/domain/narrativeBundle.ts` 与测试；Modify `src/game/application/{createGame,generatePendingNarrativeBundle,approveNarrativeBundle}.ts` 与各自的 `.test.ts`（三个测试文件都已核实存在）；Modify `src/game/application/narrativeBundleSource.ts`——**它没有同名测试文件**，它的类型改动由上面三个测试与 `liveNarrativeBundleSource.test.ts` 间接覆盖，不要新建空壳测试；Create `prepareNarrativeBundleCommit.ts` 与测试；Modify `src/game/application/server/ai/liveNarrativeBundleSource.ts` 与测试。

Modify `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts` 及测试与其调用点，传入已批准 outlineSeed；Create `src/game/application/outlineEvidenceWindow.ts` 与测试，供本 Task 和 Task7 共用生成前证据白名单。

关于 fixture，已核实的现状与“opening/decision 各有一份 response fixture”的直觉不符：

- **opening 侧**唯一的 offline fixture 是 `createGame.ts:639` 的 `createFixtureOpeningSource()`（`createGame.ts` 已在 Modify 列表里），它内部复用 `:450` 的 `createFixtureOpeningCandidateSource()`。`outlineSeed` 就加在这一处，不需要再找别的文件。
- **decision 侧没有任何 fixture 源**。全仓只有 `liveNarrativeBundleSource.test.ts` 与 `generatePendingNarrativeBundle.test.ts` 在自己的测试文件里就地构造 decision proposal。所以 `outlineUpdate` 的 offline 用例要在这两个测试文件内就地构造，**不要**去 `src/game/application/testing/` 下找一个并不存在的 decision fixture。
- `src/game/application/testing/foundationJourney.testutil.ts` 用的是 `createDeterministicSceneSource()`（`SceneSource` 协议，见 §0 新增那行），与 `NarrativeBundleSource` 不同协议。本 Task **不需要**改它；它要动也是 Task 5（legacy 链同步 outline）或 Task 10（新 journey 自带 testutil）的事。

同时 Modify `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`，并 Create `narrativeBundleContext.test.ts`：新的必填字段、符号/证据白名单和基本输出合同必须与 parser 同批接入。该测试只检查 decision 的 bundle:output-contract（outlineUpdate、baseRevision、白名单、null），opening 的 outlineSeed 合同在 liveNarrativeBundleSource.test.ts 检查实际 opening 请求；不能要求 decision block 输出 opening 字段。Task7 在同一测试文件追加预算断言。

**Interfaces:** `OpeningNarrativeBundleProposal.outlineSeed: OutlineSeedProposal`；`NarrativeBundleProposal.outlineUpdate: OutlineRevisionProposal|null`。两个类型不在同一个文件：`NarrativeBundleProposal` 在 `domain/narrativeBundle.ts:88-93`（四个键 `worldDelta/currentScene/continuationScenes/terminal`），而 `OpeningNarrativeBundleProposal` 在 **`application/narrativeBundleSource.ts:54-59`**，不在 domain。Produces：

```ts
type PreparedNarrativeBundleCommit = Readonly<{ nextWorldState: WorldState; nextStoryState: StoryState }>;
prepareNarrativeBundleCommit(input: Readonly<{
  approved: ApprovedNarrativeBundle; outlineUpdate: OutlineRevisionProposal | null;
  worldState: WorldState; storyState: StoryState; job: PendingNarrativeJob; committedAt: string;
}>): OutlineResult<PreparedNarrativeBundleCommit>;
buildOutlineEvidenceWindow(input: Readonly<{
  worldState: WorldState; outline: LivingOutlineState; job: PendingNarrativeJob;
  relatedThreadIds: readonly StoryThreadId[];
}>): readonly EventId[];
```

`ApprovedNarrativeBundle`（`approveNarrativeBundle.ts:65-73`，现有 7 个字段：`nextWorldState/nextStoryStatePreview/currentScene/choiceRegistry/bundle/candidateEventPool/eventDrafts`）同时新增只读 `symbolBindings: ReadonlyMap<string, EntityId>`。

已核实的落点，别再去猜：

- `approvedDelta` 不是 `ApprovedNarrativeBundle` 的字段，而是 `approveNarrativeBundle.ts:553` 的局部 `let approvedDelta: ApprovedWorldDelta | undefined`，在 `:590` 由 `materializeWorldDelta(...)` 赋值，并且**只有 `proposal.worldDelta !== null` 时才有值**。所以 `proposal.worldDelta === null` 时必须返回空 Map，不能读 `undefined` 上的属性。
- 该文件 `:60` 的头注释已经写了 “resolve symbols → approve scenes”，但**文件里没有任何符号解析代码**（全仓也搜不到 `resolveSymbol`）。这条注释是历史遗留的意图声明，不是可复用 helper 的线索。
- 六个 `minted*Ids` 的基数已在 `approveWorldDelta.ts:1037-1041` 核实：每种要么是 `[]` 要么是 `[单个 ID]`，因此 `minted*Ids[0]` 的写法成立，不需要循环、也不需要处理歧义。唯一例外是 `mintedEndingIds: ids.endingIds`（trust/doubt 一对，可能长度 2），它不在 `@new.*` 六种之内，不要顺手把它塞进映射。
- 按 `@new.location/npc/item/enemy/fact/quest` 与对应 `minted*Ids[0]` 建立封闭映射，缺失的种类不入表，再返回副本。不在下一层凭实体名称推导，不把 Map 写进存档。

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
- [ ] **Step 3 — 接入独立子协议，保留原生成/重试矩阵。** 四个 exact-key/normalizer 落点已核实，逐个改，不要新写第五份：

| 位置 | 现状 | 本 Task 要做的事 |
|---|---|---|
| `domain/narrativeBundle.ts:325-327` | `parseNarrativeBundleProposal` 用 `hasOnlyKeys(value, ["worldDelta","currentScene","continuationScenes","terminal"])` | 加 `"outlineUpdate"`，并在下面补 `null` 或合法提案的校验分支 |
| `application/narrativeBundleSource.ts:54-59` | `OpeningNarrativeBundleProposal` 四字段 | 加 `outlineSeed: OutlineSeedProposal` |
| `liveNarrativeBundleSource.ts:388-392` | `parseOpeningBundleProposal` 的 `allowedResponseKeys = new Set(["opening","currentScene","continuationScenes","terminal"])` | 加 `"outlineSeed"` |
| `liveNarrativeBundleSource.ts:128-208` / `:233` | `normalizeOpeningCandidateShape(value, targetActs: 3\|5)` 与 `normalizeDecisionBundleShape` | 透传新字段；normalizer 不丢字段、不合成缺失字段 |

两个新字段的校验委托 **Task4** 的 parser：decision 非 null 的 outlineUpdate 调 parseOutlineRevisionProposal，opening 的 outlineSeed 调 parseOutlineSeedProposal；未知字段、缺字段和非法内容拒绝整包。createGame 对可注入 source 的结果也必须检查 outlineSeed，不能只依赖 live source 的 parser。

特别补齐 `parseOpeningBundleProposal` 内部复用 decision parser 的适配：它当前构造 `{worldDelta:null,currentScene,continuationScenes,terminal}` 传给 parseNarrativeBundleProposal；新增必填字段后，这个内部对象必须显式加 `outlineUpdate:null`，否则所有合法 opening 都会因缺字段失败。这是服务端 opening→scene 校验适配，不是给 provider 缺失的 decision 字段补默认值。对正常 opening、缺 outlineSeed、缺 decision outlineUpdate 分别写回归测试。

显式 offline fixture 添加规则 seed 或 null。opening 合同修改 liveNarrativeBundleSource 的 buildOpeningPrompt；decision 合同修改 narrativeBundleContext 的 bundle:output-contract。opening 编译时将批准的 outlineSeed 随 candidate 一起传入 compileOpeningGenerationCandidate（在该 gameplay 输入新增 outlineSeed，Task5 的规则 seed 保留在调用方），以真实 Contract 创建 outline，最后在 initialization ledger 上 reconcile 后才保存 ready world/scene。开局原有最多 3 次尝试、decision 最多 4 次尝试均保持；不增加第二次开局调用。

记录但不在本 Task 扩展的既有边界：live opening 对非 medium 取 3，fixture candidate 对非 short 取 5；short/medium 一致，long/open 占位路径不一致。本文不开放 long/open，也不新增未定义的“统一常量”或修改全局预算；新增 outline 的生产测试只覆盖正式支持的两档，并验证 Contract.targetActs、StoryState.targetActs 与初始 chapter 数一致。统一长篇档位属于 Plan8。

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

随后调用 Task3 的 selectOutlineWindow，并用 buildOutlineEvidenceWindow 构造 AI 可以直接引用的证据白名单：本 job.domainEventIds、它们的直接原因，以及选中 Thread 已存在的 opening/supporting Event；去重、过滤为 ledger 中真实 ID 后按 sequence 排序。Prompt 与审批共用此函数及同一份生成前 outline/window，不在各处另写选取规则。

本次 worldDelta 的 blueprint_expanded 是服务器在响应之后才铸造的，不能要求 provider 提前填写未知 Event ID。它仅供服务端核实 @new.* 绑定来源并填入 ApprovedOutlineOperation.bind_slot.sourceEventId，不自动扩张 provider 的 sourceEventIds 白名单。symbolBindings 直接读取 input.approved.symbolBindings，不在 prepare 层访问不可见的 approvedDelta 局部变量。approval 非 null revision 成功才追加；prepare 返回 ready narrative + final memory + final outline，不调用 repository。

将此准备步骤放进 `runBoundedAttempts` 的 runAttempt：world/scene 或 outline 任一个失败都进入现有 repair。bounded 成功值改为 PreparedNarrativeBundleCommit；循环之后不再重复 commitEventDrafts/reconcile，直接一次 `repository.applyState`。

两个 union 别混（都在 `application/narrativeBundleSource.ts`）：

- `NarrativeBundleRejection`（`:30-44`）**增加** `outline_revision_rejected`。它是 `ApproveNarrativeBundleResult.code` 的类型（`approveNarrativeBundle.ts:79`），所以加在这里会自动流到审批失败分支。
- `NarrativeBundleRepairReason`（`:23-28`）**保持不变**。`generatePendingNarrativeBundle.ts:136-147` 的审批失败分支现在硬编码 `reason: "approval_rejected"` 并把 `approvalResult.code` 放进 `rejectionCode`；outline 失败必须沿用这条既有路径，不要为它新增一个 repair reason，否则现有四次重试矩阵和 `providerTriggerMatrix.test.ts` 的期望都要重写。
- `NarrativeBundleRepair.attempt` 是字面量类型 `1`（`:47`），不是 `number`；`detail` 只传 `OutlineErrorCode:path`，不回传私密正文。

- [ ] **Step 4 — Run** source/parser/approval/retry/createGame tests＋typecheck。锁定 initialization=1 logical generation，decision=1 logical generation；outline 失败无部分 world/scene 写入；同 job 重试无重复 revision；stale CAS 不写任何 revision。failed persist 本身按已有规则允许一次状态提交，不把它误算为剧情成功。
- [ ] **Step 5 — Commit** `git add src/game/domain/narrativeBundle* src/game/application src/game/gameplay/rpg/openingGeneration && git commit -m "feat(outline): carry atomic planning revisions in narrative bundles"`。

### Task 7: 安全上下文投影与酒馆式定向注入

**Files:** Create `src/game/application/outlineContextProjection.ts` 与测试；Create `src/game/application/server/ai/narrativeContext/outlineNarrativeContext.ts` 与测试；Modify `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts` 与 `narrativeBundleContext.test.ts`——注意这个测试文件**在今天的仓库里不存在**：已核实同目录 `compileNarrativeContext` / `renderNarrativeContext` / `sceneNarrativeContext` / `worldNarrativeContext` 四个兄弟模块都有同名测试，唯独 `narrativeBundleContext.ts` 没有，全仓也没有任何测试 import 它或 `compileDecisionNarrativeContext`。它由 **Task 6 创建**（只放输出合同断言），本 Task 在同一文件里**追加** Step 4 的预算与降级断言（8k 预算不变、mandatory overflow 可观察、低优先级 Thread 独立 dropped）。别把这些塞进 `compileNarrativeContext.test.ts`——那测的是通用 compiler，拿不到 bundle 的真实块集合；也别另建第二份 bundle context 测试。同时 Modify 同目录 `index.ts`：它是 `export * from "./<module>"` 的 barrel（现有 7 行），新增的 `outlineNarrativeContext` 要么加一行导出，要么由 `narrativeBundleContext.ts` 直接同目录相对导入——`liveNarrativeBundleSource.ts:21` 是经 barrel `./narrativeContext` 导入的，别改成深导入。

**明确非目标（已核实，不要去改）：** `sceneNarrativeContext.ts`、`worldNarrativeContext.ts`、`sceneGenerationContext.ts` 都不在生产 AI 路径上，本 Task 不修改它们。证据链：`compositionRoot.ts:241` 只装配一个源 `createNarrativeBundleSourceFactory(env, logger, aiClient)`，在 `:257` 与 `:452` 使用；`sourceFactory.ts:56` 的 `createSceneSource` 与 `:86` 的 `createWorldEvolutionSource` 全仓只被 `sourceFactory.test.ts` 以 `{} as never` 调用过，没有任何生产装配点；`liveNarrativeBundleSource.ts:21` 只 import `compileDecisionNarrativeContext`。所以 `compileSceneNarrativeContext → sceneNarrativeContext → sceneGenerationContext` 与 `compileWorldNarrativeContext → worldNarrativeContext` 两条链在生产不可达，往它们里面塞 outline 卡片既不会被任何真实 prompt 消费，也会让本 Task 的 8k 预算断言失去意义。`narrativeContext/index.ts:6-7` 仍然 re-export 这两份，保持原样即可。

同一事实对 Task 6 的约束：`liveNarrativeBundleSource.ts:441` 是 `const prompt = decisionCompilation?.prompt ?? buildOpeningPrompt(...)`——**decision 走块编译器，opening 走 `:51` 起的裸模板字符串**。因此 opening 的 `outlineSeed` 输出合同要加在 `buildOpeningPrompt` 的模板里，不是加在 `narrativeBundleContext.ts` 的某个 block；只有 decision 的 `outlineUpdate` 合同才进 `bundle:output-contract` 块。别把两边写成同一处。

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

同一 `outlineContextProjection.ts` 导出稳定异常供现有同步 compiler 入口向 live source 传递错误，不改变通用 compiler：

```ts
export class OutlineContextProjectionError extends Error {
  constructor(readonly failure: Extract<OutlineResult<never>, { ok: false }>) {
    super(`${failure.code}:${failure.path}`);
  }
}
```

因此本 Task 同时 Modify `liveNarrativeBundleSource.ts` 与测试：识别这个异常，返回 invalid_schema 与稳定 detail，发生在 aiClient.complete 之前；不把它当作成功的空 outline。

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

这段 map 就是 Interfaces 里 `buildOutlineNarrativeContextBlocks` 的实现体，别另起一个名字。它能直接通过 `NarrativeContextBlock`（`contextBlock.ts:9-19`）的类型检查：必填的 `id/slot/title/content/authority/retention/priority/source` 全都给到了，`source` 是 `Readonly<{ kind: string; refs: readonly string[] }>`——`kind` 是开放 `string`，所以 `"living_outline"` 不需要改任何 union；可选的 `conflictKey` 按下面一段刻意不传。`slot: "director_guidance"` 也已在 `NarrativeContextSlot`（`contextBlock.ts:3-7`）与 `NARRATIVE_CONTEXT_SLOT_ORDER`（`:67-72`）里存在，**不要新增 slot**——新增就得同步改那个顺序数组和所有排序测试，收益为零。

唯一的生产接线点，已核实：`narrativeBundleContext.ts` 的 `buildDecisionNarrativeContextBlocks(input: DecisionNarrativeContextInput)`（`:201-435`）。它在 `:278` 起构造 `const blocks: NarrativeContextBlock[] = [...]`，在 `:428-432` 追加一跳实体块，`:434` `return blocks`。把 outline 块 push 进这同一个数组（位置在 `bundle:director-guidance` 之后即可，最终顺序由 compiler 按 slot→priority 排，不靠数组下标）。它的唯一调用方是同文件 `compileDecisionNarrativeContext`（`:437-444`），后者把数组交给 `compileNarrativeContext({ maxEstimatedTokens: NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS, blocks })`——预算裁剪在那里发生，本 Task 不需要自己写裁剪。

不需要给 buildDecisionNarrativeContextBlocks 加参数，直接使用 input 的 worldState/storyState/job。**预算耗尽不是投影失败**：合法 outline 达到修订上限时返回 ok:true，保留当前根/线程卡，把 availableOperationKinds 置空并声明 outlineUpdate=null；optional token 裁剪仍由 compiler 负责。坏引用、循环、无法重建等 ok:false 必须显式失败，不能吞掉损坏状态继续生成。

```ts
const projection = buildOutlineContextProjection({ worldState, storyState, job });
if (!projection.ok) throw new OutlineContextProjectionError(projection);
blocks.push(...buildOutlineNarrativeContextBlocks(projection.value));
```

预算常量是 `narrativeBundleContext.ts:29` 的 `NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS = 8_000`，本 Task 不改它。优先级必须落进现有梯度里，下面是已核实的邻居：`bundle:story-contract` plan/mandatory **850**（`:293`）、`bundle:director-guidance` plan/mandatory **825**（`:349`）、episodic memory memory/optional **700**（`:396`）、recent scenes memory/optional **680**（`:404`）、lore optional **500**（`:287`）。据此定：

| 卡片 | retention | priority | 理由 |
|---|---|---|---|
| 当前根＋当前 Arc 链（合并一张，最多 900 字） | mandatory | **820** | 低于导演/风格 825，高于一切 optional；plan 权威不该压过当前 state |
| Thread（每条一张，最多 6 张） | optional | **760..755** | 高于 episodic memory 700，逐条独立可裁 |
| 下一 chapter direction | optional | **730** | 仍高于 memory，但让位给未决 Thread |
| 历史 milestone（最多 4 条合并） | optional | **710** | 在新增的 outline optional 卡中最先被丢；现有 memory 700/recent scenes 680/lore 500 更低 |

每张卡独立进入 compiler，使预算不足时可以逐条裁，不把六条 Thread 合并成一个“全选或全丢”大块。当前事实块仍比 plan 权威高。

关于 conflictKey：现有 bundle 块没有设置它，outline 不新增同义 key。相同 key 的真正冲突由 authority 决胜，state 高于 plan，因此不是“plan 会吃掉 state”；风险是把整张计划卡错误当成同一事实丢弃。无冲突 key 时，optional 选择按 priority→authority→slot→id，最终展示按 slot→priority→id，不能称为 authority 优先预算。投影必须明确计划/历史不是当前位置事实，不依靠 compiler 理解 prose 冲突，也不禁止合法的未来地点意图。

Thread 卡显示 question、状态、age、允许公开的实体/Fact ID、最多 3 个证据 ID；Fact 正文仍由既有安全 fact cards 提供。slot 显示“需要某类角色/地点”，不变成 NPC 可知信息，不自动添加到正文允许引用集。非焦点 NPC 的历史不因关联同一 thread 就全部注入。

卡片集合不要自己重新算一遍范围，`buildOutlineContextProjection` 内部同样调 Task 3 的 `selectOutlineWindow`，§2.3 的 Context 上限与 `OutlineWindow` 字段是一一对应的：

| §2.3 上限 | 取自 | 卡片 |
|---|---|---|
| 当前 Arc 链最多 4 | `activeArcIds`（截前 4） | 与根 Arc 合并成那张 mandatory 820 卡 |
| 相关 Thread 6 | `threadIds`（截前 6） | 每条一张 optional 760..755 |
| 下一 chapter 1 | `nextArcId`（可为 null） | optional 730，null 时不产卡 |
| 历史里程碑 4 | `historicalMilestoneIds`（截前 4） | 合并一张 optional 710 |
| 未绑定 slots 最多 4 | `unboundSlotIds`（截前 4） | 并入下一 chapter 卡，只写“需要某类角色/地点” |

`allowedArcIds` 为 current/next chapter（Quest/Sequence 不可编辑，revise_future_arc 仍只准下一 chapter）；`allowedEventIds` 来自 Task6 的 buildOutlineEvidenceWindow；`availableOperationKinds` 是实际阶段/预算允许的操作子集。输出合同与 server 审批共用这些权限。服务端响应后铸造的世界增量 Event 只作为内部绑定证明，不冒充生成前给过 provider 的白名单。

将全量 outline/revisions 留在 server；manifest 仅 ID/slot/预算/来源，UI 不收到远期方向和隐藏槽位。本 Task 只改 decision 路径：decision prompt 给本轮允许操作、baseRevision、sourceEventIds 白名单及 `null` 语义。opening 的 seed 输出合同属于 Task 6，且落在 `buildOpeningPrompt` 的模板字符串里，不在这里。**不要**让 `sceneNarrativeContext.ts` / `worldNarrativeContext.ts` 去读 outline——按 Files 一节的非目标，那两条链生产不可达，给它们加读取只会制造无人消费的分支和额外的维护面。

- [ ] **Step 4 — Run** targeted＋liveNarrativeBundleSource＋boundaries＋typecheck。断言 8k 预算不变、mandatory overflow 可观察、低优先级 Thread 独立 dropped、当前地点覆盖旧 Arc 位置、未授权 Event 引用不变成 NPC usedEventIds 许可。另分开验证“合法修订额度耗尽仍生成、outlineUpdate=null”和“损坏 outline 显式失败、aiClient.complete 调用 0 次”，不能用同一 fallback 通过两者。
- [ ] **Step 5 — Commit** `git add src/game/application && git commit -m "feat(outline): compile bounded plan and thread context cards"`。

### Task 8: 主线线程、结局与战斗回滚接线收口

**Files:** Modify `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts` 与测试；**只加测试、不改生产代码**：`src/game/gameplay/rpg/ruleEngine/resolveEnding.ts`（`resolveEnding.test.ts`）；Modify `src/game/domain/storyState.ts` 与测试；Modify `src/game/application/{performTurn,performBattleRound,stateCommit}.ts` 与各自的 `.test.ts`；Modify `src/game/application/consumeNarrativeBundle.ts`（**这个文件没有同名测试，全仓只有 `performTurn.ts` 与 `performBattleRound.ts` 导入它**，所以它的 outline 行为通过那两个 `.test.ts` 间接断言，不要去找 `consumeNarrativeBundle.test.ts`，也不要为它新建一个空壳测试文件）；Modify `src/game/gameplay/rpg/storyOutline/outlineProgress.ts` 与测试。

`resolveEnding.ts` 全文 76 行，已核实**从不读取 `unresolvedThreads`**：入口守卫 `:31` 只有 `!ss.endingAllowed || ws.ending !== null`，主题选择来自 `themeFromRequirements`（`:22-28`，看 ending 的 `npc_affinity_at_least/at_most`）与 `ws.npcs.at(-1)?.memory.interactionHistory.at(-1)?.dialogueAct`（`:37-39`）。所以“不扫描可选 Thread”已经是现状，不需要改它；本 Task 对它的产出是一条**回归测试**，把这个既有性质钉住，防止将来有人往里加线程扫描。

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
- [ ] **Step 3 — 去掉第二份线程生命周期写入，保持游戏完成条件。** `advanceStoryProgression` 保留主 Quest、stage、storyProgress 和 evolution 规则。

先看现状（`advanceStoryProgression.ts`，逐行核实）。线程的选取**不是随机的**，`:14-16` 是确定性的首个非 undefined 元素：

```ts
function mainThreadId(ss: StoryState): string {
  return ss.unresolvedThreads.find((t) => t !== undefined) ?? "main_thread";
}
```

回收发生在 `:67-69`，与 `:81-91` 的 endingAllowed 判断在**同一次调用内**、且回收在前：

```ts
if (currentAct >= ss.targetActs && currentActMainQuestExists && mainQuestsResolved) {
  unresolvedThreads = unresolvedThreads.filter((t) => t !== thread);
}
// ...
if (
  currentAct >= ss.targetActs
  && currentActMainQuestExists
  && mainQuestsResolved
  && storyProgress >= 80
  && unresolvedThreads.length === 0   // ← 本 Task 要删掉的这一条
) { endingAllowed = true; } else { endingAllowed = false; }
```

本 Task 把它换成：

```ts
const endingAllowed = currentAct >= ss.targetActs
  && currentActMainQuestExists && mainQuestsResolved && storyProgress >= 80;
```

删掉该守卫的原因是消除循环依赖：Task5 后数组只可能为 [] 或 [thread:main]，可选 Thread 根本不在其中，不能再声称“任意 AI 可选线程会锁住这个数组”。当 mainline_ready 读取规则 endingAllowed，而旧数组又作为 endingAllowed 的前置条件时，会产生“等大纲关闭主线才能结束、等允许结束才能关闭主线”的死锁。Task8 删除局部 mainThreadId/回收逻辑及数组守卫，规则只按原有幕、Quest、progress 判定；正常主线的结束时点保持不变。

Task8 后主线通过 mainline_ready 派生为 resolved，不是 retire_thread（后者始终禁止操作主线）。在最终 ledger 同次 reconcile，凡规则结束门槛成立，该次已提交状态必须 endingAllowed=true、兼容数组=[]；门槛不成立则不能仅凭预创建/已完成的终幕任务提前关闭主线。大纲晚更新属于一致性错误，不是允许更改原游戏结束时点的理由。

`resolveEnding` 依赖规则 endingAllowed/requirements/立场，不扫描可选 Thread（见 Files：这条已是现状，只加回归测试）。reconcile 后 `unresolvedThreads=projectUnresolvedMainThreadIds(outline)`，成为只读兼容投影；主线 Thread 使用规则 mainline_ready，最终 campaign 使用 ending_reached。`derivePacingNeed` 不能把可选 Thread 未完成当成永不收束的理由——注意 `storyState.ts:137` 现有分支 `if (ss.endingAllowed && ss.unresolvedThreads.length === 0) return "resolve"` 也读这个数组，删守卫后它仍然成立，因为数组里只剩主线。

顺带记录一个已核实的读写不对称，改这段代码时别被它误导：`allMainQuestsResolved`（`:38`）与 `shouldAdvanceAct`（`:32`）都接受 `status === "failed"`，`resolveEnding.ts:15` 的 `quest_failed` requirement 也读它，但**生产没有任何写入方会把 Quest 置为 `"failed"`**（`reconcileQuests.ts` 只写 `completed` 与 `closed`）。同时 `storyProgress` 的 `:75` 只统计 `completed | failed`，**不含 `closed`**——所以一个被 `closed` 的主线 Quest 会满足 `allMainQuestsResolved` 却不推进 storyProgress，可能让 `storyProgress >= 80` 永不成立。这是既有行为，本 Task 不改它，但写 endingAllowed 测试时要知道这条路径存在，别把测试 fixture 建成 `closed` 然后奇怪为什么进度不动。

检查 active battle fast path：目前它保留 beforeStoryState 而提交新 battle ledger；stateCommit 在最终 ledger 重建 outline。胜利后照常消费批准 bundle，更新 evidence；失败先整体恢复 checkpoint.storySnapshot，再 reconcile 恢复后的 ledger，不能用战中 outline 作为初始定义/修订来源。修订只在白名单 decision 发生，战斗期间不新建 revision。

- [ ] **Step 4 — Run** targeted＋现有 journey＋typecheck。npcContinuityJourney 证明 legacy 中篇规则可达性，不证明生产 bundle 修订，也不证明短篇闭环。advanceStoryProgression.test.ts 只断言原规则结束门槛不再依赖兼容数组；performTurn/performBattleRound 的测试验证最终 CAS 中 endingAllowed、主线 resolved、unresolvedThreads=[] 与 nextPacingNeed=resolve 对齐。另测“终幕 Quest 已完成但仍有其他主线 active”“currentAct 尚未终幕”“progress 不达门槛”时不能关闭主线，以及可选 Thread 不挡结局、预创建不能跳过战斗、战败重赛不留下败局证据。Task10 再用完整生产 bundle 旅程证明相同性能与可达性边界。
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
- [ ] **Step 3 — 补齐真实边界需要的分支。** “ensure 普通观察不重跑 failed”**已经实现，只需断言、不要重写**：`compositionRoot.ts:243-254` 的 `BackgroundEnsureCoordinator.loadPending` 在 `:248` 对 `provider_failed` 直接返回 `{ ok: false, result: "failed" }`，在 `:249` 对非 `provider_pending` 返回 `not_pending`，所以协调器不会重跑失败的 job。本 Task 的产出是一条覆盖 outline 拒因的测试，证明 outline 失败走的是同一条 `provider_failed` 路径、同样不被普通观察重跑；如果去改 `loadPending`，反而会破坏现有语义。其余需要真实补齐的分支：retry 使用同 jobId；重复成功 revision 零追加；同时有更新/序幕确认时保留 prologueShown 单调性。序列化前、读回、checkpoint 三处均拒绝错误 Event ID 和错误 predicate kind；不能仅检查 supportingEventIds 非空。

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
  rollbackProved: boolean; nestedTemplatesProved: boolean;
  recall: Readonly<{
    kind: "short_followup" | "long_gap";
    openingEventId: EventId; recalledAtTurn: number; gapTurns: number;
  }>;
}>;
runLivingOutlineJourney(input: Readonly<{ length: "short" | "medium"; stance: "support" | "challenge"; seed: string }>): Promise<LivingOutlineJourneyReport>;
```

- [ ] **Step 1 — 写失败测试。**

```ts
it.each(["short", "medium"] as const)("finishes %s through real bundle approvals and SQLite reload", async (length) => {
  const result = await runLivingOutlineJourney({ length, stance: "support", seed: "outline-stable" });
  expect(result.record.worldState.ending).not.toBeNull();
  expect(result.record.storyState.currentAct).toBe(length === "short" ? 3 : 5);
  expect(result.successfulTurns).toBeGreaterThanOrEqual(length === "short" ? 10 : 18);
  expect(result.reloads).toBeGreaterThanOrEqual(4);
  expect(result.linearProviderCalls).toBe(0);
  expect(result.rollbackProved && result.nestedTemplatesProved).toBe(true);
  expect(result.recall.kind).toBe(length === "short" ? "short_followup" : "long_gap");
  expect(result.recall.gapTurns).toBeGreaterThanOrEqual(length === "short" ? 1 : 12);
  expect(result.openingEventIds).toContain(result.recall.openingEventId);
});
```

回合下限的取值依据，不要凭空抬高：仓库里**唯一**已证明能打到结局的完整旅程是 `npcContinuityJourney.test.ts`，它是 `gameLength: "medium"`、5 幕，断言 `successfulRounds >= 18`（`:728`）、`currentAct === 5`（`:740`）。所以 medium 的下限取 **18**——与已验证基线齐平；short（3 幕）在仓库里没有任何通关基线，按幕数比例取 **10** 作为起点。

10/18 是本 Task 的初始验收目标，不是已证实的生产 Bundle 实测值。实施时记录实际回合数，并同时断言逐幕 Quest、移动/调查/物品、决策与战斗的真实覆盖；回合数不能替代这些行为证据。达不到目标时先排查 fixture、驱动器与游戏规则，不得为了变绿把阈值改成“实测值 − 1 或 − 2”，也不能注入空转或伪造结局凑数。确需修改验收目标时，应说明规则依据与覆盖不减的证据，作为显式计划变更复核。

- [ ] **Step 2 — Run** `npm test -- src/game/application/testing/livingOutlineJourney.test.ts`；Expected FAIL。
- [ ] **Step 3 — 实现 fixture 驱动器。** 不要从零写，两份现成模式各取一半：

- **临时 SQLite 生命周期**参考 `npcContinuityJourney.testutil.ts`：独占临时目录、SQLite client/repository、close/reopen 与 reloadCount 的模式。不能照搬“每 6 回合 reload 一次”后就声称短篇必有 4 次；两种篇幅均在开局后、首次 decision 审批后、首次战斗结果落库后、进入结局前设置四个实际 close/reopen 检查点，逐次深比较重载前后的 world/outline/revision。
- **加载与 issued action 选择**参考 `foundationJourney.testutil.ts` 的 view/record 加载、固定时间及 opaque choice 选择方式，但不要复用 `playIssuedChoice`/`playTurn`/`advanceScene` 或 `createJourneyEvolutionSource`：它们会接入 legacy source，不能证明生产 Bundle 链。本 Task 自建 issued action 驱动器，按生产依赖方式调用 `performTurn`，不注入 legacy SceneSource/WorldEvolutionSource；仅在 pending 时调用 `generatePendingNarrativeBundle`。`createJourneyGame` 也不能复用，它把 InMemoryRepo 和 opening-only source 写死；改为直接 `createGame({ gameId, gameType, gameLength, seed }, { repository, source, now, aiEnabled })`。

通过 `createGame` 建局，注入显式 deterministic `NarrativeBundleSource`；该测试源自身调用正式 parser 校验模拟响应（直接注入 typed source 不会自动经过 live source 的 parser），随后仍经过正式 approve/prepare/CAS。提交 `projectGameSessionView` 真正下发的 opaque choices/free text，不直接伪造 ending、修改 currentAct 或注入已完成 outline。

这个 deterministic source **必须自己写**，仓库里没有现成的，两个看起来最像的都不能用，别在它们上面浪费时间：

- `createFixtureOpeningSource()`（`createGame.ts:639`）确实是 `NarrativeBundleSource`，但 `:643` 对 `context.kind !== "opening"` 直接返回 `{ ok: false, failure: { kind: "AI_CALL_FAILED", phase: "scene" } }`——它只有开局能力，拿它跑 decision 会让每个回合都失败。
- `createDeterministicSceneSource()`（`deterministicSceneSource.ts:63`）是 **`SceneSource`**，签名是 `generateScene(context: SceneGenerationContext) → ScenePerformanceProposal`。decision 分支收到的是 `NarrativeBundleSourceContext` 的 `{ worldState, storyState, job, contentRepair }`（`narrativeBundleSource.ts:68-75`），要返回的是 `NarrativeBundleProposal`（`domain/narrativeBundle.ts:88-93`）。入参和返回类型两头都对不上，它内部的 `buildSegments(context)` 等 helper 也全部以 `SceneGenerationContext` 为参数，无法搬过来。

可复用的是**形状**，不是代码：`domain/narrativeBundle.test.ts` 里的 `makeValidScene()`（`:17`）、`makeValidBundle()`（`:36`）、`makeStep(stepKey)`（`:45`）已经是一份能通过 parser 的最小合法 bundle，但它们是模块私有、没有 export，所以照它们的字段结构在新 testutil 里重写一份，不要试图 import。要记牢的三个契约点：`BundleSceneProposal.choices` 是 `readonly { candidateId: string; label: string }[]`（不是 legacy 那套完整 choice 对象），`worldDelta` 允许直接是 `null`，`terminal` 只有三种封闭形状（`narrativeBundle.ts:69-73`：`next_decision→current_scene`、`next_decision→continuation_step{stepKey}`、`ending`）。Task 6 之后 `NarrativeBundleProposal` 还多了必填的 `outlineUpdate: OutlineRevisionProposal | null`，这个 source 每次都要显式给值——分叉断言靠的就是它，`revisedDirections` 只能来自这里返回的真实修订。

每个回合：读取 view → 选 issued action → performTurn → 仅 pending 时 generatePendingNarrativeBundle → 读取并验证结果。固定与自由输入都至少两次；包括真实移动、取物/赠物、调查揭示、战斗失败恢复和重赛胜利。人工配置 fixture 的敌人强度属于测试初始材料，不能在战斗进行到一半时改 HP 伪造失败。

至少一次 npc_free_text 回合的 fixture 响应提议并批准 player_choice 未来方向修订，来源为该 job 的真实 ask 交互 Event；同时验证它不能被当作 refuse 去放弃线程。离线 fixture 证明协议允许自由输入驱动方向，不声称证明模型已理解自然语言；后者由 Task11 真实 AI 验收确认。

最小源接口固定为 `createLivingOutlineJourneySource(input: Readonly<{ stance: "support" | "challenge" }>): NarrativeBundleSource`，实现开局和 decision 两个分支。以上 parser fixture 只提供 JSON 形状，不能直接当作审批可通过的运行内容：decision 必须从当前 job、真实候选动作、合法 worldDelta 预览及 continuation descriptor 图生成 beatId/candidateId/stepKey/terminal；对照生产审批做覆盖校验，不能凭空编 step 或把终点一律写 ending。所有 fixture/helper 留在 testing，禁止替换生产调用。

至少一次拒绝/支持导致下一 chapter direction 不同。两次运行比较的是**分叉动作发生前**共同的 ledger/已完成节点前缀；分叉后的新 Event 本来就应不同。每条路线内部再断言已完成 Arc/Milestone 在后续修订中不被改写（Spec §3.4：可以改写未来，不能改写过去）。不同路线最终仍由规则立场得到两个结局方向。

长间隔回访的证明**分配给 medium**：第 2–4 个成功回合开启一条可选线索 Thread，间隔至少 12 个成功回合后回访相关 NPC/物品/地点，验证它进入实际选中的 plan/memory cards；此时当前位置/关系仍由 store authority 提供。short 验证至少间隔 1 个成功回合的后续承接，report.kind 为 short_followup；medium 为 long_gap。这里是测试分工，不是“三幕局不可能超过 12 回合”——10 是下限，并非上限。openingEventIds 指本测试 Thread 的真实开启证据（不是限定开局事件）；recall.openingEventId 必须在 ledger 中可查、属于该 Thread，gapTurns 由开启与召回计数相减，不能手填布尔值代替证据。

分叉断言必须显式满足结局立场来源：`resolveEnding.ts` 读取 `ws.npcs.at(-1)?.memory.interactionHistory.at(-1)?.dialogueAct`，support/challenge 用于挑选 trust/doubt 方向；当前自由输入转换走 ask，不直接提供这个立场。因此 fixture 在终幕对最后一个 NPC 下发并执行固定 support/challenge 选项，且不再创建改变 at(-1) 来源的新 NPC。不要声称“自由输入必定得到相同结局”：未命中显式立场时，代码先筛选满足 requirements 的结局，再作 ID 排序兜底，其他状态差异仍可能导致不同结果。DIALOGUE_ACTS 的帮助类名称为 offer，不是 offer_help。

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

**Files:** Create `docs/agent/层级大纲与剧情线程.md`（**该文件当前不存在**，按 `docs/agent/template.md` 编写职责、当前契约、必要流程、代码与验证入口和条件关联阅读；原位替换事实，不追加日期维护记录）；Modify `docs/agent/剧情连续性与结构化记忆.md`、`运行时AI导演与场景表演.md`、`世界动态具象化.md`、`战斗与结局.md`、`当前开发阶段.md`、`current-phase.json`（以上六个 Modify 目标均已核实存在）；Modify `docs/Agent文档索引.md`（登记新增系统）、`docs/策划文档/AI生成RPG_MVP.md`（玩家规则）；跨系统开发约束变化时才更新开发规范。阶段状态只修改 JSON，阶段 Markdown 只负责导航。

- [ ] **Step 1 — 更新已实现事实。** 写清 v9、规则执行游标与叙事 phase 区别、批准计划/事件/progress 三种来源、nullable revision 协议、单次 bundle CAS、slot visibility、可选线程不挡结局、战败完整恢复。不得把本 Plan 的结构功能标记描述为 Plan6 已实现的高潮/战斗导演算法。

关于 Spec §13 的离线指标，只写“输入已具备”，不要写成“指标已实现”：§13 列的 `Thread continuity`（长期未决线程被遗忘或无依据关闭的比例）与 `Arc pacing`（铺垫/升级/转折/高潮/收束是否有结构依据）在 Plan5 之后才第一次拥有可计算输入——`StoryThread.priority` 与 `openedByEventIds` 给出线程年龄与优先级，`OutlineProgress.arcs[].phaseIndex/phase` 与 `OutlineMilestone.function` 给出结构阶段依据。但**本 Plan 不新增任何指标计算、评分或报表代码**（`Context efficiency` 依赖的 selected/dropped manifest 已由既有 compiler 产出，也不需要改）。文档里把这两项标为“输入就绪、指标待 Plan6 之后”，标成已实现会让下一次复核找不到对应代码。
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
npm run handoff:check:docs
npm run handoff:check
```

`npm run phase:status` **不是门禁，不要拿它当验收项**：`scripts/checkHandoff.mjs` 在检查 failures 前对 statusOnly 直接退出 0。真正会失败的是 `handoff:check:docs`（校验阶段配置、入口文件、Plan 状态标记等机械约束，不验证所有文档的语义一致性）和 `handoff:check`（额外要求当前分支等于 config.targetBranch 且身处 git worktree）。后者必须在 phase 分支/worktree 里跑；在主工作区 main 上分支检查失败不是 Plan 的缺陷。同步将 current-phase.json.acceptanceCommands 的 phase:status 替换为这两条；phase:status 仅用于状态展示。`npm run accept` 是既有组合命令，但其末尾同样是不会失败的 phase:status，不能替代这里的 handoff 门禁。

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
| NAR-17 每阶段完整可玩 | 5、6、8、10、11 | optional Thread 不软锁；中篇到真实 ending 由既有 `npcContinuityJourney.test.ts` 在 Task 5/8 证明，**短篇（3 幕）端到端闭环在 Task 10 才第一次建立**——所以“短/中篇都到真实 ending”是整个 Plan 交付后的断言，不是 Task 5 或 Task 8 单独能声称的 |
| 一次生成逐步消费 | 6、8、9、10 | 无新增 provider、路线/战斗只消费批准图 |
| 关系/知识权限 | 2、4、7 | plan 不写组件、不扩大 NPC disclosure/usedEventIds |
| 过去/当前/未来分离 | 2、4、7 | 未绑定 slot 不算真实实体；预创建任务不算已经历 |
| CAS/重试/恢复 | 5、6、9 | 无半提交、重复 revision、未来引用或静默修复 |
| 记忆与酒馆式上下文策略 | 3、7、10 | 定向相关激活＋独立块预算＋无正文 manifest，而非聊天全文注入 |

执行前自检：本文所有新函数均在 Interfaces 或对应步骤中声明；后续代码不能创造第二套同义 helper；测试 fixture 必须建立真实 Entity/Event 闭包。

**完成界限：** Plan5 交付的是可运行、可持久化、可审批、能影响下一次生成的长期叙事计划系统；不是单独存一个大纲 JSON，也不是提前实现长篇或自动保证文学高潮。
