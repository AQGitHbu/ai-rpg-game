import { describe, expect, it } from "vitest";
import { createTownRng, hashTownSeed } from "./townRandom";

function drawSequence(seed: string, count: number): number[] {
  const rng = createTownRng(seed);
  const values: number[] = [];
  for (let i = 0; i < count; i += 1) values.push(rng.next());
  return values;
}

describe("createTownRng", () => {
  it("同 seed 的两个实例产出完全一致的前 20 个值", () => {
    expect(drawSequence("seed-a", 20)).toEqual(drawSequence("seed-a", 20));
  });

  it("不同 seed 产出不同序列", () => {
    expect(drawSequence("seed-a", 20)).not.toEqual(drawSequence("seed-b", 20));
  });

  it("next 恒在 [0,1)", () => {
    const rng = createTownRng("seed-range");
    for (let i = 0; i < 200; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("nextInt(10) 恒为 [0,10) 内整数", () => {
    const rng = createTownRng("seed-int");
    for (let i = 0; i < 200; i += 1) {
      const value = rng.nextInt(10);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });

  it("pick 只返回列表内元素且同 seed 同结果", () => {
    const items = ["a", "b", "c", "d"] as const;
    const first = createTownRng("seed-pick");
    const second = createTownRng("seed-pick");
    for (let i = 0; i < 50; i += 1) {
      const picked = first.pick(items);
      expect(items).toContain(picked);
      expect(second.pick(items)).toBe(picked);
    }
  });

  it("shuffle 不修改原数组、是原数组的排列且同 seed 同结果", () => {
    const original = [1, 2, 3, 4, 5, 6, 7, 8];
    const frozenCopy = [...original];
    const shuffledA = createTownRng("seed-shuffle").shuffle(original);
    const shuffledB = createTownRng("seed-shuffle").shuffle(original);
    expect(original).toEqual(frozenCopy);
    expect(shuffledA).toEqual(shuffledB);
    expect([...shuffledA].sort((a, b) => a - b)).toEqual(frozenCopy);
  });
});

describe("hashTownSeed", () => {
  it("产出 16 位十六进制串且确定", () => {
    const hash = hashTownSeed("seed-a");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hashTownSeed("seed-a")).toBe(hash);
  });

  it("不同 seed 产出不同哈希", () => {
    expect(hashTownSeed("seed-a")).not.toBe(hashTownSeed("seed-b"));
  });
});
