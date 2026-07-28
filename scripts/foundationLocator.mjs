import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// foundation 必须是完整的 sibling Git 仓库/同名 worktree；仅存在 packages
// 目录不足以证明它可用。这个最小根契约同时防止残缺目录被静默当成依赖。
const FOUNDATION_CONTRACT_PATHS = [
  ".git",
  "package.json",
  "project-family.json",
  "packages/standards/package.json",
  "packages/ui/package.json",
];

export function hasFoundationContract(root, pathExists = existsSync) {
  return FOUNDATION_CONTRACT_PATHS.every((relativePath) =>
    pathExists(resolve(root, relativePath)),
  );
}

export function resolveFoundationRoot({
  root = projectRoot,
  env = process.env,
  gitCommonDir,
  pathExists = existsSync,
} = {}) {
  const manifest = readManifest(root);
  const overrideName = manifest.pathOverrideEnvironmentVariable;
  if (overrideName && env[overrideName]) return resolve(env[overrideName]);

  const primaryRoot = resolvePrimaryCheckoutRoot(root, gitCommonDir);
  const foundationMain = resolve(primaryRoot, manifest.localPath);
  const worktreeName = resolveWorktreeName(root, primaryRoot, manifest.coordinatedWorktreeDirectory);
  if (worktreeName) {
    const candidate = resolve(
      foundationMain,
      manifest.coordinatedWorktreeDirectory,
      worktreeName,
    );
    if (hasFoundationContract(candidate, pathExists)) return candidate;
  }
  return foundationMain;
}

export function resolvePrimaryCheckoutRoot(root = projectRoot, gitCommonDir) {
  const commonDir = gitCommonDir ?? execFileSync(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  return dirname(resolve(root, commonDir));
}

export function resolveWorktreeName(root, primaryRoot, worktreeDirectory = ".worktrees") {
  const segments = relative(primaryRoot, root).split(/[\\/]+/);
  return segments[0] === worktreeDirectory && segments[1] ? segments[1] : null;
}

export function assertFoundationRoot(root = resolveFoundationRoot()) {
  if (!hasFoundationContract(root)) {
    throw new Error(
      `ai-game-foundation 缺失或不完整：${root}。它必须是完整 sibling Git 仓库；请停止清理操作并检查 .ai-game-foundation.json、链接或恢复流程。`,
    );
  }
  return root;
}

function readManifest(root) {
  return JSON.parse(readFileSync(resolve(root, ".ai-game-foundation.json"), "utf8"));
}
