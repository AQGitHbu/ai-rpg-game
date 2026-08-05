// 分层验证入口：把零网络回归、短真实 smoke、完整 regression 与 release
// 门禁拆开。默认只跑 offline，真实请求必须由调用方显式设置相应 opt-in。
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { projectRoot } from "./aiEnv.mjs";

const PREFIX = "[story-eval-verify]";
const LAYERS = new Set(["offline", "smoke", "regression", "release"]);

export function resolveVerificationLayer(argv = []) {
  const value = argv.find((entry) => entry.startsWith("--layer="))?.slice("--layer=".length) ?? "offline";
  return LAYERS.has(value) ? value : null;
}

export function buildVerificationCommand(layer, argv = []) {
  const passthrough = argv.filter((entry) => !entry.startsWith("--layer="));
  if (layer === "offline") {
    return { script: "scripts/storyEvalJourney.mjs", args: ["--mode=replay"] };
  }
  const profile = layer === "smoke" ? "smoke" : layer === "regression" ? "regression" : "baseline";
  return {
    script: "scripts/storyEvalJourney.mjs",
    args: ["--mode=record", `--reuse-completed`, `--profile=${profile}`, ...passthrough],
  };
}

function runNodeScript(script, args, env, spawn = spawnSync) {
  const result = spawn(process.execPath, [resolve(projectRoot, script), ...args], {
    cwd: projectRoot,
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  return result.status ?? 1;
}

export function main({ argv = process.argv.slice(2), env = process.env, log = console.log, spawn = spawnSync } = {}) {
  const layer = resolveVerificationLayer(argv);
  if (layer === null) {
    log(`${PREFIX} INVALID_LAYER`);
    return 1;
  }
  if (layer !== "offline" && env.RUN_REAL_AI_STORY_EVAL !== "1") {
    log(`${PREFIX} REAL_AI_OPT_IN_REQUIRED layer=${layer}`);
    return 1;
  }
  if (layer === "release" && env.RUN_REAL_AI_STORY_EVAL_JUDGE !== "1") {
    log(`${PREFIX} JUDGE_OPT_IN_REQUIRED layer=release`);
    return 1;
  }
  const command = buildVerificationCommand(layer, argv);
  const childEnv = { ...env, STORY_EVAL_PROFILE: command.args.find((arg) => arg.startsWith("--profile="))?.slice(10) ?? env.STORY_EVAL_PROFILE };
  const status = runNodeScript(command.script, command.args, layer === "offline"
    ? { ...childEnv, RUN_REAL_AI_STORY_EVAL: "0" }
    : childEnv, spawn);
  log(`${PREFIX} layer=${layer} status=${status === 0 ? "ok" : "failed"}`);
  return status;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) process.exitCode = main();

