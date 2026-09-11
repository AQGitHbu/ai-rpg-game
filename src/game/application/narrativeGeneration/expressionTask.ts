import { parseExpressionTask, type ExpressionTask, type InquiryAspect } from "@/game/domain/expressionTask";
import type { Check } from "@/game/domain/narrativeUnit";
import type { SafeFact } from "./perspectiveContext";

const purposes: Record<ExpressionTask["intent"], string> = {
  describe: "以玩家视点呈现", inform: "向玩家说明", admit_unknown: "明确承认自己不知道本轮提问的答案，不编造答案或亲历",
  ask: "追问并要求澄清", support: "表明支持", challenge: "质疑并要求解释",
  threaten: "施压要求回应", deceive: "试探性探问，不编造世界事实", offer: "提出协助",
  refuse: "明确拒绝", reassure: "安抚对方",
};
const inquiryLabels: Record<InquiryAspect, string> = {
  identity: "涉及谁或身份", location: "所在地点", direction: "走向/方向", depth: "深浅",
  time: "发生时间", cause: "原因", method: "具体方式", quantity: "数量/程度",
  source: "消息来源", reliability: "依据与可信度", purpose: "目的",
};

/** 只编译表达职责；不验证或执行任何世界效果、承诺或知识写入。 */
export function projectExpressionTask(task: ExpressionTask, facts: readonly SafeFact[],
  questions: NonNullable<ExpressionTask["inquiries"]> = []): Check<string> & { detail?: string } {
  if (parseExpressionTask(task) === null) return { ok: false, code: "plan_task_invalid" };
  if (task.answers?.some(answer => !questions.some(question => question.factId === answer.factId
    && question.aspects.includes(answer.aspect)))) return { ok: false, code: "plan_reply_question_mismatch" };
  const ids = [...task.focusFactIds, ...task.prerequisiteFactIds];
  const unavailableFactIds = ids.filter(id => !facts.some(fact => fact.id === id));
  if (unavailableFactIds.length) return { ok: false, code: "beat_authority_conflict",
    detail: JSON.stringify({ unavailableFactIds, allowedFactIds: facts.map(fact => fact.id),
      repairInstruction: "任务的主旨和先求证内容均须来自该视角可知且可披露的事实；不要删掉具体条件让表达器自行补剧情。" }) };
  const topic = (ids: readonly string[]) => ids.map(id => {
    const fact = facts.find(fact => fact.id === id)!;
    return `[${id}，${fact.certainty}] ${fact.text}`;
  }).join("；");
  const boundedReferences = [
    task.prerequisiteFactIds.length ? `先要求对方核实以下说法，未得到答复前不无条件承诺：${topic(task.prerequisiteFactIds)}。然后才表达主要内容。` : "",
    task.contentFactIds?.length ? `正文必须明确包含：${topic(task.contentFactIds)}。` : "",
    ...(task.inquiries ?? []).map(inquiry => `必须针对事实 ${inquiry.factId} 具体询问：${inquiry.aspects.map(aspect => inquiryLabels[aspect]).join("、")}。这些是待问的维度，未知答案不能当作已知事实；每个维度都须保留，不能替换成笼统的“怎么解释”。`),
    ...(task.answers ?? []).map(answer => `对玩家关于 ${answer.factId} 的「${inquiryLabels[answer.aspect]}」问题：${answer.outcome === "answer"
      ? `只用以下授权内容回答，保留 certainty：${topic(answer.answerFactIds)}`
      : answer.outcome === "unknown" ? "明确表示不知道，不能改成失忆、拒绝透露或编造答案"
        : "明确拒绝回答，不暗示知道任何未授权答案，也不编造拒绝原因"}。这是已规划的回应结果，不得自行改变。`),
  ].filter(Boolean);
  if (task.brief !== undefined) return { ok: true, value: [
    task.brief,
    ...boundedReferences,
    "完整保留以上本轮内容的对象、回答、未知范围、态度、协助方式与条件；只调整措辞，不把相关话题背景补进内容稿，不增加线索、任务、路线或行动结果。",
  ].join("\n") };
  return { ok: true, value: [
    `任务：${purposes[task.intent]}。`,
    task.focusFactIds.length ? `具体内容：${topic(task.focusFactIds)}。` : "只承接本场已批准节拍、现场或当前话语，不另编关键事实。",
    ...boundedReferences,
    "保留以上目的、具体内容与先后条件，只调整措辞；不得自行增加交易条件、线索、任务、路线或行动结果。",
  ].filter(Boolean).join("\n") };
}
