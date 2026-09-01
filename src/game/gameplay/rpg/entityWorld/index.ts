export {
  applyEntityMutations,
  EntityMutationInvariantError,
  // 临时公共面：只有 dialogueResolution 的 summaryFor 转发还在用它。
  // Task 5C 把对话改线到 record_npc_interaction 后，这个导出一并收回（模板归本文件内部）。
  formatNpcInteractionSummary,
  type ApplyEntityMutationsResult,
  type EntityMutation,
  type EntityMutationErrorCode,
  type KnowledgeMutationSource,
  type RelationshipMutationSource,
} from "./entityMutation";
export {
  approveProposedEntityCommands,
  entityMutationsForApprovedCommands,
  parseProposedEntityCommands,
  type ApprovedEntityCommand,
  type ApproveProposedEntityCommandsResult,
  type EntityCommandApprovalContext,
  type EntityCommandProvenance,
  type ParseProposedEntityCommandsResult,
  type ProposedEntityCommand,
} from "./proposedEntityCommand";
