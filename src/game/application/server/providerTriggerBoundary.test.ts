import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DECISION_BOUNDARY_KINDS,
  classifyProviderDecisionBoundary,
} from "@/game/domain/pendingNarrativeJob";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
const occurrences = (source: string, token: string): number => source.split(token).length - 1;

describe("provider trigger architecture boundary", () => {
  it("keeps performTurn free of scene/world provider capabilities", () => {
    const source = read("src/game/application/performTurn.ts");
    expect(source).not.toMatch(/SceneSource|WorldEvolutionSource|generatePendingScene/);
  });

  it("keeps compositionRoot with one pending-job generation entry", () => {
    const source = read("src/game/application/server/compositionRoot.ts");
    // Task 7/10: generatePendingScene was replaced by generatePendingNarrativeBundle
    expect(occurrences(source, "generatePendingNarrativeBundle(")).toBeGreaterThanOrEqual(1);
    expect(source).not.toMatch(/shouldCompleteSceneInAction|immediateSceneResult|battleScenePrewarm/);
  });

  it("keeps free-text intent conversion as performTurn's only provider capability", () => {
    const source = read("src/game/application/performTurn.ts");
    expect(source).toMatch(/IntentParserSource/);
    expect(occurrences(source, "intentParserSource")).toBeGreaterThan(0);
  });

  it("exposes the additive decision-boundary whitelist", () => {
    expect(DECISION_BOUNDARY_KINDS).toEqual([
      "initialization",
      "narrative_choice",
      "npc_free_text",
    ]);
  });

  it("classifies formal fixed choices as narrative_choice", () => {
    expect(classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "support" },
      interactionKind: "fixed_choice",
      fixedChoiceIsCurrentFormalDecision: true,
      focusedNpcId: "npc_1" as never,
    })).toBe("narrative_choice");
  });

  it("classifies focus NPC free text as npc_free_text", () => {
    expect(classifyProviderDecisionBoundary({
      action: { type: "talk", npcId: "npc_1" as never, dialogueAct: "ask" },
      interactionKind: "free_text",
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: "npc_1" as never,
    })).toBe("npc_free_text");
  });

  it("returns null for non-dialogue boundaries", () => {
    expect(classifyProviderDecisionBoundary({
      action: { type: "move", locationId: "loc_2" as never },
      interactionKind: null,
      fixedChoiceIsCurrentFormalDecision: false,
      focusedNpcId: null,
    })).toBeNull();
  });
});
