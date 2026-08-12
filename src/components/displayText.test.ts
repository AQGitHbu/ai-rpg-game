import { describe, expect, it } from "vitest";
import { normalizeDisplayText } from "./displayText";

describe("normalizeDisplayText", () => {
  it.each([
    ["卷起。。", "卷起。"],
    ["真的！！", "真的！"],
    ["为什么？？", "为什么？"],
    ["省略……仍然保留", "省略……仍然保留"],
    ["普通文本。", "普通文本。"],
  ])("normalizes duplicated sentence punctuation: %s", (input, expected) => {
    expect(normalizeDisplayText(input)).toBe(expected);
  });
});
