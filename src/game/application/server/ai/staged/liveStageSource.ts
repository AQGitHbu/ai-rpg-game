// staged live source（Spec 2026-09-09 / Plan Task 5）。
//
// StageSource 的 transport 实现：每个 stage 恰好一次 RpgAiClient.complete。
// 只做 prompt 组装与 domain 解析（parsePlanProposal/parseUnitOutput），不做
// 审批、不铸 ID、不写状态；provider 失败按既有分类映射为 AiSourceFailure。

import type { AiCompletionResult, AiMessage } from "@ai-game/ai-transport";
import { aiRepairAuditContext, createAiSourceFailure, type AiSourceFailure } from "@/game/application/aiGenerationRetry";
import { transportFailureCodeToCategory } from "@/game/application/aiGenerationFailure";
import { parseStructuredJsonObject } from "@/game/core/json";
import { hasOnlyKnownOpeningCandidateKeys } from "../openingGenerationSource";
import { parseLiveDraftPlan } from "@/game/domain/liveDraftPlan";
import { applyPolish } from "@/game/domain/draftPolish";
import type {
  StageExecution,
  StageRequest,
  StageSource,
  StageSuccess,
} from "@/game/application/narrativeGeneration/stageSource";
import type { RpgAiClient, RpgAiRole } from "../rpgAiClient";
import { buildPlanningPrompt, buildPlanningContentPrompt, PLANNING_CONTENT_RULES } from "./planningPrompt";
import { buildNarrationPrompt } from "./narrationPrompt";
import { buildCharacterPrompt } from "./characterPrompt";
import { buildChoicePrompt } from "./choicePrompt";
import { buildDialogueConsistencyReviewPrompt } from "./dialogueConsistencyReviewPrompt";
import { DIALOGUE_REVIEW_CONTEXT_LIMIT } from "@/game/application/narrativeGeneration/dialogueConsistencyReview";
import { parsePolishReviewVerdict } from "@/game/application/narrativeGeneration/dialogueConsistencyReview";
import { buildDisclosureReviewPrompt } from "./disclosureReviewPrompt";
import { repeatedNpcResponseUnits } from "@/game/application/narrativeGeneration/dialogueContinuity";

const STAGE_ROLES: Readonly<Record<StageRequest["stage"], RpgAiRole>> = {
  planning: "planning",
  narration: "narration",
  character: "character",
  choices: "choices",
};

export type CreateLiveStageSourceOptions = Readonly<{
  readonly client: RpgAiClient;
}>;

function invalidContent(code: string, detail?: string) {
  return createAiSourceFailure("scene", "invalid_schema", code, detail);
}

type ProviderFailureResult = Extract<AiCompletionResult, { ok: false }>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Preserve stable provider evidence for the next content-repair request.
 * The provider may spend the entire completion budget on reasoning and return
 * no final channel; reporting that fact is materially more useful than the
 * old generic `provider_failure` message. Raw provider text is never copied.
 */
function providerFailure(result: ProviderFailureResult) {
  const metadata = asRecord(result);
  const usage = asRecord(metadata?.usage);
  const finishReason = typeof metadata?.finishReason === "string" ? metadata.finishReason : undefined;
  const reasoningTokens = finiteNumber(metadata?.reasoningTokens) ?? finiteNumber(usage?.reasoningTokens);
  const hasReasoningContent = typeof metadata?.hasReasoningContent === "boolean"
    ? metadata.hasReasoningContent : undefined;

  if (result.code === "empty_response") {
    const detail = finishReason === "length"
      ? `provider 未返回最终 JSON：finishReason=length；reasoningTokens=${reasoningTokens ?? "unknown"}；hasReasoningContent=${hasReasoningContent ?? "unknown"}。思考阶段已达到长度上限，下一次必须在思考后输出完整 JSON。`
      : "provider 未返回最终 JSON（empty_response）；下一次必须输出完整 JSON，不要只返回思考内容。";
    return createAiSourceFailure("scene", "empty_response", "empty_response", detail);
  }

  return createAiSourceFailure(
    "scene",
    transportFailureCodeToCategory(result.code),
    "provider_failure",
    `provider transport 失败：code=${result.code}；本次没有可解析结果，下一次请重新调用并返回完整 JSON。`,
  );
}

/**
 * 单次 stage 生成：role 映射、prompt 组装、JSON 解析与失败分类的唯一实现。
 * execution.signal / execution.timeoutMs 原样透传给 client（由 transport
 * 独占取消与超时机制），audit context 原样进入审计记录。
 */
