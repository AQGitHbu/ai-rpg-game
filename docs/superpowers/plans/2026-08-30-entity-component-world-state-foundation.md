# Entity/Component World State Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变当前玩家规则、AI 调用次数、叙事包协议和战斗失败回滚语义的前提下，为玩家、NPC、地点、物品、敌人、阵营、任务与事实建立唯一稳定 Entity Store、类型化 Component、统一引用/位置校验和受限 Entity Command；现有 `WorldState` 数组保留为由 Entity Store 确定性生成的兼容投影，使短篇与中篇仍可完整通关。

**Architecture:** `WorldState.version=3` 新增持久化 `entityStore`，其中每个实体是带 `EntityCore` 的判别联合，不使用“万能 Entity + 大量可空字段”。规则层只通过封闭的 `EntityMutation` 修改 store，再统一重建 `locations/npcs/items/worldFacts/quests/enemies/factions` 及位置、持有、解锁、到访、击败等兼容投影；应用层与 UI 在本阶段继续读取原字段，因此不需要并行运行链。AI 本阶段仍只返回既有 `WorldDeltaProposal/NarrativeBundleProposal`；新增的 `ProposedEntityCommand` parser/approver 是唯一允许未来 AI 请求修改既有实体的入口，但本 Plan 不把它加入 provider schema、也不新增调用。上下文编译器改从 Entity Store 的规则闭包投影相关实体，避免重新把整份 `WorldState` 当 Prompt 事实源。

**Tech Stack:** TypeScript 5.8、Vitest 3、Next.js 16、现有 domain → gameplay/rpg → application 分层、SQLite JSON/CAS 存档；不新增 npm 依赖或外部服务。

**Spec:** `docs/superpowers/specs/2026-08-23-long-form-narrative-entity-memory-architecture.md`（Plan 2；NAR-04、NAR-05、NAR-14、NAR-17）

> 状态：待执行

## Global Constraints

- 实施前完整读取 `docs/游戏开发规范.md`、`docs/游戏设计原则.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/剧情连续性与结构化记忆.md`、`docs/agent/运行时AI导演与场景表演.md`、`docs/agent/世界动态具象化.md`、`docs/agent/行动裁决.md`、`docs/agent/战斗与结局.md`、总 Spec 与本 Plan。
- 先确认 Plan 1 已在 `main` 标记为 `completed/merged`，且工作区除本次已审定的 Plan 2 文档外无其他改动；阶段元数据与 Plan 在执行启动 Step 4 一并提交，确认 main 干净后再通过 `npm run phase:start` 创建 `.worktrees/entity-component-world-state-foundation`，不用 `git checkout`。
- 本 Plan 只修改 `ai-rpg-game`，不读取或修改 foundation；Entity/Component 含明确 RPG 语义，不创建通用 package。
- 不增加 provider 调用，不修改 initialization / narrative_choice / npc_free_text 触发白名单，不改变一次生成、原子审批、逐步消费和失败重试语义。
- 不修改玩家可见行动、任务顺序、战斗数值、结局条件或战败恢复到战前状态的规则。
- 不引入 NPC 多维关系、人格锚点、知识来源图或 NPC-to-NPC 关系；这些属于 Plan 3。
- 不引入带稳定 eventId 的 Event、Episode 或历史检索；这些属于 Plan 4。
- 不引入 Living Outline、Arc、Milestone 或 Story Thread；这些属于 Plan 5。
- 不允许任意 JSON Patch、字段路径更新、动态 component 名称或 `Record<string, unknown>` 直接写入权威 Entity。
- `entityStore` 是新增权威事实；旧数组只能由统一 projector 生成。最终生产代码不得存在“同时手改 store 和数组”的写入路径。
- 测试若需一次构造完整世界，只能用 `domain/testing/worldStateFixture.testutil` 从完整兼容 projection 一次编译 v3；构造后除故意验证损坏门禁的测试外，也不得用 object spread 单改 legacy 数组。该 helper 禁止被非测试生产文件 import。
- `WorldState.version` 从 2 升到 3；旧 v2 开发存档明确返回 `UNSUPPORTED_RECORD`，不迁移、不静默重置。SQLite 表和 `record_version` 不变。
- 每个任务先运行列出的 targeted tests；实现代码与同目录测试一起提交。完整门禁前不得把阶段写成 `completed/merged`。

## Target File Structure

```text
src/game/domain/entity/
├── entityCore.ts                 # EntityKind、EntityLifecycle、EntityCore、统一 EntityId
├── entityComponents.ts           # 固定类型化组件；无动态字段
├── entityRecord.ts               # 8 类 EntityRecord 判别联合
├── entityStore.ts                # store、selector、结构/引用校验
├── entityStore.test.ts
├── entityProjection.ts           # store ↔ 现有 WorldState 兼容投影
├── entityProjection.test.ts
└── index.ts

src/game/domain/worldEntries.ts       # legacy entry/value types; worldState.ts re-export keeps callers stable
src/game/domain/worldStateValidation.ts # entity store 之外的 battle/ending 引用闭包校验
src/game/domain/worldStateValidation.test.ts
src/game/domain/testing/worldStateFixture.testutil.ts # 仅测试使用：一次编译完整 v3 world，禁止生产 import

src/game/gameplay/rpg/entityWorld/
├── entityMutation.ts             # 规则可信的封闭 mutation + 原子 apply/project
├── entityMutation.test.ts
├── proposedEntityCommand.ts      # 不可信 AI command parser/approval
├── proposedEntityCommand.test.ts
└── index.ts

src/game/application/
├── entityContextProjection.ts
├── entityContextProjection.test.ts
├── server/persistence/worldStatePersistenceValidation.ts
├── server/persistence/worldStatePersistenceValidation.test.ts
└── testing/entityProjectionJourney.test.ts
```

主要修改：

- `src/game/domain/worldEntity.ts`：增加 `PlayerEntityId`、`FactionId` 与 helper。
- `src/game/domain/worldEntries.ts`：从 `worldState.ts` 移出现有 entry/value type，避免 Entity Component 与 `WorldState` 循环依赖；`worldState.ts` 继续 re-export，不要求一次性改完所有 import。
- `src/game/domain/worldState.ts`：`version: 3`、`entityStore`、兼容投影说明与构造。
- `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`：开局一次建立 store 并投影。
- `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`、`reconcileQuests.ts`、`propagateKnownFacts.ts`、`battleResolver.ts`：改走 mutation。
- `src/game/application/performBattleRound.ts`：失败/撤退恢复改用战前 `entityStore` 快照经 projector 重建（恢复逻辑现居此文件，不在 `battleResolver`）。
- `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts`、`worldEvolution/materializeWorldDelta.ts`、`worldEvolution/storyReveal.ts`：改走 mutation。
- `src/game/domain/worldState.ts` 的旧 `append*` helper 删除或改为调用 entity mutation facade；不得继续裸追加数组。
- `src/game/application/server/persistence/sqliteGameRepository.ts`：v3 读取、实体/投影一致性校验、v2 明确拒绝。
- `src/game/application/server/persistence/worldStatePersistenceValidation.ts`：对未信任 JSON 做完整 v3 envelope/store/reference/projection 校验。
- `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`、`sceneGenerationContext.ts`、`narrativeContext/worldNarrativeContext.ts`：从规则闭包 Entity projection 构造上下文。
- `src/dependencyBoundaries.test.ts`：登记 `entityWorld` gameplay facade，阻止 application deep import。
- 新建 `docs/agent/实体与组件世界状态.md`，同步相关 agent 文档和索引。

---

## 执行启动（Task 1 前，只在 main 主工作区执行）

**Files:**

- Modify: `docs/agent/current-phase.json`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: 确认 Plan 1 已收尾且 main 干净**

Run:

```bash
git status --short --branch
npm run handoff:check:docs
```

Expected: 上一阶段为 `completed / merged`，不存在遗留 worktree 声明；`main` 要么已干净，要么只允许本文件这一项已审定、待 Step 4 提交的修改，不能夹带代码或其他文档改动。

- [ ] **Step 2: 把机器可读阶段切到 Plan 2 的 planned/not_started**

用以下字段更新 `docs/agent/current-phase.json`，保留 `schemaVersion: 1`：

```json
{
  "schemaVersion": 1,
  "phase": "entity-component-world-state-foundation",
  "status": "planned",
  "implementationStatus": "not_started",
  "targetBranch": "codex/entity-component-world-state-foundation",
  "worktreeName": "entity-component-world-state-foundation",
  "repositories": ["ai-rpg-game"],
  "plan": "docs/superpowers/plans/2026-08-30-entity-component-world-state-foundation.md",
  "sharedInfrastructureChangeAllowed": false,
  "startCommand": "npm run phase:start",
  "entryDocs": [
    "docs/游戏设计原则.md",
    "docs/游戏开发规范.md",
    "docs/Agent文档索引.md",
    "docs/agent/当前开发阶段.md",
    "docs/superpowers/specs/2026-08-23-long-form-narrative-entity-memory-architecture.md",
    "docs/superpowers/plans/2026-08-30-entity-component-world-state-foundation.md"
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
    "npm test",
    "npm run test:foundation-journey",
    "npm run journey:foundation",
    "npm test -- src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/entityProjectionJourney.test.ts",
    "npm run build",
    "npm run phase:status"
  ]
}
```

- [ ] **Step 3: 更新人读阶段入口，不提前声称实现完成**

`docs/agent/当前开发阶段.md` 顶部写“实体与组件世界状态基础 / 待执行”；唯一 Plan 指向本文件。`docs/Agent文档索引.md` 的当前阶段行同步为“计划待执行”。保留 v7 当前生产基线，不把目标架构写成实现事实。

- [ ] **Step 4: 验证、提交并创建 worktree**

