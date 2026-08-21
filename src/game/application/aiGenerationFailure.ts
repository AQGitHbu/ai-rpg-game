import type {
  AiFailureKind,
  AiFailurePhase,
  AiGenerationFailure,
} from "@/game/domain/narrativeGenerationFailure";

// ---------------------------------------------------------------------------
// Application-only error class：携带稳定 kind/phase，不暴露 provider 原始信息。
// Domain 代码不导入此文件；只由 live source / use case 使用。
// ---------------------------------------------------------------------------

export class AiGenerationError extends Error {
  readonly kind: AiFailureKind;
  readonly phase: AiFailurePhase;

  constructor(
    kind: AiFailureKind,
    phase: AiFailurePhase,
    message: string,
  ) {
    super(message);
    this.name = "AiGenerationError";
    this.kind = kind;
    this.phase = phase;
  }
}

// ---------------------------------------------------------------------------
// 分类映射：把内部 source 失败原因映射为两个稳定 kind。
// transport/unavailable/timeout/rate_limit/service_error/empty_response
//   → AI_CALL_FAILED
// invalid_json/invalid_schema/invalid_reference/approval_rejected/unknown
//   → AI_RESPONSE_INVALID（unknown 归为 AI_CALL_FAILED 以保守对待）
// ---------------------------------------------------------------------------

export type AiFailureCategory =
  | "transport"
  | "unavailable"
  | "timeout"
  | "rate_limit"
  | "service_error"
  | "empty_response"
  | "invalid_json"
  | "invalid_schema"
  | "invalid_reference"
  | "approval_rejected"
  | "unknown";

const CALL_FAILED_CATEGORIES: ReadonlySet<AiFailureCategory> = new Set([
  "transport",
  "unavailable",
  "timeout",
  "rate_limit",
  "service_error",
  "empty_response",
]);

const RESPONSE_INVALID_CATEGORIES: ReadonlySet<AiFailureCategory> = new Set([
  "invalid_json",
  "invalid_schema",
  "invalid_reference",
  "approval_rejected",
]);

export function classifyAiFailure(input: {
  readonly phase: AiFailurePhase;
  readonly category: AiFailureCategory;
}): AiGenerationFailure {
  const kind: AiFailureKind = RESPONSE_INVALID_CATEGORIES.has(input.category)
    ? "AI_RESPONSE_INVALID"
    : CALL_FAILED_CATEGORIES.has(input.category)
      ? "AI_CALL_FAILED"
      : "AI_CALL_FAILED"; // unknown → conservative AI_CALL_FAILED
  return { kind, phase: input.phase };
}
