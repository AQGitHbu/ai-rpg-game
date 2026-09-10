import type { AiTransport, AiTransportConfig } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { WorldEvolutionRepairReason, WorldEvolutionSource, WorldEvolutionSourceContext, WorldEvolutionSourceResult } from "../../worldEvolutionSource";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createRpgAiClient, RPG_AI_DEFAULT_POLICIES, type RpgAiClient } from "./rpgAiClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import { classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import { createAiSourceFailure, aiRepairAuditContext } from "../../aiGenerationRetry";
import { compileWorldNarrativeContext } from "./narrativeContext";
import type { NarrativePromptCompilation } from "./narrativeContext";
import { parseStructuredJsonObject } from "@/game/core/json";
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

// 世界变化提案的 parser 归属 domain（见 domain/worldDeltaProposal.ts）：
// 本文件只 import/re-export 同一实现，不复制一份产生两套校验语义。规则过滤
// （filterProposalRefs）仍留在本层，不在 domain 复制。
import { hasExactKeys, parseWorldDeltaProposal } from "@/game/domain/worldDeltaProposal";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";

export {
  parseFactInvestigationApproaches,
  parseWorldDeltaProposal,
  type ParsedInvestigationApproaches,
} from "@/game/domain/worldDeltaProposal";

/** 引用越权过滤：connectFromLocationId / 现有地点引用必须真实存在（source 层不做审批）。 */
export function filterProposalRefs(
  proposal: WorldDeltaProposal,
  ws: WorldState,
  storyState?: StoryState,
): WorldDeltaProposal | null {
  const locIds = new Set(ws.locations.map((l) => String(l.id)));
  if (proposal.newLocation && !locIds.has(proposal.newLocation.connectFromLocationId)) return null;
  if (proposal.newNpc && proposal.newNpc.locationRef.kind === "existing" && !locIds.has(proposal.newNpc.locationRef.id)) return null;

  // Provider 偶尔会在续幕提案中把已经在场的角色再作为 newNpc 回传（通常还会
  // 错把它留在旧地点）。这不是新的剧情事实；若交给审批器，会先因空间约束
  // 被拒绝，随后又让同一条错误角色反复消耗人工重试。保留 AI 生成的地点、
  // 线索和任务，只去掉这条与当前世界完全重名的“新增”声明。这样没有合成
  // 任何玩家可见文本，也不会把旧 NPC 静默搬到新地点。
  const duplicateNpc = proposal.newNpc !== null
    && ws.npcs.some((npc) => npc.name.trim() === proposal.newNpc!.name.trim());
  // 物品、敌人和事实共用 events 预算。容量已用尽时，它们不能成为本次续幕
  // 的锚点；剔除这些可选增量仍保留 AI 给出的主线地点/角色/任务，避免同一
  // 正文因可预判的预算溢出反复失败。未传入 storyState 的纯引用校验调用不做
  // 此归一化。
  const eventCapacityExhausted = storyState !== undefined
    && storyState.budget.events.expanded >= storyState.budget.events.max;
  const normalized = {
    ...proposal,
    ...(duplicateNpc ? { newNpc: null } : {}),
    ...(eventCapacityExhausted
      ? { newItem: null, newEnemy: null, newFact: null }
      : {}),
  };
  if (normalized.newLocation?.placement === "town_building") {
    const parent = ws.locations.find((location) => String(location.id) === normalized.newLocation!.connectFromLocationId);
    if (
      parent === undefined
      || parent.id !== ws.currentLocationId
      || parent.scale !== "town"
      || parent.town === undefined
      || normalized.newNpc?.locationRef.kind !== "new_location"
    ) return null;
  }
  return normalized;
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
    const result = createAiSourceFailure("world", category, repairReason);
    logger?.warn("world_evolution_failed", { category, kind: result.failure.kind });
    return result;
  };


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
        const repairRetry = ctx.contentRepair === undefined ? undefined : aiRepairAuditContext(ctx.contentRepair, ctx.auditLink?.retry);
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
          const parsed = parseStructuredJsonObject(result.content);
          if (!parsed.ok) {
            logger?.warn("world_evolution_invalid_json");
            return parsed.reason === "root_not_object"
              ? failWorld("invalid_schema", "invalid_schema")
              : failWorld("invalid_json", "invalid_json");
          }
          if (parsed.normalization === "json_fence") {
            logger?.warn("world_evolution_json_fence_normalized");
          }
          const isWrapped = "proposal" in parsed.value;
          if (isWrapped && !hasExactKeys(parsed.value, ["proposal"])) {
            logger?.warn("world_evolution_invalid_wrapper");
            return failWorld("invalid_schema", "invalid_schema");
          }
          const rawProposal = isWrapped ? parsed.value.proposal : parsed.value;
          const parsedResult = parseWorldDeltaProposal(rawProposal, ctx.worldState.generation.gameType);
          if (parsedResult !== null) {
            // 解析层修复/降级类别（不含任何事实正文，安全入日志）。
            for (const category of parsedResult.logCategories) {
              logger?.warn(category, {});
            }
            const filtered = filterProposalRefs(parsedResult.proposal, ctx.worldState, ctx.storyState);
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
