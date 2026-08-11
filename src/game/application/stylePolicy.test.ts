import { describe, it, expect } from "vitest";
import {
  buildStylePolicy,
  buildNarrationInstruction,
  buildIntensityInstruction,
  PERSONALITY_TRAIT_OPTIONS,
} from "./stylePolicy";

describe("StylePolicy（Task 8 呈现政策）", () => {
  it("暴露表单使用的六个性格标签", () => {
    expect(PERSONALITY_TRAIT_OPTIONS).toEqual(["冷静", "冲动", "善良", "多疑", "幽默", "寡言"]);
  });

  it("无开局配置时得到默认政策：无标签 / concise / normal", () => {
    expect(buildStylePolicy()).toEqual({
      protagonistTraits: [],
      narration: "concise",
      intensity: "normal",
      narrationInstruction: expect.stringContaining("简洁"),
      intensityInstruction: expect.stringContaining("含蓄"),
    });
  });

  it("把开局配置映射为政策字段（标签/叙事风格/内容强度逐项透传）", () => {
    const policy = buildStylePolicy({
      personalityTags: ["冷静", "多疑"],
      narrativeStyle: "cinematic",
      contentIntensity: "dark",
    });
    expect(policy.protagonistTraits).toEqual(["冷静", "多疑"]);
    expect(policy.narration).toBe("cinematic");
    expect(policy.intensity).toBe("dark");
    expect(policy.narrationInstruction).toContain("电影");
    expect(policy.intensityInstruction).toContain("暗色意象");
  });

  it("narrationInstruction 只描述呈现：叙事风格 + 主角刻画 + 建议选项措辞", () => {
    const instruction = buildNarrationInstruction(["冷静", "多疑"], "cinematic");
    expect(instruction).toContain("冷静");
    expect(instruction).toContain("多疑");
    expect(instruction).toContain("建议选项");
    // 绝不携带规则数值指令
    expect(instruction).not.toMatch(/奖励|伤害|成功率|金钱/);
  });

  it("dark 强度允许道德上艰难的结果与克制的暗色意象", () => {
    const instruction = buildIntensityInstruction("dark");
    expect(instruction).toContain("道德上艰难的结果");
    expect(instruction).toContain("克制的暗色意象");
  });

  it("normal 强度避免血腥等具体细节", () => {
    const instruction = buildIntensityInstruction("normal");
    expect(instruction).toContain("避免");
    expect(instruction).toContain("血腥");
  });

  it("呈现专用：政策只含呈现字段，不含 stats/规则行动/奖励/预算", () => {
    const dark = buildStylePolicy({ personalityTags: ["多疑"], narrativeStyle: "cinematic", contentIntensity: "dark" });
    const normal = buildStylePolicy({ personalityTags: ["善良"], narrativeStyle: "novel", contentIntensity: "normal" });
    for (const policy of [dark, normal]) {
      expect(Object.keys(policy).sort()).toEqual([
        "intensity", "intensityInstruction", "narration", "narrationInstruction", "protagonistTraits",
      ]);
    }
    const serialized = JSON.stringify({ dark, normal });
    expect(serialized).not.toMatch(/"stats"|"attack"|"hp"|"rewards"|"budget"|"action"/);
  });

  it("不同标签集合产出不同的呈现指令（同一叙事风格基线）", () => {
    const calm = buildNarrationInstruction(["冷静"], "novel");
    const impulsive = buildNarrationInstruction(["冲动"], "novel");
    expect(calm).not.toBe(impulsive);
    expect(calm).toContain("冷静");
    expect(impulsive).toContain("冲动");
  });
});