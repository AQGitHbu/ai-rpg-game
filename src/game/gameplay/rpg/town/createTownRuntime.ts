import type { LocationId, NpcId } from "@/game/domain/worldEntity";
import type { TownBuildingSlot, TownBuildingSlotType, TownRuntimeState, TownBuildingType } from "@/game/domain/townState";
import { TOWN_GENERATOR_VERSION } from "@/game/domain/townState";
import { generateTown } from "./generateTown";

const SLOT_TYPE_BY_BUILDING_TYPE: Readonly<Record<TownBuildingType, TownBuildingSlotType>> = {
  tavern: "tavern",
  blacksmith: "blacksmith",
  house: "house",
  shop: "market",
  workshop: "market",
  warehouse: "market",
  well: "house",
  gatehouse: "house",
};

export type CreateTownRuntimeInput = {
  readonly locationId: LocationId;
  readonly seed: string;
};

export function createTownRuntime(input: CreateTownRuntimeInput): TownRuntimeState {
  const snapshot = generateTown({ seed: input.seed });
  const storyBuildings = [...snapshot.buildings]
    .filter((building) => building.storyRequired)
    .sort((a, b) => {
      const numA = Number(a.buildingId.replace("building_", ""));
      const numB = Number(b.buildingId.replace("building_", ""));
      return numA - numB;
    });
  const slots: TownBuildingSlot[] = storyBuildings.map((building, index) => ({
    slotId: `slot_${index}`,
    buildingId: building.buildingId,
    buildingType: SLOT_TYPE_BY_BUILDING_TYPE[building.buildingType],
    boundNpcId: null,
  }));
  return {
    locationId: input.locationId,
    seed: input.seed,
    generatorVersion: TOWN_GENERATOR_VERSION,
    slots,
  };
}

export function townSeedFor(generationSeed: string, locationId: string): string {
  return `${generationSeed}#town#${locationId}`;
}