```bash
npm run handoff:check:docs
git add docs/agent/current-phase.json docs/agent/当前开发阶段.md docs/Agent文档索引.md docs/superpowers/plans/2026-08-30-entity-component-world-state-foundation.md
git commit -m "docs(phase): plan entity component world state"
npm run phase:start
```

Expected: commit 后 `git status --short` 为空；`.worktrees/entity-component-world-state-foundation` 创建成功；进入该目录后 `npm run handoff:check` PASS。

---

### Task 1: 建立 Entity Core、固定 Component 与判别联合 Store

**Consumes:** 当前 `worldEntity.ts` 的品牌 ID 与 `worldState.ts` 的 8 类对象字段。  
**Produces:** 零 IO、可序列化、无可空万能字段的 `EntityStore` 及结构校验。  
**Independent proof:** domain 单元测试；只从 `worldState.ts` 移出并 re-export entry type，不改 `WorldState` 数据 shape、玩法或存档。

**Files:**

- Modify: `src/game/domain/worldEntity.ts`
- Create: `src/game/domain/worldEntries.ts`
- Modify: `src/game/domain/worldState.ts`
- Create: `src/game/domain/entity/entityCore.ts`
- Create: `src/game/domain/entity/entityComponents.ts`
- Create: `src/game/domain/entity/entityRecord.ts`
- Create: `src/game/domain/entity/entityStore.ts`
- Create: `src/game/domain/entity/entityStore.test.ts`
- Create: `src/game/domain/entity/index.ts`
- Modify: `src/game/domain/index.ts`

- [ ] **Step 1: 写失败测试，固定稳定身份与非万能结构**

测试至少覆盖：

1. player/NPC/location/item/enemy/faction/quest/fact 的 ID 在同一 store 全局唯一；
2. 同 ID 重复时：`createEntityStore` 抛 `EntityStoreInvariantError`（code=`duplicate_entity_id`），`validateEntityStoreStructure` 返回 `duplicate_entity_id` issue；
3. `npc` record 必须有 `identity + position + npcState`，不能携带 `quest/fact/item` component；
4. `createdAtTurn` 为非负整数、`lifecycle` 只能取四个固定值；
5. `getEntity(store,id)` 与 `entitiesOfKind(store,kind)` 顺序稳定；
6. `JSON.stringify/parse` 后 store 内容逐字等价；
7. 任意 `components: Record<string, unknown>` 或 `{op,path,value}` 不能赋给公开类型（用 `// @ts-expect-error` 锁定）。
8. 从 `JSON.parse` 得到的对象若缺 component、多出其他 kind component、嵌套字段值域错误或 quest/enemy lifecycle 不一致，runtime validator 稳定拒绝；
9. 私密 Fact 的 `core.name` 不包含 `FactComponent.text`，序列化 store 中事实正文只出现一次。
10. `position.locationOrder` 与 `possession.ownerOrder` 只接受非负整数，序列化 round-trip 不丢失。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/game/domain/entity/entityStore.test.ts`  
Expected: FAIL，模块尚不存在。

- [ ] **Step 3: 增加稳定 ID 与核心类型**

在 `worldEntity.ts` 增加：

```ts
export type PlayerEntityId = BrandedId<"PlayerEntityId">;
export type FactionId = BrandedId<"FactionId">;
export function asPlayerEntityId(raw: string): PlayerEntityId { return raw as PlayerEntityId; }
export function asFactionId(raw: string): FactionId { return raw as FactionId; }
export const PLAYER_ENTITY_ID: PlayerEntityId = asPlayerEntityId("player_0");
```

同一步把 `PlayerState`、`LocationEntry`、`NpcMemory`、`NpcInteraction`、`NpcEntry`、`ItemEntry`、`InvestigationApproach`、`WorldFactEntry`、`QuestObjective`、`QuestOutcome`、`QuestEntry`、`EnemyEntry`、`EndingEntry`、`EndingRequirement`、`FactionEntry` 原样移到 `worldEntries.ts`。`worldState.ts` 从该文件 import 并 re-export 这些类型；Entity Component 只 import `worldEntries.ts`，禁止 entity 目录反向 import `worldState.ts`。`BattleState`、`BattleStartSnapshot`、`EndingState`、`WorldState` 仍留在 `worldState.ts`。

`entityCore.ts` 精确导出：

```ts
export type EntityKind =
  | "player_character" | "npc" | "location" | "item"
  | "enemy" | "faction" | "quest" | "fact";
export type EntityLifecycle = "active" | "inactive" | "resolved" | "destroyed";
export type EntityId = PlayerEntityId | NpcId | LocationId | ItemId | EnemyId | FactionId | QuestId | FactId;
export type EntityCore<Id extends EntityId, Kind extends EntityKind> = Readonly<{
  id: Id;
  kind: Kind;
  name: string;
  createdAtTurn: number;
  lifecycle: EntityLifecycle;
}>;
```

- [ ] **Step 4: 定义固定 Component 与 8 类 EntityRecord**

组件必须为命名字段，而不是动态字典。共享与各 kind 组件逐字段复用当前稳定类型：

```ts
export type PositionComponent = Readonly<{
  locationId: LocationId;
  /** 当前地点成员列表内的稳定顺序；player 固定为 0。 */
  locationOrder: number;
}>;

export type PlayerIdentityComponent = Readonly<{ identity: string; stats: StatBlock }>;

export type NpcIdentityComponent = Readonly<{ role: string; description: string; tags: readonly string[] }>;
export type NpcStateComponent = Readonly<{ isCompanion: boolean; met: boolean; memory: NpcMemory }>;

export type LocationComponent = Readonly<{
  description: string;
  kind: LocationKind;
  // LocationEntry.scale 当前可选；保留缺省形状，读模型继续用 locationScaleOf() 解析为 scene。
  scale?: LocationScale;
  connectedLocationIds: readonly LocationId[];
  tags: readonly string[];
  town?: TownRuntimeState;
  unlocked: boolean;
  visited: boolean;
}>;

export type ItemPresentationComponent = Readonly<{
  description: string;
  kind: string;
  tags: readonly string[];
  category?: ItemCategory;
  rarity?: ItemRarity;
  level?: number;
  statLines?: readonly ItemStatLine[];
}>;

export type PossessionComponent = Readonly<{
  owner:
    | { readonly kind: "player"; readonly playerId: PlayerEntityId }
    | { readonly kind: "location"; readonly locationId: LocationId }
    | { readonly kind: "npc"; readonly npcId: NpcId }
    | { readonly kind: "none" };
  quantity: number;
  /** 当前 owner 容器内的稳定顺序；owner=none 时固定为 0。 */
  ownerOrder: number;
}>;

export type EnemyComponent = Readonly<{ tier: EnemyTier; stats: StatBlock; tags: readonly string[]; defeated: boolean }>;

export type FactionComponent = Readonly<{ attitudeToPlayer: number }>;

export type QuestComponent = Readonly<{
  description: string;
  objectives: readonly QuestObjective[];
  onSuccess: QuestOutcome;
  onFailure: QuestOutcome;
  tags: readonly string[];
  kind: QuestEntry["kind"];
  stage?: number;
  status: QuestEntry["status"];
}>;

export type FactComponent = Readonly<{
  text: string;
  source: FactSource;
  discovered: boolean;
  locationId?: LocationId;
  investigationLabel?: string;
  investigationApproaches?: readonly InvestigationApproach[];
}>;
```

不要在本任务拆分 `NpcMemory`；它在 Plan 3 才拆为人格/知识/关系组件。`NpcStateComponent.memory` 原样持有 `NpcMemory`。

总 Spec §5.2 的组件清单是建议边界而非要求 Plan 2 一次实现全部组件：`Goal/Knowledge/Relationship/FactionMembership/NarrativeRole` 留到 Plan 3/5。`PositionComponent` 本阶段也不另设独立状态版本；当前原子写入与冲突控制仍以 `GameRecord.revision`、command `basedOnRevision` 和 `EntityStore.version=1` 为唯一版本边界，避免在尚未拆表前制造第二套 CAS。将来若 Plan 7 拆分 Entity 持久化，再通过显式 schema migration 增加 component revision。

`EntityRecord` 是 8 分支判别联合；每个分支只包含该 kind 合法的组件：

```ts
export type PlayerEntityRecord = Readonly<{ core: EntityCore<PlayerEntityId, "player_character">; identity: PlayerIdentityComponent; position: PositionComponent }>;
export type NpcEntityRecord = Readonly<{ core: EntityCore<NpcId, "npc">; identity: NpcIdentityComponent; position: PositionComponent; npcState: NpcStateComponent }>;
export type LocationEntityRecord = Readonly<{ core: EntityCore<LocationId, "location">; location: LocationComponent }>;
export type ItemEntityRecord = Readonly<{ core: EntityCore<ItemId, "item">; presentation: ItemPresentationComponent; possession: PossessionComponent }>;
export type EnemyEntityRecord = Readonly<{ core: EntityCore<EnemyId, "enemy">; enemy: EnemyComponent; position: PositionComponent }>;
export type FactionEntityRecord = Readonly<{ core: EntityCore<FactionId, "faction">; faction: FactionComponent }>;
export type QuestEntityRecord = Readonly<{ core: EntityCore<QuestId, "quest">; quest: QuestComponent }>;
export type FactEntityRecord = Readonly<{ core: EntityCore<FactId, "fact">; fact: FactComponent }>;
export type EntityRecord =
  | PlayerEntityRecord | NpcEntityRecord | LocationEntityRecord | ItemEntityRecord
  | EnemyEntityRecord | FactionEntityRecord | QuestEntityRecord | FactEntityRecord;
