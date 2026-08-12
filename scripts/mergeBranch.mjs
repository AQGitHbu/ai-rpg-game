import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finishBranch, parseFinishArgs, parseWorktreeList } from "./finishBranch.mjs";
import { projectRoot, resolvePrimaryCheckoutRoot } from "./foundationLocator.mjs";

function fail(message) {
  throw new Error(`分支合并已停止：${message}`);
}

function git(args, { cwd = projectRoot, capture = false } = {}) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} 失败：${error.message}`);
  }
}

function isInsideWorktrees(path) {
  const worktreesRoot = resolve(projectRoot, ".worktrees");
  const relativePath = relative(worktreesRoot, resolve(path));
  return relativePath && !relativePath.startsWith("..") && !relativePath.includes(":");
}

function assertMainCheckout() {
  if (resolvePrimaryCheckoutRoot(projectRoot) !== resolve(projectRoot)) {
    fail("必须从 ai-rpg-game 主工作区运行，不能在 worktree 内合并。");
  }
  const currentBranch = git(["branch", "--show-current"], { capture: true }).trim();
  if (currentBranch !== "main") {
    fail(`必须从 main 运行，当前为 ${currentBranch || "(detached)"}。`);
  }
  if (git(["status", "--porcelain"], { capture: true }).trim()) {
    fail("main 有未提交修改；请先恢复或处理工作区，再执行分支合并。");
  }
}

function assertLocalBranch(branch) {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  } catch {
    fail(`本地分支不存在：${branch}`);
  }
}

function assertTargetWorktreeClean(branch, worktreeName) {
  const target = parseWorktreeList(git(["worktree", "list", "--porcelain"], { capture: true }))
    .find((entry) => entry.branch === `refs/heads/${branch}`);
  const expected = resolve(projectRoot, ".worktrees", worktreeName);
  if (!target) {
    if (existsSync(expected)) {
      fail(`目标目录存在但未登记为 Git worktree，拒绝继续：${expected}`);
    }
    return;
  }
  if (!isInsideWorktrees(target.path) || basename(resolve(target.path)) !== worktreeName) {
    fail(`分支登记的 worktree 不在 .worktrees/${worktreeName}：${target.path}`);
  }
  if (!existsSync(target.path)) {
    fail(`分支登记的 worktree 目录不存在：${target.path}`);
  }
  const currentBranch = git(["branch", "--show-current"], { cwd: target.path, capture: true }).trim();
  if (currentBranch !== branch) {
    fail(`worktree 当前分支为 ${currentBranch || "(detached)"}，不是 ${branch}。`);
  }
  if (git(["status", "--porcelain"], { cwd: target.path, capture: true }).trim()) {
    fail(`worktree 有未提交修改，拒绝合并：${target.path}`);
  }
}

export function parseMergeArgs(args) {
  const parsed = parseFinishArgs(args);
  return parsed;
}

export function mergeBranch({ branch, worktreeName, dryRun = false }) {
  assertMainCheckout();
  assertLocalBranch(branch);
  assertTargetWorktreeClean(branch, worktreeName);

  if (dryRun) {
    console.log(`✓ 已验证 ${branch} 可从干净 main 执行 fast-forward 合并`);
    console.log(`将合并：${branch}`);
    console.log(`将执行：npm run branch:finish -- ${branch}`);
    return;
  }

  git(["merge", "--ff-only", branch]);
  finishBranch({ branch, worktreeName });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseMergeArgs(process.argv.slice(2));
  mergeBranch(options);
}
