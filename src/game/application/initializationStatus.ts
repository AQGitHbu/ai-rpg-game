// 初始化任务的对外安全视图（Plan 2026-09-09 / Task 10）。
//
// InitializationView 是 UI 唯一可见的初始化状态投影：只有 requestId、状态、
// 失败分类与已发布 revision。绝不包含输入、单元、骨架或任何 provider 正文
// ——这些都可能携带隐藏指令或未批准文本。

import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import type { StoredJob } from "./server/persistence/narrativeJobRepository";

export type InitializationView = Readonly<{
  requestId: string;
  status: "pending" | "failed" | "published" | "cancelled";
  failureKind?: AiFailureKind;
  revision?: number;
}>;

/** 无初始化任务时的显式状态，与「有任务」区分，避免 UI 把网络失败当 none。 */
export type InitializationStatus = InitializationView | { readonly status: "none" };

/** 存储 job 的 failureCode 是否是可对外投影的已知失败分类。 */
const KNOWN_FAILURE_KINDS: ReadonlySet<string> = new Set<string>([
  "AI_CALL_FAILED",
  "AI_RESPONSE_INVALID",
  "AI_TIMEOUT",
  "AI_RATE_LIMITED",
  "AI_AUTH_FAILED",
  "AI_CONFIG_MISSING",
  "AI_CONTENT_REJECTED",
]);

function toFailureKind(code: string | null): AiFailureKind | undefined {
  if (code === null) return undefined;
  return KNOWN_FAILURE_KINDS.has(code) ? code as AiFailureKind : undefined;
}

/**
 * 把存储 job 投影为安全视图。revision 只有 published 才有意义：
 * 未发布时不给客户端任何可据以推测存档状态的数字。
 */
export function projectInitializationView(
  job: StoredJob,
  requestId: string,
  publishedRevision?: number,
): InitializationView {
  if (job.status === "published") {
    return {
      requestId,
      status: "published",
      ...(publishedRevision === undefined ? {} : { revision: publishedRevision }),
    };
  }
  if (job.status === "failed") {
    const failureKind = toFailureKind(job.failureCode);
    return {
      requestId,
      status: "failed",
      ...(failureKind === undefined ? {} : { failureKind }),
    };
  }
  if (job.status === "cancelled") return { requestId, status: "cancelled" };
  return { requestId, status: "pending" };
}

/** 客户端提交的 requestId 形状校验：只认非空短字符串，避免任意长文本入存储。 */
export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128;
}
