import { describe, expect, it } from "vitest";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { createJourneyGame } from "./foundationJourney.testutil";
import { entitiesOfKind } from "@/game/domain/entity";
import { DOUBT_ENDING_MAX_AFFINITY, TRUST_ENDING_MIN_AFFINITY } from "@/game/application/deterministicEvolutionSource";

describe("formal-choice divergence", () => {
  it("the opening exposes two distinct server-approved branches", async () => {
    const { repo } = await createJourneyGame();
    const loaded = await repo.repo.getCurrentGame();
    if (!loaded.ok || loaded.status !== "active") throw new Error("missing game");

    const openingNpc = entitiesOfKind(loaded.record.worldState.entityStore, "npc")[0];
    expect(openingNpc?.identity.anchors.values.length).toBeGreaterThan(0);
    expect(openingNpc?.relationships.outgoing.every((edge) => edge.evidence.every((evidence) => evidence.actionId.trim() !== ""))).toBe(true);
    expect(TRUST_ENDING_MIN_AFFINITY).toBe(10);
    expect(DOUBT_ENDING_MAX_AFFINITY).toBe(9);

    const map = buildChoiceMap(
      loaded.record.worldState,
      loaded.record.storyState,
      loaded.record.revision,
    );
    const formalDialogueActs = [...map.values()]
      .filter((action): action is Extract<typeof action, { type: "talk" }> => action.type === "talk")
      .map((action) => action.dialogueAct)
      .filter((act): act is "challenge" | "support" => act === "challenge" || act === "support");
    expect(formalDialogueActs).toContain("challenge");
    expect(formalDialogueActs).toContain("support");
  });
});
