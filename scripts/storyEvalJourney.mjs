// ---------------------------------------------------------------------------
// storyEvalJourney：评估旅程门禁脚本（spec §7）。
// 沿用 scripts/phase11StoryContinuityJourney.mjs 的门禁模式：
// - --mode=replay：跑零网络离线用例（vitest 文件内 fetch 被 mock）；
// - --mode=record：要求 RUN_REAL_AI_STORY_EVAL=1 才发真实计费调用；校验 AI 凭据
//   （aiEnv.mjs），逐局 spawnSync vitest 子进程，childEnv 显式注入
//   STORY_EVAL_CAPTURE=1、STORY_EVAL_ARTIFACT_DIR、STORY_EVAL_SEED、
//   STORY_EVAL_MAX_SCENES、GAME_DB_PATH（artifact/checkpoint.sqlite）与 AI 三键。
// - --runs N：策略 seed 依次递增，每局独立 run-id 与持久 checkpoint；失败可用
//   --resume=<artifactDir> 从最后安全场景继续，父进程不会删除 SQLite。
// 真实计费调用一律显式 env 开关；stdout 绝不打印凭据。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  defaultAiEnvSources,
  projectRoot,
  readAiEnv,
  validateAiEnv,
} from "./aiEnv.mjs";

const PREFIX = "[story-eval-journey]";
const TEST_FILE = "src/game/application/testing/storyEvalJourney.test.ts";
const CASES_FILE = "data/story-eval/cases/v2.json";

/**
 * 读取 v2 case 集（与 TS loader 同一数据源）：门禁只消费 caseId 做展开，
 * 结构校验由 storyEvalCases.ts 在 vitest 侧负责；读取失败视为致命门禁错误。
 */
export function loadStoryEvalCases() {
  const raw = readFileSync(resolve(projectRoot, CASES_FILE), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("v2 case 集不是数组");
  return parsed;
}

export function resolveJourneyMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "replay";
  return mode === "record" || mode === "replay" ? mode : null;
}

