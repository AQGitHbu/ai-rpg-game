import { NARRATIVE_EMOTIONS } from "@/game/domain";
import type { NarrativeApprovalResult, NpcPerformanceProposal } from "./types";

/** Validates performer text against the exact fact cards supplied to that NPC. */
export function approveNpcPerformance(input: Readonly<{
  proposal: NpcPerformanceProposal;
  allowedFactIds: readonly string[];
}>): NarrativeApprovalResult<NpcPerformanceProposal> {
  const length = Array.from(input.proposal.text).length;
  if (length < 1 || length > 360 || !NARRATIVE_EMOTIONS.includes(input.proposal.emotion)) {
    return { ok: false, category: "schema_violation" };
  }
  const allowed = new Set(input.allowedFactIds);
  if (input.proposal.usedFactIds.some((factId) => !allowed.has(factId))) {
    return { ok: false, category: "knowledge_scope_violation" };
  }
  return { ok: true, value: { text: input.proposal.text, usedFactIds: [...input.proposal.usedFactIds], emotion: input.proposal.emotion } };
}
