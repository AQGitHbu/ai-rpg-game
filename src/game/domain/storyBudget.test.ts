import { describe, it, expect } from "vitest";
import { createStoryBudget, budgetAllowsExpansion, withinHardLimit, TARGET_ACTS } from "./storyBudget";

describe("StoryBudget", () => {
  it("short game: locations max=8, opening 记入不占扩展预算", () => {
    const b = createStoryBudget("short", { locations: 4, npcs: 5, quests: 2, events: 0 });
    expect(b.locations.max).toBe(8);
    expect(b.locations.opening).toBe(4);
    expect(b.locations.expanded).toBe(0);
    expect(TARGET_ACTS.short).toBe(3);
  });

  it("budgetAllowsExpansion true when expanded < max", () => {
    const b = createStoryBudget("short", { locations: 4, npcs: 5, quests: 2, events: 0 });
    expect(budgetAllowsExpansion(b, "locations")).toBe(true);
  });

  it("budgetAllowsExpansion false when expanded >= max", () => {
    const b = createStoryBudget("short", { locations: 4, npcs: 5, quests: 2, events: 0 });
    const b2 = { ...b, locations: { ...b.locations, expanded: 8 } };
    expect(budgetAllowsExpansion(b2, "locations")).toBe(false);
  });

  it("withinHardLimit for opening + expanded total (spec 3.3 safety valve)", () => {
    const b = createStoryBudget("short", { locations: 39, npcs: 0, quests: 0, events: 0 });
    expect(withinHardLimit(b, "locations")).toBe(true);   // 39 < 40
    const b2 = { ...b, locations: { ...b.locations, expanded: 1 } };
    expect(withinHardLimit(b2, "locations")).toBe(false);  // 39+1 = 40 -> over limit
  });
});