```

`core.name` 来源与各字段语义（投影必须逐字可逆）：

- player_character：`name = PlayerState.name`；position 的 `locationId = currentLocationId`、`locationOrder = 0`。
- npc：`name = NpcEntry.name`；position = `NpcEntry.locationId`；`locationOrder` 来自该地点 `npcIds` 的索引。
- location：`name = LocationEntry.name`；`description` 存入 `LocationComponent.description`（当前 `LocationEntry.description` 不丢）。
- item：`name = ItemEntry.name`；`possession.quantity` 恒为 1（现有物品无堆叠）；`ownerOrder` 来自 `inventory` 或所属地点 `availableItemIds` 的索引。
- enemy：`name = EnemyEntry.name`；position = `EnemyEntry.locationId`；`locationOrder` 取 `enemies` 中的稳定索引（本阶段不生成地点 enemy 成员列表）；`enemy.defeated` 是 `defeatedEnemyIds` 的唯一来源。
- faction：`name = FactionEntry.name`；`FactionEntry.factionId` 现类型是普通 `string`，read model 保持 `string` 不变，仅在 store 边界用 `asFactionId()` 转为 `FactionId`（`FactionEntityRecord.core.id` 为 `FactionId`）。
- quest：`name = QuestEntry.name`。
- fact：`WorldFactEntry` 无玩家可见 `name` 字段，而 `EntityCore.name` 必填，故使用非私密、稳定的 `core.name = "fact:" + factId`；事实正文只存于 `FactComponent.text`，投影回 `WorldFactEntry` 时丢弃 core name。禁止把事实正文复制到 core，否则私密 Fact 会经 occupied-name 索引泄漏。fact 不携带 `PositionComponent`，其可选发现地点存于 `FactComponent.locationId`。

Lifecycle 映射是单向确定规则，不允许与组件双源漂移：quest `locked → inactive`、`active → active`、`completed|failed|closed → resolved`；enemy `defeated=false → active`、`defeated=true → resolved`。其他新建实体默认 `active`。Plan 2 只开放 NPC 的 `active/inactive` 切换；`resolved/destroyed` 保留在 core 模型中供后续实体类型使用，本阶段不提供泛化修改入口。`set_quest_status` 和 `set_enemy_defeated` 必须同时维护该映射，validator 对不一致记录返回 `component_lifecycle_mismatch`。`NpcStateComponent.memory.npcId` 也必须等于 `core.id`。

投影派生关系：`location.unlocked/visited` → `unlockedLocationIds/visitedLocationIds`；item `possession.owner` → `inventory`（owner=player）与各 `LocationEntry.availableItemIds`（owner=location）。owner 为 `npc` 或 `none` 的物品既不进 `inventory` 也不进任何 `availableItemIds`——这与当前 `give_item` 后物品离开背包且不可再被拾取的行为一致。`LocationEntry.npcIds` 按 active NPC 的 `position.locationOrder`、`inventory/availableItemIds` 按 item 的 `possession.ownerOrder` 排序，同序号再以 core ID 打破平局；这些玩家可见列表不能退化成全局 record 顺序。

NPC lifecycle 必须有确定投影语义：所有 NPC record 仍投影到 `npcs` 以保留稳定引用，但只有 `lifecycle="active"` 的 NPC 进入所在地点的 `LocationEntry.npcIds`；`inactive/resolved/destroyed` 不出现在场 NPC 投影中。`set_npc_lifecycle` 切回 active 时按其 `PositionComponent` 重新挂载。Entity Context 的 optional 扩展同样跳过 inactive/resolved/destroyed NPC。

- [ ] **Step 5: 实现只读 Store 与结构校验**

```ts
export type EntityStore = Readonly<{
  version: 1;
  records: readonly EntityRecord[];
}>;
export type EntityStoreValidationCode =
  | "invalid_store_version" | "invalid_record_shape" | "invalid_component_value"
  | "duplicate_entity_id" | "invalid_created_turn" | "invalid_lifecycle"
  | "kind_id_mismatch" | "component_id_mismatch" | "component_lifecycle_mismatch"
  | "missing_player" | "multiple_players";
export type EntityStoreValidationIssue = Readonly<{ code: EntityStoreValidationCode; entityId?: string }>;
export class EntityStoreInvariantError extends Error {
  readonly code: EntityStoreValidationCode;
  readonly entityId?: string;
  constructor(issue: EntityStoreValidationIssue);
}
export type ParseEntityStoreResult =
  | { readonly ok: true; readonly store: EntityStore }
  | { readonly ok: false; readonly issues: readonly EntityStoreValidationIssue[] };
export function createEntityStore(records: readonly EntityRecord[]): EntityStore;
export function parseEntityStore(value: unknown): ParseEntityStoreResult;
export function validateEntityStoreStructure(value: unknown): readonly EntityStoreValidationIssue[];
export function getEntity(store: EntityStore, id: EntityId | string): EntityRecord | undefined;
export function entitiesOfKind<K extends EntityKind>(store: EntityStore, kind: K): readonly Extract<EntityRecord, { core: { kind: K } }>[];
```

`parseEntityStore/validateEntityStoreStructure` 不能只依赖 TypeScript 静态类型：它们直接接受 `unknown`，对从 SQLite JSON 读回的未信任值按 kind 检查 exact keys、核心字段和所有嵌套 component 的完整 shape/value domain，拒绝多余 component、缺必需 component、错误 store version、负数/非整数 `locationOrder/ownerOrder` 与 quest/enemy lifecycle 漂移。未信任边界必须使用 `parseEntityStore` 的成功分支取得类型化 store 后才能调用 selector/reference validator；不得在调用前用类型断言跳过解析。`validateEntityStoreStructure` 是测试/诊断用的 issue-list facade。`createEntityStore` 不自动覆盖重复项；发现非法结构抛稳定 `EntityStoreInvariantError`，错误对象只含 code/entityId，不含完整实体正文。

- [ ] **Step 6: 测试与提交**

```bash
npm test -- src/game/domain/entity/entityStore.test.ts
npm run typecheck
git add src/game/domain/worldEntity.ts src/game/domain/worldEntries.ts src/game/domain/worldState.ts src/game/domain/entity src/game/domain/index.ts
git commit -m "feat(entity): define typed entity store"
```

---

### Task 2: 建立 Entity Store ↔ WorldState 兼容投影并升级 v3

**Consumes:** 8 类 EntityRecord。  
**Produces:** 唯一 projector；`WorldState.version=3` 携带 `entityStore`，旧数组为逐字可验证的派生结果。  
**Independent proof:** domain round-trip 和 projection mismatch 测试。

**Files:**

- Create: `src/game/domain/entity/entityProjection.ts`
- Create: `src/game/domain/entity/entityProjection.test.ts`
- Create: `src/game/domain/worldStateValidation.ts`
- Create: `src/game/domain/worldStateValidation.test.ts`
- Create: `src/game/domain/testing/worldStateFixture.testutil.ts`
- Modify: `src/game/domain/entity/index.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/worldState.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts`

- [ ] **Step 1: 写失败的双向投影测试**

构造包含全部 8 kind 的 legacy world fixture，断言：

- `compileEntityStoreFromCompatibilityProjection` 不改变稳定 ID、名称、顺序和组件内容；
- `projectEntityStore` 还原 `player/locations/currentLocationId/unlockedLocationIds/visitedLocationIds/npcs/items/inventory/worldFacts/quests/enemies/defeatedEnemyIds/factions`；
- NPC 位置会确定性生成 `LocationEntry.npcIds`，item owner 会生成 `inventory` 或单一 `availableItemIds`；
- `LocationEntry.npcIds`、`availableItemIds` 与 `inventory` 的既有顺序经 `locationOrder/ownerOrder` round-trip 后保持不变；
- inactive NPC 仍保留在 `npcs`，但不进任何 `LocationEntry.npcIds`；切回 active 后按 position 恢复挂载；
- 同一 NPC 同时出现在两个地点、item 同时属于玩家和地点、连接自环/非对称、quest objective 指向未知 ID 时返回稳定 issue；
- 同一地点 active NPC 的 `locationOrder` 或同一 owner item 的 `ownerOrder` 重复时返回稳定 issue；
- projection 被手工篡改时 `validateEntityCompatibilityProjection` 返回 `projection_mismatch`；
- store → projection → store 保留 `createdAtTurn`，不会把动态实体改回 turn 0。

- [ ] **Step 2: 定义精确投影接口**

```ts
export type EntityCompatibilityProjection = Readonly<{
  player: PlayerState;
  locations: readonly LocationEntry[];
  currentLocationId: LocationId;
  unlockedLocationIds: readonly LocationId[];
  visitedLocationIds: readonly LocationId[];
  npcs: readonly NpcEntry[];
  items: readonly ItemEntry[];
  inventory: readonly ItemId[];
  worldFacts: readonly WorldFactEntry[];
  quests: readonly QuestEntry[];
  enemies: readonly EnemyEntry[];
  defeatedEnemyIds: readonly EnemyId[];
  factions: readonly FactionEntry[];
}>;
export function projectEntityStore(store: EntityStore): EntityCompatibilityProjection;
export function compileEntityStoreFromCompatibilityProjection(input: {
  projection: EntityCompatibilityProjection;
  createdAtTurn: number;
  previousStore?: EntityStore;
}): EntityStore;
export type EntityReferenceIssueCode =
  | "unknown_location_ref" | "self_connection" | "asymmetric_connection"
  | "unknown_item_owner_ref" | "unknown_quest_objective_ref"
  | "unknown_npc_fact_ref" | "unknown_player_location"
  | "duplicate_location_order" | "duplicate_owner_order";
