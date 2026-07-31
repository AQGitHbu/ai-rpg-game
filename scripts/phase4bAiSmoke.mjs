import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectRoot, readAiEnv } from "./aiEnv.mjs";

// ---------------------------------------------------------------------------
// phase4bAiSmoke：opt-in 的真实 AI 冒烟脚本（Phase 4B Task 5）。
//
// 目的：在【操作者显式授权】下，用 production-equivalent 装配（compositionRoot →
// live source）对三组固定合法输入（武侠 / 科幻 / 都市）各创建一局，确认真实链路
// 要么产出 generated 开局、要么可观测地降级到 fallback，且成功存档可 reload、
// 内容预算与双结局约束仍满足。
//
// 安全红线（由 phase4bAiSmoke.node-test.mjs 门禁强制）：
// - 必须 RUN_REAL_AI_SMOKE=1 才运行；否则退出非零且不发起任何请求。
// - 运行前先跑 `npm run env:check`，但 stdout/stderr 绝不打印键值。
// - 每例只输出白名单摘要：gameType、generated|fallback、耗时、稳定诊断码、
//   tokens/cost（如有）。永不输出玩家输入、prompt、模型原文、URL、Key。
// - 真实服务慢 / 限流 / 非法输出 → 记录可观测 fallback 后整体成功；
//   只有本地脚本 / 配置 / 持久化 / fallback 违约才失败（退出非零）。
// - 决不加入 npm test / test:fast / build / CI。
//
// 本文件是 .mjs（Node 直接运行）：真实链路的 TS 依赖只在 opt-in 实跑路径里，
// 经 node:module registerHooks 惰性加载（Node 24 原生 strip-types；钩子补齐
// tsconfig 的 @/ 别名、无扩展名相对导入与 JSON 导入）。门禁测试主体 import 下方
// 纯函数并注入 mock；另有一条离线实跑用例以占位 AI 配置驱动 realRunCase
// （unavailable → fallback，会加载 TS 但绝不触网）。
// ---------------------------------------------------------------------------

const DIAG_PREFIX = "[phase4b-smoke]";

/** 结果来源白名单：只有这两种算成功；其余（fixture/unavailable 等）视为违约。 */
export const ALLOWED_SOURCES = Object.freeze(["generated", "fallback"]);

/** 内容预算里的结局数量硬约束（与 domain budgetPolicy.opening.endings 对齐）。 */
export const REQUIRED_ENDING_COUNT = 2;

/**
 * 三组固定合法输入：字段均满足 domain 校验下限（characterName≥2、identity≥2、
 * worldPremise≥20、storyOpening≥20、tags≤3）。内容仅为覆盖三个 gameType 范围，
 * 不承载任何真实密钥或环境信息，且绝不进入日志输出。
 */
export const SMOKE_CASES = Object.freeze([
  {
    gameType: "wuxia",
    input: {
      gameType: "wuxia",
      characterName: "沈孤鸿",
      characterIdentity: "落魄镖师",
      personalityTags: ["重义", "沉默"],
      worldPremise: "江湖动荡，镖局衰败，各派为一部失传剑谱明争暗斗，庙堂亦暗中插手。",
      storyOpening: "雨夜押镖入城，镖车半路被劫，唯一线索是一枚寒山派的青铜令牌。",
      narrativeStyle: "concise",
      contentIntensity: "normal",
    },
  },
  {
    gameType: "science_fiction",
    input: {
      gameType: "science_fiction",
      characterName: "凯伦",
      characterIdentity: "深空货运领航员",
      personalityTags: ["谨慎"],
      worldPremise: "殖民星系依赖跃迁网络维系补给，一次跃迁事故让边境站陷入信号孤岛与资源枯竭。",
      storyOpening: "货船脱离跃迁后仪表全灭，唯一还在闪的是一封来自失联母站的加密求救。",
      narrativeStyle: "cinematic",
      contentIntensity: "normal",
    },
  },
  {
    gameType: "urban",
    input: {
      gameType: "urban",
      characterName: "林晚",
      characterIdentity: "深夜电台主持",
      personalityTags: ["敏锐", "念旧"],
      worldPremise: "霓虹与旧巷交错的沿海都市里，一连串失踪案与一档只在凌晨播出的点歌节目悄然重叠。",
      storyOpening: "直播尾声接进一通电话，对方只报出一个早已拆除的地址便挂断。",
      narrativeStyle: "novel",
      contentIntensity: "normal",
    },
  },
]);

