import { describe, expect, it } from "vitest";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { createJourneyGame } from "./foundationJourney.testutil";

describe("formal-choice divergence", () => {
  it("the opening exposes two distinct server-approved branches", async () => {
    const { repo } = await createJourneyGame();
    const loaded = await repo.repo.getCurrentGame();
    if (!loaded.ok || loaded.status !== "active") throw new Error("missing game");

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
