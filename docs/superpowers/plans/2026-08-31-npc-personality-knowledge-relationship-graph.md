# NPC Personality, Knowledge, and Directed Relationship Graph Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持“一次生成、逐步消费”、现有玩家行动闭环、战斗失败恢复战前状态和 provider 调用次数不变的前提下，把 NPC 的固定人格、动态状态、知识来源、交互历史、承诺与 NPC→玩家 / NPC→NPC 有向关系边变成唯一权威 Entity Component；所有对话、调查、物品、任务与战斗统一读取同一 NPC 投影，并由规则层以有证据、有限速、可回滚的方式更新。

**Architecture:** `NpcEntityRecord` 不再保存整块 `NpcStateComponent.memory`，而是保存固定 `identity`、可变 `dynamicState`、`knowledge`、`relationships` 与 `history` 五类职责清晰的组件。AI 只能在创建 NPC 时提议有界的人格锚点、初始目标和定性关系种子；既有 NPC 的知识与关系变化必须来自服务器已裁决的行动、事实传播或战斗结果，并通过封闭 `EntityMutation` 原子写入。规则层以 `actionId + turnNumber` 作为本阶段可验证证据，Plan 4 再迁移到稳定 `eventId/Episode`，本 Plan 不伪造未来事件 ID。现有 `NpcEntry/NpcMemory/relationship.affinity` 保留为 Entity Store 的只读兼容投影，使 UI、结局条件和当前场景 DTO 在迁移期仍可完整运行。

**Tech Stack:** TypeScript 5.8、Vitest 3、Next.js 16、现有 domain → gameplay/rpg → application 分层、SQLite JSON/CAS 存档、Narrative Context Compiler 与 Entity Store；不新增 npm 依赖或外部服务。

**Spec:** `docs/superpowers/specs/2026-08-23-long-form-narrative-entity-memory-architecture.md`（Plan 3；§7；NAR-06、NAR-07、NAR-14、NAR-17）

> 状态：待执行

## Global Constraints

- 实施前完整读取 `docs/游戏设计原则.md`、`docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/实体与组件世界状态.md`、`docs/agent/剧情连续性与结构化记忆.md`、`docs/agent/运行时AI导演与场景表演.md`、`docs/agent/世界动态具象化.md`、`docs/agent/行动裁决.md`、`docs/agent/探索与任务推进.md`、`docs/agent/战斗与结局.md`、总 Spec 与本 Plan。
- 先确认 Plan 2 已在 `main` 标记为 `completed/merged`，主工作区干净；阶段元数据与本 Plan 在执行启动 Step 4 一并提交，再用 `npm run phase:start` 创建 `.worktrees/npc-personality-knowledge-relationship-graph`，不用 `git checkout`。
- 本 Plan 只修改 `ai-rpg-game`；NPC Component 具有明确 RPG 业务语义，不修改 foundation 或创建共享 package。
- 不增加 provider 调用；只扩展现有 opening / narrative bundle 内嵌 world delta 的 schema，同一次调用产生更完整的 NPC 创建材料。
- 不改变六个 `/api/game/**` 路由、CAS 边界、后台 ensure/retry 语义、一次生成后逐场消费的 Narrative Bundle 图或玩家可见行动种类。
- 不改变战斗失败/撤退恢复到战前 `entityStore + eventLedger + narrative checkpoint` 的规则；战斗中产生的 NPC 动态、知识和关系变化也必须随失败一起回滚。
- AI 不得提交数值关系 delta、关系 stage、知识写入、人格 patch、任意字段路径或通用 JSON Patch；服务器只接受创建时的定性材料和既有封闭提案，数值变化由规则表决定。
- Identity Anchors 默认不可由普通行动、场景、关系信号或 `ProposedEntityCommand` 更新；本 Plan 不增加任何 `replace_npc_identity` mutation。
- 关系是有向边。`A → B` 不自动等于 `B → A`；只有明确的第二条初始种子或第二个规则信号才能建立反向边。
- 关系变化必须引用本阶段真实存在的 `actionId + turnNumber`，创建时背景关系使用 `initial_world` 来源；不得生成假的 `eventId`。Plan 4 增加稳定事件后再把证据升级为 `supportingEventIds`。
- 知识只能引用已存在的 canonical `FactId`。本 Plan 支持“已知/怀疑”和披露策略，不建立虚假事实或 NPC 主观错误事实模型；misinformation 留给 Plan 4 的事件/断言设计。
- 当前 `NpcInteraction.relationshipDelta`、`NpcMemory.knownFactIds/hiddenFactIds`、`NpcMemory.relationship.affinity` 只作为兼容读模型存在；最终生产写路径不得平行修改兼容 memory 与新组件。
- 不引入 Episode、语义向量检索、稳定 Event ID（Plan 4），不引入 Living Outline / Arc / Story Thread（Plan 5），不引入分段 ledger、归档或十小时存档容量承诺（后续长篇存储 Plan）。
- `WorldState.version` 从 3 升到 4，`EntityStore.version` 从 1 升到 2；旧 v3 / store v1 开发存档返回 `UNSUPPORTED_RECORD`，不做隐式迁移、不静默重置。SQLite 表与 `record_version` 不变。
- 每个任务先写失败测试并运行 targeted tests；实现与同目录测试一起提交。完成完整门禁并合并 main 前，不得把阶段状态写为 `completed/merged`。

## 明确边界

本 Plan 排除以下内容，即使总 Spec 描述了它们：

- **排除** Episode、语义向量检索、稳定 `eventId` 与因果事件模型（Plan 4）；关系与知识证据只引用真实 `actionId + turnNumber` 或 `initial_world`。
- **排除** NPC 主观错误事实 / misinformation 模型；knowledge 只有 `known`/`suspected` 两档 certainty 与三级 disclosure。
- **排除** Living Outline、Story Thread、Milestone、Arc 与 `NarrativeRoleComponent`（Plan 5/6）。
- **排除** Identity Anchors 的任何运行期更新通道：不新增 `replace_npc_identity` mutation，`ProposedEntityCommand` 不获得人格、知识或关系直写权限。
- **排除** `dynamicState` 中的健康/战斗数值字段；战斗状态仍只存在于 combat runtime 并随战前快照整体回滚。
- **排除** 分段 event ledger、快照归档与十小时存档容量承诺（Plan 7/8）；`GameRecord` 仍是单条 JSON 存档。
- **排除** 新增 npm 依赖、外部服务、provider 调用、`/api/game/**` 路由、CAS 边界与玩家可见行动种类。
- **排除** foundation 与任何 `@ai-game/*` 共享 package 改动；NPC Component 具有 RPG 业务语义。

## Canonical NPC Model

Plan 3 最终固定以下职责；具体 branded ID 可以放在同一 domain 文件中，禁止退化为动态 component 字典：

