import {
  locationScaleOf,
  TOWN_GENERATOR_VERSION,
  type GameState,
  type ScenarioBlueprint,
  type TownGenerationState,
  type TownPlanGeneratedEvent,
  type TownRuntimeState
} from "@/game/domain";
import { createTownPlanFromLocation } from "./planFromBlueprint";

// 进入 town 地点的纯规则：performAction(move) 与 town/ensure 用例共用。
// offline → 同步派生规划（towns 追加 + 事件）；ai → 只产出 pending 标记，
// 真正的 AI 生成由 application 层 generatePendingTownPlan 消费。
// 纯函数：时间戳由调用方注入，domain/gameplay 不读时钟。

export type TownEntryMode = "offline" | "ai";

export type TownEntryResult =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "generated";
      readonly town: TownRuntimeState;
      readonly event: TownPlanGeneratedEvent;
    }
  | { readonly kind: "pending"; readonly townGeneration: TownGenerationState };

/** 小镇 seed 派生：蓝图 seed + 地点 ID，确定性且各地点互不相同。 */
export function townSeedFor(blueprintSeed: string, locationId: string): string {
  return `${blueprintSeed}#town#${locationId}`;
}

/**
 * 确保 town 地点的运行时规划就绪。非 town 地点 / 已生成 / 已 pending
 * 一律返回 unchanged；结果只描述应写入的增量，状态合并由调用方完成。
 */
export function ensureTownRuntime(
  blueprint: ScenarioBlueprint,
  state: GameState,
  locationId: string,
  mode: TownEntryMode,
  occurredAt: string
): TownEntryResult {
  const location = blueprint.locations.find((entry) => String(entry.id) === locationId);
  if (location === undefined || locationScaleOf(location) !== "town") {
    return { kind: "unchanged" };
  }
  if (state.towns.some((town) => String(town.locationId) === locationId)) {
    return { kind: "unchanged" };
  }
  if (mode === "ai") {
    if (
      state.townGeneration.status === "pending" &&
      String(state.townGeneration.locationId) === locationId
    ) {
      return { kind: "unchanged" };
    }
    return {
      kind: "pending",
      townGeneration: { status: "pending", locationId: location.id, requestedAt: occurredAt }
    };
  }
  const seed = townSeedFor(blueprint.seed, locationId);
  return {
    kind: "generated",
    town: {
      locationId: location.id,
      seed,
      plan: createTownPlanFromLocation(blueprint, locationId, seed),
      planSource: "offline",
      generatorVersion: TOWN_GENERATOR_VERSION
    },
    event: {
      type: "town_plan_generated",
      locationId: location.id,
      planSource: "offline",
      occurredAt
    }
  };
}
