import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const results = [];

const floor = String(pkg.engines?.node ?? "").match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
const current = process.versions.node.split(".").map(Number);
const nodeOk = !floor || current[0] > floor[0] || (current[0] === floor[0] && (current[1] > floor[1] || (current[1] === floor[1] && current[2] >= floor[2])));
results.push(["Node 版本", nodeOk, `当前 ${process.versions.node}，要求 ${pkg.engines.node}`]);
results.push(["共同规范副本", existsSync(resolve(root, "docs", "共同规范", ".standards-source.json")), "运行 npm run sync:standards 后存在"]);
results.push(["架构边界测试", existsSync(resolve(root, "src", "dependencyBoundaries.test.ts")), "边界测试文件存在"]);

try {
  execFileSync(process.execPath, ["scripts/checkStandards.mjs"], { cwd: root, stdio: "pipe" });
  results.push(["共同规范一致性", true, "检查通过"]);
} catch (error) {
  results.push(["共同规范一致性", false, String(error.message ?? error)]);
}

let failures = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "✓" : "✗"} ${name}：${detail}`);
  if (!ok) failures += 1;
}

if (failures > 0) process.exit(1);
