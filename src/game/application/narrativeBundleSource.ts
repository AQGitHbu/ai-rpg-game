import type { AiContentRepair, AiSourceFailure } from "./aiGenerationRetry";
import type { NarrativeGenerationRepairReason } from "@/game/domain/narrativeGenerationFailure";
import type { NarrativeJobId } from "@/game/domain/events";
import type {
  NarrativeBundleProposal,
  NarrativeBundleTerminal,
  BundleSceneProposal,
  BundleStepProposal,
} from "@/game/domain/narrativeBundle";
import type { BundleCoverageErrorCode } from "@/game/gameplay/rpg/narrativeBundle";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { OpeningGenerationInput } from "./createGame";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";

// ---------------------------------------------------------------------------
// 统一叙事生成包源端口（历史整包契约）。
//
// Task 10 起生产装配只走分阶段源（narrativeGeneration/stageSource +
// liveStageSource）；本端口保留给尚未迁移的离线/质量测试，不再是生产
// 回退路径。依赖守卫（dependencyBoundaries）钉死生产代码不再导入
// server/ai/liveNarrativeBundleSource。
// 不含 IO 编排、审批或状态写回——那些由 approveNarrativeBundle 和上层协调。
// ---------------------------------------------------------------------------

export type NarrativeBundleRepairReason =
  | NarrativeGenerationRepairReason
  | "provider_failure"
  | "context_budget_exceeded"
  | "invalid_json"
  | "invalid_schema"
  | "invalid_reference"
  | "coverage_rejected"
  | "approval_rejected";

export type NarrativeBundleRejection =
  | "world_delta_rejected"
  | "bundle_missing_step"
  | "bundle_unknown_step"
  | "bundle_duplicate_step"
  | "bundle_invalid_reference"
  | "bundle_invalid_scene"
  | "bundle_invalid_terminal"
  | "invented_beat_id"
  | "missing_mandatory_beat"
  | "out_of_order_beats"
  | "player_utterance_unanswered"
  | "dialogue_focus_line_missing"
  | "objective_link_mismatch"
  | "staged_dependency_unmet"
  | "bundle_ending_labels_missing"
  | BundleCoverageErrorCode;

export type NarrativeBundleRepair = AiContentRepair<NarrativeBundleRepairReason, NarrativeBundleRejection>;

export type OpeningNarrativeBundleProposal = {
  readonly opening: OpeningGenerationCandidate;
  readonly currentScene: BundleSceneProposal;
  readonly continuationScenes: readonly [];
  readonly terminal: { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } };
};

export type NarrativeBundleSourceContext =
  | {
    readonly kind: "opening";
    readonly jobId: NarrativeJobId;
    readonly input: OpeningGenerationInput;
    readonly auditLink?: AiTextAuditLink;
    readonly contentRepair?: NarrativeBundleRepair;
  }
  | {
    readonly kind: "decision";
    readonly worldState: WorldState;
    readonly storyState: StoryState;
    readonly job: PendingNarrativeJob;
    readonly auditLink?: AiTextAuditLink;
    readonly contentRepair?: NarrativeBundleRepair;
  };

export type NarrativeBundleSourceResult =
  | { readonly ok: true; readonly kind: "opening"; readonly proposal: OpeningNarrativeBundleProposal }
  | { readonly ok: true; readonly kind: "decision"; readonly proposal: NarrativeBundleProposal }
  | AiSourceFailure<NarrativeBundleRepairReason>;

export type NarrativeBundleSource = {
  generate(context: NarrativeBundleSourceContext): Promise<NarrativeBundleSourceResult>;
};

// Re-export domain types for convenience
export type {
  NarrativeBundleProposal,
  NarrativeBundleTerminal,
  BundleSceneProposal,
  BundleStepProposal,
};
