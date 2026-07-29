import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 跨仓家族阶段的唯一合法组合：顺序与内容都必须精确匹配（见 Phase 4B Plan Task 1）。
export const CROSS_REPO_FAMILY_REPOSITORIES = Object.freeze([
  "ai-game-foundation",
  "ai-slg-game",
  "ai-rpg-game",
]);
export const CROSS_REPO_FAMILY_START_COMMAND =
  "manual coordinated worktree setup (see Phase 4B Plan Task 1)";

export function isCrossRepoFamilyPhase(config) {
  return (
    JSON.stringify(config.repositories) === JSON.stringify(CROSS_REPO_FAMILY_REPOSITORIES) &&
    config.sharedInfrastructureChangeAllowed === true
  );
}

/**
 * 阶段策略检查：单仓旧阶段维持原有严格要求；只有精确三仓且
 * sharedInfrastructureChangeAllowed === true 时允许手工协调 startCommand，
 * 且 Plan 必须提及三个仓库与 ready:family 家族验收。
 */
export function collectPhasePolicyFailures(config, planText) {
  const failures = [];
  if (isCrossRepoFamilyPhase(config)) {
    if (config.startCommand !== CROSS_REPO_FAMILY_START_COMMAND) {
      failures.push(
        `跨仓家族阶段 startCommand 必须是 "${CROSS_REPO_FAMILY_START_COMMAND}"（phase:start 拒绝跨仓阶段）`,
      );
    }
    for (const repository of CROSS_REPO_FAMILY_REPOSITORIES) {
      if (!planText.includes(repository)) {
        failures.push(`跨仓家族阶段 Plan 必须提及仓库 ${repository}`);
      }
    }
    if (!planText.includes("ready:family")) {
      failures.push("跨仓家族阶段 Plan 必须包含 ready:family 家族验收");
    }
    return failures;
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
  return failures;
}

function runHandoffCheck() {
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

  const plan = existsSync(resolve(root, config.plan))
    ? readFileSync(resolve(root, config.plan), "utf8")
    : "";
  failures.push(...collectPhasePolicyFailures(config, plan));
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHandoffCheck();
}