/**
 * 校验单例报告是否满足 smoke 契约；返回稳定问题码数组（空数组=通过）。
 * 只读取白名单可观测字段，绝不回显敏感内容。
 */
export function validateCaseReport(report) {
  const issues = [];
  if (!report || typeof report !== "object") {
    return ["REPORT_MISSING"];
  }
  if (report.ok !== true) {
    // 本地创建失败（输入/持久化/基础设施）——真实服务的降级会以 ok:true +
    // fallback 呈现，因此 ok:false 一律视为需要人工排查的硬失败。
    issues.push("CASE_LOCAL_FAILURE");
    return issues;
  }
  if (!ALLOWED_SOURCES.includes(report.source)) {
    issues.push("SOURCE_OUT_OF_CONTRACT");
  }
  if (report.reloadOk !== true) {
    issues.push("RELOAD_FAILED");
  }
  if (report.endingCount !== REQUIRED_ENDING_COUNT) {
    issues.push("ENDING_COUNT_MISMATCH");
  }
  if (report.budgetOk !== true) {
    issues.push("CONTENT_BUDGET_VIOLATION");
  }
  return issues;
}

/**
 * 构造单例摘要行：重建 payload 只含白名单字段，即使 report 被误塞入敏感字段
 * 也不输出。usage 缺失时省略 token 字段；ok:false 时改输出稳定 failureCode。
 */
export function buildCaseSummaryLine(report) {
  const payload = { gameType: report.gameType };
  if (report.ok === true) {
    payload.source = report.source;
  } else if (report.failureCode !== undefined) {
    payload.failureCode = report.failureCode;
  }
  if (report.durationMs !== undefined) {
    payload.durationMs = Math.round(report.durationMs);
  }
  if (Array.isArray(report.codes)) {
    payload.codes = report.codes;
  }
  const usage = report.usage;
  if (usage && typeof usage === "object") {
    if (usage.promptTokens !== undefined) payload.promptTokens = usage.promptTokens;
    if (usage.completionTokens !== undefined) payload.completionTokens = usage.completionTokens;
    if (usage.totalTokens !== undefined) payload.totalTokens = usage.totalTokens;
  }
  if (report.estimatedCostUsd !== undefined) {
    payload.estimatedCostUsd = report.estimatedCostUsd;
  }
  return `${DIAG_PREFIX} case ${JSON.stringify(payload)}`;
}

/**
 * smoke 编排核心（纯逻辑，依赖全部注入）：返回进程退出码，0 = 全部通过。
 * deps.env / runEnvCheck / runCase / log 由调用方提供，门禁测试注入 mock。
 */
