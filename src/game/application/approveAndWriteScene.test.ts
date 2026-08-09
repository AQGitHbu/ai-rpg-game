import { describe, it, expect } from "vitest";
import { approveSceneEventProposals, approveScenePackage, POOL_MAX_CANDIDATES } from "./approveAndWriteScene";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { NarrativeSceneState } from "@/game/domain/narrative";
import { asEnemyId, asLocationId, asNpcId, asFactId } from "@/game/domain/scenarioBlueprint";
import type { SceneGenerationContext } from "./sceneGenerationContext";

function makeScene(overrides?: Partial<NarrativeSceneState>): NarrativeSceneState {
  return {
    sceneId: "scene-1",
    turn: 1,
    narration: "场景旁白",
    usedFactIds: [],
    npcLine: null,
    choices: [
      { choiceToken: "a", label: "探索", actionKey: "explore" },
      { choiceToken: "b", label: "前往客栈", actionKey: "move:loc_2" },
    ],
    source: "generated",
    ...overrides,
  };
}

function makeContext(overrides?: Partial<SceneGenerationContext>): SceneGenerationContext {
  return {
    job: { jobId: "job_1" } as never,
    player: { name: "侠客", identity: "剑客", knownFactCards: [] },
    currentLocation: { id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main" },
    publicWorldFacts: [],
    sceneVisibleFacts: [],
    presentNpcs: [{
      id: asNpcId("npc_1"), name: "老板", role: "路人", publicProfile: "t",
      knownFactCards: [{ factId: asFactId("fact_a"), text: "已知" }],
      hiddenFactCards: [], sceneVisibleFactIds: [asFactId("fact_vis")],
      recentInteractionSummaries: [], relationship: { affinity: 0 }, emotion: "neutral",
      goals: [], forbiddenKnowledgeIds: [],
    }],
    story: {
      currentAct: 1, targetActs: 3, tension: 30, nextPacingNeed: "reveal",
      remainingBudget: { remainingLocations: 1, remainingNpcs: 1, remainingEvents: 1 },
      unresolvedThreadSummaries: [],
    },
    recentBeats: [],
    legalActionCandidates: [],
    worldConstraints: [],
    ...overrides,
  };
}

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

describe("approveScenePackage (Task 25)", () => {
  it("合法场景通过审批，原样返回", () => {
    const result = approveScenePackage({ context: makeContext(), scene: makeScene() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.narration).toBe("场景旁白");
  });

  it("旁白为空 → 整场拒绝 empty_narration", () => {
    const result = approveScenePackage({ context: makeContext(), scene: makeScene({ narration: "  " }) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty_narration");
  });

  it("台词 NPC 不在场 → 整场拒绝 unknown_dialogue_npc", () => {
    const scene = makeScene({
      npcLine: { npcId: asNpcId("ghost"), text: "你是谁", emotion: "neutral", usedFactIds: [] },
    });
    const result = approveScenePackage({ context: makeContext(), scene });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unknown_dialogue_npc");
  });

  it("NPC 使用 forbidden fact → 整场拒绝 npc_uses_forbidden_fact", () => {
    const scene = makeScene({
      npcLine: { npcId: asNpcId("npc_1"), text: "这是秘密", emotion: "neutral", usedFactIds: [asFactId("fact_forbidden")] },
    });
    const result = approveScenePackage({ context: makeContext(), scene });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("npc_uses_forbidden_fact");
  });

  it("NPC 使用自己 known/scene-visible fact → 通过", () => {
    const scene = makeScene({
      npcLine: { npcId: asNpcId("npc_1"), text: "我知道这个", emotion: "neutral", usedFactIds: [asFactId("fact_a")] },
    });
    const result = approveScenePackage({ context: makeContext(), scene });
    expect(result.ok).toBe(true);
  });

  it("两选项语义重复 → 整场拒绝 semantic_duplicate_choices", () => {
    const scene = makeScene({
      choices: [
        { choiceToken: "a", label: "探索", actionKey: "explore" },
        { choiceToken: "b", label: "再次探索", actionKey: "explore" },
      ],
    });
    const result = approveScenePackage({ context: makeContext(), scene });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("semantic_duplicate_choices");
  });

  it("选项目标非法 → 整场拒绝 illegal_choice_target", () => {
    const scene = makeScene({
      choices: [
        { choiceToken: "a", label: "作弊", actionKey: "grant:999999" },
        { choiceToken: "b", label: "探索", actionKey: "explore" },
      ],
    });
    const result = approveScenePackage({ context: makeContext(), scene });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("illegal_choice_target");
  });
});
