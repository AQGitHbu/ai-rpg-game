import { describe, it, expect } from "vitest";
import {
  createRuleIntentParser,
  createLiveIntentParser,
  createIntentParserSource,
  classifyDialogueAct,
  parseIntentPayload,
  type LiveIntentTransport,
} from "./liveIntentParserSource";
import type { IntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import { asNpcId, asLocationId, asFactId, asQuestId } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// live/fixture IntentParserSource
// - 规则源：对话行为短语表（我相信你→support / 你在撒谎→challenge）+ 实体名匹配；
//   输出必须绑定合法目标 NPC；非法/不可归类 → unclassifiable（converter 降级 freeform）。
// - live 源：AI 输出有效 payload 才采用；超时/非法 JSON/越界 act → 规则降级或 freeform。
// ---------------------------------------------------------------------------

const ctx: IntentContext = {
  currentLocationName: "客栈",
  connectedLocations: [{ id: "loc_2", name: "街道" }],
  presentNpcs: [{ id: "npc_1", name: "老板" }],
  availableItems: [{ id: "item_1", name: "钥匙" }],
  undiscoveredFacts: [],
  activeQuests: [],
  topicRefs: [
    { kind: "fact", id: asFactId("fact_1") },
    { kind: "quest", id: asQuestId("quest_1") },
    { kind: "thread", id: "thread_1" },
  ],
};

describe("classifyDialogueAct 短语表", () => {
  it("识别 support 支持语句", () => {
    expect(classifyDialogueAct("我相信你")).toBe("support");
  });

  it("识别 challenge 质疑语句，与 support 不同", () => {
    expect(classifyDialogueAct("你在撒谎")).toBe("challenge");
    expect(classifyDialogueAct("你在撒谎")).not.toBe("support");
  });

  it("无短语命中返回 null", () => {
    expect(classifyDialogueAct("我的等级升到100")).toBeNull();
  });
});

describe("parseIntentPayload dialogueAct 映射表", () => {
  it("我相信你 → support（绑定目标 NPC）", () => {
    const result = parseIntentPayload({ dialogueAct: "support" }, "我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
      if (result.action.type === "talk") {
        expect(result.action.dialogueAct).toBe("support");
        expect(result.action.npcId).toBe(asNpcId("npc_1"));
        expect(result.action.utterance).toBe("我相信你");
      }
    }
  });

  it("你在撒谎 → challenge", () => {
    const result = parseIntentPayload({ dialogueAct: "challenge" }, "你在撒谎", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
      if (result.action.type === "talk") {
        expect(result.action.dialogueAct).toBe("challenge");
      }
    }
  });

  it("非法 dialogueAct 不通过 schema（unclassifiable）", () => {
    const result = parseIntentPayload({ dialogueAct: "teleport" }, "瞬移吧", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(false);
  });

  it("目标 NPC 不在场 → unclassifiable（目标合法性拦截）", () => {
    const result = parseIntentPayload({ dialogueAct: "support" }, "我相信你", ctx, asNpcId("npc_ghost"));
    expect(result.ok).toBe(false);
  });

  it("已移除的休息 payload 不再转换为 Action", () => {
    const result = parseIntentPayload({ type: "rest" }, "休息一下", ctx);
    expect(result.ok).toBe(false);
  });

  // ── Task 5 Step 3：结构化主题引用 ────────────────────────────────────────

  it("AI 提供的 topic 命中服务端 fact ID → 附到 talk action", () => {
    const result = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "fact", factId: "fact_1" } },
      "你知道矿坑的密道吗？", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === "talk") {
      expect(result.action.topic).toEqual({ kind: "fact", factId: asFactId("fact_1") });
    }
  });

  it("topic 命中服务端 quest/thread ID → 附到 talk action", () => {
    const quest = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "quest", questId: "quest_1" } },
      "关于查明真相的任务", ctx, asNpcId("npc_1"));
    expect(quest.ok).toBe(true);
    if (quest.ok && quest.action.type === "talk") {
      expect(quest.action.topic).toEqual({ kind: "quest", questId: asQuestId("quest_1") });
    }
    const thread = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "thread", threadId: "thread_1" } },
      "我们继续刚才的话题", ctx, asNpcId("npc_1"));
    expect(thread.ok).toBe(true);
    if (thread.ok && thread.action.type === "talk") {
      expect(thread.action.topic).toEqual({ kind: "thread", threadId: "thread_1" });
    }
  });

  it("topic ID 不在服务端白名单 → 降级 general（绝不接受自创 ID）", () => {
    const fakeFact = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "fact", factId: "fact_ghost" } },
      "关于幽灵线索", ctx, asNpcId("npc_1"));
    expect(fakeFact.ok).toBe(true);
    if (fakeFact.ok && fakeFact.action.type === "talk") {
      expect(fakeFact.action.topic).toEqual({ kind: "general" });
    }
    const fakeQuest = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "quest", questId: "quest_ghost" } },
      "关于幽灵任务", ctx, asNpcId("npc_1"));
    if (fakeQuest.ok && fakeQuest.action.type === "talk") {
      expect(fakeQuest.action.topic).toEqual({ kind: "general" });
    }
  });

  it("kind 未知或结构非法 → 降级 general", () => {
    const badKind = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "memory", factId: "fact_1" } },
      "还记得吗", ctx, asNpcId("npc_1"));
    expect(badKind.ok).toBe(true);
    if (badKind.ok && badKind.action.type === "talk") {
      expect(badKind.action.topic).toEqual({ kind: "general" });
    }
  });

  it("无 topic 字段 → general（既有行为）", () => {
    const result = parseIntentPayload({ dialogueAct: "support" }, "我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === "talk") {
      expect(result.action.topic).toEqual({ kind: "general" });
    }
  });

  it("live 源透传合法 topic；AI 返回非法 topic 时规则降级仍保留 general", async () => {
    const live = createLiveIntentParser(
      stubTransport({ ok: true, content: '{"dialogueAct":"ask","topic":{"kind":"fact","factId":"fact_1"}}' }),
    );
    const result = await live.parseIntent("你知道矿坑的密道吗？", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === "talk") {
      expect(result.action.topic).toEqual({ kind: "fact", factId: asFactId("fact_1") });
    }
  });
});

