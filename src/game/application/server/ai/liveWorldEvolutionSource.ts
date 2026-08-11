import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { WorldEvolutionSource, WorldEvolutionSourceContext } from "../../worldEvolutionSource";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import { createDeterministicEvolutionSource } from "../../deterministicEvolutionSource";
import type { WorldState } from "@/game/domain/worldState";

// ---------------------------------------------------------------------------
// WorldEvolution live source（Task 3）。
//
// 编排：AI 原始 JSON → 纯解析/校验（非法字段、越权引用直接丢弃）→ 失败/异常
// 回退确定性 source（保证总能产出可装配的下幕/结局对/修复提案）。source 只做
// “提案”，不做审批/分配 ID/写状态（那些是 gameplay worldEvolution 纯函数职责）。
// 敏感信息（apiKey 等）绝不进入日志。
// ---------------------------------------------------------------------------

export type WorldEvolutionLiveDeps = {
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

const MAX_NAME = 40;
const MAX_TEXT = 200;

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function validName(v: unknown): v is string {
  if (!isStr(v)) return false;
  const t = v.trim();
  return t.length >= 2 && t.length <= MAX_NAME;
}

function validText(v: unknown): v is string {
  if (!isStr(v)) return false;
  const t = v.trim();
  return t.length > 0 && t.length <= MAX_TEXT;
}

function strList(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isStr).map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 8);
}

function parseLocationRef(v: unknown): { readonly kind: "existing"; readonly id: string } | { readonly kind: "new_location" } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  if (rec.kind === "new_location") return { kind: "new_location" };
  if (rec.kind === "existing" && isStr(rec.id) && rec.id.trim() !== "") {
    return { kind: "existing", id: rec.id.trim() };
  }
  return null;
}

function parseMountedRef(v: unknown): "current" | "new_location" | null {
  return v === "current" || v === "new_location" ? v : null;
}

/** 把 AI 原始 JSON 逐字段解析/校验为合法 WorldDeltaProposal；非法整条丢弃。 */
export function parseWorldDeltaProposal(raw: unknown): WorldDeltaProposal | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const beatSummary = isStr(rec.beatSummary) ? rec.beatSummary.trim().slice(0, MAX_TEXT) : "";
  if (beatSummary === "") return null;

  let newLocation: WorldDeltaProposal["newLocation"] = null;
  if (rec.newLocation !== null && rec.newLocation !== undefined) {
    if (typeof rec.newLocation !== "object" || Array.isArray(rec.newLocation)) return null;
    const l = rec.newLocation as Record<string, unknown>;
    const scale = l.scale;
    if (!validName(l.name) || !validText(l.description)) return null;
    if (scale !== "scene" && scale !== "town") return null;
    if (!isStr(l.connectFromLocationId) || l.connectFromLocationId.trim() === "") return null;
    newLocation = {
      name: l.name.trim(),
      description: l.description.trim(),
      scale,
      connectFromLocationId: l.connectFromLocationId.trim(),
    };
  }

  let newNpc: WorldDeltaProposal["newNpc"] = null;
  if (rec.newNpc !== null && rec.newNpc !== undefined) {
    if (typeof rec.newNpc !== "object" || Array.isArray(rec.newNpc)) return null;
    const n = rec.newNpc as Record<string, unknown>;
    if (!validName(n.name) || !validText(n.role) || !validText(n.description)) return null;
    const locationRef = parseLocationRef(n.locationRef);
    if (locationRef === null) return null;
    newNpc = {
      name: n.name.trim(),
      role: n.role.trim(),
      description: n.description.trim(),
      locationRef,
      goals: strList(n.goals),
    };
  }

  let newItem: WorldDeltaProposal["newItem"] = null;
  if (rec.newItem !== null && rec.newItem !== undefined) {
    if (typeof rec.newItem !== "object" || Array.isArray(rec.newItem)) return null;
    const it = rec.newItem as Record<string, unknown>;
    if (!validName(it.name) || !validText(it.description)) return null;
    const locationRef = parseMountedRef(it.locationRef);
    if (locationRef === null) return null;
    newItem = { name: it.name.trim(), description: it.description.trim(), locationRef };
  }

  let newEnemy: WorldDeltaProposal["newEnemy"] = null;
  if (rec.newEnemy !== null && rec.newEnemy !== undefined) {
    if (typeof rec.newEnemy !== "object" || Array.isArray(rec.newEnemy)) return null;
    const e = rec.newEnemy as Record<string, unknown>;
    if (!validName(e.name)) return null;
    const tier = e.tier;
    if (tier !== "normal" && tier !== "boss") return null;
    const locationRef = parseMountedRef(e.locationRef);
    if (locationRef === null) return null;
    newEnemy = { name: e.name.trim(), tier, locationRef };
  }

  let newFact: WorldDeltaProposal["newFact"] = null;
  if (rec.newFact !== null && rec.newFact !== undefined) {
    if (typeof rec.newFact !== "object" || Array.isArray(rec.newFact)) return null;
    const f = rec.newFact as Record<string, unknown>;
    if (!validText(f.text)) return null;
    const visibility = f.visibility;
    if (visibility !== "public" && visibility !== "npc_private") return null;
    newFact = { text: f.text.trim(), visibility };
  }

  let nextMainQuest: WorldDeltaProposal["nextMainQuest"] = null;
  if (rec.nextMainQuest !== null && rec.nextMainQuest !== undefined) {
    if (typeof rec.nextMainQuest !== "object" || Array.isArray(rec.nextMainQuest)) return null;
    const q = rec.nextMainQuest as Record<string, unknown>;
    if (!validName(q.name) || !validText(q.description) || !validText(q.objectiveText)) return null;
    nextMainQuest = {
      name: q.name.trim(),
      description: q.description.trim(),
      objectiveText: q.objectiveText.trim(),
    };
  }

  let endingPair: WorldDeltaProposal["endingPair"] = null;
  if (rec.endingPair !== null && rec.endingPair !== undefined) {
    if (!Array.isArray(rec.endingPair) || rec.endingPair.length !== 2) return null;
    const parsed: { name: string; description: string; themeKey: "trust" | "doubt" }[] = [];
    for (const item of rec.endingPair) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
      const e = item as Record<string, unknown>;
      const themeKey = e.themeKey;
      if (themeKey !== "trust" && themeKey !== "doubt") return null;
      if (!validName(e.name) || !validText(e.description)) return null;
      parsed.push({ name: e.name.trim(), description: e.description.trim(), themeKey });
    }
    endingPair = [parsed[0]!, parsed[1]!];
  }

  if (
    newLocation === null && newNpc === null && newItem === null && newEnemy === null
    && newFact === null && nextMainQuest === null && endingPair === null
  ) {
    return null;
  }

  return { beatSummary, newLocation, newNpc, newItem, newEnemy, newFact, nextMainQuest, endingPair };
}

