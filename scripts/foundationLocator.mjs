import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    if (pathExists(resolve(candidate, "packages", "standards"))) return candidate;
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
  const standards = resolve(root, "packages", "standards", "package.json");
  if (!existsSync(standards)) {
    throw new Error(
      `未找到 ai-game-foundation：${root}。请检查 .ai-game-foundation.json 或设置 AI_GAME_FOUNDATION_DIR。`,
    );
  }
  return root;
}

function readManifest(root) {
  return JSON.parse(readFileSync(resolve(root, ".ai-game-foundation.json"), "utf8"));
}
