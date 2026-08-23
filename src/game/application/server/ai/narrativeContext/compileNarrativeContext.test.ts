import { describe, expect, it } from "vitest";
import type { NarrativeContextBlock } from "./contextBlock";
import { compileNarrativeContext } from "./compileNarrativeContext";
import { estimateNarrativeTokens } from "./estimateNarrativeTokens";

function block(
  overrides: { readonly id: string } & Partial<Omit<NarrativeContextBlock, "id">>,
): NarrativeContextBlock {
  return {
    id: overrides.id,
    slot: overrides.slot ?? "recent_scenes",
    title: overrides.title ?? overrides.id,
    content: overrides.content ?? "测试正文",
    authority: overrides.authority ?? "memory",
    retention: overrides.retention ?? "optional",
    priority: overrides.priority ?? 0,
    ...(overrides.conflictKey === undefined ? {} : { conflictKey: overrides.conflictKey }),
    source: overrides.source ?? { kind: "test", refs: [] },
  };
}

describe("compileNarrativeContext", () => {
  it("同一 conflictKey 由较高 authority 胜出，当前 state 覆盖旧 memory", () => {
    const result = compileNarrativeContext({
      maxEstimatedTokens: 200,
      blocks: [
        block({ id: "old-location", authority: "memory", conflictKey: "npc:1:location", content: "旧地点" }),
        block({ id: "current-location", authority: "state", conflictKey: "npc:1:location", content: "当前地点" }),
      ],
    });
    expect(result.selected.map((entry) => entry.id)).toEqual(["current-location"]);
    expect(result.dropped).toContainEqual(expect.objectContaining({ id: "old-location", reason: "conflict" }));
  });

  it("同 authority 的冲突优先保留 mandatory", () => {
    const result = compileNarrativeContext({
      maxEstimatedTokens: 200,
      blocks: [
        block({ id: "optional", authority: "state", retention: "optional", priority: 100, conflictKey: "current:goal" }),
        block({ id: "mandatory", authority: "state", retention: "mandatory", priority: 1, conflictKey: "current:goal" }),
      ],
    });
    expect(result.selected.map((entry) => entry.id)).toEqual(["mandatory"]);
  });

  it("mandatory 超出预算仍保留并报告 overflow", () => {
    const result = compileNarrativeContext({
      maxEstimatedTokens: 1,
      blocks: [block({ id: "rules", retention: "mandatory", authority: "rule", content: "不可改写已结算结果" })],
    });
    expect(result.selected.map((entry) => entry.id)).toEqual(["rules"]);
    expect(result.overflowEstimatedTokens).toBeGreaterThan(0);
  });

  it("optional 预算不足时保留高优先级并给低优先级 budget 原因", () => {
    const high = block({ id: "high", priority: 100, content: "甲".repeat(20) });
    const low = block({ id: "low", priority: 10, content: "乙".repeat(20) });
    const highOnly = compileNarrativeContext({ maxEstimatedTokens: 1_000, blocks: [high] });
    const result = compileNarrativeContext({
      maxEstimatedTokens: highOnly.selectedEstimatedTokens,
      blocks: [low, high],
    });
    expect(result.selected.map((entry) => entry.id)).toEqual(["high"]);
    expect(result.dropped).toContainEqual(expect.objectContaining({ id: "low", reason: "budget" }));
  });

  it("输入倒序不会改变 selected 的渲染顺序和 manifest", () => {
    const blocks = [
      block({ id: "state", slot: "current_state", authority: "state", priority: 50 }),
      block({ id: "rules", slot: "system_rules", authority: "rule", retention: "mandatory", priority: 100 }),
    ];
    expect(compileNarrativeContext({ maxEstimatedTokens: 200, blocks }))
      .toEqual(compileNarrativeContext({ maxEstimatedTokens: 200, blocks: [...blocks].reverse() }));
  });

  it("相同 id 即使正文不同也使用二进制稳定键选择，不依赖输入顺序", () => {
    const a = block({ id: "same", title: "同名", content: "甲正文" });
    const b = block({ id: "same", title: "同名", content: "乙正文" });
    const forward = compileNarrativeContext({ maxEstimatedTokens: 200, blocks: [b, a] });
    const reverse = compileNarrativeContext({ maxEstimatedTokens: 200, blocks: [a, b] });
    expect(forward).toEqual(reverse);
    expect(forward.selected[0]?.content).toBe("甲正文");
    expect(forward.dropped).toContainEqual(expect.objectContaining({ id: "same", reason: "duplicate" }));
  });

  it("空正文以 empty 原因丢弃", () => {
    const result = compileNarrativeContext({
      maxEstimatedTokens: 200,
      blocks: [block({ id: "empty", content: "  \n " })],
    });
    expect(result.selected).toEqual([]);
    expect(result.dropped).toEqual([expect.objectContaining({ id: "empty", reason: "empty" })]);
  });

  it("manifest 只有元数据，不出现 block content", () => {
    const result = compileNarrativeContext({
      maxEstimatedTokens: 200,
      blocks: [block({ id: "secret", content: "私密正文" })],
    });
    expect(JSON.stringify(result.manifest)).not.toContain("私密正文");
  });

  it("非法预算抛 RangeError", () => {
    for (const maxEstimatedTokens of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => compileNarrativeContext({ maxEstimatedTokens, blocks: [] })).toThrow(RangeError);
    }
  });

  it("token 估算区分 ASCII 与非 ASCII code point", () => {
    expect(estimateNarrativeTokens("abcd")).toBe(1);
    expect(estimateNarrativeTokens("中A")).toBe(2);
  });
});
