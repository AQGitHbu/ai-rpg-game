import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { findMainRepositoryRoot, projectRoot } from "./aiEnv.mjs";

const dryRun = process.argv.includes("--dry-run");
const config = JSON.parse(
  readFileSync(resolve(projectRoot, "docs", "agent", "current-phase.json"), "utf8"),
);
const mainRoot = findMainRepositoryRoot(projectRoot);
const worktreePath = join(mainRoot, ".worktrees", config.worktreeName);

function git(args, { cwd = mainRoot, capture = false } = {}) {
  if (dryRun) {
    console.log(`[${cwd}] git ${args.join(" ")}`);
    return { status: 0, stdout: "" };
  }
  const result = spawnSync("git", args, {
    cwd,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败`);
  return result;
}

function npmRun(script) {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  if (dryRun) {
    console.log(`[${worktreePath}] npm run ${script}`);
    return;
  }
  const result = spawnSync(command, ["run", script], {
    cwd: worktreePath,
    stdio: "inherit",
    windowsHide: true,
    // Windows 的 .cmd 不能以 CreateProcess 直接启动；交由 shell 包装，
    // 否则 spawnSync 会返回 EINVAL，phase:start 会误报 setup 失败。
    shell: process.platform === "win32",
  });
  if (result.error) throw new Error(`npm run ${script} 无法启动：${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm run ${script} 失败（退出码 ${result.status}）`);
}

if (config.status !== "planned" || config.implementationStatus !== "not_started") {
  throw new Error("current-phase.json 不是可启动的 planned/not_started 状态");
}
if (config.repositories.join(",") !== "ai-rpg-game") {
  throw new Error("phase:start 只支持当前单仓 RPG 阶段；跨仓阶段必须使用单独 Plan");
}
if (!config.worktreeName || !config.targetBranch?.startsWith("codex/")) {
  throw new Error("current-phase.json 缺少合法 worktreeName 或 codex/ 目标分支");
}

const currentBranch = git(["branch", "--show-current"], { capture: true }).stdout.trim();
if (!dryRun && resolve(projectRoot) !== resolve(mainRoot)) {
  throw new Error("phase:start 只能从 ai-rpg-game 主工作区执行");
}
if (!dryRun && currentBranch !== "main") {
  throw new Error(`phase:start 要求主工作区位于 main，当前为 ${currentBranch}`);
}
if (!dryRun) {
  const dirty = git(["status", "--porcelain"], { capture: true }).stdout.trim();
  if (dirty) throw new Error("ai-rpg-game main 有未提交修改，拒绝创建阶段 worktree");
}

if (existsSync(worktreePath)) {
  const worktreeBranch = git(["branch", "--show-current"], {
    cwd: worktreePath,
    capture: true,
  }).stdout.trim();
  if (!dryRun && worktreeBranch !== config.targetBranch) {
    throw new Error(`${worktreePath} 已存在但分支是 ${worktreeBranch}`);
  }
  console.log(`阶段 worktree 已存在：${worktreePath}`);
} else {
  const branchExists =
    !dryRun &&
    spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${config.targetBranch}`], {
      cwd: mainRoot,
      windowsHide: true,
    }).status === 0;
  git(
    branchExists
      ? ["worktree", "add", worktreePath, config.targetBranch]
      : ["worktree", "add", "-b", config.targetBranch, worktreePath, "main"],
  );
}

npmRun("setup");
npmRun("handoff:check");
console.log(`当前阶段已可交接：${worktreePath}`);
