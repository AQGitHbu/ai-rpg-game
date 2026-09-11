import { DIALOGUE_ACTS, type DialogueAct } from "./action";

/** 表达任务，不产生规则动作。正文只从授权事实投影，禁止夹带规划自由文本。 */
export const EXPRESSION_INTENTS = ["describe", "inform", "admit_unknown", ...DIALOGUE_ACTS] as const;
export type ExpressionTask = Readonly<{
  intent: "describe" | "inform" | "admit_unknown" | DialogueAct;
  focusFactIds: readonly string[];
  /** 先核实这些已知说法，再表达主意图；不是已经完成的调查或规则前置条件。 */
  prerequisiteFactIds: readonly string[];
}>;

export function parseExpressionTask(value: unknown): ExpressionTask | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["intent", "focusFactIds", "prerequisiteFactIds"].includes(key))
    || !EXPRESSION_INTENTS.includes(record.intent as ExpressionTask["intent"])) return null;
  const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 12
    && value.every(id => typeof id === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(id))
    && new Set(value).size === value.length;
  if (!ids(record.focusFactIds) || !ids(record.prerequisiteFactIds)) return null;
  return { intent: record.intent as ExpressionTask["intent"],
    focusFactIds: [...record.focusFactIds], prerequisiteFactIds: [...record.prerequisiteFactIds] };
}
