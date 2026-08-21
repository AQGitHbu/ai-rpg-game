import type {
  AiFailureKind,
  AiFailurePhase,
  AiGenerationFailure,
} from "@/game/domain/narrativeGenerationFailure";

/**
 * Server/application 层的 AI 生成错误。
 *
 * 携带稳定 kind 与 phase，message 只用于 server 端日志，不进入客户端、存档或玩家文案。
 * Domain code 不得 import 此文件——domain 只依赖 narrativeGenerationFailure.ts 的纯类型。
 *
 * 不使用 TypeScript parameter-property 语法（`constructor(private readonly ...`），
 * 因为项目在部分 smoke 脚本中运行 Node type stripping。
 */
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

/**
 * 内部 source 失败的分类输入：将 provider/transport/schema/审批等具体失败原因
 * 映射为玩家可见的稳定 AiGenerationFailure。
 */
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
  "unknown",
]);

/**
 * 将内部失败分类映射为稳定的 AiGenerationFailure。
 *
 * - transport/unavailable/timeout/rate_limit/service_error/empty_response/unknown → AI_CALL_FAILED
 * - invalid_json/invalid_schema/invalid_reference/approval_rejected → AI_RESPONSE_INVALID
 */
export function classifyAiFailure(input: {
  readonly phase: AiFailurePhase;
  readonly category: AiFailureCategory;
}): AiGenerationFailure {
  const kind: AiFailureKind = CALL_FAILED_CATEGORIES.has(input.category)
    ? "AI_CALL_FAILED"
    : "AI_RESPONSE_INVALID";
  return { kind, phase: input.phase };
}
