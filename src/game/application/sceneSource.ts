import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";

/**
 * SceneGenerator 的事件提议（spec §7.4 newEvents）。
 * R4 后为结构化候选事件（含可执行 proposedEffects），由场景写回阶段独立审批。
 * Task 6：事件提议不再随场景表演契约传递；场景只负责表现层。
 */
export type EventProposal = EventCandidate;

/** 场景表演的一段旁白：必须对应服务端提供的强制节拍 ID（atmosphere 可选且最后）。 */
export type ScenePerformanceSegment = {
  readonly beatId: string;
  readonly text: string;
  /**
   * 可选的结构化叙事引用。它只用于 grounding 质量诊断，不能替代
   * mandatory beat/objectiveLink，也不能由客户端消费或执行。
   */
  readonly referencedEntityIds?: readonly string[];
};

/** 焦点 NPC 的台词：所有引用（事实/交互）必须归属该 NPC 的允许集合。 */
export type ScenePerformanceNpcLine = {
  readonly npcId: string;
  readonly text: string;
  readonly emotion: NarrativeEmotion;
  /** Task 5：该台词应答的强制节拍 ID（player_utterance 必须命中）。 */
  readonly answeredBeatIds: readonly string[];
  /** 仅允许该 NPC known ∪ scene-visible 的事实；私密/未知事实 → 整场拒绝。 */
  readonly usedFactIds: readonly string[];
  /** 仅允许该 NPC 自己最近的交互 actionId；引用他人交互 → 整场拒绝。 */
  readonly usedInteractionActionIds: readonly string[];
};

/** 同一场景 API 为非焦点 NPC 生成的零回合闲聊台词。 */
export type ScenePerformanceNpcDialogue = {
  readonly npcId: string;
  readonly text: string;
};

/** objectiveLink 必须与 ObjectiveTransition.after 一致（无 after 时必须为 null）。 */
export type ScenePerformanceObjectiveLink = {
  readonly questId: string;
  readonly objectiveIndex: number;
  readonly mode: "hint" | "progress" | "handoff";
};

/**
 * 单线行动（investigate/move）的 AI 预生成叙事（Task 1）。
 * 仅 live 提案携带；随审批持久化后由 fast path 消费，offline fixture 提案不携带。
 * 引用必须命中 SceneGenerationContext.upcomingLinearObjectives 的权威实体。
 */
export type LinearActionNarrative =
  | { readonly actionKind: "investigate"; readonly factId: string; readonly narration: string }
  | {
      readonly actionKind: "move";
      readonly locationId: string;
      readonly narration: string;
      /** 移动抵达后即将成为主线目标的 NPC 首句；随同移动预生成，不创建回合。 */
      readonly arrivalNpcLine?: LinearActionNpcLine;
    };

export type LinearActionNpcLine = {
  readonly npcId: string;
  readonly text: string;
  readonly emotion: NarrativeEmotion;
  readonly usedFactIds: readonly string[];
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
  /** 普通场景为两个选项；对话完成交接场景严格为一个唯一下一步。 */
  readonly choices: readonly { readonly candidateId: string; readonly label: string }[];
  /** Task 1：仅 live 提案携带的 AI 预生成单线行动叙事；随审批持久化后由 fast path 消费。 */
  readonly linearActionNarratives?: readonly LinearActionNarrative[];
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
      readonly repairReason?: "empty_response" | "invalid_json" | "invalid_schema";
    };

/** 可注入的叙事场景 source。显式离线 fixture 返回 ok:true + fixture proposal；live source 失败返回 ok:false。 */
export type SceneSource = {
  generateScene(context: SceneGenerationContext): Promise<SceneSourceResult>;
};
