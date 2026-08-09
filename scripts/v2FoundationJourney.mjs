#!/usr/bin/env node
/**
 * v2.1 foundation 完整离线旅程（Task 30）。
 *
 * 该旅程为确定性离线 journey（fixture world source + deterministic scene source），
 * 零网络、零计费。脚本只做 replaay 模式：直接运行 vitest journey 测试并透出结果。
 * 失败时以非零码退出。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mode = process.argv[2]?.split("=")[1] ?? process.argv[2] ?? "replay";

if (mode !== "replay") {
  console.error(`仅支持 --mode=replay（离线确定性旅程）。收到：${mode}`);
  process.exit(2);
}

const result = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vitest", "run", "src/game/application/testing/v2FoundationJourney.test.ts"],
  { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
);

process.exit(result.status ?? 1);
