import { describe, expect, it } from "vitest";
import { generateTownDemoView } from "./townDemo";

// Task 7：application 投影门面。纯同步、无 IO：stats 必须逐项与 snapshot
// 对得上（防止投影层自造数字），非法 seed 走稳定错误码而非异常外泄。
describe("generateTownDemoView", () => {
  it("合法 seed 返回 ok，stats 与 snapshot 逐项一致", () => {
    const result = generateTownDemoView("demo-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { snapshot, stats } = result.view;
    expect(snapshot.seed).toBe("demo-1");
    expect(stats.buildingCount).toBe(snapshot.buildings.length);
    expect(stats.storyBuildingCount).toBe(
      snapshot.buildings.filter((building) => building.storyRequired).length
    );
    expect(stats.plotCount).toBe(snapshot.plots.length);
    expect(stats.occupiedPlotCount).toBe(
      snapshot.plots.filter((plot) => plot.status === "occupied").length
    );
    expect(stats.reservedPlotCount).toBe(
      snapshot.plots.filter((plot) => plot.status === "reserved").length
    );
    expect(stats.repairCount).toBe(snapshot.validation.repairCount);
    expect(stats.retryCount).toBe(snapshot.validation.retryCount);
    // 投影不空转：demo 小镇至少有剧情建筑与占用地块。
    expect(stats.storyBuildingCount).toBeGreaterThan(0);
    expect(stats.occupiedPlotCount).toBeGreaterThan(0);
  });

  it("同 seed 两次调用结果深度相等（确定性）", () => {
    expect(generateTownDemoView("demo-1")).toEqual(generateTownDemoView("demo-1"));
  });

  it("seed 先 trim 再使用：前后空白不影响结果", () => {
    expect(generateTownDemoView("  demo-1  ")).toEqual(generateTownDemoView("demo-1"));
  });

  it("空串 / 全空白 / 超过 64 字符 → INVALID_SEED", () => {
    for (const seed of ["", "   ", "\t\n", "a".repeat(65)]) {
      expect(generateTownDemoView(seed)).toEqual({ ok: false, code: "INVALID_SEED" });
    }
  });

  it("恰好 64 字符仍是合法 seed", () => {
    expect(generateTownDemoView("a".repeat(64)).ok).toBe(true);
  });
});