export async function runPhase4bAiSmoke(deps) {
  const { env, runEnvCheck, runCase, log, outputFormatLabel } = deps;

  if (env.RUN_REAL_AI_SMOKE !== "1") {
    log(
      `${DIAG_PREFIX} SMOKE_OPT_IN_REQUIRED：真实 AI smoke 需显式设置 RUN_REAL_AI_SMOKE=1，未发起任何请求。`,
    );
    return 1;
  }

  const envCheck = await runEnvCheck();
  if (!envCheck.ok) {
    log(`${DIAG_PREFIX} SMOKE_ENV_CHECK_FAILED：env:check 未通过，终止 smoke（未打印任何键值）。`);
    return 1;
  }

  let failures = 0;
  const reports = [];
  for (const smokeCase of SMOKE_CASES) {
    let report;
    try {
      report = await runCase(smokeCase);
    } catch {
      // 本地脚本/持久化崩溃：异常文本可能含路径等细节，绝不回显，只记稳定码。
      failures += 1;
      log(`${DIAG_PREFIX} SMOKE_CASE_CRASHED gameType=${smokeCase.gameType}`);
      // 占位报告：计入汇总的 failed，不携带任何异常细节。
      reports.push({ gameType: smokeCase.gameType, ok: false });
      continue;
    }
    reports.push(report);
    const issues = validateCaseReport(report);
    // 报告结构存在才输出摘要行；缺失/非对象时只记违约码，避免抛出原始堆栈。
    if (report && typeof report === "object") {
      log(buildCaseSummaryLine(report));
    }
    if (issues.length > 0) {
      failures += 1;
      log(`${DIAG_PREFIX} SMOKE_CASE_VIOLATION gameType=${smokeCase.gameType} codes=${issues.join(",")}`);
    }
  }

  // 安全汇总行（spec §4）：只聚合白名单字段，不影响下方通过判定。
  log(buildRunSummaryLine(reports, outputFormatLabel ?? "prompt_only"));

  if (failures > 0) {
    log(`${DIAG_PREFIX} SMOKE_FAILED：${failures}/${SMOKE_CASES.length} 例违约。`);
    return 1;
  }
  log(`${DIAG_PREFIX} SMOKE_OK：${SMOKE_CASES.length} 例均满足 generated|fallback 契约。`);
  return 0;
}

