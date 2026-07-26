import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = resolve(root, "docs", "共同规范", "共享模块目录.json");
const query = process.argv.slice(2).join(" ").trim();
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

console.log(`共享基础仓库：${catalog.repository}`);
console.log(`查询：${query || "（未提供；展示已发布模块）"}`);

for (const pkg of catalog.packages) {
  console.log(`\n${pkg.name} [${pkg.status}]`);
  for (const responsibility of pkg.responsibility) console.log(`- ${responsibility}`);
}

for (const pkg of catalog.plannedPackages) {
  console.log(`\n${pkg.name} [${pkg.status}]`);
  console.log(`- 范围：${pkg.scope}`);
  console.log(`- 触发：${pkg.trigger}`);
}

if (catalog.plannedPackages.length === 0) {
  console.log("\n当前没有预建 UI、AI Runtime 或引擎 package。新能力第一次出现默认留在本项目；命中 AGENTS 触发条件时再读共享模块流程。");
}
