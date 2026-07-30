import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, relative } from "node:path";
import {
  defaultAiEnvSources,
  projectRoot,
  readAiEnv,
  validateAiEnv,
} from "./aiEnv.mjs";

const PREFIX = "[phase10-journey]";
const TEST_FILE = "src/game/application/testing/phase10FullJourney.test.ts";

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
    return spawn({ ...env, RUN_REAL_AI_JOURNEY: "0" });
  }
  if (env.RUN_REAL_AI_JOURNEY !== "1") {
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
  const artifactRoot = resolve(projectRoot, "artifacts", "phase10-journey");
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const artifactDir = resolve(artifactRoot, runId);
  if (!isPathInside(artifactRoot, artifactDir)) {
    log(`${PREFIX} ARTIFACT_PATH_REJECTED`);
    return 1;
  }
  const childEnv = {
    ...env,
    RUN_REAL_AI_JOURNEY: "1",
    PHASE10_JOURNEY_ARTIFACT_DIR: artifactDir,
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

