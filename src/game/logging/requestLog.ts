import "server-only";

import { randomUUID } from "node:crypto";

const SAFE_TRACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_RESULT_CODE = /^[A-Za-z0-9_.-]{1,128}$/;

export type RequestLogContext = Readonly<{
  readonly traceId: string;
  readonly method: string;
  readonly route: string;
  readonly startedAtMs: number;
  markResultCode(code: string | undefined): void;
  resultCode(): string | undefined;
}>;

export type RequestLogContextOptions = Readonly<{
  method: string;
  route: string;
  traceId?: string;
  now?: () => number;
}>;

function safeTraceId(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate !== undefined && SAFE_TRACE_ID.test(candidate)
    ? candidate
    : randomUUID();
}
export function createRequestLogContext(
  options: RequestLogContextOptions
): RequestLogContext {
  const startedAtMs = options.now?.() ?? Date.now();
  const traceId = safeTraceId(options.traceId);
  let resultCode: string | undefined;

  return Object.freeze({
    traceId,
    method: options.method,
    route: options.route,
    startedAtMs,
    markResultCode(code: string | undefined) {
      const candidate = code?.trim();
      if (candidate !== undefined && SAFE_RESULT_CODE.test(candidate)) {
        resultCode = candidate;
      }
    },
    resultCode() {
      return resultCode;
    }
  });
}
