import { describe, expect, it } from "vitest";
import { createJourneyGame, loadStoryState, playIssuedChoice } from "./foundationJourney.testutil";
import { entitiesOfKind } from "@/game/domain/entity";

describe("medium-length decision-boundary setup", () => {
  it("creates a five-act story and defers continuation generation to the first formal decision", async () => {
    const { repo } = await createJourneyGame(undefined, undefined, "medium-seed", "medium");
    const opening = await loadStoryState(repo.repo);
    expect(opening?.targetActs).toBe(5);
    const record = repo.record();
    if (record === null) throw new Error("opening record missing");
    const openingNpc = entitiesOfKind(record.worldState.entityStore, "npc")[0];
    expect(openingNpc?.identity.anchors).toEqual(expect.objectContaining({ selfConcept: expect.any(String) }));
    expect(openingNpc?.dynamicState.goals.filter((goal) => goal.status === "active")).not.toHaveLength(0);
    expect(opening?.narrative.status).toBe("ready");
    if (opening?.narrative.status === "ready") {
      expect(opening.narrative.narrativeBundle?.steps).toEqual([]);
    }

    const chosen = await playIssuedChoice(repo.repo, "回应");
    expect(chosen.ok).toBe(true);
    const pending = await loadStoryState(repo.repo);
    expect(pending?.narrative.status).toBe("provider_pending");
  });
});
