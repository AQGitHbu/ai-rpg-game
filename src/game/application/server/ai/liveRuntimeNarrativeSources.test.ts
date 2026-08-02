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
    // relevantFactIds 是导演的叙事锚点；修复器把它交给编剧作为同一组
    // discovered-only 的允许事实，避免角色交接时丢失事实意图。
    expect(repaired.allowedRevealFactIds).toEqual(["fact_known"]);
    expect(repaired.introducedEntities).toEqual([]);
  });

  it("active main objective 在合法时优先于导演随意选择", () => {
    const repaired = repairRuntimeNarrativeReferences("director", {
      sceneGoal: "推进主线",
      suggestedActionKeys: ["observe:loc_1", "talk:npc_1"],
      focusNpcId: null,
      relevantFactIds: [],
      allowedRevealFactIds: [],
      introducedEntities: [],
    }, {
      activeMainObjective: { questId: "q2", stage: 2, kind: "talk_to_npc", targetId: "npc_1", suggestedActionKey: "talk:npc_1" },
      actionCandidates: [
        { actionKey: "observe:loc_1" },
        { actionKey: "talk:npc_1" },
      ],
      npcIdsPresent: ["npc_1"],
      discoveredFactIds: [],
    });
    expect(repaired.suggestedActionKeys).toEqual(["talk:npc_1", "observe:loc_1"]);
    expect(repaired.focusNpcId).toBe("npc_1");
  });

  it("relevant facts 只从 discovered fact ids 补入 writer permission", () => {
    const repaired = repairRuntimeNarrativeReferences("director", {
      relevantFactIds: ["fact_known", "fact_hidden"],
      allowedRevealFactIds: [],
      suggestedActionKeys: ["move:loc_2", "talk:npc_1"],
    }, {
      actionCandidates: [{ actionKey: "move:loc_2" }, { actionKey: "talk:npc_1" }],
      npcIdsPresent: ["npc_1"],
      discoveredFactIds: ["fact_known"],
    });
    expect(repaired.relevantFactIds).toEqual(["fact_known"]);
    expect(repaired.allowedRevealFactIds).toEqual(["fact_known"]);
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
      npcProfile: { id: "npc_1", knownFactIds: ["fact_allowed"] },
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
      allowedFactIds: ["fact_allowed"],
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

  it("director: malformed proposedNewLocations discarded to []", () => {
    const context = { actionCandidates: [{ actionKey: "move:loc_2" }, { actionKey: "observe:loc_1" }], npcIdsPresent: [], discoveredFactIds: [] };
    const cases = [
      "not-an-array",
      [{ name: "x" }],
      [{ name: "a", description: "b", connectFromLocationId: "loc_1", reason: "c", scale: "invalid" }],
      [{ name: "a", description: "b", connectFromLocationId: "loc_1", reason: "c", scale: "scene" }, { name: "two" }],
      [],
      undefined,
    ];
    for (const proposedNewLocations of cases) {
      const repaired = repairRuntimeNarrativeReferences("director", { proposedNewLocations }, context);
      expect(repaired.proposedNewLocations).toEqual([]);
    }
  });

  it("director: valid proposedNewLocations passes through", () => {
    const context = { actionCandidates: [{ actionKey: "move:loc_2" }, { actionKey: "observe:loc_1" }], npcIdsPresent: [], discoveredFactIds: [] };
    const proposal = { name: "迷雾谷", description: "一处隐秘山谷", connectFromLocationId: "loc_1", reason: "剧情需要", scale: "scene" };
    const repaired = repairRuntimeNarrativeReferences("director", { proposedNewLocations: [proposal] }, context);
    expect(repaired.proposedNewLocations).toEqual([proposal]);
  });

  it("director: malformed proposedNewNpcs discarded to []", () => {
    const context = { actionCandidates: [{ actionKey: "move:loc_2" }, { actionKey: "observe:loc_1" }], npcIdsPresent: [], discoveredFactIds: [] };
    const cases = [
      "string",
      [{ name: "x" }],
      [{ name: "a", role: "b", description: "c", locationId: 123 }],
      [],
      undefined,
    ];
    for (const proposedNewNpcs of cases) {
      const repaired = repairRuntimeNarrativeReferences("director", { proposedNewNpcs }, context);
      expect(repaired.proposedNewNpcs).toEqual([]);
    }
  });

  it("director: valid proposedNewNpcs passes through", () => {
    const context = { actionCandidates: [{ actionKey: "move:loc_2" }, { actionKey: "observe:loc_1" }], npcIdsPresent: [], discoveredFactIds: [] };
    const proposal = { name: "线人", role: "情报贩子", description: "戴斗笠的人", locationId: "new:0" };
    const repaired = repairRuntimeNarrativeReferences("director", { proposedNewNpcs: [proposal] }, context);
    expect(repaired.proposedNewNpcs).toEqual([proposal]);
  });
});
