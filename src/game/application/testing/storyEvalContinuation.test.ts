import { describe, expect, it } from "vitest";
import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  makeValidCandidate,
  TEST_POLICY,
  TEST_PROFILE
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { projectStoryEvalContinuation } from "./storyEvalContinuation";

const compiled = compileScenarioBlueprint(
  validateScenarioBlueprintCandidate(makeValidCandidate(), {
    profile: TEST_PROFILE,
    policy: TEST_POLICY,
    phase: "runtime_expansion"
  })
);
if (!compiled.ok) throw new Error(`fixture blueprint invalid: ${JSON.stringify(compiled.issues)}`);
const BLUEPRINT: ScenarioBlueprint = compiled.blueprint;

/** 当前地点已观察、NPC 全已结识、事实全已发现、物品全持有；
 *  唯一的合法非战斗行动是前往厅二厅（move:loc_b）。 */
function singleMoveState(): GameState {
  const state = initializeGameState(BLUEPRINT);
  return {
    ...state,
    eventLedger: [
      ...state.eventLedger,
      { type: "location_observed", locationId: state.currentLocationId, occurredAt: "2026-08-03T00:00:00.000Z" },
    ],
    npcs: state.npcs.map((npc) => ({ ...npc, met: true })),
    worldFacts: state.worldFacts.map((fact) => ({ ...fact, discovered: true })),
    inventory: BLUEPRINT.items.map((item) => item.id),
  };
}

describe("projectStoryEvalContinuation", () => {
  it("returns the only legal non-battle action as a runner bridge", () => {
    const state = singleMoveState();
    const actions = projectAvailableActions(BLUEPRINT, state);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.type).toBe("move");

    const continuation = projectStoryEvalContinuation(BLUEPRINT, state);
    expect(continuation).toMatchObject({
      actionKey: `move:${actions[0] && actions[0].type === "move" ? actions[0].locationId : ""}`,
      label: actions[0]?.label,
      reason: "single_legal_action",
      intent: { type: "move" },
    });
  });

  it("does not consume a battle_action as a narrative recovery bridge", () => {
    const state = { ...singleMoveState(), battle: { status: "active" as const, enemyId: "enemy_a" as never, playerHp: 1, enemyHp: 1, round: 1 } };
    expect(projectStoryEvalContinuation(BLUEPRINT, state)).toBeNull();
  });
});