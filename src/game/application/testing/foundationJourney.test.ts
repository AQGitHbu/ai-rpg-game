import { describe, expect, it } from "vitest";
import { createJourneyGame, loadStoryState, playIssuedChoice } from "./foundationJourney.testutil";

// The old journey asserted a rule-owned scene write after every move, item and
// combat action. That is deliberately no longer a runtime capability: a
// formal choice opens one provider job, and the returned narrative bundle owns
// everything until the next decision boundary.
describe("foundation decision-boundary journey", () => {
  it("opening formal choice creates exactly one pending narrative job and blocks another action", async () => {
    const { repo } = await createJourneyGame();

    const first = await playIssuedChoice(repo.repo, "回应");
    expect(first.ok).toBe(true);
    expect(repo.applyCalls()).toHaveLength(1);

    const pending = await loadStoryState(repo.repo);
    expect(pending?.narrative.status).toBe("provider_pending");

    const second = await playIssuedChoice(repo.repo, "追问");
    expect(second.ok).toBe(false);
    expect(repo.applyCalls()).toHaveLength(1);
  });
});
