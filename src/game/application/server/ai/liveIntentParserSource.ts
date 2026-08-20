import type { Action, DialogueAct, StructuredDialogueTopic } from "@/game/domain/action";
import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import { DIALOGUE_ACTS } from "@/game/domain/action";
import type { IntentContext } from "@/game/gameplay/rpg/intentParser";
import type {
  IntentParserResult,
  IntentParserSource,
  IntentAuditLink,
} from "@/game/gameplay/rpg/intentParser";
import {
  asItemId,
  asLocationId,
  asNpcId,
  asFactId,
  asQuestId,
  type NpcId,
} from "@/game/domain/worldEntity";
import { createRpgAiClient, type RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";

// ---------------------------------------------------------------------------
// live/fixture IntentParserSource。
// - 绝不静态导入 @ai-game/ai-transport：transport 以结构类型注入，
//   worktree 依赖 junction 缺失时本模块仍可单测与运行（composition root 注入真实 transport）。
// - 规则源：对话行为短语表（我相信你→support / 你在撒谎→challenge / 问候→ask）
//   + 实体名匹配；输出必须绑定在场目标 NPC；非法/不可归类 → unclassifiable。
// - live 源：AI 输出有效且通过 schema+目标合法性才采用；超时/非法 JSON/越界 act
//   → 规则降级；规则仍不可归类才 unclassifiable（converter 降级 freeform）。
// ---------------------------------------------------------------------------

export type LiveTransportResponse = {
  readonly ok: boolean;
  readonly content?: string;
  readonly code?: string;
};

export type LiveTransportMessage = {
  readonly role: string;
  readonly content: string;
};

export type LiveTransportConfig = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
};

export type LiveIntentTransport = {
  complete(
    config: LiveTransportConfig,
    messages: readonly LiveTransportMessage[],
    options: { readonly timeoutMs: number; readonly extraBody?: Record<string, unknown> },
  ): Promise<LiveTransportResponse>;
};

const SUPPORT_PHRASES = ["我相信你", "我信你", "信任你", "我相信"];
const CHALLENGE_PHRASES = ["你在撒谎", "你撒谎", "胡说", "骗子"];
const GREET_PHRASES = ["你好", "早上好", "晚上好", "再见", "谢谢", "嗨", "哈喽", "辛苦了"];

/** 对话行为短语表：命中 support/challenge 才归类，其它输入返回 null。 */
export function classifyDialogueAct(text: string): DialogueAct | null {
  const t = text.trim();
  if (SUPPORT_PHRASES.some((p) => t.includes(p))) return "support";
  if (CHALLENGE_PHRASES.some((p) => t.includes(p))) return "challenge";
  return null;
}

function resolvePresentNpc(ctx: IntentContext, raw: string | NpcId | undefined): NpcId | null {
  if (raw === undefined) return null;
  const id = String(raw);
  const npc = ctx.presentNpcs.find((n) => String(n.id) === id);
  return npc === undefined ? null : asNpcId(String(npc.id));
}

function presentNpcByName(ctx: IntentContext, text: string): NpcId | null {
  const npc = ctx.presentNpcs.find((n) => text.includes(String(n.name)));
  return npc === undefined ? null : asNpcId(String(npc.id));
}

/**
 * Task 5 Step 3：主题引用白名单解析。
 * 只允许选择服务端供应的 fact/quest/thread ID；ID 不存在或 kind 非法一律降级 general。
 */
export function resolveIntentTopic(raw: unknown, ctx: IntentContext): StructuredDialogueTopic {
  if (raw === null || typeof raw !== "object") return { kind: "general" };
  const data = raw as { kind?: unknown; factId?: unknown; questId?: unknown; threadId?: unknown };
  if (data.kind === "fact" && typeof data.factId === "string") {
    if (ctx.topicRefs.some((r) => r.kind === "fact" && String(r.id) === data.factId)) {
      return { kind: "fact", factId: asFactId(data.factId) };
    }
    return { kind: "general" };
  }
  if (data.kind === "quest" && typeof data.questId === "string") {
    if (ctx.topicRefs.some((r) => r.kind === "quest" && String(r.id) === data.questId)) {
      return { kind: "quest", questId: asQuestId(data.questId) };
    }
    return { kind: "general" };
  }
  if (data.kind === "thread" && typeof data.threadId === "string") {
    if (ctx.topicRefs.some((r) => r.kind === "thread" && String(r.id) === data.threadId)) {
      return { kind: "thread", threadId: data.threadId };
    }
    return { kind: "general" };
  }
  return { kind: "general" };
}

