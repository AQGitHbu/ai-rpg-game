# Phase 14：渐进式生成与剧情推演 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开局只生成起始锚点+序幕+结局方向骨架，运行时按剧情推进动态生成地点/NPC/任务/结局；NPC对话面板统一为 AI 情境选项，去掉 dialogue_choice 规则中介层；新增黑底白字序幕开场。

**Architecture:** 保留现有 domain → gameplay → application 三层结构与三角色场景流水线。核心改动：(1) `ScenarioBlueprint` schemaVersion 1→2，新增 `startAnchor`/`endingDirection`/`prologue` 字段；(2) `createFallbackBlueprint` 收窄为起始锚点；(3) `dialogue_choice` 完全废除，`talk` intent 升级为场景生成触发器；(4) 新增 `ack_prologue` intent + `PrologueScreen` 组件；(5) 小镇入口加"任务目标+已结识"过滤；(6) 结局由 AI 导演提议 + 闸门审批具体化。

**Tech Stack:** TypeScript 5.x / Next.js 14 / React 18 / SQLite (libsql) / vitest

## Global Constraints

- Python 使用 UV 管理依赖和运行（`uv run`），禁止全局 pip 安装
- Windows 系统：不使用 `&&` 连接命令
- 函数级注释必须添加（中文）
- 分支放 `.worktrees/`，不用 `git checkout`
- `../ai-game-foundation` 是受保护 sibling 仓库，`.foundation` 是 junction：禁止删除/移动/重建
- 规则独占状态写入：AI 只产出候选，必经审批 + 规则裁决
- CAS 持久化：场景与蓝图扩展同一次原子写入
- 三角色最小权限：导演/编剧/NPC 演员各自独立请求
- 确定性 fallback：开局 fallback（起始锚点）+ 运行时 fallback（单地点/NPC）
- 不修改 foundation / 共享模块

---

## File Structure

### 新增文件

| 文件 | 责任 |
|---|---|
| `src/game/gameplay/rpg/quests/storyProgression.ts` | 主线幕数追踪纯函数 |
| `src/game/gameplay/rpg/narrative/approveEndingProposal.ts` | 结局提议 8 步闸门审批 |
| `src/game/gameplay/rpg/narrative/applyEndingToBlueprint.ts` | 结局追加到蓝图（不可变更新） |
| `src/game/gameplay/rpg/scenario/createRuntimeFallbackExpansion.ts` | 运行时 fallback（AI 失败时确定性产出） |
| `src/components/PrologueScreen.tsx` | 黑底白字序幕组件 |
| `src/app/api/game/prologue/ack/route.ts` | 序幕确认 API（委托 performAction） |
| `src/game/application/phase14ProgressiveGenerationRegression.test.ts` | 回归测试 |

### 修改文件

| 文件 | 改动级别 |
|---|---|
| `src/game/domain/scenarioBlueprint.ts` | 大 |
| `src/game/domain/narrative.ts` | 中 |
| `src/game/domain/gameState.ts` | 小 |
| `src/game/application/server/persistence/sqliteGameRepository.ts` | 中 |
| `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts` | 大 |
| `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts` | 中 |
| `src/game/application/scenarioGeneration.ts` | 小 |
| `src/game/application/server/ai/scenarioPrompt.ts` | 中 |
| `src/game/application/server/ai/liveScenarioCandidateSource.ts` | 小 |
| `src/game/application/server/ai/fixtureScenarioCandidateSource.ts` | 小 |
| `src/game/application/server/ai/scenarioResponseFormat.ts` | 中 |
| `src/game/gameplay/rpg/actions/intents.ts` | 中 |
| `src/game/gameplay/rpg/actions/dialogueChoices.ts` | 删除 |
| `src/game/gameplay/rpg/actions/validateIntent.ts` | 中 |
| `src/game/gameplay/rpg/actions/resolveAction.ts` | 中 |
| `src/game/gameplay/rpg/actions/index.ts` | 小 |
| `src/app/api/game/actions/actionHandler.ts` | 小 |
| `src/game/application/performAction.ts` | 中 |
| `src/game/application/orchestrateNarrativeScene.ts` | 中 |
| `src/game/application/locationAdventureView.ts` | 大 |
| `src/game/application/townRuntimeView.ts` | 中 |
| `src/game/application/handleNpcDialogue.ts` | 小 |
| `src/game/gameplay/rpg/narrative/types.ts` | 小 |
| `src/game/application/server/ai/liveRuntimeNarrativeSources.ts` | 中 |
| `src/game/application/gameSessionView.ts` | 中 |
| `src/components/CurrentGameScreen.tsx` | 小 |
| `src/components/AdventureGameShell.tsx` | 中 |
| `src/components/NpcDialoguePanel.tsx` | 中 |
| `src/components/TownLayerScreen.tsx` | 小 |
| `src/app/globals.css` | 小 |

---

### Task 1: 域类型扩展（schemaVersion 2 + 新类型）

**Files:**
- Modify: `src/game/domain/scenarioBlueprint.ts:205-213,228-246,259-286`
- Modify: `src/game/domain/narrative.ts:8-12,21-29,40-42`
- Modify: `src/game/domain/gameState.ts:88-119`
- Test: `src/game/domain/scenarioBlueprint.test.ts`（已存在）
- Test: `src/game/domain/narrative.test.ts`（已存在）
- Test: `src/game/domain/gameState.test.ts`（已存在）

**Interfaces:**
- Produces: `ScenarioBlueprint` 含 `schemaVersion: 2` / `startAnchor` / `endingDirection`；`SceneDefinitionOf<I>` 含 `prologue?`；`NarrativeSceneState` 含 `npcDialogues?`；`NarrativeChoiceState` 含 `hint?`/`narrativeIntent?`；`NarrativeGenerationState.pending` 含 `triggerContext?`；`GameState` 含 `prologueShown`/`mainStoryProgress`

- [ ] **Step 1: 在 scenarioBlueprint.ts 新增类型定义**

在 `EndingDefinitionOf<I>` 定义之后（第 203 行后）新增：

```typescript
// === Phase 14：结局方向与序幕 ===

/** 结局基调：影响结局文案与视觉风格。 */
export type EndingTone = "triumph" | "tragedy" | "bittersweet" | "ambiguous";

/** 序幕定义：黑底白字开场，开局一次性生成。 */
export type PrologueDefinition = {
  /** 序幕正文，如"南宋覆灭五十余年..." */
  readonly text: string;
  /** 影响视觉风格（字体动画速度等）。 */
  readonly tone: "serious" | "epic" | "mysterious";
  /** 可选自动播放时长（毫秒）；缺省由玩家点击跳过。 */
  readonly durationMs?: number;
};

/** 结局方向骨架：开局生成，运行时由 AI 导演具体化。 */
type EndingDirectionOf<I extends IdSet> = {
  /** 结局主题方向，如"反元抉择"。 */
  readonly theme: string;
  /** 可能的基调集合，AI 提议的结局必须从中选择。 */
  readonly possibleTones: readonly EndingTone[];
  /** 主线幕数阈值，达此阈值后 AI 可提议具体化结局。 */
  readonly lockedAt: number;
};

/** 起始锚点：开局生成，运行时只读。 */
type StartAnchorOf<I extends IdSet> = {
  readonly locationId: I["location"];
  readonly npcId: I["npc"];
  readonly startQuestId: I["quest"];
};

/** 运行时 AI 提议的结局（经闸门审批后转为 EndingDefinition）。 */
export type ProposedEnding = {
  readonly name: string;
  readonly description: string;
  readonly tone: EndingTone;
  readonly requirements: readonly EndingRequirement[];
  /** AI 解释为何此结局合适（审计用）。 */
  readonly reason: string;
};
```

- [ ] **Step 2: 在 SceneDefinitionOf<I> 新增 prologue 字段**

修改 `src/game/domain/scenarioBlueprint.ts:205-213`，在 `investigableFactIds` 字段后新增：

```typescript
type SceneDefinitionOf<I extends IdSet> = {
  readonly id: I["scene"];
  readonly locationId: I["location"];
  readonly narration: string;
  readonly presentNpcIds: readonly I["npc"][];
  readonly suggestedActions: readonly string[];
  /** Phase 3: 当前场景中可调查的世界事实 ID（opening scene 至少一个）。 */
  readonly investigableFactIds: readonly I["fact"][];
  /** Phase 14: 序幕（黑底白字开场），仅 openingScene 使用。 */
  readonly prologue?: PrologueDefinition;
};
```

- [ ] **Step 3: 在 ScenarioBlueprintShapeOf<I> 新增字段并升级 schemaVersion**

修改 `src/game/domain/scenarioBlueprint.ts:228-246`：

