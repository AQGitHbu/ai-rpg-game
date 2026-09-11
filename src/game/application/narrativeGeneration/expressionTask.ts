import { parseExpressionTask, type ExpressionTask } from "@/game/domain/expressionTask";
import type { Check } from "@/game/domain/narrativeUnit";
import type { SafeFact } from "./perspectiveContext";

const purposes: Record<ExpressionTask["intent"], string> = {
  describe: "以玩家视点呈现", inform: "向玩家说明", admit_unknown: "明确承认自己不知道本轮提问的答案，不编造答案或亲历",
  ask: "追问并要求澄清", support: "表明支持", challenge: "质疑并要求解释",
  threaten: "施压要求回应", deceive: "试探性探问，不编造世界事实", offer: "提出协助",
  refuse: "明确拒绝", reassure: "安抚对方",
};

/** 只编译表达职责；不验证或执行任何世界效果、承诺或知识写入。 */
export function projectExpressionTask(task: ExpressionTask, facts: readonly SafeFact[]): Check<string> & { detail?: string } {
  if (parseExpressionTask(task) === null) return { ok: false, code: "plan_task_invalid" };
  const ids = [...task.focusFactIds, ...task.prerequisiteFactIds];
  const unavailableFactIds = ids.filter(id => !facts.some(fact => fact.id === id));
  if (unavailableFactIds.length) return { ok: false, code: "beat_authority_conflict",
    detail: JSON.stringify({ unavailableFactIds, allowedFactIds: facts.map(fact => fact.id),
      repairInstruction: "任务的主旨和先求证内容均须来自该视角可知且可披露的事实；不要删掉具体条件让表达器自行补剧情。" }) };
  const topic = (ids: readonly string[]) => ids.map(id => {
    const fact = facts.find(fact => fact.id === id)!;
    return `[${id}，${fact.certainty}] ${fact.text}`;
  }).join("；");
  return { ok: true, value: [
    task.prerequisiteFactIds.length ? `先要求对方核实以下说法，未得到答复前不无条件承诺：${topic(task.prerequisiteFactIds)}。然后才表达以下意图。` : "",
    `任务：${purposes[task.intent]}。`,
    task.focusFactIds.length ? `具体内容：${topic(task.focusFactIds)}。` : "只承接本场已批准节拍、现场或当前话语，不另编关键事实。",
    "保留以上目的、具体内容与先后条件，只调整措辞；不得自行增加交易条件、线索、任务、路线或行动结果。",
  ].filter(Boolean).join("\n") };
}