export function createLiveStageSource(options: CreateLiveStageSourceOptions): StageSource {
  return {
    async reviewDialogueConsistency(request, execution) {
      if ([...JSON.stringify(request)].length > DIALOGUE_REVIEW_CONTEXT_LIMIT)
        return invalidContent("dialogue_consistency_context_limit");
      const response = await options.client.complete("dialogue_consistency_review",
        [{ role: "user", content: buildDialogueConsistencyReviewPrompt(request, execution.repair) }], execution.repair === undefined ? execution.audit
          : { ...execution.audit, retry: aiRepairAuditContext(execution.repair, execution.audit.retry) },
        { signal: execution.signal, timeoutMs: Math.min(30_000, execution.timeoutMs) });
      if (!response.ok) return providerFailure(response);
      if ([...response.content].length > 4_000) return invalidContent("dialogue_consistency_review_invalid", "response too long");
      const parsed = parseStructuredJsonObject(response.content);
      const verdict = parsed.ok ? parsePolishReviewVerdict(parsed.value, request) : { ok: false as const, code: "invalid_json" };
      return !verdict.ok ? invalidContent("dialogue_consistency_review_invalid", "Only verdict and failedIds are allowed") : { ok: true, ...verdict.value };
    },
    async reviewDisclosure(request, execution) {
      const prompt = buildDisclosureReviewPrompt(request);
      if (prompt.length > 12_000) return invalidContent("disclosure_review_context_overflow", "审核输入超限，不能截断事实");
      const audit = execution.repair === undefined ? execution.audit : {
        ...execution.audit, retry: aiRepairAuditContext(execution.repair, execution.audit.retry),
      };
      const response = await options.client.complete("disclosure_review", [{ role: "user", content: prompt }],
        audit, { signal: execution.signal, timeoutMs: execution.timeoutMs });
      if (!response.ok) return providerFailure(response);
      const parsed = parseStructuredJsonObject(response.content);
      if (!parsed.ok || Object.keys(parsed.value).length !== 1
        || typeof parsed.value.verdict !== "string"
        || !["pass", "reject", "uncertain"].includes(parsed.value.verdict))
        return invalidContent("disclosure_review_invalid", "审核必须只返回 verdict");
      return { ok: true, verdict: parsed.value.verdict as "pass" | "reject" | "uncertain" };
    },
    async generate(
      request: StageRequest,
      execution: StageExecution,
    ): Promise<StageSuccess | AiSourceFailure> {
      const role = STAGE_ROLES[request.stage];
      const prompt = request.stage === "planning"
        ? buildPlanningPrompt(request.context, execution.repair, request.context.kind === "decision")
        : request.stage === "narration"
          ? buildNarrationPrompt(request.context, execution.repair)
          : request.stage === "character"
            ? buildCharacterPrompt(request.context, execution.repair)
            : buildChoicePrompt(request.context, execution.repair);
      const messages: readonly AiMessage[] = [{ role: "system", content: request.stage === "planning"
        ? PLANNING_CONTENT_RULES
        : "你是文字润色器。输入末尾的完整表达内容是本次唯一的内容稿；把它变成对应角色的自然表达，保留每个意思。上下文仅帮助理解称呼、指代和衔接，事实表仅核对引用。你不从这些资料中选取新内容。只改变口吻、句式和停顿，不增加或替换回答、背景、理由、见闻、问题、承诺与条件。内容稿是一句，成稿也可以只有一句；同一 NPC 的全部回应一次输出。每个选项只润色自己的内容稿。最终只输出完整 JSON，不要代码围栏或解释。" },
      { role: "user", content: prompt },
      ...(request.stage === "planning" && request.context.kind === "decision"
        ? [{ role: "user" as const, content: buildPlanningContentPrompt(request.context) }] : [])];

      const audit = execution.repair === undefined ? execution.audit : {
        ...execution.audit, retry: aiRepairAuditContext(execution.repair, execution.audit.retry),
      };
      const result = await options.client.complete(role, messages, audit, {
        signal: execution.signal,
        timeoutMs: execution.timeoutMs,
      });
      if (!result.ok) {
        return providerFailure(result);
      }

      const parsed = parseStructuredJsonObject(result.content);
      if (!parsed.ok) {
        return invalidContent("invalid_json", parsed.reason);
      }

      if (request.stage === "planning") {
        if (parsed.value.opening !== null && parsed.value.opening !== undefined
          && !hasOnlyKnownOpeningCandidateKeys(parsed.value.opening)) return invalidContent("opening_unknown_keys");
        const proposal = parseLiveDraftPlan(parsed.value);
        if (!proposal.ok) return invalidContent(proposal.code, proposal.detail);
        if (repeatedNpcResponseUnits(proposal.value).length > 0) return invalidContent("plan_character_response_split");
        return { ok: true, stage: "planning", value: proposal.value };
      }

      if (request.context.draft === undefined) return invalidContent("plan_draft_missing");
      const output = applyPolish(request.context.draft, parsed.value);
      if (!output.ok) return invalidContent(output.code, output.detail);
      if (output.value.stage !== request.stage) {
        return invalidContent("invalid_schema", `stage: expected ${request.stage}; received ${output.value.stage}`);
      }
      return { ok: true, stage: request.stage, value: output.value };
    },
  } satisfies StageSource;
}
