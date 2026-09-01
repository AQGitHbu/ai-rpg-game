import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type {
  AiGenerationFailure,
  NarrativeGenerationRepairReason,
} from "@/game/domain/narrativeGenerationFailure";

// Re-export pure value types that were moved to domain/narrativeBundle.ts.
// These re-exports are temporary — Task 10 deletes this file after all
// consumers import from domain/narrativeBundle.ts directly.
export type {
  ScenePerformanceSegment,
  ScenePerformanceNpcLine,
  ScenePerformanceNpcDialogue,
  ScenePerformanceObjectiveLink,
} from "@/game/domain/narrativeBundle";

import type {
  ScenePerformanceSegment,
  ScenePerformanceNpcLine,
  ScenePerformanceNpcDialogue,
  ScenePerformanceObjectiveLink,
} from "@/game/domain/narrativeBundle";

// Re-export for backwards compatibility of type references in this file
// (the types below use them in their own definitions).

/**
 * SceneGenerator 的事件提议（spec §7.4 newEvents）。
 * R4 后为结构化候选事件（含可执行 proposedEffects），由场景写回阶段独立审批。
 * Task 6：事件提议不再随场景表演契约传递；场景只负责表现层。
 */
export type EventProposal = EventCandidate;

/** One provider-authored scene seed; graph identity and actions remain server-owned. */
export type PreparedContinuationProposal = {
  readonly stepId: string;
  readonly segments: readonly ScenePerformanceSegment[];
  readonly npcLine: ScenePerformanceNpcLine | null;
  readonly objectiveLink: ScenePerformanceObjectiveLink | null;
  readonly choices: readonly { readonly candidateId: string; readonly label: string }[];
  readonly source?: "generated" | "fixture";
};

/**
 * Task 5：已结算调查结果（investigate 主动选择后由规则层写入 eventLedger）。
 * 只携带叙事所需的权威标签：所选方式、证据质量与下一目标实体名。
 * 不含 approachId 之外的裁决字段，绝不含 tensionDelta；客户端不得读取或计算。
 */
export type SceneInvestigationResult = {
  readonly factId: string;
  readonly approachLabel: string;
  readonly evidenceQuality: "clean" | "noisy";
  readonly nextObjectiveLabel?: string;
};

/**
 * 场景表演契约（spec §10.3，Task 6）。
 * 只描述"如何表演"：旁白分段、焦点台词、目标链接与合法选项 ID。
 * 不含事件、不含完整状态、不含任意 path；所有实体 ID 由服务端权威下发。
 */
export type ScenePerformanceProposal = {
  readonly sceneId: string;
  readonly segments: readonly ScenePerformanceSegment[];
  readonly npcLine: ScenePerformanceNpcLine | null;
  /** 由同一次 live scene API 生成的非焦点 NPC 台词，不创建回合。 */
  readonly npcDialogues?: readonly ScenePerformanceNpcDialogue[];
  readonly objectiveLink: ScenePerformanceObjectiveLink | null;
  /** 普通场景为两个选项；最终交接场景为零个可执行选项。 */
  readonly choices: readonly { readonly candidateId: string; readonly label: string }[];
  /** Local acknowledgement for a final NPC handoff; it is never an executable choice. */
  readonly handoffAcknowledgement?: string;
  /** Atomic server-authored continuation seeds through the next NPC boundary. */
  readonly preparedContinuations: readonly PreparedContinuationProposal[];
  /** Task 5：本回合已结算调查结果的叙事上下文；仅 investigate + 已结算时携带。 */
  readonly investigationResult?: SceneInvestigationResult;
  readonly source: "generated" | "fixture";
};

/** 从场景上下文投影已结算调查结果（无结果时返回 undefined）。 */
export function sceneInvestigationResultFrom(
  context: SceneGenerationContext,
): SceneInvestigationResult | undefined {
  const resolved = context.resolvedInvestigation;
  if (resolved === undefined) return undefined;
  return {
    factId: String(resolved.factId),
    approachLabel: resolved.approachLabel,
    evidenceQuality: resolved.evidenceQuality,
    ...(context.objectiveTarget === null ? {} : { nextObjectiveLabel: context.objectiveTarget.entityName }),
  };
}

/**
 * 场景 source 结果：成功返回 generated proposal，失败返回稳定 AiGenerationFailure。
 * 失败时不返回 fallback 正文，也不把 deterministic scene 标记成 generated。
 */
export type SceneSourceResult =
  | { readonly ok: true; readonly proposal: ScenePerformanceProposal }
  | {
      readonly ok: false;
      readonly failure: AiGenerationFailure;
      /** Source reports the repairable content reason; the caller owns the budget. */
      readonly repairReason?: NarrativeGenerationRepairReason;
    };

/** 可注入的叙事场景 source。显式离线 fixture 返回 ok:true + fixture proposal；live source 失败返回 ok:false。 */
export type SceneSource = {
  generateScene(context: SceneGenerationContext): Promise<SceneSourceResult>;
};
