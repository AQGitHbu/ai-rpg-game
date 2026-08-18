import { describe, expect, it } from "vitest";
import type { GameTypeId } from "@/game/domain/newGame";
import { actBeatFor } from "./deterministicEvolutionBeats";

const ALL_THEMES: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse",
];

describe("actBeatFor 题材剧本库", () => {
  it("wuxia acts 2-5 数据保持现状（回归锁）", () => {
    expect(actBeatFor("wuxia", 2).npcName).toBe("顾砚");
    expect(actBeatFor("wuxia", 2).investigationLabel).toBe("酒楼后巷的车轮印");
    expect(actBeatFor("wuxia", 3).npcName).toBe("苏绾");
    expect(actBeatFor("wuxia", 4).npcName).toBe("程砚秋");
    expect(actBeatFor("wuxia", 5).npcName).toBe("陆归鸿");
    expect(actBeatFor("wuxia", 5).newLocation?.name).toBe("黑水古道");
  });

  it("七个题材各自的第 2 幕使用本题材人物与地点", () => {
    const expected: Record<GameTypeId, string> = {
      wuxia: "顾砚",
      xianxia: "青芜",
      fantasy: "莉娜",
      science_fiction: "伊芙",
      urban: "陈默",
      alternate_history: "沈时叙",
      post_apocalypse: "阿蜡",
    };
    for (const theme of ALL_THEMES) {
      expect(actBeatFor(theme, 2).npcName).toBe(expected[theme]);
    }
  });

  it("每个题材 acts 2-5 人物链连续且字段完整", () => {
    for (const theme of ALL_THEMES) {
      for (let act = 2; act <= 5; act += 1) {
        const beat = actBeatFor(theme, act);
        expect(beat.npcName.length).toBeGreaterThan(0);
        expect(beat.npcRole.length).toBeGreaterThan(0);
        expect(beat.npcDescription.length).toBeGreaterThan(0);
        expect(beat.npcGoal.length).toBeGreaterThan(0);
        expect(beat.itemName.length).toBeGreaterThan(0);
        expect(beat.itemDescription.length).toBeGreaterThan(0);
        expect(beat.enemyName.length).toBeGreaterThan(0);
        expect(beat.questName.length).toBeGreaterThan(0);
        expect(beat.questDescription.length).toBeGreaterThan(0);
        expect(beat.factText.length).toBeGreaterThan(0);
      }
    }
  });

  it("超出库范围的幕回落到通用模板，且同参数结果稳定", () => {
    expect(actBeatFor("wuxia", 6).npcName).toBe("传讯人·6");
    expect(actBeatFor("fantasy", 9).npcName).toBe("传讯人·9");
    // 同参数两次独立调用深比较一致（确定性回归锁）
    const first = actBeatFor("urban", 4);
    const second = actBeatFor("urban", 4);
    expect(first).toEqual(second);
    // 通用模板按幕次区分人物名，不同幕不串数据
    expect(actBeatFor("urban", 4).npcName).not.toBe(actBeatFor("urban", 5).npcName);
  });
});
