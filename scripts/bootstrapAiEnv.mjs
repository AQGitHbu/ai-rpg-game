import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AI_ENV_KEYS,
  findUsableAiEnvSource,
  projectRoot,
  readAiEnv,
  validateAiEnv,
} from "./aiEnv.mjs";

const force = process.argv.includes("--force");
const target = resolve(projectRoot, ".env.local");

if (existsSync(target) && !force) {
  const failures = validateAiEnv(readAiEnv(target));
  if (failures.length > 0) {
    throw new Error(
      `.env.local 已存在但 AI 配置无效：${failures.join("；")}。修正文件或显式运行 env:bootstrap -- --force。`,
    );
  }
  console.log("RPG 自有 .env.local 已就绪（未显示任何值）。");
} else {
  const source = findUsableAiEnvSource({ target });
  if (!source) {
    console.log(
      "未找到完整的 AI 环境来源；Phase 1 可继续。需要真实 AI 时，请填写 RPG 自有 .env.local 或设置 AI_GAME_ENV_SOURCE 后运行 env:bootstrap。",
    );
  } else {
    const lines = [
      "# ai-rpg-game owned environment; seeded locally and never committed.",
      "# Runtime reads this repository's environment only. The source may diverge later.",
      ...AI_ENV_KEYS.map((key) => `${key}=${source.values.get(key).raw}`),
      "",
    ];
    writeFileSync(target, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
    console.log(`已初始化 RPG 自有 .env.local，来源：${source.path}（未显示任何值）。`);
  }
}
