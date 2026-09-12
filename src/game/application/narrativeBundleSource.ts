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
// Task 4：统一叙事生成包源端口。一次 generate 调用返回完整原子包提案。
// 生产注入 liveNarrativeBundleSource；离线注入确定性 fixture。Task 6 的
// NPC 私有判断是独立端口，不能把 privateContext 塞进这个公共场景包。
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
  | BundleCoverageErrorCode;

export type NarrativeBundleRepair = AiContentRepair<NarrativeBundleRepairReason, NarrativeBundleRejection>;

export type OpeningNarrativeBundleProposal = {
  readonly opening: OpeningGenerationCandidate;
  readonly interactionProposals?: readonly import("@/game/domain/storyInteraction").StoryInteractionProposal[];
  readonly currentScene: BundleSceneProposal;
  readonly continuationScenes: readonly [];
  readonly terminal: { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } };
};

export type NarrativeBundleSourceContext =
  | {
    readonly kind: "opening";
    readonly jobId: NarrativeJobId;
    /** 1-based server-owned content version for this complete candidate. */
    readonly candidateVersion?: number;
    readonly input: OpeningGenerationInput;
    readonly auditLink?: AiTextAuditLink;
    readonly contentRepair?: NarrativeBundleRepair;
  }
  | {
    readonly kind: "decision";
    /** 1-based server-owned content version for this complete candidate. */
    readonly candidateVersion?: number;
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

// Keep the NPC deliberation boundary discoverable beside the public bundle
// port without making a bundle source responsible for private NPC calls.
export type {
  NpcDeliberationInput,
  NpcDeliberationProposal,
  NpcDeliberationResponse,
  NpcDeliberationSource,
} from "./npcDeliberationSource";

// Re-export domain types for convenience
export type {
  NarrativeBundleProposal,
  NarrativeBundleTerminal,
  BundleSceneProposal,
  BundleStepProposal,
};