```ts
type NpcIdentityAnchors = Readonly<{
  selfConcept: string;
  values: readonly string[];              // 1..4，去重、非空
  speechStyle: string;
  capabilityBoundaries: readonly string[]; // 1..4，NPC 不会/不能做什么
  taboos: readonly string[];               // 0..4，长期禁区
}>;

type NpcGoal = Readonly<{
  goalId: string;                           // 服务端按 npcId + ordinal 铸造
  horizon: "short" | "long";
  description: string;
  priority: 1 | 2 | 3 | 4 | 5;
  status: "active" | "blocked" | "completed" | "abandoned";
  reason: string;
}>;

type NpcDynamicStateComponent = Readonly<{
  isCompanion: boolean;
  met: boolean;
  emotion: NarrativeEmotion;
  goals: readonly NpcGoal[];
}>;

type NpcKnowledgeEntry = Readonly<{
  factId: FactId;
  certainty: "known" | "suspected";
  disclosure: "public" | "conditional" | "secret";
  source:
    | Readonly<{ kind: "initial_world"; learnedAtTurn: number }>
    | Readonly<{
        kind: "action";
        mode: FactChangeSource;
        actionId: string;
        learnedAtTurn: number;
        sourceNpcId?: NpcId;
      }>;
}>;

type NpcKnowledgeComponent = Readonly<{
  entries: readonly NpcKnowledgeEntry[]; // 每个 NPC / FactId 唯一
}>;

type RelationshipDimensions = Readonly<{
  affinity: number;
  trust: number;
  fear: number;
  hostility: number; // 全部闭区间 [-100, 100]
}>;

type RelationshipStage =
  | "unknown" | "acquainted" | "cooperative" | "trusted" | "bonded"
  | "wary" | "hostile";

type RelationshipEvidence = Readonly<{
  evidenceId: string; // 服务端从 actionId + fromId + toId + signal 确定性构造
  actionId: string;
  turnNumber: number;
  signal: RelationshipSignal;
  severity: "normal" | "major";
  summaryKey: string; // 固定枚举/规则 key，不保存玩家原文
}>;

type RelationshipCommitment =
  | Readonly<{
      kind: "debt";
      commitmentId: string;
      direction: "source_owes_target" | "target_owes_source";
      status: "open" | "fulfilled" | "forgiven" | "broken";
      description: string;
      source: RelationshipSource;
    }>
  | Readonly<{
      kind: "promise";
      commitmentId: string;
      promisor: "source" | "target";
      status: "open" | "fulfilled" | "broken" | "released";
      description: string;
      source: RelationshipSource;
    }>;

type DirectedRelationshipEdge = Readonly<{
  targetId: PlayerEntityId | NpcId;
  dimensions: RelationshipDimensions;
  stage: RelationshipStage;
  trend: "improving" | "stable" | "worsening";
  commitments: readonly RelationshipCommitment[];
  evidence: readonly RelationshipEvidence[]; // 最近 12 条，稳定裁剪
  origin: RelationshipSource;
  lastChangedAtTurn: number;
}>;

type NpcRelationshipComponent = Readonly<{
  outgoing: readonly DirectedRelationshipEdge[]; // targetId 唯一、按 ID 稳定排序
}>;

type NpcHistoryComponent = Readonly<{
  interactions: readonly NpcInteraction[]; // 仍按 actionId 去重，最近 10 条
}>;
```

`RelationshipSource` 只允许 `{ kind: "initial_world"; createdAtTurn; reasonKey }` 或 `{ kind: "action"; actionId; turnNumber }`。`NpcEntityRecord` 最终形状固定为 `core + identity + position + dynamicState + knowledge + relationships + history`。`identity.role/description/tags` 保留，新增 `anchors`；旧 `NpcEntry.memory` 由统一 projector 重建：

- `knownFactIds` = knowledge 全部 entry 的 FactId；
- `hiddenFactIds` = `disclosure === "secret"` 的 FactId；
- `interactionHistory` = history.interactions；
- `relationship.affinity` = 指向 `PLAYER_ENTITY_ID` 的边的 affinity，无边时为 0；
- `emotion/goals` = dynamic state 的兼容值，其中 goals 只投影 active/blocked 的 description；
- `isCompanion/met` = dynamic state。

Spec §7.1 的其余层次在本 Plan 的边界：

- 健康/战斗状态：当前玩法中只存在于战斗 runtime（`CombatantSource` 参战单位），随 `preBattleSnapshot.entityStore` 在失败/撤退时整体恢复；本 Plan 不在 `dynamicState` 中新增健康字段。
- Episodic References：本阶段由 `history.interactions`（最近 10 条）与关系边的证据（最近 12 条）承载；结构化 Episode 属 Plan 4。
- Arc Role / `NarrativeRoleComponent`：依赖 Plan 5 才建立的 Arc 结构，本 Plan 不实现；Plan 6 只消费该结构做剧情规划，不再反向修改人格锚点。

## Relationship Rule Policy

- `RelationshipSignal` 是封闭 union，至少包含 `supported`、`challenged`、`threatened`、`deceived`、`offered_help`、`reassured`、`refused`、`gave_item`、`shared_fact`、`fought_together`、`betrayed`、`kept_promise`、`broke_promise`；AI 和客户端都不能携带数值 delta。
- 每个 signal 在 `relationshipSignalPolicy.ts` 中映射固定维度变化、severity、trend 与可选 commitment 操作。normal 单维绝对变化 ≤5、四维绝对变化总和 ≤8；major 单维 ≤12、总和 ≤20；所有维度最终 clamp 到 `[-100, 100]`。
- 同一 `actionId + fromId + targetId + signal` 幂等，重复应用零写入；同一行动对同一边同一维度的累计变化还要受上述 cap 限制。
- stage 由维度阈值和累计证据共同裁决，但每个已提交 action 最多沿允许图移动一档。双向转换：`unknown ↔ acquainted`、`acquainted ↔ cooperative`、`acquainted ↔ wary`、`cooperative ↔ trusted`、`cooperative ↔ wary`、`trusted ↔ bonded`、`wary ↔ hostile`；单向降级：`trusted → wary`、`bonded → wary`。因此从 `wary` 恢复信任必须逐档经过 `cooperative`（或 `acquainted`）到 `trusted`，再升 `bonded`，不允许跳级回补。
- `trusted` 至少要求 trust≥45、affinity≥35 且两条正向证据；`bonded` 至少要求 trust≥70、affinity≥60、三条正向证据且至少一条 major；`wary` 在 fear≥40、hostility≥25 或 affinity≤-20 时可候选；`hostile` 在 hostility≥60 或 affinity≤-60 时可候选。阈值满足但证据/相邻转换不满足时保持原 stage。
- 初始定性种子只允许 `ally`、`rival`、`wary`、`indebted_to`、`protective_of`；规则层映射为保守初值，最高只能初始化到 `cooperative` 或 `wary`，不能直接创建 `trusted/bonded/hostile`。固定映射：`ally` 与 `protective_of` → `cooperative` + 保守正向维度；`rival` 与 `wary` → `wary` + 保守负向维度；`indebted_to` → `cooperative` + 保守正向维度，并开一条 `source_owes_target` 的 open debt commitment（来源为 `initial_world`）。种子不携带数值，维度初值由 `relationshipSignalPolicy.ts` 的固定表给出。
- 关系边只保存规则 key 与 ID，不保存玩家自由输入原文；Prompt 渲染 stage、trend、commitment 和最多三条相关证据摘要，不注入裸数值推理指令。

## Target File Structure

```text
src/game/domain/entity/
├── npcComponents.ts
├── npcComponents.test.ts
├── npcProjection.ts
├── npcProjection.test.ts
├── entityComponents.ts
├── entityRecord.ts
├── entityStore.ts
└── entityProjection.ts

src/game/gameplay/rpg/npcMemory/
├── relationshipSignalPolicy.ts
├── relationshipSignalPolicy.test.ts
├── npcKnowledge.ts
├── npcKnowledge.test.ts
├── npcRuntimeProjection.ts
├── npcRuntimeProjection.test.ts
└── index.ts

src/game/application/
├── npcSpeechAuthority.ts
├── npcSpeechAuthority.test.ts
└── testing/npcContinuityJourney.test.ts
```

