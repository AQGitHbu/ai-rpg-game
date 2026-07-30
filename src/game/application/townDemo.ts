import type { TownSnapshot } from "@/game/domain";
import { generateTown, TownGenerationError } from "@/game/gameplay/rpg/town";

// ---------------------------------------------------------------------------
// Task 7：小镇 demo 的 application 投影门面。纯同步、无 IO/env/随机：
// 随机性只在 gameplay 层由 seed 决定，本层仅做输入校验、调用门面与
// stats 投影。生成失败只回稳定错误码，不外泄 issue 细节。
// ---------------------------------------------------------------------------

/** seed 长度上限（trim 后计）。 */
const MAX_SEED_LENGTH = 64;

/** snapshot 的数量投影：UI 展示用，逐项可与 snapshot 对账。 */
export type TownDemoStats = {
  readonly buildingCount: number;
  readonly storyBuildingCount: number;
  readonly plotCount: number;
  readonly occupiedPlotCount: number;
  readonly reservedPlotCount: number;
  readonly repairCount: number;
  readonly retryCount: number;
};

export type TownDemoView = {
  readonly snapshot: TownSnapshot;
  readonly stats: TownDemoStats;
};

export type GenerateTownDemoResult =
  | { readonly ok: true; readonly view: TownDemoView }
  | { readonly ok: false; readonly code: "GENERATION_FAILED" | "INVALID_SEED" };

function computeStats(snapshot: TownSnapshot): TownDemoStats {
  return {
    buildingCount: snapshot.buildings.length,
    storyBuildingCount: snapshot.buildings.filter((building) => building.storyRequired).length,
    plotCount: snapshot.plots.length,
    occupiedPlotCount: snapshot.plots.filter((plot) => plot.status === "occupied").length,
    reservedPlotCount: snapshot.plots.filter((plot) => plot.status === "reserved").length,
    repairCount: snapshot.validation.repairCount,
    retryCount: snapshot.validation.retryCount
  };
}

/** seed trim 后非空且 ≤ 64 字符，否则 INVALID_SEED；生成异常 → GENERATION_FAILED。 */
export function generateTownDemoView(seed: string): GenerateTownDemoResult {
  const trimmed = seed.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SEED_LENGTH) {
    return { ok: false, code: "INVALID_SEED" };
  }
  try {
    const snapshot = generateTown({ seed: trimmed });
    return { ok: true, view: { snapshot, stats: computeStats(snapshot) } };
  } catch (error) {
    if (error instanceof TownGenerationError) {
      return { ok: false, code: "GENERATION_FAILED" };
    }
    throw error;
  }
}
