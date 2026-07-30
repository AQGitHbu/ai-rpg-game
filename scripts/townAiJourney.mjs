import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  defaultAiEnvSources,
  projectRoot,
  readAiEnv,
  validateAiEnv,
} from "./aiEnv.mjs";

// ---------------------------------------------------------------------------
// townAiJourney CLI：真实 AI 的 scene+town 旅程录制/回放驱动（镜像 phase10Journey）。
// - replay：零网络 golden 回放（RUN_REAL_AI_TOWN_JOURNEY=0），CI 默认路径；
// - record：opt-in 真实 AI 录制（需 RUN_REAL_AI_TOWN_JOURNEY=1 + 有效 AI 三键），
//   产物落入 artifacts/town-journey/run-*，人工复核后复制到 data/fixtures。
// 脚本只注入 AI 三键与 artifact 目录：绝不打印任何密钥/URL/模型值。
// ---------------------------------------------------------------------------

const PREFIX = "[town-journey]";
const TEST_FILE = "src/game/application/testing/townAiJourney.test.ts";

export function resolveJourneyMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "replay";
  return mode === "record" || mode === "replay" ? mode : null;
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

export function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  spawn = spawnJourney,
} = {}) {
  const mode = resolveJourneyMode(argv);
  if (mode === null) {
    log(`${PREFIX} INVALID_MODE`);
    return 1;
  }
  if (mode === "replay") {
    log(`${PREFIX} replay: zero-network golden journey`);
    return spawn({ ...env, RUN_REAL_AI_TOWN_JOURNEY: "0" });
  }
  if (env.RUN_REAL_AI_TOWN_JOURNEY !== "1") {
    log(`${PREFIX} REAL_AI_OPT_IN_REQUIRED`);
    return 1;
  }

  const source = defaultAiEnvSources({ cwd: projectRoot, env })
    .find((candidate) => existsSync(candidate) && validateAiEnv(readAiEnv(candidate)).length === 0);
  if (source === undefined) {
    log(`${PREFIX} AI_ENV_INVALID`);
    return 1;
  }
  const aiValues = readAiEnv(source);
  const artifactRoot = resolve(projectRoot, "artifacts", "town-journey");
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const artifactDir = resolve(artifactRoot, runId);
  if (!isPathInside(artifactRoot, artifactDir)) {
    log(`${PREFIX} ARTIFACT_PATH_REJECTED`);
    return 1;
  }
  const childEnv = {
    ...env,
    RUN_REAL_AI_TOWN_JOURNEY: "1",
    TOWN_JOURNEY_ARTIFACT_DIR: artifactDir,
  };
  for (const key of ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY"]) {
    childEnv[key] = aiValues.get(key).decoded;
  }
  log(`${PREFIX} record: real AI opt-in accepted`);
  const status = spawn(childEnv);
  log(`${PREFIX} ${status === 0 ? "REAL_AI_JOURNEY_OK" : "REAL_AI_JOURNEY_FAILED"}`);
  return status;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main();
}
