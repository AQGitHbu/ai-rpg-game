# Structured Events and Episodic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持一次玩家决策只触发一次剧情生成、已批准内容逐步消费、战斗失败恢复战前状态和短/中篇完整可玩的前提下，把当前弱类型 `GameEvent[]` 升级为带稳定身份、参与者、因果、显著度和来源回合的不可变事件账本；再从账本确定性派生可重建 Episode、近期场景记忆和结构化检索结果，使较早但相关的经历能进入下一幕 Prompt，而不注入完整账本或建立第二真相源。

**Architecture:** `WorldState.eventLedger` 继续是当前单记录存档中的权威历史，但元素改为 `CommittedNarrativeEvent` envelope，事件 payload 只描述已裁决事实，envelope 统一保存 `eventId/sequence/turnId/actionId/turnNumber/actorIds/targetIds/locationId/causeEventIds/factIds/questIds/outcome/salience/episodeId/committedAt`。规则层先产生封闭 `NarrativeEventDraft`，由一个纯 `commitEventDrafts` 入口铸造 ID、校验引用与因果并一次追加；任何 resolver、世界演化或场景写回都不能再直接拼接 ledger。`StoryState.memory` 保存可从完整 ledger 重建并校验的 `EpisodicMemoryState`，Episode 只含来源 Event ID、范围和结构化摘要 key；应用层按硬引用、任务/实体/地点、因果邻接、显著度和近期性稳定检索，再投影为 Context Compiler 的 `event` / `memory` 块。Entity 当前状态始终高于 Episode 历史描述。

**Tech Stack:** TypeScript 5.8、Vitest 3、Next.js 16、现有 domain → gameplay/rpg → application 分层、SQLite JSON/CAS 存档、Narrative Context Compiler、Entity Store v2 与 NPC 五层组件；不新增 npm 依赖、外部服务、向量数据库或 provider 调用。

**Spec:** `docs/superpowers/specs/2026-08-23-long-form-narrative-entity-memory-architecture.md`（Plan 4；§6、§10、§11.3；NAR-08、NAR-09、NAR-14、NAR-17）

> 状态：已实现并合入 main；2026-09-04 main 复核修复见 `docs/agent/剧情连续性与结构化记忆.md`。本轮复核为离线代码/测试验收，不代表重新完成真实 AI 游玩验收。

## Global Constraints

- 实施前完整读取 `docs/游戏设计原则.md`、`docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/剧情连续性与结构化记忆.md`、`docs/agent/NPC人格知识与关系图.md`、`docs/agent/实体与组件世界状态.md`、`docs/agent/运行时AI导演与场景表演.md`、`docs/agent/行动裁决.md`、`docs/agent/战斗与结局.md`、总 Spec 与本 Plan。
- 开始实现前确认 Plan 3 已在 `main` 验收，机器状态为 `completed / merged`，主工作区干净；再按本 Plan 的执行启动步骤创建 `.worktrees/structured-events-episodic-memory`，不用 `git checkout`。
- 本 Plan 只修改 `ai-rpg-game`。Event、Episode、NPC provenance 和 RPG memory retrieval 都有明确业务语义，不创建共享 package，不修改 foundation。
- 不增加 provider 调用。Event、Episode、检索索引和摘要全部由已提交规则事实确定性产生；AI 只能阅读经过投影的 memory cards，不能提议、改写、删除或总结权威历史。
- 不改变六个 `/api/game/**` 路由、玩家可见 Action、单次规则 CAS + 独立 scene CAS、ensure/retry 语义、Narrative Bundle 图或“一次生成、逐步消费”流程。
- 不改变战斗失败/撤退语义。战斗开始后产生的 Event、Episode、NPC event references 与场景记忆都必须随 `preBattleSnapshot` 一起回到战前；失败世界线不得泄漏到后续 Prompt。
- 不保存玩家自由输入原文、完整 narration、完整 NPC 台词、choice token、action key、完整 Prompt、模型原文或私密 Fact 正文到 Event/Episode。`PendingNarrativeJob.utterance` 仍是玩家原文唯一的有界暂存位置。
- Event envelope 是 append-only 权威事实；Episode、recent scenes、索引和摘要都是可重建 read model。普通运行时不得修改既有 Event；重建 memory 不得修改 ledger。
- 当前 Entity/Component 是“现在是什么”，Event 是“为何变成这样”，Episode 是“哪些已发生经历与当前场景相关”。冲突时 Entity 当前状态覆盖 Episode；Episode 不得把旧位置、旧关系 stage 或旧任务状态渲染成当前事实。
- 检索先做 Event ID、当前任务、实体、地点和因果的硬条件，再稳定排序；本 Plan 不引入 embeddings、语义向量、全文搜索服务或让 AI 自选记忆。
- 不实现 Living Outline、Arc、Milestone、Story Thread（Plan 5），不实现 Arc-aware scene planning（Plan 6），不实现分段 ledger、snapshot/cursor、归档、持久索引表或长局非线性加载（Plan 7），不开放十小时长篇（Plan 8）。
- 当前设计原则明确不把 misinformation 作为独立模型；本 Plan 只为 canonical Fact 与 NPC knowledge 增加 Event provenance，不新增自由文本命题、真假断言或 NPC 虚假信念系统。
- `WorldState.version` 在 Task 2 随 ledger schema 从 4 升到 5，`StoryState.version` 在 Task 5 随 memory schema 从 7 升到 8，`EntityStore.version` 保持 2。旧 v4/v7 开发存档返回 `UNSUPPORTED_RECORD`，不做隐式迁移、不静默重置；SQLite 表与 `GAME_RECORD_VERSION`（当前为 1）不变。版本常量分别在 `src/game/domain/worldState.ts:44` 的 `WORLD_STATE_SCHEMA_VERSION` 与 `src/game/domain/storyState.ts:14` 的 `STORY_STATE_SCHEMA_VERSION`；两个 domain classifier 必须覆盖全部已知旧版本（World 1..4 / Story 1..7），SQLite 不再维护第二份 legacy whitelist。
- 每个任务先写失败测试并运行 targeted tests；实现与同目录测试一起提交。每个任务的提交前必须额外跑 `npm run typecheck`。Task 1 只**增量引入**新 contract/helper，不切换 `WorldState.eventLedger`，因此可独立绿；真正把 `GameEvent` 换成 `CommittedNarrativeEvent` 的整仓类型收缩必须在 Task 2 一次完成，凡是 `readonly GameEvent[]` 形参、类型守卫、持久化 parser 和测试 fixture 都在该 Task 同步，不能把会导致 typecheck 失败的旧形状推迟到 Task 3/7/8。
- 计划中的 `rg` 扫描沿用仓库既往 Plan 的写法；若执行环境没有 ripgrep，用 `grep -rn <pattern> <path>` 等价替代，判定结果必须一致。
- 完整门禁和短/中篇 journey 通过前不得把阶段标为 `completed / merged`。

## 明确边界

- **包含：** committed Event envelope、稳定 ID/sequence/turn、参与实体、地点、因果、显著度、严格 ledger validator；可重建 Episode、近期场景记忆、NPC Event provenance、结构化检索与 Prompt 投影。
- **保持：** Entity Store v2、六个 API、玩家 Action、Narrative Bundle、单次规则 CAS + 独立 scene CAS、一次生成逐步消费、AI typed failure/manual retry 和战败恢复战前状态。
- **排除：** AI 直接写 Event/Episode、额外 memory summarizer 调用、完整 narration/台词/玩家原文长期保存、向量检索、全文搜索服务和通用 misinformation 命题。
- **排除：** Living Outline/Arc/Thread、Arc-aware scene planning、分段 ledger、snapshot/cursor、归档、持久索引表、十小时长篇开放，以及 foundation/共享 package 修改。
- **版本：** WorldState v5 / StoryState v8 是开发期破坏性升级，旧 v4/v7 明确 unsupported；EntityStore 保持 v2，SQLite 表与 record version 不变。

## Canonical Event Contract

Plan 4 最终只持久化以下 envelope；各 payload 的字段仍由封闭 discriminated union 定义，禁止万能 `Record<string, unknown>`：

```ts
type EventId = string & { readonly __eventId: unique symbol };
type EpisodeId = string & { readonly __episodeId: unique symbol };

type CommittedNarrativeEvent<P extends NarrativeEventPayload = NarrativeEventPayload> = Readonly<{
  eventId: EventId;
  sequence: number;                 // eventLedger 中从 0 开始且连续的稳定序号
  turnId: TurnId;                   // initialization 也有 server-authored TurnId
  actionId?: string;                // 仅真实玩家/规则行动事件存在
  turnNumber: number;               // StoryState 玩家回合号，不等于 sequence
  episodeId: EpisodeId;
  kind: P["type"];
  actorIds: readonly EntityId[];
  targetIds: readonly EntityId[];
  locationId: LocationId | null;
  causeEventIds: readonly EventId[]; // 只能指向较早 sequence，天然无环
  factIds: readonly FactId[];
  questIds: readonly QuestId[];
  outcome: "success" | "failure" | "mixed" | "neutral";
  salience: number;                 // 0..100 整数，规则表生成
  committedAt: string;              // 注入时钟；payload 不再重复 occurredAt
  payload: P;
}>;

type NarrativeEventDraft<P extends NarrativeEventPayload = NarrativeEventPayload> = Readonly<{
  eventKey: string;                 // 同一 source/turn 内唯一的 server-authored 语义键
  episodeKey: string;               // normal turn / battleKey / initialization
  actorIds: readonly EntityId[];
  targetIds: readonly EntityId[];
  locationId: LocationId | null;
  causeKeys: readonly EventCauseKey[];
  factIds: readonly FactId[];
  questIds: readonly QuestId[];
  outcome: CommittedNarrativeEvent["outcome"];
  salience: number;
  payload: P;
}>;

type EventCauseKey =
  | Readonly<{ kind: "event_id"; eventId: EventId }>
  | Readonly<{ kind: "same_batch"; eventKey: string }>;
```

