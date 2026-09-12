import { expect, it } from "vitest";
import { buildPolishPrompt } from "./polishPrompt";
import { buildPlanningPrompt, renderPlanProposalContract, PLANNING_BEAT_KINDS, PLANNING_TRIGGER_KINDS, PLANNING_TOPIC_KINDS } from "./planningPrompt";
import { asGenerationId } from "@/game/domain/worldEntity";
import { DIALOGUE_ACTS } from "@/game/domain/action";
import { dialogueReviewHarness } from "@/game/application/narrativeGeneration/dialogueConsistencyFixture.testutil";
import { approvePlanningContext } from "@/game/application/narrativeGeneration/approvePlanningContext";
import { projectUnitContext } from "@/game/application/narrativeGeneration/perspectiveContext";
import type { UnitOutput } from "@/game/domain/narrativeUnit";
const opening = { kind: "opening" as const, input: { gameType: "wuxia" as const, gameLength: "short" as const, seed: "schema" }, generation: { generationId: asGenerationId("schema"), seed: "schema", templateVersion: "v2" as const, inputDigest: "", gameType: "wuxia" as const } };
it("planning preserves all structural enum contracts and fixed opening identities", () => {
  const prompt = renderPlanProposalContract(opening);
  for (const entry of [...PLANNING_BEAT_KINDS, ...PLANNING_TRIGGER_KINDS, ...PLANNING_TOPIC_KINDS, ...DIALOGUE_ACTS]) expect(prompt).toContain(entry);
  const assembled = buildPlanningPrompt(opening);
  for (const id of ["player_0", "npc_0", "loc_0", "quest_0", "fact_0"]) expect(assembled).toContain(id);
  expect(assembled).toContain("knownFactKeys"); expect(assembled).not.toContain('"brief"');
});
it("all polish prompts carry only their complete draft, scoped facts and style, no old task instructions", async () => {
  const { h, plan } = await dialogueReviewHarness(false); const loaded = await h.readJob(); if (!loaded.ok) throw Error(loaded.code);
  const result = approvePlanningContext(loaded.value.input, plan); if (!result.ok) throw Error(result.code);
  const approved = new Map<string, UnitOutput>();
  for (const unit of result.value.units) {
    const projected = projectUnitContext({ plan: result.value, unit, approved }); if (!projected.ok) throw Error(projected.code);
    const prompt = buildPolishPrompt(projected.value, { attempt: 1, reason: "invalid_schema", rejectionCode: "polish_payload_invalid" });
    expect(prompt).toContain(JSON.stringify(unit.draft)); expect(prompt).toContain("polish_payload_invalid");
    expect(prompt).not.toContain("必须针对事实"); expect(prompt).not.toContain("inquiries"); expect(prompt).not.toContain("prerequisiteFactIds");
    expect(prompt).toContain("玩家性格只影响玩家选项"); expect(prompt).toContain("不增删实质内容");
    if (unit.stage === "choices") expect(prompt).toContain('只返回 {"labels"'); else expect(prompt).toContain('只返回 {"texts"');
    approved.set(unit.key, unit.draft!);
  }
});
it("planning preserves actual selected label and bounded same-NPC history without historical task", async () => {
  const { h } = await dialogueReviewHarness(); const loaded = await h.readJob(); if (!loaded.ok || loaded.value.input.kind !== "decision") throw Error("fixture");
  const sentinel = "LEGACY_SEMANTIC_TASK_SENTINEL";
  const context = { ...loaded.value.input, dialogueHistory: [{ previousReply: "我不知道旧址在哪。", previousChoices: ["旧址在哪？", "你愿意帮忙吗？"],
    selectedDialogue: { label: "旧址在哪？", dialogueAct: "ask" as const, task: { brief: sentinel, inquiries: [{ factId: sentinel, aspects: ["source"] }] } } }] };
  const prompt = buildPlanningPrompt(context);
  const { buildPlanningContentPrompt } = await import("./planningPrompt");
  const content = buildPlanningContentPrompt(context);
  expect(prompt + content).not.toContain(sentinel);
  expect(content).toContain("旧址在哪？");
  expect(prompt).toContain("从哪儿听来的，消息可靠吗？"); expect(prompt).not.toContain('"inquiries"');
});
