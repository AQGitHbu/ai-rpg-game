import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { WorldEvolutionSource, WorldEvolutionSourceContext, WorldEvolutionSourceResult } from "../../worldEvolutionSource";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { WorldState, InvestigationApproach } from "@/game/domain/worldState";
import type { GameTypeId } from "@/game/domain/newGame";
import { createRpgAiClient, RPG_AI_DEFAULT_POLICIES, type RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import { classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";

// ---------------------------------------------------------------------------
// WorldEvolution live source（Task 3）。
//
// 编排：AI 原始 JSON → 纯解析/校验（非法字段、越权引用直接丢弃）→ 失败/异常
// 返回稳定 typed failure（保证调用方知道是 AI 调用失败还是响应格式不对）。source
// 只做“提案”，不做审批/分配 ID/写状态（那些是 gameplay worldEvolution 纯函数职责）。
// 敏感信息（apiKey 等）绝不进入日志。
// ---------------------------------------------------------------------------

export type WorldEvolutionLiveDeps = {
  readonly transport?: AiTransport;
  readonly config?: AiTransportConfig;
  /** Shared RPG client supplied by the server composition root. */
  readonly aiClient?: RpgAiClient;
  readonly jsonMode?: ProviderJsonMode;
  readonly logger?: GameLogger;
};

/**
 * 世界演化与场景共用同一兼容 provider；30 秒会在正文到达前中止合法 JSON。
 * 该超时只决定何时明确记录失败，不会把失败当成一次有效 AI 演化。
 */
export const LIVE_WORLD_EVOLUTION_TIMEOUT_MS = RPG_AI_DEFAULT_POLICIES.world.timeoutMs;
/** 世界演化只生成一次增量，限制输出以保持场景等待可控。 */
// 同一 provider 的演化 JSON 也会先输出 reasoning_content；completion token 预算
// 必须同时预留 reasoning 和完整提案正文空间，避免长度截断后的无效 proposal。
export const LIVE_WORLD_EVOLUTION_MAX_TOKENS = RPG_AI_DEFAULT_POLICIES.world.maxTokens ?? 0;

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

// 调查方式安全边界：显式列表必须恰好 2-3 条；张力在 [-5, 20]。
const MIN_APPROACH_COUNT = 2;
const MAX_APPROACH_COUNT = 3;
const MIN_TENSION_DELTA = -5;
const MAX_TENSION_DELTA = 20;

/**
 * 判定软泄漏：label/hint 与事实正文共享 >=2 字符子串（完整正文命中除外，
 * 走硬泄漏）。与 gameplay 审批层的判定一致（词库文案与剧本事实无重合，
 * 确定性路径不会被误伤）。
 */
function sharesFactFragment(candidate: string, factText: string): boolean {
  const t = factText.trim();
  if (t === "" || candidate.trim() === "") return false;
  for (let size = 2; size <= Math.min(8, t.length); size += 1) {
    for (let i = 0; i + size <= t.length; i += 1) {
      if (candidate.includes(t.slice(i, i + size))) return true;
    }
  }
  return false;
}

export type ParsedInvestigationApproaches = {
  readonly approaches: readonly InvestigationApproach[];
  readonly logCategories: readonly string[];
};

/**
 * 解析/校验 AI 提交的 investigationApproaches（世界演化入口，泄漏在此闭环）：
 * - 非数组或缺省 = 自动揭示，不产生日志；
 * - 逐条拒绝：approachId/label/hint 非空、quality 枚举、张力在界内、id 唯一、
 *   硬泄漏（完整正文子串）；
 * - 软泄漏（关键名词重合）或任一条目非法：整组响应失败，记稳定
 *   investigation_approach_invalid；不使用本地词库修补，也不把部分响应转换成成功。
 */
export function parseFactInvestigationApproaches(
  raw: unknown,
  factText: string,
): ParsedInvestigationApproaches | null {
  if (!Array.isArray(raw) || raw.length < MIN_APPROACH_COUNT || raw.length > MAX_APPROACH_COUNT) {
    return null;
  }
  const seenIds = new Set<string>();
  const kept: InvestigationApproach[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    const approachId = typeof entry.approachId === "string" ? entry.approachId.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const hint = entry.hint === undefined ? undefined : typeof entry.hint === "string" ? entry.hint.trim() : "";
    const quality = entry.evidenceQuality === "clean" ? "clean" : entry.evidenceQuality === "noisy" ? "noisy" : null;
    const tensionDelta = typeof entry.tensionDelta === "number" && Number.isFinite(entry.tensionDelta)
      ? entry.tensionDelta
      : null;
    if (approachId === "" || label === "" || hint === "" || quality === null || tensionDelta === null) return null;
    if (tensionDelta < MIN_TENSION_DELTA || tensionDelta > MAX_TENSION_DELTA) return null;
    if (seenIds.has(approachId)) return null;
    const leakTexts = [label, ...(hint === undefined ? [] : [hint])];
    const factTrimmed = factText.trim();
    if (factTrimmed !== "" && leakTexts.some((text) => text.includes(factTrimmed))) return null;
    if (leakTexts.some((text) => sharesFactFragment(text, factText))) return null;
    seenIds.add(approachId);
    kept.push({ approachId, label, ...(hint === undefined ? {} : { hint }), evidenceQuality: quality, tensionDelta });
  }
  return { approaches: kept, logCategories: [] };
}

/** 把 AI 原始 JSON 逐字段解析/校验为合法 WorldDeltaProposal；非法整条丢弃。 */
export function parseWorldDeltaProposal(
  raw: unknown,
  _gameType?: GameTypeId,
): { readonly proposal: WorldDeltaProposal; readonly logCategories: readonly string[] } | null {
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
  let approachCategories: readonly string[] = [];
  if (rec.newFact !== null && rec.newFact !== undefined) {
    if (typeof rec.newFact !== "object" || Array.isArray(rec.newFact)) return null;
    const f = rec.newFact as Record<string, unknown>;
    if (!validText(f.text)) return null;
    const visibility = f.visibility;
    if (visibility !== "public" && visibility !== "npc_private") return null;
    const investigationLabel = f.investigationLabel;
    if (investigationLabel !== undefined && !validName(investigationLabel)) return null;
    const rawApproaches = f.investigationApproaches;
    const parsedApproaches = rawApproaches === undefined
      ? undefined
      : parseFactInvestigationApproaches(rawApproaches, f.text.trim());
    if (parsedApproaches === null) return null;
    approachCategories = parsedApproaches?.logCategories ?? [];
    newFact = {
      text: f.text.trim(),
      visibility,
      ...(investigationLabel === undefined ? {} : { investigationLabel: investigationLabel.trim() }),
      // 缺省字段表示自动揭示；显式列表必须完整通过 source schema 校验。
      ...(parsedApproaches === undefined
        ? {}
        : { investigationApproaches: parsedApproaches.approaches }),
    };
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

  return { proposal: { beatSummary, newLocation, newNpc, newItem, newEnemy, newFact, nextMainQuest, endingPair }, logCategories: approachCategories };
}

/** 引用越权过滤：connectFromLocationId / 现有地点引用必须真实存在（source 层不做审批）。 */
export function filterProposalRefs(proposal: WorldDeltaProposal, ws: WorldState): WorldDeltaProposal | null {
  const locIds = new Set(ws.locations.map((l) => String(l.id)));
  if (proposal.newLocation && !locIds.has(proposal.newLocation.connectFromLocationId)) return null;
  if (proposal.newNpc && proposal.newNpc.locationRef.kind === "existing" && !locIds.has(proposal.newNpc.locationRef.id)) return null;
  return proposal;
}

/** live 世界演化源：AI 提案 → 纯解析/校验/引用过滤 → 失败返回稳定 typed failure。 */
export function createLiveWorldEvolutionSource(deps: WorldEvolutionLiveDeps): WorldEvolutionSource {
  const { transport, config, logger, jsonMode } = deps;
  const aiClient = deps.aiClient ?? (transport && config
    ? createRpgAiClient({
      transport,
      config,
      logger,
      policies: { world: { jsonMode: jsonMode ?? "prompt_only" } },
    })
    : undefined);
  const failWorld = (category: Parameters<typeof classifyAiFailure>[0]["category"]): WorldEvolutionSourceResult => {
    const failure: AiGenerationFailure = classifyAiFailure({ phase: "world", category });
    logger?.warn("world_evolution_failed", { category, kind: failure.kind });
    return { ok: false, failure };
  };

  return {
    async propose(ctx) {
      if (!aiClient) {
        return failWorld("unavailable");
      }
      try {
        const messages = [
          { role: "system" as const, content: buildWorldEvolutionPrompt(ctx) },
          { role: "user" as const, content: userPrompt(ctx) },
        ];
        // 瞬态网络失败由统一 client 按角色策略重试；empty_response 或非法
        // JSON 不再重复相同请求，避免 provider reasoning 失败时重复计费。
        const result = await aiClient.complete("world", messages, {
          purpose: "world_evolution",
          trigger: ctx.reason,
          ...(ctx.auditLink ?? {}),
          action: {
            need: ctx.need,
            ...(ctx.action === undefined ? {} : { action: ctx.action }),
          },
        });
        if (!result.ok) {
          logger?.warn("world_evolution_ai_failed", { code: result.code });
          return failWorld(transportFailureCodeToCategory(result.code));
        }
          const parsed = parseJsonResponse(result.content);
          const rawProposal = typeof parsed === "object" && parsed !== null && "proposal" in parsed
            ? (parsed as Record<string, unknown>).proposal
            : parsed;
          const parsedResult = parseWorldDeltaProposal(rawProposal, ctx.worldState.generation.gameType);
          if (parsedResult !== null) {
            // 解析层修复/降级类别（不含任何事实正文，安全入日志）。
            for (const category of parsedResult.logCategories) {
              logger?.warn(category, {});
            }
            const filtered = filterProposalRefs(parsedResult.proposal, ctx.worldState);
            if (filtered === null) {
              return failWorld("invalid_reference");
            }
            return { ok: true, proposal: filtered };
          }
          logger?.warn("world_evolution_invalid_data");
          return failWorld("invalid_schema");
      } catch (error) {
        logger?.warn("world_evolution_transport_failed", { message: (error as Error)?.message });
        return failWorld("unknown");
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
  const existingLocationIds = worldState.locations.map((location) => String(location.id)).join("、") || "无";
  const setup = worldState.generation.setup;
  const genreGuard = worldState.generation.gameType === "wuxia"
    ? "这是武侠世界：只能使用江湖、门派、镖局、官府、山川、兵器、线索和武学语汇；禁止魔法、巫师、精灵、骑士、幽灵/灵魂、祭坛、法阵、圣光、异界等奇幻或超自然实体。"
    : `题材=${worldState.generation.gameType}，所有实体必须服从该题材，不得跨题材借词。`;
  return `只输出 JSON，不能解释。你为 RPG 生成一次小型世界演化。${genreGuard}
需求=${kindText(ctx.need)}；原因=${ctx.reason}；地点=${currentLoc?.name ?? "未知"}；现有地点ID=${existingLocationIds}；幕=${storyState.currentAct}/${storyState.targetActs}。
世界背景=${setup?.worldPremise ?? worldState.generation.gameType}；故事开端=${setup?.storyOpening ?? "沿用当前主线冲突"}。
外层必须是 {"proposal":{...}}。proposal 必有 beatSummary；未使用字段直接省略，不要写 null。
新地点={"newLocation":{"name":"","description":"","scale":"scene","connectFromLocationId":"现有地点ID"}}。
新NPC={"newNpc":{"name":"","role":"","description":"","locationRef":{"kind":"existing","id":"现有地点ID"}或{"kind":"new_location"},"goals":[""]}}。
新任务={"nextMainQuest":{"name":"","description":"","objectiveText":""}}。
终局={"endingPair":[{"name":"","description":"","themeKey":"trust"},{"name":"","description":"","themeKey":"doubt"}]}。
下一幕必须给新地点、新NPC和新任务；终局必须只给两个不同结局；其他情况只补一个必要实体。名称2-40字、描述200字内。不要创造与题材不符的角色、地点、物品或结局意象。`;
}
