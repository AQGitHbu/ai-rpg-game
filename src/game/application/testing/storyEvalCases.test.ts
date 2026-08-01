// ---------------------------------------------------------------------------
// storyEvalCases.test.ts：v2 评测集契约（Task 13 Step 1）。
// 断言：恰 6 个唯一 caseId、三种题材各 2 个、全部 gameLength=long、
// 输入全部通过 domain 校验、固定角色/人格/文风/强度跨 case 一致、
// 同题材两 case 前提与开端不同、resolveStoryEvalCase 三态语义。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { validateNewGameInput } from "@/game/domain";
import { loadStoryEvalCases, resolveStoryEvalCase } from "./storyEvalCases";

const FIXED_FIELDS = {
  characterName: "沈孤鸿",
  characterIdentity: "身世成谜的独行者",
  personalityTags: ["重义", "谨慎", "好奇"],
  narrativeStyle: "concise",
  contentIntensity: "normal",
} as const;

describe("story eval case set (v2)", () => {
  it("恰有 6 个唯一 caseId", () => {
    const cases = loadStoryEvalCases();
    expect(cases).toHaveLength(6);
    expect(new Set(cases.map((item) => item.caseId)).size).toBe(6);
  });

  it("三种题材（wuxia/science_fiction/urban）各 2 个 case", () => {
    const cases = loadStoryEvalCases();
    for (const gameType of ["wuxia", "science_fiction", "urban"]) {
      expect(cases.filter((item) => item.input.gameType === gameType), gameType).toHaveLength(2);
    }
  });

  it("全部 gameLength 为 long 且输入通过 validateNewGameInput", () => {
    for (const item of loadStoryEvalCases()) {
      expect(item.input.gameLength, item.caseId).toBe("long");
      const result = validateNewGameInput(item.input);
      expect(result.ok, `case=${item.caseId} 校验失败`).toBe(true);
    }
  });

  it("固定角色/人格/narrativeStyle/contentIntensity 跨 case 一致", () => {
    const cases = loadStoryEvalCases();
    for (const item of cases) {
      expect(item.input.characterName).toBe(FIXED_FIELDS.characterName);
      expect(item.input.characterIdentity).toBe(FIXED_FIELDS.characterIdentity);
      expect(item.input.personalityTags).toEqual(FIXED_FIELDS.personalityTags);
      expect(item.input.narrativeStyle).toBe(FIXED_FIELDS.narrativeStyle);
      expect(item.input.contentIntensity).toBe(FIXED_FIELDS.contentIntensity);
    }
  });

  it("同一题材的两个 case 使用不同的 worldPremise/storyOpening", () => {
    const cases = loadStoryEvalCases();
    for (const gameType of ["wuxia", "science_fiction", "urban"]) {
      const pair = cases.filter((item) => item.input.gameType === gameType);
      expect(pair).toHaveLength(2);
      expect(pair[0].input.worldPremise, `${gameType} premise`).not.toBe(pair[1].input.worldPremise);
      expect(pair[0].input.storyOpening, `${gameType} opening`).not.toBe(pair[1].input.storyOpening);
    }
  });

  it("resolveStoryEvalCase：缺省 undefined、已知 case 返回对象、未知返回 null", () => {
    expect(resolveStoryEvalCase(undefined)).toBeUndefined();
    const found = resolveStoryEvalCase("wuxia-a");
    expect(found).not.toBeNull();
    expect(found?.caseId).toBe("wuxia-a");
    expect(resolveStoryEvalCase("does-not-exist")).toBeNull();
  });
});
