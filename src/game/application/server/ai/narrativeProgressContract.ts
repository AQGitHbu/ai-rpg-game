import type { NarrativeCandidateReviewInput } from "../../narrativeCandidateReview";

/** Shared requirements, not a prose score or permission to invent state. */
export const NARRATIVE_PROGRESS_CONTRACT = [
  "开场建立具体利害、中心问题和可由现有行动完成的有限委托；交付成功与整个社会冲突解决必须区分。",
  "中间幕至少带来具体分歧、能改变判断的信息，或基于已发生输入/事实的回应变化。单纯复述引路、再次核验或重复确认不能充当冲突推进；普通同幕回应不要求每次新增剧情。",
  "终幕处理本次委托与玩家立场的具体后果，并明确中心问题中仍未解决的部分；不能用抵达、再次引荐或宏观和解代替可执行的交付。游戏结束不表示所有疑问、承诺或社会冲突都已解决。",
  "推进仍受事实与行动权限约束：新 NPC 知晓已有事实须声明 existingFactIds 并具有公开初始化来源；不强迫每幕新增战斗、秘密、物品或数值系统。",
  "系统节拍是作者的规则依据，正文应将因果变化表达为具体情节；幕数、任务完成状态由 HUD 展示，不把系统提示复写成故事旁白。公开事实不证明某人曾说过或托付过某句话；托话、转述和委托归因必须有真实来源，不能因内容公开就补造传播经历。当前物品权威状态优先于历史中曾经持有的描述。",
].join("\n");

export function buildNarrativeProgressRequirements(input: NarrativeCandidateReviewInput) {
  if (input.context.kind === "opening") return [{ key: "progress:opening", requirement: "concrete_stakes_and_executable_commission" }];
  const { storyState } = input.context;
  return [{ key: "progress:response", requirement: storyState.evolution.status === "needs_next_act"
    ? "concrete_conflict_information_or_grounded_response_change" : "grounded_response_to_current_input" },
  ...("endingOutcomes" in input.proposal ? (input.proposal.endingOutcomes ?? []).map(outcome => ({
    key: `progress:ending:${outcome.themeKey}`, requirement: "finite_commission_stance_consequences_and_remaining_questions",
  })) : [])];
}