主要修改还包括：

- `domain/openingGenerationCandidate.ts` 与 `domain/worldDelta.ts`：创建 NPC 时增加 anchors、类型化 goals 和定性 relationship seeds。
- `gameplay/rpg/openingGeneration/*`、`worldEvolution/*`：审批创建材料并由服务端铸造 goal/relationship/evidence ID。
- `gameplay/rpg/entityWorld/entityMutation.ts`：Task 2 用过渡桥接 `sync_npc_legacy_memory` 替换 `replace_npc_state`（保持规则链可编译），随后增加细粒度 NPC dynamic / knowledge / relationship / history mutation，Task 5 拆除桥接。
- `gameplay/rpg/dialogue/dialogueResolution.ts`、`ruleEngine/resolveByType.ts`、`propagateKnownFacts.ts`、`candidateEvents/compileCandidateEvent.ts`：改为规则信号与来源明确的知识写入。
- `gameplay/rpg/ruleEngine/buildEncounter.ts` 与 `application/performBattleRound.ts`：同地点同伴读取统一 NPC 投影参战；胜利写 `fought_together`，失败/撤退随战前 store 回滚。
- `application/focusNpcContext.ts`、`entityContextProjection.ts`、`sceneGenerationContext.ts` 与三个 narrative context renderer：只通过统一 NPC 投影构造 Prompt。
- `application/approveNarrativeBundle.ts`、`approveAndWriteScene.ts`、`approvePreparedContinuation.ts`、`createGame.ts`：所有 NPC 台词路径统一验证 Fact/Interaction 引用归属。
- `application/server/persistence/worldStatePersistenceValidation.ts` 与 SQLite repository tests：严格读取 v4/store v2，拒绝旧版和损坏嵌套组件。

---

## 执行启动（Task 1 前，只在 main 主工作区执行）

> **执行偏差（2026-08-31）**：本次执行要求 main 工作区零改动，因此 Steps 2–4 的阶段元数据提交与 worktree 创建全部改在目标分支内完成：worktree 由 `git worktree add -b codex/npc-personality-knowledge-relationship-graph .worktrees/npc-personality-knowledge-relationship-graph main` 直接创建，随后在 worktree 内执行 `npm run setup`、`npm run handoff:check`，并把 `current-phase.json` / `当前开发阶段.md` / `Agent文档索引.md` 的 Plan 3 元数据提交在功能分支上。`npm run phase:start`（只能从干净的 main 执行）因此未运行。main 的阶段指针在分支合并前仍指向 Plan 2 `completed / merged`。

**Files:**

- Modify: `docs/agent/current-phase.json`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/Agent文档索引.md`

- [x] **Step 1: 确认 Plan 2 已完成、合并并收尾**

Run:

```bash
git status --short --branch
npm run phase:status
git worktree list
```

Expected: 当前分支为 `main`；Plan 2 为 `completed / merged`；旧 Plan 2 worktree/branch 已按仓库流程清理；除本 Plan 文档外主工作区无修改。

- [x] **Step 2: 把机器可读阶段切到 Plan 3 planned/not_started**

更新 `docs/agent/current-phase.json`：

```json
{
  "schemaVersion": 1,
  "phase": "npc-personality-knowledge-relationship-graph",
  "status": "planned",
  "implementationStatus": "not_started",
  "targetBranch": "codex/npc-personality-knowledge-relationship-graph",
  "worktreeName": "npc-personality-knowledge-relationship-graph",
  "repositories": ["ai-rpg-game"],
  "plan": "docs/superpowers/plans/2026-08-31-npc-personality-knowledge-relationship-graph.md",
  "sharedInfrastructureChangeAllowed": false,
  "startCommand": "npm run phase:start",
  "entryDocs": [
    "docs/游戏设计原则.md",
    "docs/游戏开发规范.md",
    "docs/Agent文档索引.md",
    "docs/agent/当前开发阶段.md",
    "docs/agent/实体与组件世界状态.md",
    "docs/superpowers/specs/2026-08-23-long-form-narrative-entity-memory-architecture.md",
    "docs/superpowers/plans/2026-08-31-npc-personality-knowledge-relationship-graph.md"
  ],
  "acceptanceCommands": [
    "npm run check:standards",
    "npm run typecheck",
    "npm run lint",
    "npm run test:boundaries",
    "npm run test:fast",
    "npm run test:game-domain",
    "npm run test:game-gameplay",
    "npm run test:game-application",
    "npm run test:components",
    "npm run test:app",
    "npm test",
    "npm run test:foundation-journey",
    "npm run journey:foundation",
    "npm test -- src/game/application/testing/npcContinuityJourney.test.ts src/game/application/testing/narrativeGroundingJourney.test.ts src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts",
    "npm run build",
    "npm run phase:status"
  ]
}
```

- [x] **Step 3: 更新人读入口但不提前写实现事实**

`docs/agent/当前开发阶段.md` 顶部改为“NPC 人格、知识与关系图 / 待执行”；唯一 Plan 指向本文件。索引只写目标与明确排除，不声称组件或 journey 已存在。

- [x] **Step 4: 验证、提交并创建 worktree**

```bash
npm run handoff:check:docs
git add docs/agent/current-phase.json docs/agent/当前开发阶段.md docs/Agent文档索引.md docs/superpowers/plans/2026-08-31-npc-personality-knowledge-relationship-graph.md
git commit -m "docs(phase): plan npc continuity graph"
npm run phase:start
```

Expected: main 提交后干净；worktree 创建成功；进入 worktree 后 `npm run handoff:check` PASS。

---

### Task 1: 固定 NPC 分层组件、来源与值域

**Consumes:** 当前 `NpcIdentityComponent`、`NpcStateComponent`、`NpcMemory` 与总 Spec §7。  
**Produces:** 独立、封闭、可严格校验的 NPC 组件类型和常量；暂不切换生产 record。  
**Independent proof:** domain 单测直接验证值域、exact keys、容量和引用 shape，不依赖 AI/DB。

**Files:**

- Create: `src/game/domain/entity/npcComponents.ts`
- Create: `src/game/domain/entity/npcComponents.test.ts`
- Modify: `src/game/domain/entity/index.ts`

- [ ] **Step 1: 写失败测试固定完整 shape**

覆盖 anchors 的非空/数量/重复限制、goal ID/priority/status、knowledge 唯一 FactId 与来源判别、关系 target 唯一和稳定顺序、四维范围、stage/trend、commitment/source 判别、history actionId 唯一与上限。

- [ ] **Step 2: 实现公开类型、枚举表与纯 validator**

导出 `validateNpcIdentityAnchors`、`validateNpcDynamicState`、`validateNpcKnowledge`、`validateNpcRelationships`、`validateNpcHistory`；错误只返回稳定 code/path，不返回私密事实正文。

- [ ] **Step 3: 锁定禁止结构**

用 `// @ts-expect-error` 证明动态 component map、裸 path patch、任意 relationship 数字对象、缺 source 的 knowledge/evidence 均不能赋给公开类型。

- [ ] **Step 4: 运行并提交**

```bash
npm test -- src/game/domain/entity/npcComponents.test.ts
npm run typecheck
git add src/game/domain/entity/npcComponents.ts src/game/domain/entity/npcComponents.test.ts src/game/domain/entity/index.ts
git commit -m "feat(entity): define layered npc components"
```

