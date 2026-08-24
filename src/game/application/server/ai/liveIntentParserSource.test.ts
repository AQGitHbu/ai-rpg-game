import { describe, it, expect, vi } from "vitest";
import {
  createRuleIntentParser,
  createLiveIntentParser,
  createIntentParserSource,
  classifyDialogueAct,
  parseIntentPayload,
  type LiveIntentTransport,
} from "./liveIntentParserSource";
import { createRpgAiClient } from "./rpgAiClient";
import type { AiTransport } from "@ai-game/ai-transport";
import type { AiTextAuditRecorder, AiTextAuditPayload } from "./textAuditTypes";
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

  it("topic ID 不在服务端白名单 → 拒绝响应（绝不接受自创 ID）", () => {
    const fakeFact = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "fact", factId: "fact_ghost" } },
      "关于幽灵线索", ctx, asNpcId("npc_1"));
    expect(fakeFact).toEqual({ ok: false, reason: "unclassifiable" });
    const fakeQuest = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "quest", questId: "quest_ghost" } },
      "关于幽灵任务", ctx, asNpcId("npc_1"));
    expect(fakeQuest).toEqual({ ok: false, reason: "unclassifiable" });
  });

  it("kind 未知或结构非法 → 拒绝响应", () => {
    const badKind = parseIntentPayload(
      { dialogueAct: "ask", topic: { kind: "memory", factId: "fact_1" } },
      "还记得吗", ctx, asNpcId("npc_1"));
    expect(badKind).toEqual({ ok: false, reason: "unclassifiable" });
  });

  it("无 topic 字段 → general（既有行为）", () => {
    const result = parseIntentPayload({ dialogueAct: "support" }, "我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === "talk") {
      expect(result.action.topic).toEqual({ kind: "general" });
    }
  });

  it("live 源透传合法 topic；非法 topic 进入稳定响应失败", async () => {
    const live = createLiveIntentParser(
      stubTransport({ ok: true, content: '{"dialogueAct":"ask","topic":{"kind":"fact","factId":"fact_1"}}' }),
    );
    const result = await live.parseIntent("你知道矿坑的密道吗？", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    if (result.ok && result.action.type === "talk") {
      expect(result.action.topic).toEqual({ kind: "fact", factId: asFactId("fact_1") });
    }
    const invalid = createLiveIntentParser(
      stubTransport({ ok: true, content: '{"dialogueAct":"ask","topic":{"kind":"fact","factId":"fact_ghost"}}' }),
    );
    await expect(invalid.parseIntent("关于未知线索", ctx, asNpcId("npc_1"))).resolves.toEqual({
      ok: false,
      reason: "service_error",
      failureKind: "AI_RESPONSE_INVALID",
    });
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

  it("绑定焦点 NPC 时明确要求 AI 只能返回对话意图，避免把自由文本误判为移动", async () => {
    let userPrompt = "";
    const transport: LiveIntentTransport = {
      async complete(_config, messages) {
        userPrompt = messages.find((message) => message.role === "user")?.content ?? "";
        return { ok: true, content: '{"dialogueAct":"ask"}' };
      },
    };
    const live = createLiveIntentParser(transport);

    const result = await live.parseIntent("我去西边看看", ctx, asNpcId("npc_1"));

    expect(result.ok).toBe(true);
    expect(userPrompt).toContain("目标 NPC 已由服务端绑定");
    expect(userPrompt).toContain("只能返回 talk 对话意图");
    expect(userPrompt).toContain("不得返回 type=move、type=take_item 或 type=explore");
  });

  it("接受 fenced JSON 并记录规范化", async () => {
    const logger = { warn: vi.fn() };
    const live = createLiveIntentParser(
      stubTransport({ ok: true, content: "```json\n{\"dialogueAct\":\"support\"}\n```" }),
      undefined,
      logger,
    );
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));

    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith("live_intent_json_fence_normalized");
  });

  it("非法 JSON → 内容修复耗尽后返回稳定格式失败", async () => {
    const live = createLiveIntentParser(stubTransport({ ok: true, content: "not a json" }));
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "service_error") throw new Error("expected service failure");
    expect(result.failureKind).toBe("AI_RESPONSE_INVALID");
  });

  it("内容修复调用把 context.retry 标为 content_repair（不再用旧 repair 字段）", async () => {
    const records: AiTextAuditPayload[] = [];
    const audit: AiTextAuditRecorder = {
      enabled: true,
      gameApiMode: "compact",
      record: async (p) => { records.push(p); },
      close: async () => {},
    };
    let calls = 0;
    const client = createRpgAiClient({
      transport: {
        complete: async () => {
          calls += 1;
          return calls === 1
            ? { ok: true as const, content: "not a json", latencyMs: 1 }
            : { ok: true as const, content: '{"dialogueAct":"support"}', latencyMs: 1 };
        },
      } as unknown as AiTransport,
      config: { baseUrl: "http://provider.test/v1", apiKey: "secret", model: "model" },
      auditRecorder: audit,
    });
    const live = createLiveIntentParser(undefined, undefined, undefined, "prompt_only", client);
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(true);
    const aiCalls = records.filter((r) => r.kind === "ai_call");
    expect(aiCalls).toHaveLength(2);
    expect(aiCalls[0].callId).not.toBe(aiCalls[1].callId);
    expect(aiCalls[0].context.retry).toEqual({ origin: "normal", mechanism: "initial", attempt: 0 });
    expect(aiCalls[1].context.retry).toEqual({
      origin: "normal",
      mechanism: "content_repair",
      attempt: 1,
      reason: "invalid_json",
    });
  });

  it("非法 JSON 且规则不可归类 → 返回稳定格式失败", async () => {
    const live = createLiveIntentParser(stubTransport({ ok: true, content: "not a json" }));
    const result = await live.parseIntent("我的等级升到100", ctx);
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "service_error") throw new Error("expected service failure");
    expect(result.failureKind).toBe("AI_RESPONSE_INVALID");
  });

  it("AI 超时（transport 返回失败）→ ok=false 兜底 result，绝不抛出", async () => {
    const live = createLiveIntentParser(stubTransport({ ok: false, code: "timeout" }));
    const result = await live.parseIntent("我的武功升到一百级", ctx);
    expect(result.ok).toBe(false);
  });

