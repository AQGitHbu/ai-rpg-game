import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { ExpansionSource, ExpansionSourceContext } from "@/game/gameplay/rpg/expansion/expansionSource";
import type { ExpansionProposal } from "@/game/gameplay/rpg/expansion/expansionTypes";
import { createFixtureExpansionSource } from "./expansionSource";
import type { WorldState } from "@/game/domain/worldState";

// ---------------------------------------------------------------------------
// Task 28：V2 Expansion live source。
//
// 编排：AI 原始 JSON → 逐条纯解析/校验（非法字段、未知 kind、超长、引用越权直接丢弃）
// → 失败/异常回退空提案（不破坏回合流水线）。
// source 只做“提案”，不做审批/分配 ID/写状态（那些是 gameplay expansion 纯函数职责）。
// 敏感信息（apiKey 等）绝不进入日志。
// ---------------------------------------------------------------------------

export type ExpansionLiveDeps = {
  readonly transport?: AiTransport;
  readonly config?: AiTransportConfig;
  readonly logger?: GameLogger;
};

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```json\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 提案文本长度上限（超长丢弃，防注入/异常载荷）。 */
const MAX_NAME = 40;
const MAX_DESC = 240;
const MAX_ROLE = 40;
const MAX_TEXT = 240;
const MAX_REASON = 120;

/** 未知 kind 直接丢弃；kind 越权引用也在此层拦截。 */
export function parseExpansionProposals(raw: unknown): readonly ExpansionProposal[] {
  if (!Array.isArray(raw)) return [];
  const proposals: ExpansionProposal[] = [];
  for (const item of raw) {
    const proposal = parseOneProposal(item);
    if (proposal !== null) proposals.push(proposal);
  }
  return proposals;
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function parseOneProposal(raw: unknown): ExpansionProposal | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const kind = rec.kind;
  switch (kind) {
    case "location": {
      const name = rec.name;
      const description = rec.description;
      const connectFromLocationId = rec.connectFromLocationId;
      if (!isStr(name) || name.trim().length < 2 || name.trim().length > MAX_NAME) return null;
      if (!isStr(description) || description.trim().length < 10 || description.trim().length > MAX_DESC) return null;
      if (!isStr(connectFromLocationId) || connectFromLocationId.trim() === "") return null;
      if (rec.scale !== "scene" && rec.scale !== "town") return null;
      return {
        kind: "location",
        name: name.trim(),
        description: description.trim(),
        scale: rec.scale as "scene" | "town",
        connectFromLocationId: connectFromLocationId.trim(),
        reason: isStr(rec.reason) ? rec.reason.trim().slice(0, MAX_REASON) : "",
      };
    }
    case "npc": {
      const name = rec.name;
      const role = rec.role;
      const description = rec.description;
      const locationId = rec.locationId;
      if (!isStr(name) || name.trim().length < 2 || name.trim().length > MAX_NAME) return null;
      if (!isStr(role) || role.trim().length < 2 || role.trim().length > MAX_ROLE) return null;
      if (!isStr(description) || description.trim().length < 10 || description.trim().length > MAX_DESC) return null;
      if (!isStr(locationId) || locationId.trim() === "") return null;
      return {
        kind: "npc",
        name: name.trim(),
        role: role.trim(),
        description: description.trim(),
        locationId: locationId.trim(),
      };
    }
    case "item": {
      const name = rec.name;
      const description = rec.description;
      const locationId = rec.locationId;
      if (!isStr(name) || name.trim().length < 2 || name.trim().length > MAX_NAME) return null;
      if (!isStr(description) || description.trim().length < 5 || description.trim().length > MAX_DESC) return null;
      if (!isStr(locationId) || locationId.trim() === "") return null;
      return {
        kind: "item",
        name: name.trim(),
        description: description.trim(),
        kind_hint: isStr(rec.kind_hint) ? rec.kind_hint.trim().slice(0, MAX_NAME) : "misc",
        tags: Array.isArray(rec.tags) ? rec.tags.filter(isStr).map((t) => t.trim()).slice(0, 16) : [],
        locationId: locationId.trim(),
      };
    }
    case "enemy": {
      const name = rec.name;
      const locationId = rec.locationId;
      if (!isStr(name) || name.trim().length < 2 || name.trim().length > MAX_NAME) return null;
      if (!isStr(locationId) || locationId.trim() === "") return null;
      const stats = rec.stats;
      if (typeof stats !== "object" || stats === null || Array.isArray(stats)) return null;
      const hp = (stats as Record<string, unknown>).hp;
      const attack = (stats as Record<string, unknown>).attack;
      const defense = (stats as Record<string, unknown>).defense;
      if (typeof hp !== "number" || typeof attack !== "number" || typeof defense !== "number") return null;
      if (rec.tier !== "normal" && rec.tier !== "boss") return null;
      return {
        kind: "enemy",
        name: name.trim(),
        tier: rec.tier as "normal" | "boss",
        stats: { hp, attack, defense },
        locationId: locationId.trim(),
        reason: isStr(rec.reason) ? rec.reason.trim().slice(0, MAX_REASON) : "",
      };
    }
    case "fact": {
      const text = rec.text;
      const locationId = rec.locationId;
      if (!isStr(text) || text.trim().length < 5 || text.trim().length > MAX_TEXT) return null;
      if (!isStr(locationId) || locationId.trim() === "") return null;
      return {
        kind: "fact",
        text: text.trim(),
        locationId: locationId.trim(),
        reason: isStr(rec.reason) ? rec.reason.trim().slice(0, MAX_REASON) : "",
      };
    }
    default:
      return null;
  }
}

/** 引用越权过滤：提案引用的 location 必须存在于当前世界（source 层不做审批，只做基础引用约束）。 */
export function filterProposalsByExistingLocations(
  proposals: readonly ExpansionProposal[],
  ws: WorldState,
): readonly ExpansionProposal[] {
  const locIds = new Set(ws.locations.map((l) => String(l.id)));
  return proposals.filter((p) => {
    const ref = p.kind === "location" ? p.connectFromLocationId : p.locationId;
    return locIds.has(ref);
  });
}

/** live 扩张源：AI 提案 → 纯解析/校验/引用过滤 → 失败回退空提案。 */
export function createLiveExpansionSource(deps: ExpansionLiveDeps): ExpansionSource {
  const fixture = createFixtureExpansionSource();
  const { transport, config, logger } = deps;

  return {
    async propose(ctx) {
      if (!transport || !config) {
        // 无配置：确定性 fixture 兜底（测试/离线）。
        return fixture.propose(ctx);
      }
      try {
        const result = await transport.complete(config, [
          { role: "system", content: buildExpansionPrompt(ctx) },
          { role: "user", content: `当前张力 ${ctx.storyState.tension} / 触发原因 ${ctx.triggerReason}` },
        ], { timeoutMs: 60_000 });

        if (!result.ok) {
          logger?.warn("expansion_ai_failed", { code: result.code });
          return { proposals: [] };
        }
        const parsed = parseJsonResponse(result.content);
        const rawProposals = typeof parsed === "object" && parsed !== null && "proposals" in parsed
          ? (parsed as Record<string, unknown>).proposals
          : parsed;
        const parsedProposals = parseExpansionProposals(rawProposals);
        if (parsedProposals.length === 0) {
          logger?.warn("expansion_invalid_data");
          return { proposals: [] };
        }
        const filtered = filterProposalsByExistingLocations(parsedProposals, ctx.worldState);
        return { proposals: filtered };
      } catch (error) {
        logger?.warn("expansion_transport_failed", { message: (error as Error)?.message });
        return { proposals: [] };
      }
    },
  };
}

function buildExpansionPrompt(ctx: ExpansionSourceContext): string {
  const { worldState, storyState, action, triggerReason } = ctx;
  const currentLoc = worldState.locations.find((l) => l.id === worldState.currentLocationId);
  return `你是 RPG 世界设计师。根据当前状态为世界扩展提出候选提案，返回严格 JSON：
{
  "proposals": [
    { "kind": "location", "name": "...", "description": "...", "scale": "scene", "connectFromLocationId": "...", "reason": "..." },
    { "kind": "npc", "name": "...", "role": "...", "description": "...", "locationId": "..." },
    { "kind": "item", "name": "...", "description": "...", "kind_hint": "weapon", "tags": [], "locationId": "..." },
    { "kind": "enemy", "name": "...", "tier": "normal", "stats": { "hp": 30, "attack": 5, "defense": 1 }, "locationId": "..." },
    { "kind": "fact", "text": "...", "locationId": "..." }
  ]
}

当前地点：${currentLoc?.name ?? "未知"}
当前幕数：${storyState.currentAct}/${storyState.targetActs}
张力值：${storyState.tension}
触发原因：${triggerReason}
玩家行动：${String(action.type)}

要求：proposals 最多 3 条；所有 locationId/connectFromLocationId 必须引用世界已存在的地点；只返回 JSON，不要其他文字。`;
}
