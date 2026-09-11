import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findUsableAiEnvSource, projectRoot } from "./aiEnv.mjs";

// ---------------------------------------------------------------------------
// stagedNarrativeSmoke：opt-in 的分阶段叙事真实 AI smoke（Plan 2026-09-09 /
// Task 12 Step 3）。
//
// 目的：用 production-equivalent 装配跑完整分阶段链路——开局（initialize）→
// 同一批准决策的两个分支续接——确认：3 个开局、6 次续接全部在预算内成功，
// 且至少一条短篇能从开局运行至合法结局。
//
// 安全红线（由 stagedNarrativeSmoke.node-test.mjs 门禁强制）：
// - 必须 RUN_REAL_AI_SMOKE=1 才运行；否则退出非零且不发起任何请求。
// - 运行前先跑 `npm run env:check`；stdout/stderr 绝不打印键值。
// - 每局只输出白名单摘要：gameType、ok/source、耗时、请求数、分支身份。
//   永不输出玩家输入、prompt、模型原文、URL、Key、临时库路径。
// - 使用独立临时 GAME_DB_PATH，绝不读写用户当前存档槽位。
// - 全 run 上限：160 次 provider transport 请求、45 分钟；任一达到即停止
//   后续局并记录未完成，不因失败重复采样直到成功。
// - 决不加入 npm test / test:fast / build / CI。
//
// 本文件是 .mjs（Node 直接运行）：真实链路的 TS 依赖只在 opt-in 实跑路径里，
// 经 node:module registerHooks 惰性加载（Node 24 原生 strip-types；钩子补齐
// tsconfig 的 @/ 别名、无扩展名相对导入与 JSON 导入）。门禁测试主体 import
// 下方纯函数并注入 mock；另有两条离线实跑用例以占位 AI 配置驱动
// realRunOpening / realRunContinuation（unavailable → failed，会加载 TS 但
// 绝不触网）。
// ---------------------------------------------------------------------------

const DIAG_PREFIX = "[staged-smoke]";

/** 真实 AI 验收唯一的成功来源。 */
export const REQUIRED_SOURCE = "generated";
export const VALID_FAILURE_KINDS = Object.freeze(["AI_CALL_FAILED", "AI_RESPONSE_INVALID"]);

/** 有界预算（Spec §9）：全 run 的硬上限，达到任一即停止。 */
export const SMOKE_LIMITS = Object.freeze({
  maxProviderRequests: 160,
  maxDurationMs: 45 * 60 * 1000,
  /** 单局通关推进的最大回合数：短篇也应远低于此，超出即判未通关。 */
  maxTurnsPerPlaythrough: 40,
});

/**
 * 三组固定合法输入：字段均满足 domain 校验下限（characterName≥2、identity≥2、
 * worldPremise≥20、storyOpening≥20）。每局声明恰好两个候选，覆盖
 * 「同一批准决策的两个分支」；范围覆盖武侠 / 科幻 / 都市三个 gameType。
 * 内容不承载任何真实密钥或环境信息，且绝不进入日志输出。
 */
export const SMOKE_CASES = Object.freeze([
  {
    gameType: "wuxia",
    gameLength: "short",
    // 首局承担「从开局运行至合法结局」的验收：续接成功不能替代通关。
    playToEnding: true,
    candidateIds: ["cand_left", "cand_right"],
    input: {
      gameType: "wuxia",
      gameLength: "short",
      characterName: "沈孤鸿",
      characterIdentity: "游历江湖的剑客",
      worldPremise: "动荡江湖中，一座边城被三股势力暗中争夺。",
      storyOpening: "你抵达边城时，守门人低声说昨夜有人翻墙出城。",
      seed: "staged-smoke-wuxia",
    },
  },
  {
    gameType: "science_fiction",
    gameLength: "short",
    candidateIds: ["cand_left", "cand_right"],
    input: {
      gameType: "science_fiction",
      gameLength: "short",
      characterName: "凯伦",
      characterIdentity: "空间站维生工程师",
      worldPremise: "轨道站在一次微陨石撞击后失去了三分之一的供氧能力。",
      storyOpening: "警报解除的第三分钟，你在舱门旁发现了一串不属于任何人的脚印。",
      seed: "staged-smoke-science-fiction",
    },
  },
  {
    gameType: "urban",
    gameLength: "short",
    candidateIds: ["cand_left", "cand_right"],
    input: {
      gameType: "urban",
      gameLength: "short",
      characterName: "林晚",
      characterIdentity: "刚调任的社区民警",
      worldPremise: "老城区拆迁在即，几户人家的旧账在这几天集中浮出水面。",
      storyOpening: "你到岗第一天，值班室的电话在凌晨两点响了三次。",
      seed: "staged-smoke-urban",
    },
  },
]);

// ---------------------------------------------------------------------------
// 纯函数：报告校验与白名单摘要（门禁测试直接断言）
// ---------------------------------------------------------------------------

export function validateBranchReport(report) {
  const issues = [];
  if (!report || typeof report !== "object") return ["BRANCH_REPORT_MISSING"];
  if (report.ok === true) return issues;
  // 续接未成功即未完成：Spec §11 要求 6/6 续接在预算内成功，缺一即不通过。
  issues.push("BRANCH_NOT_SUCCEEDED");
  if (!VALID_FAILURE_KINDS.includes(report.failureKind)) issues.push("BRANCH_FAILURE_KIND_INVALID");
  if (typeof report.failureCode !== "string") issues.push("BRANCH_FAILURE_CODE_MISSING");
  return issues;
}

