import { describe, expect, it } from "vitest";
import { checkStepDependencies, sceneSnapshot } from "./sceneSnapshot";
import type { ApprovedPlan } from "./approvePlan";
import type { Observation } from "@/game/domain/narrativeObservation";
import type { ScenePoint } from "@/game/domain/narrativeUnit";
import {
  branchWorld,
  branchStory,
  branchDecision,
  LOC_A,
  LOC_B,
  LOC_C,
  NPC_0,
} from "./branchFixture.testutil";
import { makeStagedPlan } from "@/game/domain/testing/stagedNarrativeFixture.testutil";
import { asItemId, asLocationId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

const POINT: ScenePoint = { stepKey: "current", order: 1 };

function planWithObservations(observations: readonly Observation[]): ApprovedPlan {
  return {
    proposal: { ...makeStagedPlan(), observations },
    world: branchWorld(),
    story: branchStory(),
    units: [],
    choiceExpression: branchDecision(),
    stepDependencies: {},
  };
}

describe("sceneSnapshot", () => {
  it("返回该时点批准的观察与权威状态（preview 不是权威状态的拷贝）", () => {
    const observation: Observation = {
      key: "obs_arrival",
      point: POINT,
      audienceIds: [String(PLAYER_ENTITY_ID)],
      fact: { factId: "fact_0", certainty: "known" },
      source: { kind: "witness" },
    };
    const plan = planWithObservations([observation]);
    const result = sceneSnapshot({ plan, point: POINT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.observations).toEqual([observation]);
    expect(result.value.world).toBe(plan.world);
    expect(result.value.story).toBe(plan.story);
  });

  it("拒绝没有任何单元或观察的未知时点", () => {
    const plan = planWithObservations([]);
    expect(sceneSnapshot({ plan, point: { stepKey: "nowhere", order: 3 } }))
      .toEqual({ ok: false, code: "unknown_point" });
  });
});

describe("checkStepDependencies", () => {
  it("player_location：玩家在指定地点通过，否则失败", () => {
    const world = branchWorld();
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "player_location", locationId: String(LOC_A) } }],
    })).toEqual({ ok: true, value: true });
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "player_location", locationId: String(LOC_B) } }],
    })).toEqual({ ok: false, code: "player_location_mismatch" });
  });

  it("npc_location：NPC 必须位于指定地点", () => {
    const world = branchWorld();
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "npc_location", npcId: String(NPC_0), locationId: String(LOC_A) } }],
    })).toEqual({ ok: true, value: true });
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "npc_location", npcId: String(NPC_0), locationId: String(LOC_B) } }],
    })).toEqual({ ok: false, code: "npc_location_mismatch" });
  });

  it("item_holder：物品在玩家背包或地点可得", () => {
    const item = asItemId("item_letter");
    const itemEntry = { id: item, name: "信件", description: "一封未寄出的信。", kind: "quest", tags: [] };
    const withItem = branchWorld({ items: [itemEntry], inventory: [item] });
    expect(checkStepDependencies({
      world: withItem, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "item_holder", itemId: "item_letter", holderId: String(PLAYER_ENTITY_ID) } }],
    })).toEqual({ ok: true, value: true });
    const atLocation = branchWorld({
      items: [itemEntry],
      locations: [
        {
          id: LOC_A, name: "渡口", description: "渡口的描述", kind: "main",
          connectedLocationIds: [LOC_B, LOC_C], npcIds: [NPC_0],
          availableItemIds: [], tags: [], scale: "scene",
        },
        {
          id: LOC_B, name: "废窑", description: "废窑的描述", kind: "main",
          connectedLocationIds: [LOC_A], npcIds: [],
          availableItemIds: [item], tags: [], scale: "scene",
        },
        {
          id: LOC_C, name: "义庄", description: "义庄的描述", kind: "main",
          connectedLocationIds: [LOC_A], npcIds: [],
          availableItemIds: [], tags: [], scale: "scene",
        },
      ],
    });
    expect(checkStepDependencies({
      world: atLocation, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "item_holder", itemId: "item_letter", holderId: String(LOC_B) } }],
    })).toEqual({ ok: true, value: true });
    expect(checkStepDependencies({
      world: branchWorld(), story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "item_holder", itemId: "item_letter", holderId: String(PLAYER_ENTITY_ID) } }],
    })).toEqual({ ok: false, code: "item_holder_mismatch" });
  });

  it("entity_lifecycle：active 需实体存在；resolved 需敌人被击败", () => {
    const world = branchWorld();
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "entity_lifecycle", entityId: String(NPC_0), lifecycle: "active" } }],
    })).toEqual({ ok: true, value: true });
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "entity_lifecycle", entityId: "npc_missing", lifecycle: "active" } }],
    })).toEqual({ ok: false, code: "entity_lifecycle_mismatch" });
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "entity_lifecycle", entityId: "enemy_bandit", lifecycle: "resolved" } }],
    })).toEqual({ ok: false, code: "entity_lifecycle_mismatch" });
  });

  it("branch_selected：以 selectedBranches 为准", () => {
    const story = branchStory();
    const decided = {
      ...story,
      selectedBranches: { ...story.selectedBranches, dec_1: "left" },
      branchDecisions: { ...story.branchDecisions, dec_1: branchDecision() },
    };
    expect(checkStepDependencies({
      world: branchWorld(), story: decided, phase: "after",
      expected: [{ phase: "after", predicate: { kind: "branch_selected", decisionId: "dec_1", candidateId: "left" } }],
    })).toEqual({ ok: true, value: true });
    expect(checkStepDependencies({
      world: branchWorld(), story: decided, phase: "after",
      expected: [{ phase: "after", predicate: { kind: "branch_selected", decisionId: "dec_1", candidateId: "right" } }],
    })).toEqual({ ok: false, code: "branch_not_selected" });
  });

  it("phase 不匹配直接失败", () => {
    expect(checkStepDependencies({
      world: branchWorld(), story: branchStory(), phase: "after",
      expected: [{ phase: "before", predicate: { kind: "player_location", locationId: String(LOC_A) } }],
    })).toEqual({ ok: false, code: "phase_mismatch" });
  });

  it("observation：无回执凭据时按 fail-closed 处理", () => {
    expect(checkStepDependencies({
      world: branchWorld(), story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "observation", observationKey: "obs_arrival", audienceId: String(PLAYER_ENTITY_ID) } }],
    })).toEqual({ ok: false, code: "observation_receipt_missing" });
    expect(checkStepDependencies({
      world: branchWorld(), story: branchStory(), phase: "before",
      expected: [{ phase: "before", predicate: { kind: "observation", observationKey: "obs_arrival", audienceId: String(PLAYER_ENTITY_ID) } }],
      observationReceipts: new Set([`${String(PLAYER_ENTITY_ID)}:obs_arrival`]),
    })).toEqual({ ok: true, value: true });
  });

  it("多依赖全部满足才通过", () => {
    const world = branchWorld();
    expect(checkStepDependencies({
      world, story: branchStory(), phase: "before",
      expected: [
        { phase: "before", predicate: { kind: "player_location", locationId: String(LOC_A) } },
        { phase: "before", predicate: { kind: "player_location", locationId: String(asLocationId("loc_missing")) } },
      ],
    })).toEqual({ ok: false, code: "player_location_mismatch" });
  });
});
