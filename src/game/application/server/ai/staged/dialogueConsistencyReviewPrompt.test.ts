import { expect, it, vi } from "vitest";
import { buildDialogueConsistencyReviewPrompt } from "./dialogueConsistencyReviewPrompt";
import { createLiveStageSource } from "./liveStageSource";
import type { RpgAiClient } from "../rpgAiClient";
import type { DialogueConsistencyReviewRequest } from "@/game/application/narrativeGeneration/dialogueConsistencyReview";

const request: DialogueConsistencyReviewRequest = { version: 1, conversations: [{
  unitKey: "character_current", stepKey: "current", speakerId: "npc_0", stage: "character",
  brief: "不知道来源和真假。", text: "我不知真假。", answers: [
    { factId: "fact_a", aspect: "source", outcome: "unknown", answerFactIds: [] },
    { factId: "fact_a", aspect: "reliability", outcome: "unknown", answerFactIds: [] },
  ], options: [], selected: { historicalChoice: true, label: "从哪儿听来的，消息可靠吗？", contract: { intent: "ask",
    inquiries: [{ factId: "fact_a", aspects: ["source", "reliability"] }] } },
  facts: [], priorText: [], previousReply: null,
}] };
const execution = { signal: new AbortController().signal, timeoutMs: 1000,
  audit: { purpose: "staged_narrative_generation" as const, trigger: "dialogue_consistency_review", jobId: "job" } };

it("独立审核prompt保留合同和实际文案，明确反例、自由输入与禁止改稿", () => {
  const prompt = buildDialogueConsistencyReviewPrompt(request);
  expect(prompt).toContain(JSON.stringify(request));
  for (const phrase of ["来源并不重要", "从哪儿听来", "historicalChoice=false", "scope=planning", "不写改稿", "1至8项", "uncertain"])
    expect(prompt).toContain(phrase);
});

it.each(["pass", "reject", "uncertain"] as const)("独立role路由及合法%s解析", async verdict => {
  const violations = verdict === "reject" ? [{ scope: "expression", unitKey: "character_current", type: "missing_response", aspect: "source" }] : [];
  const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ verdict, violations }), latencyMs: 1 });
  const source = createLiveStageSource({ client: { complete } as unknown as RpgAiClient });
  expect(await source.reviewDialogueConsistency!(request, execution)).toEqual({ ok: true, verdict, violations });
  expect(complete).toHaveBeenCalledWith("dialogue_consistency_review", expect.any(Array), execution.audit,
    { signal: execution.signal, timeoutMs: 1000 });
});

it.each(['{"verdict":"pass"}', '{"verdict":"yes","violations":[]}', 'invalid JSON', "x".repeat(4001)])(
  "非法或超长审核响应明确失败", async content => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content, latencyMs: 1 });
    const source = createLiveStageSource({ client: { complete } as unknown as RpgAiClient });
    const result = await source.reviewDialogueConsistency!(request, execution);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("dialogue_consistency_review_invalid");
    expect(complete).toHaveBeenCalledTimes(1);
  });

it("16000 Unicode码点上限不能截断待审内容，超限不请求", async () => {
  const complete = vi.fn().mockResolvedValue({ ok: true, content: '{"verdict":"pass","violations":[]}', latencyMs: 1 });
  const source = createLiveStageSource({ client: { complete } as unknown as RpgAiClient });
  const empty = { ...request, conversations: [{ ...request.conversations[0]!, text: "" }] };
  const overhead = [...JSON.stringify(empty)].length;
  const bounded = { ...empty, conversations: [{ ...empty.conversations[0]!, text: "🙂".repeat(16000 - overhead) }] };
  expect((await source.reviewDialogueConsistency!(bounded, execution)).ok).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
  const overflow = { ...bounded, conversations: [{ ...bounded.conversations[0]!, text: bounded.conversations[0]!.text + "界" }] };
  const result = await source.reviewDialogueConsistency!(overflow, execution);
  expect(JSON.stringify(result)).toContain("dialogue_consistency_context_limit");
  expect(complete).toHaveBeenCalledTimes(1);
});