// ---------------------------------------------------------------------------
// 真实实跑装配（opt-in CLI 路径使用；门禁测试仅经离线 fallback 用例触达，
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
    const [composition, domain, sqliteClient, sqliteRepository] = await Promise.all([
      import("../src/game/application/server/compositionRoot.ts"),
      import("../src/game/domain/index.ts"),
      import("../src/game/application/server/persistence/sqliteClient.ts"),
      import("../src/game/application/server/persistence/sqliteGameRepository.ts"),
    ]);
    return {
      createServerGameEntryPoints: composition.createServerGameEntryPoints,
      budgetPolicyOf: domain.budgetPolicyOf,
      createSqliteClient: sqliteClient.createSqliteClient,
      createSqliteGameRepository: sqliteRepository.createSqliteGameRepository,
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

/** 从（本就脱敏的）audit 事件提取稳定诊断码、token 合计与成本估算合计；
 * 非对象/非数值字段一律忽略，绝不透传其他字段。 */
export function summarizeAuditEvents(events) {
  const codes = [];
  const usage = {};
  let estimatedCostUsd;
  const addTokens = (key, value) => {
    if (typeof value !== "number") return;
    usage[key] = (usage[key] ?? 0) + value;
  };
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
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
  return { codes, usage: Object.keys(usage).length > 0 ? usage : undefined, estimatedCostUsd };
}

/** 输出格式安全标签：合法值原样、缺失/空白→prompt_only、其余→invalid（绝不回显原值）。 */
export const AI_OUTPUT_FORMAT_LABELS = Object.freeze(["json_schema", "json_object", "prompt_only"]);
export function resolveOutputFormatLabel(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") return "prompt_only";
  return AI_OUTPUT_FORMAT_LABELS.includes(trimmed) ? trimmed : "invalid";
}

/** 安全汇总（spec §4）：只聚合白名单可观测字段，通过条件不受影响。 */
export function summarizeSmokeRun(reports, outputFormatLabel) {
  const summary = {
    outputFormat: outputFormatLabel,
    cases: 0,
    generated: 0,
    fallback: 0,
    failed: 0,
    fallbackCategories: {},
    totalDurationMs: 0,
  };
  const usage = {};
  let estimatedCostUsd;
  for (const report of reports) {
    if (!report || typeof report !== "object") continue;
    summary.cases += 1;
    if (typeof report.durationMs === "number") {
      summary.totalDurationMs += Math.round(report.durationMs);
    }
    if (report.ok === true && report.source === "generated") {
      summary.generated += 1;
    } else if (report.ok === true && report.source === "fallback") {
      summary.fallback += 1;
      for (const code of Array.isArray(report.codes) ? report.codes : []) {
        if (typeof code !== "string" || code === "attempt_ok") continue;
        summary.fallbackCategories[code] = (summary.fallbackCategories[code] ?? 0) + 1;
      }
    } else {
      summary.failed += 1;
    }
    const reportUsage = report.usage;
    if (reportUsage && typeof reportUsage === "object") {
      for (const key of ["promptTokens", "completionTokens", "totalTokens"]) {
        if (typeof reportUsage[key] === "number") usage[key] = (usage[key] ?? 0) + reportUsage[key];
      }
    }
    if (typeof report.estimatedCostUsd === "number") {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + report.estimatedCostUsd;
    }
  }
  if (Object.keys(usage).length > 0) summary.usage = usage;
  if (estimatedCostUsd !== undefined) summary.estimatedCostUsd = estimatedCostUsd;
  return summary;
}

export function buildRunSummaryLine(reports, outputFormatLabel) {
  return `${DIAG_PREFIX} summary ${JSON.stringify(summarizeSmokeRun(reports, outputFormatLabel))}`;
}

/** blueprint 预算复查：与 domain budgetPolicy.opening 完全对照（双结局包含在内）。 */
export function checkContentBudget(blueprint, policy) {
  const opening = policy.opening;
  const mainCount = blueprint.locations.filter((entry) => entry.kind === "main").length;
  const hiddenCount = blueprint.locations.filter((entry) => entry.kind === "hidden").length;
  const npcCount = blueprint.npcs.length;
  const companionCount = blueprint.npcs.filter((entry) => entry.isCompanion).length;
  const sideCount = blueprint.quests.filter((entry) => entry.kind === "side").length;
  return (
    mainCount >= opening.mainLocationsMin &&
    mainCount <= opening.mainLocationsMax &&
    hiddenCount <= opening.hiddenLocationsMax &&
    npcCount >= opening.coreNpcsMin &&
    npcCount <= opening.coreNpcsMax &&
    companionCount <= opening.companionsMax &&
    sideCount <= opening.sideQuestsMax &&
    blueprint.endings.length === opening.endings
  );
}

/** 把 aiEnv.mjs 的解析结果收敛为纯四键记录：其余键一概不带入装配 env。 */
function toAiEnvRecord(values) {
  return {
    AI_API_BASE_URL: values.get("AI_API_BASE_URL")?.decoded,
    AI_MODEL: values.get("AI_MODEL")?.decoded,
    AI_API_KEY: values.get("AI_API_KEY")?.decoded,
    AI_OUTPUT_FORMAT: values.get("AI_OUTPUT_FORMAT")?.decoded,
  };
}

const TEMP_DB_PREFIX = "phase4b-ai-smoke-";

/** 清扫上次运行因 Windows 句柄延迟而遗留的临时库（与 sqlite 测试同一约定）。 */
function sweepStaleTempDatabases() {
  const tmpRoot = resolve(projectRoot, "tmp");
  let entries;
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_DB_PREFIX)) continue;
    try {
      rmSync(join(tmpRoot, entry), { force: true });
    } catch {
      // 仍被占用：留待下次运行清理。
    }
  }
}

/** Windows 下 SQLite 句柄可能延迟释放：删除临时文件时短暂重试，
 * 仍失败则留待下次运行由 sweepStaleTempDatabases 收尾（不阻断 smoke 结果）。 */
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

/**
 * 真实单例：临时 SQLite + production composition root（live/unavailable 由
 * parseAiRuntimeConfig(env) 决定）。AI 三键默认取自 RPG 自己的 .env.local（与生产
 * 部署同一契约），值只进内存；`overrides.aiEnv` 仅供本地 plumbing 干跑注入占位
 * 配置（unavailable → fallback，不触网），不改变生产等价装配。createGame 后
 * reload、复查持久化 blueprint 的预算/双结局，最后显式 close 并删除临时文件。
 * 只返回白名单可观测字段。
 */
