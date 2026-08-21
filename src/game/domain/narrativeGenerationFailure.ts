// ---------------------------------------------------------------------------
// 稳定 AI 失败分类：可持久化的安全类型。
// 只暴露两个稳定分类 + 四个阶段标识，不泄漏 provider code、错误正文或模型名。
// ---------------------------------------------------------------------------

export type AiFailureKind = "AI_CALL_FAILED" | "AI_RESPONSE_INVALID";
export type AiFailurePhase = "opening" | "intent" | "world" | "scene";

export type AiGenerationFailure = {
  readonly kind: AiFailureKind;
  readonly phase: AiFailurePhase;
};

export type NarrativeGenerationFailure = AiGenerationFailure & {
  readonly phase: "scene";
  readonly failedAt: string;
};
