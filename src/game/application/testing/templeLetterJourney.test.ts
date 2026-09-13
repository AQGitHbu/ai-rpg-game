/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  runTempleDepartureProbes,
  runConditionalSecretIntroductionProbe,
  runTempleLetterJourney,
  type TempleRoute,
} from "./templeLetterJourney.testutil";
import { resolveStoryInteraction } from "@/game/gameplay/rpg/storyInteraction";
import { createEntityStore, type NpcEntityRecord } from "@/game/domain/entity";
import { asTurnId } from "@/game/domain/events";
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
      expect(result.promiseStatus).toBe(route === "private" ? "fulfilled" : route === "exit_return" ? "released" : route === "exit_keep" ? "broken" : "absent");
      expect(result.itemOwnerAtEnd).toBe(route === "exit_keep" ? PLAYER_ENTITY_ID : route === "exit_return" ? "npc_0" : "npc_dyn_2");
      if (route === "exit_return") expect(final!.worldState.eventLedger.find((event) => event.payload.type === "item_given")?.payload).toMatchObject({ type: "item_given", npcId: "npc_0" });
      const expectedOperation = {
        private: "promise_confidentiality",
        public: "share_known_fact",
        verify_first: "request_verification",
      }[route as "private" | "public" | "verify_first"];
      if (route === "private") {
        const events = final!.worldState.eventLedger;
        const pledgeIndex = events.findIndex((event) => event.payload.type === "story_interaction_resolved" && event.payload.operation === "promise_confidentiality");
        const introductionIndex = events.findIndex((event) => event.payload.type === "story_interaction_resolved" && event.payload.operation === "request_introduction");
        const deliveryIndex = events.findIndex((event) => event.payload.type === "item_given");
        expect(pledgeIndex).toBeGreaterThan(-1);
        expect(introductionIndex).toBeGreaterThan(pledgeIndex);
        expect(deliveryIndex).toBeGreaterThan(introductionIndex);
        const priorDelivery = result.snapshots.filter((snapshot) => !snapshot.worldState.eventLedger.some((event) => event.payload.type === "item_given"));
        expect(priorDelivery.at(-1)!.worldState.entityStore.records.flatMap((record) => record.core.kind === "npc" ? (record as import("@/game/domain/entity").NpcEntityRecord).relationships.outgoing.flatMap((edge) => edge.commitments) : []).find((entry) => entry.kind === "promise")?.status).toBe("open");
      }
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

  it("keeps a disclosure breach through reload, delivery and a final supportive stance", async () => {
    const result = await runTempleLetterJourney("private", { leakBeforeDelivery: true, reloadBeforeFinalAct: true });
    expect(result.ended).toBe(true);
    expect(result.promiseStatus).toBe("broken");
    expect(result.itemOwnerAtEnd).toBe("npc_dyn_2");
    expect(result.publicExposure).toBe(true);
    const final = result.snapshots.at(-1)!;
    expect(final.worldState.endings.find((ending) => ending.id === final.worldState.ending?.endingId)?.requirements.some((requirement) => requirement.kind === "npc_affinity_at_most")).toBe(true);
    expect(final.worldState.eventLedger.filter((event) => event.kind === "item_given")).toHaveLength(1);
    const recipient = final.worldState.npcs.find((npc) => npc.id === final.storyState.delivery?.recipientNpcId)!;
    expect(recipient.memory.interactionHistory.at(-1)?.dialogueAct).toBe("support");
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


it("persists an opening secret, a real pledge and explicit introduction separately through SQLite reload", async () => {
  const snapshots = await runConditionalSecretIntroductionProbe();
  const secret = snapshots[0]!.worldState.worldFacts.find(fact => fact.text === "引荐人的信物藏在第三块砖下。")!;
  expect(secret.discovered).toBe(false);
  const pledged = snapshots.filter(snapshot => snapshot.worldState.eventLedger.some(event => event.payload.type === "story_interaction_resolved" && event.payload.operation === "promise_confidentiality")
    && !snapshot.worldState.eventLedger.some(event => event.payload.type === "story_interaction_resolved" && event.payload.operation === "request_introduction"));
  expect(pledged.length).toBeGreaterThanOrEqual(2);
  for (const snapshot of pledged) expect(snapshot.worldState.worldFacts.find(fact => fact.factId === secret.factId)?.discovered).toBe(false);
  const beforeIntroduction = pledged.at(-1)!;
  const giver = beforeIntroduction.worldState.entityStore.records.find(record => record.core.id === "npc_0") as NpcEntityRecord;
  const definition = giver.interactions!.find(entry => entry.operation === "request_introduction")!;
  const action = { type: "talk" as const, npcId: giver.core.id, interactionId: definition.id, dialogueAct: "ask" as const };
  const deps = { actionId: "negative_probe", turnId: asTurnId("negative_probe"), turnNumber: 2, now: () => "2026-09-12T00:00:00.000Z" };
  // Even a previously approved token must recheck permissions against current state.
  for (const status of ["broken", "released"] as const) {
    const changed = { ...giver, interactions: [{ ...definition, condition: [] }], relationships: { outgoing: giver.relationships.outgoing.map(edge => ({ ...edge,
      commitments: edge.commitments.map(commitment => commitment.kind === "promise" ? { ...commitment, status } : commitment),
    })) } };
    const world = { ...beforeIntroduction.worldState, entityStore: createEntityStore(beforeIntroduction.worldState.entityStore.records.map(record => record.core.id === giver.core.id ? changed : record)) };
    expect(resolveStoryInteraction(world, action, deps)).toMatchObject({ ok: false });
  }
  expect(resolveStoryInteraction({ ...beforeIntroduction.worldState, eventLedger: [] }, action, deps)).toMatchObject({ ok: false });
  const final = snapshots.at(-1)!;
  expect(final.worldState.worldFacts.find(fact => fact.factId === secret.factId)?.discovered).toBe(true);
  const npc = final.worldState.entityStore.records.find(record => record.core.id === "npc_0") as import("@/game/domain/entity").NpcEntityRecord;
  expect(npc.knowledge.entries.find(entry => entry.factId === secret.factId)?.disclosure).toBe("secret");
});
