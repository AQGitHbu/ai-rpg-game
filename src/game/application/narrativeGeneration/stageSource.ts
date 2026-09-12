// 分阶段生成的 stage source 端口（Spec 2026-09-09 / Plan Task 5）。
//
// 本文件是纯类型端口：StageSource 的实现（liveStageSource）在 server/ai 层，
// 编排（Task 8 的 runJob）只依赖本端口。端口不导入 transport，不持有 IO；
// AiContentRepair/AiSourceFailure 复用 aiGenerationRetry，审计类型复用
// textAuditTypes，不重复定义错误 envelope。

import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { Stage, UnitOutput } from "@/game/domain/narrativeUnit";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { AiContentRepair, AiSourceFailure } from "@/game/application/aiGenerationRetry";
import type { AiTextAuditContext } from "../server/ai/textAuditTypes";
import type { OpeningGenerationInput } from "@/game/application/createGame";
import type { SafeContext } from "./perspectiveContext";
import type { DisclosureReviewRequest } from "./disclosureReview";

export type DialogueHistoryEntry = Readonly<{
  readonly previousReply: string;
  readonly previousChoices: readonly string[];
  readonly selectedDialogue: Readonly<{
    readonly label: string;
    readonly dialogueAct: NonNullable<PendingNarrativeJob["selectedDialogue"]>["dialogueAct"];
    readonly topic?: NonNullable<PendingNarrativeJob["selectedDialogue"]>["topic"];
  }>;
}>;

/** planning 的两种上下文：开局规划消费开局输入；决策规划消费权威状态与 job。 */
export type PlanningContext =
  | {
    readonly kind: "opening";
    readonly input: OpeningGenerationInput;
    /**
     * durable 初始化输入的生成元数据：结构编译（compileOpeningStructure）只从
     * 这里取 generation/seed，绝不从当前世界或已安装叙事反推。
     */
    readonly generation: import("@/game/domain/worldEntity").GenerationMetadata;
  }
  | {
    readonly kind: "decision";
    readonly world: WorldState;
    readonly story: StoryState;
    readonly job: PendingNarrativeJob;
    /** 同一 NPC 的有界已展示历史；只供 planning 理解连续对话，不写回存档或参与审批。 */
    readonly dialogueHistory?: readonly DialogueHistoryEntry[];
  };

export type ExpressionStage = Exclude<Stage, "planning">;

/** 一次 stage 生成请求：planning 产骨架，表达阶段消费 SafeContext。 */
export type StageRequest =
  | { readonly stage: "planning"; readonly context: PlanningContext }
  | { readonly stage: ExpressionStage; readonly context: SafeContext };

/** planning 成功返回已解析提案（未审批）；表达成功返回已解析单元输出。 */
export type StageSuccess =
  | { readonly ok: true; readonly stage: "planning"; readonly value: PlanProposal }
  | { readonly ok: true; readonly stage: ExpressionStage; readonly value: UnitOutput };

/** 每次 generate 的执行约束：取消信号与剩余预算由编排层给定。 */
export type StageExecution = Readonly<{
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly repair?: AiContentRepair;
  readonly audit: AiTextAuditContext;
}>;

/**
 * 单次 stage 生成端口。每个 stage 恰好一次 provider 调用，无共享会话；
 * 失败一律返回 AiSourceFailure，不抛出传输异常。
 */
export type StageSource = {
  /** 不是生成阶段；缺少端口时仅允许无新增披露的单元。 */
  reviewDisclosure?(
    request: DisclosureReviewRequest, execution: StageExecution,
  ): Promise<{ readonly ok: true; readonly verdict: "pass" | "reject" | "uncertain" } | AiSourceFailure>;
  reviewDialogueConsistency?(request: import("./dialogueConsistencyReview").DialogueConsistencyReviewRequest, execution: StageExecution): Promise<({ readonly ok: true } & import("./dialogueConsistencyReview").PolishReviewVerdict) | AiSourceFailure>;
  generate(
    request: StageRequest,
    execution: StageExecution,
  ): Promise<StageSuccess | AiSourceFailure>;
};