`narrative_scene_presented` 在新 payload union 中使用以下最小结构；地点与参与实体只放 envelope，避免同一索引在 payload/envelope 双写漂移：

```ts
type NarrativeScenePresentedPayload = Readonly<{
  type: "narrative_scene_presented";
  sceneId: string;
  focusNpcId: NpcId | null;
  pacing: StoryPacing;
  beatIds: readonly string[];
  revealedFactIds: readonly FactId[];
}>;
```

`RecentSceneMemory.locationId` 从 committed envelope 的 `locationId` 读取；`referencedEntityIds` 从 envelope 的 `actorIds + targetIds` 稳定去重得到。payload 不再重复 `locationId/referencedEntityIds/occurredAt`。

ID 规则必须纯且可重放：

- initialization：`eventIdFor(turnId, "game_initialized")`，`turnId = asTurnId("init:" + generationId)`；
- 玩家/规则回合：`eventIdFor(turnId, eventKey)`；`eventKey` 必须包含足够语义引用，例如 `fact_discovered:<factId>`、`relationship:<from>:<target>:<signal>`，不能依赖数组当前下标；
- scene/world write-back：复用 pending job 的 `turnId`，分别使用 `scene_presented:<sceneId>`、`world_expanded:<jobId>`；
- `sequence` 只表达最终提交顺序，不参与 Event ID；事件排序调整不会改写同一事实的 ID；
- `eventId` 与 `episodeId` 只由 domain helper 铸造，parser 只验证格式，不接受 provider/client 提交。

因果规则是封闭 policy，不让 AI 猜：

- 一个行动的 primary outcome 是同回合派生 NPC interaction、knowledge、relationship、quest 和 candidate activation 的直接原因；
- `quest_completed` 引用本轮满足目标的事件及账本中该任务最近的目标证据；
- `battle_round_resolved` 引用 `battle_started` 或上一回合，`battle_resolved` 引用最后一轮，`enemy_defeated` 引用胜利结算；
- `ending_reached` 引用终幕立场 interaction 与满足 requirement 的最近 Event；
- `blueprint_expanded`、`narrative_scene_presented` 引用 pending job 的 `domainEventIds`；
- 找不到可证明原因时保留空 `causeEventIds`，不得伪造或引用未来事件。

## Canonical Episodic Memory Contract

```ts
type NarrativeEpisode = Readonly<{
  episodeId: EpisodeId;
  kind: "initialization" | "turn" | "battle";
  fromSequence: number;
  toSequenceInclusive: number;
  fromTurn: number;
  toTurn: number;
  eventIds: readonly EventId[];
  participantEntityIds: readonly EntityId[];
  locationIds: readonly LocationId[];
  factIds: readonly FactId[];
  questIds: readonly QuestId[];
  causeEventIds: readonly EventId[];
  outcome: CommittedNarrativeEvent["outcome"];
  salience: number;
  summaryVersion: 1;                // 摘要格式版本；升版即可让旧 Episode 重算
  summaryKeys: readonly string[];   // 固定规则 key，不含 AI/玩家 prose
}>;

type RecentSceneMemory = Readonly<{
  sceneEventId: EventId;
  sceneId: string;
  turnNumber: number;
  locationId: LocationId;
  focusNpcId: NpcId | null;
  pacing: StoryPacing;
  beatIds: readonly string[];
  referencedEntityIds: readonly EntityId[];
  revealedFactIds: readonly FactId[];
}>;

type EpisodicMemoryState = Readonly<{
  version: 1;
  reducedThroughSequence: number; // 空账本为 -1，否则必须等于 ledger.length - 1
  episodes: readonly NarrativeEpisode[];
  recentScenes: readonly RecentSceneMemory[]; // 最近 8 幕，稳定裁剪
  npcContacts: readonly NpcContact[];
}>;
```

`NpcContact` 当前定义在 `src/game/domain/materializedView.ts`（字段：`npcId` / `lastContactTurn` / `lastLocationId`）。Task 5 删除 `materializedView.ts` 时把该类型原样迁入 `episodicMemory.ts`，字段不变。

- 默认 Episode 以 `turnId` 聚合；同一 `battleKey` 的 started/round/resolved/defeated 事件跨 battle action 聚合为一个 battle Episode；同一 pending job 的 world/scene 事件并回触发它的 turn Episode。
- Episode 的“未解决问题”只用 `questIds` + `factIds` 表达：Thread 级未决问题属于 Plan 5，本 Plan 的 Episode 不含 Thread 引用。
- Episode 可以被后续同组事件扩展，但其 `eventIds` 只能按 sequence 追加；reducer 以 Event ID 去重，重复归约零变化。
- `summaryKeys` 由 payload kind/outcome 固定映射，Prompt renderer 再用当前 Entity name/lifecycle 和公开 Fact 卡解释；Episode 本身不保存旧实体 prose。
- 每次 state/scene CAS 前调用同一个 `reconcileEpisodicMemory`；持久化读取对完整 ledger 重建并与保存的 memory deep-compare，漂移返回稳定 corrupt 分类。

## Retrieval Policy

`retrieveNarrativeMemory(query)` 只接收结构化引用：

```ts
type NarrativeMemoryQuery = Readonly<{
  beforeSequenceExclusive: number;
  requiredEventIds: readonly EventId[];
  focusEntityIds: readonly EntityId[];
  locationId?: LocationId;
  questIds: readonly QuestId[];
  factIds: readonly FactId[];
  causeEventIds: readonly EventId[];
  maxEpisodes: number;       // production 固定 6
  maxRecentScenes: number;   // production 固定 4
}>;
```

排序使用可测试 tuple，不用浮点相似度：

1. 命中 `requiredEventIds`；
2. 命中当前 quest/fact；
3. 命中 focus entity / 有向关系两端；
4. 与 current/cause Event 一跳因果相邻；
5. 命中 current location；
6. salience 降序；
7. `toSequenceInclusive` 降序；
8. `episodeId` 字典序。

只有至少命中 1–5 中一项的旧 Episode 才进入 relevant set；recent scenes 独立取最近 4 条。当前 pending job 的事件继续由 `current_resolution`/mandatory beats 表达，不重复作为“旧记忆”注入。

## Target File Structure

```text
src/game/domain/
├── events.ts                         # payload、EventId/EpisodeId、envelope、parser primitives
├── eventLedger.ts                    # draft commit、ID、sequence/causal/reference validator
├── eventLedger.test.ts
├── episodicMemory.ts                 # Episode/recent-scene reducer 与 rebuild validator
├── episodicMemory.test.ts
├── storyState.ts                     # v8 + memory
├── worldState.ts                     # v5 ledger
└── turnResolution.ts                 # committed domainEvents

src/game/gameplay/rpg/narrativeMemory/
├── eventPolicy.ts                    # kind → refs/outcome/salience/summary/causal policy
├── eventPolicy.test.ts
├── retrieveNarrativeMemory.ts
├── retrieveNarrativeMemory.test.ts
├── renderNarrativeMemory.ts
├── renderNarrativeMemory.test.ts
└── index.ts

src/game/application/
├── reconcileCommittedMemory.ts       # state/scene CAS 前唯一 memory reconciliation
├── reconcileCommittedMemory.test.ts
├── sceneGenerationContext.ts
├── npcSpeechAuthority.ts
└── testing/episodicMemoryJourney.test.ts

src/game/gameplay/rpg/openingGeneration/
├── compileOpeningGenerationCandidate.ts   # 生产开局世界 + 唯一 game_initialized 事件
└── compileOpeningGenerationCandidate.test.ts

src/dependencyBoundaries.test.ts           # Task 5 换掉 materializedView 锚点；Task 6 注册 narrativeMemory facade
```

`materializedView.ts` 在 Task 5 被 `episodicMemory.ts` 完整替代后删除；不保留并行 recent-beat reducer。

**注意：`src/game/domain/index.ts` 不在本 Plan 修改范围内。** 该文件是窄口 domain facade，注释已写明“Runtime internals use focused modules”，全仓生产代码没有任何 `from "@/game/domain"`（只有 `dependencyBoundaries.test.ts` 的合成片段），gameplay/application 一律深引 `@/game/domain/<module>`。Event 与 Episode 沿用同样的深引方式，不要往该 facade 塞导出。

---

## 执行启动（Task 1 前，只在 main 主工作区执行）

**Files:**

