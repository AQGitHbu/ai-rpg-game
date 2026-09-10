import { describe, expect, it } from "vitest";
import {
  MAX_KEY_LENGTH,
  MAX_TEXT_PARTS,
  MAX_TEXT_PART_LENGTH,
  parseUnitOutput,
  type TextPart,
} from "./narrativeUnit";

function part(text: string): TextPart {
  return { text, facts: [], evidence: [], beatIds: [] };
}

const narration = (parts: readonly TextPart[]) => ({
  stage: "narration" as const,
  parts,
  actionKeys: [] as readonly string[],
});

const character = (overrides: Record<string, unknown> = {}) => ({
  stage: "character" as const,
  speakerId: "npc_0",
  parts: [part("先坐吧。")],
  emotion: "neutral",
  actions: [] as readonly unknown[],
  answeredBeatIds: [] as readonly string[],
  ...overrides,
});

describe("parseUnitOutput", () => {
  it("accepts a narration output within the segment cap", () => {
    const result = parseUnitOutput(narration([part("风吹过空荡的街道。")]));
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate candidate ids in a choices output", () => {
    expect(
      parseUnitOutput({
        stage: "choices",
        labels: [
          { candidateId: "a", label: "我愿意帮你。" },
          { candidateId: "a", label: "我不答应。" },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects the planning stage as an expression output", () => {
    expect(parseUnitOutput({ stage: "planning", parts: [] }).ok).toBe(false);
  });

  it("rejects an unknown stage", () => {
    expect(parseUnitOutput({ stage: "monologue", parts: [] }).ok).toBe(false);
  });

  it("rejects empty segment text", () => {
    expect(parseUnitOutput(narration([part("")])).ok).toBe(false);
  });

  it("rejects segment text beyond the length cap", () => {
    expect(parseUnitOutput(narration([part("长".repeat(MAX_TEXT_PART_LENGTH + 1))])).ok).toBe(false);
  });

  it("accepts segment text exactly at the length cap", () => {
    expect(parseUnitOutput(narration([part("长".repeat(MAX_TEXT_PART_LENGTH))])).ok).toBe(true);
  });

  it("rejects more segments than the cap", () => {
    const parts = Array.from({ length: MAX_TEXT_PARTS + 1 }, (_, index) => part(`第${index}句。`));
    expect(parseUnitOutput(narration(parts)).ok).toBe(false);
  });

  it("rejects an unknown emotion enum value", () => {
    expect(parseUnitOutput(character({ emotion: "furious" })).ok).toBe(false);
  });

  it("rejects a character output without a speaker", () => {
    expect(parseUnitOutput(character({ speakerId: "" })).ok).toBe(false);
  });

  it("rejects a character output that carries narration-only fields", () => {
    expect(parseUnitOutput(character({ actionKeys: [] })).ok).toBe(false);
  });

  it("rejects a choices output that is not exactly two labels", () => {
    expect(
      parseUnitOutput({ stage: "choices", labels: [{ candidateId: "a", label: "我愿意帮你。" }] }).ok,
    ).toBe(false);
  });

  it("rejects a label beyond the length cap", () => {
    expect(
      parseUnitOutput({
        stage: "choices",
        labels: [
          { candidateId: "a", label: "话".repeat(81) },
          { candidateId: "b", label: "我不答应。" },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects an empty label", () => {
    expect(
      parseUnitOutput({
        stage: "choices",
        labels: [
          { candidateId: "a", label: "   " },
          { candidateId: "b", label: "我不答应。" },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects a fact certainty outside the known/suspected union", () => {
    const withBadFact = { text: "他说城门昨夜没关。", facts: [{ factId: "fact_0", certainty: "proven" }], evidence: [], beatIds: [] };
    expect(parseUnitOutput(narration([withBadFact as unknown as TextPart])).ok).toBe(false);
  });

  it("rejects an evidence ref with an unknown kind", () => {
    const withBadEvidence = {
      text: "他说城门昨夜没关。",
      facts: [],
      evidence: [{ kind: "rumor", id: "x" }],
      beatIds: [],
    };
    expect(parseUnitOutput(narration([withBadEvidence as unknown as TextPart])).ok).toBe(false);
  });

  it("rejects a unit key beyond the length cap", () => {
    expect(
      parseUnitOutput({
        stage: "narration",
        parts: [part("风吹过空荡的街道。")],
        actionKeys: ["k".repeat(MAX_KEY_LENGTH + 1)],
      }).ok,
    ).toBe(false);
  });
});
