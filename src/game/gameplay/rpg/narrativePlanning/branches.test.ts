import { describe, it, expect } from "vitest";
import { approveDecision, applyNarrativeBranch, decisionIdOf } from "./branches";
import {
  LOC_A,
  LOC_B,
  LOC_C,
  NPC_0,
  QUEST_0,
  branchDecision,
  branchOption,
  branchStory,
  branchWorld,
  branchWorldWithObjectives,
  intent,
} from "./branchFixture.testutil";
import { DEFERRED_LOCATION_ID_SYMBOL } from "@/game/domain/narrativeBranch";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";

const OK_DECISION = branchDecision();

describe("approveDecision", () => {
  it("accepts two options that point at different reachable targets", () => {
    const result = approveDecision({ decision: OK_DECISION, world: branchWorld(), story: branchStory() });
    expect(result.ok).toBe(true);
  });

  it("rejects two options with the same target", () => {
    const decision = branchDecision({
      options: [
        branchOption({ candidateId: "left", target: { kind: "visit_location", locationId: LOC_B } }),
        branchOption({ candidateId: "right", target: { kind: "visit_location", locationId: LOC_B } }),
      ],
    });
    const result = approveDecision({ decision, world: branchWorld(), story: branchStory() });
    expect(result).toEqual({ ok: false, code: "duplicate_target" });
  });

  it("rejects a target whose entity does not exist", () => {
    const decision = branchDecision({
      options: [
        branchOption({ candidateId: "left", target: { kind: "visit_location", locationId: "loc_ghost" } }),
        branchOption({ candidateId: "right", target: { kind: "visit_location", locationId: LOC_C } }),
      ],
    });
    const result = approveDecision({ decision, world: branchWorld(), story: branchStory() });
    expect(result).toEqual({ ok: false, code: "unknown_target_entity" });
  });

  it("rejects an unreachable location target", () => {
    const world = branchWorld({ unlockedLocationIds: [LOC_A, LOC_C] });
    const result = approveDecision({ decision: OK_DECISION, world, story: branchStory() });
    expect(result).toEqual({ ok: false, code: "target_unreachable" });
  });

  it("rejects a target that is already satisfied", () => {
    const world = branchWorld({ visitedLocationIds: [LOC_A, LOC_B] });
    const result = approveDecision({ decision: OK_DECISION, world, story: branchStory() });
    expect(result).toEqual({ ok: false, code: "target_already_satisfied" });
  });

  it("rejects a decision whose npc is not present at the player location", () => {
    const world = branchWorld({ currentLocationId: LOC_B });
    const result = approveDecision({ decision: OK_DECISION, world, story: branchStory() });
    expect(result).toEqual({ ok: false, code: "decision_npc_absent" });
  });

  it("rejects when there is no continuable main objective", () => {
    const world = branchWorld({
      quests: [{
        id: QUEST_0, name: "渡口疑云", description: "", objectives: [],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 1, status: "completed",
      }],
    });
    const result = approveDecision({ decision: OK_DECISION, world, story: branchStory() });
    expect(result).toEqual({ ok: false, code: "no_active_quest" });
  });

  it("keeps both candidates even when they share the same dialogue act and topic", () => {
    const decision = branchDecision({
      options: [
        branchOption({ candidateId: "left", dialogueAct: "support", target: { kind: "visit_location", locationId: LOC_B } }),
        branchOption({ candidateId: "right", dialogueAct: "support", target: { kind: "visit_location", locationId: LOC_C } }),
      ],
    });
    const result = approveDecision({ decision, world: branchWorld(), story: branchStory() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options.map((o) => o.candidateId)).toEqual(["left", "right"]);
  });

  it("rejects duplicate candidate ids", () => {
    const decision = branchDecision({
      options: [
        branchOption({ candidateId: "same", target: { kind: "visit_location", locationId: LOC_B } }),
        branchOption({ candidateId: "same", target: { kind: "visit_location", locationId: LOC_C } }),
      ],
    });
    expect(approveDecision({ decision, world: branchWorld(), story: branchStory() }))
      .toEqual({ ok: false, code: "duplicate_candidate_id" });
  });
});

describe("approveDecision deferred locations", () => {
  const deferred = (candidateId: string, name: string) => branchOption({
    candidateId,
    target: { kind: "visit_location", locationId: DEFERRED_LOCATION_ID_SYMBOL },
    publicIntent: intent(name),
    deferredLocation: {
      name, description: `${name}的公开描述`, scale: "scene",
      placement: "world", connectFromLocationId: String(LOC_A),
    },
  });

  it("rebuilds the provider symbol into distinct reserved location ids", () => {
    const decision = branchDecision({ options: [deferred("left", "北滩"), deferred("right", "南岭")] });
    const result = approveDecision({ decision, world: branchWorld(), story: branchStory() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.options.map((o) => (o.target.kind === "visit_location" ? o.target.locationId : ""));
    expect(ids).toEqual(["loc_dyn_0", "loc_dyn_1"]);
    expect(new Set(ids).size).toBe(2);
  });

  it("rejects a deferred definition that is not a visit_location target", () => {
    const bad = branchOption({
      candidateId: "left",
      target: { kind: "talk_to_npc", npcId: String(NPC_0) },
      deferredLocation: {
        name: "北滩", description: "描述", scale: "scene",
        placement: "world", connectFromLocationId: String(LOC_A),
      },
    });
    const decision = branchDecision({ options: [bad, deferred("right", "义庄")] });
    expect(approveDecision({ decision, world: branchWorld(), story: branchStory() }))
      .toEqual({ ok: false, code: "deferred_requires_visit_location" });
  });

  it("rejects a deferred target that does not use the reserved symbol", () => {
    const bad = branchOption({
      candidateId: "left",
      target: { kind: "visit_location", locationId: String(LOC_B) },
      deferredLocation: {
        name: "北滩", description: "描述", scale: "scene",
        placement: "world", connectFromLocationId: String(LOC_A),
      },
    });
    const decision = branchDecision({ options: [bad, deferred("right", "义庄")] });
    expect(approveDecision({ decision, world: branchWorld(), story: branchStory() }))
      .toEqual({ ok: false, code: "deferred_symbol_required" });
  });

  it("rejects a deferred definition attached to a missing origin location", () => {
    const bad = branchOption({
      candidateId: "left",
      target: { kind: "visit_location", locationId: DEFERRED_LOCATION_ID_SYMBOL },
      deferredLocation: {
        name: "北滩", description: "描述", scale: "scene",
        placement: "world", connectFromLocationId: "loc_missing",
      },
    });
    const decision = branchDecision({ options: [bad, deferred("right", "义庄")] });
    expect(approveDecision({ decision, world: branchWorld(), story: branchStory() }))
      .toEqual({ ok: false, code: "deferred_definition_invalid" });
  });
});

describe("applyNarrativeBranch", () => {
  it("replaces only the current pending objective and leaves the player where they are", () => {
    const world = branchWorld();
    const story = branchStory();
    const result = applyNarrativeBranch({ world, story, decision: OK_DECISION, candidateId: "left" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const quest = result.value.world.quests.find((q) => String(q.id) === String(QUEST_0));
    expect(quest?.objectives).toEqual([{ kind: "visit_location", locationId: LOC_B }]);
    expect(String(result.value.world.currentLocationId)).toBe(String(LOC_A));
    expect(result.value.story.selectedBranches[decisionIdOf(OK_DECISION)]).toBe("left");
    expect(result.value.story.branchDecisions[decisionIdOf(OK_DECISION)]).toBeDefined();
  });

  it("keeps the already satisfied prefix and the shared suffix", () => {
    
    const story = branchStory();
    const result = applyNarrativeBranch({
      world: branchWorldWithObjectives([
        { kind: "visit_location", locationId: LOC_A },
        { kind: "talk_to_npc", npcId: NPC_0 },
        { kind: "visit_location", locationId: LOC_C },
      ]),
      story,
      decision: OK_DECISION,
      candidateId: "right",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const quest = result.value.world.quests.find((q) => String(q.id) === String(QUEST_0));
    expect(quest?.objectives.map((o) => o.kind)).toEqual(["visit_location", "visit_location", "visit_location"]);
    expect(quest?.objectives[0]).toEqual({ kind: "visit_location", locationId: LOC_A });
    expect(result.value.world.quests[0]?.status).toBe("active");
  });

  it("emits one narrative_branch_selected draft with structured refs", () => {
    const result = applyNarrativeBranch({
      world: branchWorld(), story: branchStory(), decision: OK_DECISION, candidateId: "left",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const branch = result.value.drafts.filter((d) => d.payload.type === "narrative_branch_selected");
    expect(branch).toHaveLength(1);
    expect(branch[0]?.payload).toMatchObject({
      type: "narrative_branch_selected",
      decisionId: decisionIdOf(OK_DECISION),
      candidateId: "left",
      target: { kind: "visit_location", locationId: LOC_B },
    });
  });

  it("rejects a second selection for the same decision (zero write)", () => {
    const first = applyNarrativeBranch({
      world: branchWorld(), story: branchStory(), decision: OK_DECISION, candidateId: "left",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyNarrativeBranch({
      world: first.value.world, story: first.value.story, decision: OK_DECISION, candidateId: "right",
    });
    expect(second).toEqual({ ok: false, code: "branch_already_selected" });
  });

  it("rejects an unknown candidate id", () => {
    const result = applyNarrativeBranch({
      world: branchWorld(), story: branchStory(), decision: OK_DECISION, candidateId: "nope",
    });
    expect(result).toEqual({ ok: false, code: "unknown_candidate" });
  });

  it("rejects a stale branch when the world prerequisite no longer holds", () => {
    const staleWorld = branchWorld({ unlockedLocationIds: [LOC_A, LOC_C] });
    const result = applyNarrativeBranch({
      world: staleWorld, story: branchStory(), decision: OK_DECISION, candidateId: "left",
    });
    expect(result).toEqual({ ok: false, code: "branch_stale" });
  });

  it("resets the dialogue session so the return talk is not auto-completed", () => {
    const result = applyNarrativeBranch({
      world: branchWorld(), story: branchStory(), decision: OK_DECISION, candidateId: "left",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.story.narrative.dialogueSession).toMatchObject({
      npcId: NPC_0, completed: false, turnCount: 0,
    });
  });

  it("the branch objective is the new current objective and stays unexecuted", () => {
    const result = applyNarrativeBranch({
      world: branchWorld(), story: branchStory(), decision: OK_DECISION, candidateId: "left",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = currentObjectiveOf(result.value.world, result.value.story);
    expect(next?.objectiveIndex).toBe(0);
    expect(result.value.world.quests[0]?.status).toBe("active");
    expect(result.value.world.visitedLocationIds).not.toContain(LOC_B);
  });
});

describe("applyNarrativeBranch deferred materialization", () => {
  const deferred = (candidateId: string, name: string) => branchOption({
    candidateId,
    target: { kind: "visit_location", locationId: DEFERRED_LOCATION_ID_SYMBOL },
    publicIntent: intent(name),
    deferredLocation: {
      name, description: `${name}的公开描述`, scale: "scene",
      placement: "world", connectFromLocationId: String(LOC_A),
    },
  });

  it("materializes only the selected location and closes the route back to the npc", () => {
    const decision = branchDecision({ options: [deferred("left", "北滩"), deferred("right", "南岭")] });
    const approval = approveDecision({ decision, world: branchWorld(), story: branchStory() });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    const result = applyNarrativeBranch({
      world: branchWorld(), story: branchStory(), decision: approval.value, candidateId: "left",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const world = result.value.world;
    expect(world.locations.map((l) => String(l.id))).toContain("loc_dyn_0");
    expect(world.locations.map((l) => String(l.id))).not.toContain("loc_dyn_1");
    // 双向连接 + 原 NPC 留在原处 + 玩家位置不变
    const origin = world.locations.find((l) => String(l.id) === String(LOC_A));
    expect(origin?.connectedLocationIds.map(String)).toContain("loc_dyn_0");
    expect(world.npcs.find((n) => String(n.id) === String(NPC_0))?.locationId).toBe(LOC_A);
    expect(String(world.currentLocationId)).toBe(String(LOC_A));
    // 有限模板：访问新地点 → 与原 NPC 的新会话
    expect(world.quests[0]?.objectives).toEqual([
      { kind: "visit_location", locationId: "loc_dyn_0" },
      { kind: "talk_to_npc", npcId: NPC_0 },
    ]);
    // 两个序号都被保留，允许未选分支留下空洞
    expect(result.value.story.evolution.nextLocationOrdinal).toBe(2);
  });
});
