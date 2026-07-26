import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFoundationRoot } from "./foundationLocator.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const foundationRoot = assertFoundationRoot();
const sourceRoot = resolve(foundationRoot, "packages", "standards");
const destinationRoot = resolve(root, "docs", "共同规范");

const files = [
  ["docs/共同游戏设计原则.md", "共同游戏设计原则.md"],
  ["docs/共同游戏开发规范.md", "共同游戏开发规范.md"],
  ["docs/共享模块开发流程.md", "共享模块开发流程.md"],
  ["docs/项目族定位与共享实践备忘.md", "项目族定位与共享实践备忘.md"],
  ["catalog/共享模块目录.json", "共享模块目录.json"]
];

if (!existsSync(sourceRoot)) {
  throw new Error(`未找到本地 foundation standards：${sourceRoot}`);
}

mkdirSync(destinationRoot, { recursive: true });
const copied = [];
for (const [from, to] of files) {
  const source = resolve(sourceRoot, from);
  if (!existsSync(source)) throw new Error(`缺少共同规范源文件：${source}`);
  const destination = resolve(destinationRoot, to);
  writeFileSync(destination, normalizedContent(source), "utf8");
  copied.push({ file: to, sha256: hash(destination) });
}

const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
writeFileSync(
  resolve(destinationRoot, ".standards-source.json"),
  `${JSON.stringify({
    source: "local-bootstrap",
    foundation: "ai-game-foundation",
    foundationPathHint: "../ai-game-foundation",
    pathOverrideEnvironmentVariable: "AI_GAME_FOUNDATION_DIR",
    package: packageJson.name,
    version: packageJson.version,
    files: copied
  }, null, 2)}\n`,
  "utf8"
);

console.log(`共同规范已从 ${sourceRoot} 同步。`);

function hash(file) {
  return createHash("sha256").update(normalizedContent(file)).digest("hex");
}

function normalizedContent(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}
