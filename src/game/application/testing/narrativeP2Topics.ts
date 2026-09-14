/** Fixed public questions. Completion metadata is never appended to model input. */
export const NARRATIVE_P2_TOPICS = Object.freeze([
  { act: 1, topicId: "1-reason", text: "这次递送为什么值得做？你最想解决的具体问题是什么？" },
  { act: 1, topicId: "1-cost", text: "如果信没能送到，具体谁会受到什么影响？你不知道的部分也请直说。" },
  { act: 1, topicId: "1-boundary", text: "我能替你完成的是递送。还有哪些事必须留给接收人决定，不能由我替他答应？" },
  { act: 2, topicId: "2-stake", text: "站在你自己的处境看，这次递送与你有什么关系？" },
  { act: 2, topicId: "2-objection", text: "对这件事，你具体赞成或担心哪一点？理由是什么？" },
  { act: 2, topicId: "2-basis", text: "你的判断有哪些你自己知道的依据，哪些只是推测？" },
  { act: 3, topicId: "3-change", text: "听了你的看法，我对这封信的处置需要重新考虑什么？" },
  { act: 3, topicId: "3-alternative", text: "如果不按你倾向的方式处理，会有什么具体代价？没有别的办法也请说明。" },
  { act: 3, topicId: "3-limit", text: "你能亲自负责哪部分，哪些结果你无法保证？" },
  { act: 4, topicId: "4-risk", text: "接近交付时，有什么实际风险需要我向接收人说明？" },
  { act: 4, topicId: "4-evidence", text: "关于这个风险，有什么可以当面核对的依据？如果没有，请不要替别人作证。" },
  { act: 4, topicId: "4-decision", text: "哪个分歧需要由接收人来回答，而不能仅靠我把信送到就算解决？" },
  { act: 5, topicId: "5-response", text: "在我交付前，你对这次递送的理由有什么具体回应？不知道的请直说。" },
  { act: 5, topicId: "5-responsibility", text: "你收到信后愿意承担哪部分责任？哪些仍需要其他人同意？" },
  { act: 5, topicId: "5-unresolved", text: "即使这次交付完成，我们刚才谈到的问题里还有哪些没有解决？" },
].map(topic => Object.freeze(topic)));
export type P2TopicCommit = Readonly<{ act: number; topicId: string; actionId: string; npcId: string }>;
export type P2TopicState = Readonly<{ committed: readonly P2TopicCommit[]; stoppedActs: readonly number[] }>;
export type P2TopicView = Readonly<{ currentAct: number; formalResponseCount: number; focus: readonly Readonly<{ npcId: string; freeInputEnabled: boolean }>[] }>;
function validateState(state: P2TopicState) {
  const actions = new Set<string>();
  const seen = new Map<number, number>();
  for (const step of state.committed) {
    if (!step.actionId || !step.npcId || actions.has(step.actionId)) throw new Error("P2_TOPIC_DUPLICATE");
    const index = seen.get(step.act) ?? 0;
    if (NARRATIVE_P2_TOPICS.filter(topic => topic.act === step.act)[index]?.topicId !== step.topicId) throw new Error("P2_TOPIC_ORDER_INVALID");
    seen.set(step.act, index + 1); actions.add(step.actionId);
  }
  if (state.stoppedActs.some(act => !Number.isInteger(act) || act < 1 || act > 5) || new Set(state.stoppedActs).size !== state.stoppedActs.length) throw new Error("P2_TOPIC_STATE_INVALID");
}
export function selectNarrativeP2Topic(view: P2TopicView, state: P2TopicState) {
  validateState(state);
  if (!Number.isInteger(view.currentAct) || view.currentAct < 1 || !Number.isInteger(view.formalResponseCount) || view.formalResponseCount < 0) throw new Error("P2_TOPIC_VIEW_INVALID");
  const topic = NARRATIVE_P2_TOPICS.filter(item => item.act === view.currentAct)[state.committed.filter(item => item.act === view.currentAct).length];
  if (!topic || state.stoppedActs.includes(view.currentAct)) return { kind: "formal" as const };
  if (view.formalResponseCount > 0) return { kind: "failure" as const, code: "P2_TOPIC_WINDOW_MISSED" };
  const focus = view.focus.filter(npc => npc.freeInputEnabled);
  if (focus.length !== 1 || !focus[0].npcId) return { kind: "failure" as const, code: "P2_TOPIC_FOCUS_MISSING" };
  return { kind: "topic" as const, topic, npcId: focus[0].npcId };
}
/** Caller owns durable action reservation and successful production performTurn evidence. */
export function commitNarrativeP2Topic(state: P2TopicState, step: P2TopicCommit, succeeded: boolean): P2TopicState {
  validateState(state);
  if (!succeeded) return state;
  if (state.committed.some(item => item.actionId === step.actionId || item.topicId === step.topicId)) throw new Error("P2_TOPIC_DUPLICATE");
  if (state.stoppedActs.includes(step.act)) throw new Error("P2_TOPIC_ACT_STOPPED");
  const next = { ...state, committed: [...state.committed, step] };
  validateState(next);
  return next;
}
export type P2TopicReview = Readonly<{
  topicId: string; actionId: string; reviewer: string; reviewedAt: string;
  historyQuotes: readonly Readonly<{ historyId: string; quote: string }>[];
  candidateIds: readonly string[]; reason: string;
  verdict: "grounded" | "repeated" | "ungrounded" | "not_applicable";
}>;
/** Human judgment is recorded, never inferred from keywords, length, or a provider call. */
export function stopNarrativeP2Topics(state: P2TopicState, review: P2TopicReview): P2TopicState {
  validateState(state);
  const step = state.committed.find(item => item.topicId === review.topicId && item.actionId === review.actionId);
  if (!step || !review.reviewer.trim() || !review.reason.trim() || !Number.isFinite(Date.parse(review.reviewedAt))
    || !review.historyQuotes.length || review.historyQuotes.some(item => !item.historyId || !item.quote.trim())
    || !["grounded", "repeated", "ungrounded", "not_applicable"].includes(review.verdict)) throw new Error("P2_TOPIC_REVIEW_INVALID");
  if (review.verdict === "grounded" || state.stoppedActs.includes(step.act)) return state;
  return { ...state, stoppedActs: [...state.stoppedActs, step.act] };
}
