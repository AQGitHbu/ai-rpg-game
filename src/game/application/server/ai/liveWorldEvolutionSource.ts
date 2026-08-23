import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { WorldEvolutionContentRepair, WorldEvolutionRepairReason, WorldEvolutionSource, WorldEvolutionSourceContext, WorldEvolutionSourceResult } from "../../worldEvolutionSource";
import type { WorldDeltaProposal, DynamicLocationPlacement } from "@/game/domain/worldDelta";
import type { WorldState, InvestigationApproach } from "@/game/domain/worldState";
import type { GameTypeId } from "@/game/domain/newGame";
import { createRpgAiClient, RPG_AI_DEFAULT_POLICIES, type RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import { classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import { compileWorldNarrativeContext } from "./narrativeContext";
import type { NarrativePromptCompilation } from "./narrativeContext";

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

export type ParsedInvestigationApproaches = {
  readonly approaches: readonly InvestigationApproach[];
  readonly logCategories: readonly string[];
};

/**
 * 解析/校验 AI 提交的 investigationApproaches（世界演化入口，泄漏在此闭环）：
 * - 非数组或缺省 = 自动揭示，不产生日志；
 * - 逐条拒绝：approachId/label/hint 非空、quality 枚举、张力在界内、id 唯一、
 *   硬泄漏（完整正文子串）；
 * - label/hint 可以复用事实中的地点、人物和线索关键词；只有完整事实正文
 *   出现在 label/hint 中时才拒绝，避免把正常的调查入口误判为泄漏。
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
    const placement: DynamicLocationPlacement | null = l.placement === "world"
      ? "world"
      : l.placement === "town_building"
        ? "town_building"
        : null;
    if (placement === null) return null;
    if (!validName(l.name) || !validText(l.description)) return null;
    if (scale !== "scene" && scale !== "town") return null;
    if (!isStr(l.connectFromLocationId) || l.connectFromLocationId.trim() === "") return null;
    newLocation = {
      name: l.name.trim(),
      description: l.description.trim(),
      scale,
      placement,
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
  if (proposal.newLocation?.placement === "town_building") {
    const parent = ws.locations.find((location) => String(location.id) === proposal.newLocation!.connectFromLocationId);
    if (
      parent === undefined
      || parent.id !== ws.currentLocationId
      || parent.scale !== "town"
      || parent.town === undefined
      || proposal.newNpc?.locationRef.kind !== "new_location"
    ) return null;
  }
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
  const failWorld = (
    category: Parameters<typeof classifyAiFailure>[0]["category"],
    repairReason?: WorldEvolutionRepairReason,
  ): WorldEvolutionSourceResult => {
    const failure: AiGenerationFailure = classifyAiFailure({ phase: "world", category });
    logger?.warn("world_evolution_failed", { category, kind: failure.kind });
    return repairReason === undefined
      ? { ok: false, failure }
      : { ok: false, failure, repairReason };
  };

  /**
   * 审计 reason：审批拒绝用 `approval_rejected:<code>` 保留稳定 code，
   * 其余直接使用解析器稳定原因。该字符串只进审计/诊断字段，不进玩家可见正文。
   */
  function repairAuditReason(repair: WorldEvolutionContentRepair): string {
    if (repair.reason === "approval_rejected") {
      return repair.approvalCode === undefined
        ? "approval_rejected"
        : `approval_rejected:${repair.approvalCode}`;
    }
    return repair.reason;
  }

  return {
    async propose(ctx) {
      if (!aiClient) {
        return failWorld("unavailable");
      }
      try {
        const compilation = compileLiveWorldEvolutionPrompt(ctx);
        const messages = [
          { role: "system" as const, content: compilation.prompt },
          { role: "user" as const, content: userPrompt(ctx) },
        ];
        // 瞬态网络失败由统一 client 按角色策略重试；empty_response 或非法
        // JSON 不再重复相同请求，避免 provider reasoning 失败时重复计费。
        // content repair（由 application 层控制预算）通过 retry.origin/mechanism
        // 标记为 content_repair，传输层 only 保留 origin/mechanism/attempt/reason。
        const repairRetry = ctx.contentRepair === undefined
          ? undefined
          : {
              origin: ctx.auditLink?.retry?.origin ?? "normal",
              mechanism: "content_repair" as const,
              attempt: ctx.contentRepair.attempt,
              reason: repairAuditReason(ctx.contentRepair),
            };
        const result = await aiClient.complete("world", messages, {
          purpose: "world_evolution",
          trigger: ctx.reason,
          ...(ctx.auditLink ?? {}),
          ...(repairRetry === undefined ? {} : { retry: repairRetry }),
          action: {
            need: ctx.need,
            ...(ctx.action === undefined ? {} : { action: ctx.action }),
          },
          narrativeContext: compilation.manifest,
        });
        if (!result.ok) {
          logger?.warn("world_evolution_ai_failed", { code: result.code });
          return failWorld(transportFailureCodeToCategory(result.code));
        }
          const parsed = parseJsonResponse(result.content);
          if (parsed === null) {
            logger?.warn("world_evolution_invalid_json");
            return failWorld("invalid_json", "invalid_json");
          }
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
              return failWorld("invalid_reference", "invalid_reference");
            }
            return { ok: true, proposal: filtered };
          }
          logger?.warn("world_evolution_invalid_data");
          return failWorld("invalid_schema", "invalid_schema");
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

export function compileLiveWorldEvolutionPrompt(
  ctx: WorldEvolutionSourceContext,
): NarrativePromptCompilation {
  return compileWorldNarrativeContext(ctx);
}

/** Compatibility entry point for prompt-only callers and existing fixtures. */
export function buildWorldEvolutionPrompt(ctx: WorldEvolutionSourceContext): string {
  return compileLiveWorldEvolutionPrompt(ctx).prompt;
}
