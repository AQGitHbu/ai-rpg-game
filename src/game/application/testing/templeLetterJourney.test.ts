/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  runTempleDepartureProbes,
  runTempleLetterJourney,
  type TempleRoute,
} from "./templeLetterJourney.testutil";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

describe("破庙来信 production journey", () => {
  const routes: readonly TempleRoute[] = [
    "private",
    "public",
    "verify_first",
    "exit_return",
    "exit_keep",
  ];

  for (const route of routes) {
    it(`completes ${route} through production turn APIs`, async () => {
      const result = await runTempleLetterJourney(route);

      expect(result.ended).toBe(true);
      expect(result.actionCount).toBeLessThanOrEqual(24);
      expect(result.snapshots.length).toBeGreaterThan(3);
      const final = result.snapshots.at(-1);
      expect(final).toBeDefined();
      const itemGivenCount = final?.worldState.eventLedger.filter((event) => event.kind === "item_given").length;
      expect(itemGivenCount).toBe(route === "exit_keep" ? 0 : 1);
      expect(result.publicExposure).toBe(route === "public");
      expect(result.promiseStatus).toBe(route === "private" ? "fulfilled" : "absent");
      expect(result.itemOwnerAtEnd).toBe(route === "exit_keep" ? PLAYER_ENTITY_ID : "npc_dyn_2");
      const expectedOperation = {
        private: "promise_confidentiality",
        public: "share_known_fact",
        verify_first: "request_verification",
      }[route as "private" | "public" | "verify_first"];
      if (expectedOperation !== undefined) {
        const operations = final?.worldState.eventLedger.flatMap((event) =>
          event.kind === "story_interaction_resolved" && event.payload.type === "story_interaction_resolved"
            ? [event.payload.operation]
            : []);
        expect(operations).toContain(expectedOperation);
      }
    });
  }

  it("reloads the same SQLite save before the final act and still completes", async () => {
    const result = await runTempleLetterJourney("private", { reloadBeforeFinalAct: true });

    expect(result.ended).toBe(true);
    expect(result.itemOwnerAtEnd).toBe("npc_dyn_2");
    expect(result.promiseStatus).toBe("fulfilled");
  });

  it("does not turn ordinary departure or freeform 我走了 into an ending", async () => {
    const result = await runTempleDepartureProbes();

    expect(result.ordinaryMoveRejected).toBe(true);
    expect(result.ordinaryMoveEnded).toBe(false);
    expect(result.freeformEnded).toBe(false);
    expect(result.freeformItemOwner).toBe(PLAYER_ENTITY_ID);
    expect(result.freeformWasNeutral).toBe(true);
  });
});