/**
 * AI 载荷纯校验（schema + 目标合法性）：
 * - {dialogueAct} 或 {type:"talk", dialogueAct} → 绑定在场目标 NPC；
 * - move/take_item → 实体必须存在于上下文；explore 直接放行；
 * - 其余一律 unclassifiable。
 */
export function parseIntentPayload(
  payload: unknown,
  text: string,
  ctx: IntentContext,
  targetNpcId?: NpcId,
): IntentParserResult {
  if (payload === null || typeof payload !== "object") return { ok: false, reason: "unclassifiable" };
  const data = payload as Record<string, unknown>;
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "unclassifiable" };

  const actOf = (value: unknown): DialogueAct | null =>
    typeof value === "string" && DIALOGUE_ACTS.includes(value as DialogueAct)
      ? (value as DialogueAct)
      : null;

  // talk 路径：AI 返回 dialogueAct（或 type:"talk"）→ 绑定玩家目标/在场 NPC。
  if (typeof data.dialogueAct === "string" || data.type === "talk") {
    const act = actOf(data.dialogueAct);
    if (act === null) return { ok: false, reason: "unclassifiable" };
    // 玩家显式绑定目标 NPC 时以玩家为准：AI 声称的 npcId 只允许等于该目标
    // （等于 → 用玩家绑定；不等 → unclassifiable，绝不静默改送到别的 NPC）。
    const rawTarget = typeof data.npcId === "string" ? data.npcId : targetNpcId;
    if (targetNpcId !== undefined && rawTarget !== String(targetNpcId)) {
      return { ok: false, reason: "unclassifiable" };
    }
    const target = resolvePresentNpc(ctx, rawTarget);
    if (target === null) return { ok: false, reason: "unclassifiable" };
    return {
      ok: true,
      action: {
        type: "talk",
        npcId: target,
        dialogueAct: act,
        utterance: trimmed,
        topic: resolveIntentTopic(data.topic, ctx),
      },
    };
  }

  if (data.type === "move" && typeof data.locationId === "string") {
    const found = ctx.connectedLocations.find((l) => String(l.id) === data.locationId);
    if (found === undefined) return { ok: false, reason: "unclassifiable" };
    return { ok: true, action: { type: "move", locationId: asLocationId(String(found.id)) } };
  }

  if (data.type === "take_item" && typeof data.itemId === "string") {
    const found = ctx.availableItems.find((i) => String(i.id) === data.itemId);
    if (found === undefined) return { ok: false, reason: "unclassifiable" };
    return { ok: true, action: { type: "take_item", itemId: asItemId(String(found.id)) } };
  }

  if (data.type === "explore") {
    const action: Action = { type: "explore" };
    return { ok: true, action };
  }

  return { ok: false, reason: "unclassifiable" };
}

function ruleParse(text: string, ctx: IntentContext, targetNpcId?: NpcId): IntentParserResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "unclassifiable" };

  // 1. 对话行为短语表：必须绑定到场目标 NPC
  const act = classifyDialogueAct(trimmed);
  if (act !== null) {
    const target = resolvePresentNpc(ctx, targetNpcId);
    if (target === null) return { ok: false, reason: "unclassifiable" };
    return {
      ok: true,
      action: { type: "talk", npcId: target, dialogueAct: act, utterance: trimmed },
    };
  }

  // 2. 问候短语 → ask（受规则记录的轻量对话回合）
  if (GREET_PHRASES.some((p) => trimmed.includes(p))) {
    const target = resolvePresentNpc(ctx, targetNpcId) ?? presentNpcByName(ctx, trimmed);
    if (target !== null) {
      return {
        ok: true,
        action: { type: "talk", npcId: target, dialogueAct: "ask", utterance: trimmed },
      };
    }
  }

  // 3. 在场 NPC 名 → ask
  const npcByName = presentNpcByName(ctx, trimmed);
  if (npcByName !== null) {
    return {
      ok: true,
      action: { type: "talk", npcId: npcByName, dialogueAct: "ask", utterance: trimmed },
    };
  }

  // 4. 地点名 → move
  for (const loc of ctx.connectedLocations) {
    if (trimmed.includes(String(loc.name))) {
      return { ok: true, action: { type: "move", locationId: asLocationId(String(loc.id)) } };
    }
  }

  // 5. 物品名 → take_item
  for (const item of ctx.availableItems) {
    if (trimmed.includes(String(item.name))) {
      return { ok: true, action: { type: "take_item", itemId: asItemId(String(item.id)) } };
    }
  }

  return { ok: false, reason: "unclassifiable" };
}