export type EntityReferenceIssue = Readonly<{ code: EntityReferenceIssueCode; entityId: string; referencedId?: string }>;
export type EntityProjectionIssue = Readonly<{
  code:
    | "projection_mismatch" | "npc_multiple_locations" | "npc_membership_mismatch"
    | "item_multiple_owners";
  field: string;
  entityId?: string;
}>;
export class EntityProjectionInvariantError extends Error {
  readonly code: EntityProjectionIssue["code"] | EntityReferenceIssueCode;
  readonly entityId?: string;
  constructor(issue: EntityProjectionIssue | EntityReferenceIssue);
}
export function validateCompatibilityProjectionInput(
  projection: EntityCompatibilityProjection,
): readonly EntityProjectionIssue[];
export function validateEntityReferences(store: EntityStore): readonly EntityReferenceIssue[];
export function validateEntityCompatibilityProjection(
  store: EntityStore,
  projection: EntityCompatibilityProjection,
): readonly EntityProjectionIssue[];
```

`compileEntityStoreFromCompatibilityProjection` 先调用 `validateCompatibilityProjectionInput`，因此 NPC 同时出现在两个 `LocationEntry.npcIds`、NPC 的 `locationId` 与唯一成员地点不一致、item 同时出现在 `inventory` 与一个/多个 `availableItemIds` 不会在编译时被“选一个”静默消解；有 issue 时抛只含 code/entityId 的 `EntityProjectionInvariantError`。初次编译按 legacy 成员列表索引写入 `locationOrder/ownerOrder`；传入 `previousStore` 时必须保留 legacy projection 无法表达的既有信息：record 的 `createdAtTurn/lifecycle`、inactive NPC 的 `locationOrder`，以及未出现在 `inventory/availableItemIds` 中的 item 的 `owner=npc|none` 和 `ownerOrder`。只有全新且无 previous record 的缺席 item 才编译为 `owner=none, ownerOrder=0`。建立 store 后再跑 structure/reference validation。引用校验至少覆盖：position/owner location、item owner NPC/player、地点自环与双向连接、quest objective、NPC known/hidden fact、player/current location，以及同一地点 active NPC 的 `locationOrder`、同一非 none owner 下 item 的 `ownerOrder` 不重复。数组比较按稳定 ID、顺序和字段深比较，不能只比长度。

`entityStore` 外还有 battle/endings 对 Entity 的权威引用，不能被 store-only validator 遗漏。在 `worldStateValidation.ts` 定义：

```ts
export type WorldStateEntityReferenceIssue = Readonly<{
  code:
    | "unknown_battle_enemy_ref" | "unknown_battle_combatant_enemy_ref"
    | "invalid_battle_snapshot" | "unknown_ending_requirement_ref"
    | "unknown_resolved_ending_ref";
  entityId: string;
  referencedId?: string;
}>;
export function validateWorldStateEntityReferences(
  worldState: WorldState,
): readonly WorldStateEntityReferenceIssue[];
```

它校验 active/resolved battle 的 `enemyId/enemyIds`、modern combatant 中的 enemy source、active battle 的 `preBattleSnapshot.entityStore` 自身 structure/reference（防止战败时恢复损坏 store）、`EndingRequirement` 对 quest/fact/NPC 的引用，以及 `ending.endingId` 必须存在于 `endings`。该文件可 import `WorldState` 和 entity selector；entity 目录不得反向 import 它。

各实体数组与 `unlockedLocationIds/visitedLocationIds/defeatedEnemyIds` 由 `projectEntityStore` 按 store record 顺序确定性输出；这些状态索引的规则消费方用顺序无关的 `.includes()`，解锁地点 Prompt 顺序允许随 record 顺序确定性归一。玩家可见且由既有顺序驱动选项/读模型的 `LocationEntry.npcIds`、`availableItemIds` 与 `inventory` 则必须分别按 `locationOrder/ownerOrder` 还原，不得按集合比较，也不得把拾取/移动先后顺序静默改成全局实体创建顺序。

- [ ] **Step 3: 升级 WorldState v3 并让构造器只从 projector 写兼容字段**

```ts
export type WorldState = {
  readonly version: 3;
  readonly generation: GenerationMetadata;
  readonly entityStore: EntityStore;
  // 以下集合/索引是 entityStore 的兼容投影，生产写入禁止单独修改
  readonly player: PlayerState;
  readonly locations: readonly LocationEntry[];
  readonly currentLocationId: LocationId;
  readonly unlockedLocationIds: readonly LocationId[];
  readonly visitedLocationIds: readonly LocationId[];
  readonly npcs: readonly NpcEntry[];
  readonly items: readonly ItemEntry[];
  readonly inventory: readonly ItemId[];
  readonly worldFacts: readonly WorldFactEntry[];
  readonly quests: readonly QuestEntry[];
  readonly enemies: readonly EnemyEntry[];
  readonly defeatedEnemyIds: readonly EnemyId[];
  readonly factions: readonly FactionEntry[];
  // 非实体权威字段：不进 entityStore，由规则/应用层在 store 之外维护
  readonly battle: BattleState;
  readonly endings: readonly EndingEntry[];
  readonly ending: EndingState;
  readonly eventLedger: readonly GameEvent[];
};
```

`createInitialWorldState` 先建立 player + starting location records，再调用 `projectEntityStore`；不要先写两套对象。其唯一生产调用方 `compileOpeningGenerationCandidate` 传 `startingItemIds: []`，故初始 store 无 item record、`inventory` 为空；`inventory` 一律由 `possession.owner = player` 的 item record 派生。不得保留参数却静默丢弃非空 `startingItemIds`：本 Plan 保留现有签名，但非空时抛稳定 `initial_item_details_required`，并把 `worldState.test.ts` 原先只给 ID 的 fixture 改为空数组与拒绝断言。若未来要带初始物品，必须先把签名升级为携带完整 `ItemEntry`，不能从 ID 伪造实体。为保证本 Task 结束时应用仍可编译、可玩，`appendLocation/appendNpc/appendItem/appendEnemy` 暂作为明确标记 `@deprecated` 的过渡适配器：它们将旧 entry 合入当前兼容投影，立即重建 store 并再投影，不得只追加数组。Task 3/4 迁移完全部调用方后删除这些适配器。

`worldState.ts` 同时定义稳定构造错误，不用字符串 message 充当协议：

```ts
export class InitialWorldStateInvariantError extends Error {
  readonly code = "initial_item_details_required" as const;
}
```

现有测试中存在“起点先引用尚未创建的地点/NPC，再通过 spread 补数组”的临时非法 fixture，不能让生产构造器或 projector 为测试放宽引用校验。在 `domain/testing/worldStateFixture.testutil.ts` 提供仅供 `*.test.ts`/`*.testutil.ts` 使用的 `createWorldStateFixture`：调用方一次传入完整 `EntityCompatibilityProjection` 与 `generation/battle/endings/ending/eventLedger`，helper 先编译 store、再 projector 生成 v3 `WorldState`。任何生产文件 import 该 helper 都由 boundary test 拒绝；故意构造损坏存档的测试必须从合法 fixture 深拷贝后篡改，并明确标注 corruption case。

```ts
export type WorldStateFixtureInput = Readonly<{
  generation: GenerationMetadata;
  projection: EntityCompatibilityProjection;
  createdAtTurn?: number;
  battle?: BattleState;
  endings?: readonly EndingEntry[];
  ending?: EndingState;
  eventLedger?: readonly GameEvent[];
}>;
export function createWorldStateFixture(input: WorldStateFixtureInput): WorldState;
```

缺省值固定为 `createdAtTurn=0`、`battle={status:"idle"}`、`endings=[]`、`ending=null`、`eventLedger=[]`；helper 不读取时间、随机数或 AI。

- [ ] **Step 4: 开局编译建立完整 store**

`compileOpeningGenerationCandidate` 先构造通过 opening approval 的 legacy entries，再一次调用 `compileEntityStoreFromCompatibilityProjection({createdAtTurn:0})` 和 projector。断言 opening player/location/NPC/fact/quest 各有唯一 record，兼容 GameSessionView 内容不变。

- [ ] **Step 5: 更新 v3 fixtures、运行 domain/opening tests 并提交**

优先更新共享 testutil；对于需要前向引用或一次装入多类实体的 fixture，改用 `createWorldStateFixture`，禁止在测试中用 `as WorldState`、`as any` 或单独 spread legacy 数组绕过 `entityStore`。

```bash
npm test -- src/game/domain/entity/entityProjection.test.ts src/game/domain/worldStateValidation.test.ts src/game/domain/worldState.test.ts src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts
npm run typecheck
git add src/game/domain/entity src/game/domain/testing/worldStateFixture.testutil.ts src/game/domain/worldStateValidation.ts src/game/domain/worldStateValidation.test.ts src/game/domain/worldState.ts src/game/domain/worldState.test.ts src/game/gameplay/rpg/openingGeneration
git commit -m "refactor(entity): make world state project entity store"
```

---

### Task 3: 建立规则可信 EntityMutation 并迁移基础行动、NPC、事实与任务写入

**Consumes:** 当前 EntityStore + 封闭 `EntityMutation[]`。  
**Produces:** 原子 next store + 全套兼容投影；规则代码不再 map/拼接 legacy collections。  
**Independent proof:** mutation 单测及 ruleEngine 原有测试。

**Files:**

- Create: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`
- Create: `src/game/gameplay/rpg/entityWorld/entityMutation.test.ts`
- Create: `src/game/gameplay/rpg/entityWorld/index.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts`（仅迁移手写 v2 fixture）
- Modify: `src/dependencyBoundaries.test.ts`

- [ ] **Step 1: 写失败测试，固定 mutation 原子性和拒绝语义**

测试：成功移动 player 会同时更新 position/currentLocation/visited；`move_npc` 只接受 NPC 并刷新两地投影；解锁/到访分别只改各自状态；拾取 item 会从地点转到 player 且不双重持有；交给 NPC 会从 inventory 消失并把 owner 设为 NPC；NPC memory replacement 不触碰 identity/position；发现 fact 幂等；quest status 与 enemy defeated 按 Task 1 映射同时更新 lifecycle；任一 command 引用非法则整批零修改。NPC 移入新地点或 item 转给新 owner 时，分别取目标容器当前最大 `locationOrder/ownerOrder + 1`，因此追加顺序与现有行为一致；重复执行相同绝对归属命令不再次改变顺序。

