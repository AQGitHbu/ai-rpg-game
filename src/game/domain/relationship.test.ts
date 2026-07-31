import { describe, expect, it } from "vitest";
import {
  relationshipTierOf,
  clampAffinity,
  RELATIONSHIP_CHANGE,
  RELATIONSHIP_MIN,
  RELATIONSHIP_MAX,
  type RelationshipTier,
  type RelationshipValue,
} from "./relationship";

describe("relationshipTierOf", () => {
  it("hostile: affinity <= -60", () => {
    expect(relationshipTierOf({ affinity: -100 })).toBe("hostile");
    expect(relationshipTierOf({ affinity: -60 })).toBe("hostile");
  });
  it("cold: -60 < affinity <= -20", () => {
    expect(relationshipTierOf({ affinity: -59 })).toBe("cold");
    expect(relationshipTierOf({ affinity: -20 })).toBe("cold");
  });
  it("neutral: -20 < affinity < 20", () => {
    expect(relationshipTierOf({ affinity: 0 })).toBe("neutral");
    expect(relationshipTierOf({ affinity: 19 })).toBe("neutral");
  });
  it("friendly: 20 <= affinity < 60", () => {
    expect(relationshipTierOf({ affinity: 20 })).toBe("friendly");
    expect(relationshipTierOf({ affinity: 59 })).toBe("friendly");
  });
  it("trusted: affinity >= 60", () => {
    expect(relationshipTierOf({ affinity: 60 })).toBe("trusted");
    expect(relationshipTierOf({ affinity: 100 })).toBe("trusted");
  });
});

describe("clampAffinity", () => {
  it("clamps to min", () => expect(clampAffinity(-200)).toBe(-100));
  it("clamps to max", () => expect(clampAffinity(200)).toBe(100));
  it("passes through within range", () => expect(clampAffinity(42)).toBe(42));
});

describe("constants", () => {
  it("RELATIONSHIP_CHANGE values are correct", () => {
    expect(RELATIONSHIP_CHANGE.GREET_FIRST_MEET).toBe(5);
    expect(RELATIONSHIP_CHANGE.ASK_MAIN_QUEST_COMPLETE).toBe(10);
    expect(RELATIONSHIP_CHANGE.FREE_INPUT_POSITIVE).toBe(3);
    expect(RELATIONSHIP_CHANGE.FREE_INPUT_NEGATIVE).toBe(-3);
  });
  it("bounds are correct", () => {
    expect(RELATIONSHIP_MIN).toBe(-100);
    expect(RELATIONSHIP_MAX).toBe(100);
  });
});