/** 无 AI 配置时的确定性意图源（离线基线，零 IO）。 */
export function createRuleIntentParser(): IntentParserSource {
  return {
    sourceVersion: "rule-intent",
    async parseIntent(text, ctx, targetNpcId?, _auditLink?) {
      return ruleParse(text, ctx, targetNpcId);
    },
  };
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1] ?? "");
      } catch {
        // fall through
      }
    }
    return null;
  }
}

function buildUserPrompt(text: string, ctx: IntentContext, targetNpcId?: NpcId): string {
  const npcNames = ctx.presentNpcs.map((n) => n.name).join("、") || "无";
  const locNames = ctx.connectedLocations.map((l) => l.name).join("、") || "无";
  const itemNames = ctx.availableItems.map((i) => i.name).join("、") || "无";
  const topicRefs = ctx.topicRefs.map((r) => `${r.kind}:${String(r.id)}`).join("、") || "无";
  const targetLine = targetNpcId !== undefined ? `目标NPC：${String(targetNpcId)}` : "无明确目标";
  return [
    `玩家输入：${text}`,
    targetLine,
    `在场NPC：${npcNames}`,
    `可达地点：${locNames}`,
    `可用物品：${itemNames}`,
    `可引用主题（仅以下 ID，topic.kind/ID 必须原样使用其中之一）：${topicRefs}`,
    "返回严格 JSON：{\"dialogueAct\":\"ask|support|challenge|threaten|deceive|offer|refuse|reassure\",\"topic\":{\"kind\":\"fact|quest|thread|general\",\"factId\"|\"questId\"|\"threadId\":\"服务端ID\"},\"npcId\":\"目标NPC\"} 或 {\"type\":\"talk\"|\"move\"|\"take_item\"|\"explore\", ...}",
  ].join("\n");
}

/** AI 配置有效时的 live 意图源：AI 失败一律规则降级，绝不抛穿回合流水线。 */
export function createLiveIntentParser(
  transport?: LiveIntentTransport,
  config?: LiveTransportConfig,
  logger?: { warn(event: string, details?: unknown): void },
  jsonMode: ProviderJsonMode = "prompt_only",
  aiClient?: RpgAiClient,
): IntentParserSource {
  const rule = createRuleIntentParser();
  const cfg = config ?? { baseUrl: "", apiKey: "", model: "" };
  const client = aiClient ?? (transport
    ? createRpgAiClient({
      transport: transport as unknown as AiTransport,
      config: cfg as AiTransportConfig,
      logger,
      policies: { intent: { jsonMode } },
    })
    : undefined);
  return {
    sourceVersion: "live-intent",
    async parseIntent(text, ctx, targetNpcId?, auditLink?: IntentAuditLink) {
      try {
        if (client === undefined) return rule.parseIntent(text, ctx, targetNpcId, auditLink);
        const response = await client.complete(
          "intent",
          [
            { role: "system", content: "你是 RPG 意图解析器，只返回严格 JSON。" },
            { role: "user", content: buildUserPrompt(text, ctx, targetNpcId) },
          ],
          {
            purpose: "intent_parsing",
            trigger: "free_text_action",
            ...(auditLink ?? {}),
            action: {
              kind: "free_text_action",
              ...(targetNpcId === undefined ? {} : { targetNpcId: String(targetNpcId) }),
            },
          },
        );
        if (response.ok && typeof response.content === "string") {
          const parsed = parseJsonResponse(response.content);
          if (parsed !== null) {
            const checked = parseIntentPayload(parsed, text, ctx, targetNpcId);
            if (checked.ok) return checked;
          }
        }
      } catch (error) {
        logger?.warn("live_intent_ai_error", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
      return rule.parseIntent(text, ctx, targetNpcId, auditLink);
    },
  };
}

/**
 * composition root 工厂：读 env 判定 AI 可用性。
 * AI 配置有效且注入 transport → live 源；否则防御性降级 rule 源。
 */
export function createIntentParserSource(
  env: Record<string, string | undefined> = process.env,
  transport?: LiveIntentTransport,
  jsonMode: ProviderJsonMode = "prompt_only",
  aiClient?: RpgAiClient,
): IntentParserSource {
  const baseUrl = env.AI_API_BASE_URL?.trim() ?? "";
  const apiKey = env.AI_API_KEY?.trim() ?? "";
  const model = env.AI_MODEL?.trim() ?? "";
  if (baseUrl !== "" && apiKey !== "" && model !== "" && (transport !== undefined || aiClient !== undefined)) {
    return createLiveIntentParser(transport, { baseUrl, apiKey, model }, undefined, jsonMode, aiClient);
  }
  return createRuleIntentParser();
}