- Modify: `docs/agent/current-phase.json`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/Agent文档索引.md`

- [x] **Step 1: 确认 Plan 3 已在 main 完成并收尾**

Run:

```bash
git status --short --branch
npm run phase:status
git worktree list
```

Expected: 当前分支为干净 `main`；Plan 3 的实现与验收提交都在 main 历史中；不存在 Plan 3 worktree 或未合并分支；`phase:status` 已显示 Plan 4 `planned / not_started`。

- [x] **Step 2: 复核机器可读阶段已是 Plan 4 planned/not_started**

`docs/agent/current-phase.json` 必须保持：

```json
{
  "schemaVersion": 1,
  "phase": "structured-events-episodic-memory",
  "status": "planned",
  "implementationStatus": "not_started",
  "targetBranch": "codex/structured-events-episodic-memory",
  "worktreeName": "structured-events-episodic-memory",
  "repositories": ["ai-rpg-game"],
  "plan": "docs/superpowers/plans/2026-09-02-structured-events-episodic-memory.md",
  "sharedInfrastructureChangeAllowed": false,
  "startCommand": "npm run phase:start"
}
```

`entryDocs` 使用 Global Constraints 第一条列出的 canonical 文档；`acceptanceCommands` 使用 Task 10 的完整命令表。

- [x] **Step 3: 验证并提交阶段指针**

```bash
npm run handoff:check:docs
git add docs/agent/current-phase.json docs/agent/当前开发阶段.md docs/Agent文档索引.md docs/superpowers/plans/2026-09-02-structured-events-episodic-memory.md
git commit -m "docs(phase): plan structured events and episodic memory"
npm run phase:start
```

Expected: `.worktrees/structured-events-episodic-memory` 创建成功；进入 worktree 后 `npm run setup` 与 `npm run handoff:check` PASS。

---

### Task 1: 建立稳定 Event Envelope、ID 与严格账本校验

**Consumes:** 当前 `domain/events.ts` 的 payload union、`TurnId`、Entity ID 与 WorldState v4。  
**Produces:** committed envelope、纯 draft commit 和账本 invariant 的增量 contract；本 Task 不修改 `WorldState.eventLedger`，旧 `GameEvent` 只作为 Task 2 cutover 前的临时源码兼容名，不能传给新 commit/parser。
**Independent proof:** domain tests 不依赖 rule/application/DB，直接证明重放、顺序、因果与引用。

**Files:**

- Modify: `src/game/domain/events.ts`
- Modify: `src/game/domain/events.test.ts`
- Create: `src/game/domain/eventLedger.ts`
- Create: `src/game/domain/eventLedger.test.ts`

- [x] **Step 1: 写失败测试固定 envelope 和 exact payload shape**

覆盖：EventId/EpisodeId 格式；同 turnId + eventKey 重放得到相同 ID；不同 key 不撞 ID；sequence 从既有 ledger 长度连续追加；数组去重并按输入语义稳定；salience 非整数/越界、空 actor/target 元素、payload kind 不一致、未知 payload 字段全部拒绝。

- [x] **Step 2: 写失败测试固定 causal graph 与引用闭包**

覆盖：cause 只能通过 `event_id` 指向既有 ledger，或通过 `same_batch` 指向本批更早 draft；未知 cause、未来 cause、自因果、ledger 内重复 Event ID、sequence 缺口、重复 episode/event membership 拒绝；Entity/Fact/Quest/Location 引用必须存在于提交后的 Entity Store。同一批重复 eventKey 拒绝；若 draft 的稳定 ID 已在 ledger，只有 source/episode/metadata/payload（不比较本次新传入的 `committedAt`）与既有 Event 完全等价时才作为 retry 幂等返回既有映射且 `appended=[]`，任何差异返回 `EVENT_ID_CONFLICT`。

- [x] **Step 3: 增量定义 payload、draft 与 committed envelope**

`NarrativeEventPayload` 保留当前仍有生产语义的封闭变体，并新增三个规则事实 payload：

```ts
type NpcInteractionRecordedPayload = {
  type: "npc_interaction_recorded";
  npcId: NpcId;
  dialogueAct: DialogueAct | "freeform";
};
type NpcKnowledgeChangedPayload = {
  type: "npc_knowledge_changed";
  npcId: NpcId;
  factId: FactId;
  change: "learned" | "certainty_upgraded" | "disclosure_changed";
};
type NpcRelationshipChangedPayload = {
  type: "npc_relationship_changed";
  fromNpcId: NpcId;
  targetId: PlayerEntityId | NpcId;
  signal: RelationshipSignal;
};
```

新 `NarrativeEventPayload` 不含 `occurredAt`；时间只在 envelope。仍有生产路径的候选生命周期 payload 保留稳定 code/turn，不保存正文；`narrative_scene_presented` 使用 Canonical Event Contract 下方的最小结构。为保证本 Task 可独立 typecheck，现有 `GameEvent`/WorldState v4 暂不改名、不改形状，但 `commitEventDrafts` 与 `parseCommittedEventLedger` 的签名只接受新类型，测试必须证明 legacy payload 不能冒充 committed event。Task 2 完成整仓 cutover 后立刻删除旧 `GameEvent` 定义，不保留运行时双形状 parser。

同时收口当前 union 中与隐私约束冲突或没有 producer 的遗留变体：删除从未由生产代码构造的 `narrative_choice` / `narrative_dialogue_choice` payload（玩家实际选择的裁决结果已由本轮真实 domain Event + `actionId` 表达），不把 `choiceToken/actionKey/dialogueIntent` 搬进新 union。`candidate_event_proposed` 同样删除：当前 Narrative Bundle 固定返回空 candidate pool，旧 scene path 只保留已有池，没有“新候选入池”事实；v4 又明确 unsupported，因此既不保留只解析分支，也不在 Plan 4 偷增 provider/candidate 玩法。`player_intent_expressed` 不再保存 `Action.intent` 字符串，改成封闭 `intentCode: "unmapped_freeform" | "thread_complicates" | "thread_resolves"`；自由输入无论原文为何只写 `unmapped_freeform`，原文仍只在 `PendingNarrativeJob.utterance` 有界暂存。

- [x] **Step 4: 实现唯一 `commitEventDrafts`**

```ts
commitEventDrafts(input: {
  ledger: readonly CommittedNarrativeEvent[];
  drafts: readonly NarrativeEventDraft[];
  source: EventCommitSource;
  entityStore: EntityStore;
}): EventCommitResult
```

返回 `{ ok:true, appended, ledger, eventIdByKey }` 或稳定错误 union；不读时钟、DB、随机数。`EventCommitSource` 明确提供 turnId/actionId/turnNumber/committedAt，初始化 source 没有 actionId。

- [x] **Step 5: 运行并提交**

```bash
npm test -- src/game/domain/events.test.ts src/game/domain/eventLedger.test.ts
npm run typecheck
git add src/game/domain/events.ts src/game/domain/events.test.ts src/game/domain/eventLedger.ts src/game/domain/eventLedger.test.ts
git commit -m "feat(events): define committed narrative event ledger"
```

---

### Task 2: 整仓切换 Committed Event，并将规则回合迁移到单一 Commit Pipeline

**Consumes:** `WorldState.eventLedger`、全部 producer/consumer/parser/fixture、`resolveTurn` 与 Task 1 commit API。
**Produces:** 整仓不再存在 legacy `GameEvent` 账本形状；玩家/规则回合只产生 drafts，并在 `resolveTurn` 末尾一次铸造、追加和返回 committed events。
**Independent proof:** gameplay tests 证明所有成功回合有稳定事件、失败/blocked 零追加、同输入可重放。

**Files:**

- Modify: `src/game/domain/turnResolution.ts`
- Modify: `src/game/domain/turnResolution.test.ts`
- Modify: `src/game/domain/events.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/worldState.test.ts`
- Modify: `src/game/domain/materializedView.ts`
- Modify: `src/game/domain/materializedView.test.ts`
- Modify: `src/game/domain/testing/worldStateFixture.testutil.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveEnding.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveEnding.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.test.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/approveCandidateEvents.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/approveCandidateEvents.test.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.test.ts`
- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.ts`
- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.test.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts`
- Modify: `src/game/gameplay/rpg/narrativeContext/objectiveRules.ts`
- Modify: `src/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition.ts`
- Modify: `src/game/gameplay/rpg/narrativeContext/narrativeContext.testutil.ts`
- Create: `src/game/gameplay/rpg/narrativeMemory/eventPolicy.ts`
- Create: `src/game/gameplay/rpg/narrativeMemory/eventPolicy.test.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/createGame.test.ts`
- Modify: `src/game/application/consumeNarrativeBundle.ts`
- Modify: `src/game/application/consumePreparedContinuation.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/application/testing/investigationChoiceJourney.test.ts`

`narrativeContext.testutil.ts:81` 的 `INITIALIZED_LEDGER = [{ type: "game_initialized", generation: GENERATION }]` 是 `objectiveRules` / `deriveObjectiveTransition` / `updateStoryMetrics` 等测试共用的原始 payload 常量；本 Task 必须先改成 `commitEventDrafts` 产出的初始化事件，否则整个 `narrativeContext` 测试目录会红。其余 fixture 不靠手工漏列：执行下面的源码扫描，把所有命中同样迁移后才允许提交：

```bash
rg -l "GameEvent|eventLedger|domainEvents" src/game --glob '**/*.test.ts' --glob '**/*.testutil.ts'
rg -n 'eventLedger:\s*\[\{\s*type:|eventLedger:\s*\[\.\.\.|eventLedger\.concat|\.eventLedger\.push' src/game
```

第一条是迁移工作集，不要求最终零命中；第二条最终除专门验证 parser 拒绝 legacy payload 的负例外必须零命中。测试统一经 `worldStateFixture.testutil.ts` 中的 deterministic committed-event fixture helper 构造，不在各测试复制 envelope/sequence/ID 规则。

- [x] **Step 1: 写失败测试并完成整仓账本形状 cutover**

把 `WorldState.eventLedger`、`BattleStartSnapshot.eventLedger`、`TurnResolution.domainEvents` 与所有消费形参一次切成 `readonly CommittedNarrativeEvent[]`，删除旧 `GameEvent`。这是持久化 schema 破坏性变化，因此同一 Task 把 `WORLD_STATE_SCHEMA_VERSION` 从 4 升 5，并新增 `classifyWorldStateSchemaVersion`：World v1–v4 → `UNSUPPORTED_RECORD`，v5 → ok，未知/未来 → unknown-version code。所有 consumer 读取 `event.kind` 与 `event.payload`，不能靠交叉类型继续读取扁平字段。

`worldStatePersistenceValidation` 此时就委托 `parseCommittedEventLedger`；`sqliteGameRepository` 改用 World classifier，移除自己的 World legacy 版本数组，确保 v4 明确返回 `UNSUPPORTED_RECORD`，从而保证 Task 2 提交后的新游戏、完整流程与 SQLite reload 都可用。Task 7 只再做 Ledger ↔ Memory/NPC provenance 交叉校验，不得把 World 版本升级推迟到那时。

每个 `resolveByType` / quest / ending / candidate / battle / world-evolution helper 只返回 `eventDrafts` 与状态 mutation；测试断言 helper 返回的 WorldState ledger 与输入保持同一引用。全仓生产扫描：

```bash
rg -n "eventLedger:\s*\[\.\.\.|eventLedger\.concat|\.eventLedger\.push" src/game --glob '!**/*.test.ts'
```

Expected: 零命中。`battleResolver.ts` 的 8 处直接拼接（当前行 93/116/215/246/299/351/398/430）也必须在本 Task 机械迁成 draft；Task 8 只增加跨 action 的 battle Episode 因果和失败回滚证明，不承担延迟的类型迁移。

- [x] **Step 2: 为每种 payload 建立固定 metadata policy**

在 `gameplay/rpg/narrativeMemory/eventPolicy.ts` 用 `satisfies Record<NarrativeEventPayload["type"], ...>` 双向锁定：actor/target/location/fact/quest refs、outcome、salience、summary key 和默认 cause selector。关键 salience 下限：ending 100、quest/battle resolved 80、fact discovered/relationship major 65、scene presented 40、普通 travel/explore 20；具体值只在该表定义。

- [x] **Step 3: `resolveTurn` 一次提交本回合 drafts**

在 `resolveTurn` 顶部捕获一次 `committedAt = deps.now()`。`ResolveDeps` 在本 Task 加入真实 `turnId`（Task 4 复用，不再重复新增）。当前 `ResolveDeps`/`BattleResolveDeps` 把 `now` 当函数往下传，`resolveByType`、`reconcileQuests`、`resolveEnding`、`approveCandidateEvents`、`compileCandidateEvent` 与 battle resolver 各自多次调用它给每个事件盖不同时间。迁移后这些 helper 一律不再产生 `occurredAt`，改为只返回 draft；`now` 只被 `resolveTurn` 调一次。

回合号不要自己算：`turnNumber` 取 `previousStoryState.turnNumber + 1`，与 `createTurnResolution`（`turnResolution.ts:48` 计算该值并同步写回 `nextStoryState.turnNumber`）保持一致。调用顺序固定为：

```text
committedAt = deps.now()
  → 收集 resolver/quest/ending/candidate 的 drafts
  → commitEventDrafts({ ledger: worldState.eventLedger, drafts, source: { turnId, actionId, turnNumber: previousStoryState.turnNumber + 1, committedAt }, entityStore })
  → nextWorldState.eventLedger = commitResult.ledger
  → createTurnResolution({ ..., domainEvents: commitResult.appended })
