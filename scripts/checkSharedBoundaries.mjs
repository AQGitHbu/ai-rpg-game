import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(root, "src");
const violations = [];
const PUBLIC_SHARED_SUBPATHS = new Set(["@ai-game/logging/redaction"]);

for (const file of walk(sourceRoot)) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/from\s+["'](@ai-game\/[^"']+)["']/g)) {
    const specifier = match[1];
    const segments = specifier.split("/");
    if (segments.length > 2 && !PUBLIC_SHARED_SUBPATHS.has(specifier)) {
      violations.push(`${file}: deep import ${specifier}`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(`共享 package import 违反 public API：\n${violations.join("\n")}`);
}

console.log("共享 package 边界检查通过。");

function walk(dir) {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(entry) ? [full] : [];
    });
  } catch {
    return [];
  }
}
