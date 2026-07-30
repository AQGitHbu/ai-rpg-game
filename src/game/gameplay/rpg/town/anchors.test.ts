import { describe, expect, it } from "vitest";
import { tileIndex, type TownSemanticPlan } from "@/game/domain";
import { createTownRng } from "./townRandom";
import { generateTerrain, type TerrainLayout } from "./terrain";
import { placeAnchors, type TownAnchor } from "./anchors";

/** 固定语义规划：与 terrain.test.ts 同构，钉住 anchors 关心的字段。 */
function makePlan(terrain: TownSemanticPlan["terrain"]): TownSemanticPlan {
  return {
    planVersion: 1,
    theme: "测试镇",
    gridSize: { width: 32, height: 32 },
    terrain,
    districts: [
      { type: "market", preferredArea: "center", weight: 35 },
      { type: "residential", preferredArea: "north", weight: 30 },
      { type: "craft", preferredArea: "east", weight: 20 },
      { type: "reserved", preferredArea: "edge", weight: 15 }
    ],
    requiredBuildings: [],
    landmarks: [{ type: "well", preferredArea: "center" }]
  };
}

function anchorsFor(seed: string, plan: TownSemanticPlan): {
  terrain: TerrainLayout;
  anchors: readonly TownAnchor[];
} {
  // terrain 与 anchors 各用独立 rng：与后续管线各阶段独立派生 seed 的做法一致。
  const terrain = generateTerrain(plan, createTownRng(`${seed}:terrain`));
  const anchors = placeAnchors(plan, terrain, createTownRng(`${seed}:anchors`));
  return { terrain, anchors };
}

const EW_PLAN = makePlan({ river: "none", externalRoad: "east_west" });
const NS_PLAN = makePlan({ river: "north", externalRoad: "north_south" });

function manhattan(a: TownAnchor, b: TownAnchor): number {
  return Math.abs(a.cell.x - b.cell.x) + Math.abs(a.cell.y - b.cell.y);
}

describe("placeAnchors", () => {
  it("同 seed 深度相等", () => {
    expect(anchorsFor("seed-a", EW_PLAN).anchors).toEqual(anchorsFor("seed-a", EW_PLAN).anchors);
  });

  it("恒含主/副城门、广场、水井四个固定锚点", () => {
    const { anchors } = anchorsFor("seed-fixed", EW_PLAN);
    const byId = new Map(anchors.map((anchor) => [anchor.id, anchor]));
    expect(byId.get("anchor_gate_main")?.kind).toBe("gate");
    expect(byId.get("anchor_gate_secondary")?.kind).toBe("gate");
    expect(byId.get("anchor_square")?.kind).toBe("square");
    expect(byId.get("anchor_poi_well")?.kind).toBe("poi");
  });

  it("每个非 reserved district 恰有一个 district_center 且带 districtType", () => {
    const { anchors } = anchorsFor("seed-district", EW_PLAN);
    const centers = anchors.filter((anchor) => anchor.kind === "district_center");
    expect(centers.map((anchor) => anchor.districtType).sort()).toEqual([
      "craft",
      "market",
      "residential"
    ]);
  });

  it("id 全局唯一", () => {
    const { anchors } = anchorsFor("seed-unique", EW_PLAN);
    expect(new Set(anchors.map((anchor) => anchor.id)).size).toBe(anchors.length);
  });

  it("多 seed 下所有锚点均落在可建格且两两曼哈顿距离 ≥ 4", () => {
    for (const seed of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
      for (const plan of [EW_PLAN, NS_PLAN]) {
        const { terrain, anchors } = anchorsFor(seed, plan);
        for (const anchor of anchors) {
          expect(terrain.buildableMask[tileIndex(terrain, anchor.cell.x, anchor.cell.y)]).toBe(true);
        }
        for (let i = 0; i < anchors.length; i += 1) {
          for (let j = i + 1; j < anchors.length; j += 1) {
            expect(manhattan(anchors[i], anchors[j])).toBeGreaterThanOrEqual(4);
          }
        }
      }
    }
  });

  it("east_west 外路时两城门分居东西半边", () => {
    const { anchors } = anchorsFor("seed-ew", EW_PLAN);
    const gates = anchors.filter((anchor) => anchor.kind === "gate");
    expect(gates).toHaveLength(2);
    const xs = gates.map((gate) => gate.cell.x).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(16);
    expect(xs[1]).toBeGreaterThanOrEqual(16);
  });

  it("north_south 外路时两城门分居南北半边", () => {
    const { anchors } = anchorsFor("seed-ns", NS_PLAN);
    const gates = anchors.filter((anchor) => anchor.kind === "gate");
    expect(gates).toHaveLength(2);
    const ys = gates.map((gate) => gate.cell.y).sort((a, b) => a - b);
    expect(ys[0]).toBeLessThan(16);
    expect(ys[1]).toBeGreaterThanOrEqual(16);
  });

  it("anchor_square 是最靠近网格中心的可建格（允许因间距约束外移时仍在中心邻域）", () => {
    const { anchors } = anchorsFor("seed-square", EW_PLAN);
    const square = anchors.find((anchor) => anchor.id === "anchor_square");
    expect(square).toBeDefined();
    const distance = Math.abs(square!.cell.x - 16) + Math.abs(square!.cell.y - 16);
    expect(distance).toBeLessThanOrEqual(4);
  });
});
