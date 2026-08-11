import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  projectRoot,
  resolvePrimaryCheckoutRoot,
} from "./foundationLocator.mjs";
import { removeWorktree, validateWorktreeName } from "./removeWorktree.mjs";

function fail(message) {
  throw new Error(`分支收尾已停止：${message}`);
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

export function parseFinishArgs(args) {
  const positional = args.filter((argument) => !argument.startsWith("--"));
  const flags = new Set(args.filter((argument) => argument.startsWith("--")));
  if (positional.length !== 1 || [...flags].some((flag) => flag !== "--dry-run")) {
    fail("用法：npm run branch:finish -- <branch> [--dry-run]");
  }
  const branch = positional[0].replace(/^refs\/heads\//, "");
  const slash = branch.indexOf("/");
  const worktreeName = slash === -1 ? branch : branch.slice(slash + 1);
  if (!branch || branch === "main" || !validateWorktreeName(worktreeName)) {
    fail("参数必须是非 main 分支，且分支名去掉前缀后能映射为合法 worktree 名称。");
  }
  return { branch, worktreeName, dryRun: flags.has("--dry-run") };
}

export function parseWorktreeList(output) {
  const blocks = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
      blocks.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim();
    }
  }
  return blocks;
}

function isInsideWorktrees(path) {
  const worktreesRoot = resolve(projectRoot, ".worktrees");
  const relativePath = relative(worktreesRoot, resolve(path));
  return relativePath && !relativePath.startsWith("..") && !relativePath.includes(":");
}

function resolveTarget({ branch, worktreeName }) {
  const registered = parseWorktreeList(git(["worktree", "list", "--porcelain"], { capture: true }))
    .find((entry) => entry.branch === `refs/heads/${branch}`);
  const expected = resolve(projectRoot, ".worktrees", worktreeName);
  if (registered) {
    if (!isInsideWorktrees(registered.path) || basename(resolve(registered.path)) !== worktreeName) {
      fail(`分支登记的 worktree 不在 .worktrees/${worktreeName}：${registered.path}`);
    }
    return { path: resolve(registered.path), registered: true };
  }
  return { path: expected, registered: false };
}

function assertMainCheckout() {
  if (resolvePrimaryCheckoutRoot(projectRoot) !== resolve(projectRoot)) {
    fail("必须从 ai-rpg-game 主工作区运行，不能在 worktree 内自删。");
  }
  const currentBranch = git(["branch", "--show-current"], { capture: true }).trim();
  if (currentBranch !== "main") {
    fail(`必须从 main 运行，当前为 ${currentBranch || "(detached)"}。`);
  }
  if (git(["status", "--porcelain"], { capture: true }).trim()) {
    fail("main 有未提交修改；请先处理工作区，再执行分支收尾。");
  }
}

function assertMerged(branch) {
  const exists = (() => {
    try {
      git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  })();
  if (!exists) fail(`本地分支不存在：${branch}`);
  try {
    git(["merge-base", "--is-ancestor", branch, "main"]);
  } catch {
    fail(`${branch} 尚未合入 main，拒绝删除。`);
  }
}

function assertRegisteredWorktreeClean(path, branch) {
  const current = git(["branch", "--show-current"], { cwd: path, capture: true }).trim();
  if (current !== branch) fail(`worktree 当前分支为 ${current || "(detached)"}，不是 ${branch}。`);
  if (git(["status", "--porcelain"], { cwd: path, capture: true }).trim()) {
    fail(`worktree 有未提交修改，拒绝删除：${path}`);
  }
}

export function finishBranch({ branch, worktreeName, dryRun = false }) {
  assertMainCheckout();
  assertMerged(branch);
  const target = resolveTarget({ branch, worktreeName });
  if (target.registered && existsSync(target.path)) assertRegisteredWorktreeClean(target.path, branch);
  if (!target.registered && existsSync(target.path)) {
    console.log(`发现未登记的残留目录，将按受控残留路径清理：${target.path}`);
  }

  if (dryRun) {
    console.log(`✓ 已验证 ${branch} 已合入 main`);
    console.log(`将清理：${target.path}`);
    console.log(`将删除：${branch}`);
    return;
  }

  if (existsSync(target.path)) removeWorktree({ name: worktreeName });
  git(["worktree", "prune"]);
  if (existsSync(target.path)) fail(`worktree 目录仍存在：${target.path}`);
  git(["branch", "-d", branch]);
  console.log(`✓ 分支收尾完成：${branch}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseFinishArgs(process.argv.slice(2));
  finishBranch(options);
}