export function validateOpeningReport(report) {
  if (!report || typeof report !== "object") return ["REPORT_MISSING"];
  const issues = [];
  if (report.ok === true) {
    if (report.source !== REQUIRED_SOURCE) issues.push("OPENING_SOURCE_NOT_GENERATED");
    if (report.reloadOk !== true) issues.push("OPENING_RELOAD_FAILED");
    if (!Array.isArray(report.branches) || report.branches.length !== 2) {
      issues.push("OPENING_BRANCH_COUNT_INVALID");
    } else {
      for (const branch of report.branches) {
        for (const issue of validateBranchReport(branch)) issues.push(issue);
      }
    }
    // 通关局必须真的到达合法结局：续接成功不能替代「从开局运行至结局」。
    if (report.playthrough !== undefined) {
      const playthrough = report.playthrough;
      if (!playthrough || typeof playthrough !== "object") {
        issues.push("PLAYTHROUGH_REPORT_MISSING");
      } else if (playthrough.endingReached !== true) {
        issues.push("PLAYTHROUGH_ENDING_NOT_REACHED");
      }
    }
    return issues;
  }
  // 验收口径（Spec §11）：smoke 的通过标准是「每局都由真实 AI 生成且续接成功」。
  // 因此任何 ok !== true 的报告本身就是违约，绝不允许「编码合法的失败」冒充通过。
  // 失败诊断码仅在违约被记录后用于定位，不再作为通过依据。
  issues.push("OPENING_NOT_GENERATED");
  if (!VALID_FAILURE_KINDS.includes(report.failureKind)) issues.push("OPENING_FAILURE_KIND_INVALID");
  if (typeof report.failureCode !== "string") issues.push("OPENING_FAILURE_IDENTITY_MISSING");
  return issues;
}

/** 白名单重建：绝不透传报告里其他字段（错误文本、路径、正文）。 */
export function buildOpeningSummaryLine(report) {
  const payload = {
    gameType: typeof report?.gameType === "string" ? report.gameType : "unknown",
    ok: report?.ok === true,
    durationMs: typeof report?.durationMs === "number" ? Math.round(report.durationMs) : 0,
    requestCount: typeof report?.requestCount === "number" ? report.requestCount : 0,
  };
  if (report?.ok === true) {
    payload.source = report.source === REQUIRED_SOURCE ? REQUIRED_SOURCE : "invalid";
    payload.branches = (Array.isArray(report.branches) ? report.branches : []).map((branch) => ({
      candidateId: typeof branch?.candidateId === "string" ? branch.candidateId : "unknown",
      ok: branch?.ok === true,
      durationMs: typeof branch?.durationMs === "number" ? Math.round(branch.durationMs) : 0,
      requestCount: typeof branch?.requestCount === "number" ? branch.requestCount : 0,
    }));
    if (report.playthrough !== undefined) {
      payload.playthrough = {
        endingReached: report.playthrough?.endingReached === true,
        turns: typeof report.playthrough?.turns === "number" ? report.playthrough.turns : 0,
      };
    }
  } else {
    payload.failureCode = typeof report?.failureCode === "string" ? report.failureCode : "unknown";
    payload.failureKind = VALID_FAILURE_KINDS.includes(report?.failureKind) ? report.failureKind : "unknown";
  }
  return `${DIAG_PREFIX} opening ${JSON.stringify(payload)}`;
}

export function buildBranchSummaryLine(report) {
  const payload = {
    candidateId: typeof report?.candidateId === "string" ? report.candidateId : "unknown",
    ok: report?.ok === true,
    durationMs: typeof report?.durationMs === "number" ? Math.round(report.durationMs) : 0,
    requestCount: typeof report?.requestCount === "number" ? report.requestCount : 0,
    ...(report?.ok === true ? {} : { failureCode: typeof report?.failureCode === "string" ? report.failureCode : "unknown" }),
  };
  return `${DIAG_PREFIX} branch ${JSON.stringify(payload)}`;
}

/** 从（本就脱敏的）audit 事件提取稳定诊断码、token 合计与成本估算合计。 */
export function summarizeAuditEvents(events) {
  const codes = [];
  const usage = {};
  // 真实来源标记只认审计事件里的 story_text.source（"generated" 表示真实 AI 产出）；
  // 组合根返回的视图不含此字段，因此绝不可用视图推断来源。
  const sources = [];
  let estimatedCostUsd;
  const addTokens = (key, value) => {
    if (typeof value !== "number") return;
    usage[key] = (usage[key] ?? 0) + value;
  };
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.kind === "ai_call") {
      codes.push(event.output?.ok === true ? "attempt_ok" : `transport_${event.output?.code ?? "unknown"}`);
      for (const key of ["promptTokens", "completionTokens", "totalTokens"]) addTokens(key, event.output?.usage?.[key]);
      continue;
    }
    if (typeof event.source === "string" && (event.kind === undefined || event.kind === "story_text")) {
      sources.push(event.source);
    }
    if (event.outcome === "ok") codes.push("attempt_ok");
    else if (typeof event.transportCode === "string") codes.push(`transport_${event.transportCode}`);
    else if (typeof event.category === "string") codes.push(event.category);
    addTokens("promptTokens", event.promptTokens);
    addTokens("completionTokens", event.completionTokens);
    addTokens("totalTokens", event.totalTokens);
    if (typeof event.estimatedCostUsd === "number") {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + event.estimatedCostUsd;
    }
  }
  return {
    codes,
    sources,
    usage: Object.keys(usage).length > 0 ? usage : undefined,
    estimatedCostUsd,
  };
}

