# Spec：蓝图动态化（时长档位 + 运行时蓝图扩展）

> 日期：2026-07-30 ｜ 状态：待实现 ｜ 关联 plan：`docs/superpowers/plans/2026-07-30-blueprint-dynamic-evolution.md`

## 1. 背景

当前蓝图是"开局一次性全量生成 + 永久只读"：

- 预算由 domain 冻结常量 `CONTENT_BUDGET` 硬编码（主地点恒 4、结局恒 2 等），并在三处静态镜像：`validateScenarioBlueprint.ts` 的数量断言、`scenarioResponseFormat.ts` 的 JSON Schema const 字面量、`scenarioPrompt.ts` 的预算文案。
- 主线固定三幕（`MainQuestStage = 1|2|3`），`stage === 3` 作为终局判定散布在 `startBattle.ts`、`gameplay/rpg/actions/index.ts`、`performAction.ts`。
- 蓝图只在 `createInitialGame` 写入一次，`gameRepository` 端口没有任何更新蓝图的方法。
- 运行时导演的 `introducedEntities` 只能引用蓝图已有实体（`approveDirectorProposal.ts` 硬闸门），live 修复层甚至强制清空该字段。

本 spec 把蓝图改造为"固定骨架 + 动态血肉"：玩家开局选择时长档位（或不选=开放），开局只生成起始区域，运行时导演可提议新地点/新 NPC，经闸门审批后追加进蓝图。

## 2. 目标

1. `NewGameInput` 新增时长档位 `gameLength`：`short | medium | long | open`，不选默认 `open`。
2. 预算从冻结常量改为按档位派生的 `BudgetPolicy`（开局预算 + 演进软上限 + 全档位统一安全硬上限）。
3. 时长映射为主线弧长（幕数），不映射为地点数字；主线幕数可变（3/5/8），终局判定不再硬编码 `stage === 3`。
4. 开局只生成起始区域（3~5 个主地点），所有档位一致；档位差异体现在主线幕数与演进期闸门。
5. 运行时导演可提议新地点（每场景至多 1 个）与新 NPC（至多 1 个），经预算/连通/节奏闸门审批后追加进蓝图并持久化。
6. 旧存档零迁移可读（沿用 `scale` 可选字段的既有模式）。

## 3. 非目标

- 运行时生成新任务/新结局（任务图与结局骨架开局锁定）。
- open 模式的"节奏信号收敛"机制：open 的主线仍是固定 5 幕骨架，收敛由主线链天然保证；open 只解除演进软上限。
- 大地图节点可视化布局改版（`positionForLocation` 的 mod-5 复用位置策略保持不变，节点多于 5 个时位置复用是可接受的）。
- 运行时生成新物品/新敌人/新事实。
- 修改 town 内景生成契约（town-plan 链路已在 main 实装，本 spec 只经 `scale` 与 town 配额与其衔接）。

## 4. 核心设计决策

### 4.1 GameLength 与 BudgetPolicy

`domain/newGame.ts` 新增：

```ts
export type GameLength = "short" | "medium" | "long" | "open";
```

`NewGameInput.gameLength?: GameLength`；`validateNewGameInput` 将 `undefined` 规范化为 `"open"`（`ValidatedNewGameInput` 中永远是四值之一，不允许 undefined 传播）；非法字符串报 `INVALID_ENUM`。

新文件 `domain/budgetPolicy.ts`：

```ts
export type BudgetPolicy = {
  readonly policyVersion: 1;
  readonly gameLength: GameLength;
  /** 主线弧长（幕数）。open 采用 medium 骨架：骨架必须开局固定以保证结局可达。 */
  readonly mainActs: number;
  /** 开局起始区域预算：全档位一致，开局 AI 返回体积不随档位膨胀。 */
  readonly opening: {
    readonly mainLocationsMin: number;   // 3
    readonly mainLocationsMax: number;   // 5
    readonly hiddenLocationsMax: number; // 1
    readonly coreNpcsMin: number;        // 4
    readonly coreNpcsMax: number;        // 6
    readonly companionsMax: number;      // 1
    readonly sideQuestsMax: number;      // 2
    readonly endings: number;            // 2
    readonly townLocationsMax: number;   // 2（全蓝图口径，含动态追加）
  };
  /** 演进期软上限（全蓝图总量口径）；open 为 null = 无软上限。 */
  readonly expansion: {
    readonly locationsSoftMax: number | null;
    readonly npcsSoftMax: number | null;
  };
  /** 全档位统一安全硬上限：防失控保险丝，不是玩法参数。 */
  readonly safety: {
    readonly locationsHardMax: number;   // 40
    readonly npcsHardMax: number;        // 30
  };
};
```

