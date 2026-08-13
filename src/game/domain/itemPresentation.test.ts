import { describe, expect, it } from "vitest";
import { resolveItemPresentation } from "./itemPresentation";

describe("resolveItemPresentation", () => {
  it("derives a quest item presentation from its kind", () => {
    expect(resolveItemPresentation({ kind: "key" })).toEqual({
      category: "quest",
      rarity: "rare",
      level: null,
      statLines: [],
      icon: "key",
    });
  });

  it("preserves explicit metadata and rejects invalid levels from the display", () => {
    expect(resolveItemPresentation({
      kind: "weapon",
      category: "equipment",
      rarity: "fine",
      level: 0,
      statLines: [{ label: "攻击力", value: "+6" }],
    })).toEqual({
      category: "equipment",
      rarity: "fine",
      level: null,
      statLines: [{ label: "攻击力", value: "+6" }],
      icon: "sword",
    });
  });

  it("uses a safe consumable fallback for an unknown kind", () => {
    expect(resolveItemPresentation({ kind: "mystery" })).toMatchObject({
      category: "consumable",
      rarity: "common",
      icon: "potion",
    });
  });
});
