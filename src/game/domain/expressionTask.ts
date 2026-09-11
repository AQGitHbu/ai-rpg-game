import { DIALOGUE_ACTS, type DialogueAct } from "./action";

/** 表达任务，不产生规则动作。正文只从授权事实投影，禁止夹带规划自由文本。 */
export const EXPRESSION_INTENTS = ["describe", "inform", "admit_unknown", ...DIALOGUE_ACTS] as const;
/** 只指定问什么维度，不携带答案、隐藏实体或自由规划备注。 */
export const INQUIRY_ASPECTS = ["identity", "location", "direction", "depth", "time", "cause",
  "method", "quantity", "source", "reliability", "purpose"] as const;
export type InquiryAspect = typeof INQUIRY_ASPECTS[number];
export const ANSWER_OUTCOMES = ["answer", "unknown", "refuse"] as const;
export type PlannedAnswer = Readonly<{
  factId: string;
  aspect: InquiryAspect;
  outcome: typeof ANSWER_OUTCOMES[number];
  /** 答案仅从本任务的授权事实编译；不知道/拒答时为空。 */
  answerFactIds: readonly string[];
}>;
export type ExpressionTask = Readonly<{
  intent: "describe" | "inform" | "admit_unknown" | DialogueAct;
  focusFactIds: readonly string[];
  /** 先核实这些已知说法，再表达主意图；不是已经完成的调查或规则前置条件。 */
  prerequisiteFactIds: readonly string[];
  inquiries?: readonly Readonly<{ factId: string; aspects: readonly InquiryAspect[] }>[];
  /** NPC 对本轮具体问题的回应结果，由规划器决定，表达器只润色。 */
  answers?: readonly PlannedAnswer[];
}>;

export function parseExpressionTask(value: unknown): ExpressionTask | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["intent", "focusFactIds", "prerequisiteFactIds", "inquiries", "answers"].includes(key))
    || !EXPRESSION_INTENTS.includes(record.intent as ExpressionTask["intent"])) return null;
  const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 12
    && value.every(id => typeof id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(id))
    && new Set(value).size === value.length;
  if (!ids(record.focusFactIds) || !ids(record.prerequisiteFactIds)) return null;
  let inquiries: NonNullable<ExpressionTask["inquiries"]> | undefined;
  if (record.inquiries !== undefined) {
    if (!Array.isArray(record.inquiries) || record.inquiries.length > 4
      || (record.inquiries.length > 0 && record.intent !== "ask" && record.intent !== "challenge")) return null;
    const parsed: { factId: string; aspects: InquiryAspect[] }[] = [];
    for (const inquiry of record.inquiries) {
      if (inquiry === null || typeof inquiry !== "object" || Array.isArray(inquiry)
        || Object.keys(inquiry).some(key => !["factId", "aspects"].includes(key))
        || typeof inquiry.factId !== "string" || !record.focusFactIds.includes(inquiry.factId)
        || parsed.some(item => item.factId === inquiry.factId)
        || !Array.isArray(inquiry.aspects) || inquiry.aspects.length < 1 || inquiry.aspects.length > 4
        || inquiry.aspects.some((aspect: unknown) => !INQUIRY_ASPECTS.includes(aspect as InquiryAspect))
        || new Set(inquiry.aspects).size !== inquiry.aspects.length) return null;
      parsed.push({ factId: inquiry.factId, aspects: [...inquiry.aspects] });
    }
    inquiries = parsed;
  }
  let answers: PlannedAnswer[] | undefined;
  if (record.answers !== undefined) {
    if (!Array.isArray(record.answers) || record.answers.length > 16) return null;
    answers = [];
    for (const answer of record.answers) {
      if (answer === null || typeof answer !== "object" || Array.isArray(answer)
        || Object.keys(answer).some(key => !["factId", "aspect", "outcome", "answerFactIds"].includes(key))
        || typeof answer.factId !== "string" || !/^[a-zA-Z0-9_:-]{1,128}$/.test(answer.factId)
        || !INQUIRY_ASPECTS.includes(answer.aspect) || !ANSWER_OUTCOMES.includes(answer.outcome)
        || !ids(answer.answerFactIds)
        || answer.answerFactIds.some((id: string) => !(record.focusFactIds as string[]).includes(id))
        || (answer.outcome === "answer" ? answer.answerFactIds.length === 0 : answer.answerFactIds.length !== 0)
        || answers.some(item => item.factId === answer.factId && item.aspect === answer.aspect)) return null;
      answers.push({ factId: answer.factId, aspect: answer.aspect, outcome: answer.outcome,
        answerFactIds: [...answer.answerFactIds] });
    }
  }
  return { intent: record.intent as ExpressionTask["intent"],
    focusFactIds: [...record.focusFactIds], prerequisiteFactIds: [...record.prerequisiteFactIds],
    ...(inquiries === undefined ? {} : { inquiries }), ...(answers === undefined ? {} : { answers }) };
}
