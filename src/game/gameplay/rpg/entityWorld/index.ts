export {
  applyEntityMutations,
  EntityMutationInvariantError,
  // 临时公共面：只有 dialogueResolution 的 summaryFor 转发还在用它。
  // Task 5C 把对话改线到 record_npc_interaction 后，这个导出一并收回（模板收回 entityMutation.ts 内部）。
  formatNpcInteractionSummary,
  // 常驻公共面（与上面那个临时导出不同）：Fact / NPC 的存在性只由这份 active-only 派生裁决，
  // 规则层的传播与 record_npc_knowledge 因此共用同一把尺子；它只读 records，不开任何写通道。
  knowledgeReferences,
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
