import { describe, expect, it } from "vitest";
import { applyPolish } from "./draftPolish";
import type { UnitOutput } from "./narrativeUnit";

describe("immutable draft polish", () => {
  const draft: UnitOutput = { stage: "narration", parts: [{ text: "消息尚未证实。", facts: [{ factId: "fact_0", certainty: "suspected" }], evidence: [], beatIds: ["atmosphere"] }], actionKeys: [] };
  it("keeps original reference metadata and accepts unchanged text", () => {
    expect(applyPolish(draft, { texts: ["消息尚未证实。"] })).toEqual({ ok: true, value: draft });
    const result = applyPolish(draft, { texts: ["这消息还没有证实。"] });
    expect(result.ok && result.value.stage === "narration" && result.value.parts[0]?.facts).toEqual(draft.parts[0]?.facts);
  });
  it("rejects metadata, count changes, and overlong text", () => {
    for (const payload of [{ texts: [], facts: [] }, { texts: [] }, { texts: ["字".repeat(501)] }])
      expect(applyPolish(draft, payload).ok).toBe(false);
  });
  it("requires candidate identity and order, including terminal labels", () => {
    const choices: UnitOutput = { stage: "choices", labels: [{ candidateId: "trust", label: "我相信你。" }, { candidateId: "doubt", label: "我还有疑问。" }] };
    expect(applyPolish(choices, { labels: choices.labels }).ok).toBe(true);
    expect(applyPolish(choices, { labels: [...choices.labels].reverse() }).ok).toBe(false);
    expect(applyPolish(choices, { labels: choices.labels.map(label => ({ ...label, label: "字".repeat(81) })) }).ok).toBe(false);
  });
});
