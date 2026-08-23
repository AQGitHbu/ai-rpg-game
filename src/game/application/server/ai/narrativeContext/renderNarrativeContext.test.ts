import { describe, expect, it } from "vitest";
import type { NarrativeContextBlock } from "./contextBlock";
import { compileNarrativeContext } from "./compileNarrativeContext";
import { renderNarrativeContext } from "./renderNarrativeContext";

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

describe("renderNarrativeContext", () => {
  it("selected 为空时仍只有一个结尾换行", () => {
    const compiled = compileNarrativeContext({
      maxEstimatedTokens: 200,
      blocks: [block({ id: "empty", content: " \n " })],
    });
    const prompt = renderNarrativeContext(compiled);
    expect(compiled.selected).toEqual([]);
    expect(prompt).toBe("[NARRATIVE_CONTEXT v1]\n");
  });

  it("无论输入顺序如何都按 slot 顺序渲染，output_contract 最后", () => {
    const compiled = compileNarrativeContext({
      maxEstimatedTokens: 200,
      blocks: [
        block({ id: "output", slot: "output_contract", title: "输出契约", content: "只输出 JSON" }),
        block({ id: "rules", slot: "system_rules", title: "规则", content: "不可改写规则结果" }),
      ],
    });
    const prompt = renderNarrativeContext(compiled);
    expect(prompt.indexOf("## [system_rules] 规则")).toBeLessThan(prompt.indexOf("## [output_contract] 输出契约"));
  });

  it("只渲染 selected，不渲染 dropped 正文", () => {
    const compiled = compileNarrativeContext({
      maxEstimatedTokens: 20,
      blocks: [
        block({ id: "current", slot: "current_location", priority: 100, content: "当前地点" }),
        block({ id: "old", slot: "recent_scenes", priority: 1, content: "已丢弃的旧地点".repeat(20) }),
      ],
    });
    const prompt = renderNarrativeContext(compiled);
    expect(prompt).toContain("当前地点");
    expect(prompt).not.toContain("已丢弃的旧地点");
  });

  it("标题与正文使用固定格式且末尾只有一个换行", () => {
    const compiled = compileNarrativeContext({
      maxEstimatedTokens: 200,
      blocks: [block({ id: "rules", slot: "system_rules", title: "规则", content: "不可改写规则结果" })],
    });
    const prompt = renderNarrativeContext(compiled);
    expect(prompt).toBe("[NARRATIVE_CONTEXT v1]\n\n## [system_rules] 规则\n不可改写规则结果\n");
  });
});
