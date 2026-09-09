import { describe, expect, it } from "vitest";
import { compileNarrativeContext } from "./compileNarrativeContext";
import { NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS } from "./narrativeBundleContext";

describe("opening handoff context budget", () => {
  it("retains mandatory causal refs while dropping oversized optional prose within 8,000 tokens", () => {
    const result = compileNarrativeContext({
      maxEstimatedTokens: NARRATIVE_BUNDLE_CONTEXT_MAX_ESTIMATED_TOKENS,
      blocks: [
        { id: "bundle:opening-handoff", slot: "relevant_events", title: "开局背景与本次回应", content: "公开因果", authority: "event", retention: "mandatory", priority: 985, source: { kind: "committed_event", refs: ["init:g:history", "init:g:thread"] } },
        { id: "oversized-optional", slot: "recent_scenes", title: "超大可选正文", content: "冗".repeat(20_000), authority: "memory", retention: "optional", priority: 1, source: { kind: "test", refs: [] } },
      ],
    });
    expect(result.selectedEstimatedTokens).toBeLessThanOrEqual(8_000);
    expect(result.selected.find((block) => block.id === "bundle:opening-handoff")?.source.refs).toEqual(["init:g:history", "init:g:thread"]);
    expect(result.dropped).toContainEqual(expect.objectContaining({ id: "oversized-optional", reason: "budget" }));
  });
});
