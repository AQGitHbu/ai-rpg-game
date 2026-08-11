// town 模块自持的确定性随机源：FNV-1a 字符串哈希 + mulberry32 PRNG。
// 实现复制自 createFallbackBlueprint.ts 内的私有函数（按 plan 要求不 import
// 该文件，避免波及其钉值 fixture）；全程无 Math.random / Date / IO。

/** FNV-1a 32 位；以 UTF-16 code unit 遍历，中英文均产生稳定散列。 */
function fnv1a(text: string, offsetBasis: number): number {
  let hash = offsetBasis >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32：由数值种子产出 [0,1) 均匀序列，确定且可复现。 */
function mulberry32(seedNumber: number): () => number {
  let state = seedNumber >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 小镇生成专用随机源：全部方法共享同一确定性序列。 */
export type TownRng = {
  /** [0,1) 均匀分布。 */
  next(): number;
  /** [0, maxExclusive) 整数。 */
  nextInt(maxExclusive: number): number;
  /** 从非空列表等概率取一项。 */
  pick<T>(items: readonly T[]): T;
  /** 确定性 Fisher-Yates；返回新数组，不修改入参。 */
  shuffle<T>(items: readonly T[]): T[];
};

export function createTownRng(seed: string): TownRng {
  const next = mulberry32(fnv1a(seed, 0x811c9dc5));
  const nextInt = (maxExclusive: number): number => Math.floor(next() * maxExclusive);
  return {
    next,
    nextInt,
    pick: (items) => items[nextInt(items.length)],
    shuffle: (items) => {
      const result = [...items];
      for (let i = result.length - 1; i > 0; i -= 1) {
        const j = nextInt(i + 1);
        [result[i], result[j]] = [result[j], result[i]];
      }
      return result;
    }
  };
}

/** 拼接两路不同 basis 的 FNV-1a 得 16 位 hex：重试时派生 seed 变体用。 */
export function hashTownSeed(seed: string): string {
  const a = fnv1a(seed, 0x811c9dc5);
  const b = fnv1a(`${seed}\u0001salt`, (0x811c9dc5 ^ 0x9e3779b9) >>> 0);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}