export async function realRunCase(smokeCase, overrides = {}) {
  const modules = await loadTsModules();
  const aiEnv = overrides.aiEnv ?? toAiEnvRecord(readAiEnv(resolve(projectRoot, ".env.local")));
  mkdirSync(resolve(projectRoot, "tmp"), { recursive: true });
  sweepStaleTempDatabases();
  const databasePath = join(resolve(projectRoot, "tmp"), `${TEMP_DB_PREFIX}${randomUUID()}.sqlite`);
  const generationEvents = [];

  const entry = modules.createServerGameEntryPoints({
    AI_API_BASE_URL: aiEnv.AI_API_BASE_URL,
    AI_MODEL: aiEnv.AI_MODEL,
    AI_API_KEY: aiEnv.AI_API_KEY,
    AI_OUTPUT_FORMAT: aiEnv.AI_OUTPUT_FORMAT,
    GAME_DB_PATH: databasePath,
  }, {
    generationObserver: (event) => generationEvents.push(event),
  });

  try {
    // compositionRoot 的默认 audit 走 console.log：创建期间临时接管 stdout，
    // 只解析（本就脱敏的）audit JSON 行，其余输出一律丢弃、不透传。
    const auditEvents = [];
    const originalConsoleLog = console.log;
    console.log = (...args) => {
      const first = args[0];
      if (typeof first !== "string" || !first.startsWith("{")) return;
      try {
        auditEvents.push(JSON.parse(first));
      } catch {
        // 非 JSON 行：丢弃。
      }
    };
    const startedAt = performance.now();
    let result;
    try {
      result = await entry.createGame(smokeCase.input);
    } finally {
      console.log = originalConsoleLog;
    }
    const durationMs = performance.now() - startedAt;
    const { codes: auditCodes, usage, estimatedCostUsd } = summarizeAuditEvents(auditEvents);
    const fallbackCodes = generationEvents.flatMap((event) =>
      event.stage === "falling_back" && typeof event.category === "string"
        ? [event.category]
        : [],
    );
    const codes = [...auditCodes, ...fallbackCodes];

    if (!result.ok) {
      return {
        gameType: smokeCase.gameType,
        ok: false,
        failureCode: result.code,
        durationMs,
        codes,
        estimatedCostUsd,
      };
    }

    const reload = await entry.getCurrentGame();
    const reloadOk = reload.status === "active" && reload.view.gameId === result.gameId;

    // 预算/双结局复查：直接读回持久化 blueprint，不信任内存态。
    const repository = modules.createSqliteGameRepository({
      clientFactory: () => modules.createSqliteClient(databasePath),
    });
    let endingCount = -1;
    let budgetOk = false;
    try {
      const loaded = await repository.getCurrentGame();
      if (loaded.ok && loaded.status === "active") {
        endingCount = loaded.record.blueprint.endings.length;
        budgetOk = checkContentBudget(loaded.record.blueprint, modules.budgetPolicyOf(loaded.record.blueprint));
      }
    } finally {
      await repository.close();
    }

    return {
      gameType: smokeCase.gameType,
      ok: true,
      source: result.source,
      durationMs,
      codes,
      usage,
      estimatedCostUsd,
      reloadOk,
      endingCount,
      budgetOk,
    };
  } finally {
    await entry.close();
    await removeTempDatabase(databasePath);
  }
}

/** 从 .env.local 读输出格式标签：文件不可读按缺省 prompt_only，绝不抛出。 */
function realOutputFormatLabel() {
  try {
    const values = readAiEnv(resolve(projectRoot, ".env.local"));
    return resolveOutputFormatLabel(values.get("AI_OUTPUT_FORMAT")?.decoded);
  } catch {
    return "prompt_only";
  }
}

async function main() {
  const exitCode = await runPhase4bAiSmoke({
    env: process.env,
    runEnvCheck: realRunEnvCheck,
    runCase: realRunCase,
    log: (line) => console.log(line),
    outputFormatLabel: realOutputFormatLabel(),
  });
  process.exitCode = exitCode;
}

// 仅当作为脚本直接运行时执行真实 smoke；被门禁测试 import 时不触发。
const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