- [ ] **Step 2: 定义规则可信 mutation 联合**

```ts
export type EntityMutation =
  | { readonly kind: "move_player"; readonly toLocationId: LocationId; readonly markVisited: true }
  | { readonly kind: "move_npc"; readonly npcId: NpcId; readonly toLocationId: LocationId }
  | { readonly kind: "set_location_unlocked"; readonly locationId: LocationId; readonly unlocked: boolean }
  | { readonly kind: "set_location_visited"; readonly locationId: LocationId; readonly visited: boolean }
  | { readonly kind: "replace_npc_state"; readonly npcId: NpcId; readonly npcState: NpcStateComponent }
  | { readonly kind: "transfer_item"; readonly itemId: ItemId; readonly owner: PossessionComponent["owner"] }
  | { readonly kind: "discover_fact"; readonly factId: FactId }
  | { readonly kind: "set_quest_status"; readonly questId: QuestId; readonly status: QuestComponent["status"] }
  | { readonly kind: "set_enemy_defeated"; readonly enemyId: EnemyId; readonly defeated: boolean }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: NpcId; readonly lifecycle: "active" | "inactive" }
  | { readonly kind: "replace_location_component"; readonly locationId: LocationId; readonly location: LocationComponent }
  | { readonly kind: "create_entities"; readonly records: readonly EntityRecord[] };

export type EntityMutationErrorCode =
  | "unknown_entity_id"
  | "duplicate_entity_id"
  | "wrong_entity_kind"
  | "invalid_reference"
  | "invalid_lifecycle_transition"
  | "structure_invalid";

export type ApplyEntityMutationsResult =
  | { readonly ok: true; readonly worldState: WorldState }
  | { readonly ok: false; readonly code: EntityMutationErrorCode; readonly entityId?: string };

export function applyEntityMutations(
  worldState: WorldState,
  mutations: readonly EntityMutation[],
): ApplyEntityMutationsResult;
export class EntityMutationInvariantError extends Error {
  readonly code: EntityMutationErrorCode;
  readonly entityId?: string;
  constructor(input: { readonly code: EntityMutationErrorCode; readonly entityId?: string });
}
```

实现必须先在局部 store 应用整批、跑 structure/reference validation，再一次 projector；失败分支不携带 partial state，且入参 `WorldState` 保持同一引用、内容未修改。成功时返回的 `WorldState` 用 projector 重建全部实体兼容投影字段，并逐字携带入参 `worldState` 的 `version/generation/battle/endings/ending/eventLedger`——projector 只覆盖实体字段，这些非实体权威字段由调用方在 mutation 结果上继续维护，`applyEntityMutations` 本身不改它们。

- [ ] **Step 3: 迁移 resolveByType**

- `move` → `move_player`；mutation 成功后，调用方继续在结果上应用原有非实体写入：把 `battle` 从 `resolved` 清回 `idle`、追加 eventLedger（`resolveByType` 当前行为）。
- `talk` / `give_item` → `replace_npc_state`；
- `take_item` → `transfer_item`（owner = `{kind:"player", playerId}`）；
- `give_item` → `transfer_item`（owner = `{kind:"npc", npcId}`）+ `replace_npc_state`；npc 持有的物品不进 `inventory` 也不进任何 `availableItemIds`，与当前“离开背包且不可再拾取”行为一致。
- `investigate` / 自动发现 → `discover_fact`；
- eventLedger、battle runtime 仍由规则在 mutation 成功后维护，不能塞进 Entity Store（endings 属世界演化写入，见 Task 4）。

保留现有 `StateChange` path 和玩家反馈文本，不改 API/read model。`StateChange` 仍是只读的变化描述元数据（`src/game/domain/resolvedEvent.ts`），不作为写入管道。

- [ ] **Step 4: 迁移 quest 与 knowledge 写入**

`reconcileQuests` 只用 `set_quest_status`；`propagateKnownFacts` 先由规则计算新的 `NpcStateComponent`，再批量 `replace_npc_state`。Plan 3 前不改变 affinity/knowledge 算法。

`updateNpcMemory` 继续返回 `NpcEntry`，不修改其公开契约；`resolveByType` 只取 `npcAfter.memory` 构造 `NpcStateComponent` 并交给 `replace_npc_state`，避免为迁移扩大 NPC 记忆 helper 范围。

- [ ] **Step 5: 加 boundary guard、运行测试并提交**

`entityWorld/index.ts` 是 gameplay facade；application 不得 deep-import内部文件。domain entity 模块不得 import gameplay/application/UI；`domain/testing/worldStateFixture.testutil` 只允许 `*.test.ts` 与 `*.testutil.ts` import。在 `dependencyBoundaries.test.ts` 的 `FACADES` 数组追加一条（anchors 用于自动生成 deep-import 违例合成用例，机制与既有条目一致）：

```ts
{ name: "entityWorld", path: "@/game/gameplay/rpg/entityWorld", anchors: ["entityMutation", "proposedEntityCommand"] }
```

```bash
npm test -- src/game/gameplay/rpg/entityWorld src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts
npm run test:boundaries
npm run typecheck
git add src/game/gameplay/rpg/entityWorld src/game/gameplay/rpg/ruleEngine src/dependencyBoundaries.test.ts
git commit -m "refactor(entity): route rule mutations through entity store"
```

---

### Task 4: 迁移候选事件、世界演化、揭示游标与战斗检查点

**Consumes:** 已审批 candidate effect / WorldDelta / battle resolution。  
**Produces:** 所有剩余生产实体写入都经 mutation；战败完整恢复战前 Entity Store。  
**Independent proof:** world evolution、candidate event、battle rollback 测试。

**Files:**

- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts`
- Modify: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.test.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/storyReveal.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/storyReveal.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts`
- Modify: `src/game/domain/worldState.ts` (`BattleStartSnapshot`)
- Modify: `src/game/application/performBattleRound.ts`（失败/撤退恢复的真正落点）
- Modify: `src/game/application/performBattleRound.test.ts`
- Modify: `src/game/application/performTurn.test.ts`（仅更新 v2→v3 fixture 与既有恢复断言）

- [ ] **Step 1: 写战斗失败 store 回滚失败测试（针对 performBattleRound 恢复路径）**

现状：`battleResolver` 只在开战时捕获 `battle.preBattleSnapshot` 并在胜负时把 `battle` 置为 resolved，**它本身不做恢复**；战前恢复发生在应用层 `performBattleRound.ts`（`performTurn` 调用），在 defeat/withdraw 时消费 `preBattleSnapshot` 还原 player stats / defeatedEnemyIds / eventLedger 并把 battle 置 idle。因此回滚测试必须扩展 `performBattleRound.test.ts` 走这条真实路径，而不是只测 `battleResolver`。

流程：战前捕获 `entityStore` → 开战（快照存 store）→ 模拟战中/结算前实体变化 → HP 归零 → 经 `performBattleRound` 得到 defeat → 断言失败后的 `entityStore` 与战前深相等、兼容投影一致、eventLedger 回滚到战前账本、battle 为 idle、未被击败的敌人仍可重战；另以 flee 覆盖 withdraw 同样恢复；随后重赛胜利只将目标 enemy 的 defeated/lifecycle 更新一次。该测试不能只比 `defeatedEnemyIds`。

- [ ] **Step 2: 让 BattleStartSnapshot 持有权威 store，并改写 performBattleRound 恢复**

```ts
export type BattleStartSnapshot = Readonly<{
  entityStore: EntityStore;
  eventLedger: readonly GameEvent[];
}>;
```

- `battleResolver.startBattle`（legacy 与 modern 两条分支）改为捕获 `{ entityStore: ws.entityStore, eventLedger: ws.eventLedger }`，取代原 `playerStats/defeatedEnemyIds`——玩家属性与击败标记都已在 store 内。
- `performBattleRound` 的 defeat/withdraw 分支改为用快照 store 恢复：以 `projectEntityStore(snapshot.entityStore)` 重建全部实体兼容投影字段，再从 `afterWorldState` 逐字携带 `generation/endings/ending`、用快照 `eventLedger` 覆盖、把 `battle` 置 `idle`；不得再逐字段读 `playerStats/defeatedEnemyIds`。storyState 的 `battleCheckpoint`/narrative 恢复逻辑保持不变。
- 胜利分支由 `battleResolver` 用 `set_enemy_defeated`（对每只 downed enemy 一条，组成一批）写入，替代直接拼 `defeatedEnemyIds`。
- active battle 的 HP/energy/queue 仍只在 `battle` runtime，不进入 Entity component。

- [ ] **Step 3: 迁移 candidate event 与 reveal**

- `npc_reveals_fact` → `discover_fact`；
- `npc_changes_stance` → 规则计算后 `replace_npc_state`；
- `location_state_changes` 的 `unlocked` → `set_location_unlocked`，`visited` → `set_location_visited`；`storyReveal` 解锁新地点也用 `set_location_unlocked`；
- `enemy_appears` 只改 battle runtime，不伪造 enemy component；但必须与 `startBattle` 一样写入 `{entityStore,eventLedger}` 的 `preBattleSnapshot`，不得留下无检查点的 active battle。

- [ ] **Step 4: 迁移 materializeWorldDelta**

审批器仍只负责 schema/引用/预算/空间校验和铸 ID。materializer 把 approved entries 编译为 EntityRecord（`createdAtTurn=ss.turnNumber`），以一批 `create_entities + replace_location_component + set_location_unlocked` 应用；由 projector 生成 NPC/物品挂载和双向连接。`town_building` 不创建 Location Entity，仍只更新既有 town location component。`approved.newEndings` 不是实体：在 mutation 批成功后，把 `endings: [...ws.endings, ...approved.newEndings]` 合并进结果（与 battle/eventLedger 同属非实体字段，不进 store）。