/** 输出格式安全标签：合法值原样、缺失/空白→prompt_only、其余→invalid（绝不回显原值）。 */
export const AI_OUTPUT_FORMAT_LABELS = Object.freeze(["json_schema", "json_object", "prompt_only"]);
export function resolveOutputFormatLabel(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return "prompt_only";
  return AI_OUTPUT_FORMAT_LABELS.includes(trimmed) ? trimmed : "invalid";
}

/** 安全汇总：只聚合白名单可观测字段；通过条件独立于本函数。 */
export function summarizeSmokeRun(reports, outputFormatLabel) {
  const summary = {
    outputFormat: outputFormatLabel,
    openings: { total: 0, generated: 0, failed: 0 },
    continuations: { total: 0, ok: 0, failed: 0 },
    playthroughsReached: 0,
    totalRequests: 0,
    totalDurationMs: 0,
  };
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    summary.openings.total += 1;
    // 每局的 durationMs/requestCount 已含分支与通关推进，不重复累加。
    if (typeof report.durationMs === "number") summary.totalDurationMs += Math.round(report.durationMs);
    if (typeof report.requestCount === "number") summary.totalRequests += report.requestCount;
    if (report.ok === true && report.source === REQUIRED_SOURCE) summary.openings.generated += 1;
    else summary.openings.failed += 1;
    for (const branch of Array.isArray(report.branches) ? report.branches : []) {
      summary.continuations.total += 1;
      if (branch?.ok === true) summary.continuations.ok += 1;
      else summary.continuations.failed += 1;
    }
    if (report.playthrough?.endingReached === true) summary.playthroughsReached += 1;
  }
  return summary;
}

export function buildRunSummaryLine(reports, outputFormatLabel) {
  return `${DIAG_PREFIX} summary ${JSON.stringify(summarizeSmokeRun(reports, outputFormatLabel))}`;
}

// ---------------------------------------------------------------------------
// 编排核心（纯逻辑，依赖全部注入）：返回进程退出码，0 = 全部通过。
// deps.env / runEnvCheck / runOpening / runContinuation / log 由调用方提供，
// 门禁测试注入 mock（绝不注入真实网络调用）。
// ---------------------------------------------------------------------------

export async function runStagedNarrativeSmoke(deps) {
  const { env, runEnvCheck, runOpening, runContinuation, log, outputFormatLabel } = deps;

  if (env.RUN_REAL_AI_SMOKE !== "1") {
    log(
      `${DIAG_PREFIX} SMOKE_OPT_IN_REQUIRED：分阶段叙事 smoke 需显式设置 RUN_REAL_AI_SMOKE=1，未发起任何请求。`,
    );
    return 1;
  }

  const envCheck = await runEnvCheck();
  if (!envCheck.ok) {
    log(`${DIAG_PREFIX} SMOKE_ENV_CHECK_FAILED：env:check 未通过，终止 smoke（未打印任何键值）。`);
    return 1;
  }

  const reports = [];
  let failures = 0;
  let spentRequests = 0;
  let spentMs = 0;
  let stopped = false;

  for (const smokeCase of SMOKE_CASES) {
    // 任一上限达到即停止调度后续局（Spec §9：达到任一上限即失败）。
    // 检查在每局开始前进行：超限的局不启动，也不计入通过。
    if (spentRequests >= SMOKE_LIMITS.maxProviderRequests || spentMs >= SMOKE_LIMITS.maxDurationMs) {
      stopped = true;
      log(
        `${DIAG_PREFIX} SMOKE_BUDGET_STOP 已达全 run 上限（requests=${spentRequests}/${SMOKE_LIMITS.maxProviderRequests}，`
        + `ms=${Math.round(spentMs)}/${SMOKE_LIMITS.maxDurationMs}），停止后续局；未完成的局不计入通过。`,
      );
      break;
    }

    let report;
    try {
      report = await runOpening(smokeCase, { runContinuation });
    } catch {
      // 本地脚本/持久化崩溃：异常文本可能含路径等细节，绝不回显，只记稳定码。
      failures += 1;
      log(`${DIAG_PREFIX} STAGED_OPENING_CRASHED gameType=${smokeCase.gameType}`);
      reports.push({ gameType: smokeCase.gameType, ok: false });
      continue;
    }

    reports.push(report);
    // 每局的 requestCount 由 runOpening 汇总（含分支与通关推进），
    // 编排层不再重复累加 branches，避免双重计数。
    if (typeof report?.durationMs === "number") spentMs += report.durationMs;
    if (typeof report?.requestCount === "number") spentRequests += report.requestCount;

    if (report && typeof report === "object") log(buildOpeningSummaryLine(report));
    for (const branch of Array.isArray(report?.branches) ? report.branches : []) {
      if (!branch || typeof branch !== "object") continue;
      log(buildBranchSummaryLine(branch));
      const branchIssues = validateBranchReport(branch);
      if (branchIssues.length > 0) {
        log(
          `${DIAG_PREFIX} STAGED_BRANCH_VIOLATION gameType=${smokeCase.gameType} `
          + `candidateId=${branch.candidateId ?? "unknown"} codes=${branchIssues.join(",")}`,
        );
      }
    }

    const issues = validateOpeningReport(report);
    if (issues.length > 0) {
      failures += 1;
      log(`${DIAG_PREFIX} STAGED_OPENING_VIOLATION gameType=${smokeCase.gameType} codes=${issues.join(",")}`);
    }
  }

  log(buildRunSummaryLine(reports, outputFormatLabel ?? "prompt_only"));

  if (failures > 0) {
    log(`${DIAG_PREFIX} SMOKE_FAILED：${failures}/${reports.length} 局违约。`);
    return 1;
  }
  if (stopped || reports.length !== SMOKE_CASES.length) {
    log(`${DIAG_PREFIX} SMOKE_FAILED：预算停止导致 ${SMOKE_CASES.length - reports.length} 局未完成。`);
    return 1;
  }
  log(`${DIAG_PREFIX} SMOKE_OK：${reports.length} 局均由真实 AI 生成，续接全部成功。`);
  return 0;
}

