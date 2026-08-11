import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFoundationRoot,
  projectRoot,
  resolveFoundationRoot,
  resolvePrimaryCheckoutRoot,
} from "./foundationLocator.mjs";

// ---------------------------------------------------------------------------
// 安全删除 .worktrees/<name> 的唯一快捷入口（npm run worktree:remove -- <name>）。
// 分两段：
//   1) 委托受保护的 foundation 工具 cleanupConsumerWorktree.mjs 完成关键安全
//      步骤（校验登记、非递归解绑 .foundation junction、复核 foundation 完整、
//      git worktree remove）；本脚本绝不重复实现、也绝不绕过这些步骤。
//   2) foundation 工具常因 node_modules/tmp 等未跟踪产物在最后一步
//      git worktree remove 报 "Directory not empty"。此时只有在全部安全前提
//      通过后才清理残留目录：.foundation junction 已解绑、git 登记已解除、
//      目录内所有链接（如 node_modules/@ai-game/ui junction）已逐个非递归
//      解除且复扫为零。任何一项不满足立即停止并保留现场，符合 AGENTS.md
//      “工具报错时保留残留 worktree 并报告”的约束。
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(`worktree 删除已停止：${message}`);
}

export function validateWorktreeName(name) {
  return /^[a-z0-9][a-z0-9-]*$/.test(name ?? "");
}

/**
 * 深度收集目录内全部 reparse point（junction / symlink）。
 * 基于 lstat 判定，绝不进入链接内部，因此扫描本身不可能触碰链接目标。
 */
export function collectReparsePoints(root, { list = readdirSync, stat = lstatSync } = {}) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of list(directory)) {
      const path = join(directory, entry);
      const info = stat(path);
      if (info.isSymbolicLink()) {
        found.push(path);
      } else if (info.isDirectory()) {
        stack.push(path);
      }
    }
  }
  return found;
}

function git(args, options = {}) {
  return execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", ...options });
}

/** Windows 下大小写不敏感地比较两个绝对路径。 */
function samePath(a, b) {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

function listWorktreeBlocks() {
  const blocks = [];
  let current = {};
  for (const line of git(["worktree", "list", "--porcelain"]).split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length);
    else if (line === "") {
      if (current.path) blocks.push(current);
      current = {};
    }
  }
  if (current.path) blocks.push(current);
  return blocks;
}

function findRegisteredWorktree(target) {
  return listWorktreeBlocks().find((block) => samePath(block.path, target));
}

function removeResidualDirectory(target, foundation) {
  // 前提 1：.foundation junction 必须已被 foundation 工具解绑。
  if (existsSync(join(target, ".foundation"))) {
    fail(".foundation junction 仍存在：foundation 工具未完成安全步骤，保留残留并报告。");
  }
  // 前提 2：git 登记必须已解除（否则不是“只剩残留文件”的失败形态）。
  if (findRegisteredWorktree(target) !== undefined) {
    fail("该 worktree 仍在 git 登记中，不属于可自动清理的残留形态，保留现场。");
  }
  // 前提 3：逐个非递归解除目录内全部链接，每次解除后复核 foundation 完整。
  for (const link of collectReparsePoints(target)) {
    console.log(`解除残留链接（非递归）：${link}`);
    unlinkSync(link);
    assertFoundationRoot(foundation);
  }
  // 前提 4：复扫必须为零链接，才允许递归删除。
  const remaining = collectReparsePoints(target);
  if (remaining.length > 0) {
    fail(`仍有未解除的链接，拒绝递归删除：${remaining.join("; ")}`);
  }

  // Windows 可能因某个深层原生模块或构建产物被占用，使一次性的递归
  // rmSync 在清理过程中半途失败。此时按“文件 → 空目录”的顺序逐项删，
  // 既能继续清除已释放的条目，也能准确报告仍被占用的精确路径。
  const files = [];
  const directories = [target];
  const stack = [target];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        fail(`清理期间出现新的链接，拒绝继续：${path}`);
      }
      if (info.isDirectory()) {
        directories.push(path);
        stack.push(path);
      } else {
        files.push(path);
      }
    }
  }

  const failures = [];
  for (const file of files) {
    try {
      rmSync(file, { force: true });
    } catch (error) {
      failures.push(`${file} :: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    fail(`残留文件仍被占用或无权删除，保留现场：${failures.join("; ")}`);
  }

  for (const directory of directories.sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(directory);
    } catch (error) {
      failures.push(`${directory} :: ${error.message}`);
    }
  }
  if (failures.length > 0) {
    fail(`残留目录仍无法删除，保留现场：${failures.join("; ")}`);
  }
}

export function removeWorktree({ name, deleteBranch = false }) {
  if (!validateWorktreeName(name)) {
    fail("worktree 名称只能包含小写字母、数字和连字符。");
  }
  // 必须从主工作区（main checkout）运行，禁止在任何 worktree 内自删。
  if (!samePath(resolvePrimaryCheckoutRoot(projectRoot), projectRoot)) {
    fail("必须从主工作区运行（当前目录本身在某个 worktree 内）。");
  }
  const target = resolve(projectRoot, ".worktrees", name);
  if (!existsSync(target)) fail(`找不到 ${target}。`);

  const foundation = assertFoundationRoot(resolveFoundationRoot());
  const cleanupTool = resolve(foundation, "scripts", "cleanupConsumerWorktree.mjs");
  if (!existsSync(cleanupTool)) fail(`foundation 缺少清理工具：${cleanupTool}。`);

  // 删除前记录分支名，供可选的 --delete-branch 使用。
  const registered = findRegisteredWorktree(target);
  const branch = registered?.branch?.replace("refs/heads/", "") ?? null;

  let toolFailed = false;
  try {
    execFileSync(
      process.execPath,
      [cleanupTool, "--repository", projectRoot, "--worktree-name", name],
      { stdio: "inherit" },
    );
  } catch {
    toolFailed = true;
  }
  // 无论工具成败，先复核 foundation 完整；损坏立即停止。
  assertFoundationRoot(foundation);

  if (toolFailed && existsSync(target)) {
    console.log("foundation 工具在最后一步失败，进入受控残留清理……");
    removeResidualDirectory(target, foundation);
  } else if (toolFailed) {
    fail("foundation 工具报错且目录已消失，状态异常，请人工检查 git worktree list。");
  }

  git(["worktree", "prune"]);
  assertFoundationRoot(foundation);
  if (existsSync(target)) fail(`目录仍存在：${target}，请人工检查。`);
  console.log(`✓ worktree 已删除：${target}`);

  if (deleteBranch) {
    if (branch === null) {
      console.log("未找到对应分支记录，跳过分支删除。");
    } else {
      // 只用安全删除（-d）：未合并分支会被 git 拒绝并如实报错，绝不 -D。
      execFileSync("git", ["-C", projectRoot, "branch", "-d", branch], { stdio: "inherit" });
      console.log(`✓ 分支已删除：${branch}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const deleteBranch = args.includes("--delete-branch");
  const positional = args.filter((argument) => !argument.startsWith("--"));
  if (positional.length !== 1) {
    fail("用法：npm run worktree:remove -- <name> [--delete-branch]");
  }
  removeWorktree({ name: positional[0], deleteBranch });
}