增加断言：同批任一新实体/引用非法时，`applyEntityMutations` 返回失败且 materializer 抛只含稳定 code/entityId 的 `EntityMutationInvariantError`，入参 world/story 保持原引用、不产生任何部分 preview；这是已审批数据违反程序不变量的内部错误，不新增 provider 修复语义。合法 next-act 的 minted IDs、任务目标、town slot、reveal 和 budget 与当前行为一致。

- [ ] **Step 5: 扫描剩余裸写入**

在扫描前删除 Task 2 的 `appendLocation/appendNpc/appendItem/appendEnemy` 过渡适配器；若仍有调用点，继续迁移而不保留第二写入入口。

Run:

```bash
rg -n "(locations|npcs|items|worldFacts|quests|enemies|factions):\s*(\[|[^,]*\.map)|inventory:\s*(\[|[^,]*\.filter)|defeatedEnemyIds:\s*\[" src/game/domain src/game/gameplay/rpg src/game/application --glob '*.ts' --glob '!*.test.ts' --glob '!**/entityProjection.ts'
```

Expected: 只剩 WorldState 类型/初始投影、AI/read-model 局部 DTO 和测试辅助；生产状态写入无命中。逐个审查命中，不能通过改写正则藏掉。

- [ ] **Step 6: 运行测试并提交**

```bash
npm test -- src/game/gameplay/rpg/candidateEvents src/game/gameplay/rpg/worldEvolution src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts src/game/gameplay/rpg/ruleEngine/modernBattleResolver.test.ts src/game/application/performBattleRound.test.ts
npm run test:game-gameplay
npm run test:game-application
npm run typecheck
git add src/game/domain/worldState.ts src/game/gameplay/rpg/candidateEvents src/game/gameplay/rpg/worldEvolution src/game/gameplay/rpg/ruleEngine/battleResolver.ts src/game/gameplay/rpg/ruleEngine/battleResolver.test.ts src/game/application/performBattleRound.ts src/game/application/performBattleRound.test.ts src/game/application/performTurn.test.ts
git commit -m "refactor(entity): project evolution and battle through entity store"
```

---

### Task 5: 在 SQLite/CAS 边界验证 v3 store 与兼容投影

**Consumes:** 待创建、规则提交或 narrative write-back 的 `WorldState.version=3`。  
**Produces:** 坏 store/坏引用/投影漂移安全失败；v2 明确拒绝；正常 CAS 语义不变。  
**Independent proof:** SQLite round-trip、corrupt classification、stale CAS tests。

**Files:**

- Modify: `src/game/application/server/persistence/gameRepository.ts`
- Create: `src/game/application/server/persistence/worldStatePersistenceValidation.ts`
- Create: `src/game/application/server/persistence/worldStatePersistenceValidation.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/application/server/persistence/gameRepository.test.ts`
- Modify: `src/game/application/stateCommit.test.ts`
- Modify: `src/game/application/sceneWriteBack.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖：v2 → `UNSUPPORTED_RECORD`；v3 缺 store/重复 ID/未知位置/非对称连接/投影篡改，或 malformed generation/battle/ending/eventLedger → `ENTITY_STATE_INVALID`；合法 v3 创建/reload 深相等；SQLite repository 的 create/replace/applyState/applySceneWriteBack 对非法 next state 零写入；active/no-active/stale predicate 与非法 next state 同时出现时仍优先返回既有 `ACTIVE_GAME_EXISTS`、`NO_ACTIVE_GAME` 或 `STALE_GAME_REVISION`，不泄漏存档正文。`stateCommit.test.ts` 与 `sceneWriteBack.test.ts` 只做合法 v3 facade 回归和 fixture 迁移，不要求任意测试 fake repository 重复实现 SQLite 的损坏分类。

- [ ] **Step 2: 扩展稳定损坏分类**

```ts
export type CorruptGameReason =
  | "UNPARSEABLE_RECORD" | "VERSION_MISMATCH" | "UNSUPPORTED_RECORD"
  | "ENTITY_STATE_INVALID";
```

在 `worldStatePersistenceValidation.ts` 新增封闭返回值的 validator：

```ts
export type PersistableWorldStateValidationResult =
  | { readonly ok: true; readonly value: WorldState }
  | {
      readonly ok: false;
      readonly code:
        | "wrong_world_version" | "invalid_world_envelope" | "invalid_entity_store"
        | "invalid_entity_reference" | "projection_mismatch";
      readonly issueCode?: string;
      readonly entityId?: string;
    };
export function validatePersistableWorldState(
  value: unknown,
): PersistableWorldStateValidationResult;
```

它先 exact-key 检查 v3 envelope，使用 `parseEntityStore` 得到类型化 store，再由 `projectEntityStore` 生成可信兼容字段并与原 JSON 中的 `player/locations/currentLocationId/unlockedLocationIds/visitedLocationIds/npcs/items/inventory/worldFacts/quests/enemies/defeatedEnemyIds/factions` 深比较。`generation/battle/endings/ending/eventLedger` 也必须按各自现有判别联合完整解析；成功返回值用解析后的非实体字段 + store projector 结果重新组装，不直接信任原兼容数组。随后调用 store reference、world envelope reference 和 projection validators。不得仅 `as unknown as WorldState`；失败分支不携带实体或事实正文。若现有 domain 尚无 generation/battle/ending/GameEvent parser，本文件实现私有 exact-key parser，不把通用任意 JSON 工具暴露成业务写入口。

`validatePersistableWorldState` 还必须调用 `validateWorldStateEntityReferences`，因此 battle/ending 对 Entity 的外围引用也在同一存储门禁内。读取损坏记录返回 `ENTITY_STATE_INVALID`；写入 port 不新增业务分支，验证失败沿用 `{ok:false,code:"INFRASTRUCTURE_FAILURE"}` 并只记录白名单 validator code。

- [ ] **Step 3: 在 write 前和 read 后验证**

create/replace/applyState/applySceneWriteBack 为保持既有错误优先级，必须先在 write transaction 内确认 active game/revision/job predicate，再验证 next world、序列化并执行原有 INSERT/单条 CAS SQL；这样“已有 active game + 非法 initial state”仍返回 `ACTIVE_GAME_EXISTS`，“stale revision + 非法 next state”仍返回 `STALE_GAME_REVISION`。不得为了预验证把 CAS 拆成事务外的先读后写，也不得在 predicate 检查前序列化无效状态。失败只记录白名单 code，不记录完整实体/Prompt/玩家输入。CAS 更新必须保持单条 SQL 和 revision +1，不新建 entity 表、不拆事务。读路径 `sqliteGameRepository.interpretGameRow` 把可接受的 `worldState.version` 从 2 改为 3：world version 1/2 → `UNSUPPORTED_RECORD`，world version 3 → 交 `validatePersistableWorldState`，其余 → `VERSION_MISMATCH`；现有 StoryState 版本分类原样保留，`record_version` 保持 1 不变（见 Global Constraints）。

- [ ] **Step 4: 测试与提交**

```bash
npm test -- src/game/application/server/persistence/worldStatePersistenceValidation.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/application/server/persistence/gameRepository.test.ts src/game/application/stateCommit.test.ts src/game/application/sceneWriteBack.test.ts
npm run test:game-application
npm run typecheck
git add src/game/application/server/persistence src/game/application/stateCommit.test.ts src/game/application/sceneWriteBack.test.ts
git commit -m "feat(entity): validate entity store at persistence boundary"
```

---

### Task 6: 建立不可信 ProposedEntityCommand parser 与审批器

**Consumes:** 未信任 JSON + 本次调用显式 allowlist。  
**Produces:** 可交给 `applyEntityMutations` 的有限批准命令；任意 patch/未知字段全部拒绝。  
**Independent proof:** parser/approval 纯测试；本任务不改 provider Prompt 或调用次数。

**Files:**

- Create: `src/game/gameplay/rpg/entityWorld/proposedEntityCommand.ts`
- Create: `src/game/gameplay/rpg/entityWorld/proposedEntityCommand.test.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/index.ts`

- [ ] **Step 1: 写失败测试固定攻击面**

接受三类提案；拒绝 `op/path/value`、动态 component 名、extra key、player movement、未知 ID、错误 kind、未授权实体（`place_item` 的目标 NPC 也必须授权）、未授权目标地点、非 active 地点/物品、`immovableEntityIds` 中的 active battle actor 移动、把 resolved/destroyed 实体恢复或重新放置。多条提案中一条失败则整批拒绝。幂等性（对应 spec §5.3）本阶段由“绝对赋值命令”保证：同一 approved command 对等价 store 应用两次后必须深相等，不得采用累加 delta。本 Plan 命令未接 provider，因此不伪造持久化“已消费 command ID”；真正的重试去重在后续接入 Event/command ledger 时以 server provenance 完成。

- [ ] **Step 2: 定义封闭 proposal 与审批上下文**

```ts
export type ProposedEntityCommand =
  | { readonly kind: "move_npc"; readonly npcId: string; readonly toLocationId: string }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: string; readonly lifecycle: "active" | "inactive" }
  | {
      readonly kind: "place_item";
      readonly itemId: string;
      readonly owner:
        | { readonly kind: "location"; readonly locationId: string }
        | { readonly kind: "npc"; readonly npcId: string };
    };