```

`commitEventDrafts` 必须在 `createTurnResolution` 之前完成，否则 `TurnResolution.domainEvents` 与 `nextWorldState.eventLedger` 会落在不同回合号上。`TurnResolution.domainEvents` 改为 `CommittedNarrativeEvent[]`，`triggeredEvents` 仍投影 payload kind，不暴露 envelope 给客户端。

战斗开始时不要再用 `occurredAt` 当 `battleKey`。先按 `turnId + battle_started:<enemyId>` 预铸稳定 `battle_started` Event ID，再由它派生 `battleKey`；同一 action retry/replay 必须得到同一个 key。`startBattle`/`battleAction` 返回 draft 时直接携带该 `episodeKey`，后续 action 从 `WorldState.battle.battleKey` 复用。

- [x] **Step 4: 移除 ledger-index 作为业务 turn 的替代**

`materializedView`、objective rules、dialogue completed 查询、quest/candidate/ending 查询统一读取 `event.payload` 和 envelope `turnNumber/eventId`。禁止继续用数组下标伪造 turn；同一玩家回合多个事件必须共享 turnNumber。

同时迁移两处 `game_initialized` 生产构造点，避免 Task 2 后新游戏仍写 legacy payload：

1. `src/game/domain/worldState.ts` 的 `createInitialWorldState`；
2. `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts` 的生产开局路径。

`createInitialWorldState` 增加必填 `committedAt`；`compileOpeningGenerationCandidate` 增加必填 `createdAt`。`createGame` 每次开局尝试只捕获一个 `createdAt`，同时传给编译、opening novelty 与最终 repository create/replace，不能在三个位置分别调用时钟。两处都用最终 opening Entity Store 调 `commitEventDrafts` 构造唯一 initialization Event；`turnId = asTurnId("init:" + generationId)`、`episodeKey = "initialization"`、`turnNumber = 0`、无 actionId。opening NPC 的 `initial_world` 来源不伪造 eventId。

- [x] **Step 5: 运行并提交**

```bash
npm test -- src/game/domain/events.test.ts src/game/domain/eventLedger.test.ts src/game/domain/worldState.test.ts src/game/domain/turnResolution.test.ts src/game/gameplay/rpg/ruleEngine src/game/gameplay/rpg/candidateEvents src/game/gameplay/rpg/narrativeContext src/game/gameplay/rpg/narrativeMemory src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts src/game/application/createGame.test.ts src/game/application/server/persistence/worldStatePersistenceValidation.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
npm run typecheck
npm test
git add src/game/domain src/game/gameplay/rpg src/game/application
git commit -m "refactor(events): commit rule outcomes through one ledger pipeline"
```

---

### Task 3: 让 Pending Job、世界演化和 Scene Write-back 使用 Event ID 与明确因果

**Consumes:** pending `domainEventRange`、world delta、scene approval/write-back、Task 2 committed events。  
**Produces:** 后台叙事任务以 Event ID 而非脆弱数组范围引用规则结果；scene CAS 原子追加 world/scene events。
**Independent proof:** application tests 覆盖 stale/retry/同 job 幂等与一次 CAS。

**Files:**

- Modify: `src/game/domain/pendingNarrativeJob.ts`
- Modify: `src/game/domain/pendingNarrativeJob.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/domain/narrativeBundle.ts`
- Modify: `src/game/domain/narrativeBundle.test.ts`
- Modify: `src/game/domain/preparedContinuation.test.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/approveNarrativeBundle.ts`
- Modify: `src/game/application/approveNarrativeBundle.test.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/generatePendingNarrativeBundle.ts`
- Modify: `src/game/application/generatePendingNarrativeBundle.test.ts`
- Modify: `src/game/application/sceneWriteBack.ts`
- Modify: `src/game/application/consumeNarrativeBundle.ts`
- Modify: `src/game/application/consumePreparedContinuation.test.ts`
- Modify: `src/game/application/entityContextProjection.test.ts`
- Modify: `src/game/application/markNarrativeGenerationFailed.test.ts`
- Modify: `src/game/application/retryNarrativeGeneration.test.ts`
- Modify: `src/game/application/server/ai/sourceFactory.test.ts`
- Modify: `src/game/application/server/ai/worldEvolutionSource.test.ts`
- Modify: `src/game/application/server/compositionRoot.test.ts`
- Modify: `src/game/gameplay/rpg/narrativeBundle/descriptors.test.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts`

`consumeNarrativeBundle.ts` 的 Event 形状已在 Task 2 机械切到 committed envelope；本 Task 只把它的触发查询改为 stable Event ID/payload 语义。`entityContextProjection.test.ts:95`、`markNarrativeGenerationFailed.test.ts:27`、`retryNarrativeGeneration.test.ts:33`、`server/ai/sourceFactory.test.ts:145`、`domain/narrative.test.ts:39` 都手工构造 `domainEventRange`，必须同步改为 `domainEventIds`。

- [x] **Step 1: 用 `domainEventIds` 替代 `domainEventRange`**

`PendingNarrativeJob` 保存本回合 committed Event ID 的稳定有序数组；parser 拒绝空/重复/格式错误 ID。构造 job 时直接使用 `resolution.domainEvents.map(eventId)`；SceneGenerationContext 通过 ID lookup，任何缺失或 payload 不匹配稳定失败，不回退到 ledger slice。

- [x] **Step 2: 世界演化返回 draft，不自行追加 ledger**

Task 2 已让 `materializeWorldDelta` 不再自行追加 ledger；本 Step 固化其返回 preview Entity/Story state + `blueprint_expanded` draft 的语义，并补上 cause keys 绑定 job domain events、episodeKey 绑定 job turn。没有新增实体时不得伪造 world-expanded 事件。

- [x] **Step 3: 落地 `narrative_scene_presented`，它是 recent-scene 记忆的唯一来源**

先核实一个容易踩空的事实：`narrative_scene_presented` 目前**从未被生产代码构造**。

```bash
rg -n 'type: "narrative_scene_presented"' src --glob '!*.test.ts'
```

Expected：当前基线零命中；该名字只出现在 `src/game/domain/events.ts` 的 union（当前行 215）和 `worldStatePersistenceValidation.ts` 的 `isGameEvent` switch（当前行 281）。Task 1/2 已把 payload/parser 单源化，但仍必须在本 Task 补上真实 scene producer。`candidate_event_proposed` 已因没有任何新候选入池路径而从新 union 删除，本 Task 不扩展 provider/candidate schema。

`RecentSceneMemory`、"最近 8 幕"裁剪、Task 6 的 `recent_scenes` 块全部依赖 `narrative_scene_presented`。本 Step 必须真正产出它，否则整条 recent-scene 链路永远为空：

- 在 `approveNarrativeBundle`（v7 生产路径）与 `approveAndWriteScene`（其余路径）审批通过处**返回 draft 所需的已批准结构数据**，最终仍只由上层 orchestration 在 scene CAS 前 commit，不能让纯审批函数直接写 ledger：
  - `sceneId`：已批准 `currentScene.sceneId`；
  - `locationId`：Narrative Bundle 路径取 `approved.nextWorldState.currentLocationId`，其余路径取已审批 `SceneGenerationContext.currentLocationId`；`NarrativeSceneState` 本身没有 location 字段，禁止臆造 `scene.locationId`；
  - `focusNpcId`：优先取 `scene.event.kind === "dialogue"` 的 `focusNpcId`，否则取已通过 speech authority 的 `scene.npcLine?.npcId`，再否则为 null；
  - `pacing`：场景 schema 当前没有 pacing 字段，使用唯一固定映射把该 job 对应的 `StoryState.nextPacingNeed` 转成 `StoryPacing`（`reveal→setup`、`develop→develop`、`complicate/escalate→turn`、`climax→climax`、`resolve→resolution`），映射只定义一次并做 exhaustiveness test；
  - `beatIds`：只取 `job.mandatoryBeats` 的 `beatId`，不含 `instruction` 正文；
  - envelope `actorIds/targetIds`：actor 固定包含玩家，target 只取 scene event、焦点 NPC、在场对白 speaker 与 mandatory beat 所引用且已通过校验的实体 ID；Fact 单独进入 `factIds`，不混入 actor/target；recent-scene reducer 再由 actor/target 生成 `referencedEntityIds`，payload 不重复保存；
  - `revealedFactIds`：本幕向玩家揭示且 `discovered` 的 `FactId`。
- 绝不写入 narration、`npcLine` 文本、choiceToken、actionKey、玩家原文或 secret Fact 正文。
- cause 绑定 pending job 的 `domainEventIds`；`episodeKey` 绑定 job 的 `turnId`，从而并回触发它的 turn Episode。

- [x] **Step 4: scene CAS 前一次 commit 所有 drafts**

`generatePendingNarrativeBundle` 在 proposal 全部审批通过后，使用 pending `turnId/actionId/turnNumber` 提交 world + scene drafts，再把 ledger 与 ready narrative 一次交给 `applySceneWriteBack`。同 job retry 发现 Event ID 已存在时必须视为幂等同值；payload 不同则拒绝 `EVENT_ID_CONFLICT`，不能覆盖。

- [x] **Step 5: 保持 provider 和 revision 语义**

测试锁定：世界/scene Event 不增加 provider 调用；content repair 不提前写 Event；审批失败 ledger/memory 零变化；stale scene CAS 零写入；成功仍只执行一次 scene CAS。

- [x] **Step 6: 运行并提交**

```bash
npm test -- src/game/domain/pendingNarrativeJob.test.ts src/game/domain/narrative.test.ts src/game/application/performTurn.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/entityContextProjection.test.ts src/game/application/markNarrativeGenerationFailed.test.ts src/game/application/retryNarrativeGeneration.test.ts src/game/application/server/ai/sourceFactory.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/compositionRoot.test.ts src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts src/game/gameplay/rpg/narrativeBundle/descriptors.test.ts
npm run typecheck
git add src/game/domain src/game/application src/game/gameplay/rpg/worldEvolution
git commit -m "feat(events): link narrative writeback through stable event ids"
```

---

### Task 4: 将 NPC 知识、关系、交互与台词引用升级为 Event Provenance

**Consumes:** Plan 3 NPC components、Task 2 NPC event payload、四条 speech approval path。  
**Produces:** actionId 继续负责幂等，Event ID 成为知识/关系/经历与台词引用的权威证据。  
**Independent proof:** domain/gameplay/application tests 证明所有 action-era NPC 事实都有真实 ledger Event。

**Files:**

- Modify: `src/game/domain/entity/npcComponents.ts`
- Modify: `src/game/domain/entity/npcComponents.test.ts`
- Modify: `src/game/domain/entity/npcProjection.ts`
- Modify: `src/game/domain/entity/npcProjection.test.ts`
- Modify: `src/game/domain/worldEntries.ts`
- Modify: `src/game/domain/npcSpeechReferences.ts`
- Modify: `src/game/gameplay/rpg/npcMemory/npcKnowledge.ts`
- Modify: `src/game/gameplay/rpg/npcMemory/npcKnowledge.test.ts`
- Modify: `src/game/gameplay/rpg/npcMemory/relationshipSignalPolicy.ts`
- Modify: `src/game/gameplay/rpg/npcMemory/relationshipSignalPolicy.test.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.test.ts`
- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts`
- Modify: `src/game/application/npcSpeechAuthority.ts`
- Modify: `src/game/application/npcSpeechAuthority.test.ts`
- Modify: `src/game/application/focusNpcContext.ts`
- Modify: `src/game/application/focusNpcContext.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/consumePreparedContinuation.ts`
- Modify: `src/game/application/testing/prologueAckPreservesSceneChoices.test.ts`
- Modify: `src/game/gameplay/rpg/preparedContinuation/candidates.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrativeBundle.ts`
- Modify: `src/game/domain/preparedContinuation.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/createGame.test.ts`
- Modify: `src/game/application/approveNarrativeBundle.ts`
- Modify: `src/game/application/approveNarrativeBundle.test.ts`
- Modify: `src/game/application/approvePreparedContinuation.ts`
- Modify: `src/game/application/approvePreparedContinuation.test.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Modify: `src/game/application/deterministicSceneSource.test.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/generatePendingScene.test.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts`

- [x] **Step 1: 写失败测试固定 NPC event references**

- action knowledge source 新增 `eventId`；
- `RelationshipEvidence` 新增且至少一个 `supportingEventIds`，保留 actionId/turnNumber 作为幂等与诊断；
- `NpcInteraction` 新增 `eventId`；
- `initial_world` 来源不伪造 action event：`NpcKnowledgeSource` 与 `RelationshipSource` 的 `initial_world` 分支是独立判别联合分支，`eventId` 在这两个分支里必须保持缺省（不出现在对象上），不能填空串或假 ID；
- 未知、重复、非该 NPC 参与的 Event ID 在 store/persistence 校验失败。

**必须先同步 `npcComponents.ts` 的三张 exact-keys 表，否则所有合法存档都会被判成 `invalid_component_shape`，而且没有编译期信号**：

| 表 | 位置 | 本次要加的字段 |
|---|---|---|
| `KNOWLEDGE_ACTION_SOURCE_KEYS` | `npcComponents.ts:583` | `eventId` |
| `EVIDENCE_KEYS` | `npcComponents.ts:656` | `supportingEventIds` |
| `INTERACTION_REQUIRED_KEYS` | `npcComponents.ts:830` | `eventId` |

`validateKnowledgeSource` 用 `hasExactKeys(raw, KNOWLEDGE_ACTION_SOURCE_KEYS, KNOWLEDGE_ACTION_SOURCE_KEYS_ALLOWED)` 判定，多一个键或 required 少一个键都直接拒绝；`NpcInteractionKeyLock`（`npcComponents.ts:837`）是 `IsExactly<keyof NpcInteraction, ...>`，改 `worldEntries.ts` 的 `NpcInteraction` 而不同步这张表时 typecheck 会失败——两个方向都要验。`RelationshipEvidence` 没有键集合类型锁，所以那张表只能靠本 Step 的失败测试兜住。

- [x] **Step 2: 规则调用方从 semantic event key 预铸 Event ID**

复用 Task 2 已加入 `ResolveDeps` 的真实 `turnId`，对话、FactChange、赠物、明确 NPC 任务、candidate effect 和共同战斗使用与 Task 2 policy 相同的 semantic key，并在 mutation 前调用 `eventIdFor(turnId, eventKey)`。Knowledge source、relationship evidence 和 interaction 因而从写入开始就是合法完整组件；同回合必须同时产生相同 key 的 draft。`commitEventDrafts` 校验预铸 ID 与 draft 映射一致；缺 draft、key 冲突或 ID 不匹配时整回合失败、零提交，不能保留 action-only evidence，也不允许先写缺 Event ID 的临时组件。

- [x] **Step 3: speech authority 改用 Event ID**

把 `allowedInteractionActionIds/usedInteractionActionIds` 迁移为 `allowedEventIds/usedEventIds`。Authority 只允许：speaker 自己的 interaction event、自己的 knowledge source event、目标关系最近三条 evidence event；还要验证 Event 在 ledger 中存在、speaker 是 actor/target、Fact disclosure 仍允许。Prompt 不注入 Event payload 中无关 NPC 的私密引用。

- [x] **Step 4: 四条台词审批原子迁移**

opening（Event 引用固定为空）、narrative bundle、prepared continuation、scene write-back 同时切换 schema/parser/renderer/tests；不得长期同时接受 actionId 与 eventId 两套引用。旧 story v7 存档已按 unsupported 处理，无需兼容双字段。

- [x] **Step 5: 运行并提交**

```bash
npm test -- src/game/domain/entity src/game/domain/narrativeBundle.test.ts src/game/domain/preparedContinuation.test.ts src/game/gameplay/rpg/npcMemory src/game/gameplay/rpg/entityWorld src/game/gameplay/rpg/dialogue src/game/gameplay/rpg/preparedContinuation src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts src/game/application/npcSpeechAuthority.test.ts src/game/application/createGame.test.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/approvePreparedContinuation.test.ts src/game/application/consumePreparedContinuation.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/testing/prologueAckPreservesSceneChoices.test.ts
npm run typecheck
git add src/game/domain src/game/gameplay/rpg src/game/application
git commit -m "feat(npc): ground continuity evidence in committed events"
```

---

### Task 5: 用可重建 Episodic Memory 替代弱类型 Materialized View

**Consumes:** committed ledger、当前 `recentBeats/npcContacts/reducedThroughEventCount`。  
**Produces:** typed `EpisodicMemoryState`、Episode/recent scene reducer、唯一 CAS reconciliation。  
**Independent proof:** domain + application tests 证明 incremental 与 full rebuild 完全一致。

**Files:**

- Create: `src/game/domain/episodicMemory.ts`
- Create: `src/game/domain/episodicMemory.test.ts`
- Delete: `src/game/domain/materializedView.ts`
- Delete: `src/game/domain/materializedView.test.ts`
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/storyState.test.ts`
- Create: `src/game/application/reconcileCommittedMemory.ts`
- Create: `src/game/application/reconcileCommittedMemory.test.ts`
- Modify: `src/game/application/stateCommit.ts`
- Modify: `src/game/application/stateCommit.test.ts`
- Modify: `src/game/application/sceneWriteBack.ts`
- Modify: `src/game/application/server/compositionRoot.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Modify: `src/dependencyBoundaries.test.ts`

- [x] **Step 1: 写失败测试固定 Episode 聚合与 recent scene cap**

覆盖：普通 turn 聚合；scene/world 后续事件并回同 Episode；battleKey 跨 action 聚合；eventIds/participants/location/fact/quest/cause 去重稳定；outcome 与 salience 由 Event 归约；最近 8 个 scene 稳定裁剪；重复归约零变化。

- [x] **Step 2: 写 incremental == full rebuild 属性式表驱动测试**

对初始化、对话+关系、调查+知识、任务完成、世界扩展、战斗多轮、结局等固定 ledger 前缀逐一比较：每次增量 reconcile 的结果必须 deep equal `rebuildEpisodicMemory(fullLedger)`。

- [x] **Step 3: StoryState v8 只保留 `memory`**

删除 weak `recentBeats: unknown[]`、`npcContacts: unknown[]`、`reducedThroughEventCount`；`createInitialStoryState` 使用 `createEmptyEpisodicMemory()`。所有 selector 读 `storyState.memory`，不保留第二 reducer 或双写。

同时把版本常量推到 v8（`src/game/domain/storyState.ts`）：

- `STORY_STATE_SCHEMA_VERSION` 从 `7` 改为 `8`（当前在 `storyState.ts:14`）；
- `classifyStoryStateSchemaVersion` 的旧版本分支由 `2 || 3 || 4 || 5 || 6` 改为覆盖 `1..7`，让所有已知旧 Story schema（尤其 v7）落进 `UNSUPPORTED_RECORD`（当前在 `storyState.ts:34`）；
- `storyState.test.ts:63` 现有断言 `classifyStoryStateSchemaVersion(7)` 返回 ok，必须改为断言 `UNSUPPORTED_RECORD`，并新增 `classifyStoryStateSchemaVersion(8)` 返回 ok 的断言；`storyState.test.ts:36` 的 `expect(STORY_STATE_SCHEMA_VERSION).toBe(7)` 改为 `8`。

`src/game/application/server/compositionRoot.test.ts:64-66` 手工铺 `recentBeats: [] / npcContacts: [] / reducedThroughEventCount: 0`，本 Step 一并替换为 `memory: createEmptyEpisodicMemory()`。

Story memory 是持久化 schema 变化，不能只改常量而让 adapter 自己猜版本：本 Step 同时让 `sqliteGameRepository` 使用 `classifyStoryStateSchemaVersion`，删除 adapter 的 Story legacy 版本数组；Story v1–v7 都稳定映射 `UNSUPPORTED_RECORD`，v8 为当前，未知/未来映射 `VERSION_MISMATCH`。完整的 Story 内容 parser 与 ledger deep-compare 仍留给 Task 7。

- [x] **Step 4: CAS 前统一 reconcile**

`commitState` 与 `writeBackScene` 都调用 `reconcileCommittedMemory({previous: nextStoryState.memory, ledger: nextWorldState.eventLedger})`；规则层不提前按临时 ledger 归约。

这里要修掉一个已核实的顺序隐患：`src/game/gameplay/rpg/ruleEngine/index.ts` 现在先在第 286 行用 `ending.nextWorldState.eventLedger` 调 `reconcileMaterializedView`，**之后**才在第 300-305 行把 `finalDomainEvents` 追加成 `nextWorldState.eventLedger`——也就是说归约看到的账本比最终账本少一整回合。本 Step 删除第 282-297 行的提前归约，改为在 `nextWorldState` 组装完成之后 reconcile，并把结果只写进 `nextStoryStateWithView`。`stateCommit.ts:29` 是第二处归约点，同样换成 `reconcileCommittedMemory`。

- [x] **Step 5: 同步 `dependencyBoundaries.test.ts` 后再跑门禁**

`src/dependencyBoundaries.test.ts:789` 的 `canonical state surfaces` 用例把 `"game/domain/materializedView.ts"` 写进硬编码清单并断言 `statSync(file).isFile()` 为 `true`。删除 `materializedView.ts` 后这条会直接失败，而 Task 5 的 targeted 测试扫不到它。把该条目替换为 `"game/domain/episodicMemory.ts"`。

```bash
npm test -- src/game/domain/episodicMemory.test.ts src/game/domain/storyState.test.ts src/game/application/reconcileCommittedMemory.test.ts src/game/application/stateCommit.test.ts src/game/application/server/compositionRoot.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
npm run test:boundaries
npm run typecheck
git add src/game/domain src/game/application src/game/gameplay/rpg/ruleEngine/index.ts src/dependencyBoundaries.test.ts
git commit -m "feat(memory): derive episodic memory from committed ledger"
```

---

### Task 6: 建立结构化检索并接入 Narrative Context Compiler

**Consumes:** EpisodicMemoryState、Entity Store、pending event IDs、当前目标/地点/焦点 NPC。  
**Produces:** 有界、可解释、无私密泄漏的 relevant event / recent scene blocks。  
**Independent proof:** retrieval 排序、预算、隐私与 prompt snapshots。

**Files:**

- Create: `src/game/gameplay/rpg/narrativeMemory/retrieveNarrativeMemory.ts`
- Create: `src/game/gameplay/rpg/narrativeMemory/retrieveNarrativeMemory.test.ts`
- Create: `src/game/gameplay/rpg/narrativeMemory/renderNarrativeMemory.ts`
- Create: `src/game/gameplay/rpg/narrativeMemory/renderNarrativeMemory.test.ts`
- Create: `src/game/gameplay/rpg/narrativeMemory/index.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/worldNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/worldNarrativeContext.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/contextBlock.ts`
- Modify: `src/dependencyBoundaries.test.ts`

- [x] **Step 1: 写失败测试固定 query 与 lexicographic rank**

构造超过 12 个 Episode，证明一个 20 回合前但命中 focus NPC/quest/cause 的 Episode 排在近期无关 Episode 前；required Event 必选；同分时按 salience/sequence/ID；无结构命中者不进入 relevant；结果严格受 6 Episode/4 scene 上限。

- [x] **Step 2: 构建当前场景 query**

从 `PendingNarrativeJob.domainEventIds`、action summary、ObjectiveTransition、当前 quest/objective、currentLocationId、focus NPC、speech authority target 纯派生；provider/client 不提交 query 字段。

- [x] **Step 3: 渲染时执行 current-state precedence**

Episode card 只说“在第 N 回合发生 X/涉及 Y”；实体名称、当前 lifecycle/location 和任务当前状态从 Entity Store 即时读取，并明确标记为当前状态。已失效历史位置只作为 `thenLocation`，不能输出“现在仍在”。

- [x] **Step 4: 隐私与 authority**

通用 relevant event 块只显示 payload kind、公开实体名、公开/已发现 Fact ID、outcome 与 cause refs；NPC knowledge/interaction 的细节仍由 `NpcSpeechAuthority` 过滤。secret Fact 正文、关系裸数值、其他 NPC history、玩家原文不得进入 block 或 manifest。

- [x] **Step 5: 接入 compiler slots 和预算**

- 当前 job 的 exact Event cards：`slot="relevant_events"`、`authority="event"`、mandatory；
- 召回 Episode：`slot="relevant_events"`、`authority="memory"`、optional，按 rank 转 priority；
- recent scenes：`slot="recent_scenes"`、`authority="memory"`、optional；
- manifest refs 使用 Event/Episode ID，不保存正文；整体仍用既有 8k 预算（`NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS = 8_000`，`narrativeBundleContext.ts:25`），不新增调用。

- [x] **Step 6: 注册 `narrativeMemory` facade 并跑边界门禁**

`docs/游戏开发规范.md` 要求"新增跨层 import、facade 或 server 入口时同步更新 `src/dependencyBoundaries.test.ts` 并运行 `npm run test:boundaries`"。在 `dependencyBoundaries.test.ts` 的 `FACADES` 清单（`dependencyBoundaries.test.ts:56-69`）末尾新增一项：

```ts
{ name: "narrativeMemory", path: "@/game/gameplay/rpg/narrativeMemory", anchors: ["eventPolicy", "retrieveNarrativeMemory"] }
```

注册后 `FACADE_DEEP_IMPORTS` 会自动禁止 `@/game/gameplay/rpg/narrativeMemory/<internal>` 形式的 deep-import，所以本 Task 的所有调用方必须统一写 `import { … } from "@/game/gameplay/rpg/narrativeMemory"`——这正是 `index.ts` 要存在的原因。`src/game/application/server/ai/**` 与 `src/game/application/**` 两条规则都包含 `FACADE_DEEP_IMPORTS`，因此它们也在约束范围内。

```bash
npm test -- src/game/gameplay/rpg/narrativeMemory src/game/application/sceneGenerationContext.test.ts src/game/application/server/ai/narrativeContext src/game/application/server/ai/liveNarrativeBundleSource.test.ts
npm run test:boundaries
npm run typecheck
git add src/game/gameplay/rpg/narrativeMemory src/game/application src/dependencyBoundaries.test.ts
git commit -m "feat(memory): retrieve relevant episodes for narrative context"
```

---

### Task 7: 升级 v5/v8 持久化并校验 Ledger ↔ Memory 一致性

**Consumes:** WorldState v5、StoryState v8、Event/Episode validators、SQLite CAS repository。  
**Produces:** 严格版本分类、坏账本/坏 memory 稳定失败、reload 后确定性一致。  
**Independent proof:** persistence unit/integration tests。

**Files:**

- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/worldState.test.ts`
- Modify: `src/game/domain/worldStateValidation.ts`
- Modify: `src/game/domain/worldStateValidation.test.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.test.ts`
- Create: `src/game/application/server/persistence/storyStatePersistenceValidation.ts`
- Create: `src/game/application/server/persistence/storyStatePersistenceValidation.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/application/server/persistence/gameRepository.ts`
- Modify: `src/game/domain/testing/worldStateFixture.testutil.ts`
- Modify: `src/game/application/testing/investigationChoiceJourney.test.ts`
- Modify: `src/game/domain/storyState.ts`

- [x] **Step 1: 先写旧版与坏数据失败测试**

v4/v7 → `UNSUPPORTED_RECORD`；未知未来版本 → `VERSION_MISMATCH`；坏 Event payload、重复 ID、sequence 缺口、未来 cause、未知 entity ref、memory cursor 漂移、Episode eventIds 与 ledger 不符、NPC provenance 指向无关 Event → `ENTITY_STATE_INVALID`，且绝不自动清档。

- [x] **Step 2: 复核 v5/v8 初始化与版本分类没有旁路**

Task 2 已随 committed ledger 把 WorldState 升到 v5，Task 5 已随 `memory` 把 StoryState 升到 v8。本 Step 不再改版本号或重复初始化逻辑，只证明新局初始化后 `memory` 是由 initialization Event rebuild 得到，而不是另写一份 Episode。

复核两个 classifier 是唯一版本来源：World v1–v4、Story v1–v7 → `UNSUPPORTED_RECORD`；当前 v5/v8 → ok；非整数/未知未来版本 → 各自 unknown-version code，由 repository 映射为 `VERSION_MISMATCH`。SQLite 不得重新引入 `LEGACY_WORLD_SCHEMA_VERSIONS` / `LEGACY_STORY_SCHEMA_VERSIONS`。

- [x] **Step 3: persistence parser 单源化**

Task 2 已让 `worldStatePersistenceValidation` 委托 `parseCommittedEventLedger` 并删除巨型 `isGameEvent` switch；本 Step 在该单源 parser 上补齐 v5 的 ledger ↔ Entity/NPC provenance 交叉校验，`BattleStartSnapshot.eventLedger` 同样走它，不能重新复制 payload switch。

StoryState 侧**当前没有独立 parser，不要假托一个**：`classifyStoryStateSchemaVersion` 只有测试在用，`sqliteGameRepository.ts` 当前是直接比较版本。本 Step 创建 `application/server/persistence/storyStatePersistenceValidation.ts`，提供显式 `parsePersistableStoryState`，并让 create/replace/applyState/applySceneWriteBack 的序列化前校验与读取路径共用。它做三件事：校验 StoryState exact keys 并调用 classifier、委托 `parseNarrativeRuntimeState` 与 `parseEpisodicMemory`、再对传入的 World ledger full rebuild 并 deep compare；内容/交叉引用失败映射 `ENTITY_STATE_INVALID`，版本失败保留 `UNSUPPORTED_RECORD`/`VERSION_MISMATCH`，不能一律压成内容损坏。

- [x] **Step 4: reload/CAS/scene CAS tests**

证明 Event IDs、sequence、causes、Episode source range、recent scenes 和 NPC supportingEventIds 跨 create/applyState/applySceneWriteBack/reload 不变；stale CAS 不产生 ledger gap 或半更新 memory。

- [x] **Step 5: 运行并提交**

```bash
npm test -- src/game/domain/worldState.test.ts src/game/domain/worldStateValidation.test.ts src/game/domain/storyState.test.ts src/game/application/server/persistence/worldStatePersistenceValidation.test.ts src/game/application/server/persistence/storyStatePersistenceValidation.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/application/testing/investigationChoiceJourney.test.ts
npm run typecheck
git add src/game/domain src/game/application
git commit -m "feat(persistence): validate v5 event ledger and v8 memory"
```

`investigationChoiceJourney.test.ts` 的 raw `game_initialized` fixture 已在 Task 2 随整仓 cutover 机械迁移；本 Task 保留它是为了证明 v5/v8 reload 与两条调查分支仍然稳定，不能到本 Task 才第一次修类型。

---

### Task 8: 固化战斗因果 Episode 与失败全量回滚

**Consumes:** active battle fast path、battleKey、preBattleSnapshot、companion victory signal。  
**Produces:** 多回合战斗是一个 causal Episode；失败/撤退完全抹除未成立时间线；胜利保留完整链。  
**Independent proof:** battle application tests + reload。

**Files:**

- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrative.test.ts`
- Modify: `src/game/domain/combat.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/advanceBattle.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/advanceBattle.test.ts`
- Modify: `src/game/application/performBattleRound.ts`
- Modify: `src/game/application/performBattleRound.test.ts`
- Modify: `src/game/application/battleShapeValidation.ts`
- Modify: `src/game/application/battleShapeValidation.test.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.ts`

- [x] **Step 1: 两类 checkpoint 共同覆盖完整战前事实**

`BattleStartSnapshot` 继续保存 entityStore + eventLedger；现有 `BattleNarrativeCheckpointState.storySnapshot` 在 StoryState v8 后自然包含 `memory`。战斗开始时两者必须取自同一战前 revision，恢复时分别整体替换，不新增第三份 memory snapshot，也不能在失败后尝试“逆向删除” Episode。

- [x] **Step 2: battleKey 必须稳定贯穿 draft 的 episodeKey**

Task 2 已把当前由 `deps.now()` ISO 串生成的 `battleKey` 改成从稳定 `battle_started` Event ID 派生，并让所有 battle draft 携带 episodeKey。本 Step 不再给 `ResolveResult` 增加第二条 `battleKey` 通道：`startBattle` 成功后的权威 key 已在 `nextWorldState.battle.battleKey`，同次返回的 draft 也已有 key；后续 `battleAction`/`modernBattleAction` 只从 active battle state 读回。测试固定同 action retry/replay key 不变、不同 battle started Event 不撞 key。

所有战斗 Event 共享 `episodeIdForBattle(battleKey)`；每轮 cause 指向上一轮/started，resolved 指向终结轮，enemy_defeated 与 `fought_together` relationship event 指向 victory resolved。HP 为 0 的真实参战同伴仍可获得共同作战证据。

`fought_together` 事件不能漏在账本外：它现在由 `performBattleRound.ts` 的 `applyCompanionVictorySignals` 在 `resolveTurn` **返回之后**才写进 Entity Store，本回合 ledger 此时已经提交完。把这段规则下沉到 victory battle resolution：先按 Task 4 的 semantic key 预铸 `npc_relationship_changed` Event ID，把它写入关系 evidence 并返回同 key draft，最终与 round/resolved/defeated 一起由 `resolveTurn` 的**同一次** `commitEventDrafts` 提交。`performBattleRound` 删除 post-resolution 关系 mutation，不再对同一规则回合做第二批 Event commit。关系 evidence 的 `turnNumber` 使用 `resolution.nextStoryState.turnNumber` 对应的 committed source；active 非终结轮仍可重复使用同一玩家回合号，但没有关系事件。测试必须断言胜利后 `supportingEventIds` 指向的 Event 真实存在于 ledger，且不是靠 actionId 假造。

- [x] **Step 3: 失败/撤退恢复完整战前事实**

恢复 snapshot entityStore + projected compatibility + eventLedger + StoryState.memory；本场 started/round/defeat/relationship/scene Event 均不留存。测试在失败后执行新行动并确认 sequence 从战前 ledger 尾部继续，无 cause 指向已回滚 ID。

- [x] **Step 4: 胜利与 reload**

胜利一次 CAS 保存 battle Episode 和 companion supportingEventIds；reload 后检索 battle Episode 能按 companion/enemy/location 命中，失败分支完全查不到。

- [x] **Step 5: 运行并提交**

```bash
npm test -- src/game/domain/narrative.test.ts src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts src/game/gameplay/rpg/ruleEngine/advanceBattle.test.ts src/game/gameplay/rpg/ruleEngine/index.test.ts src/game/application/performBattleRound.test.ts src/game/application/battleShapeValidation.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
rg -n "eventLedger:\s*\[\.\.\.|eventLedger\.concat|\.eventLedger\.push" src/game --glob '!**/*.test.ts'
npm run typecheck
git add src/game/domain src/game/gameplay/rpg/ruleEngine src/game/application
git commit -m "feat(memory): preserve causal battle episodes and rollback"
```

最后那条 `rg` 在排除测试负例后必须零命中；Task 2 已消除 `battleResolver.ts` 的直接追加，本 Task 只防止回归。

---

### Task 9: 增加跨长间隔召回与完整游戏 Journey

**Consumes:** 完整 Plan 4 runtime。  
**Produces:** 离线可重复的“旧事精确召回但当前状态不被覆盖”证明，并保持短/中篇通关。  
**Independent proof:** 新 journey + 既有 continuity/divergence/foundation journeys。

**Files:**

- Create: `src/game/application/testing/episodicMemoryJourney.test.ts`
- Modify: `src/game/application/testing/npcContinuityJourney.test.ts`
- Modify: `src/game/application/testing/narrativeGroundingJourney.test.ts`
- Modify: `src/game/application/testing/dynamicMaterializationJourney.test.ts`
- Modify: `src/game/application/testing/investigationChoiceJourney.test.ts`
- Modify: `src/game/application/testing/mediumActJourney.test.ts`
- Modify: `src/game/application/testing/storyDivergenceJourney.test.ts`
- Modify: `src/game/application/testing/foundationJourney.test.ts`

`investigationChoiceJourney.test.ts` 也是当前验收命令里的既有 journey（`当前开发阶段.md` 的验收命令包含它，`current-phase.json` 的 `acceptanceCommands` 漏了，本 Plan 在 Task 10 一并补上）。它原先直接构造 `game_initialized` payload，已在 Task 2 做机械迁移；本 Task 负责补上它的召回/隐私断言。

- [x] **Step 1: 构造至少 24 成功玩家回合的中篇 Journey**

覆盖 opening → NPC 互动 → 私密/公开 Fact → 赠物/承诺 → 新地点/NPC/任务 → 多轮战斗 → 结局；至少 4 次 SQLite reload。保存第 2–4 回合的关键 Event ID，然后在至少 12 回合后让同一 NPC/quest/location 再次成为焦点。

- [x] **Step 2: 断言旧事召回与无全账本泄漏**

后期 SceneGenerationContext 必须召回指定旧 Episode/Event；无关但更近的 Episode 排在后面或被裁；Prompt/manifest 不出现完整 ledger JSON、玩家原文、secret Fact 正文、其他 NPC history 或裸关系数值。

- [x] **Step 3: 断言 current-state precedence**

让 NPC 在旧 Episode 后移动、任务完成、关系 stage 改变；后期 memory card 可以说“曾在旧地点发生”，但 current state 必须展示新地点/当前 stage/已完成任务，不能把 Episode 的旧值当现在。

- [x] **Step 4: 断言 causal provenance**

知识 source event、relationship supporting event、interaction event、quest completion cause、battle chain 与 ending cause 都能在 ledger 找到且顺序早于引用者；所有 Episode 可由 ledger full rebuild deep equal。

- [x] **Step 5: 断言战败时间线消失**

先失败并 reload，确认失败 battle 的 Event/Episode/companion evidence 不存在；再胜利，只有胜利链被召回。战败恢复规则本身不改为 fail-forward。

- [x] **Step 6: 运行并提交**

```bash
npm test -- src/game/application/testing/episodicMemoryJourney.test.ts src/game/application/testing/npcContinuityJourney.test.ts src/game/application/testing/narrativeGroundingJourney.test.ts src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts src/game/application/testing/foundationJourney.test.ts
npm run typecheck
git add src/game/application/testing
git commit -m "test(memory): prove long-gap episodic recall and continuity"
```

---

### Task 10: 更新实现事实、完整门禁与阶段收尾

**Consumes:** 已实现且 targeted tests 全绿的 Plan 4。  
**Produces:** canonical 文档与代码一致、短/中篇完整门禁通过、Plan 4 可安全合并。  
**Independent proof:** 全仓 test/build/phase status。

**Files:**

- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/agent/NPC人格知识与关系图.md`
- Modify: `docs/agent/实体与组件世界状态.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/行动裁决.md`
- Modify: `docs/agent/战斗与结局.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/游戏开发规范.md`
- Modify: `src/dependencyBoundaries.test.ts`

