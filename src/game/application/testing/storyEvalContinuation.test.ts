import { describe, expect, it } from "vitest";
import type { GameState, NewGameInput } from "@/game/domain";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import { runScenarioPipeline } from "../applicationFixture.testutil";
import { projectStoryEvalContinuation } from "./storyEvalContinuation";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";

const fixture = wuxiaFixture as unknown as { input: NewGameInput };
const pipeline = runScenarioPipeline(
  { ...fixture.input, gameLength: "long" },
  "story-eval-continuation",
);

function singleMoveState(): GameState {
  const current = pipeline.state.currentLocationId;
  const location = pipeline.blueprint.locations.find((entry) => entry.id === current);
  const target = location?.connectedLocationIds[0];
  if (target === undefined) throw new Error("fixture opening location has no connection");
  return {
    ...pipeline.state,
    unlockedLocationIds: [current, target],
    eventLedger: [
      ...pipeline.state.eventLedger,
      { type: "location_observed", locationId: current, occurredAt: "2026-08-03T00:00:00.000Z" },
    ],
    npcs: pipeline.state.npcs.map((npc) => ({ ...npc, met: true })),
    worldFacts: pipeline.state.worldFacts.map((fact) => ({ ...fact, discovered: true })),
    inventory: pipeline.blueprint.items.map((item) => item.id),
  };
}

describe("projectStoryEvalContinuation", () => {
  it("returns the only legal non-battle action as a runner bridge", () => {
    const state = singleMoveState();
    const actions = projectAvailableActions(pipeline.blueprint, state);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("move");

    const continuation = projectStoryEvalContinuation(pipeline.blueprint, state);
    expect(continuation).toMatchObject({
      actionKey: `move:${actions[0] && actions[0].type === "move" ? actions[0].locationId : ""}`,
      label: actions[0]?.label,
      reason: "single_legal_action",
      intent: { type: "move" },
    });
  });

  it("does not consume a battle_action as a narrative recovery bridge", () => {
    const state = { ...singleMoveState(), battle: { status: "active" as const, enemyId: "enemy_1" as never, playerHp: 1, enemyHp: 1, round: 1 } };
    expect(projectStoryEvalContinuation(pipeline.blueprint, state)).toBeNull();
  });
});
