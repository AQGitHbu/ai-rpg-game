export {
  applyEntityMutations,
  EntityMutationInvariantError,
  // 常驻公共面（与上面那个临时导出不同）：Fact / NPC 的存在性只由这份 active-only 派生裁决，
  // 规则层的传播与 record_npc_knowledge 因此共用同一把尺子；它只读 records，不开任何写通道。
  knowledgeReferences,
  type ApplyEntityMutationsResult,
  type EntityMutation,
  type NpcInteractionPayload,
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