---

### Task 2: 切换 NPC Entity Record、兼容投影与 v4 持久化

**Consumes:** Plan 2 唯一 Entity Store、兼容 projector、严格 persistence parser。  
**Produces:** `NpcEntityRecord` 新形状、store v2、world v4；legacy `NpcEntry` 只由 projector 重建。  
**Independent proof:** store↔compatibility round trip、损坏存档和战斗快照测试；不触发 provider。

**Files:**

- Modify: `src/game/domain/entity/entityComponents.ts`
- Modify: `src/game/domain/entity/entityRecord.ts`
- Modify: `src/game/domain/entity/entityStore.ts`
- Modify: `src/game/domain/entity/entityStore.test.ts`
- Create: `src/game/domain/entity/npcProjection.ts`
- Create: `src/game/domain/entity/npcProjection.test.ts`
- Modify: `src/game/domain/entity/entityProjection.ts`
- Modify: `src/game/domain/entity/entityProjection.test.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/worldState.test.ts`
- Modify: `src/game/domain/worldStateValidation.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/domain/testing/worldStateFixture.testutil.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.test.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.test.ts`

- [ ] **Step 1: 写失败测试证明新 record 是唯一事实源**

测试：新 NPC record 不含 `npcState`；兼容 affinity/known/hidden/history/emotion/goals 精确投影；从完整兼容 projection 编译时创建保守 anchors、goal ID、initial knowledge 和 player edge；previous store 已有新组件时必须逐字保留而不是由 legacy memory 覆盖。

- [ ] **Step 2: 实现单向兼容策略**

Task 2 尚未扩展 opening / world delta 的 NPC 创建 schema，因此本任务允许**唯一临时创建桥**：现有生产创建路径和测试 compatibility fixture 都可从 legacy `NpcEntry` 确定性生成 `legacy_import` anchors、goal ID、initial knowledge，以及 affinity 等于 legacy compatibility 值、其余维度为 0 的 player edge，使切换 store v2 后游戏仍可创建和完整运行；不得从 AI prose 猜测缺失字段。Task 6 扩展创建 schema 后，生产 opening/world materialization 必须显式提供 anchors/typed goals，并删除生产路径的 `legacy_import` 回退；仅 `domain/testing/worldStateFixture.testutil.ts` 可继续为旧形状测试夹具使用它。`projectEntityStore` 始终从新组件重建 `NpcEntry`；删除所有读取 `record.npcState.memory` 的 selector。

- [ ] **Step 3: 桥接规则链，保持行为不变**

移除 `replace_npc_state` 后 `resolveByType.npcStateAfter`、`propagateKnownFacts`、`compileCandidateEvent` 三处调用点必须仍可编译且行为逐条等价。做法：在 `entityMutation.ts` 增加过渡桥接 `sync_npc_legacy_memory`（payload 为 exact-key 的 `dynamicState + knowledge + relationships + history` 四组件）；在 `npcProjection.ts` 增加纯函数：

```ts
compileLegacyNpcSync(input: Readonly<{
  before: NpcEntityRecord;
  afterLegacy: NpcEntry;
  actionId: string;
  turnNumber: number;
  addedKnowledge: readonly Readonly<{
    factId: FactId;
    mode: FactChangeSource;
    sourceNpcId?: NpcId;
  }>[];
}>): Readonly<{
  dynamicState: NpcDynamicStateComponent;
  knowledge: NpcKnowledgeComponent;
  relationships: NpcRelationshipComponent;
  history: NpcHistoryComponent;
}>
```

该函数从 `before` 保留非 legacy 可表达的字段，只应用可观察差量：affinity 差值只更新 player edge 的 affinity，新建边时其他维度为 0；已有 trust/fear/hostility、stage、commitments、evidence 和 origin 必须原样保留。新交互写 history（actionId 去重、上限 10）；`met/isCompanion/emotion` 写 dynamicState；legacy goals 未变化时保留原 typed goals，只有旧路径确实改变 goal descriptions 时才按 npcId + ordinal 确定性重建为 `legacy_import` goal。新增知识必须来自 `addedKnowledge`，不得仅比较 `knownFactIds` 后猜 source。

`propagateKnownFacts` 在本步骤改为接收 `{ actionId, turnNumber }` 并把每条 `FactChangeSource` 组装为 `addedKnowledge`。`compileCandidateEvent` 当前由 `resolveTurn` 激活但自身没有 action context，因此同步把 deps 改为 `{ now, actionId, turnNumber }`，在 `ruleEngine/index.ts` 传入当前真实 actionId 与 story turn；测试显式提供固定 action ID。任何调用点缺少真实证据都必须编译失败或零写入，不得用 candidate ID/时间戳伪造。桥接是过渡写路径，不得新增第二个；行为回归用现有 `resolveByType/propagateKnownFacts/compileCandidateEvent/ruleEngine index` 测试证明逐条不变。

- [ ] **Step 4: 升版本并严格解析**

设置 `EntityStore.version=2`、`WorldState.version=4`；更新 active battle `preBattleSnapshot.entityStore` parser；所有新嵌套字段 exact-key 校验。v3/store v1、缺组件、额外 key、重复边/Fact、越界数值、坏 commitment/evidence 返回稳定 corrupt/unsupported 分类，不 throw 到基础设施层。

- [ ] **Step 5: 保持战败回滚完整**

证明战前 snapshot 包含全部 NPC 新组件；失败/撤退投影恢复后 identity、knowledge、relationships、history 与 dynamicState 均与战前 deep equal。

- [ ] **Step 6: 运行并提交**

```bash
npm test -- src/game/domain/entity src/game/domain/worldState.test.ts src/game/domain/worldStateValidation.test.ts src/game/application/server/persistence/worldStatePersistenceValidation.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/application/performBattleRound.test.ts src/game/gameplay/rpg/entityWorld/entityMutation.test.ts src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts src/game/gameplay/rpg/ruleEngine/index.test.ts src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.test.ts
npm run typecheck
git add src/game/domain/entity src/game/domain/worldState.ts src/game/domain/worldState.test.ts src/game/domain/worldStateValidation.ts src/game/application/server/persistence src/game/domain/testing/worldStateFixture.testutil.ts src/game/application/performBattleRound.test.ts src/game/gameplay/rpg/entityWorld src/game/gameplay/rpg/ruleEngine/resolveByType.ts src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts src/game/gameplay/rpg/ruleEngine/index.ts src/game/gameplay/rpg/ruleEngine/index.test.ts src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.test.ts
git commit -m "refactor(entity): make layered npc state authoritative"
```

---

### Task 3: 建立有向关系信号、限速、stage 与承诺规则

**Consumes:** `DirectedRelationshipEdge`、现有 dialogue act/outcome 与 action ID。  
**Produces:** 唯一规则可信的关系更新引擎；AI 不接触数值。  
**Independent proof:** 纯函数 property/table tests，覆盖上下限、幂等、速度和方向性。

**Files:**

- Create: `src/game/gameplay/rpg/npcMemory/relationshipSignalPolicy.ts`
- Create: `src/game/gameplay/rpg/npcMemory/relationshipSignalPolicy.test.ts`
- Create: `src/game/gameplay/rpg/npcMemory/index.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.test.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/index.ts`
- Modify: `src/dependencyBoundaries.test.ts`

- [ ] **Step 1: 写失败表驱动测试**

