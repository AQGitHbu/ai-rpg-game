import { describe, expect, it } from "vitest";
import { asEnemyId, asFactId, asItemId, asLocationId, asNpcId } from "@/game/domain";
import type { AvailableAction } from "../actions";
import { actionKeyOf, findAvailableActionByKey, toNarrativeActionCandidates } from "./actionCandidates";

describe("actionCandidates", () => {
  const actions: readonly AvailableAction[] = [
    { type: "observe", locationId: asLocationId("loc_village"), label: "观察村落" },
    { type: "talk", npcId: asNpcId("npc_1"), label: "与掌柜交谈" },
    { type: "investigate", factId: asFactId("fact_1"), label: "调查线索" },
    { type: "move", locationId: asLocationId("loc_temple"), label: "前往寺庙" },
    { type: "take_item", itemId: asItemId("item_sword"), label: "拾取长剑" },
    { type: "start_battle", enemyId: asEnemyId("enemy_boss"), label: "挑战boss" },
    { type: "battle_action", action: "attack", label: "攻击" },
  ];

  it("creates stable unique keys for each action type", () => {
    expect(actionKeyOf(actions[0])).toBe("observe:loc_village");
    expect(actionKeyOf(actions[1])).toBe("talk:npc_1");
    expect(actionKeyOf(actions[2])).toBe("investigate:fact_1");
    expect(actionKeyOf(actions[3])).toBe("move:loc_temple");
    expect(actionKeyOf(actions[4])).toBe("take_item:item_sword");
    expect(actionKeyOf(actions[5])).toBe("start_battle:enemy_boss");
    expect(actionKeyOf(actions[6])).toBe("battle_action:attack");
  });

  it("creates candidates from available actions", () => {
    const candidates = toNarrativeActionCandidates(actions);
    expect(candidates.map((entry) => entry.actionKey)).toEqual([
      "observe:loc_village",
      "talk:npc_1",
      "investigate:fact_1",
      "move:loc_temple",
      "take_item:item_sword",
      "start_battle:enemy_boss",
      "battle_action:attack",
    ]);
    expect(candidates[0].kind).toBe("observe");
    expect(candidates[0].publicLabel).toBe("观察村落");
  });

  it("only resolves a key from the current available action list", () => {
    expect(findAvailableActionByKey(actions, "talk:npc_1")).toEqual(actions[1]);
    expect(findAvailableActionByKey(actions, "talk:npc_hidden")).toBeNull();
    expect(findAvailableActionByKey(actions.slice(0, 2), "investigate:fact_1")).toBeNull();
  });
});
