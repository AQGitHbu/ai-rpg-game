import assert from "node:assert/strict";
import test from "node:test";
import {
  CROSS_REPO_FAMILY_REPOSITORIES,
  CROSS_REPO_FAMILY_START_COMMAND,
  collectPhasePolicyFailures,
  isCrossRepoFamilyPhase,
} from "./checkHandoff.mjs";

const legacyConfig = Object.freeze({
  repositories: ["ai-rpg-game"],
  startCommand: "npm run phase:start",
  sharedInfrastructureChangeAllowed: false,
});

const crossRepoConfig = Object.freeze({
  repositories: ["ai-game-foundation", "ai-slg-game", "ai-rpg-game"],
  startCommand: CROSS_REPO_FAMILY_START_COMMAND,
  sharedInfrastructureChangeAllowed: true,
});

const crossRepoPlanText = [
  "跨仓原子工作包：ai-game-foundation、ai-slg-game、ai-rpg-game。",
  "家族验收：npm run ready:family",
].join("\n");

test("单仓旧阶段维持原有严格要求", () => {
  assert.equal(isCrossRepoFamilyPhase(legacyConfig), false);
  assert.deepEqual(collectPhasePolicyFailures(legacyConfig, "任意 Plan"), []);
});

test("单仓阶段的 startCommand 必须是 npm run phase:start", () => {
  const failures = collectPhasePolicyFailures(
    { ...legacyConfig, startCommand: CROSS_REPO_FAMILY_START_COMMAND },
    "任意 Plan",
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /phase:start/);
});

test("单仓阶段不允许开启共享基础设施修改", () => {
  const failures = collectPhasePolicyFailures(
    { ...legacyConfig, sharedInfrastructureChangeAllowed: true },
    "任意 Plan",
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /共享基础设施/);
});

test("精确三仓 + sharedInfrastructureChangeAllowed 才是跨仓家族阶段", () => {
  assert.equal(isCrossRepoFamilyPhase(crossRepoConfig), true);
  assert.equal(
    isCrossRepoFamilyPhase({ ...crossRepoConfig, sharedInfrastructureChangeAllowed: false }),
    false,
  );
  assert.equal(
    isCrossRepoFamilyPhase({
      ...crossRepoConfig,
      repositories: ["ai-rpg-game", "ai-slg-game", "ai-game-foundation"],
    }),
    false,
  );
  assert.equal(
    isCrossRepoFamilyPhase({ ...crossRepoConfig, repositories: ["ai-game-foundation"] }),
    false,
  );
});

test("跨仓阶段允许手工协调 startCommand，Plan 合规时无失败", () => {
  assert.deepEqual(collectPhasePolicyFailures(crossRepoConfig, crossRepoPlanText), []);
});

test("跨仓阶段拒绝 npm run phase:start 作为 startCommand", () => {
  const failures = collectPhasePolicyFailures(
    { ...crossRepoConfig, startCommand: "npm run phase:start" },
    crossRepoPlanText,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /manual coordinated worktree setup/);
});

test("跨仓阶段 Plan 必须提及三个仓库", () => {
  const failures = collectPhasePolicyFailures(
    crossRepoConfig,
    "只有 ai-rpg-game 和 npm run ready:family",
  );
  assert.equal(failures.length, 2);
  assert.match(failures[0], /ai-game-foundation/);
  assert.match(failures[1], /ai-slg-game/);
});

test("跨仓阶段 Plan 必须包含 ready:family 家族验收", () => {
  const failures = collectPhasePolicyFailures(
    crossRepoConfig,
    "跨仓：ai-game-foundation、ai-slg-game、ai-rpg-game，但没有家族验收命令",
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /ready:family/);
});

test("三仓但未开启共享修改时按单仓严格要求拒绝", () => {
  const failures = collectPhasePolicyFailures(
    { ...crossRepoConfig, sharedInfrastructureChangeAllowed: false },
    crossRepoPlanText,
  );
  assert.equal(failures.length >= 1, true);
  assert.match(failures.join("\n"), /只允许修改 ai-rpg-game/);
});

test("常量与 Plan 固定值保持一致", () => {
  assert.deepEqual(
    [...CROSS_REPO_FAMILY_REPOSITORIES],
    ["ai-game-foundation", "ai-slg-game", "ai-rpg-game"],
  );
  assert.equal(
    CROSS_REPO_FAMILY_START_COMMAND,
    "manual coordinated worktree setup (see Phase 4B Plan Task 1)",
  );
});
