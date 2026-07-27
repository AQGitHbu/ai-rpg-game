import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(root, "docs", "agent", "current-phase.json");
const strictBranch = process.argv.includes("--strict-branch");
const statusOnly = process.argv.includes("--status");
const failures = [];

if (!existsSync(configPath)) {
  throw new Error("缺少 docs/agent/current-phase.json。");
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const requiredFields = [
  "phase",
  "status",
  "implementationStatus",
  "targetBranch",
  "worktreeName",
  "plan",
  "entryDocs",
  "acceptanceCommands",
  "startCommand",
];
for (const field of requiredFields) {
  if (config[field] === undefined) failures.push(`current-phase.json 缺少 ${field}`);
}

for (const file of [config.plan, ...(config.entryDocs ?? [])]) {
  if (!existsSync(resolve(root, file))) failures.push(`入口文档不存在：${file}`);
}

if (config.status !== "planned") {
  failures.push(`当前交接状态应为 planned，实际为 ${config.status}`);
}
if (config.implementationStatus !== "not_started") {
  failures.push(`当前阶段交接前实现状态应为 not_started，实际为 ${config.implementationStatus}`);
}
if (JSON.stringify(config.repositories) !== JSON.stringify(["ai-rpg-game"])) {
  failures.push("当前阶段只允许修改 ai-rpg-game");
}
if (config.startCommand !== "npm run phase:start") {
  failures.push("当前阶段 startCommand 必须指向 npm run phase:start");
}
if (config.sharedInfrastructureChangeAllowed !== false) {
  failures.push("当前阶段不允许修改共享基础设施");
}

const plan = existsSync(resolve(root, config.plan))
  ? readFileSync(resolve(root, config.plan), "utf8")
  : "";
if (!plan.includes("> 状态：待执行")) failures.push("当前 Phase Plan 状态不是“待执行”");
if (!plan.includes("### 排除") && !plan.includes("## 明确边界")) {
  failures.push("当前 Phase Plan 缺少明确边界");
}

const branch = execFileSync("git", ["branch", "--show-current"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
  cwd: root,
  encoding: "utf8",
}).trim();

if (strictBranch && branch !== config.targetBranch) {
  failures.push(`当前分支 ${branch || "(detached)"}，期望 ${config.targetBranch}`);
}
if (strictBranch && !commonDir.replaceAll("\\", "/").includes("/.git")) {
  failures.push("无法确认当前目录属于 Git worktree");
}

console.log(`当前阶段：${config.phase}`);
console.log(`状态：${config.status} / ${config.implementationStatus}`);
console.log(`目标分支：${config.targetBranch}`);
console.log(`执行 Plan：${config.plan}`);
console.log(`修改仓库：${config.repositories.join(", ")}`);

if (statusOnly) process.exit(0);
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log(`✓ Agent 交接检查通过${strictBranch ? "（含分支）" : "（文档模式）"}`);