it("AI 声称的 npcId 与玩家显式目标不一致 → 返回稳定引用失败", async () => {
    const live = createLiveIntentParser(
      stubTransport({ ok: true, content: '{"dialogueAct":"support","npcId":"npc_2"}' }),
    );
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "service_error") throw new Error("expected service failure");
    expect(result.failureKind).toBe("AI_RESPONSE_INVALID");
  });

it("AI 抛异常 → 返回调用失败，绝不炸穿", async () => {
    const exploding = {
      async complete() {
        throw new Error("transport exploded");
      },
    } as unknown as LiveIntentTransport;
    const live = createLiveIntentParser(exploding);
    const result = await live.parseIntent("我相信你", ctx, asNpcId("npc_1"));
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "service_error") throw new Error("expected service failure");
    expect(result.failureKind).toBe("AI_CALL_FAILED");
  });
});

describe("createIntentParserSource（composition root 工厂）", () => {
  it("无 AI 配置 → 不可用源", () => {
    const source = createIntentParserSource({});
    expect(source.sourceVersion).toBe("unavailable-intent");
  });

  it("AI 配置有效但未注入 transport → 不可用源", () => {
    const source = createIntentParserSource({
      AI_API_BASE_URL: "https://api.example.com/v1",
      AI_MODEL: "small-model",
      AI_API_KEY: "sk-test",
    });
    expect(source.sourceVersion).toBe("unavailable-intent");
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