```typescript
type ScenarioBlueprintShapeOf<I extends IdSet> = {
  readonly schemaVersion: 2;  // Phase 14: 从 1 升到 2
  readonly generationId: I["generation"];
  readonly seed: string;
  readonly templateVersion: string;
  readonly gameType: GameTypeId;
  readonly inputDigest: string;
  readonly world: WorldDefinitionOf<I>;
  readonly player: GeneratedPlayerDefinitionOf<I>;
  /** Phase 14: 起始锚点（开局生成，运行时只读）。 */
  readonly startAnchor: StartAnchorOf<I>;
  /** Phase 14: 结局方向骨架（开局生成，运行时具体化）。 */
  readonly endingDirection: EndingDirectionOf<I>;
  readonly locations: readonly LocationDefinitionOf<I>[];
  readonly npcs: readonly NpcDefinitionOf<I>[];
  readonly quests: readonly QuestDefinitionOf<I>[];
  readonly enemies: readonly EnemyTemplateOf<I>[];
  readonly items: readonly ItemDefinitionOf<I>[];
  readonly endings: readonly EndingDefinitionOf<I>[];
  readonly openingScene: SceneDefinitionOf<I>;
  // 旧存档缺省，读取一律经 budgetPolicyOf
  readonly budgetPolicy?: BudgetPolicy;
};
```

- [ ] **Step 4: 新增公开别名**

在 `src/game/domain/scenarioBlueprint.ts:259-286` 的别名区域新增：

```typescript
// Phase 14 新增别名
export type EndingDirection = EndingDirectionOf<CompiledIds>;
export type StartAnchor = StartAnchorOf<CompiledIds>;
export type EndingDirectionCandidate = EndingDirectionOf<CandidateIds>;
export type StartAnchorCandidate = StartAnchorOf<CandidateIds>;
```

- [ ] **Step 5: 在 narrative.ts 新增 NarrativeTriggerContext 和 NpcDialogueInScene**

在 `src/game/domain/narrative.ts` 的 `NarrativeSceneState` 定义前新增：

```typescript
/** Phase 14: 场景生成的触发上下文，让导演知道场景是为何触发的。 */
export type NarrativeTriggerContext =
  | { readonly kind: "talk"; readonly npcId: NpcId; readonly isFirstMeeting: boolean }
  | { readonly kind: "narrative_choice_followup"; readonly previousChoiceActionKey: string }
  | { readonly kind: "free_input"; readonly npcId: NpcId; readonly playerText: string }
  | { readonly kind: "location_entered"; readonly locationId: string; readonly isFirstVisit: boolean };

/** Phase 14: 场景内 NPC 的对白（含焦点 NPC 与其他在场 NPC）。 */
export type NpcDialogueInScene = {
  readonly npcId: NpcId;
  readonly npcName: string;
  readonly npcRole: string;
  /** 复用现有分页机制（paginateSpeechText）。 */
  readonly speechPages: readonly string[];
};
```

- [ ] **Step 6: 在 NarrativeSceneState 新增 npcDialogues 字段**

修改 `src/game/domain/narrative.ts:21-29`：

```typescript
export type NarrativeSceneState = {
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly usedFactIds: readonly FactId[];
  readonly npcLine: NarrativeNpcLineState | null;
  readonly choices: readonly [NarrativeChoiceState, NarrativeChoiceState];
  readonly source: "generated" | "fallback";
  /** Phase 14: 场景内多 NPC 对白（含焦点 NPC）。 */
  readonly npcDialogues?: readonly NpcDialogueInScene[];
};
```

- [ ] **Step 7: 在 NarrativeChoiceState 新增 hint 和 narrativeIntent 字段**

修改 `src/game/domain/narrative.ts:8-12`：

```typescript
export type NarrativeChoiceState = {
  readonly choiceToken: string;
  readonly label: string;
  readonly actionKey: string;
  /** Phase 14: 选项展示提示（如"将引入新 NPC"）。 */
  readonly hint?: string;
  /** Phase 14: 情境语义，供导演后续参考。 */
  readonly narrativeIntent?: "advance_plot" | "introduce_npc" | "introduce_location" | "combat" | "discover_item";
};
```

- [ ] **Step 8: 在 NarrativeGenerationState.pending 新增 triggerContext 字段**

修改 `src/game/domain/narrative.ts:40-42`：

```typescript
export type NarrativeGenerationState =
  | { readonly status: "idle" }
  | {
      readonly status: "pending";
      readonly requestedAt: string;
      /** Phase 14: 场景生成的触发上下文。 */
      readonly triggerContext?: NarrativeTriggerContext;
      readonly playerNpcChat?: PlayerNpcChatState;
    };
```

- [ ] **Step 9: 在 GameState 新增 prologueShown 和 mainStoryProgress 字段**

修改 `src/game/domain/gameState.ts:88-119`，在 `eventLedger` 字段前新增：

```typescript
  /** Phase 14: 序幕已播放标记（开局 false，播放后 true）。 */
  readonly prologueShown: boolean;
  /** Phase 14: 主线幕数追踪（结局推演用）。 */
  readonly mainStoryProgress: {
    readonly currentAct: number;
    readonly endingProposed: boolean;
  };
  /** 追加式事件账本：初始条目必须是 game_initialized。 */
  readonly eventLedger: readonly GameEvent[];
```

注意：`stateVersion` 保持 `1`（新字段走 `with*Defaults` 兼容，不升记录版本）。

- [ ] **Step 10: 运行类型检查验证编译通过**

Run: `npm run typecheck`
Expected: FAIL（下游模块引用了旧 schemaVersion: 1 或缺少新字段）—— 这是预期的，后续 Task 会修复下游

- [ ] **Step 11: 提交**

```bash
git add src/game/domain/scenarioBlueprint.ts src/game/domain/narrative.ts src/game/domain/gameState.ts
git commit -m "feat(domain): Phase 14 域类型扩展——schemaVersion 2 + startAnchor + endingDirection + prologue + npcDialogues + triggerContext"
```

---

### Task 2: 持久化迁移（sqliteGameRepository with*Defaults + 版本检查）

