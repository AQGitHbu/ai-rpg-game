import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, readAiEnv, validateAiEnv } from "./aiEnv.mjs";

const target = resolve(projectRoot, ".env.local");
if (!existsSync(target)) {
  throw new Error("缺少 RPG 自有 .env.local；先运行 npm run env:bootstrap。");
}

const failures = validateAiEnv(readAiEnv(target));
if (failures.length > 0) {
  throw new Error(`RPG AI 环境检查失败：${failures.join("；")}`);
}
console.log("RPG AI 环境检查通过（未显示任何值）。");