逐个 signal 断言固定变化；normal/major cap、[-100,100] clamp、同 action 幂等、边按 target 排序、A→B 不改 B→A、证据上限 12、trend、stage 阈值/证据门槛/单次最多一档。

- [ ] **Step 2: 实现纯 `applyRelationshipSignal`**

输入 `fromNpcId/targetId/signal/actionId/turnNumber` 和当前边；输出新边或零变化。stage 候选与允许转换图必须是独立纯函数并有 exhaustive tests。

- [ ] **Step 3: 实现 commitment 操作**

只允许封闭 `open_debt/open_promise/fulfill/forgive/break/release`，ID 由服务器确定性铸造；更新必须引用现有 commitment 和 action source，未知 ID/非法状态迁移零写入并返回稳定错误。

- [ ] **Step 4: 接入原子 EntityMutation**

增加 `apply_relationship_signal`、`apply_relationship_commitment`；验证双方实体类型、self-edge、lifecycle、source 和 action ID。`replace_npc_state` 已在 Task 2 移除；桥接 `sync_npc_legacy_memory` 内的 relationships 整体同步保留到 Task 5 拆除（它是本 Plan 唯一过渡写路径，不得新增第二个），从本任务起所有新增关系写入只允许走这两个细粒度 mutation。

- [ ] **Step 5: 运行并提交**

```bash
npm test -- src/game/gameplay/rpg/npcMemory/relationshipSignalPolicy.test.ts src/game/gameplay/rpg/entityWorld/entityMutation.test.ts
npm run test:boundaries
npm run typecheck
git add src/game/gameplay/rpg/npcMemory src/game/gameplay/rpg/entityWorld src/dependencyBoundaries.test.ts
git commit -m "feat(npc): add evidence bound relationship rules"
```

---

### Task 4: 建立知识来源、披露策略与统一 NPC 运行投影

**Consumes:** `FactChange`、Fact Entity、NPC 新组件、Plan 2 Entity context closure。  
**Produces:** 来源可追踪的知识写入和一个供规则/Prompt/战斗共同消费的 NPC 投影。  
**Independent proof:** 私密知识隔离、来源、相关边和确定性排序单测。

**Files:**

- Create: `src/game/gameplay/rpg/npcMemory/npcKnowledge.ts`
- Create: `src/game/gameplay/rpg/npcMemory/npcKnowledge.test.ts`
- Create: `src/game/gameplay/rpg/npcMemory/npcRuntimeProjection.ts`
- Create: `src/game/gameplay/rpg/npcMemory/npcRuntimeProjection.test.ts`
- Modify: `src/game/gameplay/rpg/npcMemory/index.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.test.ts`
- Modify: `src/game/domain/resolvedEvent.ts`

- [ ] **Step 1: 写失败测试固定知识语义**

覆盖 initial/action source、Fact/NPC/action 引用、同 Fact 幂等、certainty 只能升不隐式降、disclosure 只能由规则显式改变、secret 不进入其他 NPC 投影、sourceNpcId 不等于自动传播 audience。

- [ ] **Step 2: 给传播链补足真实证据输入**

不要把 actionId 塞进每个 `FactChange` 重复存储；`propagateKnownFacts` 的 `{ actionId, turnNumber }` 规则上下文签名已在 Task 2 桥接时落地。本步骤负责 `npcKnowledge` 模块的 entry 语义：现有 `FactChange.source/audience` 完整映射为 knowledge source mode，无 audience、未知 Fact/NPC 或非法 source 保持零写入；桥接的知识编译改为复用本模块暴露的校验与构造函数。传播链从桥接改线为直接调用细粒度 mutation 属于 Task 5。

- [ ] **Step 3: 增加细粒度知识 mutation**

实现 `record_npc_knowledge` 与 `set_npc_knowledge_disclosure`，新增 mutation 本身不得包含整块替换 knowledge 的种类（桥接内的整体知识同步保留到 Task 5 随传播链改线拆除）。mutation 原子验证 Fact Entity、source NPC 和 target NPC。

- [ ] **Step 4: 实现 `projectNpcRuntimeProfile`**

一个 selector 同时返回 identity anchors、dynamic goals/emotion、对指定 target 的 outgoing edge、相关 incoming edge、可说 Fact cards、扣留 Fact IDs 和最近 5 条交互。Prompt-safe 模式只返回允许披露正文；rule 模式返回结构化权威值。不得扫描/返回其他 NPC 的 secret 正文。

- [ ] **Step 5: 运行并提交**

```bash
npm test -- src/game/gameplay/rpg/npcMemory src/game/gameplay/rpg/entityWorld/entityMutation.test.ts
npm run typecheck
git add src/game/gameplay/rpg/npcMemory src/game/gameplay/rpg/entityWorld src/game/domain/resolvedEvent.ts
git commit -m "feat(npc): track knowledge provenance and runtime projection"
```

---

### Task 5: 迁移对话、事实传播和候选事件到新组件

**Consumes:** 当前 `updateNpcMemory`、dialogue resolution、`propagateKnownFacts`、`npc_changes_stance`。  
**Produces:** 正式行动只通过细粒度 mutation 写 history/knowledge/relationship/dynamic state。  
**Independent proof:** 现有对话与调查规则测试加跨系统断言。

**Files:**

- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.ts`
- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.test.ts`
- Delete: `src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts`
- Delete: `src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Modify: `src/game/domain/candidateEvent.ts`
- Modify: `src/game/domain/candidateEvent.test.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/approveCandidateEvents.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/approveCandidateEvents.test.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.test.ts`

- [ ] **Step 1: 对话先输出定性信号再由规则更新**

保留 `DialogueResolution.relationshipDelta` 作为兼容/叙事展示字段，但它必须等于关系引擎实际 affinity 差值，不能再由对话层自行计算写入。dialogue act → signal 映射固定；history、emotion、knowledge disclosure、player edge 在一次 entity mutation batch 中原子提交。`give_item` 与本步骤一并改线（它与对话共用 `npcStateAfter` 桥接）：成功时对接收 NPC 写一条 history interaction 与 `gave_item` 关系信号，不再经 `updateNpcMemory`；debt 承诺语义与零写入守卫见 Task 7。

- [ ] **Step 2: 事实传播写来源**

事实传播从桥接整体同步改线为逐条调用 `record_npc_knowledge`（规则上下文 `{ actionId, turnNumber }` 自 Task 2 起已由 `resolveTurn` 传入）；现有 `FactChangeSource` 五个取值 `scene_witness`（在场可见，覆盖调查/目击）、`player_told`、`npc_revealed`、`public_broadcast`、`faction_shared` 各自保留 source mode。重复传播不得覆盖更早来源或追加重复 entry。

- [ ] **Step 3: 移除无真实因果证据的 `npc_changes_stance` 候选效果**

当前 `candidateEventPool` 的候选可能跨回合保存，`npc_changes_stance` 只有任意 `stance: string`，既不绑定产生候选的 action，也没有 Plan 4 的稳定 source event；在激活回合套用当前 actionId 会制造错误因果证据。Task 5 从 `EventCandidateKind`、`ProposedEffect`、parser、审批和编译器中删除 `npc_changes_stance`，已有旧候选由 v4 持久化 parser 拒绝。对话、赠物、承诺和共同战斗的关系变化全部由本轮已裁决 Action 直接产生封闭 `RelationshipSignal`；NPC-to-NPC 初始关系由 Task 6 的受控 seed 建立。后续跨 NPC 剧情事件导致的动态关系变化，等 Plan 4 提供稳定 eventId 与参与者后再接入，不得在本 Plan 伪造。

- [ ] **Step 4: 删除旧整块 memory 写路径与过渡桥接**

对话、事实传播与候选事件改线完成后，从 `entityMutation.ts` 移除 `sync_npc_legacy_memory` 及 `compileLegacyNpcSync`。全仓 `rg "replace_npc_state|sync_npc_legacy_memory|updateNpcMemory|npcState\.memory" src` 最终只允许历史文档/迁移测试命中，生产代码零命中。`ProposedEntityCommand` 不新增人格、知识或关系直接写权限。

- [ ] **Step 5: 运行并提交**

```bash
npm test -- src/game/gameplay/rpg/dialogue src/game/gameplay/rpg/ruleEngine src/game/domain/candidateEvent.test.ts src/game/gameplay/rpg/candidateEvents
npm run typecheck
git add src/game/gameplay/rpg src/game/domain/candidateEvent.ts src/game/domain/candidateEvent.test.ts
git commit -m "refactor(npc): route dialogue facts and stance through components"
```

---

### Task 6: 扩展开局和世界演化的 NPC 创建材料及 NPC-to-NPC 种子

**Consumes:** 现有 opening candidate、world delta newNpc、同一次 narrative bundle 调用。  
**Produces:** 所有新 NPC 出生即拥有完整 anchors/goals；动态 NPC 可建立受控有向 NPC-to-NPC 初始边。  
**Independent proof:** parser/approval/materialization 测试；provider 调用矩阵不变。

**Files:**

- Modify: `src/game/domain/openingGenerationCandidate.ts`
- Modify: `src/game/domain/openingGenerationCandidate.test.ts`
- Modify: `src/game/domain/entity/entityProjection.ts`
- Modify: `src/game/domain/entity/entityProjection.test.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/worldState.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts`
- Modify: `src/game/domain/worldDelta.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.test.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/createGame.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- Modify: `src/game/application/testing/providerTriggerMatrix.test.ts`

