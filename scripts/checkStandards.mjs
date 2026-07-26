import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFoundationRoot } from "./foundationLocator.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destinationRoot = resolve(root, "docs", "共同规范");
const manifestPath = resolve(destinationRoot, ".standards-source.json");

if (!existsSync(manifestPath)) {
  throw new Error("共同规范尚未同步；请先运行 npm run sync:standards。");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const sourceRoot = resolve(assertFoundationRoot(), "packages", "standards");
const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, "package.json"), "utf8"));
if (packageJson.name !== manifest.package || packageJson.version !== manifest.version) {
  throw new Error(
    `共同规范版本漂移：副本 ${manifest.package}@${manifest.version}，foundation ${packageJson.name}@${packageJson.version}。`,
  );
}
for (const entry of manifest.files) {
  const file = resolve(destinationRoot, entry.file);
  const source = resolveSource(sourceRoot, entry.file);
  if (
    !existsSync(file) ||
    !existsSync(source) ||
    hash(file) !== entry.sha256 ||
    hash(source) !== entry.sha256
  ) {
    throw new Error(`共同规范已漂移：${entry.file}；请重新运行 npm run sync:standards。`);
  }
}

console.log(`共同规范检查通过：${manifest.package}@${manifest.version}`);

function hash(file) {
  return createHash("sha256")
    .update(readFileSync(file, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");
}

function resolveSource(sourceRoot, file) {
  return file.endsWith(".json")
    ? resolve(sourceRoot, "catalog", file)
    : resolve(sourceRoot, "docs", file);
}
