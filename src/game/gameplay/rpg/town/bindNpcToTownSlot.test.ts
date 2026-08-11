import { describe, expect, it } from "vitest";
import { bindNpcToTownSlot } from "./bindNpcToTownSlot";
import { createTownRuntime } from "./createTownRuntime";
import type { TownRuntimeState } from "@/game/domain/townState";
import { asLocationId, asNpcId } from "@/game/domain/worldEntity";

function emptyTown(): TownRuntimeState {
  return createTownRuntime({ locationId: asLocationId("loc_0"), seed: "demo-1" });
}

describe("bindNpcToTownSlot", () => {
  it("把 NPC 绑定到第一个空闲 slot 并返回绑定后的城镇与 slot", () => {
    const town = emptyTown();
    const result = bindNpcToTownSlot(town, asNpcId("npc_0"));
    expect(result.slot.slotId).toBe("slot_0");
    expect(result.slot.boundNpcId).toBe(asNpcId("npc_0"));
    expect(result.town.slots[0]?.boundNpcId).toBe(asNpcId("npc_0"));
  });

  it("后续 NPC 依次绑定下一个空闲 slot，已绑定的 slot 不变", () => {
    const first = bindNpcToTownSlot(emptyTown(), asNpcId("npc_0"));
    const second = bindNpcToTownSlot(first.town, asNpcId("npc_1"));
    expect(second.slot.slotId).toBe("slot_1");
    expect(second.town.slots[0]?.boundNpcId).toBe(asNpcId("npc_0"));
    expect(second.town.slots[1]?.boundNpcId).toBe(asNpcId("npc_1"));
    expect(second.town.slots[2]?.boundNpcId).toBeNull();
  });

  it("slot 满员时抛错且不改动原城镇", () => {
    let town = emptyTown();
    town = bindNpcToTownSlot(town, asNpcId("npc_0")).town;
    town = bindNpcToTownSlot(town, asNpcId("npc_1")).town;
    town = bindNpcToTownSlot(town, asNpcId("npc_2")).town;
    expect(() => bindNpcToTownSlot(town, asNpcId("npc_3"))).toThrow(/无可用 slot/);
    expect(town.slots.map((slot) => slot.boundNpcId)).toEqual([
      asNpcId("npc_0"),
      asNpcId("npc_1"),
      asNpcId("npc_2"),
    ]);
  });

  it("纯函数：不修改入参城镇", () => {
    const town = emptyTown();
    const before = JSON.stringify(town);
    bindNpcToTownSlot(town, asNpcId("npc_0"));
    expect(JSON.stringify(town)).toBe(before);
  });
});
