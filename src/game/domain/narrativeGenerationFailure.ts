/**
 * AI 生成失败的持久化安全类型。
 *
 * 这些类型只携带玩家可见的稳定分类，不包含 provider 错误码、响应正文、
 * prompt、URL、模型名或密钥。domain 层定义它们，application 层负责映射
 * 内部 source 结果到这些类型。
 */

/** 玩家可见的稳定失败分类：调用失败或返回格式不符合要求。 */
export type AiFailureKind = "AI_CALL_FAILED" | "AI_RESPONSE_INVALID";

/** 失败发生的生产角色：开局、意图、世界演化或场景表演。 */
export type AiFailurePhase = "opening" | "intent" | "world" | "scene";

/**
 * 可安全持久化、可直接写入修复 prompt 的原因码。
 * 原因码只描述契约/编排问题，不包含 provider 原文、用户输入或模型输出。
 */
export type NarrativeGenerationRepairReason =
  | "empty_response"
  | "invalid_json"
  | "root_not_object"
  | "segments_empty"
  | "segment_invalid"
  | "segment_unknown_beat"
  | "npc_line_invalid_shape"
  | "npc_line_unusable"
  | "npc_dialogues_invalid"
  | "objective_link_invalid_shape"
  | "objective_link_invalid_fields"
  | "choices_invalid"
  | "choices_stale_template"
  | "handoff_acknowledgement_invalid"
  | "prepared_continuations_invalid"
  | "invalid_schema"
  | "unit_output_label_invalid"
  | "unit_output_stage_invalid"
  | "provider_failure"
  | "source_exception"
  | `approval:${string}`;

/** Persisted reason codes must stay short, opaque, and free of model/provider text. */
export function isSafeNarrativeGenerationRepairReason(value: unknown): value is NarrativeGenerationRepairReason {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9:_-]+$/u.test(value);
}

/**
 * 通用 AI 生成失败：可出现在任何 phase。
 * 不持久化到 StoryState——只有场景失败（NarrativeGenerationFailure）才持久化。
 */
export type AiGenerationFailure = {
  readonly kind: AiFailureKind;
  readonly phase: AiFailurePhase;
};

/**
 * 可持久化到 NarrativeRuntimeState provider_failed 变体的场景失败。
 * phase 固定为 "scene"，并记录失败时间戳。
 * failedAt 使用 ISO 8601 字符串，不携带任何 provider 细节。
 */
export type NarrativeGenerationFailure = AiGenerationFailure & {
  readonly phase: "scene";
  readonly failedAt: string;
  /** 上一次失败的稳定原因码，旧存档可缺省。 */
  readonly reason?: NarrativeGenerationRepairReason;
};

/** provider_failed → provider_pending 时携带给下一次生成的修复上下文。 */
export type NarrativeGenerationRetryContext = Readonly<{
  readonly attempt: 1;
  readonly reason: NarrativeGenerationRepairReason;
}>;
