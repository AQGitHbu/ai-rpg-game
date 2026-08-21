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
 * 通用 AI 生成失败：可出现在任何 phase。
 * 不持久化到 StoryState——只有场景失败（NarrativeGenerationFailure）才持久化。
 */
export type AiGenerationFailure = {
  readonly kind: AiFailureKind;
  readonly phase: AiFailurePhase;
};

/**
 * 可持久化到 NarrativeGenerationState 的场景失败。
 * phase 固定为 "scene"，并记录失败时间戳。
 * failedAt 使用 ISO 8601 字符串，不携带任何 provider 细节。
 */
export type NarrativeGenerationFailure = AiGenerationFailure & {
  readonly phase: "scene";
  readonly failedAt: string;
};
