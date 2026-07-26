import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AI_ENV_KEYS = ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY"];
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseEnvAssignments(content) {
  const values = new Map();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const raw = match[2].trim();
    const decoded =
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")))
        ? raw.slice(1, -1)
        : raw;
    values.set(match[1], { raw, decoded });
  }
  return values;
}

export function readAiEnv(path) {
  return parseEnvAssignments(readFileSync(path, "utf8"));
}

export function validateAiEnv(values) {
  const failures = [];
  for (const key of AI_ENV_KEYS) {
    const value = values.get(key)?.decoded.trim();
    if (!value) failures.push(`${key} 未设置`);
    if (value && /^(change-me|replace-me|todo|<.+>)$/i.test(value)) {
      failures.push(`${key} 仍是占位值`);
    }
  }

  const baseUrl = values.get("AI_API_BASE_URL")?.decoded.trim();
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) {
        failures.push("AI_API_BASE_URL 必须使用 http 或 https");
      }
    } catch {
      failures.push("AI_API_BASE_URL 不是合法 URL");
    }
  }
  return failures;
}

export function findMainRepositoryRoot(cwd = projectRoot) {
  const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  const commonDir = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (topLevel.status !== 0 || commonDir.status !== 0) {
    throw new Error("无法通过 Git 定位 ai-rpg-game 主仓");
  }
  return dirname(resolve(topLevel.stdout.trim(), commonDir.stdout.trim()));
}

export function defaultAiEnvSources({
  cwd = projectRoot,
  env = process.env,
} = {}) {
  const rpgMain = findMainRepositoryRoot(cwd);
  const familyRoot = dirname(rpgMain);
  return [
    env.AI_GAME_ENV_SOURCE ? resolve(cwd, env.AI_GAME_ENV_SOURCE) : null,
    resolve(rpgMain, ".env.local"),
    resolve(familyRoot, "ai-slg-game", ".env.local"),
    resolve(familyRoot, "ai-slg-game", ".env"),
  ].filter(Boolean);
}

export function findUsableAiEnvSource({ cwd = projectRoot, target, env = process.env } = {}) {
  for (const candidate of defaultAiEnvSources({ cwd, env })) {
    if (resolve(candidate) === resolve(target) || !existsSync(candidate)) continue;
    const values = readAiEnv(candidate);
    if (validateAiEnv(values).length === 0) return { path: candidate, values };
  }
  return null;
}
