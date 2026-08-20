// ---------------------------------------------------------------------------
// AI 文本审计记录器（Task 1）。
//
// Append-only JSONL recorder：默认开启、显式关闭。
// - 路径恒为 <rootDir>/<runId>/events.jsonl
// - rootDir 取 options.rootDir，缺省为 env AI_TEXT_AUDIT_DIR，再缺省 logs/ai-text-audit
// - runId 取 env AI_TEXT_AUDIT_RUN_ID，缺省由 now() 派生一次并固定
// - 显式 runId 必须是单一安全路径片段；非法值改用自动 runId + 配置告警
// - 并发 record() 由 recorder 内部串行化（promise 链）
// - 关闭模式在首次 record 前不创建目录或文件
// ---------------------------------------------------------------------------

import "server-only";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AiTextAuditEntry,
  AiTextAuditMode,
  AiTextAuditPayload,
  AiTextAuditRecorder,
  GameApiAuditMode,
} from "./textAuditTypes";

export type TextAuditRecorderOptions = {
  readonly rootDir?: string;
  readonly now?: () => string;
  readonly onWriteFailure?: () => void;
  readonly onConfigIssue?: (code: "invalid_run_id") => void;
};

const DEFAULT_ROOT_DIR = "logs/ai-text-audit";

function resolveMode(env: Record<string, string | undefined>): AiTextAuditMode {
  const value = (env.AI_TEXT_AUDIT ?? "").trim().toLowerCase();
  if (value === "off") return "off";
  return "full";
}

/**
 * 游戏 API 审计独立于 AI 文本审计：默认 compact，只有显式 full 才保存轮询 body。
 */
function resolveGameApiMode(env: Record<string, string | undefined>): GameApiAuditMode {
  const value = (env.GAME_API_AUDIT ?? "").trim().toLowerCase();
  if (value === "off") return "off";
  if (value === "full") return "full";
  return "compact";
}

/** 检查 runId 是否为单一安全路径片段。 */
function isSafeRunId(runId: string): boolean {
  if (runId === "" || runId === "." || runId === "..") return false;
  return !/[\\/:]/.test(runId);
}

/** 把 ISO 时间戳中的路径非法字符替换为 -。 */
function sanitizeTimestampForPath(iso: string): string {
  return iso.replace(/[:]/g, "-");
}

/**
 * 创建一个 append-only JSONL 审计记录器。
 * record() 是 best-effort、永不把写入异常抛回游戏主流程。
 */
export function createTextAuditRecorder(
  env: Record<string, string | undefined> = {},
  options: TextAuditRecorderOptions = {},
): AiTextAuditRecorder {
  const mode = resolveMode(env);
  const enabled = mode !== "off";
  const gameApiMode = resolveGameApiMode(env);

  const now = options.now ?? (() => new Date().toISOString());

  // Resolve rootDir
  let rootDir: string;
  if (options.rootDir !== undefined) {
    rootDir = options.rootDir;
  } else if (env.AI_TEXT_AUDIT_DIR !== undefined && env.AI_TEXT_AUDIT_DIR.trim() !== "") {
    rootDir = env.AI_TEXT_AUDIT_DIR;
  } else {
    rootDir = DEFAULT_ROOT_DIR;
  }

  // Resolve runId
  let runId: string | undefined;
  const explicitRunId = env.AI_TEXT_AUDIT_RUN_ID?.trim();
  if (explicitRunId !== undefined && explicitRunId !== "") {
    if (isSafeRunId(explicitRunId)) {
      runId = explicitRunId;
    } else {
      // Invalid runId: fall back to auto-derived and issue config warning
      runId = sanitizeTimestampForPath(now());
      options.onConfigIssue?.("invalid_run_id");
    }
  }
  // runId is resolved lazily on first record for auto-derive case
  if (runId === undefined) {
    // Will be set on first record
  }

  // State
  let sequence = 0;
  let filePath: string | null = null;
  let dirEnsured = false;
  let chain: Promise<void> = Promise.resolve();
  let closed = false;

  function ensureFilePath(): string {
    if (filePath !== null) return filePath;
    const resolvedRunId = runId ?? sanitizeTimestampForPath(now());
    runId = resolvedRunId;
    const dir = join(rootDir, resolvedRunId);
    filePath = join(dir, "events.jsonl");
    return filePath;
  }

  async function ensureDir(): Promise<string> {
    const path = ensureFilePath();
    if (!dirEnsured) {
      const dir = join(rootDir, runId!);
      await mkdir(dir, { recursive: true });
      dirEnsured = true;
    }
    return path;
  }

  function notifyWriteFailure(): void {
    try {
      options.onWriteFailure?.();
    } catch {
      // Observability callbacks are also best-effort.
    }
  }

  function doRecord(payload: AiTextAuditPayload): Promise<void> {
    const shouldRecord = enabled || (payload.kind === "game_api" && gameApiMode !== "off");
    if (!shouldRecord || closed) return Promise.resolve();

    const entry: AiTextAuditEntry = {
      ...payload,
      sequence: sequence + 1,
      timestamp: now(),
    } as AiTextAuditEntry;
    sequence += 1;

    let line: string;
    try {
      line = JSON.stringify(entry) + "\n";
    } catch {
      notifyWriteFailure();
      return Promise.resolve();
    }

    chain = chain.then(async () => {
      try {
        const path = await ensureDir();
        await appendFile(path, line, "utf8");
      } catch {
        // best-effort: never throw back to game main flow
        notifyWriteFailure();
      }
    });

    return chain.catch(() => {
      // The chain itself must never reject, even if a future implementation
      // adds a throwing operation outside the guarded appendFile block.
      notifyWriteFailure();
    });
  }

  async function doClose(): Promise<void> {
    if (closed) return;
    closed = true;
    // Wait for the write queue to drain
    try {
      await chain;
    } catch {
      // Swallow close exceptions
    }
  }

  return {
    enabled,
    gameApiMode,
    record: doRecord,
    close: doClose,
  };
}