档位表（冻结常量，唯一事实源 `createBudgetPolicy(gameLength)`）：

| 档位 | mainActs | locationsSoftMax | npcsSoftMax |
|---|---|---|---|
| short | 3 | 8 | 10 |
| medium | 5 | 14 | 16 |
| long | 8 | 22 | 24 |
| open | 5 | null | null |

派生规则：policy 永远由 `createBudgetPolicy(input.gameLength)` 从 `ValidatedNewGameInput` 派生，不作为独立请求参数传递（`ScenarioGenerationRequest` 三字段不变）。

### 4.2 蓝图形状变化（零迁移）

- `ScenarioBlueprintShapeOf` 移除 `contentBudget: ContentBudget`，新增 `readonly budgetPolicy?: BudgetPolicy`（可选：旧存档缺省；新候选由 validator 强制存在且与派生 policy 深度相等）。
- `CONTENT_BUDGET` 常量与 `ContentBudget` 类型删除（迁移完成后的清理任务）。
- 读取入口 `budgetPolicyOf(blueprint)`：`blueprint.budgetPolicy ?? LEGACY_BUDGET_POLICY`。`LEGACY_BUDGET_POLICY` 等价旧语义：mainActs 3、opening 与旧 `CONTENT_BUDGET` 对应（main 4/4）、expansion soft {8,10}、safety {40,30}、gameLength "short"。
- `schemaVersion` 保持 `1`：sqlite 仓储的 `VERSION_MISMATCH` 判定不变，旧存档记录中多出的 `contentBudget` JSON 字段被忽略。
- `MainQuestStage` 从 `1|2|3` 放宽为 `number`（正整数，上限由 policy.mainActs 决定，校验在 questGraph）。

### 4.3 主线弧长与终局判定

- `questGraph.ts`：`QuestGraphInput` 新增 `budget: { mainActs: number; sideQuestsMax: number; endings: number }`；结构校验改为"stage 必须是 1..mainActs 的整数，每幕恰一个主线任务"；支线/结局预算断言改用 `budget` 字段（不再 import `CONTENT_BUDGET`）。
- 终局判定统一经 helper：`finalMainActOf(blueprint) = budgetPolicyOf(blueprint).mainActs`（定义于 `domain/budgetPolicy.ts`）。替换三处 `stage === 3` / `stage !== 3`：`startBattle.ts` L111、`gameplay/rpg/actions/index.ts` L140、`performAction.ts` L444。`compileScenarioBlueprint.ts` L103 的 `stage === 1` 初始激活语义不变。

### 4.4 开局生成链改造

- `validateScenarioBlueprintCandidate` 的 context 变为 `{ profile, policy }`：
  - 主地点数量断言从 `=== 4` 改为区间 `[mainLocationsMin, mainLocationsMax]`，issue code `MAIN_LOCATION_COUNT_MISMATCH` → `MAIN_LOCATION_COUNT_OUT_OF_RANGE`；
  - `CONTENT_BUDGET_MISMATCH` → `BUDGET_POLICY_MISMATCH`：候选自带 `budgetPolicy` 必须与派生 policy 深度相等（JSON round-trip 比较）；
  - town 配额从常量 `TOWN_SCALE_LOCATIONS_MAX` 改为 `policy.opening.townLocationsMax`。