/** 引用越权过滤：connectFromLocationId / 现有地点引用必须真实存在（source 层不做审批）。 */
export function filterProposalRefs(proposal: WorldDeltaProposal, ws: WorldState): WorldDeltaProposal | null {
  const locIds = new Set(ws.locations.map((l) => String(l.id)));
  if (proposal.newLocation && !locIds.has(proposal.newLocation.connectFromLocationId)) return null;
  if (proposal.newNpc && proposal.newNpc.locationRef.kind === "existing" && !locIds.has(proposal.newNpc.locationRef.id)) return null;
  return proposal;
}

/** live 世界演化源：AI 提案 → 纯解析/校验/引用过滤 → 失败回退确定性源。 */
export function createLiveWorldEvolutionSource(deps: WorldEvolutionLiveDeps): WorldEvolutionSource {
  const deterministic = createDeterministicEvolutionSource();
  const { transport, config, logger } = deps;

  return {
    async propose(ctx) {
      if (!transport || !config) {
        return deterministic.propose(ctx);
      }
      try {
        const result = await transport.complete(config, [
          { role: "system", content: buildWorldEvolutionPrompt(ctx) },
          { role: "user", content: userPrompt(ctx) },
        ], { timeoutMs: 60_000 });

        if (!result.ok) {
          logger?.warn("world_evolution_ai_failed", { code: result.code });
          return deterministic.propose(ctx);
        }
        const parsed = parseJsonResponse(result.content);
        const rawProposal = typeof parsed === "object" && parsed !== null && "proposal" in parsed
          ? (parsed as Record<string, unknown>).proposal
          : parsed;
        const proposal = parseWorldDeltaProposal(rawProposal);
        if (proposal === null) {
          logger?.warn("world_evolution_invalid_data");
          return deterministic.propose(ctx);
        }
        const filtered = filterProposalRefs(proposal, ctx.worldState);
        return { proposal: filtered };
      } catch (error) {
        logger?.warn("world_evolution_transport_failed", { message: (error as Error)?.message });
        return deterministic.propose(ctx);
      }
    },
  };
}

function userPrompt(ctx: WorldEvolutionSourceContext): string {
  return `演化需求 ${kindText(ctx.need)} / 触发原因 ${ctx.reason}${ctx.action ? ` / 玩家行动 ${String(ctx.action.type)}` : ""}`;
}

function kindText(need: WorldEvolutionSourceContext["need"]): string {
  switch (need.kind) {
    case "none": return "无";
    case "next_act": return `下一幕（${need.act}）`;
    case "ending_pair": return `终幕结局对（${need.finalAct}）`;
    case "pacing": return `节奏${need.pacingNeed}`;
  }
}

function buildWorldEvolutionPrompt(ctx: WorldEvolutionSourceContext): string {
  const { worldState, storyState } = ctx;
  const currentLoc = worldState.locations.find((l) => l.id === worldState.currentLocationId);
  return `你是 RPG 世界设计师。根据演化需求产出一次世界演化提案，返回严格 JSON：
{
  "proposal": {
    "beatSummary": "一句话说明本次演化的叙事意义",
    "newLocation": null | { "name": "...", "description": "...", "scale": "scene" | "town", "connectFromLocationId": "..." },
    "newNpc": null | { "name": "...", "role": "...", "description": "...", "locationRef": { "kind": "existing", "id": "..." } | { "kind": "new_location" }, "goals": ["..."] },
    "newItem": null | { "name": "...", "description": "...", "locationRef": "current" | "new_location" },
    "newEnemy": null | { "name": "...", "tier": "normal" | "boss", "locationRef": "current" | "new_location" },
    "newFact": null | { "text": "...", "visibility": "public" | "npc_private" },
    "nextMainQuest": null | { "name": "...", "description": "...", "objectiveText": "..." },
    "endingPair": null | [{ "name": "...", "description": "...", "themeKey": "trust" }, { "name": "...", "description": "...", "themeKey": "doubt" }]
  }
}

当前地点：${currentLoc?.name ?? "未知"}
当前幕数：${storyState.currentAct}/${storyState.targetActs}
张力值：${storyState.tension}
演化需求：${kindText(ctx.need)} / 原因 ${ctx.reason}

要求：只填充与演化需求相称的字段（next_act 必须给 nextMainQuest 且至少一名锚定 NPC；ending_pair 必须给互斥且名称各异的 endingPair；pacing 补缺失实体即可）；所有 existing 地点引用必须来自世界已存在的地点；名称 2-40 字符，描述非空且不超过 200 字符；只返回 JSON，不要其他文字。`;
}
