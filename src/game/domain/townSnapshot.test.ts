import { describe, expect, it } from "vitest";
import {
  TOWN_GENERATOR_VERSION,
  TOWN_GRID_DEFAULT,
  TOWN_GRID_MAX,
  TOWN_GRID_MIN,
  tileIndex
} from "./townSnapshot";

describe("townSnapshot 常量", () => {
  it("生成器版本为 town-gen-0.1.0", () => {
    expect(TOWN_GENERATOR_VERSION).toBe("town-gen-0.1.0");
  });

  it("网格合法域为 24–40，默认 32", () => {
    expect(TOWN_GRID_MIN).toBe(24);
    expect(TOWN_GRID_MAX).toBe(40);
    expect(TOWN_GRID_DEFAULT).toBe(32);
    expect(TOWN_GRID_MIN).toBeLessThanOrEqual(TOWN_GRID_DEFAULT);
    expect(TOWN_GRID_DEFAULT).toBeLessThanOrEqual(TOWN_GRID_MAX);
  });
});

describe("tileIndex", () => {
  it("行优先扁平索引：y * width + x", () => {
    expect(tileIndex({ width: 32 }, 3, 2)).toBe(67);
  });

  it("原点为 0，行首随行号推进", () => {
    expect(tileIndex({ width: 32 }, 0, 0)).toBe(0);
    expect(tileIndex({ width: 32 }, 0, 1)).toBe(32);
    expect(tileIndex({ width: 24 }, 23, 23)).toBe(24 * 24 - 1);
  });
});