- `createFallbackBlueprint`：内部经 `createBudgetPolicy(input.gameLength)` 派生 policy；地点仍固定 4 main + 1 hidden（在 3..5 区间内，保持确定性）；主线链生成 `mainActs` 幕——第 1 幕与终幕沿用现有模板，中间幕循环三套中段模板并以"第 k 章"编号命名，objective 只引用既有实体，链式 `unlock_quests` 衔接，终幕 `reach_ending`；`budgetPolicy` 字段填 policy 快照。
- `scenarioResponseFormat.ts`：`SCENARIO_CANDIDATE_JSON_SCHEMA` 常量改为 `buildScenarioCandidateJsonSchema(policy)` 工厂；`budgetPolicy` 子 schema 按 policy 实例逐字段 const（候选必须原样复述）；quest 的 main 变体 `stage` 从枚举 [1,2,3] 改为 `{ type: "integer", minimum: 1, maximum: policy.mainActs }`；`buildScenarioResponseFormatExtraBody(outputFormat, policy)`。
- `liveScenarioCandidateSource`：`extraBody` 选项从静态对象改为 `buildExtraBody?: (request) => Record<string, unknown> | undefined`（schema 随档位变化，必须按请求构建）；`scenarioCandidateSourceFactory` 相应装配。
- `scenarioPrompt.ts`：预算段落从 policy 插值（起始区域 3~5 主地点、隐藏 ≤1、NPC 4~6、主线恰 `mainActs` 幕每幕一个、支线 ≤2、恰 2 个可达结局、town ≤2）；新增"# 时长档位"一行说明本局档位与主线幕数。
- 契约版本：`SCENARIO_CANDIDATE_CONTRACT_VERSION`：`"phase4b-v1"` → `"scenario-dynamic-v2"`。

### 4.5 运行时蓝图扩展

**提案契约**（`gameplay/rpg/narrative/types.ts`，`DirectorProposal` 新增两个字段；`introducedEntities` 语义不变仍只引用既有实体）：

```ts
export type ProposedNewLocation = {
  readonly name: string;                  // 2..20 码点
  readonly description: string;           // 10..120 码点
  readonly scale: "scene" | "town";
  readonly connectFromLocationId: string; // 必须为蓝图既有且已解锁的地点
  readonly reason: string;                // 10..100 码点，剧情理由
};
export type ProposedNewNpc = {
  readonly name: string;                  // 2..20 码点
  readonly role: string;                  // 2..40 码点
  readonly description: string;           // 10..120 码点
  /** 既有地点 ID，或哨兵 "new:0" 指向 proposedNewLocations[0]。 */
  readonly locationId: string;
};
// DirectorProposal 追加：
//   readonly proposedNewLocations: readonly ProposedNewLocation[]; // ≤1
//   readonly proposedNewNpcs: readonly ProposedNewNpc[];           // ≤1
```

**审批闸门**（新纯函数 `approveBlueprintExpansion`，gameplay 层）。关键原则：**扩展审批失败绝不使整个场景失败**——场景照常生成，扩展被丢弃并返回稳定拒绝码：

```ts
export type BlueprintExpansionRejection =
  | "none_proposed" | "invalid_payload" | "soft_cap_reached" | "hard_cap_reached"
  | "endgame_locked" | "pacing_locked" | "connect_not_unlocked" | "town_cap_reached";
export type BlueprintExpansionDecision =
  | { readonly ok: true; readonly expansion: ApprovedBlueprintExpansion }
  | { readonly ok: false; readonly reason: BlueprintExpansionRejection };
```

闸门顺序：无提案 → none_proposed；载荷形状/长度非法 → invalid_payload；`pacing ∈ {climax, resolution}` → pacing_locked；当前激活主线幕 = mainActs（或主线已全部完成）→ endgame_locked；地点/NPC 总数达软上限（open 跳过）→ soft_cap_reached；达硬上限 → hard_cap_reached；connectFrom 不在 `state.unlockedLocationIds` → connect_not_unlocked；提议 town 且蓝图 town 总数已达 `townLocationsMax` → town_cap_reached。

**ID 铸造（服务端，绝不采用 AI 提供的 ID）**：`loc_dyn_<n>` / `npc_dyn_<n>`，n = 既有同前缀最大序号 + 1。