// ---------------------------------------------------------------------------
// 真实实跑装配（opt-in CLI 路径使用；门禁测试仅经离线 failed 用例触达，
// 即 overrides.aiEnv 注入占位配置 → unavailable source，不发起任何请求）。
// ---------------------------------------------------------------------------

let tsHooksInstalled = false;

/** 安装 TS 解析钩子：Node 24 原生 strip-types，本钩子补 @/ 别名与 JSON 导入。 */
function installTsHooks() {
  if (tsHooksInstalled) return;
  tsHooksInstalled = true;
  const srcRoot = resolve(projectRoot, "src");

  const tryFile = (base) => {
    for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
      const candidate = base + suffix;
      if (candidate.endsWith("/")) continue;
      if (existsSync(candidate) && /\.(ts|tsx|json|mjs|js)$/.test(candidate)) return candidate;
    }
    return null;
  };

  registerHooks({
    resolve(specifier, context, nextResolve) {
      // `server-only` 在 Next 编译器外会直接抛错；与 vitest.config.ts 同策略映射到无行为 shim。
      if (specifier === "server-only") {
        return { url: pathToFileURL(resolve(srcRoot, "test-server-only.ts")).href, shortCircuit: true };
      }
      if (specifier.startsWith("@/")) {
        const found = tryFile(resolve(srcRoot, specifier.slice(2)));
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        context.parentURL?.startsWith("file:") &&
        !/\.[a-z]+$/i.test(specifier)
      ) {
        const base = resolve(dirname(fileURLToPath(context.parentURL)), specifier);
        const found = tryFile(base);
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      // TS 源按 resolveJsonModule 风格裸导入 JSON（无 import attributes）：
      // 转成带 default 导出的模块，行为与 bundler 一致。
      if (url.endsWith(".json") && context.importAttributes?.type !== "json") {
        const source = readFileSync(fileURLToPath(url), "utf8");
        return { format: "module", source: `export default ${source};`, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

/** 惰性加载 TS 侧模块：与生产 API 路由相同的 compositionRoot 装配入口。 */
let tsModulesPromise = null;
function loadTsModules() {
  tsModulesPromise ??= (async () => {
    installTsHooks();
    const composition = await import("../src/game/application/server/compositionRoot.ts");
    const sqlite = await import("../src/game/application/server/persistence/sqliteClient.ts");
    const diagnostics = await import("../src/game/application/server/ai/staged/requestDiagnostics.ts");
    return {
      createServerGameEntryPoints: composition.createServerGameEntryPoints,
      createSqliteClient: sqlite.createSqliteClient,
      drainRequestDiagnostics: diagnostics.drainRequestDiagnostics,
    };
  })();
  return tsModulesPromise;
}

/** 真实 env:check：spawn `npm run env:check`，只回传通过与否，绝不转发其输出。 */
function realRunEnvCheck() {
  const isWindows = process.platform === "win32";
  // 与 startCurrentPhase.mjs 相同的 Windows npm 调用方式（cmd.exe 执行 .cmd）。
  const command = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const args = isWindows ? ["/d", "/s", "/c", "npm.cmd run env:check"] : ["run", "env:check"];
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "ignore",
    windowsHide: true,
  });
  return { ok: result.status === 0 };
}

function toAiEnvRecord(values) {
  return {
    AI_API_BASE_URL: values.get("AI_API_BASE_URL")?.decoded,
    AI_MODEL: values.get("AI_MODEL")?.decoded,
    AI_API_KEY: values.get("AI_API_KEY")?.decoded,
    AI_OUTPUT_FORMAT: values.get("AI_OUTPUT_FORMAT")?.decoded,
  };
}

/**
 * 解析真实 AI 配置来源。找不到可用来源时抛出稳定错误（不含路径/值），
 * 由 runStagedNarrativeSmoke 记为该局崩溃，绝不以空配置继续。
 */
function resolveAiEnvOrThrow() {
  const source = findUsableAiEnvSource({ target: resolve(projectRoot, ".env.local") });
  if (source === null) throw new Error("AI_ENV_SOURCE_NOT_FOUND");
  return toAiEnvRecord(source.values);
}

const TEMP_DB_PREFIX = "staged-narrative-smoke-";

/** Windows 下 SQLite 句柄可能延迟释放：删除临时文件时短暂重试。 */
async function removeTempDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = databasePath + suffix;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(target, { force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 文件审计读取。
//
// 审计记录器（textAuditRecorder）写的是 append-only JSONL 文件
// （<AI_TEXT_AUDIT_DIR>/<runId>/events.jsonl），**不经 console.log**。
// 因此绝不能靠拦截 console 统计 provider 请求或判定生成来源——那样恒为 0 条，
// 会让「预算内成功」与「真实 AI 生成」双双失去证据。
// ---------------------------------------------------------------------------

/** 单次审计会话目录里的事件文件相对路径。 */
const AUDIT_EVENTS_FILE = "events.jsonl";

/** 列出审计根目录下的 run 目录名（按名升序，名字含 ISO 时间戳）。 */
function listAuditRunDirs(rootDir) {
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** 读取某个 run 目录里的全部审计事件；解析失败的行跳过，绝不抛出。 */
function readAuditEvents(rootDir, runId) {
  const file = join(rootDir, runId, AUDIT_EVENTS_FILE);
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 半截行（进程被强杀时可能出现）：跳过。
    }
  }
  return events;
}

/** 读取在 `before` 之后新建的全部审计事件（smoke 每次运行前记录基线）。 */
function readAuditEventsSince(rootDir, before) {
  const baseline = new Set(before);
  const events = [];
  for (const runId of listAuditRunDirs(rootDir)) {
    if (baseline.has(runId)) continue;
    events.push(...readAuditEvents(rootDir, runId));
  }
  return events;
}

/** 审计根目录：smoke 用临时目录，绝不写入用户 logs/。 */
const TEMP_AUDIT_PREFIX = "staged-narrative-smoke-audit-";

/**
 * 在临时 SQLite 上装配 production composition root。绝不接触用户当前存档：
 * 全部读写都落在本次随机命名的临时库上，退出前删除。审计同样定向到本次的
 * 临时根（AI_TEXT_AUDIT_DIR），不污染用户 logs/。
 *
 * `run` 的第二参数是本局审计读取句柄：开局前先取基线，运行后只读新增 run 目录。
 */
async function withTempEntry(overrides, run) {
  const modules = await loadTsModules();
  // 与 `npm run env:check` 使用同一来源解析规则（aiEnv.findUsableAiEnvSource）：
  // worktree 内 `.env.local` 通常不含 AI 三键，真实配置在主仓/同族仓；若此处
  // 只读 worktree 本地文件，会静默解析为 unavailable source → 零请求秒失败，
  // 而 envCheck 仍通过，造成「门禁绿灯 + 实际全红」的假阳性。
  const aiEnv = overrides.aiEnv ?? resolveAiEnvOrThrow();
  const tmpRoot = resolve(projectRoot, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const auditRoot = join(tmpRoot, `${TEMP_AUDIT_PREFIX}${randomUUID()}`);
  mkdirSync(auditRoot, { recursive: true });
  // 审计基线：本局之前的 run 目录一律不计入本局统计。
  const auditBaseline = listAuditRunDirs(auditRoot);
  const audit = {
    /** 读取自基线以来新增的全部审计事件。 */
    eventsSinceBaseline: () => readAuditEventsSince(auditRoot, auditBaseline),
  };
  const databasePath = join(tmpRoot, `${TEMP_DB_PREFIX}${randomUUID()}.sqlite`);
  const logDatabasePath = `${databasePath}.logs.sqlite`;
  if (overrides.snapshotPath) copyFileSync(overrides.snapshotPath, databasePath);
  const entry = modules.createServerGameEntryPoints({
    AI_API_BASE_URL: aiEnv.AI_API_BASE_URL,
    AI_MODEL: aiEnv.AI_MODEL,
    AI_API_KEY: aiEnv.AI_API_KEY,
    AI_OUTPUT_FORMAT: aiEnv.AI_OUTPUT_FORMAT,
    AI_REQUEST_DIAGNOSTICS: "1",
    GAME_DB_PATH: databasePath,
    GAME_LOG_DB_PATH: logDatabasePath,
    AI_TEXT_AUDIT_DIR: auditRoot,
  });
  let entryClosed = false;
  audit.failureCode = async () => {
    const client = modules.createSqliteClient(databasePath);
    try {
      const result = await client.execute("SELECT payload_json FROM narrative_jobs WHERE status = 'failed' ORDER BY rowid DESC LIMIT 1");
      const payload = result.rows[0]?.payload_json;
      return typeof payload === "string" ? JSON.parse(payload).failureCode : null;
    } finally { client.close(); }
  };
  try {
    const fork = async (callback) => {
      const snapshotPath = join(tmpRoot, `${TEMP_DB_PREFIX}${randomUUID()}.sqlite`);
      const client = modules.createSqliteClient(databasePath);
      try {
        await client.execute({ sql: "VACUUM INTO ?", args: [snapshotPath] });
        return await withTempEntry({ ...overrides, aiEnv, snapshotPath }, callback);
      } finally {
        client.close();
        await removeTempDatabase(snapshotPath);
      }
    };
    const result = await run(entry, audit, fork);
    // 可选诊断钩子只访问本次隔离库；便于重放/检查失败，不接触用户存档。
    if (overrides.inspect !== undefined) await overrides.inspect({ entry, databasePath, auditRoot });
    return result;
  } finally {
    await modules.drainRequestDiagnostics();
    if (!entryClosed) {
      try {
        await entry.close();
      } catch {
        // 仅尝试清理本次创建的临时库；占用残留保留，不扫描其他运行目录。
      }
    }
    await removeTempDatabase(databasePath);
    await removeTempDatabase(logDatabasePath);
    // 保留本次审计证据供人工质量验收；不自动删除失败样本。
  }
}

/**
 * 轮询初始化任务直到终态：成功 / 失败 / 超时。只返回白名单字段。
 *
 * `getInitialization` 的返回形状是 `{ ok: true, view: InitializationView }`，
 * 状态在 `result.view.status`（不是 `result.status`）。早期版本误读顶层
 * `status`，导致失败的 job 永远轮询不到终态、一律超时，把真实失败码
 * `unit_output_fact_unavailable` 掩盖成 `INITIALIZATION_TIMEOUT`，
 * 同时摘要显示 `requestCount: 0`（看起来像「零请求秒失败」）。
 * 视图只投影 `failureKind`（白名单分类），不含 `failureCode`，因此失败时
 * 以 `failureKind` 为准，缺失时回退稳定码。
 */
async function awaitInitialization(entry, requestId, budget) {
  const deadline = performance.now() + budget;
  while (performance.now() < deadline) {
    const result = await entry.getInitialization(requestId);
    const view = result?.ok === true ? result.view : undefined;
    const status = typeof view?.status === "string" ? view.status : undefined;
    if (status === "published") return { ok: true };
    if (status === "failed" || status === "cancelled") {
      return {
        ok: false,
        failureCode: typeof result.failureCode === "string" ? result.failureCode : "INITIALIZATION_FAILED",
        failureKind: typeof view?.failureKind === "string" ? view.failureKind : "AI_CALL_FAILED",
      };
    }
    await sleep(1000);
  }
  return { ok: false, failureCode: "INITIALIZATION_TIMEOUT", failureKind: "AI_TIMEOUT" };
}

/**
 * 真实开局：createGame（异步初始化）→ 轮询至就绪 → 同一批准决策两个分支续接。
 * 每个分支在独立临时库上重放，避免前一个分支的选择污染另一个的初始状态。
 * 只返回白名单可观测字段，绝不透传正文或路径。
 */
export async function realRunOpening(smokeCase, overrides = {}) {
  // 开局自身的请求与两个分支的请求分别统计，便于总量预算判定。
  const { report, requestCount, durationMs } = await withTempEntry(overrides, async (entry, audit, fork) => {
    const startedAt = performance.now();
    // requestId 是持久初始化任务的幂等键，属 CreateGameInput 必填项
    // （compositionRoot 注释：路由层已做形状校验）。smoke 直连组合根，
    // 必须自己补上；缺失会让 startInitialization 以 INFRASTRUCTURE_FAILURE
    // 在毫秒级提前返回，且零 provider 请求。
    const requestId = `staged-smoke-${randomUUID()}`;
    const { gameType, gameLength, seed: _seed, ...setup } = smokeCase.input;
    const created = await entry.createGame({ gameType, gameLength,
      setup: { personalityTags: [], narrativeStyle: "concise", contentIntensity: "normal", ...setup }, requestId });
    const ready = created.ok === true
      ? await awaitInitialization(entry, requestId, 5 * 60 * 1000)
      : { ok: false, failureCode: "CREATE_GAME_NOT_STARTED", failureKind: "AI_CALL_FAILED" };

    // 审计只在整段生命周期结束后统一读取：provider 调用发生在后台初始化
    // 任务里，任何早于 awaitInitialization 返回的读取都会漏记请求。
    const events = audit.eventsSinceBaseline();
    const { codes, sources } = summarizeAuditEvents(events);
    const requestCount = codes.length;

    if (created.ok !== true) {
      return {
        durationMs: performance.now() - startedAt,
        requestCount,
        report: {
          gameType: smokeCase.gameType,
          ok: false,
          failureCode: typeof created.code === "string" ? created.code : "CREATE_GAME_FAILED",
          failureKind: "AI_CALL_FAILED",
        },
      };
    }

    if (!ready.ok) {
      return {
        durationMs: performance.now() - startedAt,
        requestCount,
        report: {
          gameType: smokeCase.gameType,
          ok: false,
          failureCode: await audit.failureCode() ?? ready.failureCode,
          failureKind: ready.failureKind,
        },
      };
    }

    const acknowledged = await entry.ackPrologue();
    if (!acknowledged.ok) throw new Error("PROLOGUE_ACK_FAILED");
    const reload = await entry.getCurrentGame();
    const reloadOk = reload.ok === true && reload.status === "active";
    // 来源判定：只要开局存在非 generated 的 story_text 审计（fixture/rule/
    // deterministic），或完全没有 story_text 审计，都不得算作真实 AI 生成。
    const generatedStages = new Set(events.filter(event => event.kind === "ai_call" && event.output?.ok === true).map(event => event.role));
    const source = (sources.length > 0 && sources.every((value) => value === REQUIRED_SOURCE))
      || ["planning", "narration", "character", "choices"].every(stage => generatedStages.has(stage))
      ? REQUIRED_SOURCE
      : "invalid";

    const branches = [];
    let branchRequests = 0;
    for (const [choiceIndex, candidateId] of smokeCase.candidateIds.entries()) {
      const branch = await fork((branchEntry, branchAudit) =>
        runBranchOnFreshEntry(branchEntry, candidateId, branchAudit, choiceIndex));
      branches.push(branch);
      branchRequests += branch.requestCount;
    }

    // 通关局：从（已选分支的）当前状态继续推进，直到出现合法结局。
    // 续接成功不能替代通关，因此这条必须独立断言。
    let playthrough;
    let playRequests = 0;
    if (smokeCase.playToEnding === true) {
      const advanced = await runToEnding(entry, audit, { maxManualRetries: smokeCase.maxManualRetries ?? 0 });
      playthrough = { endingReached: advanced.endingReached, turns: advanced.turns, manualRetries: advanced.manualRetries, recoveredFailures: advanced.recoveredFailures,
        ...(advanced.failureCode === undefined ? {} : { failureCode: advanced.failureCode }) };
      playRequests = advanced.requestCount;
    }

    return {
      durationMs: performance.now() - startedAt,
      requestCount: requestCount + branchRequests + playRequests,
      report: {
        gameType: smokeCase.gameType,
        ok: true,
        source,
        reloadOk,
        branches,
        ...(playthrough === undefined ? {} : { playthrough }),
      },
    };
  });
  return { ...report, requestCount, durationMs };
}

/**
 * 从当前存档持续推进，直到出现合法结局或达到轮次上限。
 * 优先提交叙事选择（保持在剧情链上），没有叙事选择时提交当前目标行动。
 * 每步都等待在途生成落定，避免把 provider_pending 误判为「无下一步」。
 */
export async function runToEnding(entry, audit, timing = {}) {
  const now = timing.now ?? (() => performance.now());
  const pause = timing.sleep ?? sleep;
  const startedAt = now();
  const deadline = startedAt + SMOKE_LIMITS.maxDurationMs;
  let pendingDeadline = null;
  let turns = 0;
  let manualRetries = 0;
  const recoveredFailures = [];
  let failureCode;
  const before = summarizeAuditEvents(audit.eventsSinceBaseline()).codes.length;

  while (turns < SMOKE_LIMITS.maxTurnsPerPlaythrough && now() < deadline) {
    const current = await entry.getCurrentGame();
    if (current.ok !== true || current.status !== "active") { failureCode = "NO_ACTIVE_GAME"; break; }
    if (current.view?.ending != null) break;
    const status = current.view?.narrativeGeneration?.status;
    if (status === "failed") {
      const code = await audit.failureCode() ?? "GENERATION_FAILED";
      if (manualRetries < (timing.maxManualRetries ?? 0)) {
        manualRetries += 1;
        recoveredFailures.push(code);
        await entry.ensureNarrativeScene({ retry: true });
        await pause(1000);
        continue;
      }
      failureCode = code; break;
    }

    // provider 等待不是玩家回合；不能用 40 次一秒轮询耗尽 40 回合预算。
    if (status === "pending") {
      pendingDeadline ??= now() + 600_000;
      if (now() >= pendingDeadline) { failureCode = "GENERATION_TIMEOUT"; break; }
      await entry.ensureNarrativeScene();
      await pause(1000);
      continue;
    }
    pendingDeadline = null;
    const token = pickProgressToken(current.view);
    if (token === null) { failureCode = "NO_PROGRESSION_TOKEN"; break; }
    const result = await entry.performTurn({
      actionId: `smoke_play_${turns}`,
      interaction: { kind: "fixed_choice", choiceToken: token },
      expectedRevision: current.revision,
    });
    if (result.ok !== true) { failureCode = result.code ?? "PERFORM_TURN_FAILED"; break; }
    turns += 1;
  }

  const final = await entry.getCurrentGame();
  const endingReached = final.ok === true && final.view?.ending != null;
  const requestCount = summarizeAuditEvents(audit.eventsSinceBaseline()).codes.length - before;
  if (!endingReached && failureCode === undefined) failureCode = turns >= SMOKE_LIMITS.maxTurnsPerPlaythrough ? "TURN_LIMIT" : "DURATION_LIMIT";
  return { endingReached, turns, requestCount, manualRetries, recoveredFailures, durationMs: now() - startedAt,
    ...(failureCode === undefined ? {} : { failureCode }) };
}

/**
 * 选一个能推进剧情的受控 action token：优先叙事选择，其次当前目标行动，
 * 再次地点可执行行动。绝不构造未在服务端注册的 token。
 */
export function offeredChoices(view) {
  const dialogue = view?.narrative?.npcDialogues?.find(npc => npc.choices?.length === 2);
  return dialogue?.choices ?? view?.narrative?.choices ?? [];
}

function pickProgressToken(view) {
  const narrativeChoices = offeredChoices(view);
  if (Array.isArray(narrativeChoices) && narrativeChoices.length > 0) {
    const token = narrativeChoices[0]?.choiceToken;
    if (typeof token === "string" && token.length > 0) return token;
  }
  const objectiveTokens = view?.story?.currentObjectiveChoiceTokens;
  if (Array.isArray(objectiveTokens) && objectiveTokens.length > 0 && typeof objectiveTokens[0] === "string") {
    return objectiveTokens[0];
  }
  // 城镇的事实抵达入口由建筑承载，isCurrentFocus 并非获得 token 的前提。
  const buildingToken = view?.currentLocation?.town?.interactiveBuildings
    ?.find(building => typeof building.arrivalChoiceToken === "string" && building.arrivalChoiceToken.length > 0)?.arrivalChoiceToken;
  if (typeof buildingToken === "string") return buildingToken;
  const locationActions = view?.currentLocation?.actions;
  if (Array.isArray(locationActions) && locationActions.length > 0) {
    const token = locationActions[0]?.choiceToken;
    if (typeof token === "string" && token.length > 0) return token;
  }
  const objectiveToken = view?.story?.currentObjectiveChoiceToken;
  if (typeof objectiveToken === "string" && objectiveToken.length > 0) return objectiveToken;
  return null;
}

/**
 * 在给定 entry 上执行一次分支续接：读取当前视图，找到与 candidateId 对应的
 * 已批准 choice token，提交一次 performTurn 并回报是否产生可证明的差异。
 */
async function runBranchOnFreshEntry(entry, candidateId, audit, choiceIndex = 0) {
  const startedAt = performance.now();
  const before = summarizeAuditEvents(audit.eventsSinceBaseline()).codes.length;
  const current = await entry.getCurrentGame();
  if (current.ok !== true || current.status !== "active") {
    return {
      candidateId,
      ok: false,
      durationMs: performance.now() - startedAt,
      requestCount: 0,
      failureCode: "NO_ACTIVE_GAME",
      failureKind: "AI_CALL_FAILED",
    };
  }
  const choice = offeredChoices(current.view)[choiceIndex];
  if (choice === undefined) {
    return {
      candidateId,
      ok: false,
      durationMs: performance.now() - startedAt,
      requestCount: 0,
      failureCode: "CANDIDATE_NOT_OFFERED",
      failureKind: "AI_CALL_FAILED",
    };
  }

  const turn = await entry.performTurn({
    actionId: `smoke_${candidateId}`,
    interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken },
    expectedRevision: current.revision,
  });
  if (turn.ok === true) {
    await entry.ensureNarrativeScene();
    const deadline = performance.now() + 600_000;
    while (performance.now() < deadline) {
      const next = await entry.getCurrentGame();
      if (next.view?.narrativeGeneration?.status !== "pending") break;
      await sleep(1000);
    }
  }
  const final = await entry.getCurrentGame();
  const requestCount = summarizeAuditEvents(audit.eventsSinceBaseline()).codes.length - before;

  if (turn.ok !== true) {
    return {
      candidateId,
      ok: false,
      durationMs: performance.now() - startedAt,
      requestCount,
      failureCode: typeof turn.code === "string" ? turn.code : "PERFORM_TURN_FAILED",
      failureKind: "AI_RESPONSE_INVALID",
    };
  }
  return { candidateId, ok: final.ok === true && final.view?.narrativeGeneration?.status === "idle"
    && final.revision > current.revision,
    failureCode: final.view?.narrativeGeneration?.status === "idle" && final.revision > current.revision
      ? undefined : await audit.failureCode() ?? `CONTINUATION_${final.view?.narrativeGeneration?.status ?? "UNKNOWN"}`,
    failureKind: "AI_RESPONSE_INVALID",
    durationMs: performance.now() - startedAt, requestCount };
}

/** 在当前视图的叙事选择里按候选身份找 token；找不到即该候选未被提出。 */
function findChoice(view, candidateId) {
  const choices = view?.narrative?.currentScene?.choices;
  if (!Array.isArray(choices)) return undefined;
  return choices.find((choice) => typeof choice?.candidateId === "string" && choice.candidateId === candidateId);
}

/**
 * 真实续接（单独入口，供门禁离线用例与将来扩展使用）：在临时库上执行一次
 * candidateId 对应的分支。没有活跃存档时返回稳定失败，不触网。
 */
export async function realRunContinuation(context, overrides = {}) {
  return withTempEntry(overrides, async (entry, audit) => {
    const current = await entry.getCurrentGame();
    if (current.ok !== true || current.status !== "active") {
      return { candidateId: context.candidateId, ok: false, durationMs: 0, requestCount: 0, failureCode: "NO_ACTIVE_GAME", failureKind: "AI_CALL_FAILED" };
    }
    return runBranchOnFreshEntry(entry, context.candidateId, audit);
  });
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

function realRunCaseDeps(log) {
  return {
    env: process.env,
    runEnvCheck: async () => realRunEnvCheck(),
    runOpening: (smokeCase, overrides) => realRunOpening(smokeCase, overrides),
    runContinuation: (context) => realRunContinuation(context),
    log,
    // 必须与 withTempEntry 装配真实链路时用的是同一来源（含主仓回退），
    // 否则摘要会显示 prompt_only 而实际链路已按 json_object 运行。
    outputFormatLabel: resolveOutputFormatLabel(resolveAiEnvOrEmpty().AI_OUTPUT_FORMAT ?? ""),
  };
}

/** 读取真实链路所用的 AI 配置；找不到来源时返回空记录（标签回退 prompt_only）。 */
function resolveAiEnvOrEmpty() {
  try {
    const source = findUsableAiEnvSource({ target: resolve(projectRoot, ".env.local") });
    return source === null ? {} : toAiEnvRecord(source.values);
  } catch {
    return {};
  }
}

async function main() {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  const deadline = performance.now() + SMOKE_LIMITS.maxDurationMs;
  globalThis.fetch = async (input, init = {}) => {
    if (requests >= SMOKE_LIMITS.maxProviderRequests || performance.now() >= deadline) {
      throw new Error("SMOKE_BUDGET_EXCEEDED");
    }
    requests += 1;
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return originalFetch(input, { ...init, signal });
  };
  try {
    const exitCode = await runStagedNarrativeSmoke(realRunCaseDeps((line) => {
    process.stdout.write(`${line}\n`);
    }));
    process.exitCode = exitCode;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const invokedDirectly = typeof process.argv[1] === "string"
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
