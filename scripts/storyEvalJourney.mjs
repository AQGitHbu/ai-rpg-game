// ---------------------------------------------------------------------------
// storyEvalJourney：评估旅程门禁脚本（spec §7）。
// 沿用 scripts/phase11StoryContinuityJourney.mjs 的门禁模式：
// - --mode=replay：跑零网络离线用例（vitest 文件内 fetch 被 mock）；
// - --mode=record：要求 RUN_REAL_AI_STORY_EVAL=1 才发真实计费调用；校验 AI 凭据
//   （aiEnv.mjs），逐局 spawnSync vitest 子进程，childEnv 显式注入
//   STORY_EVAL_CAPTURE=1、STORY_EVAL_ARTIFACT_DIR、STORY_EVAL_SEED、
//   STORY_EVAL_MAX_SCENES、GAME_DB_PATH（tmp 临时 SQLite）与 AI 三键。
// - --runs N：策略 seed 依次递增，每局独立 run-id 与独立临时库（结束即清）。
// 真实计费调用一律显式 env 开关；stdout 绝不打印凭据。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

export function isPathInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

/** 每次 record run 使用全新目录，避免 calls.jsonl 追加污染历史 run。 */
export function buildStoryEvalArtifactDir({ artifactRoot, caseId, strategy, runIndex }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(artifactRoot, `${caseId}-${strategy}-${runIndex}-${stamp}-${randomUUID().slice(0, 8)}`);
}

export const STORY_EVAL_PROFILE_DEFAULTS = Object.freeze({
  smoke: Object.freeze({ maxScenes: 3, maxRoleAttempts: 1, aiTimeoutMs: 60_000, branchMode: "none", totalBudgetMs: 10 * 60_000 }),
  regression: Object.freeze({ maxScenes: 12, maxRoleAttempts: 2, aiTimeoutMs: 90_000, branchMode: "sample", totalBudgetMs: 45 * 60_000 }),
  baseline: Object.freeze({ maxScenes: 60, maxRoleAttempts: 3, aiTimeoutMs: 120_000, branchMode: "full", totalBudgetMs: 90 * 60_000 }),
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
    aiTimeoutMs: resolveEvalInt(env, "STORY_EVAL_AI_TIMEOUT_MS", defaults.aiTimeoutMs, 1_000, 120_000),
    branchMode,
    totalBudgetMs: resolveEvalInt(env, "STORY_EVAL_TOTAL_BUDGET_MS", defaults.totalBudgetMs, 60_000, 6 * 60 * 60_000),
  };
}

function spawnJourney(env) {
  return spawnSync(
    process.execPath,
    ["./node_modules/vitest/vitest.mjs", "run", TEST_FILE],
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
  const baseSeed = resolveBaseSeed(argv);
  if (baseSeed === null) {
    log(`${PREFIX} INVALID_SEED`);
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
  const selectedCaseId = resolveCaseId(argv, cases);
  if (selectedCaseId === null) {
    log(`${PREFIX} INVALID_CASE`);
    return 1;
  }
  const selectedCases = selectedCaseId === undefined
    ? profileConfig.profile === "smoke" ? cases.slice(0, 1) : cases
    : cases.filter((item) => item.caseId === selectedCaseId);
  const runSpecs = selectedCases.flatMap((item) => [
    { caseId: item.caseId, strategy: "explore" },
    { caseId: item.caseId, strategy: "objective" },
  ]);
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
  let failed = 0;
  let replicateTotal = 0;
  let runIndex = 0;
  for (const runSpec of runSpecs) {
    for (let replicate = 0; replicate < runs; replicate += 1) {
      const isReplicate = replicate > 0;
      if (isReplicate) replicateTotal += 1;
      const seed = baseSeed + runIndex;
      // 每个 run 独立 artifact/db：dir 用展开序号，replicate 同样占唯一序号。
      const artifactDir = buildStoryEvalArtifactDir({
        artifactRoot,
        caseId: runSpec.caseId,
        strategy: runSpec.strategy,
        runIndex,
      });
      const databasePath = resolve(dbRoot, `story-eval-run-${runIndex}-${randomUUID()}.sqlite`);
      if (!isPathInside(artifactRoot, artifactDir)) {
        log(`${PREFIX} ARTIFACT_PATH_REJECTED`);
        return 1;
      }
      const childEnv = {
        ...env,
        RUN_REAL_AI_STORY_EVAL: "1",
        STORY_EVAL_CAPTURE: "1",
        STORY_EVAL_ARTIFACT_DIR: artifactDir,
        STORY_EVAL_CASE_ID: runSpec.caseId,
        STORY_EVAL_STRATEGY: runSpec.strategy,
        STORY_EVAL_SEED: String(seed),
        STORY_EVAL_PROFILE: profileConfig.profile,
        STORY_EVAL_MAX_SCENES: String(profileConfig.maxScenes),
        STORY_EVAL_MAX_ROLE_ATTEMPTS: String(profileConfig.maxRoleAttempts),
        STORY_EVAL_AI_TIMEOUT_MS: String(profileConfig.aiTimeoutMs),
        STORY_EVAL_BRANCH_MODE: profileConfig.branchMode,
        STORY_EVAL_SCENE_WAIT_MS: env.STORY_EVAL_SCENE_WAIT_MS ?? String(3 * profileConfig.maxRoleAttempts * profileConfig.aiTimeoutMs + 60_000),
        STORY_EVAL_TOTAL_BUDGET_MS: String(profileConfig.totalBudgetMs),
        GAME_DB_PATH: databasePath,
      };
      for (const key of ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY"]) {
        childEnv[key] = aiValues.get(key).decoded;
      }
      const replicateMark = isReplicate ? ` replicate=${replicate + 1}/${runs}` : "";
      log(`${PREFIX} record run ${runIndex + 1} case=${runSpec.caseId} strategy=${runSpec.strategy} seed=${seed}${replicateMark}`);
      const status = runSpawn(childEnv);
      if (status !== 0) failed += 1;
      try {
        rmSync(databasePath, { force: true });
      } catch {
        // Windows 句柄延迟：留待下次 sweep。
      }
      runIndex += 1;
    }
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
