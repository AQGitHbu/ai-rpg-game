import type {
  GameState,
  GenerationMetadata,
  ScenarioBlueprint,
  ScenarioBlueprintCandidate
} from "@/game/domain";
import type {
  ScenarioBlueprintIssue,
  ValidateScenarioBlueprintResult
} from "./validateScenarioBlueprint";

// ---------------------------------------------------------------------------
// 蓝图编译与初始状态构造（Task 5）。
//
// API 约定（两种候选设计中选择了结果透传式，理由是可直接串联管线）：
//   compileScenarioBlueprint(validateScenarioBlueprintCandidate(candidate, ctx))
// 校验失败时原样透传结构化诊断，绝不产出部分蓝图；成功分支只可能从
// ValidatedScenarioBlueprintCandidate（品牌类型）构造，这里因此成为
// ScenarioBlueprint 品牌的唯一铸造点。
// 纯函数层：不读 JSON/环境/时间/随机。
// ---------------------------------------------------------------------------

export type CompileScenarioBlueprintResult =
  | { ok: true; blueprint: ScenarioBlueprint }
  | { ok: false; issues: readonly ScenarioBlueprintIssue[] };

export function compileScenarioBlueprint(
  validation: ValidateScenarioBlueprintResult
): CompileScenarioBlueprintResult {
  if (!validation.ok) return { ok: false, issues: validation.issues };

  // 深拷贝后排序：候选（可能已被调用方冻结）绝不被修改。
  const compiled = deepClone(validation.validated) as ScenarioBlueprintCandidate;
  sortById(compiled.locations);
  sortById(compiled.npcs);
  sortById(compiled.quests);
  sortById(compiled.enemies);
  sortById(compiled.items);
  sortById(compiled.endings);
  sortById(compiled.world.facts);
  deepFreeze(compiled);
  // 唯一铸造点：字符串 ID 品牌化 + compiled 品牌（均为 phantom 类型，运行时无痕）。
  return { ok: true, blueprint: compiled as unknown as ScenarioBlueprint };
}

/** 蓝图数据是纯 JSON 结构（无 Date/Map），手写克隆保证确定性且不依赖宿主环境 API。 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepClone(entry)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) clone[key] = deepClone(child);
    return clone as T;
  }
  return value;
}

/** 稳定排序：按 id 升序（ID 全局唯一，比较器不会遇到相等分支）。 */
function sortById(entries: readonly { readonly id: string }[]): void {
  (entries as { id: string }[]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

// ---------------------------------------------------------------------------
// initializeGameState：初始状态完全由已编译蓝图派生。
// ---------------------------------------------------------------------------

export function initializeGameState(blueprint: ScenarioBlueprint): GameState {
  const generation: GenerationMetadata = {
    generationId: blueprint.generationId,
    seed: blueprint.seed,
    templateVersion: blueprint.templateVersion,
    inputDigest: blueprint.inputDigest,
    gameType: blueprint.gameType
  };
  return {
    stateVersion: 1,
    generation,
    player: {
      name: blueprint.player.name,
      identity: blueprint.player.identity,
      stats: { ...blueprint.player.baseStats }
    },
    currentLocationId: blueprint.openingScene.locationId,
    // 隐藏地点初始不解锁，由后续玩法事件揭露。
    unlockedLocationIds: blueprint.locations
      .filter((entry) => entry.kind !== "hidden")
      .map((entry) => entry.id),
    // 开场地点即初始已到访事实：Phase 4 的 visit_location objective 读取此列表。
    visitedLocationIds: [blueprint.openingScene.locationId],
    // 相遇状态从 false 起步：开场叙事尚未发生，在场 NPC 由 openingScene 呈现。
    npcs: blueprint.npcs.map((npc) => ({ npcId: npc.id, locationId: npc.locationId, met: false })),
    // 唯一 stage 1 主线（校验已保证）为 active，其余等待解锁。
    quests: blueprint.quests.map((quest) => ({
      questId: quest.id,
      status: quest.kind === "main" && quest.stage === 1 ? ("active" as const) : ("locked" as const)
    })),
    inventory: [...blueprint.player.startingItemIds],
    // 玩家输入宣称的事实开局即为已知；生成器补全的事实待探索发现。
    worldFacts: blueprint.world.facts.map((fact) => ({
      factId: fact.id,
      discovered: fact.source === "player_input"
    })),
    // Phase 6：初始无已击败敌人、无战斗、未抵达结局。
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    // Phase 10：初始无叙事场景。
    narrative: { currentScene: null },
    eventLedger: [{ type: "game_initialized", generation }]
  };
}