- [x] **Step 1: 文档只记录已实现事实与后续边界**

记录 v5/v8、committed event、Episode 重建、检索顺序、NPC Event provenance、battle rollback、Prompt blocks 与 journey。明确未实现 Plan 5 outline/Arc、Plan 6 scene planning、Plan 7 segmented storage/vector index、Plan 8 十小时支持和 misinformation。

- [x] **Step 2: 清理旧入口与第二事实源**

```bash
rg -n "domainEventRange|recentBeats|reducedThroughEventCount|materializedView|usedInteractionActionIds|allowedInteractionActionIds" src
rg -n "eventLedger:\s*\[\.\.\.|eventLedger\.concat|\.eventLedger\.push" src/game --glob '!**/*.test.ts'
rg -n 'type: "game_initialized"' src --glob '!*.test.ts'
```

Expected:
- 第一、二组生产代码零命中；所有 ledger 追加只在 `eventLedger.ts` 的 commit helper 内。
- 第三组只命中 `src/game/domain/eventLedger.ts`（或初始化专用的 domain helper）里通过 `commitEventDrafts` 构造的那一行；不得再出现任何手工拼出的 `{ type: "game_initialized", generation }` 字面量。

顺带清掉 `docs/agent/current-phase.json` 与 `docs/agent/当前开发阶段.md` 之间的验收命令不一致：两者当前差一个 `src/game/application/testing/investigationChoiceJourney.test.ts`（`当前开发阶段.md` 有，`current-phase.json` 没有）。本 Task 统一补上，Step 4 的命令表即为准。

