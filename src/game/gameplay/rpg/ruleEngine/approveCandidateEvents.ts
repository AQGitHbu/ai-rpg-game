// 兼容包装：R4 后候选事件审批迁移到 candidateEvents 纯模块，本文件保留为
// 过渡期的再导出，避免历史调用点直接断链。新代码请直接使用
// `@/game/gameplay/rpg/candidateEvents`。
export {
  approveCandidateEvents,
  MAX_CANDIDATE_APPROVED_PER_TURN,
  type ApprovedEventCandidate,
  type CandidateRejection,
  type ApproveCandidateEventsInput,
  type ApproveCandidateEventsResult,
  type ApproveCandidateEventsDeps,
} from "@/game/gameplay/rpg/candidateEvents";