**蓝图/状态编译**（gameplay 纯函数 `compileBlueprintExpansion`）：新地点 kind "main"、双向连通（connectFrom 的 `connectedLocationIds` 追加新 ID）、`availableItemIds: []`；新 NPC `isCompanion: false`、`knownFactIds: []`；state 变化：`unlockedLocationIds` 追加新地点、`state.npcs` 追加 runtime 条目（复用 `initializeGameState` 的同一构造逻辑）、eventLedger 追加 `blueprint_expanded` 事件（新增 GameEvent 类型，携带新实体 ID 列表）。

**持久化**：`gameRepository` 端口新增：

```ts
export type ApplyBlueprintExpansionInput = {
  readonly gameId: GameId;
  readonly expectedRevision: number;
  readonly nextBlueprint: ScenarioBlueprint;
  readonly nextState: GameState;
};
applyBlueprintExpansion(input): Promise<ApplyResolvedActionResult>;
```

sqlite 实现：单事务同时更新 blueprint JSON + state JSON + revision+1，CAS 语义与 `applyResolvedAction` 一致（revision 不匹配 → STALE_GAME_REVISION）。

**编排接线**：`orchestrateNarrativeScene` 保持"不写库"，返回值追加 `expansionDecision`；持久化调用方（`generatePendingNarrativeScene` 场景保存点）在 decision ok 时改走 `applyBlueprintExpansion`（一次 CAS 同时落场景与扩展），否则沿用 `applyResolvedAction`。

**AI 链路**：导演 system prompt 增补扩展规则（可选、至多各 1、必须给剧情理由、ID 由系统分配不要编造）；`DirectorContext` 新增 `expansionAllowed: boolean` 与 `remainingLocationBudget: number | null`（open 为 null），让 AI 知道当前是否允许扩张；live 修复层对新字段做丢弃式清洗（malformed → 空数组，绝不让场景失败）；fixture source 缺省 `proposedNewLocations/Npcs: []`，另备一份含扩展的 fixture 供回归。契约版本 `NARRATIVE_CONTRACT_VERSION`：`"runtime-narrative-v1"` → `"runtime-narrative-v2"`。

### 4.6 UI

`NewGameSetupForm.tsx` 新增"游戏时长"下拉：`不限（随剧情推演）`(open，默认) / `短篇`(short) / `中篇`(medium) / `长篇`(long)。提交进 `NewGameInput.gameLength`。服务端重新校验。

## 5. 兼容性与安全

- 旧存档：`budgetPolicy` 缺省经 `budgetPolicyOf` 回 `LEGACY_BUDGET_POLICY`（mainActs 3 → 终局判定与旧行为逐字一致）；`schemaVersion`、`GAME_RECORD_VERSION`、`stateVersion` 均不变。
- 依赖边界规则全部不变（UI 只经 `@/game/application` 门面；town/battle 等 deep-import 禁令保持）。
- AI 提供的任何 ID/文本进入蓝图前必须经审批重建（逐字段拷贝、服务端铸 ID），沿用"绝不透传 AI 对象引用"的既有纪律。
- 扩展写入与场景写入同一次 CAS，杜绝"场景引用了未落库地点"的中间态。

## 6. 验收标准

1. 开新档可选四档时长；不选=open；`ValidatedNewGameInput.gameLength` 永远为四值之一。
2. short/medium/long 分别生成 3/5/8 幕主线（fallback 与 AI 路径皆然），每幕恰一个主线任务，结局可达校验通过；open 生成 5 幕。
3. 开局主地点数在 3..5 区间即通过校验（fallback 恒 4）；候选 `budgetPolicy` 与档位派生不一致被拒。
4. 终局战斗/结局判定在 8 幕 long 档位下发生于第 8 幕（不再锚定 3）。
5. 旧存档（无 budgetPolicy 字段、3 幕）可正常读取、推进、通关。
6. 离线 fixture 旅程：导演提议 1 个新地点 + 1 个新 NPC → 审批通过 → 蓝图追加、地图出现新节点、可移动进入、事件账本含 blueprint_expanded；软上限达到后同类提议被拒且场景正常生成。
7. climax/resolution 节奏、终幕激活时提议被拒（pacing_locked / endgame_locked）。
8. 全量 vitest、`npx tsc --noEmit`、`npx eslint .` 通过；`dependencyBoundaries.test.ts` 无新违规。