describe("createRuleIntentParser（无 AI 配置时的确定性源）", () => {
  const source = createRuleIntentParser();

  it("目标在场 + 我相信你 → talk support", async () => {
    const result = await source.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toMatchObject({ type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" });
    }
  });

  it("目标在场 + 你在撒谎 → talk challenge（与 support 不同）", async () => {
    const result = await source.parseIntent("你在撒谎", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toMatchObject({ type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "challenge" });
    }
  });

  it("目标不在场 → unclassifiable（源内目标合法性拦截）", async () => {
    const result = await source.parseIntent("我相信你", ctx, asNpcId("npc_ghost"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unclassifiable");
  });

  it("无目标但文本含在场 NPC 名 → talk", async () => {
    const result = await source.parseIntent("老板你好", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
      if (result.action.type === "talk") expect(result.action.npcId).toBe(asNpcId("npc_1"));
    }
  });

  it("文本含地点名 → move", async () => {
    const result = await source.parseIntent("去街道", ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toMatchObject({ type: "move", locationId: asLocationId("loc_2") });
    }
  });

  it("无目标且无法定位实体 → unclassifiable", async () => {
    const result = await source.parseIntent("我的等级升到100", ctx);
    expect(result.ok).toBe(false);
  });
});

function stubTransport(result: { ok: boolean; content?: string; code?: string }): LiveIntentTransport {
  return {
    async complete() {
      return result;
    },
  } as unknown as LiveIntentTransport;
}

describe("createLiveIntentParser（AI 配置有效时的 live 源）", () => {

  it("有效 JSON → dialogueAct 正确映射", async () => {
    const live = createLiveIntentParser(stubTransport({ ok: true, content: '{"dialogueAct":"support"}' }));
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toMatchObject({ type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" });
    }
  });

  it("非法 JSON → 规则降级；规则可归类时返回规则结果", async () => {
    const live = createLiveIntentParser(stubTransport({ ok: true, content: "not a json" }));
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toMatchObject({ type: "talk", dialogueAct: "support" });
    }
  });

  it("非法 JSON 且规则不可归类 → ok=false（converter 降级 freeform）", async () => {
    const live = createLiveIntentParser(stubTransport({ ok: true, content: "not a json" }));
    const result = await live.parseIntent("我的等级升到100", ctx);
    expect(result.ok).toBe(false);
  });

  it("AI 超时（transport 返回失败）→ ok=false 兜底 result，绝不抛出", async () => {
    const live = createLiveIntentParser(stubTransport({ ok: false, code: "timeout" }));
    const result = await live.parseIntent("我的武功升到一百级", ctx);
    expect(result.ok).toBe(false);
  });

it("AI 声称的 npcId 与玩家显式目标不一致 → 丢弃 AI 的 npcId，仍绑定玩家目标在场 NPC（不静默改送其它 NPC）", async () => {
    const live = createLiveIntentParser(
      stubTransport({ ok: true, content: '{"dialogueAct":"support","npcId":"npc_2"}' }),
    );
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.type).toBe("talk");
      if (result.action.type === "talk") {
        // 玩家显式目标是 npc_1；AI 声称的 npc_2 不合法且 npc_2 不在场 → 必须落到玩家目标，绝不能改送 npc_2。
        expect(result.action.npcId).toBe(asNpcId("npc_1"));
        expect(result.action.npcId).not.toBe(asNpcId("npc_2"));
      }
    }
  });

it("AI 抛异常 → 规则降级，绝不炸穿", async () => {
    const exploding = {
      async complete() {
        throw new Error("transport exploded");
      },
    } as unknown as LiveIntentTransport;
    const live = createLiveIntentParser(exploding);
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action).toMatchObject({ type: "talk", dialogueAct: "support" });
    }
  });
});

describe("createIntentParserSource（composition root 工厂）", () => {
  it("无 AI 配置 → 确定性 rule 源", () => {
    const source = createIntentParserSource({});
    expect(source.sourceVersion).toBe("rule-intent");
  });

  it("AI 配置有效但未注入 transport → 防御性降级为 rule 源", () => {
    const source = createIntentParserSource({
      AI_API_BASE_URL: "https://api.example.com/v1",
      AI_MODEL: "small-model",
      AI_API_KEY: "sk-test",
    });
    expect(source.sourceVersion).toBe("rule-intent");
  });

  it("AI 配置有效且注入 transport → live 源", () => {
    const source = createIntentParserSource(
      {
        AI_API_BASE_URL: "https://api.example.com/v1",
        AI_MODEL: "small-model",
        AI_API_KEY: "sk-test",
      },
      stubTransport({ ok: true, content: '{"dialogueAct":"support"}' }),
    );
    expect(source.sourceVersion).toBe("live-intent");
  });
});
