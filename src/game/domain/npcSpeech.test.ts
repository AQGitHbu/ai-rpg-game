import { describe, expect, it } from "vitest";
import {
  composeDirectNpcGreeting,
  composeIdleNpcLine,
  isGenericNpcAcknowledgement,
  isGenericNpcGreeting,
  isGenericNpcInquiry,
  normalizeNpcSpeech,
} from "./npcSpeech";

describe("NPC direct speech", () => {
  it("removes a named speaker and descriptive speech wrapper", () => {
    expect(normalizeNpcSpeech('邵叔如实答道："我知道了。"', "邵叔")).toBe("我知道了。");
    expect(normalizeNpcSpeech("邵叔低声说道：“这件事我会查清楚。”", "邵叔")).toBe("这件事我会查清楚。");
    expect(normalizeNpcSpeech("邵叔如实答道：我知道了。", "邵叔")).toBe("我知道了。");
    expect(normalizeNpcSpeech("邵叔如实答道，我知道了。", "邵叔")).toBe("我知道了。");
  });

  it("keeps direct speech and normal colon content intact", () => {
    expect(normalizeNpcSpeech("“你问得正是时候。”", "邵叔")).toBe("你问得正是时候。");
    expect(normalizeNpcSpeech("韩征点了点头：「有什么事直接找我。」", "韩征")).toBe("有什么事直接找我。");
    expect(normalizeNpcSpeech("关于商队失踪的事：我还不能确定。", "邵叔")).toBe("关于商队失踪的事：我还不能确定。");
    expect(normalizeNpcSpeech("邵叔看了你一眼，继续巡视。", "邵叔")).toBe("");
  });

  it("repairs adjacent smart quotes between two AI-generated sentences", () => {
    expect(normalizeNpcSpeech("你给的腰牌，是镖队的东西。”“镖队不是遇袭失散。"))
      .toBe("你给的腰牌，是镖队的东西。镖队不是遇袭失散。");
  });

  it("strips a leading stage direction and a whole-line single curly quote wrapper", () => {
    expect(normalizeNpcSpeech(
      "（哑巴猎户用炭笔在树皮上写下几个字，推到你面前）‘铁旗会总舵，铁面人。这铜牌，是我从火场里捡回来的。’",
      "哑巴猎户",
    )).toBe("铁旗会总舵，铁面人。这铜牌，是我从火场里捡回来的。");
    expect(normalizeNpcSpeech("（摇了摇头）这件事我不能说。", "邵叔")).toBe("这件事我不能说。");
    // 句中的单弯引号是引用，不是整段包装。
    expect(normalizeNpcSpeech("他说过‘小心’，可我没能及时躲开。", "邵叔"))
      .toBe("他说过‘小心’，可我没能及时躲开。");
    // 只剩舞台说明时不产出台词正文。
    expect(normalizeNpcSpeech("（他转身离去）", "邵叔")).toBe("（他转身离去）");
  });

  it("分页留下的单侧弯引号也不残留在气泡里", () => {
    // 真机台词被按句号拆成两页后，整段 ‘…’ 包装会各自剩下一侧。
    expect(normalizeNpcSpeech("（哑巴猎户用炭笔在树皮上写下几个字，推到你面前）‘铁旗会总舵，铁面人。", "哑巴猎户"))
      .toBe("铁旗会总舵，铁面人。");
    expect(normalizeNpcSpeech("当年长风镖局押送的官银，就是被他调包的。你……要小心。’", "哑巴猎户"))
      .toBe("当年长风镖局押送的官银，就是被他调包的。你……要小心。");
    // 成对的句内引用不受影响。
    expect(normalizeNpcSpeech("我只听人提过 ‘铁旗会’ 这个名字。", "哑巴猎户"))
      .toBe("我只听人提过 ‘铁旗会’ 这个名字。");
  });

  it("recognizes context-free acknowledgements", () => {
    expect(isGenericNpcAcknowledgement('"我知道了。"')).toBe(true);
    expect(isGenericNpcAcknowledgement("关于商队失踪的事，我先说我确定的部分。")).toBe(false);
  });

  it("recognizes the context-free AI greeting that must not mask a story NPC", () => {
    expect(isGenericNpcGreeting("你是来打听事情的吧？想知道什么，直接问我。")).toBe(true);
    expect(isGenericNpcGreeting("这份旧案牵连太深；你若真要查下去，我可以先交出我保管的那一页。")).toBe(false);
  });

  it("provides a direct greeting without a speaker description", () => {
    expect(composeDirectNpcGreeting()).toBe("先进来坐。有什么需要我帮忙的，慢慢说清楚。");
    expect(normalizeNpcSpeech("先进来坐。有什么需要我帮忙的，慢慢说清楚。")).toBe("先进来坐。有什么需要我帮忙的，慢慢说清楚。");
  });

  it("uses a context-free safe fallback instead of inventing facts from role/name", () => {
    const greetings = [
      composeDirectNpcGreeting("失踪镖队幸存者", "苏绾"),
      composeDirectNpcGreeting("旧案传讯人", "顾砚"),
      composeDirectNpcGreeting("旧案知情人", "陆归鸿"),
      composeDirectNpcGreeting("酒肆老板娘", "何二娘"),
      composeDirectNpcGreeting("镇口更夫", "老白"),
    ];
    expect(new Set(greetings).size).toBe(1);
    expect(greetings[0]).toContain("只回答亲眼见过或已经核对的部分");
    expect(greetings.join(" ")).not.toMatch(/盟誓铁印|无灯马车|告示|松脂|车辙/u);
  });

  it("rejects empty inquiry templates that make distinct NPCs sound identical", () => {
    expect(isGenericNpcInquiry("关于旧案，我先说我确定的部分。你还想从哪一段继续追问？")).toBe(true);
    expect(isGenericNpcInquiry("无灯马车从北巷出镇，车轮印还留在酒楼后巷。去那里核对左手血布。")).toBe(false);
  });
});

describe("composeIdleNpcLine", () => {
  it("有交互历史的 NPC 生成承接当前权威目标的提醒台词", () => {
    const line = composeIdleNpcLine({
      currentObjectiveLabel: "调查酒楼后巷的车轮印",
      hasInteractionHistory: true,
      variantIndex: 0,
    });
    expect(line).toContain("调查酒楼后巷的车轮印");
    // 直接对白正文：无叙述包装、无引号残留
    expect(normalizeNpcSpeech(line)).toBe(line);
  });

  it("无交互历史的 NPC 使用不泄露主线内容的中性闲聊", () => {
    for (let variantIndex = 0; variantIndex < 6; variantIndex += 1) {
      const line = composeIdleNpcLine({
        currentObjectiveLabel: "调查酒楼后巷的车轮印",
        hasInteractionHistory: false,
        variantIndex,
      });
      expect(line).not.toContain("车轮印");
      expect(line).not.toContain("调查");
    }
  });

  it("同 variantIndex 稳定，变体索引覆盖全部模板", () => {
    const a = composeIdleNpcLine({ currentObjectiveLabel: null, hasInteractionHistory: true, variantIndex: 4 });
    const b = composeIdleNpcLine({ currentObjectiveLabel: null, hasInteractionHistory: true, variantIndex: 4 });
    expect(a).toBe(b);
    // objective 为 null 时即使有交互历史也落入中性闲聊（无目标可提醒）
    const seen = new Set(
      [0, 1, 2].map((i) => composeIdleNpcLine({ currentObjectiveLabel: null, hasInteractionHistory: false, variantIndex: i })),
    );
    expect(seen.size).toBe(3);
  });
});
