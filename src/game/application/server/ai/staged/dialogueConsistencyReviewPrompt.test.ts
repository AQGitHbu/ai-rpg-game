import { expect, it, vi } from "vitest";
import { buildDialogueConsistencyReviewPrompt } from "./dialogueConsistencyReviewPrompt";
import { createLiveStageSource } from "./liveStageSource";
import type { RpgAiClient } from "../rpgAiClient";
import type { DialogueConsistencyReviewRequest } from "@/game/application/narrativeGeneration/dialogueConsistencyReview";

import { compileDialogueReviewChecks } from "@/game/application/narrativeGeneration/dialogueReviewChecks";
import { realReviewSubjects } from "@/game/application/narrativeGeneration/dialogueReviewRealFailures.testutil";
const request: DialogueConsistencyReviewRequest = compileDialogueReviewChecks(realReviewSubjects.missingSource).request;
const execution = { signal: new AbortController().signal, timeoutMs: 1000,
  audit: { purpose: "staged_narrative_generation" as const, trigger: "dialogue_consistency_review", jobId: "job" } };

it("独立审核prompt保留合同和实际文案，明确反例、自由输入与禁止改稿", () => {
  const prompt = buildDialogueConsistencyReviewPrompt(request);
  expect(prompt).toContain(JSON.stringify(request));
  for (const phrase of ["来源并不重要", "从哪儿听来", "玩家自由输入不会生成selected", "plan_answer", "不写改稿", "1至8项", "uncertain",
    "不能从未来选项借来time/reliability", "修复层级和目标完全由服务器决定", "offer是自己提出协助", "空inquiries不授权任意提问",
    "prerequisiteFactIds是已批准的先核实条件", "沿着脚印方向一起排查"])
    expect(prompt).toContain(phrase);
});

it.each(["pass", "reject", "uncertain"] as const)("独立role路由及合法%s解析", async verdict => {
  const check = request.checks.find(c => c.kind === "answer")!;
  const violations = verdict === "reject" ? [{ checkId: check.checkId, type: "missing_response", inquiryId: check.inquiries[0]!.inquiryId }] : [];
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
  const empty = { ...request, checks: [{ ...request.checks[0]!, text: "" }] };
  const overhead = [...JSON.stringify(empty)].length;
  const bounded = { ...empty, checks: [{ ...empty.checks[0]!, text: "🙂".repeat(16000 - overhead) }] };
  expect((await source.reviewDialogueConsistency!(bounded, execution)).ok).toBe(true);
  expect(complete).toHaveBeenCalledTimes(1);
  const overflow = { ...bounded, checks: [{ ...bounded.checks[0]!, text: bounded.checks[0]!.text + "界" }] };
  const result = await source.reviewDialogueConsistency!(overflow, execution);
  expect(JSON.stringify(result)).toContain("dialogue_consistency_context_limit");
  expect(complete).toHaveBeenCalledTimes(1);
});