export type EntityCommandApprovalContext = Readonly<{
  allowedEntityIds: readonly string[];
  allowedLocationIds: readonly string[];
  immovableEntityIds: readonly string[];
  provenance: Readonly<{ jobId: string; basedOnRevision: number }>;
}>;
```

`parseProposedEntityCommands(value)` 要求 root 为数组、每项 only-known-keys；`approveProposedEntityCommands(store, proposals, context)` 逐项把字符串解析回现有品牌 ID，输出 `ApprovedEntityCommand[]`，并附 server provenance。不得让 proposal 自带 actionId/eventId/revision。

```ts
export type EntityCommandProvenance = Readonly<{ jobId: string; basedOnRevision: number }>;
export type ApprovedEntityCommand =
  | { readonly kind: "move_npc"; readonly npcId: NpcId; readonly toLocationId: LocationId; readonly provenance: EntityCommandProvenance }
  | { readonly kind: "set_npc_lifecycle"; readonly npcId: NpcId; readonly lifecycle: "active" | "inactive"; readonly provenance: EntityCommandProvenance }
  | {
      readonly kind: "place_item";
      readonly itemId: ItemId;
      readonly owner:
        | { readonly kind: "location"; readonly locationId: LocationId }
        | { readonly kind: "npc"; readonly npcId: NpcId };
      readonly provenance: EntityCommandProvenance;
    };

export type ParseProposedEntityCommandsResult =
  | { readonly ok: true; readonly proposals: readonly ProposedEntityCommand[] }
  | { readonly ok: false; readonly code: "root_not_array" | "unknown_kind" | "unknown_key" | "invalid_field"; readonly index?: number };
export type ApproveProposedEntityCommandsResult =
  | { readonly ok: true; readonly commands: readonly ApprovedEntityCommand[] }
  | {
      readonly ok: false;
      readonly code:
        | "unknown_entity" | "wrong_entity_kind" | "entity_not_allowed"
        | "location_not_allowed" | "entity_immovable" | "invalid_entity_lifecycle"
        | "invalid_lifecycle_transition";
      readonly index: number;
      readonly entityId?: string;
    };
export function parseProposedEntityCommands(value: unknown): ParseProposedEntityCommandsResult;
export function approveProposedEntityCommands(
  store: EntityStore,
  proposals: readonly ProposedEntityCommand[],
  context: EntityCommandApprovalContext,
): ApproveProposedEntityCommandsResult;
export function entityMutationsForApprovedCommands(
  commands: readonly ApprovedEntityCommand[],
): readonly EntityMutation[];
```

批准命令到 `EntityMutation` 的 1:1 映射（交由 `applyEntityMutations`）：`move_npc` → `move_npc`（projector 随之刷新两地 `LocationEntry.npcIds`）；`set_npc_lifecycle` → `set_npc_lifecycle`；`place_item` → `transfer_item`（owner=npc 的物品按 Task 1 语义不进 `inventory`/`availableItemIds`）。审批时 subject 与目标分别校验 kind、allowlist 和 lifecycle：location/item 必须 active；NPC 可在 active/inactive 间受限移动或切换，但 resolved/destroyed 不可恢复；`place_item.owner.kind="npc"` 时目标 NPC 也必须存在、获准且未 resolved/destroyed。`immovableEntityIds` 由可信调用方根据 active battle actor 构造，proposal 不能自带或覆盖。provenance 只用于审计日志，不参与规则数值映射；Plan 4 引入稳定 Event 前，因果来源只能绑定可信 `jobId + basedOnRevision`，不得伪造 `sourceEventId`。

- [ ] **Step 3: 明确未接 provider**

本 Plan 不向 Narrative Bundle schema 增加 `entityCommands`。测试 `liveNarrativeBundleSource` 的 output contract 与 provider 调用数保持不变。该入口只为后续 Plan 3/6 提供受控扩展；在接入前 AI 对既有实体仍是零更新权限。

- [ ] **Step 4: 测试与提交**

```bash
npm test -- src/game/gameplay/rpg/entityWorld/proposedEntityCommand.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts
npm run typecheck
git add src/game/gameplay/rpg/entityWorld
git commit -m "feat(entity): approve bounded entity commands"
```

---

### Task 7: 用 Entity 规则闭包驱动 Narrative Context 投影

**Consumes:** 当前 action/job、目标转换、当前位置、Entity Store。  
**Produces:** mandatory closure + optional related summaries；生产 narrative bundle 不再直接遍历 legacy arrays 作为事实源。  
**Independent proof:** projection/context tests，Prompt 隐私与 manifest 回归。

**Files:**

- Create: `src/game/application/entityContextProjection.ts`
- Create: `src/game/application/entityContextProjection.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.test.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/worldNarrativeContext.ts`
- Modify: `src/game/application/server/ai/narrativeContext/worldNarrativeContext.test.ts`

- [ ] **Step 1: 写失败测试固定两阶段选择**

世界至少有两个地点、三个 NPC、物品/敌人/事实/主线；当前回合只引用其中一部分。断言 mandatory IDs 精确包含：player、当前位置、焦点 NPC、action target、active quest、当前 objective target、mandatory beat subjects、这些实体直接引用的地点/事实；不因 AI prose 中出现陌生名字扩展。optional 只沿一跳 location membership/quest objective 扩展，稳定 ID 排序并有数量上限。

- [ ] **Step 2: 定义安全 projection**

```ts
export type NarrativeEntitySummary = Readonly<{
  id: string;
  kind: EntityKind;
  name: string;
  summary: string;
  locationId?: string;
}>;
export type EntityContextProjection = Readonly<{
  mandatory: readonly NarrativeEntitySummary[];
  optional: readonly NarrativeEntitySummary[];
  occupiedNames: Readonly<Record<"location" | "npc" | "item" | "enemy" | "quest", readonly string[]>>;
}>;
export function buildEntityContextProjection(input: {
  worldState: WorldState;
  storyState: StoryState;
  job: PendingNarrativeJob;
  optionalLimit?: number;
}): EntityContextProjection;
```

NPC summary 只能含公开 identity、位置、目标与焦点 NPC 已批准 response policy/最近五条交互；非焦点 NPC 不含 interaction history、hidden fact ID/正文或关系裸值。Fact 只有 discovered 且不属于任何 NPC hidden 集合时可带正文。

`occupiedNames` 只覆盖当前 WorldDelta 可创建且需防撞名的五类命名实体；不包含 player/faction/fact，尤其不得把 Fact core name 或 text 当作撞名词典下发。

- [ ] **Step 3: 迁移三条上下文投影**

- `narrativeBundleContext`：实体详情来自新 projection；全局 occupied names 只用于撞名审批，仍是紧凑索引。
- `sceneGenerationContext`：用 store selector 解析当前地点/在场/目标/事实，输出 DTO shape 不变。
- `worldNarrativeContext`：用 store 生成 entity index 与 optional per-entity block，不读 `eventLedger`。

保持 Plan 1 的 block ID/authority/slot/budget；decision bundle 仍附 body-free manifest，正常路径仍一次 `aiClient.complete`。

- [ ] **Step 4: 隐私与预算断言**

Prompt 必须包含 mandatory closure 中每个 Entity 的当前安全全貌与焦点 NPC 五条交互；不得因此将全部 Entity 或完整 store 注入 Prompt。不得包含无关 NPC 私密正文、私密 Fact 的 core name/text、完整 store JSON、eventLedger、generation seed 或裸 affinity。manifest 只含允许引用的 block/source metadata，不含玩家原文和 hidden fact refs。

- [ ] **Step 5: 测试与提交**

```bash
npm test -- src/game/application/entityContextProjection.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/server/ai/narrativeContext src/game/application/server/ai/liveNarrativeBundleSource.test.ts
npm run test:game-application
npm run typecheck
git add src/game/application/entityContextProjection.ts src/game/application/entityContextProjection.test.ts src/game/application/sceneGenerationContext.ts src/game/application/sceneGenerationContext.test.ts src/game/application/server/ai/narrativeContext src/game/application/server/ai/liveNarrativeBundleSource.test.ts
git commit -m "refactor(narrative): project context from entity store"
```

---

### Task 8: 增加跨层 Entity 一致性 Journey 与完整游戏证明

**Consumes:** v3 runtime 全链。  
**Produces:** 每个关键回合 store、兼容投影、存档 reload 和战斗 checkpoint 始终一致。  
**Independent proof:** 新 journey + 现有短/中篇 journeys。

**Files:**

- Create: `src/game/application/testing/entityProjectionJourney.test.ts`
- Modify: `src/game/application/testing/providerTriggerMatrix.test.ts` only for v3 fixtures, not semantics
- Modify: 由本任务 fixture audit 命中的既有 `*.test.ts`/`*.testutil.ts`（只把手写/单边 legacy projection 改为 `createWorldStateFixture` 或 EntityMutation，不改断言语义）

- [ ] **Step 1: 写 Entity consistency assertion helper**

```ts
// 放在 journey 测试内（entity domain 模块禁止反向 import WorldState，故不放进 entity/ 目录）。
function compatibilityProjectionOf(ws: WorldState): EntityCompatibilityProjection {
  return {
    player: ws.player, locations: ws.locations, currentLocationId: ws.currentLocationId,
    unlockedLocationIds: ws.unlockedLocationIds, visitedLocationIds: ws.visitedLocationIds,
    npcs: ws.npcs, items: ws.items, inventory: ws.inventory, worldFacts: ws.worldFacts,
    quests: ws.quests, enemies: ws.enemies, defeatedEnemyIds: ws.defeatedEnemyIds, factions: ws.factions,
  };
}