- [ ] **Step 1: 扩展创建 schema，不增加调用**

opening NPC 与 `WorldDeltaProposal.newNpc` 增加 `anchors` 和 typed `goals`。动态 NPC 另有 `relationshipSeeds[]`，每项为 existing active NPC ID + 定性 stance + bounded reason；开局只有一名 NPC，seeds 必须为空。

- [ ] **Step 2: 审批创建材料**

限制文本长度、数组数量、重复值和 goal 数；seed target 必须出现在该次 `entityContextProjection` 实体规则闭包（mandatory + 直接引用扩展 + 当前地点 optional 集合）内的既有 active NPC 中，且不能为新 NPC 自身。拒绝数值 delta/stage/evidence/actionId 和未知 key。seed 的 bounded reason 只用于提案诊断/审计，不进入关系边；持久化 `RelationshipSource.reasonKey` 由服务器按 stance 映射固定 key，不能把 AI 解释提升为关系事实。

- [ ] **Step 3: 服务端铸造 ID 并物化**

goalId、commitmentId 与初始边来源均由服务器生成。seed 映射保守维度和最高 cooperative/wary stage；只创建 `newNpc → targetNpc`，不自动创建反向边。`compileEntityStoreFromCompatibilityProjection` 对新 NPC 增加显式 `npcCreationComponentsById` 输入：previous store 已有 NPC 继续保留原组件，新 NPC 必须从该 map 取得已审批组件，否则稳定失败；不得在 domain 生产 compiler 内保留隐式 `legacy_import` fallback。测试 helper 自己调用 test-only legacy adapter 组装该 map，生产 opening compiler 与 world materializer 则分别从已验证 candidate / approved delta 组装。

- [ ] **Step 4: 更新确定性 fixture/source**

确定性 stock NPC 在各题材 `createGame.ts` 的 `createFixtureOpeningCandidateSource` contacts 池中，每个 stock NPC 提供明确且不矛盾的 anchors/goals；`openingGenerationSource.ts` 是 live AI 源，同步扩展其 Prompt 契约。`repairOpeningGenerationCandidate` 只能机械归一已有数组/字符串 shape，不能为缺失的 selfConcept/values/speechStyle/boundaries/taboos 创作默认人格；缺少或语义无效的 anchors/goals 必须走现有 content retry。Task 6 删除 Task 2 在生产 opening/world materialization 上的 `legacy_import` 创建回退，并加扫描/测试证明只剩测试 fixture helper 可用。动态 materialization journey 至少创建一条 NPC-to-NPC 边。调用矩阵仍是 initialization 一次、每个需要的 narrative bundle 一次，无额外 persona/relationship 调用。

- [ ] **Step 5: 运行并提交**

```bash
npm test -- src/game/domain/openingGenerationCandidate.test.ts src/game/domain/entity/entityProjection.test.ts src/game/domain/worldState.test.ts src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/worldEvolution src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/createGame.test.ts src/game/application/testing/providerTriggerMatrix.test.ts
npm run typecheck
git add src/game/domain src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/worldEvolution src/game/application/server/ai src/game/application/createGame.ts src/game/application/createGame.test.ts src/game/application/testing/providerTriggerMatrix.test.ts
git commit -m "feat(npc): materialize anchored npcs and directed seeds"
```

---

### Task 7: 让物品、任务与战斗消费统一 NPC 投影

**Consumes:** `projectNpcRuntimeProfile`、give_item、quest reconciliation、现有多单位 combat source。  
**Produces:** 非对话玩法也使用同一 NPC 状态；只在存在明确参与者时产生关系/知识后果。  
**Independent proof:** 物品、任务、战斗单测与失败回滚测试。

**Files:**

- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/buildEncounter.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/buildEncounter.test.ts`
- Modify: `src/game/domain/combat.ts`
- Modify: `src/game/application/performBattleRound.ts`
- Modify: `src/game/application/performBattleRound.test.ts`
- Modify: `src/game/application/combatView.ts`
- Modify: `src/game/application/combatView.test.ts`

- [ ] **Step 1: 物品行为只对明确目标产生信号**

`give_item` 的 history 与 `gave_item` 信号已在 Task 5 接入；本步骤补承诺语义：需要回报的物品类型可按固定规则开 debt，普通物品不自动产生承诺。失败、tampered、stale、非 NPC owner 零关系写入。

- [ ] **Step 2: 任务不凭空猜关系**

只有 objective 明确指向 NPC 且本轮行动由该 NPC 参与时才写对应信号；纯地点/敌人/物品任务完成不根据“关键 NPC”猜测关系。已在 dialogue/give/battle 写过的 actionId 不重复奖励。

- [ ] **Step 3: 同地点同伴确定性加入战斗**

`buildEncounter` 通过统一投影选择 `isCompanion && active && currentLocation` 的 NPC，按 ID 排序最多 1 名，使用固定 `COMPANION_COMBAT_STATS` 和现有 `source:{kind:"companion",npcId}`；不增加玩家操作单位，仍由 rule controller 驱动。

- [ ] **Step 4: 胜利与失败语义**

胜利时参与且存活/倒地的同伴均获得一次 `fought_together` 证据（关系信号不依赖伤害文本）；失败/撤退继续恢复战前 store，因此不会留下参战 history、知识或关系。非终结 battle round 不推进故事 turn，不能提前写永久关系。

- [ ] **Step 5: 运行并提交**

```bash
npm test -- src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts src/game/gameplay/rpg/ruleEngine/buildEncounter.test.ts src/game/gameplay/rpg/ruleEngine/advanceBattle.test.ts src/game/application/performBattleRound.test.ts src/game/application/combatView.test.ts
npm run typecheck
git add src/game/gameplay/rpg/ruleEngine src/game/domain/combat.ts src/game/application/performBattleRound.ts src/game/application/performBattleRound.test.ts src/game/application/combatView.ts src/game/application/combatView.test.ts
git commit -m "feat(npc): apply continuity rules across items quests and battle"
```

---

### Task 8: 统一 Prompt 投影与所有 NPC 台词引用审批

**Consumes:** Narrative Context Compiler、Entity context、scene/bundle/prepared/opening 四条台词路径。  
**Produces:** 焦点 NPC 只看到自己的 anchors、可说知识、相关关系和经历；每条持久化台词引用均可验证。  
**Independent proof:** context snapshot、隐私和四路径 approval tests。

**Files:**

- Create: `src/game/application/npcSpeechAuthority.ts`
- Create: `src/game/application/npcSpeechAuthority.test.ts`
- Modify: `src/game/application/focusNpcContext.ts`
- Modify: `src/game/application/focusNpcContext.test.ts`
- Modify: `src/game/application/entityContextProjection.ts`
- Modify: `src/game/application/entityContextProjection.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/worldNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/worldNarrativeContext.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/domain/narrativeBundle.ts`
- Modify: `src/game/application/approveAndWriteScene.ts`
- Modify: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/approveNarrativeBundle.ts`
- Modify: `src/game/application/approveNarrativeBundle.test.ts`
- Modify: `src/game/application/approvePreparedContinuation.ts`
- Modify: `src/game/application/approvePreparedContinuation.test.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/createGame.test.ts`

