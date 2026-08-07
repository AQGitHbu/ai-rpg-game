import type { GameLength } from "./newGame";

export type BudgetDimension = {
  readonly opening: number;
  readonly expanded: number;
  readonly max: number;
};

export type StoryBudget = {
  readonly locations: BudgetDimension;
  readonly npcs: BudgetDimension;
  readonly quests: BudgetDimension;
  readonly events: BudgetDimension;
  readonly hardLimit: { readonly locations: number; readonly npcs: number };
};

export const TARGET_ACTS: Record<GameLength, number> = {
  short: 3, medium: 5, long: 8, open: 5,
} as const;

const PRESETS = {
  short: { locationsMax: 8, npcsMax: 10, questsMax: 4, eventsMax: 6 },
  medium: { locationsMax: 14, npcsMax: 16, questsMax: 8, eventsMax: 12 },
  long: { locationsMax: 22, npcsMax: 24, questsMax: 12, eventsMax: 20 },
  open: { locationsMax: 999, npcsMax: 999, questsMax: 999, eventsMax: 999 },
} as const;

const HARD_LIMIT = { locations: 40, npcs: 30 } as const;

export type BudgetDimensionKey = "locations" | "npcs" | "quests" | "events";

export function createStoryBudget(
  gameLength: GameLength,
  initialCounts: { locations: number; npcs: number; quests: number; events: number },
): StoryBudget {
  const p = PRESETS[gameLength];
  return Object.freeze({
    locations: { opening: initialCounts.locations, expanded: 0, max: p.locationsMax },
    npcs: { opening: initialCounts.npcs, expanded: 0, max: p.npcsMax },
    quests: { opening: initialCounts.quests, expanded: 0, max: p.questsMax },
    events: { opening: initialCounts.events, expanded: 0, max: p.eventsMax },
    hardLimit: HARD_LIMIT,
  });
}

export function budgetAllowsExpansion(budget: StoryBudget, dim: BudgetDimensionKey): boolean {
  return budget[dim].expanded < budget[dim].max;
}

export function withinHardLimit(budget: StoryBudget, dim: "locations" | "npcs"): boolean {
  const d = budget[dim];
  return d.opening + d.expanded < budget.hardLimit[dim];
}

export function consumeExpansion(budget: StoryBudget, dim: BudgetDimensionKey): StoryBudget {
  const d = budget[dim];
  return { ...budget, [dim]: { ...d, expanded: d.expanded + 1 } };
}