export function resolveRunCount(argv) {
  const arg = argv.find((entry) => entry.startsWith("--runs="));
  if (arg === undefined) return 1;
  const value = Number(arg.slice("--runs=".length));
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function resolveBaseSeed(argv) {
  const arg = argv.find((entry) => entry.startsWith("--seed="));
  if (arg === undefined) return 20260731;
  const value = Number(arg.slice("--seed=".length));
  return Number.isFinite(value) ? value : null;
}

export function resolveCaseId(argv, cases) {
  const arg = argv.find((entry) => entry.startsWith("--case="));
  if (arg === undefined) return undefined;
  const caseId = arg.slice("--case=".length);
  return cases.some((item) => item.caseId === caseId) ? caseId : null;
}

export function resolveStrategy(argv) {
  const arg = argv.find((entry) => entry.startsWith("--strategy="));
  if (arg === undefined) return undefined;
  const strategy = arg.slice("--strategy=".length);
  return strategy === "explore" || strategy === "objective" ? strategy : null;
}

export function resolveBlueprintArtifact(argv) {
  const arg = argv.find((entry) => entry.startsWith("--blueprint-artifact="));
  if (arg === undefined) return undefined;
  const value = arg.slice("--blueprint-artifact=".length).trim();
  return value.length > 0 && value.length <= 4096 ? value : null;
}

/** 显式续跑某个 artifact；路径必须是完整 run 目录，而不是 calls.jsonl。 */
export function resolveResumeArtifact(argv, env = {}) {
  const arg = argv.find((entry) => entry.startsWith("--resume="));
  const value = arg === undefined ? env.STORY_EVAL_RESUME_DIR : arg.slice("--resume=".length);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 4096 ? trimmed : null;
}

/** 矩阵复用是显式 opt-in，避免旧 artifact 意外改变既有 release 语义。 */
export function resolveMatrixReuse(argv, env = {}) {
  if (argv.includes("--force-rerun") || env.STORY_EVAL_REUSE_COMPLETED === "0") return false;
  return argv.includes("--reuse-completed") || env.STORY_EVAL_REUSE_COMPLETED === "1";
}

export function isPathInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

export function buildStoryEvalMatrixFingerprint({ caseId, strategy, seed, profileConfig, model, gitCommit }) {
  return Object.freeze({
    caseId,
    strategy,
    strategySeed: seed,
    profile: profileConfig.profile,
    maxScenes: profileConfig.maxScenes,
    maxRoleAttempts: profileConfig.maxRoleAttempts,
    aiTimeoutMs: profileConfig.aiTimeoutMs,
    branchMode: profileConfig.branchMode,
    model: model ?? null,
    gitCommit: gitCommit ?? null,
  });
}

function readJsonFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function matrixFingerprintMatches(manifest, fingerprint) {
  const candidate = manifest?.resumeFingerprint && typeof manifest.resumeFingerprint === "object"
    ? manifest.resumeFingerprint
    : manifest;
  return Object.entries(fingerprint).every(([key, value]) => candidate?.[key] === value);
}

function isTerminalArtifact(manifest, artifactDir) {
  const terminal = new Set(["converged", "max_scenes", "aborted", "exhausted", "generation_failed", "recovery_loop", "time_budget", "incomplete"]);
  return terminal.has(manifest?.status) && existsSync(resolve(artifactDir, "manifest.json")) && existsSync(resolve(artifactDir, "calls.jsonl"));
}

/** 在同一矩阵 fingerprint 下复用已完成 slot，返回最新目录。 */
export function findReusableStoryEvalArtifact({ artifactRoot, fingerprint }) {
  let entries;
  try {
    entries = readdirSync(artifactRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(artifactRoot, entry.name))
    .map((artifactDir) => ({ artifactDir, manifest: readJsonFile(resolve(artifactDir, "manifest.json")) }))
    .filter(({ artifactDir, manifest }) => matrixFingerprintMatches(manifest, fingerprint) && isTerminalArtifact(manifest, artifactDir))
    .sort((left, right) => String(right.manifest?.finishedAt ?? right.manifest?.updatedAt ?? "").localeCompare(String(left.manifest?.finishedAt ?? left.manifest?.updatedAt ?? "")));
  return candidates[0] ?? null;
}

function writeMatrixStateAtomic(path, state) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** 每次 record run 使用全新目录，避免 calls.jsonl 追加污染历史 run。 */
export function buildStoryEvalArtifactDir({ artifactRoot, caseId, strategy, runIndex }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(artifactRoot, `${caseId}-${strategy}-${runIndex}-${stamp}-${randomUUID().slice(0, 8)}`);
}

/**
 * 展开可比的成对旅程：同一 case/replicate 只生成一个 seed，explore 与
 * objective 依次消费同一份 captured blueprint。这样策略差异不会被不同的
 * 开局蓝图或 seed 混淆。
 */
export function buildPairedRunSpecs(cases, strategies, runs, baseSeed) {
  return cases.flatMap((entry) => Array.from({ length: runs }, (_, replicate) => {
    const seed = baseSeed + replicate;
    return {
      pairId: `${entry.caseId}-${seed}-${replicate + 1}`,
      caseId: entry.caseId,
      replicate,
      seed,
      strategies: [...strategies],
    };
  }));
}

export const STORY_EVAL_PROFILE_DEFAULTS = Object.freeze({
  // ai-slg-game-model 的蓝图请求偶尔会接近一分钟；smoke 也必须给完整
  // 的单请求预算，否则 provider 尚未返回就被误记成 fallback。
  smoke: Object.freeze({ maxScenes: 3, maxRoleAttempts: 1, aiTimeoutMs: 300_000, branchMode: "none", totalBudgetMs: 10 * 60_000 }),
  // fallback-7 的 long 主线需要 13 个 narrative scenes 才能启动终局战斗；
  // 生成事实全覆盖会再增加一条调查动作，18 给 battle/ending 收尾留出余量，
  // 避免 regression 把正常终局误报成不收敛。baseline 仍保留 60 幕作为跨蓝图安全阀。
  // 同一配置 provider 的短暂 service_error/rate-limit 在 long 旅程中并不罕见；
  // 第三次同角色重试可显著降低把一幕降级为 fallback 的概率，且仍受总预算约束。
  regression: Object.freeze({ maxScenes: 18, maxRoleAttempts: 3, aiTimeoutMs: 300_000, branchMode: "sample", totalBudgetMs: 45 * 60_000 }),
  baseline: Object.freeze({ maxScenes: 60, maxRoleAttempts: 3, aiTimeoutMs: 300_000, branchMode: "full", totalBudgetMs: 90 * 60_000 }),
});

const STORY_EVAL_BRANCH_MODES = new Set(["none", "sample", "full"]);

export function resolveEvalProfile(env = {}) {
  const profile = env.STORY_EVAL_PROFILE ?? "baseline";
  return Object.hasOwn(STORY_EVAL_PROFILE_DEFAULTS, profile) ? profile : null;
}

export function resolveEvalProfileConfig(env = {}) {
  const profile = resolveEvalProfile(env);
  if (profile === null) return null;
  const defaults = STORY_EVAL_PROFILE_DEFAULTS[profile];
  const branchMode = env.STORY_EVAL_BRANCH_MODE ?? defaults.branchMode;
  if (!STORY_EVAL_BRANCH_MODES.has(branchMode)) return null;
  return {
    profile,
    maxScenes: resolveEvalInt(env, "STORY_EVAL_MAX_SCENES", defaults.maxScenes, 1, 60),
    maxRoleAttempts: resolveEvalInt(env, "STORY_EVAL_MAX_ROLE_ATTEMPTS", defaults.maxRoleAttempts, 1, 3),
    // ai-slg-game-model occasionally takes 2–3 minutes for long-context
    // director/writer calls; captured runs must be able to wait for that
    // response instead of converting it into a false fallback.
    aiTimeoutMs: resolveEvalInt(env, "STORY_EVAL_AI_TIMEOUT_MS", defaults.aiTimeoutMs, 1_000, 300_000),
    branchMode,
    totalBudgetMs: resolveEvalInt(env, "STORY_EVAL_TOTAL_BUDGET_MS", defaults.totalBudgetMs, 60_000, 6 * 60 * 60_000),
  };
}

function spawnJourney(env) {
  return spawnSync(
    process.execPath,
    [
      "./node_modules/vitest/vitest.mjs",
      "run",
      TEST_FILE,
      // 故事旅程会持有临时 SQLite 并等待长耗时 provider 请求；单 fork
      // 避免 Windows worker 在长 run 收尾时被 tinypool 意外回收。
      "--pool=forks",
      "--poolOptions.forks.singleFork",
    ],
    {
      cwd: projectRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    },
  ).status ?? 1;
}

function resolveEvalInt(env, key, fallback, min, max) {
  const value = Number(env[key] ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** 清扫上次运行因 Windows 句柄延迟而遗留的临时库（与 phase4b smoke 同一约定）。 */
function sweepStaleTempDatabases() {
  const tmpRoot = resolve(projectRoot, "tmp");
  let entries;
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("story-eval-run-")) continue;
    try {
      rmSync(resolve(tmpRoot, entry), { force: true });
    } catch {
      // 仍被占用：留待下次运行清理。
    }
  }
}

export function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  spawn = spawnJourney,
  // sources 注入式（node-test 传 () => [] 确定性失败）；默认读取真实 .env 候选。
  sources = defaultAiEnvSources({ cwd: projectRoot, env }),
} = {}) {
  // spawn 可能抛错（如 vitest.mjs 缺失）：统一包装，绝不崩溃主流程。
  const runSpawn = (childEnv) => {
    try {
      return spawn(childEnv);
    } catch {
      log(`${PREFIX} SPAWN_FAILED`);
      return 1;
    }
  };
  const mode = resolveJourneyMode(argv);
  if (mode === null) {
    log(`${PREFIX} INVALID_MODE`);
    return 1;
  }
  const runs = resolveRunCount(argv);
  if (runs === null) {
    log(`${PREFIX} INVALID_RUNS`);
    return 1;
  }
  let baseSeed = resolveBaseSeed(argv);
  if (baseSeed === null) {
    log(`${PREFIX} INVALID_SEED`);
    return 1;
  }
  const selectedStrategy = resolveStrategy(argv);
  if (selectedStrategy === null) {
    log(`${PREFIX} INVALID_STRATEGY`);
    return 1;
  }
  const blueprintArtifactArg = resolveBlueprintArtifact(argv);
  if (blueprintArtifactArg === null) {
    log(`${PREFIX} INVALID_BLUEPRINT_ARTIFACT`);
    return 1;
  }
  const blueprintArtifact = blueprintArtifactArg === undefined
    ? env.STORY_EVAL_BLUEPRINT_ARTIFACT
    : resolve(projectRoot, blueprintArtifactArg);
  const resumeArtifactArg = resolveResumeArtifact(argv, env);
  if (resumeArtifactArg === null) {
    log(`${PREFIX} INVALID_RESUME_ARTIFACT`);
    return 1;
  }
  if (mode === "replay") {
    log(`${PREFIX} replay: zero-network offline journey`);
    return runSpawn({ ...env, RUN_REAL_AI_STORY_EVAL: "0" });
  }
  if (env.RUN_REAL_AI_STORY_EVAL !== "1") {
    log(`${PREFIX} REAL_AI_OPT_IN_REQUIRED：真实 AI 评估需显式设置 RUN_REAL_AI_STORY_EVAL=1`);
    return 1;
  }
  const profileConfig = resolveEvalProfileConfig(env);
  if (profileConfig === null) {
    log(`${PREFIX} INVALID_PROFILE：STORY_EVAL_PROFILE 必须是 smoke、regression 或 baseline，分支模式必须是 none、sample 或 full`);
    return 1;
  }

  // v2 确定性展开（spec §7 / Task 13 Step 3）：每 case 固定生成 explore+objective
  // 两个 StoryEvalRun；--case 只做试点/定向复测；--runs 仅在 --case 下把同一
  // case/strategy 对复制 N 次并标记为 replicate，不得当作新 case。
  const cases = loadStoryEvalCases();
  let selectedCaseId = resolveCaseId(argv, cases);
  if (selectedCaseId === null) {
    log(`${PREFIX} INVALID_CASE`);
    return 1;
  }
  const resumeArtifactDir = resumeArtifactArg === undefined ? undefined : resolve(projectRoot, resumeArtifactArg);
  if (resumeArtifactDir !== undefined && !isPathInside(resolve(projectRoot, "artifacts", "story-eval"), resumeArtifactDir)) {
    log(`${PREFIX} RESUME_PATH_REJECTED`);
    return 1;
  }
  const resumeManifest = resumeArtifactDir === undefined ? null : readJsonFile(resolve(resumeArtifactDir, "manifest.json"));
  const resumeProgress = resumeArtifactDir === undefined ? null : readJsonFile(resolve(resumeArtifactDir, "progress.json"));
  const resumeIdentity = resumeManifest ?? (resumeProgress?.fingerprint && typeof resumeProgress.fingerprint === "object" ? resumeProgress.fingerprint : null);
  if (resumeArtifactDir !== undefined && (resumeIdentity === null || typeof resumeIdentity.caseId !== "string" || !["explore", "objective"].includes(resumeIdentity.strategy))) {
    log(`${PREFIX} RESUME_MANIFEST_INVALID`);
    return 1;
  }
  if (resumeIdentity !== null && selectedCaseId === undefined) selectedCaseId = resumeIdentity.caseId;
  if (resumeIdentity !== null && argv.find((entry) => entry.startsWith("--seed=")) === undefined && Number.isFinite(Number(resumeIdentity.strategySeed))) {
    baseSeed = Number(resumeIdentity.strategySeed);
  }
  const selectedCases = selectedCaseId === undefined
    ? profileConfig.profile === "smoke" ? cases.slice(0, 1) : cases
    : cases.filter((item) => item.caseId === selectedCaseId);
  const strategies = resumeIdentity !== null
    ? [resumeIdentity.strategy]
    : selectedStrategy === undefined ? ["explore", "objective"] : [selectedStrategy];
  if (resumeIdentity !== null && selectedStrategy !== undefined && selectedStrategy !== resumeIdentity.strategy) {
    log(`${PREFIX} RESUME_STRATEGY_MISMATCH`);
    return 1;
  }
  const runSpecs = buildPairedRunSpecs(selectedCases, strategies, runs, baseSeed);
  if (runs > 1 && selectedCaseId === undefined) {
    log(`${PREFIX} REPLICATE_REQUIRES_CASE：--runs 复制仅允许在 --case 内使用`);
    return 1;
  }

  // sources 注入式：node-test 传函数 () => []（确定性失败），生产默认传候选数组。
  const sourceList = typeof sources === "function" ? sources() : sources;
  const source = sourceList
    .find((candidate) => existsSync(candidate) && validateAiEnv(readAiEnv(candidate)).length === 0);
  if (source === undefined) {
    log(`${PREFIX} AI_ENV_INVALID`);
    return 1;
  }
  const aiValues = readAiEnv(source);
  const artifactRoot = resolve(projectRoot, "artifacts", "story-eval");
  const dbRoot = resolve(projectRoot, "tmp");
  mkdirSync(dbRoot, { recursive: true });
  sweepStaleTempDatabases();
  mkdirSync(artifactRoot, { recursive: true });
  const matrixReuse = resolveMatrixReuse(argv, env) && resumeArtifactDir === undefined;
  const matrixStatePath = resolve(artifactRoot, "matrix-state.json");
  const matrixState = readJsonFile(matrixStatePath) ?? { version: 1, slots: {} };
  if (!matrixState.slots || typeof matrixState.slots !== "object") matrixState.slots = {};
  const gitCommit = (() => {
    try {
      const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", windowsHide: true });
      return result.status === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  })();
  let failed = 0;
  let replicateTotal = 0;
  let runIndex = 0;
  for (const pair of runSpecs) {
    let pairedBlueprintArtifact = blueprintArtifact;
    for (const strategy of pair.strategies) {
      const isReplicate = pair.replicate > 0;
      if (isReplicate) replicateTotal += 1;
      const fingerprint = buildStoryEvalMatrixFingerprint({
        caseId: pair.caseId,
        strategy,
        seed: pair.seed,
        profileConfig,
        model: aiValues.get("AI_MODEL")?.decoded ?? null,
        gitCommit,
      });
      const reusable = matrixReuse ? findReusableStoryEvalArtifact({ artifactRoot, fingerprint }) : null;
      if (reusable !== null) {
        const reusedCalls = resolve(reusable.artifactDir, "calls.jsonl");
        if (strategy === "explore" && existsSync(reusedCalls)) pairedBlueprintArtifact = reusedCalls;
        matrixState.slots[`${pair.pairId}:${strategy}`] = {
          fingerprint,
          artifactDir: reusable.artifactDir,
          status: reusable.manifest.status,
          reusedAt: new Date().toISOString(),
        };
        writeMatrixStateAtomic(matrixStatePath, matrixState);
        log(`${PREFIX} REUSED artifact=${reusable.artifactDir} pair=${pair.pairId} strategy=${strategy}`);
        runIndex += 1;
        continue;
      }
      // 每个 fresh run 使用 artifact 内持久 checkpoint.sqlite；失败后可直接以
      // --resume=<artifactDir> 重启，不再因父进程收尾而丢失数据库状态。
      const artifactDir = resumeArtifactDir ?? buildStoryEvalArtifactDir({
        artifactRoot,
        caseId: pair.caseId,
        strategy,
        runIndex,
      });
      const databasePath = resolve(artifactDir, "checkpoint.sqlite");
      mkdirSync(artifactDir, { recursive: true });
      if (!isPathInside(artifactRoot, artifactDir)) {
        log(`${PREFIX} ARTIFACT_PATH_REJECTED`);
        return 1;
      }
      const childEnv = {
        ...env,
        RUN_REAL_AI_STORY_EVAL: "1",
        STORY_EVAL_CAPTURE: "1",
        STORY_EVAL_ARTIFACT_DIR: artifactDir,
        STORY_EVAL_CASE_ID: pair.caseId,
        STORY_EVAL_STRATEGY: strategy,
        STORY_EVAL_SEED: String(pair.seed),
        STORY_EVAL_PAIR_ID: pair.pairId,
        STORY_EVAL_PROFILE: profileConfig.profile,
        STORY_EVAL_MAX_SCENES: String(profileConfig.maxScenes),
        STORY_EVAL_MAX_ROLE_ATTEMPTS: String(profileConfig.maxRoleAttempts),
        STORY_EVAL_AI_TIMEOUT_MS: String(profileConfig.aiTimeoutMs),
        STORY_EVAL_BRANCH_MODE: profileConfig.branchMode,
        STORY_EVAL_SCENE_WAIT_MS: env.STORY_EVAL_SCENE_WAIT_MS ?? String(3 * profileConfig.maxRoleAttempts * profileConfig.aiTimeoutMs + 60_000),
        STORY_EVAL_TOTAL_BUDGET_MS: String(profileConfig.totalBudgetMs),
        STORY_EVAL_RESUME: resumeArtifactDir === undefined ? "0" : "1",
        GAME_DB_PATH: databasePath,
        ...(pairedBlueprintArtifact === undefined ? {} : { STORY_EVAL_BLUEPRINT_ARTIFACT: pairedBlueprintArtifact }),
      };
      for (const key of ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY"]) {
        childEnv[key] = aiValues.get(key).decoded;
      }
      const replicateMark = isReplicate ? ` replicate=${pair.replicate + 1}/${runs}` : "";
      const sourceMark = pairedBlueprintArtifact === undefined ? " live-blueprint" : " captured-blueprint";
      log(`${PREFIX} record run ${runIndex + 1} pair=${pair.pairId} case=${pair.caseId} strategy=${strategy} seed=${pair.seed}${replicateMark}${sourceMark}`);
      const status = runSpawn(childEnv);
      if (status !== 0) failed += 1;
      matrixState.slots[`${pair.pairId}:${strategy}`] = {
        fingerprint,
        artifactDir,
        status: status === 0 ? "completed" : "failed",
        updatedAt: new Date().toISOString(),
      };
      writeMatrixStateAtomic(matrixStatePath, matrixState);
      if (status === 0 && pairedBlueprintArtifact === undefined) {
        const callsPath = resolve(artifactDir, "calls.jsonl");
        if (existsSync(callsPath)) pairedBlueprintArtifact = callsPath;
      }
      if (status !== 0) log(`${PREFIX} RESUMABLE_FAILURE artifact=${artifactDir} (use --resume=${artifactDir})`);
      runIndex += 1;
      // 一个显式 resume 只允许修复一个 slot；避免误把同一 SQLite 用于 pair 的另一策略。
      if (resumeArtifactDir !== undefined) break;
    }
    if (resumeArtifactDir !== undefined) break;
  }
  const total = runIndex;
  const summary = `${failed === 0 ? "REAL_AI_JOURNEY_OK" : `REAL_AI_JOURNEY_FAILED ${failed}/${total}`}` +
    (replicateTotal > 0 ? ` (含 replicate ${replicateTotal})` : "");
  log(`${PREFIX} ${summary}`);
  return failed === 0 ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main();
}
