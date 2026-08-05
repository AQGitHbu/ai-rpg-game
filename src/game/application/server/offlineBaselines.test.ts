/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { GENRE_TO_CASE, OFFLINE_CASE_IDS, resolveOfflineBaseline } from "./offlineBaselines";

describe("offlineBaselines", () => {
  it("白名单恰好 7 个，与 GENRE_TO_CASE 一一对应", () => {
    expect(OFFLINE_CASE_IDS).toHaveLength(7);
    expect(GENRE_TO_CASE.map((g) => g.caseId).sort()).toEqual([...OFFLINE_CASE_IDS].sort());
  });

  it("GENRE_TO_CASE 覆盖 7 个 gameType，无重复", () => {
    const gameTypes = GENRE_TO_CASE.map((g) => g.gameType);
    expect(gameTypes).toHaveLength(7);
    expect(new Set(gameTypes).size).toBe(7);
  });

  it("resolveOfflineBaseline 命中白名单返回合法 input + 确定性 seed", () => {
    const baseline = resolveOfflineBaseline("wuxia-a");
    expect(baseline).not.toBeNull();
    if (baseline === null) return;
    expect(baseline.input.gameType).toBe("wuxia");
    expect(baseline.input.gameLength).toBe("long");
    expect(typeof baseline.seed).toBe("string");
    expect(baseline.seed.length).toBeGreaterThan(0);
    expect(resolveOfflineBaseline("wuxia-a")?.seed).toBe(baseline.seed);
    expect(resolveOfflineBaseline("xianxia-a")?.seed).not.toBe(baseline.seed);
  });

  it("resolveOfflineBaseline 覆盖全部 7 个 caseId", () => {
    for (const caseId of OFFLINE_CASE_IDS) {
      const baseline = resolveOfflineBaseline(caseId);
      expect(baseline, `caseId=${caseId}`).not.toBeNull();
      expect(baseline?.input.gameLength).toBe("long");
    }
  });

  it("resolveOfflineBaseline 未知 caseId 返回 null", () => {
    expect(resolveOfflineBaseline("wuxia-c")).toBeNull();
    expect(resolveOfflineBaseline("nonexistent")).toBeNull();
    expect(resolveOfflineBaseline("")).toBeNull();
  });
});
