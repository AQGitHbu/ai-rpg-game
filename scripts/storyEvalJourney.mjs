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
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  defaultAiEnvSources,
  projectRoot,
  readAiEnv,
  validateAiEnv,
} from "./aiEnv.mjs";

const PREFIX = "[story-eval-journey]";
const TEST_FILE = "src/game/application/testing/storyEvalJourney.test.ts";

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
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    // runId 带随机后缀：防并发/同毫秒冲突覆盖同目录产物。
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const artifactDir = resolve(artifactRoot, runId);
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
      STORY_EVAL_SEED: String(baseSeed + runIndex),
      STORY_EVAL_MAX_SCENES: env.STORY_EVAL_MAX_SCENES ?? "60",
      GAME_DB_PATH: databasePath,
    };
    for (const key of ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY"]) {
      childEnv[key] = aiValues.get(key).decoded;
    }
    log(`${PREFIX} record run ${runIndex + 1}/${runs} seed=${baseSeed + runIndex}`);
    const status = runSpawn(childEnv);
    if (status !== 0) failed += 1;
    try {
      rmSync(databasePath, { force: true });
    } catch {
      // Windows 句柄延迟：留待下次 sweep。
    }
  }
  log(`${PREFIX} ${failed === 0 ? "REAL_AI_JOURNEY_OK" : `REAL_AI_JOURNEY_FAILED ${failed}/${runs}`}`);
  return failed === 0 ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main();
}
