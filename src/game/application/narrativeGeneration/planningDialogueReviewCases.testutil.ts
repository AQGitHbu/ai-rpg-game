import type { DialogueReviewSubject } from "./dialogueReviewChecks";

/** Fixed heldout contrast from dimensions/preregistered-live.json; not inferred from model output. */
const recognition: DialogueReviewSubject = {
  unitKey: "choices_current", candidateId: "candidate_emblem", kind: "option", intent: "ask",
  brief: "问对方是否认得这枚旧徽章，以及它属于哪个组织。", inquiries: [], answers: [], prerequisiteFactIds: [],
  topicFactIds: ["fact_emblem"], facts: [{ id: "fact_emblem", text: "桌上放着一枚带有双翼纹样的旧徽章。", certainty: "known", sources: [] }],
};
export const planningDimensionCases = [
  { id: "recognition_missing", expected: "reject", expectedAspect: "identity", subject: recognition },
  { id: "recognition_encoded", expected: "pass", expectedAspect: null, subject: { ...recognition,
    inquiries: [{ factId: "fact_emblem", aspects: ["identity"] }] } },
  { id: "credibility_missing", expected: "reject", expectedAspect: "reliability", subject: { ...recognition,
    brief: "询问这条失踪传闻是真是假，是否可信。", topicFactIds: ["fact_rumor"],
    facts: [{ id: "fact_rumor", text: "城里流传着有人失踪的说法。", certainty: "known", sources: [] }] } },
] as const satisfies readonly { id: string; expected: "pass" | "reject"; expectedAspect: string | null; subject: DialogueReviewSubject }[];
