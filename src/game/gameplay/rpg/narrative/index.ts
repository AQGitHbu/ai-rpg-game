// ---------------------------------------------------------------------------
// narrative gameplay facade（Phase 10 Task 2）：
// application 可用的唯一 narrative 入口。禁止 deep import 内部文件。
// ---------------------------------------------------------------------------

export {
  actionKeyOf,
  toNarrativeActionCandidates,
  findAvailableActionByKey,
} from "./actionCandidates";

export {
  approveDirectorProposal,
  type ApproveDirectorProposalInput,
  type DirectorProposal,
  type ApprovedDirectorPlan,
} from "./approveDirectorProposal";

export {
  approveSceneScript,
  type ApproveSceneScriptInput,
  type ApprovedSceneScript,
  type SceneScriptProposal,
} from "./approveSceneScript";

export { approveNpcPerformance } from "./approveNpcPerformance";

export {
  type NarrativeActionCandidate,
  type NpcPerformanceProposal,
  type NarrativeApprovalCategory,
  type NarrativeApprovalResult,
} from "./types";

export {
  reconcileStoryMemory,
  type ReconcileStoryMemoryInput,
} from "./reconcileStoryMemory";

export {
  deriveContentProgression,
  type ContentProgression,
  type DeriveContentProgressionInput,
} from "./contentProgression";
