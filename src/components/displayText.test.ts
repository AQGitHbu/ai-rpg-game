import { describe, expect, it } from "vitest";
import { normalizeDisplayText, removeCoveredClauses } from "./displayText";

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

describe("removeCoveredClauses", () => {
  it("剔除旁注已经复述过的氛围小句，保留描述里的其余信息", () => {
    const narration = "夜色如墨，窗外风声呜咽，远处矿洞方向隐约传来铁器碰撞的声响，仿佛正酝酿着一场风暴。";
    const description = "位于后山密林中的一间废弃猎户小屋，木墙斑驳，窗外风声呜咽，远处隐约传来矿洞方向的动静，此处虽简陋，却是眼下最安全的藏身之处。";
    expect(removeCoveredClauses(description, narration)).toBe(
      "位于后山密林中的一间废弃猎户小屋，木墙斑驳，此处虽简陋，却是眼下最安全的藏身之处。",
    );
  });

  it("无重复或参考文本为空时原样返回", () => {
    expect(removeCoveredClauses("一间客栈，柜后有人打着盹。", "车轮印断续向北延伸。"))
      .toBe("一间客栈，柜后有人打着盹。");
    expect(removeCoveredClauses("一间客栈。", "")).toBe("一间客栈。");
  });

  it("整段都被旁注覆盖时返回空串，由调用方隐藏描述", () => {
    expect(removeCoveredClauses(
      "窗外风声呜咽，远处矿洞方向隐约传来声响。",
      "窗外风声呜咽，远处矿洞方向隐约传来铁器碰撞的声响。",
    )).toBe("");
  });

  it("剔除末尾小句后收敛成完整句子，不留悬空逗号", () => {
    expect(removeCoveredClauses("一间客栈，木墙斑驳，窗外风声呜咽。", "窗外风声呜咽，夜色如墨。"))
      .toBe("一间客栈，木墙斑驳。");
  });
});
