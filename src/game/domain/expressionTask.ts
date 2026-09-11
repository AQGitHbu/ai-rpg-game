import { DIALOGUE_ACTS, type DialogueAct } from "./action";

/** 表达任务，不产生规则动作。正文只从授权事实投影，禁止夹带规划自由文本。 */
export const EXPRESSION_INTENTS = ["describe", "inform", "admit_unknown", ...DIALOGUE_ACTS] as const;
/** 只指定问什么维度，不携带答案、隐藏实体或自由规划备注。 */
export const INQUIRY_ASPECTS = ["identity", "location", "direction", "depth", "time", "cause",
  "method", "quantity", "source", "reliability", "purpose"] as const;
export type InquiryAspect = typeof INQUIRY_ASPECTS[number];
export type ExpressionTask = Readonly<{
  intent: "describe" | "inform" | "admit_unknown" | DialogueAct;
  focusFactIds: readonly string[];
  /** 先核实这些已知说法，再表达主意图；不是已经完成的调查或规则前置条件。 */
  prerequisiteFactIds: readonly string[];
  inquiries?: readonly Readonly<{ factId: string; aspects: readonly InquiryAspect[] }>[];
}>;

export function parseExpressionTask(value: unknown): ExpressionTask | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["intent", "focusFactIds", "prerequisiteFactIds", "inquiries"].includes(key))
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
  return { intent: record.intent as ExpressionTask["intent"],
    focusFactIds: [...record.focusFactIds], prerequisiteFactIds: [...record.prerequisiteFactIds],
    ...(inquiries === undefined ? {} : { inquiries }) };
}
