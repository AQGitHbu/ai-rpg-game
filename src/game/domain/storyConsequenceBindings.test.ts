import { describe, expect, it } from "vitest";
import { parseNarrativeBundleProposal } from "./narrativeBundle";
import { isStoryConsequenceBindingsProposal } from "./storyConsequenceBindings";

describe("consequence binding provider shape", () => {
  it.each([
    { kind: "bind_goal_resolution", npcRef: "@new.npc", goalOrdinal: 0 },
    { kind: "bind_goal_resolution", npcRef: "@new.npc", goalOrdinal: 0, resolution: { completeWhen: [null], blockWhen: [] } },
    { kind: "bind_npc_cooperation", npcRef: "@new.npc" },
    { kind: "bind_investigation", factRef: "@new.fact", discoveryMode: "investigation", approaches: [null, null] },
    { kind: "bind_talk_completion", questRef: "@new.quest", npcRef: "@new.npc", conditions: [{ kind: "goal_status", npcId: "@new.npc", goalOrdinal: 0, goalId: "old", status: "completed" }] },
  ])("rejects malformed nested values before compilation: $kind", (binding) => {
    expect(isStoryConsequenceBindingsProposal([binding])).toBe(false);
    expect(parseNarrativeBundleProposal({ consequenceBindings: [binding] })).toMatchObject({ ok: false, reason: "consequence_bindings_invalid" });
  });

  it("accepts local references and ordinal conditions without minting ids", () => {
    const bindings = [{ kind: "bind_talk_completion", questRef: "@new.quest", npcRef: "@new.npc", conditions: [{ kind: "goal_status", npcId: "@new.npc", goalOrdinal: 0, status: "completed" }] }];
    expect(isStoryConsequenceBindingsProposal(bindings)).toBe(true);
  });
});
