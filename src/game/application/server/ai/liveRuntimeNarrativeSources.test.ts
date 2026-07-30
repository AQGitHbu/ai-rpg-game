import { describe, expect, it } from "vitest";
import { repairRuntimeNarrativeReferences } from "./liveRuntimeNarrativeSources";

describe("runtime narrative mechanical reference repair", () => {
  it("pins director coverage to legal keys and minimal NPC knowledge", () => {
    const repaired = repairRuntimeNarrativeReferences("director", {
      sceneGoal: "推进",
      suggestedActionKeys: ["invented", "move:loc_2"],
      focusNpcId: "npc_secret",
      relevantFactIds: ["fact_known", "fact_secret"],
      allowedRevealFactIds: ["fact_secret"],
      introducedEntities: [{ kind: "npc", id: "invented" }],
    }, {
      coverageTargetActionKey: "talk:npc_1",
      actionCandidates: [
        { actionKey: "talk:npc_1" },
        { actionKey: "move:loc_2" },
      ],
      npcIdsPresent: ["npc_1"],
      discoveredFactIds: ["fact_known"],
    });
    expect(repaired.suggestedActionKeys).toEqual(["talk:npc_1", "move:loc_2"]);
    expect(repaired.focusNpcId).toBe("npc_1");
    expect(repaired.relevantFactIds).toEqual(["fact_known"]);
    expect(repaired.allowedRevealFactIds).toEqual([]);
    expect(repaired.introducedEntities).toEqual([]);
  });

  it("pins writer choice/NPC references but retains authored prose", () => {
    const repaired = repairRuntimeNarrativeReferences("writer", {
      narration: "模型写出的原始场景文字",
      usedFactIds: ["fact_allowed", "fact_hidden"],
      npcInstruction: {
        npcId: "invented",
        speechAct: "invented-act",
        emotion: "concerned",
        allowedFactIds: ["fact_hidden"],
        mayLie: "no",
      },
      choices: [
        { actionKey: "invented:a", label: "A", strategy: "S1" },
        { actionKey: "invented:b", label: "B", strategy: "S2" },
      ],
    }, {
      plan: { suggestedActionKeys: ["talk:npc_1", "move:loc_2"] },
      npcProfile: { id: "npc_1" },
      allowedFactCards: [{ id: "fact_allowed" }],
    });
    expect(repaired.narration).toBe("模型写出的原始场景文字");
    expect(repaired.usedFactIds).toEqual(["fact_allowed"]);
    expect(repaired.choices).toEqual([
      { actionKey: "talk:npc_1", label: "A", strategy: "S1" },
      { actionKey: "move:loc_2", label: "B", strategy: "S2" },
    ]);
    expect(repaired.npcInstruction).toMatchObject({
      npcId: "npc_1",
      speechAct: "warn",
      emotion: "guarded",
      allowedFactIds: [],
      mayLie: false,
    });
  });

  it("creates a safe NPC instruction when the writer returned null", () => {
    const repaired = repairRuntimeNarrativeReferences("writer", {
      narration: "场景",
      usedFactIds: [],
      npcInstruction: null,
      choices: [
        { actionKey: "wrong", label: "", strategy: "" },
        { actionKey: "wrong", label: "B".repeat(50), strategy: "S".repeat(90) },
      ],
    }, {
      plan: { suggestedActionKeys: ["talk:npc_1", "move:loc_2"] },
      npcProfile: { id: "npc_1" },
      allowedFactCards: [],
      actionCandidates: [
        { actionKey: "talk:npc_1", label: "与守门人交谈" },
        { actionKey: "move:loc_2", label: "前往广场" },
      ],
    });
    expect(repaired.npcInstruction).toEqual({
      npcId: "npc_1",
      speechAct: "warn",
      emotion: "guarded",
      allowedFactIds: [],
      mayLie: false,
    });
    const choices = repaired.choices as readonly Record<string, unknown>[];
    expect(choices[0]?.label).toBe("与守门人交谈");
    expect(Array.from(choices[1]?.label as string)).toHaveLength(40);
    expect(Array.from(choices[1]?.strategy as string)).toHaveLength(80);
  });

  it("normalizes NPC emotion and fact references without rewriting dialogue", () => {
    const repaired = repairRuntimeNarrativeReferences("npc", {
      text: "别再向前了。",
      usedFactIds: ["fact_allowed", "fact_hidden"],
      emotion: "anxious",
    }, {
      factCards: [{ id: "fact_allowed" }],
    });
    expect(repaired).toEqual({
      text: "别再向前了。",
      usedFactIds: ["fact_allowed"],
      emotion: "guarded",
    });
  });
});