**Files:**
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts:35,212-274,104-208`
- Test: `src/game/application/server/persistence/sqliteGameRepository.test.ts`（已存在）

**Interfaces:**
- Consumes: Task 1 的 `ScenarioBlueprint` schemaVersion 2 / `GameState` 新字段
- Produces: 旧存档（schemaVersion 1）读取时自动补 `startAnchor`/`endingDirection`/`prologueShown`/`mainStoryProgress` 默认值

- [ ] **Step 1: 写失败测试——旧存档（schemaVersion 1）读取后含新字段默认值**

在 `sqliteGameRepository.test.ts` 新增测试：

```typescript
describe("Phase 14 schemaVersion 1→2 迁移", () => {
  test("旧存档（schemaVersion 1）读取后含 startAnchor 默认值", () => {
    const row = buildLegacyV1Row();  // schemaVersion: 1, 无 startAnchor
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.blueprint.startAnchor).toBeDefined();
      expect(result.record.blueprint.startAnchor.locationId).toBe("loc_1");
      expect(result.record.blueprint.startAnchor.npcId).toBe("npc_1");
    }
  });

  test("旧存档读取后含 endingDirection 默认值", () => {
    const row = buildLegacyV1Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.blueprint.endingDirection).toBeDefined();
      expect(result.record.blueprint.endingDirection.lockedAt).toBeGreaterThanOrEqual(1);
    }
  });

  test("旧存档读取后 prologueShown 为 true（已过开场）", () => {
    const row = buildLegacyV1Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.state.prologueShown).toBe(true);
    }
  });

  test("旧存档读取后 mainStoryProgress 含 currentAct 和 endingProposed", () => {
    const row = buildLegacyV1Row();
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.state.mainStoryProgress).toBeDefined();
      expect(typeof result.record.state.mainStoryProgress.currentAct).toBe("number");
      expect(result.record.state.mainStoryProgress.endingProposed).toBe(false);
    }
  });

  test("新存档（schemaVersion 2）读取通过", () => {
    const row = buildNewV2Row();  // schemaVersion: 2, 含 startAnchor/endingDirection
    const result = interpretGameRow(row);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run test:game-application -- --grep "schemaVersion 1→2 迁移"`
Expected: FAIL（`startAnchor` undefined / 版本检查拒绝 v2）

- [ ] **Step 3: 修改 interpretGameRow 版本检查接受 schemaVersion 1 或 2**

修改 `sqliteGameRepository.ts:242`：

```typescript
// 旧：if (blueprint["schemaVersion"] !== 1 || state["stateVersion"] !== 1) {
// 新：Phase 14：接受 schemaVersion 1（旧档）或 2（新档）；stateVersion 仍为 1
const blueprintVersion = blueprint["schemaVersion"];
if ((blueprintVersion !== 1 && blueprintVersion !== 2) || state["stateVersion"] !== 1) {
  return corrupt("VERSION_MISMATCH");
}
```

- [ ] **Step 4: 新增 withStartAnchorDefault 函数**

在 `sqliteGameRepository.ts` 的 `with*Defaults` 区域（第 181 行附近）新增：

```typescript
/** Phase 14: 旧存档（无 startAnchor 字段）补默认值——从 locations[0]/npcs[0]/quests[0] 推导。 */
function withStartAnchorDefault(blueprint: JsonObject): JsonObject {
  if (blueprint["startAnchor"] !== undefined) return blueprint;
  const locations = blueprint["locations"] as readonly JsonObject[] | undefined;
  const npcs = blueprint["npcs"] as readonly JsonObject[] | undefined;
  const quests = blueprint["quests"] as readonly JsonObject[] | undefined;
  const firstLocationId = locations?.[0]?.["id"] ?? "loc_1";
  const firstNpcId = npcs?.[0]?.["id"] ?? "npc_1";
  const firstQuestId = quests?.[0]?.["id"] ?? "quest_main_1";
  return { ...blueprint, startAnchor: { locationId: firstLocationId, npcId: firstNpcId, startQuestId: firstQuestId } };
}
```

- [ ] **Step 5: 新增 withEndingDirectionDefault 函数**

```typescript
/** Phase 14: 旧存档（无 endingDirection 字段）补默认值——lockedAt 从 budgetPolicy.mainActs 推导。 */
function withEndingDirectionDefault(blueprint: JsonObject): JsonObject {
  if (blueprint["endingDirection"] !== undefined) return blueprint;
  const budgetPolicy = blueprint["budgetPolicy"] as JsonObject | undefined;
  const mainActs = (budgetPolicy?.["mainActs"] as number | undefined) ?? 3;
  const world = blueprint["world"] as JsonObject | undefined;
  const themes = (world?.["themes"] as readonly string[] | undefined) ?? [];
  const theme = themes[0] ?? "未定";
  return {
    ...blueprint,
    endingDirection: {
      theme,
      possibleTones: ["triumph", "tragedy", "bittersweet"],
      lockedAt: Math.ceil(mainActs / 2),
    },
  };
}
```

- [ ] **Step 6: 新增 withPrologueDefault 函数**

```typescript
/** Phase 14: 旧存档 state 无 prologueShown 字段时补 true（已过开场）。 */
function withPrologueDefault(state: JsonObject): JsonObject {
  if (state["prologueShown"] !== undefined) return state;
  return { ...state, prologueShown: true };
}
```

- [ ] **Step 7: 新增 withMainStoryProgressDefault 函数**

```typescript
/** Phase 14: 旧存档 state 无 mainStoryProgress 字段时补默认值。 */
function withMainStoryProgressDefault(state: JsonObject): JsonObject {
  if (state["mainStoryProgress"] !== undefined) return state;
  // 根据已完成的 quest_completed 事件数量推导 currentAct
  const eventLedger = (state["eventLedger"] as readonly JsonObject[] | undefined) ?? [];
  const completedMainQuests = eventLedger.filter(
    (e) => e["type"] === "quest_completed",
  ).length;
  return {
    ...state,
    mainStoryProgress: {
      currentAct: completedMainQuests,
      endingProposed: false,
    },
  };
}
```

- [ ] **Step 8: 在 interpretGameRow 调用链中接入新函数**

修改 `sqliteGameRepository.ts:254-260`：

```typescript
// 旧：
// const visitedState = withVisitedLocationDefault(state);
// const migratedState = withTownDefaults(withNarrativeDefault(visitedState));
// const migratedBlueprint = withEnemyLocationIdDefault(withAvailableItemsDefault(blueprint));
// const phase6State = withPhase6StateDefaults(migratedState);

// 新：Phase 14 在链中追加 startAnchor/endingDirection/prologue/mainStoryProgress
const visitedState = withVisitedLocationDefault(state);
const narrativeState = withTownDefaults(withNarrativeDefault(visitedState));
const phase14State = withMainStoryProgressDefault(withPrologueDefault(narrativeState));
const phase6State = withPhase6StateDefaults(phase14State);
const migratedBlueprint = withEndingDirectionDefault(
  withStartAnchorDefault(
    withEnemyLocationIdDefault(withAvailableItemsDefault(blueprint)),
  ),
);
```

- [ ] **Step 9: 运行测试验证通过**

Run: `npm run test:game-application -- --grep "schemaVersion 1→2 迁移"`
Expected: PASS

- [ ] **Step 10: 运行全量 typecheck**

Run: `npm run typecheck`
Expected: 仍有 FAIL（下游 createFallbackBlueprint 等还未适配），但 sqliteGameRepository 相关错误消除

- [ ] **Step 11: 提交**

```bash
git add src/game/application/server/persistence/sqliteGameRepository.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
git commit -m "feat(persistence): Phase 14 schemaVersion 1→2 迁移——新增 withStartAnchorDefault/withEndingDirectionDefault/withPrologueDefault/withMainStoryProgressDefault"
```

---

### Task 3: 开局生成层收窄（createFallbackBlueprint + validateScenarioBlueprint）

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts:39,506-552,620,696-924`
- Modify: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts:84-87,100-131,115-122`
- Modify: `src/game/application/scenarioGeneration.ts:12`
- Modify: `src/game/application/server/ai/scenarioPrompt.ts`
- Modify: `src/game/application/server/ai/scenarioResponseFormat.ts`
- Modify: `src/game/application/server/ai/liveScenarioCandidateSource.ts`
- Modify: `src/game/application/server/ai/fixtureScenarioCandidateSource.ts`
- Test: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`（已存在）
- Test: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`（已存在）

**Interfaces:**
- Consumes: Task 1 的 `ScenarioBlueprint` schemaVersion 2 + `startAnchor`/`endingDirection`/`prologue`
- Produces: `createFallbackBlueprint` 返回 `ScenarioBlueprintCandidate`（仅 1 地点 + 1 NPC + 1 任务 + 序幕 + 结局方向）；`validateScenarioBlueprintCandidate` 分层校验

- [ ] **Step 1: 写失败测试——fallback 蓝图只含起始锚点**

在 `createFallbackBlueprint.test.ts` 新增：

```typescript
describe("Phase 14 开局 fallback 收窄", () => {
  test("只生成 1 个地点", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.locations).toHaveLength(1);
    expect(blueprint.locations[0].id).toBe("loc_1");
  });

  test("只生成 1 个 NPC", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.npcs).toHaveLength(1);
    expect(blueprint.npcs[0].id).toBe("npc_1");
  });

  test("只生成 1 个任务（stage 1）", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.quests).toHaveLength(1);
    expect(blueprint.quests[0].id).toBe("quest_main_1");
  });

  test("items/enemies/endings 为空数组", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.items).toEqual([]);
    expect(blueprint.enemies).toEqual([]);
    expect(blueprint.endings).toEqual([]);
  });

  test("含 startAnchor", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.startAnchor).toEqual({
      locationId: "loc_1",
      npcId: "npc_1",
      startQuestId: "quest_main_1",
    });
  });

  test("含 endingDirection", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.endingDirection).toBeDefined();
    expect(blueprint.endingDirection.theme).toBeTruthy();
    expect(blueprint.endingDirection.possibleTones.length).toBeGreaterThan(0);
    expect(blueprint.endingDirection.lockedAt).toBeGreaterThanOrEqual(1);
  });

  test("含 openingScene.prologue", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.openingScene.prologue).toBeDefined();
    expect(blueprint.openingScene.prologue?.text).toBeTruthy();
    expect(blueprint.openingScene.prologue?.tone).toMatch(/serious|epic|mysterious/);
  });

  test("schemaVersion 为 2", () => {
    const blueprint = createFallbackBlueprint(VALID_INPUT, "test-seed");
    expect(blueprint.schemaVersion).toBe(2);
  });

  test("FALLBACK_TEMPLATE_VERSION 升级", () => {
    expect(FALLBACK_TEMPLATE_VERSION).toBe("fallback-8");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run test:game-gameplay -- --grep "开局 fallback 收窄"`
Expected: FAIL

- [ ] **Step 3: 升级 FALLBACK_TEMPLATE_VERSION**

修改 `createFallbackBlueprint.ts:39`：

```typescript
export const FALLBACK_TEMPLATE_VERSION = "fallback-8";
```

- [ ] **Step 4: 重构 createFallbackBlueprint 为起始锚点+序幕+结局方向**

这是本 Task 最大的改动。修改 `createFallbackBlueprint.ts:506-552` 主函数，使其只产出：
- `schemaVersion: 2`
- `startAnchor: { locationId: "loc_1", npcId: "npc_1", startQuestId: "quest_main_1" }`
- `endingDirection: { theme, possibleTones, lockedAt }`（从题材模板推导）
- `locations: [起始地点]`（仅 1 个，`connectedLocationIds: []`）
- `npcs: [起始 NPC]`（仅 1 个，`locationId: "loc_1"`）
- `quests: [开场任务]`（仅 1 个，stage 1）
- `items: []`
- `enemies: []`
- `endings: []`
- `openingScene: { ...现有字段, prologue: { text, tone } }`

删除旧的 `buildLocations`/`buildNpcs`/`buildQuests`/`buildItems`/`buildEnemies`/`buildEndings` 多实体生成逻辑，替换为 `buildStartLocation`/`buildStartNpc`/`buildStartQuest` 单实体版本。

保留 `buildWorld`/`buildPlayer` 逻辑不变。

- [ ] **Step 5: 修改 validateScenarioBlueprintCandidate 支持 phase 参数**

修改 `validateScenarioBlueprint.ts:84-87`：

```typescript
export type ScenarioValidationContext = {
  readonly profile: GameTypeProfile;
  readonly policy: BudgetPolicy;
  /** Phase 14: 校验阶段——"opening"（开局，严格预算约束）或 "runtime_expansion"（运行时扩展，放宽约束）。 */
  readonly phase?: "opening" | "runtime_expansion";
};
```

- [ ] **Step 6: 修改 validateSchemaBasics 接受 schemaVersion 2**

在 `validateScenarioBlueprint.ts` 的 `validateSchemaBasics` 函数中，将 `schemaVersion !== 1` 改为 `schemaVersion !== 1 && schemaVersion !== 2`。

- [ ] **Step 7: 新增 validateStartAnchor/validateEndingDirection/validatePrologue**

在 `validateScenarioBlueprint.ts` 新增三个校验函数：

```typescript
/** Phase 14: 校验起始锚点完整性。 */
function validateStartAnchor(candidate: ScenarioBlueprintCandidate, issues: ScenarioBlueprintIssue[]): void {
  const anchor = candidate.startAnchor;
  if (!anchor) { issues.push({ code: "MISSING_START_ANCHOR", message: "startAnchor 缺失" }); return; }
  if (!anchor.locationId || !anchor.npcId || !anchor.startQuestId) {
    issues.push({ code: "INVALID_START_ANCHOR", message: "startAnchor 字段不完整" });
  }
  // 校验引用的 location/npc/quest 存在
  if (!candidate.locations.some((l) => l.id === anchor.locationId)) {
    issues.push({ code: "START_ANCHOR_LOCATION_MISSING", message: `startAnchor.locationId ${anchor.locationId} 不在 locations 中` });
  }
  // ... npcId / startQuestId 同理
}

/** Phase 14: 校验结局方向骨架。 */
function validateEndingDirection(candidate: ScenarioBlueprintCandidate, issues: ScenarioBlueprintIssue[]): void {
  const dir = candidate.endingDirection;
  if (!dir) { issues.push({ code: "MISSING_ENDING_DIRECTION", message: "endingDirection 缺失" }); return; }
  if (!dir.theme || dir.possibleTones.length === 0 || dir.lockedAt < 1) {
    issues.push({ code: "INVALID_ENDING_DIRECTION", message: "endingDirection 字段不合法" });
  }
}

/** Phase 14: 开局校验序幕必产。 */
function validatePrologue(candidate: ScenarioBlueprintCandidate, issues: ScenarioBlueprintIssue[]): void {
  const prologue = candidate.openingScene.prologue;
  if (!prologue) { issues.push({ code: "MISSING_PROLOGUE", message: "openingScene.prologue 缺失" }); return; }
  if (!prologue.text || !prologue.tone) {
    issues.push({ code: "INVALID_PROLOGUE", message: "prologue 字段不完整" });
  }
}
```

- [ ] **Step 8: 在主校验函数中调用新校验**

修改 `validateScenarioBlueprint.ts:100-131`，在 `validateOpeningScene` 之后调用新校验：

```typescript
// Phase 14 新增校验
validateStartAnchor(candidate, issues);
validateEndingDirection(candidate, issues);
if ((context.phase ?? "opening") === "opening") {
  validatePrologue(candidate, issues);
}
```

- [ ] **Step 9: runtime_expansion 阶段放宽 validateQuestGraph 的 endings 约束**

修改 `validateScenarioBlueprint.ts:115-122`：

```typescript
const phase = context.phase ?? "opening";
if (phase === "opening") {
  // 开局：保持现有 endings 数量约束
  issues.push(
    ...validateQuestGraph({
      quests: candidate.quests,
      endings: candidate.endings,
      knownEntityIds: collectKnownEntityIds(candidate),
      budget: { mainActs: context.policy.mainActs, sideQuestsMax: context.policy.opening.sideQuestsMax, endings: context.policy.opening.endings },
    }),
  );
} else {
  // 运行时扩展：放宽 endings 约束（允许空 endings 或运行时追加的结局）
  issues.push(
    ...validateQuestGraph({
      quests: candidate.quests,
      endings: candidate.endings,
      knownEntityIds: collectKnownEntityIds(candidate),
      budget: { mainActs: context.policy.mainActs, sideQuestsMax: context.policy.opening.sideQuestsMax, endings: 0 },
    }),
  );
}
```

- [ ] **Step 10: 升级 SCENARIO_CANDIDATE_CONTRACT_VERSION**

修改 `src/game/application/scenarioGeneration.ts:12`：

```typescript
export const SCENARIO_CANDIDATE_CONTRACT_VERSION = "scenario-dynamic-v3" as const;
```

- [ ] **Step 11: 收窄 scenarioPrompt.ts（开局 AI prompt 只要求起始锚点）**

修改 `src/game/application/server/ai/scenarioPrompt.ts`，将 prompt 改为只要求 AI 生成：
- `world` / `player` / `openingScene`（含 `prologue`）
- `startAnchor`（固定 `loc_1`/`npc_1`/`quest_main_1`）
- `endingDirection`（theme + possibleTones + lockedAt）
- `locations: [1]` / `npcs: [1]` / `quests: [1]`
- `items: []` / `enemies: []` / `endings: []`

不再要求 AI 产出所有地点/NPC/任务/敌人/结局的完整蓝图。

- [ ] **Step 12: 收窄 scenarioResponseFormat.ts JSON Schema**

修改 `src/game/application/server/ai/scenarioResponseFormat.ts`，将 JSON Schema 的 `locations`/`npcs`/`quests` 的 `minItems` 调整为 1，`items`/`enemies`/`endings` 的 `maxItems` 设为 0，新增 `startAnchor`/`endingDirection`/`prologue` 的 schema。

- [ ] **Step 13: 适配 liveScenarioCandidateSource 和 fixtureScenarioCandidateSource**

修改这两个文件，确保它们产出的 `ScenarioBlueprintCandidate` 含 `schemaVersion: 2` + `startAnchor` + `endingDirection` + `prologue`。

- [ ] **Step 14: 运行测试验证通过**

Run: `npm run test:game-gameplay -- --grep "开局 fallback 收窄"`
Expected: PASS

- [ ] **Step 15: 运行 typecheck**

Run: `npm run typecheck`
Expected: 仍有 FAIL（下游 intents/resolveAction 等未适配），但 scenario 相关错误消除

- [ ] **Step 16: 提交**

```bash
git add src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts src/game/application/scenarioGeneration.ts src/game/application/server/ai/scenarioPrompt.ts src/game/application/server/ai/scenarioResponseFormat.ts src/game/application/server/ai/liveScenarioCandidateSource.ts src/game/application/server/ai/fixtureScenarioCandidateSource.ts
git commit -m "feat(scenario): Phase 14 开局生成层收窄——fallback 仅起始锚点+序幕+结局方向，validate 分层校验"
```

---

### Task 4: dialogue_choice 废除 + talk 升级

**Files:**
- Delete: `src/game/gameplay/rpg/actions/dialogueChoices.ts`
- Modify: `src/game/gameplay/rpg/actions/intents.ts:14-24`
- Modify: `src/game/gameplay/rpg/actions/validateIntent.ts:166-200`
- Modify: `src/game/gameplay/rpg/actions/resolveAction.ts:247-295`
- Modify: `src/game/gameplay/rpg/actions/index.ts`
- Modify: `src/app/api/game/actions/actionHandler.ts`
- Modify: `src/game/application/performAction.ts:391-405`
- Test: `src/game/gameplay/rpg/actions/dialogueChoices.test.ts`（删除）
- Test: `src/game/gameplay/rpg/actions/resolveAction.test.ts`（已存在）
- Test: `src/game/application/performAction.test.ts`（已存在）

**Interfaces:**
- Consumes: Task 1 的 `NarrativeTriggerContext`
- Produces: `PlayerIntent` 联合不含 `DialogueChoiceIntent`；`talk` intent 首遇时排队 pending 场景（携带 `triggerContext`）

- [ ] **Step 1: 写失败测试——dialogue_choice intent 被拒绝**

在 `resolveAction.test.ts` 新增：

```typescript
describe("Phase 14 dialogue_choice 废除", () => {
  test("dialogue_choice intent 不再被 resolveAction 接受", () => {
    const intent = { type: "dialogue_choice", npcId: "npc_1" as NpcId, choiceId: "npc_1:greet" };
    const result = resolveAction(BLUEPRINT, STATE, intent as PlayerIntent, DEPS);
    // 应返回 INTENT_NOT_ROUTED 或类似错误
    expect(result.ok).toBe(false);
  });

  test("talk intent 首遇写 npc_met 事件", () => {
    const state = { ...STATE, npcs: [{ npcId: "npc_1" as NpcId, met: false, relationship: { affinity: 0 } }] };
    const intent = { type: "talk", npcId: "npc_1" as NpcId };
    const result = resolveAction(BLUEPRINT, state, intent, DEPS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.npcs[0].met).toBe(true);
      expect(result.events.some((e) => e.type === "npc_met")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run test:game-gameplay -- --grep "dialogue_choice 废除"`
Expected: FAIL（dialogue_choice 仍被接受）

- [ ] **Step 3: 从 PlayerIntent 联合中移除 DialogueChoiceIntent**

修改 `intents.ts:14-24`：

```typescript
export type PlayerIntent =
  | { readonly type: "observe"; readonly locationId: LocationId }
  | { readonly type: "talk"; readonly npcId: NpcId }
  | { readonly type: "investigate"; readonly factId: FactId }
  | { readonly type: "move"; readonly locationId: LocationId }
  | { readonly type: "take_item"; readonly itemId: ItemId }
  | { readonly type: "start_battle"; readonly enemyId: EnemyId }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "withdraw" }
  | { readonly type: "narrative_choice"; readonly choiceToken: string }
  | AckPrologueIntent;  // Phase 14 新增
```

- [ ] **Step 4: 新增 AckPrologueIntent**

在 `intents.ts` 新增：

```typescript
/** Phase 14: 内部 intent——标记序幕已播放（幂等，零事件，零排队）。 */
export type AckPrologueIntent = { readonly type: "ack_prologue" };
```

- [ ] **Step 5: 删除 dialogueChoices.ts 文件**

```bash
git rm src/game/gameplay/rpg/actions/dialogueChoices.ts src/game/gameplay/rpg/actions/dialogueChoices.test.ts
```

- [ ] **Step 6: 从 index.ts 移除 dialogueChoices re-export**

修改 `src/game/gameplay/rpg/actions/index.ts`，删除 `export * from "./dialogueChoices"` 行，保留 `talk`/`npcSpeech`/`classifyFreeDialogue` 的 re-export。

- [ ] **Step 7: 从 validateIntent.ts 删除 dialogue_choice 校验**

修改 `validateIntent.ts:166-200`，删除 `dialogue_choice` case 和 `INVALID_DIALOGUE_CHOICE`/`DIALOGUE_CHOICE_UNAVAILABLE` 错误码。

新增 `ack_prologue` 校验（总是合法，无参数）。

- [ ] **Step 8: 从 resolveAction.ts 删除 dialogue_choice case**

修改 `resolveAction.ts:247-295`，删除整个 `dialogue_choice` case。

新增 `ack_prologue` case：

```typescript
case "ack_prologue": {
  // 幂等：置 prologueShown=true，零事件
  return {
    ok: true,
    state: { ...state, prologueShown: true },
    events: [],
    feedback: { message: null },
  };
}
```

- [ ] **Step 9: 从 actionHandler.ts 删除 dialogue_choice 白名单**

修改 `actionHandler.ts`，删除 `dialogue_choice` 白名单条目，新增 `talk`（已有则保留）和 `ack_prologue`。

- [ ] **Step 10: 修改 performAction.ts 的 isRepeatGreet 守卫**

修改 `performAction.ts:391-405`，将 `isRepeatGreet` 替换为基于 `talk` 的首遇判断：

```typescript
// 旧：isRepeatGreet（基于 dialogue_choice + greet + met）
// 新：Phase 14——talk intent 的首遇判断
const isRepeatTalk =
  command.intent.type === "talk" &&
  (record.state.npcs.find((npc) => npc.npcId === command.intent.npcId)?.met ?? true);

if (record.state.narrative.mode !== "offline" &&
    deps.runtimeNarrativeSources !== undefined &&
    canQueueRuntimeNarrativeScene(record.blueprint, nextState)) {
  // ack_prologue 跳过排队（纯幂等标记）
  // talk 首遇才排队；非 talk intent 也排队（narrative_choice 等）
  const shouldQueue = command.intent.type !== "ack_prologue" && !isRepeatTalk;
  if (shouldQueue) {
    nextState = {
      ...nextState,
      narrative: {
        currentScene: null,
        generation: {
          status: "pending",
          requestedAt: deps.now(),
          triggerContext: command.intent.type === "talk"
            ? { kind: "talk", npcId: command.intent.npcId, isFirstMeeting: !isRepeatTalk }
            : command.intent.type === "narrative_choice"
            ? { kind: "narrative_choice_followup", previousChoiceActionKey: command.intent.choiceToken }
            : undefined,
        },
        mode: nextState.narrative.mode,
      },
    };
  }
}
```

- [ ] **Step 11: 运行测试验证通过**

Run: `npm run test:game-gameplay -- --grep "dialogue_choice 废除"`
Expected: PASS

- [ ] **Step 12: 运行边界测试**

Run: `npm run test:boundaries`
Expected: PASS（dialogueChoices 删除后守卫清理）

- [ ] **Step 13: 提交**

```bash
git add -A
git commit -m "feat(actions): Phase 14 dialogue_choice 废除 + talk 升级 + ack_prologue 新增"
```

---

### Task 5: NPC对话层统一（场景对白+情境选项）

**Files:**
- Modify: `src/game/application/locationAdventureView.ts:261-299,317-332`
- Modify: `src/game/application/orchestrateNarrativeScene.ts:160-241`
- Modify: `src/game/gameplay/rpg/narrative/types.ts:29-43,74-88`
- Modify: `src/game/application/handleNpcDialogue.ts`
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/components/AdventureGameShell.tsx:169-196,321`
- Modify: `src/components/NpcDialoguePanel.tsx`
- Test: `src/game/application/locationAdventureView.test.ts`（已存在）
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`（已存在）

**Interfaces:**
- Consumes: Task 1 的 `NpcDialogueInScene`/`NarrativeTriggerContext`；Task 4 的 `talk` 升级
- Produces: `projectDialogues` 从 `narrative.currentScene` 读取对白+情境选项；`DirectorProposal` 含 `proposedEnding?`；`SceneScriptProposal` 支持多 NPC 对白

- [ ] **Step 1: 写失败测试——projectDialogues 从 currentScene 读取**

在 `locationAdventureView.test.ts` 新增：

```typescript
describe("Phase 14 NPC 对话层统一", () => {
  test("无 currentScene 时返回空 choices", () => {
    const state = { ...STATE, narrative: { ...STATE.narrative, currentScene: null } };
    const view = projectLocationAdventureView(BLUEPRINT, state);
    const npc = view.npcDialogues[0];
    expect(npc.choices).toEqual([]);
  });

  test("有 currentScene 时从 scene.choices 读取情境选项", () => {
    const scene = {
      sceneId: "scene_1",
      turn: 1,
      narration: "test",
      usedFactIds: [],
      npcLine: null,
      choices: [
        { choiceToken: "tok_1", label: "选项A", actionKey: "observe" },
        { choiceToken: "tok_2", label: "选项B", actionKey: "investigate" },
      ],
      source: "generated" as const,
      npcDialogues: [{ npcId: "npc_1", npcName: "老者", npcRole: "elder", speechPages: ["你好"] }],
    };
    const state = { ...STATE, narrative: { ...STATE.narrative, currentScene: scene } };
    const view = projectLocationAdventureView(BLUEPRINT, state);
    const npc = view.npcDialogues[0];
    expect(npc.choices.length).toBe(2);
    expect(npc.choices[0].label).toBe("选项A");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run test:game-application -- --grep "NPC 对话层统一"`
Expected: FAIL

- [ ] **Step 3: 修改 projectDialogues 从 currentScene 读取**

修改 `locationAdventureView.ts:261-299`，将 `projectDialogueChoices`（规则投影）替换为从 `state.narrative.currentScene` 读取：

```typescript
function projectDialogues(
  blueprint: ScenarioBlueprint,
  state: GameState,
  readOnly: boolean,
): readonly NpcDialogueView[] {
  const currentId = String(state.currentLocationId);
  const scene = state.narrative.currentScene;
  const inSceneNpcIds = scene?.presentNpcIds ?? [];

  return state.npcs
    .filter((npcState) => {
      const npc = blueprint.npcs.find((n) => n.id === npcState.npcId);
      return npc && String(npc.locationId) === currentId;
    })
    .map((npcState) => {
      const npc = blueprint.npcs.find((n) => n.id === npcState.npcId)!;
      const sceneHasThisNpc = inSceneNpcIds.includes(npcState.npcId);

      // 从 currentScene 读取对白
      const sceneDialogue = scene?.npcDialogues?.find((d) => d.npcId === npcState.npcId);
      const speechPages = sceneDialogue?.speechPages ?? [];

      // 从 currentScene.choices 读取情境选项
      const choices = (readOnly || !sceneHasThisNpc)
        ? []
        : (scene?.choices ?? []).map((c) => ({
            choiceToken: c.choiceToken,
            label: c.label,
            hint: c.hint,
          }));

      return {
        npcId: String(npcState.npcId),
        npcName: npc.name,
        npcRole: npc.role,
        relationshipTier: projectRelationshipTier(npcState),
        speechPages,
        choices,
        freeInputEnabled: !readOnly && sceneHasThisNpc,
      };
    });
}
```

- [ ] **Step 4: 修改 DirectorProposal 新增 proposedEnding**

修改 `narrative/types.ts:29-43`，在 `proposedNewNpcs` 后新增：

```typescript
  readonly proposedNewNpcs: readonly ProposedNewNpc[];
  /** Phase 14: 结局提议（达阈值时导演可提议）。 */
  readonly proposedEnding?: ProposedEnding;
```

- [ ] **Step 5: 修改 SceneScriptProposal 支持多 NPC 对白**

修改 `narrative/types.ts:74-88`，将 `npcInstruction`（单数）扩展为同时支持多 NPC：

```typescript
export type SceneScriptProposal = {
  readonly narration: string;
  readonly usedFactIds: readonly string[];
  readonly npcInstruction: {
    readonly npcId: string;
    readonly speechAct: "inform" | "ask" | "evade" | "deny" | "warn" | "encourage";
    readonly emotion: NarrativeEmotion;
    readonly allowedFactIds: readonly string[];
    readonly mayLie: boolean;
  } | null;
  /** Phase 14: 多 NPC 对白指令（含焦点 NPC）。 */
  readonly additionalNpcInstructions?: readonly {
    readonly npcId: string;
    readonly speechAct: "inform" | "ask" | "evade" | "deny" | "warn" | "encourage";
    readonly emotion: NarrativeEmotion;
    readonly allowedFactIds: readonly string[];
    readonly mayLie: boolean;
  }[];
  readonly choices: readonly [
    { readonly actionKey: string; readonly label: string; readonly strategy: string },
    { readonly actionKey: string; readonly label: string; readonly strategy: string },
  ];
};
```

- [ ] **Step 6: 修改 orchestrateNarrativeScene 组装 npcDialogues**

修改 `orchestrateNarrativeScene.ts:199-241`，在 NPC 演员阶段为每个 `presentNpcId` 生成对白：

```typescript
// Phase 14: 为场景内每个 NPC 生成对白分页
const npcDialogues: NpcDialogueInScene[] = [];
for (const npcId of approvedScript.presentNpcIds) {
  const npcInstruction = npcId === approvedScript.npcInstruction?.npcId
    ? approvedScript.npcInstruction
    : approvedScript.additionalNpcInstructions?.find((i) => i.npcId === npcId) ?? null;

  if (npcInstruction) {
    const npcLineContext = toNpcLineContext(blueprint, state, npcId, npcInstruction);
    const npcPerformance = await retryRole("npc", () => deps.npcLineSource.generate(npcLineContext));
    if (npcPerformance.ok) {
      const npc = blueprint.npcs.find((n) => String(n.id) === npcId);
      npcDialogues.push({
        npcId: npcId as NpcId,
        npcName: npc?.name ?? "未知",
        npcRole: npc?.role ?? "stranger",
        speechPages: paginateSpeechText(npcPerformance.performance.text),
      });
    }
  }
}
```

- [ ] **Step 7: 修改 handleNpcDialogue 携带 triggerContext**

修改 `handleNpcDialogue.ts`，在排队 pending 时携带 `triggerContext`：

```typescript
// Phase 14: 自由输入触发 pending 时携带 triggerContext
nextState = {
  ...nextState,
  narrative: {
    currentScene: null,
    generation: {
      status: "pending",
      requestedAt: deps.now(),
      triggerContext: { kind: "free_input", npcId: command.npcId, playerText: command.text },
      playerNpcChat: { npcId: command.npcId, playerText: command.text, npcName, npcRole },
    },
    mode: nextState.narrative.mode,
  },
};
```

- [ ] **Step 8: 修改 gameSessionView 投影 npcDialogues**

修改 `gameSessionView.ts`，确保 `NarrativeSceneView` 含 `npcDialogues` 字段。

- [ ] **Step 9: 修改 AdventureGameShell 移除 handleDialogueChoice**

修改 `AdventureGameShell.tsx:169-196,321`，将 `handleDialogueChoice`（提交 `dialogue_choice`）改为直接渲染 `NpcDialoguePanel`（从 view 读取已投影的 choices）。

- [ ] **Step 10: 修改 NpcDialoguePanel 统一渲染**

修改 `NpcDialoguePanel.tsx`，直接渲染 `view.npcDialogues` 中的 `choices` 和 `speechPages`，不再区分 greet/ask_main_quest/review_clue。

- [ ] **Step 11: 运行测试验证通过**

Run: `npm run test:game-application -- --grep "NPC 对话层统一"`
Expected: PASS

- [ ] **Step 12: 提交**

```bash
git add -A
git commit -m "feat(narrative): Phase 14 NPC 对话层统一——从 currentScene 读取对白+情境选项，移除规则投影"
```

---

### Task 6: 序幕 UI 与 API

**Files:**
- Create: `src/components/PrologueScreen.tsx`
- Create: `src/app/api/game/prologue/ack/route.ts`
- Modify: `src/components/CurrentGameScreen.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/PrologueScreen.test.tsx`（新增）

**Interfaces:**
- Consumes: Task 1 的 `PrologueDefinition`/`GameState.prologueShown`；Task 4 的 `ack_prologue` intent
- Produces: `POST /api/game/prologue/ack` 委托 `performAction({ intent: { type: "ack_prologue" } })`

- [ ] **Step 1: 写失败测试——PrologueScreen 渲染**

创建 `src/components/PrologueScreen.test.tsx`：

```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { PrologueScreen } from "./PrologueScreen";

describe("PrologueScreen", () => {
  test("渲染序幕文本", () => {
    render(
      <PrologueScreen
        prologue={{ text: "南宋覆灭五十余年", tone: "serious" }}
        onComplete={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("点击触发 onComplete", () => {
    const onComplete = vi.fn();
    render(
      <PrologueScreen
        prologue={{ text: "测试", tone: "epic" }}
        onComplete={onComplete}
      />,
    );
    // 第一次点击：显示全文
    fireEvent.click(screen.getByRole("dialog"));
    // 第二次点击：触发 onComplete
    fireEvent.click(screen.getByRole("dialog"));
    expect(onComplete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run test:components -- --grep "PrologueScreen"`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 创建 PrologueScreen 组件**

创建 `src/components/PrologueScreen.tsx`：

```tsx
"use client";

import { useEffect, useState } from "react";

interface PrologueScreenProps {
  prologue: { text: string; tone: "serious" | "epic" | "mysterious"; durationMs?: number };
  onComplete: () => void;
}

/** Phase 14: 黑底白字序幕开场组件。 */
export function PrologueScreen({ prologue, onComplete }: PrologueScreenProps) {
  const [displayedText, setDisplayedText] = useState("");
  const [isComplete, setIsComplete] = useState(false);

  // 逐字淡入动画
  useEffect(() => {
    let index = 0;
    const speed = prologue.tone === "epic" ? 80 : 50;
    const timer = setInterval(() => {
      if (index < prologue.text.length) {
        setDisplayedText(prologue.text.slice(0, index + 1));
        index++;
      } else {
        clearInterval(timer);
        setIsComplete(true);
      }
    }, speed);
    return () => clearInterval(timer);
  }, [prologue.text, prologue.tone]);

  /** 点击/按键跳过：先显示全文，再次点击进入游戏。 */
  const handleSkip = () => {
    if (!isComplete) {
      setDisplayedText(prologue.text);
      setIsComplete(true);
    } else {
      onComplete();
    }
  };

  useEffect(() => {
    const handleKey = () => handleSkip();
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isComplete]);

  return (
    <div
      className="prologue-screen"
      role="dialog"
      aria-label="游戏序幕"
      onClick={handleSkip}
    >
      <div className="prologue-content">
        <p className="prologue-text">{displayedText}</p>
        {isComplete && <p className="prologue-hint">点击任意处继续</p>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 在 globals.css 新增序幕样式**

```css
.prologue-screen {
  position: fixed;
  inset: 0;
  background-color: #000;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  cursor: pointer;
  z-index: 9999;
  animation: prologue-fade-in 800ms ease-out;
}

.prologue-content {
  max-width: 640px;
  text-align: center;
}

.prologue-text {
  font-size: 1.25rem;
  line-height: 1.8;
  white-space: pre-wrap;
}

.prologue-hint {
  margin-top: 2rem;
  opacity: 0.6;
  font-size: 0.9rem;
}

@keyframes prologue-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

- [ ] **Step 5: 创建 prologue/ack API route**

创建 `src/app/api/game/prologue/ack/route.ts`：

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCompositionRoot } from "@/game/application/server/compositionRoot";

/** POST /api/game/prologue/ack —— 标记序幕已播放（委托 performAction）。 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json();
  const { revision } = body;
  const root = getCompositionRoot();
  const result = await root.performAction({
    intent: { type: "ack_prologue" },
    expectedRevision: revision,
  });
  return result.ok
    ? NextResponse.json({ view: result.view })
    : NextResponse.json({ code: result.code }, { status: 409 });
}
```

- [ ] **Step 6: 修改 CurrentGameScreen 增加序幕优先级**

修改 `CurrentGameScreen.tsx`：

```tsx
export function CurrentGameScreen({ view }: { view: GameSessionView }) {
  // Phase 14: 序幕未播放时显示 PrologueScreen
  if (!view.prologueShown && view.openingScene?.prologue) {
    return (
      <PrologueScreen
        prologue={view.openingScene.prologue}
        onComplete={() => void markPrologueShown(view.revision)}
      />
    );
  }
  return <AdventureGameShell view={view} />;
}

/** 标记序幕已播放（CAS 幂等）。 */
async function markPrologueShown(revision: number): Promise<void> {
  await fetch("/api/game/prologue/ack", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision }),
  });
}
```

- [ ] **Step 7: 确保 gameSessionView 投影 prologue/prologueShown**

修改 `gameSessionView.ts`，确保 view 含 `prologueShown` 和 `openingScene.prologue`。

- [ ] **Step 8: 运行测试验证通过**

Run: `npm run test:components -- --grep "PrologueScreen"`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(ui): Phase 14 序幕 UI——黑底白字开场 + ack API + CurrentGameScreen 优先级"
```

---

### Task 7: 小镇入口过滤

**Files:**
- Modify: `src/game/application/townRuntimeView.ts:44-54,61-64,87-100`
- Modify: `src/game/application/locationAdventureView.ts:317-332`
- Modify: `src/components/TownLayerScreen.tsx`
- Test: `src/game/application/townRuntimeView.test.ts`（已存在）

**Interfaces:**
- Consumes: Task 1 的 `GameState`
- Produces: `projectTownLayerView(blueprint, town, state)` 新增 `state` 参数；`interactiveBuildings` 加"任务目标+已结识"过滤

- [ ] **Step 1: 写失败测试——未结识且非 talk 目标的建筑不可进入**

在 `townRuntimeView.test.ts` 新增：

```typescript
describe("Phase 14 小镇入口过滤", () => {
  test("未结识且非 talk 目标的 NPC 建筑不在 interactiveBuildings 中", () => {
    const blueprint = { ...BLUEPRINT, npcs: [{ id: "npc_2", locationId: "loc_1" }] };
    const state = {
      ...STATE,
      npcs: [{ npcId: "npc_2", met: false }],
      quests: [],
    };
    const town = { ...TOWN, buildings: [{ planKey: "story_npc_npc_2" }] };
    const view = projectTownLayerView(blueprint, town, state);
    expect(view.interactiveBuildings).toEqual([]);
  });

  test("已结识的 NPC 建筑在 interactiveBuildings 中", () => {
    const state = {
      ...STATE,
      npcs: [{ npcId: "npc_2", met: true }],
      quests: [],
    };
    const town = { ...TOWN, buildings: [{ planKey: "story_npc_npc_2" }] };
    const view = projectTownLayerView(BLUEPRINT, town, state);
    expect(view.interactiveBuildings).toHaveLength(1);
  });

  test("talk_to_npc objective 指向的 NPC 建筑在 interactiveBuildings 中", () => {
    const blueprint = {
      ...BLUEPRINT,
      npcs: [{ id: "npc_2", locationId: "loc_1" }],
      quests: [{
        id: "quest_main_1",
        kind: "main",
        stage: 1,
        objectives: [{ kind: "talk_to_npc", npcId: "npc_2", id: "obj_1" }],
        onSuccess: { unlockQuests: [], reachEnding: null },
        onFailure: { failQuests: [] },
        tags: [],
      }],
    };
    const state = {
      ...STATE,
      npcs: [{ npcId: "npc_2", met: false }],
      quests: [{ questId: "quest_main_1", status: "active", objectiveProgress: {} }],
    };
    const town = { ...TOWN, buildings: [{ planKey: "story_npc_npc_2" }] };
    const view = projectTownLayerView(blueprint, town, state);
    expect(view.interactiveBuildings).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run test:game-application -- --grep "小镇入口过滤"`
Expected: FAIL

- [ ] **Step 3: 修改 projectTownLayerView 新增 state 参数**

修改 `townRuntimeView.ts:61-64`：

```typescript
export function projectTownLayerView(
  blueprint: ScenarioBlueprint,
  town: TownRuntimeState,
  state: GameState,  // Phase 14 新增
): TownLayerView
```

- [ ] **Step 4: 新增 collectActiveTalkTargetNpcIds 辅助函数**

在 `townRuntimeView.ts` 新增：

```typescript
/** Phase 14: 收集当前 active quest 的 talk_to_npc objective 指向的 NPC ID。 */
function collectActiveTalkTargetNpcIds(blueprint: ScenarioBlueprint, state: GameState): Set<string> {
  const result = new Set<string>();
  for (const quest of blueprint.quests) {
    const stateQuest = state.quests.find((sq) => sq.questId === quest.id);
    if (stateQuest?.status !== "active") continue;
    for (const obj of quest.objectives) {
      if (obj.kind === "talk_to_npc" && stateQuest.objectiveProgress[obj.id] !== "completed") {
        result.add(String(obj.npcId));
      }
    }
  }
  return result;
}
```

- [ ] **Step 5: 修改 interactiveBuildings 投影加过滤**

修改 `townRuntimeView.ts:87-100`：

```typescript
const knownNpcIds = new Set(blueprint.npcs.map((npc) => String(npc.id)));
// Phase 14: 已结识的 NPC
const metNpcIds = new Set(
  state.npcs.filter((n) => n.met).map((n) => String(n.npcId)),
);
// Phase 14: active quest 的 talk_to_npc objective 指向的 NPC
const activeTalkTargetNpcIds = collectActiveTalkTargetNpcIds(blueprint, state);

const interactiveBuildings: TownInteractiveBuildingView[] = [];
for (const building of snapshot.buildings) {
  const key = building.planKey;
  if (key === undefined || !key.startsWith(STORY_NPC_KEY_PREFIX)) continue;
  const npcId = key.slice(STORY_NPC_KEY_PREFIX.length);
  if (!knownNpcIds.has(npcId)) continue;
  // Phase 14: 任务目标+已结识过滤
  const isMet = metNpcIds.has(npcId);
  const isTalkTarget = activeTalkTargetNpcIds.has(npcId);
  if (!isMet && !isTalkTarget) continue;
  interactiveBuildings.push({
    buildingId: building.buildingId,
    buildingKey: key,
    displayName: building.displayName,
    buildingType: building.buildingType,
    npcIds: [npcId],
  });
}
```

- [ ] **Step 6: 修改 locationAdventureView 调用传 state**

修改 `locationAdventureView.ts:325`：

```typescript
// 旧：town = projectTownLayerView(blueprint, entry);
// 新：Phase 14 传 state
town = projectTownLayerView(blueprint, entry, state);
```

- [ ] **Step 7: 修改 TownLayerScreen 渲染占位图**

修改 `TownLayerScreen.tsx`，对非 `interactiveBuildings` 中的建筑渲染占位图，无"进入"按钮。

- [ ] **Step 8: 运行测试验证通过**

Run: `npm run test:game-application -- --grep "小镇入口过滤"`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add -A
git commit -m "feat(town): Phase 14 小镇入口过滤——任务目标+已结识判定，非可进入建筑占位图"
```

---

### Task 8: 结局推演机制

**Files:**
- Create: `src/game/gameplay/rpg/quests/storyProgression.ts`
- Create: `src/game/gameplay/rpg/narrative/approveEndingProposal.ts`
- Create: `src/game/gameplay/rpg/narrative/applyEndingToBlueprint.ts`
- Modify: `src/game/application/orchestrateNarrativeScene.ts:107-158`
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Test: `src/game/gameplay/rpg/quests/storyProgression.test.ts`（新增）
- Test: `src/game/gameplay/rpg/narrative/approveEndingProposal.test.ts`（新增）

**Interfaces:**
- Consumes: Task 1 的 `ProposedEnding`/`EndingTone`；`GameState.mainStoryProgress`
- Produces: `reconcileMainStoryProgress` 纯函数；`approveEndingProposal` 8 步闸门；`applyEndingToBlueprint` 不可变更新

- [ ] **Step 1: 写失败测试——reconcileMainStoryProgress**

创建 `src/game/gameplay/rpg/quests/storyProgression.test.ts`：

```typescript
describe("reconcileMainStoryProgress", () => {
  test("无已完成主线任务时 currentAct=0", () => {
    const result = reconcileMainStoryProgress(BLUEPRINT, STATE_WITH_NO_COMPLETED, DEPS);
    expect(result.currentAct).toBe(0);
    expect(result.shouldProposeEnding).toBe(false);
  });

  test("达 lockedAt 阈值时 shouldProposeEnding=true", () => {
    const blueprint = { ...BLUEPRINT, endingDirection: { theme: "test", possibleTones: ["triumph"], lockedAt: 2 } };
    const state = { ...STATE, mainStoryProgress: { currentAct: 2, endingProposed: false } };
    const result = reconcileMainStoryProgress(blueprint, state, DEPS);
    expect(result.shouldProposeEnding).toBe(true);
  });

  test("已提议过结局时 shouldProposeEnding=false", () => {
    const state = { ...STATE, mainStoryProgress: { currentAct: 3, endingProposed: true } };
    const result = reconcileMainStoryProgress(BLUEPRINT, state, DEPS);
    expect(result.shouldProposeEnding).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npm run test:game-gameplay -- --grep "reconcileMainStoryProgress"`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 storyProgression.ts**

创建 `src/game/gameplay/rpg/quests/storyProgression.ts`：

```typescript
import type { ScenarioBlueprint } from "@/game/domain/scenarioBlueprint";
import type { GameState } from "@/game/domain/gameState";
import type { ReconcileQuestsDependencies } from "./reconcileQuests";

/** Phase 14: 主线幕数追踪——统计已完成的主线任务数量。 */
export function reconcileMainStoryProgress(
  blueprint: ScenarioBlueprint,
  state: GameState,
  deps: ReconcileQuestsDependencies,
): { currentAct: number; shouldProposeEnding: boolean } {
  // 统计已完成/关闭的主线任务
  const completedMainQuests = blueprint.quests.filter(
    (q) => q.kind === "main" && state.quests.some(
      (sq) => sq.questId === q.id && (sq.status === "completed" || sq.status === "closed"),
    ),
  );
  const currentAct = completedMainQuests.length;
  const lockedAt = blueprint.endingDirection.lockedAt;
  const shouldProposeEnding =
    currentAct >= lockedAt && !state.mainStoryProgress.endingProposed;
  return { currentAct, shouldProposeEnding };
}
```

- [ ] **Step 4: 写失败测试——approveEndingProposal 8 步闸门**

创建 `src/game/gameplay/rpg/narrative/approveEndingProposal.test.ts`：

```typescript
describe("approveEndingProposal", () => {
  test("none_proposed: 未提议时拒绝", () => {
    const result = approveEndingProposal({ blueprint: BLUEPRINT, state: STATE, proposed: undefined as any });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("none_proposed");
  });

  test("not_locked: 未达阈值时拒绝", () => {
    const blueprint = { ...BLUEPRINT, endingDirection: { theme: "test", possibleTones: ["triumph"], lockedAt: 5 } };
    const state = { ...STATE, mainStoryProgress: { currentAct: 1, endingProposed: false } };
    const result = approveEndingProposal({ blueprint, state, proposed: VALID_PROPOSED_ENDING });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_locked");
  });

  test("already_proposed: 已提议过时拒绝", () => {
    const state = { ...STATE, mainStoryProgress: { currentAct: 5, endingProposed: true } };
    const result = approveEndingProposal({ blueprint: BLUEPRINT, state, proposed: VALID_PROPOSED_ENDING });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("already_proposed");
  });

  test("tone_mismatch: 基调不在 possibleTones 内时拒绝", () => {
    const blueprint = { ...BLUEPRINT, endingDirection: { theme: "test", possibleTones: ["triumph"], lockedAt: 1 } };
    const proposed = { ...VALID_PROPOSED_ENDING, tone: "tragedy" as EndingTone };
    const result = approveEndingProposal({ blueprint, state: STATE, proposed });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tone_mismatch");
  });

  test("审批通过时返回 approvedEnding", () => {
    const result = approveEndingProposal({ blueprint: BLUEPRINT, state: STATE_WITH_THRESHOLD, proposed: VALID_PROPOSED_ENDING });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvedEnding.name).toBe(VALID_PROPOSED_ENDING.name);
    }
  });
});
```

- [ ] **Step 5: 运行测试验证失败**

Run: `npm run test:game-gameplay -- --grep "approveEndingProposal"`
Expected: FAIL

- [ ] **Step 6: 创建 approveEndingProposal.ts**

创建 `src/game/gameplay/rpg/narrative/approveEndingProposal.ts`，实现 8 步闸门（见 spec 第 422-430 行）。

- [ ] **Step 7: 创建 applyEndingToBlueprint.ts**

创建 `src/game/gameplay/rpg/narrative/applyEndingToBlueprint.ts`：

```typescript
import type { ScenarioBlueprint, EndingDefinition } from "@/game/domain/scenarioBlueprint";

/** Phase 14: 将审批通过的结局追加到 blueprint.endings[]（不可变更新）。 */
export function applyEndingToBlueprint(
  blueprint: ScenarioBlueprint,
  approvedEnding: EndingDefinition,
): ScenarioBlueprint {
  return {
    ...blueprint,
    endings: [...blueprint.endings, approvedEnding],
  };
}
```

- [ ] **Step 8: 修改 orchestrateNarrativeScene 在达阈值时调用审批**

修改 `orchestrateNarrativeScene.ts:107-158`，在导演阶段后检查 `shouldProposeEnding`：

```typescript
// Phase 14: 达阈值时导演提议结局，经闸门审批
const { shouldProposeEnding } = reconcileMainStoryProgress(blueprint, state, questDeps);
if (shouldProposeEnding && directorProposal.proposedEnding) {
  const endingDecision = approveEndingProposal({
    blueprint,
    state,
    proposed: directorProposal.proposedEnding,
  });
  if (endingDecision.ok) {
    blueprint = applyEndingToBlueprint(blueprint, endingDecision.approvedEnding);
    // 更新 state.mainStoryProgress.endingProposed
    state = {
      ...state,
      mainStoryProgress: { ...state.mainStoryProgress, endingProposed: true },
    };
  }
}
```

- [ ] **Step 9: 修改 liveRuntimeNarrativeSources 扩展 director prompt**

修改 `liveRuntimeNarrativeSources.ts`，在 `endingProposalAllowed === true` 时扩展 director prompt 允许提议结局。

- [ ] **Step 10: 运行测试验证通过**

Run: `npm run test:game-gameplay -- --grep "reconcileMainStoryProgress|approveEndingProposal"`
Expected: PASS

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "feat(ending): Phase 14 结局推演机制——主线追踪+8步闸门审批+蓝图扩展"
```

---

### Task 9: 回归测试与验收

**Files:**
- Create: `src/game/application/phase14ProgressiveGenerationRegression.test.ts`
- Test: 全量测试

**Interfaces:**
- Consumes: 所有前序 Task 的产出

- [ ] **Step 1: 写回归测试**

创建 `src/game/application/phase14ProgressiveGenerationRegression.test.ts`，覆盖 spec 第 527-537 行的 9 个测试用例。

- [ ] **Step 2: 运行回归测试**

Run: `npm run test:game-application -- --grep "Phase 14 渐进式生成与剧情推演"`
Expected: PASS

- [ ] **Step 3: 运行全量测试**

Run: `npm run test`
Expected: PASS

- [ ] **Step 4: 运行边界测试**

Run: `npm run test:boundaries`
Expected: PASS

- [ ] **Step 5: 运行 typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: 运行 lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 7: 运行 build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "test: Phase 14 回归测试——渐进式生成与剧情推演完整旅程"
```

---

## Self-Review

### 1. Spec coverage

| Spec 要求 | 对应 Task |
|---|---|
| schemaVersion 2 + startAnchor + endingDirection + prologue | Task 1 |
| with*Defaults 迁移 + 版本检查 | Task 2 |
| createFallbackBlueprint 收窄 + validate 分层 + AI prompt 收窄 | Task 3 |
| dialogue_choice 废除 + talk 升级 + ack_prologue | Task 4 |
| NPC 对话面板统一 + DirectorProposal.proposedEnding + SceneScriptProposal 多 NPC | Task 5 |
| PrologueScreen + ack API + CurrentGameScreen 优先级 | Task 6 |
| 小镇入口过滤 + allBuildings | Task 7 |
| storyProgression + approveEndingProposal + applyEndingToBlueprint + orchestrateNarrativeScene | Task 8 |
| 回归测试 + 全量验收 | Task 9 |

### 2. Placeholder scan

- 无 "TBD" / "TODO" / "implement later"
- 每个步骤都有具体代码或命令
- 类型签名前后一致（`NarrativeTriggerContext`/`NpcDialogueInScene`/`ProposedEnding`/`EndingTone`/`PrologueDefinition` 在 Task 1 定义，后续 Task 引用同名）

### 3. Type consistency

- `reconcileMainStoryProgress` 参数 `deps: ReconcileQuestsDependencies`（Task 8 与代码事实一致）
- `approveEndingProposal` 参数 `proposed: ProposedEnding`（Task 8 与 Task 1 定义一致）
- `projectTownLayerView` 新增 `state: GameState` 参数（Task 7 与 Task 1 的 `GameState` 一致）
- `ack_prologue` intent 在 Task 4 定义，Task 6 的 API route 引用