- [ ] **Step 1: 建立单一 `NpcSpeechAuthority`**

输入 world/store、speaker NPC、scene-visible Fact IDs 和当前 target；输出 allowedFactIds、withheldFactIds、allowedInteractionActionIds、identity anchors、关系档位/趋势/承诺与最多三条 evidence key。所有 renderer 和 approver 使用同一对象，禁止各自重算 allowlist。开局目前在 `createGame.compileOpeningNarrative` 中先审批 narrative、后编译 WorldState，不能直接调用要求 store 的 authority；本任务调整顺序为：先 parse/validate opening candidate → 用同一 candidate 编译只存在内存中的 preview WorldState/store → 基于 preview 调用 `NpcSpeechAuthority` 审批 opening currentScene → novelty 接受后再持久化同一 preview。不得另写一套 `publicFacts` opening allowlist，也不得增加 provider 调用。

- [ ] **Step 2: Prompt 使用人格与关系语义，不暴露隐私/裸数值**

焦点块稳定渲染 selfConcept/values/speechStyle/boundaries/taboos、active goals、对玩家和本场相关 NPC 的 stage/trend/open commitments、最近 5 条交互、允许披露 Fact cards。不得注入其他 NPC secret 正文、全世界关系边或让 AI 自算 affinity。

- [ ] **Step 3: 补齐持久化引用字段**

现有台词类型与缺口（已核对代码）：提案侧 `ScenePerformanceNpcLine`（`domain/narrativeBundle.ts`）已有 `usedFactIds + usedInteractionActionIds`；零回合闲聊 `ScenePerformanceNpcDialogue` 只有 npcId/text；持久化侧 `NarrativeNpcLineState`（`domain/narrative.ts`）只有 `usedFactIds`；多 NPC 对白 `NpcDialogueInScene` 只有 speechPages。本步骤给 `NarrativeNpcLineState` 补 `usedInteractionActionIds`，给 `NpcDialogueInScene` 与 `ScenePerformanceNpcDialogue` 补 `usedFactIds + usedInteractionActionIds`（闲聊无引用时为只读空数组），Narrative Bundle current/continuation line 与 prepared continuation 同步保留两字段；解析器 exact keys，旧缺字段不在 v4 接受。opening 首句 interaction IDs 固定为空。

- [ ] **Step 4: 四条审批路径统一验证**

现状校验强度不一致（已核对代码）：`createGame` 只校验开局首句 `usedFactIds ⊆ publicFacts`；`approveNarrativeBundle` 只校验说话人存在，引用仅透传；`approvePreparedContinuation` 校验 `usedFactIds ⊆ visibleFactIds` 但无 interaction 校验；`approveAndWriteScene` 已有 `npc_uses_forbidden_fact` / `wrong_npc_interaction` 两类校验。本步骤让四条路径都调用同一 authority 补齐到同一强度。拒绝不存在/属于其他 NPC/未披露的 Fact、其他 NPC actionId、speaker 不在场和引用数组重复；拒绝整包/场景，绝不静默删引用后写回。

- [ ] **Step 5: 证明 context 预算和调用数不回退**

anchors/edges 是 mandatory focus block；证据/非焦点关系为 optional，稳定排序后受既有 8k token 预算裁剪。Context manifest 不保存私密正文；provider 调用次数完全不变。

- [ ] **Step 6: 运行并提交**

```bash
npm test -- src/game/application/npcSpeechAuthority.test.ts src/game/application/focusNpcContext.test.ts src/game/application/entityContextProjection.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/server/ai/narrativeContext src/game/application/approveAndWriteScene.test.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/approvePreparedContinuation.test.ts src/game/application/createGame.test.ts
npm run typecheck
npm run test:boundaries
git add src/game/application src/game/domain/narrative.ts src/game/domain/narrativeBundle.ts
git commit -m "feat(narrative): ground npc speech in one authority projection"
```

---

### Task 9: 增加人格、知识、关系和战斗一致性 Journey

**Consumes:** 完整 Plan 3 运行链。  
**Produces:** 离线、可重复、跨 reload 的 NPC continuity 证明；游戏仍能完整结束。  
**Independent proof:** 单个 journey 覆盖成功链和失败回滚，另保留现有 grounding/medium journeys。

**Files:**

- Create: `src/game/application/testing/npcContinuityJourney.test.ts`
- Modify: `src/game/application/testing/narrativeGroundingJourney.test.ts`
- Modify: `src/game/application/testing/investigationChoiceJourney.test.ts`
- Modify: `src/game/application/testing/dynamicMaterializationJourney.test.ts`
- Modify: `src/game/application/testing/mediumActJourney.test.ts`
- Modify: `src/game/application/testing/storyDivergenceJourney.test.ts`

- [ ] **Step 1: 构造至少 18 成功回合的离线 Journey**

注意：现有套件没有中篇结局完成证明——`mediumActJourney.test.ts` 目前只是 19 行冒烟测试（五幕开局 + 首个决定进入 `provider_pending`），因此“完成中篇结局”是本 Journey 新增的覆盖，不能假设已有测试背书。覆盖：开场 NPC anchors；支持与威胁的有限关系变化；同一 action 重放不重复；调查事实只进入显式 audience；私密事实不能由另一 NPC 引用；动态创建第二 NPC 并建立一条 directed seed；赠物产生规则信号；共同战斗胜利；至少三次 SQLite repository reload；最终把五幕中篇推进到结局解析。直接构造旧 `npc.memory`/`relationship.affinity` fixture 的 journey（`narrativeGroundingJourney` 的 `runWithAffinity`、`investigationChoiceJourney` 的 memory fixture）同步改为向统一关系组件/知识组件播种。

- [ ] **Step 2: 明确断言不漂移与不跳级**