function expectEntityWorldConsistent(worldState: WorldState): void {
  expect(validateEntityStoreStructure(worldState.entityStore)).toEqual([]);
  expect(validateEntityReferences(worldState.entityStore)).toEqual([]);
  expect(validateWorldStateEntityReferences(worldState)).toEqual([]);
  expect(validateEntityCompatibilityProjection(
    worldState.entityStore,
    compatibilityProjectionOf(worldState),
  )).toEqual([]);
}
```

- [ ] **Step 2: 完成至少 15 回合 journey**

覆盖：开局/reload、固定选择、自定义输入、NPC 记忆变化、事实发现、地点移动、拾取、交付、world delta 新实体、战斗开始、战败恢复、重赛胜利、任务推进和结局。每次成功 CAS/reload 后调用 consistency assertion；战败前后 store 深比较；结局后无重复写入。

- [ ] **Step 3: 锁定 provider 与 UI 行为不变**

断言 initialization/narrative_choice/npc_free_text 之外无 provider 调用；以迁移前已锁定的 read-model expected fixture 为基准，GameSessionView 的玩家可见地点/NPC/物品顺序、任务、战斗与结局语义等价（不是加载已明确拒绝的 v2 存档），不新增 Entity debug 字段或 ID registry 到客户端。

在运行 journey 前执行 fixture audit：

```bash
rg -n "version:\s*2|as WorldState|as any" src/game --glob '*.test.ts' --glob '*.testutil.ts'
rg -n "(locations|npcs|items|worldFacts|quests|enemies|factions|inventory|defeatedEnemyIds):\s*(\[|[^,]*\.(map|filter))" src/game --glob '*.test.ts' --glob '*.testutil.ts'
```

第一条只允许 SQLite 的明确 v2/错误版本输入与故意的类型攻击测试；第二条逐个审查，初次传给 `createWorldStateFixture` 的完整 projection 和故意 corruption case 合法，其余在一个合法 v3 world 上单改 legacy 投影的 fixture 必须迁移。不得通过类型断言隐藏漂移。

- [ ] **Step 4: 运行 journeys 并提交**

```bash
npm test -- src/game/application/testing/entityProjectionJourney.test.ts src/game/application/testing/foundationJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts src/game/application/testing/providerTriggerMatrix.test.ts
npm run test:foundation-journey
npm run journey:foundation
git add src/game/application/testing/entityProjectionJourney.test.ts
git add -u -- src/game
git commit -m "test(entity): prove entity projection across full journeys"
```

---

### Task 9: 更新实现事实文档并把阶段转入待验收

**Consumes:** 实际通过的 v3 接口与测试。  
**Produces:** Agent 文档只描述已实现事实，并清楚标出 Plan 3–8 未实现。  
**Independent proof:** 路径/API/命令可由 `rg` 对应，无 placeholder。

**Files:**

- Create: `docs/agent/实体与组件世界状态.md`
- Modify: `docs/agent/剧情连续性与结构化记忆.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/世界动态具象化.md`
- Modify: `docs/agent/行动裁决.md`
- Modify: `docs/agent/战斗与结局.md`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/游戏开发规范.md` only for `WorldState.version=3` / write boundary facts

- [ ] **Step 1: 新建 Entity 实现事实文档**

必须记录：8 kind、core/component 边界、store 权威、兼容 projector、mutation union、Proposed command allowlist、引用/空间 invariant、v2 拒绝、battle store checkpoint、context closure、主要文件和测试。

- [ ] **Step 2: 明确尚未实现**

文档必须写明：NPC identity anchors/多维关系/知识来源仍是 Plan 3；eventId/Episode 是 Plan 4；Outline/Arc/Thread 是 Plan 5；Entity Command 尚未加入 provider 输出，当前 AI 对既有 Entity 仍无更新权限；正式长篇仍未开放。

- [ ] **Step 3: 阶段转为 implemented/待验收**

`current-phase.json` 只把 `status` 与 `implementationStatus` 改为 `implemented`；分支/worktree/Plan 不变。人读文档状态写“待验收”，不能提前写 `completed/merged`。

- [ ] **Step 4: 文档/placeholder 校验并提交**

```bash
rg -n "EntityStore|EntityMutation|ProposedEntityCommand|entityContextProjection|WorldState.version=3" docs/agent docs/游戏开发规范.md docs/Agent文档索引.md
rg -n "TODO|TBD|待补|占位" src/game/domain/entity src/game/gameplay/rpg/entityWorld src/game/application/entityContextProjection.ts
git add docs/agent docs/Agent文档索引.md docs/游戏开发规范.md
git commit -m "docs(entity): document component world state"
```

Expected: 第一条能定位 canonical 实现；第二条无命中。

---

### Task 10: 全量门禁、架构审查与合并准备

**Consumes:** Task 1–9 全部提交。  
**Produces:** Plan 2 可合并证据；失败只修复对应任务范围并从相关门禁重跑。  
**Independent proof:** 全量自动化 + 最终 diff/裸写入/隐私扫描。

**Files:**

- No planned production changes.
- 门禁发现问题时只修改引入问题的精确文件并补回归测试。

- [ ] **Step 1: 运行分层测试**

```bash
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行完整 journeys**

```bash
npm run test:foundation-journey
npm run journey:foundation
npm test -- src/game/application/testing/entityProjectionJourney.test.ts src/game/application/testing/mediumActJourney.test.ts src/game/application/testing/storyDivergenceJourney.test.ts
```

Expected: 短篇 ≥15 回合、中篇 5 幕、分歧结局、战败→战前 store 恢复→重赛胜利全部 PASS。

- [ ] **Step 3: 运行工程门禁**

```bash
npm run check:standards
npm run test:boundaries
npm run test:fast
npm test
npm run typecheck
npm run lint
npm run build
npm run phase:status
```

Expected: 全部 PASS；`phase:status` 显示 `entity-component-world-state-foundation / implemented`。

- [ ] **Step 4: 做最终架构扫描**

```bash
rg -n "op.*path.*value|JSON Patch|Record<string, unknown>" src/game/domain/entity src/game/gameplay/rpg/entityWorld
rg -n "(locations|npcs|items|worldFacts|quests|enemies|factions):\s*(\[|[^,]*\.map)|inventory:\s*(\[|[^,]*\.filter)|defeatedEnemyIds:\s*\[" src/game/domain src/game/gameplay/rpg src/game/application --glob '*.ts' --glob '!*.test.ts' --glob '!**/entityProjection.ts'
rg -n "eventLedger|hiddenFactIds|interactionHistory|affinity=" src/game/application/entityContextProjection.ts src/game/application/server/ai/narrativeContext
rg -n "TODO|TBD|待补|占位" src/game/domain/entity src/game/gameplay/rpg/entityWorld src/game/application/entityContextProjection.ts
```

Expected:

- 第一条允许 parser/validator 在未信任 JSON 边界内部使用 `Record<string, unknown>` 做 shape inspection，也允许拒绝性测试/注释命中；公开 Entity/Component/Mutation/Command 类型不得接受该字典，不存在 patch API；
- 第二条只有兼容 projection/read-only DTO/初始化合法命中，无生产实体裸写入；
- 第三条只允许 builder 为排除私密事实读取 `hiddenFactIds`、焦点 NPC 最近五条批准交互的测试/投影，不把账本、其他 NPC 私密正文或裸 affinity 写入 Prompt；
- 第四条无命中。

- [ ] **Step 5: 最终 diff 审查**

```bash
git status --short
git diff main...HEAD --stat
git log --oneline main..HEAD
```

Expected: 只包含本 Plan 列出的 domain/gameplay/application/persistence/tests/docs；无 UI 玩法改动、共享 package、依赖升级、生成文件或旧兼容运行链。

---

## Acceptance Checklist

- [ ] `WorldState.version=3` 持久化唯一 `EntityStore`；8 类实体均有稳定 ID、core、created turn 与 lifecycle。
- [ ] EntityRecord 是固定判别联合，没有万能可空字段、动态 component 名或任意 patch。
- [ ] 现有数组/位置/持有/解锁/击败索引只由唯一 projector 生成，任何漂移在存储边界安全失败；NPC/可拾取物/背包的玩家可见顺序由 `locationOrder/ownerOrder` 保持。
- [ ] 地点存在性、连接对称性、NPC/enemy 位置、item 单一 owner、quest objective、NPC fact 引用由 store validator 校验；battle/ending 的外围 Entity 引用由 `validateWorldStateEntityReferences` 纳入同一存储门禁。
- [ ] opening、规则行动、候选事件、world delta、任务、NPC memory、事实和战斗胜利均通过 EntityMutation 更新。
- [ ] ProposedEntityCommand 只有固定 allowlist，非法/越权/任意 JSON Patch 整批零写入；本 Plan 不把它接入 provider。
- [ ] production narrative bundle/scene/world context 从 Entity 规则闭包投影，保留 Plan 1 编译顺序、预算、隐私与 body-free manifest。
- [ ] 正常玩家决策仍恰好一次 AI 调用；移动、物品、战斗和 bundle 消费不新增 provider 调用。
- [ ] 战斗失败或撤退均恢复战前 Entity Store、兼容投影和 eventLedger，失败尝试不进入长期世界因果。
- [ ] v2 存档明确返回 `UNSUPPORTED_RECORD`；合法 v3 可 create/reload/CAS，损坏 store、兼容投影或 v3 envelope 不静默重置。
- [ ] GameSessionView/API/UI 不暴露 Entity Store、command、registry 或隐藏事实。
- [ ] 短篇、中篇、分歧结局、reload、战败重赛 journeys 全部通过。
- [ ] 全量 tests、typecheck、lint、boundaries、build 全部通过。

## 明确边界

- Plan 2 不把当前 `NpcMemory` 拆成人格锚点/动态状态/知识来源/多维关系；Plan 3 在 Entity 基础上完成。
- Plan 2 不给 Event 增加稳定 eventId，不建立 Episode、摘要、向量索引或长期召回；Plan 4 完成。
- Plan 2 不建立 Living Outline、嵌套 Arc、Milestone、Story Thread 或滚动修订；Plan 5 完成。
- Plan 2 不加入 Arc-aware director、高潮/转折规划或战斗叙事功能；Plan 6 完成。
- Plan 2 不拆分 SQLite 事件表、不做快照/分段/归档；Plan 7 完成。
- Plan 2 不开放 long/open，不承诺十小时能力；Plan 8 完成。
- Plan 2 不改变战斗失败回滚、不新增持久失败世界线、不改变当前短篇/中篇玩家规则。
