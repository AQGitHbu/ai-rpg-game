import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
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
// Task 4：统一叙事生成包源端口。一次 generate 调用返回完整原子包提案。
// 生产注入 liveNarrativeBundleSource（Task 5），离线注入确定性 fixture。
// 不含 IO 编排、审批或状态写回——那些由 approveNarrativeBundle 和上层协调。
// ---------------------------------------------------------------------------

export type NarrativeBundleRepairReason =
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
  | BundleCoverageErrorCode;

export type NarrativeBundleRepair = {
  readonly attempt: 1;
  readonly reason: NarrativeBundleRepairReason;
  readonly rejectionCode?: NarrativeBundleRejection;
  /** 规则引擎细分理由（如 `duplicate_name:enemy`）；只用于提示修复方向。 */
  readonly detail?: string;
};

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
  | {
    readonly ok: false;
    readonly failure: AiGenerationFailure;
    readonly repairReason?: NarrativeBundleRepairReason;
    /** 规则引擎细分理由（如契约原因 terminal_step_requires_two_choices）；只用于修复提示。 */
    readonly repairDetail?: string;
  };

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
