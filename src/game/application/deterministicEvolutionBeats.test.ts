import { describe, expect, it } from "vitest";
import type { GameTypeId } from "@/game/domain/newGame";
import { actBeatFor } from "./deterministicEvolutionBeats";

const ALL_THEMES: readonly GameTypeId[] = [
  "wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse",
];

describe("actBeatFor 题材剧本库", () => {
  // wuxia acts 2-5 的数据从 deterministicEvolutionSource 逐字迁移（计划硬约束），
  // 以下 golden 为迁移前原文的字面量（act 2 的 investigationLabel 为迁移时新增、
  // 等价承载旧 planNextAct 中 act===2 三元式的"酒楼后巷的车轮印"）：
  // 任何字段漂移都会在此立即暴露。
  it("wuxia acts 2-5 数据逐字保持现状（全量 golden 回归锁）", () => {
    expect(actBeatFor("wuxia", 2)).toEqual({
      npcName: "顾砚",
      npcRole: "旧案传讯人",
      npcDescription: "韩七托他把镇外脚印的密信交给沈青崖，他一路避开追兵才赶到酒楼。",
      npcGoal: "把韩七交代的密信送达",
      itemName: "染血腰牌",
      itemDescription: "顾砚交出的旧腰牌，血迹旁刻着与缉凶告示相同的暗纹。",
      enemyName: "黑衣追兵",
      questName: "追查镇外脚印",
      questDescription: "沿着韩七看见的脚印，核对顾砚带来的密信与腰牌。",
      factText: "车轮印在后巷泥水中断续向北延伸，指向北巷旧道深处的旧镖局废墟；腰牌上的暗纹与缉凶告示源自同一旧案。",
      investigationLabel: "酒楼后巷的车轮印",
      newLocation: {
        name: "北巷旧道",
        description: "酒楼后巷通往旧镖局的石道潮湿狭窄，车轮印在泥水里断续延伸。",
      },
    });
    expect(actBeatFor("wuxia", 3)).toEqual({
      npcName: "苏绾",
      npcRole: "失踪镖队幸存者",
      npcDescription: "她认出了染血腰牌，昨夜从断碑谷逃出后又折返回谷口，知道黑衣追兵为何盯上这桩旧案。",
      npcGoal: "说出断碑谷里被掩埋的真相",
      itemName: "断裂镖旗",
      itemDescription: "从苏绾手里接过的半面镖旗，旗角还沾着断碑谷的黑泥。",
      enemyName: "夺旗客",
      questName: "追问断碑谷",
      questDescription: "前往断碑谷找到苏绾，核对她带出的失踪镖队证词。",
      factText: "失踪镖队并非遇袭失散，押运的卷宗曾被人带进断碑谷。",
      newLocation: {
        name: "断碑谷",
        description: "荒碑夹着一线山谷，黑泥里留有被拖拽过的车辙。",
      },
    });
    expect(actBeatFor("wuxia", 4)).toEqual({
      npcName: "程砚秋",
      npcRole: "旧案卷宗保管人",
      npcDescription: "他沿着断碑谷留下的车辙追到谷口，手里藏着能证明幕后主使的残卷。",
      npcGoal: "交出能指向幕后主使的残卷",
      itemName: "残缺卷宗",
      itemDescription: "被撕去关键页的卷宗，剩下的印记仍能与缉凶告示互相印证。",
      enemyName: "灭口刺客",
      questName: "拼回旧案卷宗",
      questDescription: "保护程砚秋并拼回残卷，确认这场追杀真正要掩盖的名字。",
      factText: "卷宗缺失的最后一页，记录着旧案主使曾在青石镇落脚。",
    });
    expect(actBeatFor("wuxia", 5)).toEqual({
      npcName: "陆归鸿",
      npcRole: "旧案知情人",
      npcDescription: "他带着最后一页卷宗在黑水古道现身，承认自己曾替幕后主使传递命令，如今决定说出真相。",
      npcGoal: "在沈青崖面前说出幕后主使的身份",
      itemName: "盟誓铁印",
      itemDescription: "卷宗最后一页上的铁印，能让旧案的责任在终幕前落到实处。",
      enemyName: "迷雾首领",
      questName: "揭开青石旧案",
      questDescription: "前往黑水古道找到陆归鸿，确认幕后主使并面对最后的阻拦。",
      factText: "最后一页卷宗确认：青石镇的缉凶告示是为了掩盖一场灭口，而旧案主使的藏身处，就在黑水古道尽头。",
      newLocation: {
        name: "黑水古道",
        description: "通往旧案主使藏身处的古道，雾气从碎石缝里不断涌出。",
      },
    });
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

  // 第 2 幕的 factText 必须同时交代“调查发现了什么”（investigationLabel 的核心意象）
  // 与“指向哪里”（newLocation.name），否则调查场景的兜底叙事缺了动线因果。
  it("第 2 幕 factText 同时包含线索核心意象与指向的新地点", () => {
    const labelCore: Record<GameTypeId, string> = {
      wuxia: "车轮印",
      xianxia: "雾中足迹",
      fantasy: "凿痕",
      science_fiction: "抓痕",
      urban: "撬痕",
      alternate_history: "刮痕",
      post_apocalypse: "车辙",
    };
    for (const theme of ALL_THEMES) {
      const beat = actBeatFor(theme, 2);
      // 前置自证：labelCore 片段确为 investigationLabel 的可辨识部分。
      expect(beat.investigationLabel).toBeDefined();
      expect(beat.investigationLabel).toContain(labelCore[theme]);
      expect(beat.newLocation).toBeDefined();
      expect(beat.factText).toContain(labelCore[theme]);
      expect(beat.factText).toContain(beat.newLocation!.name);
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
