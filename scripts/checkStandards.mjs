import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = resolve(root, "docs", "共同规范");
const manifestPath = resolve(destinationRoot, ".standards-source.json");

if (!existsSync(manifestPath)) {
  throw new Error("共同规范尚未同步；请先运行 npm run sync:standards。");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const entry of manifest.files) {
  const file = resolve(destinationRoot, entry.file);
  if (!existsSync(file) || hash(file) !== entry.sha256) {
    throw new Error(`共同规范已漂移：${entry.file}；请重新运行 npm run sync:standards。`);
  }
}

console.log(`共同规范检查通过：${manifest.package}@${manifest.version}`);

function hash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
