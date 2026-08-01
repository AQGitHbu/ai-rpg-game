import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createLogSink,
  runLogRetention,
  SqliteLogSink,
  vacuumLogDatabase
} from "@ai-game/logging";

const DEFAULT_DB_PATH = "data/logs.db";
const DEFAULT_STANDARD_RETENTION_DAYS = 30;
const DEFAULT_AUDIT_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_MAX_RUN_MS = 30_000;
const DEFAULT_LIMIT = 1_000;

function usage() {
  return [
    "用法:",
    "  node scripts/logs.mjs query --trace <traceId> [--limit <n>] [--db <path>]",
    "  node scripts/logs.mjs query --event <event> [--limit <n>] [--db <path>]",
    "  node scripts/logs.mjs query --from <ms|ISO> --to <ms|ISO> [--limit <n>] [--db <path>]",
    "  node scripts/logs.mjs retention [--standard-days <n>] [--audit-days <n>] [--vacuum] [--db <path>]",
    "  node scripts/logs.mjs health [--db <path>]",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--help") {
      options.help = true;
      continue;
    }
    if (token === "--vacuum") {
      options.vacuum = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`未知参数: ${token}`);
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数缺少值: --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function positiveInteger(value, name, fallback) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new Error(`${name} 必须是大于 0 的安全整数`);
  }
  return candidate;
}

function timestamp(value, name) {
  if (value === undefined) throw new Error(`${name} 必须提供`);
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} 不是有效时间`);
  return parsed;
}

function databasePath(options) {
  const configured = options.db ?? process.env.GAME_LOG_DB_PATH ?? DEFAULT_DB_PATH;
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new Error("日志数据库路径不能为空");
  }
  return resolve(process.cwd(), configured.trim());
}

async function openSqlite(path) {
  const sink = await createLogSink({ backend: "sqlite", sqlitePath: path });
  if (!(sink instanceof SqliteLogSink)) {
    await sink.close();
    throw new Error("日志数据库未使用 SQLite sink");
  }
  return sink;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function query(options, path) {
  const sink = await openSqlite(path);
  try {
    const filters = [
      options.trace !== undefined,
      options.event !== undefined,
      options.from !== undefined || options.to !== undefined,
    ].filter(Boolean).length;
    if (filters !== 1) {
      throw new Error("query 必须且只能指定 --trace、--event 或 --from/--to");
    }

    let events;
    if (options.trace !== undefined) {
      if (options.trace.trim() === "") throw new Error("--trace 不能为空");
      events = await sink.queryByTraceId(options.trace.trim());
    } else if (options.event !== undefined) {
      if (options.event.trim() === "") throw new Error("--event 不能为空");
      events = await sink.queryByEvent(options.event.trim());
    } else {
      const from = timestamp(options.from, "--from");
      const to = timestamp(options.to, "--to");
      if (from > to) throw new Error("--from 不能晚于 --to");
      events = await sink.queryByTimeRange(from, to);
    }

    const limit = positiveInteger(options.limit, "--limit", DEFAULT_LIMIT);
    printJson({ dbPath: path, count: events.length, events: events.slice(-limit) });
  } finally {
    await sink.close();
  }
}

async function retention(options, path) {
  const standardDays = positiveInteger(
    options["standard-days"] ?? process.env.GAME_LOG_STANDARD_RETENTION_DAYS,
    "standard retention days",
    DEFAULT_STANDARD_RETENTION_DAYS
  );
  const auditDays = positiveInteger(
    options["audit-days"] ?? process.env.GAME_LOG_AUDIT_RETENTION_DAYS,
    "audit retention days",
    DEFAULT_AUDIT_RETENTION_DAYS
  );
  if (auditDays < standardDays) {
    throw new Error("audit retention days 不能少于 standard retention days");
  }
  const sink = await openSqlite(path);
  try {
    const result = await runLogRetention(sink.db, {
      standardRetentionDays: standardDays,
      auditRetentionDays: auditDays,
      maxRunMs: positiveInteger(
        process.env.GAME_LOG_RETENTION_MAX_RUN_MS,
        "GAME_LOG_RETENTION_MAX_RUN_MS",
        DEFAULT_RETENTION_MAX_RUN_MS
      ),
    });
    if (options.vacuum) await vacuumLogDatabase(sink.db);
    printJson({ dbPath: path, standardDays, auditDays, vacuum: Boolean(options.vacuum), ...result });
  } finally {
    await sink.close();
  }
}

async function health(path) {
  const sink = await openSqlite(path);
  try {
    const result = await sink.db.execute(
      "SELECT COUNT(*) AS count, MAX(occurred_at_ms) AS latest_occurred_at_ms FROM log_events"
    );
    const row = result.rows[0] ?? {};
    printJson({
      ok: true,
      dbPath: path,
      exists: existsSync(path),
      eventCount: Number(row.count ?? 0),
      latestOccurredAtMs: row.latest_occurred_at_ms == null
        ? null
        : Number(row.latest_occurred_at_ms),
      checkedAtMs: Date.now(),
    });
  } finally {
    await sink.close();
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || options.help !== undefined) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const path = databasePath(options);
  if (command === "query") return query(options, path);
  if (command === "retention") return retention(options, path);
  if (command === "health") return health(path);
  throw new Error(`未知命令: ${command}\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error?.name ?? "Error", message: error?.message ?? String(error) })}\n`);
  process.exitCode = 1;
});
