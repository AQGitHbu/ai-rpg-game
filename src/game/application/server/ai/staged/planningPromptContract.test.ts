import { expect, it } from "vitest";
import { buildPlanningPrompt, PLANNING_CONTENT_RULES } from "./planningPrompt";
import { INQUIRY_SEMANTICS } from "./inquirySemantics";
import { asGenerationId } from "@/game/domain/worldEntity";

it("planning includes RPG roles, precise inquiry boundaries and original-fact prerequisites", () => {
  expect(PLANNING_CONTENT_RULES).toContain(INQUIRY_SEMANTICS);
  for (const phrase of ["仅表示玩家已经向 NPC 提出的问题", "不得擅加问题", "认不认得令牌不等于问令牌真假",
    "不必额外 location", "不是成因", "不等于“如何调查”", "已给时间范围", "玩家 offer/support 不携带新的事实问题",
    "改为 ask/challenge", "或只保留提议", "不能新增条件结论或升级事实强度", "不授予事实、知识、披露权限"])
    expect(PLANNING_CONTENT_RULES).toContain(phrase);
});

it("assembled structural contract scopes inquiries to player candidates, including NPC questions", () => {
  const prompt = buildPlanningPrompt({ kind: "opening", input: { gameType: "wuxia", gameLength: "short", seed: "roles" },
    generation: { generationId: asGenerationId("gen_roles"), seed: "roles", templateVersion: "v2", inputDigest: "", gameType: "wuxia" } });
  expect(prompt).toContain("以下 inquiries 编码约束用于玩家候选");
  expect(prompt).toContain("NPC 主动问玩家由自身 brief/intent 承载，不混入其 answers 或 selectedDialogue 的玩家问询合同");
  expect(prompt).toContain("玩家候选无事实问询");
  expect(prompt).toContain("玩家候选询问谁、在哪里");
  expect(prompt).not.toContain("- 询问谁、在哪里");
  expect(prompt).toContain("须原样保留其 opening、worldDelta、steps、terminal、observations、actions");
  expect(prompt).toContain("只修正 units 的任务内容及 decision 候选意图/brief/inquiries");
});