每次 reload 后 opening NPC anchors deep equal；普通对话不能一次进入 trusted/bonded/hostile；A→B seed 不生成 B→A；每个维度 cap/stage/evidence/source 可追踪；兼容 affinity 与 player edge 一致。`storyDivergenceJourney` 的现有结局要求（亲和度 ≥10 命中信任、≤9 命中质疑）属于玩家规则回归，不能为了让测试通过而改 stock threshold；relationship signal 的 affinity 固定表必须在限速范围内保持支持/质疑分支经真实多回合行动仍可达，必要时增加 journey 的合法对话回合，不修改结局条件。

- [ ] **Step 3: 明确断言知识与台词引用**

NPC 台词 used Fact/Interaction IDs 全部属于其 speech authority；另一 NPC 的 secret Fact 正文既不在 Prompt block，也不在 manifest；同一 Fact 重复传播不增加 entry。

- [ ] **Step 4: 明确断言战斗回滚**

先跑一次失败/撤退分支，确认 NPC 全组件与战前 deep equal；再从战前状态跑胜利，确认只有真实参战同伴获得 `fought_together`，且游戏继续消费既有 prepared continuation。

- [ ] **Step 5: 运行并提交**

```bash
npm test -- src/game/application/testing/npcContinuityJourney.test.ts src/game/application/testing/narrativeGroundingJourney.test.ts src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/dynamicMaterializationJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
git add src/game/application/testing
git commit -m "test(npc): prove continuity across long gameplay systems"
```

---

### Task 10: 更新实现事实、完成门禁并收尾阶段

**Consumes:** 已实现且通过 targeted tests 的 Plan 3。  
**Produces:** 实现文档与代码一致、全门禁通过、阶段可合并收尾。  
**Independent proof:** 全仓测试、build、phase status 与 main 合并事实。

**Files:**

- Create: `docs/agent/NPC人格知识与关系图.md`
- Modify: `docs/agent/实体与组件世界状态.md`
- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/世界动态具象化.md`
- Modify: `docs/agent/行动裁决.md`
- Modify: `docs/agent/探索与任务推进.md`
- Modify: `docs/agent/战斗与结局.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`
- Modify: `docs/Agent文档索引.md`
- Modify: `src/dependencyBoundaries.test.ts`

- [ ] **Step 1: 写实现事实与后续边界**

新 agent 文档记录真实组件 shape、唯一写路径、关系规则、知识隔离、speech authority、战斗回滚和版本。明确仍未实现 Plan 4 Event/Episode、Plan 5 Living Outline/Arc，以及长篇 segmented storage；不把未来目标写成现状。

- [ ] **Step 2: 清理旧生产写路径与过时注释**

```bash
rg -n "replace_npc_state|sync_npc_legacy_memory|updateNpcMemory|npcState\.memory" src
rg -n "WorldState\.version=3|EntityStore\.version=1|Plan 3 才" src docs/agent
```

Expected: 第一条生产代码零命中；第二条只允许明确的历史/不支持版本说明，不得仍把 Plan 3 写成未实现。

- [ ] **Step 3: 先标记待验收**

目标分支内将 `status/implementationStatus` 暂写 `implemented/implemented`，branch/worktree/Plan 不变；人读入口写“待验收”。不要在合并前写 `completed/merged`。

- [ ] **Step 4: 运行完整离线门禁**

逐条执行：

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
npm test -- src/game/application/testing/npcContinuityJourney.test.ts src/game/application/testing/narrativeGroundingJourney.test.ts src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
npm run build
npm run phase:status
```

Expected: 全部 PASS；无真实 AI 凭据要求；没有新增 provider 调用。

- [ ] **Step 5: 提交实现事实**

```bash
git add docs/agent docs/Agent文档索引.md src/dependencyBoundaries.test.ts
git commit -m "docs(npc): document personality knowledge relationship graph"
git status --short --branch
```

Expected: worktree 干净，阶段仍为待验收。

- [ ] **Step 6: 合并 main 并按安全流程收尾**

回到本仓 main 主工作区：

```bash
npm run branch:merge -- codex/npc-personality-knowledge-relationship-graph
```

若仓库的 `branch:merge` 只负责合并而未改阶段元数据，则在 main 将 `current-phase.json` 改为 `status: "completed"`、`implementationStatus: "merged"`，保留实际 targetBranch/worktreeName/Plan；同步 `当前开发阶段.md` 和索引为已完成，再提交：

```bash
git add docs/agent/current-phase.json docs/agent/当前开发阶段.md docs/Agent文档索引.md
git commit -m "docs(phase): close npc continuity graph"
npm run phase:status
git status --short --branch
```

Expected: main 干净；Plan 3 分支/worktree 已按仓库安全工具清理；`phase:status` 显示 `completed / merged`。

## Acceptance Checklist

> **执行偏差（2026-09-01，code review 记录）**：下方统一读取项的原始措辞要求五个玩法面“读取同一个 `projectNpcRuntimeProfile`”。实际实现中所有玩法面共享同一权威事实源（Entity Store 分层组件）：规则裁决读取面（`dialogueResolution`、`resolveByType` 的 give_item 去重等）消费 projector 每次提交都重建的 `NpcEntry.memory` 兼容 read model，台词与 prompt 读取面经 `NpcSpeechAuthority` 与同源可见性分区规则。`projectNpcRuntimeProfile` 已实现并由单测锁定，但规则路径不直接调用它。兼容投影始终由同一组件重建，行为等价且不存在第二状态源，故按“兼容桥是既定迁移读取路径”修正条目措辞而非改线。

- [ ] `NpcEntityRecord` 的 identity/dynamic/knowledge/relationships/history 分层是唯一权威事实，legacy `NpcMemory` 仅为 projector 读模型。
- [ ] 普通场景无法更新 identity anchors；opening 和动态 NPC 都有经过审批的稳定 anchors 与 typed goals。
- [ ] 知识记录 FactId、披露策略、真实 actionId/turn 来源；没有 audience 不扩散，NPC 私密知识不进入其他 NPC Prompt。
- [ ] NPC→玩家与 NPC→NPC 都是有向边；数值变化只来自规则 signal，有 cap、阈值、证据、幂等和每 action 一档的速度限制。
- [ ] debt/promise 有稳定 ID、方向、状态与来源；AI 不能提交数值关系或直接 patch commitment。
- [ ] 对话、调查、赠物、明确 NPC 任务和共同战斗都从同一权威事实源（Entity Store 分层组件）读取：规则裁决经 projector 重建的兼容 read model，台词与 prompt 经 `NpcSpeechAuthority` 同源可见性规则；无明确参与者时不猜关系后果。
- [ ] 所有生成/预备/开局 NPC 台词都以同一 `NpcSpeechAuthority` 审批 Fact 与 Interaction 引用。
- [ ] 同地点同伴可按确定性规则参战；失败/撤退恢复全部 NPC 组件，胜利才写共同作战证据。
- [ ] provider 调用数、路由、CAS、一次生成逐步消费和战败恢复语义不变。
- [ ] `WorldState.version=4` / `EntityStore.version=2` 严格持久化；旧版明确 unsupported，坏嵌套组件稳定判 corrupt。
- [ ] `npcContinuityJourney` 跨多回合、多 reload、NPC-to-NPC、隐私、战斗失败/胜利并最终完成游戏。
- [ ] Plan 4 Event/Episode、Plan 5 Living Outline/Arc 和长篇 segmented storage 没有被偷偷提前实现。
- [ ] 所有完整门禁通过，阶段合并后为 `completed / merged`。
