// staged live source（Spec 2026-09-09 / Plan Task 5）。
//
// StageSource 的 transport 实现：每个 stage 恰好一次 RpgAiClient.complete。
// 只做 prompt 组装与 domain 解析（parsePlanProposal/parseUnitOutput），不做
// 审批、不铸 ID、不写状态；provider 失败按既有分类映射为 AiSourceFailure。

import type { AiMessage } from "@ai-game/ai-transport";
import { createAiSourceFailure, type AiSourceFailure } from "@/game/application/aiGenerationRetry";
import { transportFailureCodeToCategory } from "@/game/application/aiGenerationFailure";
import { parseStructuredJsonObject } from "@/game/core/json";
import { parsePlanProposal } from "@/game/domain/narrativePlan";
import { parseUnitOutput } from "@/game/domain/narrativeUnit";
import type {
  StageExecution,
  StageRequest,
  StageSource,
  StageSuccess,
} from "@/game/application/narrativeGeneration/stageSource";
import type { RpgAiClient, RpgAiRole } from "../rpgAiClient";
import { buildPlanningPrompt } from "./planningPrompt";
import { buildNarrationPrompt } from "./narrationPrompt";
import { buildCharacterPrompt } from "./characterPrompt";
import { buildChoicePrompt } from "./choicePrompt";

const STAGE_ROLES: Readonly<Record<StageRequest["stage"], RpgAiRole>> = {
  planning: "planning",
  narration: "narration",
  character: "character",
  choices: "choices",
};

export type CreateLiveStageSourceOptions = Readonly<{
  readonly client: RpgAiClient;
}>;

function invalidContent(code: string, detail: string) {
  return createAiSourceFailure("scene", "invalid_schema", code, detail);
}

/**
 * 单次 stage 生成：role 映射、prompt 组装、JSON 解析与失败分类的唯一实现。
 * execution.signal / execution.timeoutMs 原样透传给 client（由 transport
 * 独占取消与超时机制），audit context 原样进入审计记录。
 */
export function createLiveStageSource(options: CreateLiveStageSourceOptions): StageSource {
  return {
    async generate(
      request: StageRequest,
      execution: StageExecution,
    ): Promise<StageSuccess | AiSourceFailure> {
      const role = STAGE_ROLES[request.stage];
      const prompt = request.stage === "planning"
        ? buildPlanningPrompt(request.context, execution.repair)
        : request.stage === "narration"
          ? buildNarrationPrompt(request.context, execution.repair)
          : request.stage === "character"
            ? buildCharacterPrompt(request.context, execution.repair)
            : buildChoicePrompt(request.context, execution.repair);
      const messages: readonly AiMessage[] = [{ role: "user", content: prompt }];

      const result = await options.client.complete(role, messages, execution.audit, {
        signal: execution.signal,
        timeoutMs: execution.timeoutMs,
      });
      if (!result.ok) {
        return createAiSourceFailure("scene", transportFailureCodeToCategory(result.code));
      }

      const parsed = parseStructuredJsonObject(result.content);
      if (!parsed.ok) {
        return invalidContent("invalid_json", parsed.reason);
      }

      if (request.stage === "planning") {
        const proposal = parsePlanProposal(parsed.value);
        if (!proposal.ok) return invalidContent("invalid_schema", proposal.code);
        if (proposal.value.units.some(unit => unit.stage !== "choices" && unit.task === undefined)
          || (proposal.value.decision?.kind === "ordinary" && proposal.value.decision.options.some(option => option.task === undefined))) {
          return invalidContent("plan_task_missing", "每个 narration/character 单元及每个普通候选必须提供 task={intent,focusFactIds,prerequisiteFactIds}，不能只给笼统 instruction。");
        }
        return { ok: true, stage: "planning", value: proposal.value };
      }

      const output = parseUnitOutput(parsed.value);
      if (!output.ok) return invalidContent("invalid_schema", output.code);
      if (output.value.stage !== request.stage) {
        return invalidContent("invalid_schema", "unit_output_stage_mismatch");
      }
      return { ok: true, stage: request.stage, value: output.value };
    },
  } satisfies StageSource;
}
