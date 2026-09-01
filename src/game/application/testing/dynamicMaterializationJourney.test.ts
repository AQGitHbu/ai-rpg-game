import { describe, expect, it } from "vitest";
import { createJourneyGame, loadGameRecord, loadGameView } from "./foundationJourney.testutil";
import { entitiesOfKind } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

describe("dynamic narrative materialization", () => {
  it("opening exposes AI-generated dialogue choices, never a rule-owned scene", async () => {
    const { repo } = await createJourneyGame();
    const record = await loadGameRecord(repo.repo);
    expect(record?.storyState.narrative.status).toBe("ready");
    const openingNpc = record === null
      ? undefined
      : entitiesOfKind(record.worldState.entityStore, "npc")[0];
    expect(openingNpc?.identity.anchors.selfConcept).toBeTruthy();
    expect(openingNpc?.dynamicState.goals.some((goal) => goal.status === "active")).toBe(true);
    expect(openingNpc?.knowledge.entries.every((entry) => entry.source.kind === "initial_world")).toBe(true);
    expect(openingNpc?.relationships.outgoing.some((edge) => edge.targetId === PLAYER_ENTITY_ID)).toBe(true);
    expect(record?.worldState.npcs.find((npc) => npc.id === openingNpc?.core.id)?.memory.relationship.affinity)
      .toBe(openingNpc?.relationships.outgoing.find((edge) => edge.targetId === PLAYER_ENTITY_ID)?.dimensions.affinity);
    if (record?.storyState.narrative.status === "ready") {
      expect(record.storyState.narrative.currentScene.source).toBe("generated");
      expect(record.storyState.narrative.currentScene.choices).toHaveLength(2);
    }

    const view = await loadGameView(repo.repo);
    expect(view.narrative.npcDialogues.flatMap((dialogue) => dialogue.choices)).toHaveLength(2);
  });
});
