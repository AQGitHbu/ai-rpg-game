import { renderAiRepairFeedback, type AiContentRepair } from "@/game/application/aiGenerationRetry";
import type { DialogueConsistencyReviewRequest } from "@/game/application/narrativeGeneration/dialogueConsistencyReview";
export function buildDialogueConsistencyReviewPrompt(request: DialogueConsistencyReviewRequest, repair?: AiContentRepair): string {
  return `核对每项完整初稿 draft 与润色 text 的内容保真和授权事实。允许自然改写、相同原句和无实质含义的修辞；不评价故事走向或要求换个话题。
拒绝增删问题、回答对象变化、不知道变成失忆/拒答/否认发生、拒答变成知道答案、条件或先后关系改变、角色互换。draft 本身和 text 都不得断言 facts/公开定位未授权的新事实、能力、设备、原因、亲历、秘密或行动结果；忠实照抄未授权原稿也应拒绝。疑似事实须保留不确定性。名字和普通语言修饰无需额外事实 ID。
每项的 facts 只授权该项；scene/speaker/selectedLabel 只用于身份、指代和当前话语衔接，不授权玩家所说内容为事实。不要把 NPC 自己的问题改成回答，也不要把玩家原句归类为来源/方式等维度。
只返回 {"verdict":"pass"|"reject"|"uncertain","failedIds":[]}。pass/uncertain 的 failedIds 必须为空；reject 至少一个输入 item.id。不得返回原因、类别、scope 或新 ID。无法判断时明确 uncertain。
输入：${JSON.stringify(request)}
${repair === undefined ? "" : renderAiRepairFeedback(repair)}`;
}
