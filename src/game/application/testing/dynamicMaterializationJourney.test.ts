import { describe, expect, it } from "vitest";
import { createJourneyGame, loadGameRecord, loadGameView } from "./foundationJourney.testutil";

describe("dynamic narrative materialization", () => {
  it("opening exposes AI-generated dialogue choices, never a rule-owned scene", async () => {
    const { repo } = await createJourneyGame();
    const record = await loadGameRecord(repo.repo);
    expect(record?.storyState.narrative.status).toBe("ready");
    if (record?.storyState.narrative.status === "ready") {
      expect(record.storyState.narrative.currentScene.source).toBe("generated");
      expect(record.storyState.narrative.currentScene.choices).toHaveLength(2);
    }

    const view = await loadGameView(repo.repo);
    expect(view.narrative.npcDialogues.flatMap((dialogue) => dialogue.choices)).toHaveLength(2);
  });
});
