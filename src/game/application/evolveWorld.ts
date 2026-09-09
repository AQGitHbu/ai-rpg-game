import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type {
  EvolutionNeed,
  ApprovedWorldDelta,
  WorldDeltaEntityContextClosure,
  WorldDeltaProposal,
  WorldDeltaEventContext,
} from "@/game/domain/worldDelta";
import type { WorldEvolutionContentRepair, WorldEvolutionSource, WorldEvolutionSourceContext } from "./worldEvolutionSource";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
import {
  approveWorldDelta,
  materializeWorldDelta,
  type ApprovedWorldDeltaCore,
  type WorldDeltaIdOverride,
  type WorldDeltaRejection,
} from "@/game/gameplay/rpg/worldEvolution";
import { runBoundedAttempts } from "@/game/core/retry";

// ---------------------------------------------------------------------------
// Template：application 层世界演化编排。纯触发（需求已由领域派生）→（条件）
// await source 提案 → 纯审批/装配预览状态；不写状态、不做 AI 内置。
// 最多两轮循环（初次 + 一次 content repair）统一覆盖"source 解析失败"与
// "approveWorldDelta 拒绝"；transport/不可用/空响应不进内容修复循环，修复耗尽
// 统一返回稳定失败，不在 application 层悄悄创建 deterministic source。
// ---------------------------------------------------------------------------

export type EvolveWorldResult =
  | {
      readonly ok: true;
      readonly proposal: WorldDeltaProposal;
      readonly approved: ApprovedWorldDeltaCore;
      readonly delta: ApprovedWorldDelta;
    }
  | {
      readonly ok: false;
      readonly code: "no_need" | "no_proposal" | "rejected" | "source_error";
      readonly rejectionCode?: WorldDeltaRejection;
      readonly failure?: AiGenerationFailure;
    };

export type EvolveWorldInput = {
  readonly need: EvolutionNeed;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly source?: WorldEvolutionSource;
  readonly action?: Action;
  readonly reason: string;
  /** 回合修复路径：把行动引用 ID 原样铸造为缺失实体 ID（只作用于匹配 kind）。 */
  readonly idOverride?: WorldDeltaIdOverride;
  readonly entityContextClosure?: WorldDeltaEntityContextClosure;
  /** 仅用于关联 world AI 审计事件，不进入世界状态。 */
  readonly auditLink?: AiTextAuditLink;
  /** 规则回合事件上下文；世界草稿不得脱离本回合因果链。 */
  readonly eventContext?: WorldDeltaEventContext;
  readonly now: () => string;
};

/** 按行动类型推导回合修复路径所需的 ID 覆写（与确定性 source 的类别映射一致）。 */
export function repairIdOverrideForAction(action: Action): WorldDeltaIdOverride | undefined {
  switch (action.type) {
    case "talk": return { kind: "npc", id: String(action.npcId) };
    case "move": return { kind: "location", id: String(action.locationId) };
    case "investigate": return { kind: "fact", id: String(action.factId) };
    case "take_item": return { kind: "item", id: String(action.itemId) };
    case "attack": return { kind: "enemy", id: String(action.enemyId) };
    default: return undefined;
  }
}

export async function evolveWorld(input: EvolveWorldInput): Promise<EvolveWorldResult> {
  if (input.need.kind === "none") {
    return { ok: false, code: "no_need" };
  }

  const source: WorldEvolutionSource | undefined = input.source;

  const context: WorldEvolutionSourceContext = {
    worldState: input.worldState,
    storyState: input.storyState,
    need: input.need,
    action: input.action,
    reason: input.reason,
    auditLink: input.auditLink,
  };

  if (source === undefined) {
    return {
      ok: false,
      code: "source_error",
      failure: { kind: "AI_CALL_FAILED", phase: "world" },
    };
  }

  try {
    let terminalResult: EvolveWorldResult = {
      ok: false,
      code: "source_error",
      failure: { kind: "AI_CALL_FAILED", phase: "world" },
    };
    const bounded = await runBoundedAttempts<
      Extract<EvolveWorldResult, { readonly ok: true }>,
      WorldEvolutionContentRepair
    >({
      maxAttempts: 2,
      runAttempt: async (attempt, repair) => {
        const sourceResult = await source.propose({ ...context, contentRepair: attempt === 1 ? undefined : repair });

        if (!sourceResult.ok) {
          terminalResult = { ok: false, code: "source_error", failure: sourceResult.failure };
          if (attempt === 1 && sourceResult.repairReason !== undefined) {
            // repairFromSourceFailure 的 reason 联合包含 provider_failure/invalid_schema
            // 兜底，而本分支已确定携带 source 自身的世界演化稳定原因，直接构造
            // WorldEvolutionContentRepair，避免类型收窄用的冗余覆盖。
            return {
              ok: false,
              retryable: true,
              reason: {
                attempt,
                reason: sourceResult.repairReason,
                ...(sourceResult.repairDetail === undefined ? {} : { detail: sourceResult.repairDetail }),
              },
            };
          }
          return { ok: false, retryable: false, reason: repair ?? { attempt: 1, reason: "invalid_schema" } };
        }

        if (sourceResult.proposal === null) {
          terminalResult = {
            ok: false,
            code: "no_proposal",
            failure: { kind: "AI_RESPONSE_INVALID", phase: "world" },
          };
          return attempt === 1
            ? { ok: false, retryable: true, reason: { attempt: 1, reason: "invalid_schema" } }
            : { ok: false, retryable: false, reason: repair ?? { attempt: 1, reason: "invalid_schema" } };
        }

        const approval = approveWorldDelta({
          proposal: sourceResult.proposal,
          need: input.need,
          ws: input.worldState,
          ss: input.storyState,
          idOverride: input.idOverride,
          entityContextClosure: input.entityContextClosure,
        });
        if (!approval.ok) {
          terminalResult = {
            ok: false,
            code: "rejected",
            rejectionCode: approval.code,
            failure: { kind: "AI_RESPONSE_INVALID", phase: "world" },
          };
          return attempt === 1
            ? { ok: false, retryable: true, reason: { attempt: 1, reason: "approval_rejected", rejectionCode: approval.code } }
            : { ok: false, retryable: false, reason: repair ?? { attempt: 1, reason: "approval_rejected", rejectionCode: approval.code } };
        }

        const delta = materializeWorldDelta({
          approved: approval.approved,
          need: input.need,
          ws: input.worldState,
          ss: input.storyState,
          now: input.now,
          eventContext: input.eventContext,
        });
        const success = { ok: true as const, proposal: sourceResult.proposal, approved: approval.approved, delta };
        terminalResult = success;
        return { ok: true, value: success };
      },
    });
    return bounded.ok ? bounded.value : terminalResult;
  } catch {
    return {
      ok: false,
      code: "source_error",
      failure: { kind: "AI_CALL_FAILED", phase: "world" },
    };
  }
}
