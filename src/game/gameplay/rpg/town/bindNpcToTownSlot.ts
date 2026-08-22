import type { NpcId } from "@/game/domain/worldEntity";
import type { TownBuildingSlot, TownRuntimeState } from "@/game/domain/townState";

export type BindNpcToTownSlotResult = {
  readonly town: TownRuntimeState;
  readonly slot: TownBuildingSlot;
};

export function bindNpcToTownSlot(
  town: TownRuntimeState,
  npcId: NpcId,
  displayName?: string,
): BindNpcToTownSlotResult {
  const firstFreeIndex = town.slots.findIndex((slot) => slot.boundNpcId === null);
  if (firstFreeIndex === -1) {
    throw new Error(`bindNpcToTownSlot: 城镇 ${town.locationId} 无可用 slot（NPC ${npcId}）`);
  }
  const slot = town.slots[firstFreeIndex]!;
  const boundSlot: TownBuildingSlot = {
    ...slot,
    ...(displayName === undefined ? {} : { displayName }),
    boundNpcId: npcId,
  };
  const slots = town.slots.map((s, i) => (i === firstFreeIndex ? boundSlot : s));
  return { town: { ...town, slots }, slot: boundSlot };
}
