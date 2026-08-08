import { describe, it, expect } from "vitest";
import { approveSceneEventProposals, POOL_MAX_CANDIDATES } from "./approveAndWriteScene";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { asEnemyId, asLocationId } from "@/game/domain/scenarioBlueprint";

function validCandidate(id: string): EventCandidate {
  return {
    id,
    kind: "enemy_appears",
    involvedEntityIds: ["enemy_1", "loc_1"],
    prerequisiteFactIds: [],
    proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
    intendedPacing: "complicate",
    reason: "敌人在起点现身",
    proposedAtTurn: 3,
    expiresAtTurn: 6,
  };
}

describe("approveSceneEventProposals (Task 21)", () => {
  it("空提议保持池不变，accept 0", () => {
    const result = approveSceneEventProposals({ existingPool: [], proposals: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool).toEqual([]);
    expect(result.acceptedIds).toEqual([]);
  });

  it("合法候选追加进池", () => {
    const result = approveSceneEventProposals({ existingPool: [], proposals: [validCandidate("ce-1")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool.map((c) => c.id)).toEqual(["ce-1"]);
    expect(result.acceptedIds).toEqual(["ce-1"]);
  });

  it("非法候选丢弃，不拖垮整个合法场景；仅合法候选入池", () => {
    const malformed = { ...validCandidate("ce-bad"), proposedEffects: [] };
    const ok = validCandidate("ce-good");
    const result = approveSceneEventProposals({ existingPool: [], proposals: [malformed, ok] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool.map((c) => c.id)).toEqual(["ce-good"]);
    expect(result.rejected.some((r) => r.id === "ce-bad")).toBe(true);
  });

  it("夹带 path patch 的候选被拒绝并分类为 path_patch", () => {
    const pathPatch = {
      ...validCandidate("ce-patch"),
      proposedEffects: [{ kind: "arbitrary_patch", path: "worldState.player.stats.hp", value: 999 }],
    } as unknown as EventCandidate;
    const result = approveSceneEventProposals({ existingPool: [], proposals: [pathPatch] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool).toEqual([]);
    expect(result.rejected.some((r) => r.id === "ce-patch" && r.reasonCode === "path_patch")).toBe(true);
  });

  it("FIFO 上限 8：超出部分从池头裁剪", () => {
    const existing = Array.from({ length: POOL_MAX_CANDIDATES }, (_, i) => validCandidate(`old-${i}`));
    const fresh = validCandidate("new-1");
    const result = approveSceneEventProposals({ existingPool: existing, proposals: [fresh] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCandidateEventPool.length).toBe(POOL_MAX_CANDIDATES);
    expect(result.nextCandidateEventPool.map((c) => c.id)).not.toContain("old-0"); // 最旧的被裁剪
    expect(result.nextCandidateEventPool.map((c) => c.id)).toContain("new-1");
  });

  it("同 ID 去重：已存在于池中的候选不再追加", () => {
    const existing = [validCandidate("ce-dup")];
    const result = approveSceneEventProposals({ existingPool: existing, proposals: [validCandidate("ce-dup")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const count = result.nextCandidateEventPool.filter((c) => c.id === "ce-dup").length;
    expect(count).toBe(1);
  });

  it("函数只返回池与采纳记录，绝不改动 World State/tension/任务/关系", () => {
    const result = approveSceneEventProposals({ existingPool: [], proposals: [validCandidate("ce-1")] });
    // 返回值不含 worldState/storyState 字段，天然无法改动世界
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("worldState" in result).toBe(false);
    expect("storyState" in result).toBe(false);
  });
});
