import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { PacingNeed } from "@/game/domain/storyState";
import type { LocationId, NpcId } from "@/game/domain/scenarioBlueprint";
import type { GameRecordV2 } from "./server/persistence/gameRepositoryV2";

/**
 * SceneGenerator 的最小输入 DTO：只暴露本回合叙事所需的稳定事实，
 * 绝不携带完整 World/Story 记录（spec §7.1）。
 * NPC 知识裁剪等完整裁剪在 R5/Task 24 完成；本阶段只做字段级最小化。
 */
export type ScenePresentNpc = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
};

export type SceneLocationInfo = {
  readonly id: LocationId;
  readonly name: string;
  readonly description: string;
};

export type SceneGenerationContext = {
  readonly job: PendingNarrativeJob;
  readonly currentLocation: SceneLocationInfo;
  readonly presentNpcs: readonly ScenePresentNpc[];
  /** 当前锁定且可到达的相邻地点（决策选项的合法集合）。 */
  readonly reachableLocations: readonly { readonly id: LocationId; readonly name: string }[];
  readonly story: {
    readonly currentAct: number;
    readonly targetActs: number;
    readonly tension: number;
    readonly nextPacingNeed: PacingNeed;
  };
};

/** SceneGenerationContext 的唯一构造入口：从持久化 record 投影最小上下文。 */
export function buildSceneGenerationContext(record: GameRecordV2): SceneGenerationContext {
  const ws = record.worldState;
  const ss = record.storyState;

  const narrative = ss.narrative;
  if (narrative.generation.status !== "pending") {
    throw new Error("buildSceneGenerationContext requires a pending narrative job");
  }
  const job = narrative.generation.job;

  const currentLocation = ws.locations.find((l) => l.id === ws.currentLocationId)
    ?? ws.locations[0];
  const currentLocId = currentLocation.id;

  const presentNpcs = ws.npcs
    .filter((n) => n.locationId === currentLocId)
    .map((n) => ({ id: n.id, name: n.name, role: n.role }));

  const reachableLocations = ws.locations.filter(
    (l) => currentLocation.connectedLocationIds.includes(l.id)
      && ws.unlockedLocationIds.includes(l.id),
  ).map((l) => ({ id: l.id, name: l.name }));

  return {
    job,
    currentLocation: {
      id: currentLocation.id,
      name: currentLocation.name,
      description: currentLocation.description,
    },
    presentNpcs,
    reachableLocations,
    story: {
      currentAct: ss.currentAct,
      targetActs: ss.targetActs,
      tension: ss.tension,
      nextPacingNeed: ss.nextPacingNeed,
    },
  };
}