- [x] **Step 3: 先标记待验收**

目标分支内将机器状态写为 `implemented / implemented`，人读入口写“待验收”；不提前写 `completed / merged`。

- [x] **Step 4: 运行完整离线门禁**

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
npm test -- src/game/application/testing/episodicMemoryJourney.test.ts src/game/application/testing/npcContinuityJourney.test.ts src/game/application/testing/narrativeGroundingJourney.test.ts src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
npm run build
npm run phase:status
```

Expected: 全部 PASS；无真实 AI 凭据要求；provider trigger matrix 与六个 route 不变；短篇/中篇均可到结局。

- [x] **Step 5: 提交实现事实并合并收尾**

```bash
git add docs src/dependencyBoundaries.test.ts
git commit -m "docs(memory): document structured events and episodic recall"
git status --short --branch
```

回到 main：

```bash
npm run branch:merge -- codex/structured-events-episodic-memory
```

若合并工具不更新阶段元数据，则在 main 将 `status` 写 `completed`、`implementationStatus` 写 `merged`，同步当前阶段与索引后提交，再运行 `npm run phase:status`。

## Acceptance Checklist

- [x] `WorldState.eventLedger` 只保存严格 `CommittedNarrativeEvent`，每项有稳定 Event ID、连续 sequence、真实 turn/action、参与者、地点、因果、outcome 与显著度。
- [x] 所有 ledger 写入都走一个纯 commit helper；规则、world delta、scene write-back、battle 不直接拼数组（含 `battleResolver.ts`，Task 2 cutover 后生产扫描即零命中）。
- [x] 同一 turn/job 重放产生相同 ID；stale/retry 不产生重复事件或 payload 覆盖。
- [x] cause 只能指向更早 Event，quest/battle/ending/world/scene 的固定因果 policy 有测试。
- [x] 两处 `game_initialized` 生产构造点（`worldState.ts` 的 `createInitialWorldState` 与 `openingGeneration/compileOpeningGenerationCandidate.ts`）都在 Task 2 产出 committed envelope，全仓无手工拼出的 `game_initialized` 字面量。
- [x] `narrative_scene_presented` 真正由审批通过路径产出（此前从未被生产代码构造），recent-scene 记忆非空；没有 producer 且旧存档不兼容的 `candidate_event_proposed` 已从新 payload/parser 删除，Plan 4 未偷增 candidate/provider schema。
- [x] NPC knowledge、relationship evidence、interaction 与台词引用使用真实 Event ID；actionId 只保留为幂等/诊断，不再充当长期证据；`npcComponents.ts` 的三张 exact-keys 表（`KNOWLEDGE_ACTION_SOURCE_KEYS` / `EVIDENCE_KEYS` / `INTERACTION_REQUIRED_KEYS`）已同步，合法 record 不会被判 `invalid_component_shape`。
- [x] Episode/recent scene/memory 可从 ledger full rebuild，incremental 结果 deep equal full rebuild，持久化漂移稳定判 corrupt。
- [x] 旧事件可按 Event/quest/entity/cause/location/salience/recency 结构化召回；不依赖完整 ledger Prompt 或向量检索。
- [x] Entity 当前状态覆盖 Episode 历史；旧位置、旧关系或旧任务状态不会被当成当前事实。
- [x] Context manifest 只含 Event/Episode ID 与元数据；玩家原文、secret Fact 正文、完整 narration/台词和其他 NPC 私密历史不进入 Event/Episode/Prompt。
- [x] 新 payload union 不含 `narrative_choice` / `narrative_dialogue_choice` 的 token/action-key 遗留形状；`player_intent_expressed` 只保存封闭 `intentCode`，不保存 `Action.intent/rawText`。
- [x] 战斗失败/撤退恢复战前 Entity Store、ledger、Episode、NPC provenance 和叙事状态；胜利才保留 causal battle Episode 与共同作战证据，且共同作战证据的 Event 真实存在于 ledger。
- [x] `dependencyBoundaries.test.ts` 已同步：`materializedView.ts` 锚点换成 `episodicMemory.ts`，新 `narrativeMemory` facade 已登记进 `FACADES`，所有调用方只经 facade 导入。
- [x] provider 调用数、六个路由、CAS、一次生成逐步消费和短/中篇完成路径不变。
- [x] `WorldState.version=5` / `StoryState.version=8` / `EntityStore.version=2` 严格持久化；旧 v4/v7 明确 unsupported。
- [x] Plan 5 Living Outline/Arc、Plan 6 scene planning、Plan 7 segmented storage/vector index、Plan 8 十小时支持与 misinformation 没有被提前实现。
- [x] `episodicMemoryJourney` 证明 12+ 回合间隔后的旧事召回、4+ reload、当前状态优先、战败回滚与最终结局。
- [x] 所有完整门禁通过，阶段合并后为 `completed / merged`。
