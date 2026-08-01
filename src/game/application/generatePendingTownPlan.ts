import {
  locationScaleOf,
  TOWN_GENERATOR_VERSION,
  type TownPlanGeneratedEvent,
  type TownPlanSource as TownPlanSourceKind,
  type TownRuntimeState
} from "@/game/domain";
import {
  createTownPlanFromLocation,
  townSeedFor,
  validateTownPlanCandidate
} from "@/game/gameplay/rpg/town";
import type { GameRepository } from "./server/persistence/gameRepository";
import type { TownPlanCandidateSource, TownPlanRequest } from "./townPlanGeneration";
import type { GameLogger } from "@/game/logging";

// ---------------------------------------------------------------------------
// Town 层：消费 durable pending 标记的小镇规划生成 use case——镜像
// generatePendingNarrativeScene 的 pending → 有界尝试 → CAS 写回模式。
// 每次 pending 最多 3 次 source 尝试（每次都过 validateTownPlanCandidate
// 的校验 + generateTown 编译验证）；耗尽降级为离线 baseline 规划
// （planSource = "fallback"），玩家永远不会卡在生成中。
// 本文件不做进程内调度：进程重启后可安全重跑（coordinator 只做去重）。
// ---------------------------------------------------------------------------

/** 每次 pending 的 AI 尝试上限；耗尽后降级 baseline，不再请求 provider。 */
export const TOWN_PLAN_MAX_ATTEMPTS = 3;

export type GeneratePendingTownPlanDependencies = Readonly<{
  repository: GameRepository;
  newTraceId: () => string;
  now: () => string;
  townPlanSource: TownPlanCandidateSource;
  logger?: GameLogger;
  traceId?: string;
}>;

export type GeneratePendingTownPlanResult =
  | "saved"
  | "not_pending"
  | "cleared"
  | "stale"
  | "unavailable";

/**
 * 执行一次 durable pending 小镇规划请求。pending 指向的地点不再合法
 * （非 town / 已有规划）时只清除标记，绝不伪造小镇数据。
 */
export async function generatePendingTownPlan(
  deps: GeneratePendingTownPlanDependencies
): Promise<GeneratePendingTownPlanResult> {
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") return "unavailable";
  const { record } = loaded;
  if (record.state.townGeneration.status !== "pending") return "not_pending";

  const locationId = String(record.state.townGeneration.locationId);
  const location = record.blueprint.locations.find(
    (entry) => String(entry.id) === locationId
  );
  const alreadyPlanned = record.state.towns.some(
    (town) => String(town.locationId) === locationId
  );

  // 旧存档或并发演进的规则可能留下失效标记：只清除，不生成。
  if (location === undefined || locationScaleOf(location) !== "town" || alreadyPlanned) {
    const cleared = await deps.repository.applyResolvedAction({
      gameId: record.gameId,
      expectedRevision: record.revision,
      nextState: { ...record.state, townGeneration: { status: "idle" } }
    });
    if (!cleared.ok) return cleared.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
    return "cleared";
  }

  const seed = townSeedFor(record.blueprint.seed, locationId);
  const baseline = createTownPlanFromLocation(record.blueprint, locationId, seed);
  const npcs = record.blueprint.npcs
    .filter((npc) => location.npcIds.some((id) => String(id) === String(npc.id)))
    .map((npc) => ({ id: String(npc.id), name: npc.name, role: npc.role }));
  const traceId = deps.traceId ?? deps.newTraceId();
  const request: TownPlanRequest = {
    locationId,
    locationName: location.name,
    locationDescription: location.description,
    locationTags: location.tags,
    npcs,
    worldTone: record.blueprint.world.tone,
    worldThemes: record.blueprint.world.themes,
    seed,
    traceId
  };

  // 有界尝试：source 失败与校验/编译拒绝同等计数；成功即停。
  let plan = baseline;
  let planSource: TownPlanSourceKind = "fallback";
  let attempts = 0;
  let lastFailureCategory: string | undefined;
  for (let attempt = 0; attempt < TOWN_PLAN_MAX_ATTEMPTS; attempt += 1) {
    attempts += 1;
    const generated = await deps.townPlanSource.generate(request);
    if (!generated.ok) {
      lastFailureCategory = generated.category;
      continue;
    }
    const validated = validateTownPlanCandidate(generated.candidate, { seed, baseline });
    if (!validated.ok) {
      lastFailureCategory = validated.reason;
      continue;
    }
    plan = validated.plan;
    planSource = "generated";
    break;
  }

  deps.logger?.info("town_plan_generation", {
    traceId,
    scope: "request",
    source: "rpg.application.generate_pending_town_plan",
    gameId: String(record.gameId),
    locationId,
    attempts,
    planSource,
    ...(lastFailureCategory === undefined ? {} : { lastFailureCategory })
  });

  const town: TownRuntimeState = {
    locationId: location.id,
    seed,
    plan,
    planSource,
    generatorVersion: TOWN_GENERATOR_VERSION
  };
  const event: TownPlanGeneratedEvent = {
    type: "town_plan_generated",
    locationId: location.id,
    planSource,
    occurredAt: deps.now()
  };
  const saved = await deps.repository.applyResolvedAction({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextState: {
      ...record.state,
      towns: [...record.state.towns, town],
      townGeneration: { status: "idle" },
      eventLedger: [...record.state.eventLedger, event]
    }
  });
  if (!saved.ok) return saved.code === "STALE_GAME_REVISION" ? "stale" : "unavailable";
  return "saved";
}
