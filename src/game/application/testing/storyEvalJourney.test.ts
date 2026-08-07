/** @vitest-environment node */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import type { GameSessionView } from "../gameSessionView";
import { createServerGameEntryPoints, type ServerGameEntryPoints } from "../server/compositionRoot";
import { toDirectorContext } from "../runtimeNarrativeContexts";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository, type SqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { asGameId, type GameRecord } from "../server/persistence/gameRepository";
import { deriveContentProgression } from "@/game/gameplay/rpg/narrative";
import { canQueueRuntimeNarrativeScene } from "../runtimeNarrativeEligibility";
import {
  relationshipTierOf,
  storyMemoryOf,
  type GameEvent,
  type GameState,
  type ScenarioBlueprintCandidate,
} from "@/game/domain";
import { validateStoryEvalArtifacts, type StoryEvalCompleteness, type StoryEvalStoryRow } from "./storyEvalArtifacts";
import { loadStoryEvalCases, type EarlyPredictionAnswerKey } from "./storyEvalCases";
import { hashStringToSeed, mulberry32, pickNarrativeChoice, pickObjectiveChoice } from "./storyEvalStrategy";
import { NARRATIVE_CONTRACT_VERSION } from "../runtimeNarrative";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateAttempt,
  type ScenarioCandidateSource,
} from "../scenarioGeneration";
import { resolveAiThinkingRoles } from "../server/ai/aiThinking";
import { projectStoryEvalContinuation } from "./storyEvalContinuation";
import {
  assertResumableFingerprint,
  readStoryEvalPartialRows,
  readStoryEvalProgress,
  storyEvalCheckpointPaths,
  writeStoryEvalPartialRowsAtomic,
  writeStoryEvalProgressAtomic,
  type StoryEvalPendingScene,
  type StoryEvalProgress,
  type StoryEvalRunFingerprint,
} from "./storyEvalCheckpoint";

// ---------------------------------------------------------------------------
// 评估旅程本体（spec §7 + Task 13）：经 createServerGameEntryPoints 驱动（唯一能
// 命中 §6.2 采集装配点、且与浏览器局同一条服务端路径的方式）。驱动侧另开评估
// 专用只读 repository（createSqliteGameRepository + 同一 GAME_DB_PATH）读取
// actionKey/主线阶段/世界 seed/蓝图快照——不经过客户端投影，不破坏安全红线。
// 离线模式（默认）：global fetch 被 mock，零网络零计费；真实模式仅在
// RUN_REAL_AI_STORY_EVAL=1 时启用（由门禁脚本 storyEvalJourney.mjs 注入）。
//
// Task 13（v2）：
// - 输入改按 v2.json case 构造（loadStoryEvalCases 按 caseId 解析），
//   不再调用固定的 buildStoryEvalInput。
// - manifest 写入 caseId/strategy/worldSeed/gitCommit/contractVersion/四角色
//   prompt 版本/AI model/temperature/timeoutMs/answerKey。
// - story 行写入 memorySummary、当前 NPC profile/relationship/lastInteractionSummary、
//   newEvents 安全结构（{ type, factId?, entityId?, questId?, endingId? }），
//   绝不写入 prompt、provider 原文或采集开关外的敏感资料。
// - 主线阶段检查点（预设 2/4/6）：读取完整记录并关闭该检查点的读连接后，经
//   repository.createInitialGame 把同一 blueprint/state 写入两个独立测试 SQLite
//   （新 gameId、revision 从 0 起），两个 entry points 各执行一个当前 choiceToken
//   并继续生成两场；分支产物写 <parent>/branches/<stage>/<choice>/branch.json。
//   禁止直接复制正在使用的 SQLite 文件或 WAL 文件。
// - 完整性校验失败时返回 status "incomplete" + missing（门禁据此非零退出）。
// ---------------------------------------------------------------------------

const tmpRoot = resolve("tmp", `story-eval-journey-${process.pid}-${Date.now()}`);
mkdirSync(tmpRoot, { recursive: true });
const openRepositories: SqliteGameRepository[] = [];

afterAll(async () => {
  vi.restoreAllMocks();
  for (const repository of openRepositories) await repository.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows 句柄延迟：下次运行用唯一路径。
  }
});

function openEvalRepository(dbPath: string): SqliteGameRepository {
  const repository = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(dbPath),
    logError: () => {},
  });
  openRepositories.push(repository);
  return repository;
}

/**
 * 受控 A/B：从既有 calls.jsonl 读取 scenario 的 parsedCandidate，固定开局蓝图，
 * 只比较后续 runtime narrative roles。该路径仅由 STORY_EVAL_CAPTURE=1 的评测进程
 * 注入，候选仍会经过 createGame 的既有 validate/compile，绝不绕过业务校验。
 */
function createCapturedBlueprintSource(env: Record<string, string | undefined>): ScenarioCandidateSource | undefined {
  const artifactPath = env.STORY_EVAL_BLUEPRINT_ARTIFACT;
  if (artifactPath === undefined || artifactPath.trim() === "") return undefined;
  let lines: readonly string[];
  try {
    lines = readFileSync(artifactPath, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "");
  } catch {
    throw new Error("captured blueprint artifact unreadable");
  }
  for (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.kind !== "ai_call" || record.role !== "scenario") continue;
    const candidate = record.parsedCandidate;
    if (!hasCapturedCandidateShape(candidate)) continue;
    return {
      async generate(): Promise<ScenarioCandidateAttempt> {
        return {
          ok: true,
          contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
          origin: "fixture",
          candidate: candidate as ScenarioBlueprintCandidate,
          diagnostics: ["STORY_EVAL_CAPTURED_BLUEPRINT"],
        };
      },
    };
  }
  throw new Error("captured blueprint candidate missing");
}

function hasCapturedCandidateShape(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  for (const field of ["locations", "npcs", "quests", "items", "enemies", "endings"] as const) {
    if (!Array.isArray(value[field])) return false;
  }
  for (const field of ["world", "player", "openingScene"] as const) {
    if (!isRecord(value[field])) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 按 sceneId 前缀 traceId 关联 calls.jsonl 中的 plan_approved 记录（spec §6.3）。 */
function directorPlanFor(sceneId: string, calls: readonly Readonly<Record<string, unknown>>[]): Readonly<Record<string, unknown>> | null {
  const record = calls.find((call) =>
    call.kind === "plan_approved" &&
    typeof call.traceId === "string" &&
    sceneId.startsWith(call.traceId),
  );
  return record !== undefined ? (record.planSummary as Readonly<Record<string, unknown>>) : null;
}

/** 主线阶段检查点（Task 13 Step 4 预设）：达到这些 stage 时成对分支。 */
const BRANCH_CHECKPOINT_STAGES = [2, 4, 6] as const;

/** AI 运行参数（与 live 源装配点一致：liveRuntimeNarrativeSources / liveScenarioCandidateSource）。 */
const AI_TEMPERATURE = 0.2;
const AI_TIMEOUT_MS = 300_000;
const MAX_AI_TIMEOUT_MS = 300_000;
type StoryEvalProfile = "smoke" | "regression" | "baseline";

const PROFILE_DEFAULTS: Readonly<Record<StoryEvalProfile, Readonly<{ maxRoleAttempts: number; timeoutMs: number; branchMode: "none" | "sample" | "full" }>>> = {
  smoke: { maxRoleAttempts: 1, timeoutMs: 300_000, branchMode: "none" },
  regression: { maxRoleAttempts: 3, timeoutMs: 300_000, branchMode: "sample" },
  baseline: { maxRoleAttempts: 3, timeoutMs: AI_TIMEOUT_MS, branchMode: "full" },
};

function resolveStoryEvalProfile(env: Record<string, string | undefined>): StoryEvalProfile {
  const value = env.STORY_EVAL_PROFILE;
  return value === "smoke" || value === "regression" || value === "baseline" ? value : "baseline";
}

function resolveStoryEvalBranchCheckpoints(env: Record<string, string | undefined>): readonly number[] {
  const mode = env.STORY_EVAL_BRANCH_MODE ?? PROFILE_DEFAULTS[resolveStoryEvalProfile(env)].branchMode;
  if (mode === "none") return [];
  if (mode === "sample") return [BRANCH_CHECKPOINT_STAGES[0]];
  return BRANCH_CHECKPOINT_STAGES;
}

function resolveStoryEvalMaxRoleAttempts(env: Record<string, string | undefined>): number {
  const defaults = PROFILE_DEFAULTS[resolveStoryEvalProfile(env)];
  const value = Number(env.STORY_EVAL_MAX_ROLE_ATTEMPTS ?? defaults.maxRoleAttempts);
  return Number.isInteger(value) && value >= 1 && value <= 3 ? value : 3;
}

function resolveStoryEvalRetryBackoffMs(env: Record<string, string | undefined>): number {
  const value = Number(env.STORY_EVAL_RETRY_BACKOFF_MS ?? "1000");
  return Number.isInteger(value) && value >= 0 && value <= 5_000 ? value : 1_000;
}

function resolveStoryEvalTimeoutMs(env: Record<string, string | undefined>): number {
  const defaults = PROFILE_DEFAULTS[resolveStoryEvalProfile(env)];
  const value = Number(env.STORY_EVAL_AI_TIMEOUT_MS ?? defaults.timeoutMs);
  return Number.isInteger(value) && value >= 1_000 && value <= MAX_AI_TIMEOUT_MS ? value : AI_TIMEOUT_MS;
}

/** 当前 git commit（manifest 可复现性；非 git 环境回退 null）。 */
function resolveGitCommit(): string | null {
  try {
    const output = execSync("git rev-parse HEAD", {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    const commit = output.trim();
    return commit === "" ? null : commit;
  } catch {
    return null;
  }
}

function storyEvalFingerprint(input: {
  caseId: string;
  strategy: "explore" | "objective";
  strategySeed: number;
  maxScenes: number;
  profile: StoryEvalProfile;
  branchMode: string;
  model: string | null;
  timeoutMs: number;
}): StoryEvalRunFingerprint {
  return {
    caseId: input.caseId,
    strategy: input.strategy,
    strategySeed: input.strategySeed,
    maxScenes: input.maxScenes,
    profile: input.profile,
    branchMode: input.branchMode,
    model: input.model,
    gitCommit: resolveGitCommit(),
    scenarioContractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
    narrativeContractVersion: NARRATIVE_CONTRACT_VERSION,
    timeoutMs: input.timeoutMs,
  };
}

/** 把事件账本条目映射为安全结构（只带稳定 ID，绝不带 AI 文案/原始响应）。 */
function toSafeEvent(event: GameEvent): { type: string; factId?: string; entityId?: string; questId?: string; endingId?: string } {
  switch (event.type) {
    case "fact_discovered":
      return { type: event.type, factId: String(event.factId) };
    case "npc_met":
      return { type: event.type, entityId: String(event.npcId) };
    case "item_obtained":
      return { type: event.type, entityId: String(event.itemId) };
    case "location_observed":
    case "location_visited":
    case "town_plan_generated":
      return { type: event.type, entityId: String(event.locationId) };
    case "battle_started":
    case "battle_round_resolved":
    case "battle_resolved":
    case "enemy_defeated":
      return { type: event.type, entityId: String(event.enemyId) };
    case "quest_completed":
    case "quest_unlocked":
    case "quest_failed":
      return { type: event.type, questId: String(event.questId) };
    case "ending_reached":
      return { type: event.type, endingId: String(event.endingId) };
    default:
      return { type: event.type };
  }
}

/** 由蓝图结构与最终规则结果生成 S4 answer key（manifest.answerKey；v2 spec §7）。 */
function buildStoryEvalAnswerKey(blueprint: GameRecord["blueprint"], endingOutcome: string | null): EarlyPredictionAnswerKey {
  const key: Record<string, { exactAliases: string[]; directionalAliases: string[] }> = {};
  for (const ending of blueprint.endings) {
    key[`ending:${ending.id}`] = { exactAliases: [String(ending.id), ending.name], directionalAliases: [] };
  }
  for (const enemy of blueprint.enemies) {
    key[`enemy:${enemy.id}`] = { exactAliases: [String(enemy.id), enemy.name], directionalAliases: [] };
  }
  for (const quest of blueprint.quests) {
    if (quest.kind === "main") {
      key[`main:${quest.stage}`] = { exactAliases: [String(quest.stage)], directionalAliases: [] };
    }
  }
  if (endingOutcome !== null) {
    key["ending:reached"] = { exactAliases: [endingOutcome], directionalAliases: [] };
  }
  return key;
}

/** 当前场景焦点 NPC 的档案快照（id/name/role/description/knownFactIds）。 */
function npcProfileOf(record: GameRecord, directorPlan: Readonly<Record<string, unknown>> | null) {
  const focusNpcId = typeof directorPlan?.focusNpcId === "string" ? directorPlan.focusNpcId : null;
  if (focusNpcId === null) return null;
  const npc = record.blueprint.npcs.find((entry) => String(entry.id) === String(focusNpcId));
  if (npc === undefined) return null;
  return {
    id: String(npc.id),
    name: npc.name,
    role: npc.role,
    description: (npc as Record<string, unknown>).description ?? null,
    isCompanion: npc.isCompanion,
    knownFactIds: npc.knownFactIds.map(String),
  };
}

/** 焦点 NPC 的关系摘要：tier/affinity + 最近接触摘要（文本形式）。 */
function relationshipSummaryOf(record: GameRecord, directorPlan: Readonly<Record<string, unknown>> | null): string | null {
  const focusNpcId = typeof directorPlan?.focusNpcId === "string" ? directorPlan.focusNpcId : null;
  if (focusNpcId === null) return null;
  const npcState = record.state.npcs.find((entry) => String(entry.npcId) === String(focusNpcId));
  if (npcState === undefined) return null;
  const affinity = npcState.relationship?.affinity ?? 0;
  const contact = storyMemoryOf(record.state).npcContacts.find((entry) => String(entry.npcId) === String(focusNpcId));
  return `tier=${relationshipTierOf({ affinity })} affinity=${affinity} last=${contact?.lastInteractionSummary ?? null}`;
}

// ---------------------------------------------------------------------------
// 分支状态快照与差异（Task 13 Step 4）：结构化、可序列化，只含稳定 ID 与状态。
// ---------------------------------------------------------------------------

type StateFacts = Readonly<{
  location: { current: string };
  facts: { discovered: readonly string[] };
  quests: { statuses: Readonly<Record<string, string>> };
  relationships: Readonly<Record<string, { met: boolean; affinity: number; tier: string }>>;
  items: { owned: readonly string[] };
  battle: { status: string };
  ending: { endingId: string; outcome: string } | null;
}>;

function captureStateFacts(state: GameState): StateFacts {
  return {
    location: { current: String(state.currentLocationId) },
    facts: { discovered: state.worldFacts.filter((entry) => entry.discovered).map((entry) => String(entry.factId)) },
    quests: { statuses: Object.fromEntries(state.quests.map((entry) => [String(entry.questId), entry.status])) },
    relationships: Object.fromEntries(state.npcs.map((entry) => {
      const affinity = entry.relationship?.affinity ?? 0;
      return [String(entry.npcId), { met: entry.met, affinity, tier: relationshipTierOf({ affinity }) }];
    })),
    items: { owned: state.inventory.map(String) },
    battle: { status: state.battle.status },
    ending: state.ending === null ? null : { endingId: String(state.ending.endingId), outcome: state.ending.outcome },
  };
}

function diffStateFacts(before: StateFacts, after: StateFacts) {
  return {
    location: { before: before.location.current, after: after.location.current },
    facts: {
      before: before.facts.discovered,
      after: after.facts.discovered,
      newlyDiscovered: after.facts.discovered.filter((id) => !before.facts.discovered.includes(id)),
    },
    quests: {
      before: before.quests.statuses,
      after: after.quests.statuses,
      changed: JSON.stringify(before.quests.statuses) !== JSON.stringify(after.quests.statuses),
    },
    relationships: {
      before: before.relationships,
      after: after.relationships,
      changed: JSON.stringify(before.relationships) !== JSON.stringify(after.relationships),
    },
    items: {
      before: before.items.owned,
      after: after.items.owned,
      gained: after.items.owned.filter((id) => !before.items.owned.includes(id)),
    },
    battle: { before: before.battle.status, after: after.battle.status },
    ending: { before: before.ending, after: after.ending },
  };
}

type StrategyPicker = (record: GameRecord, rand: () => number) => { index: number; reason: string };

function resolveSceneWaitMs(env: Record<string, string | undefined>): number {
  const raw = env.STORY_EVAL_SCENE_WAIT_MS;
  if (raw === undefined) return 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1_000 ? parsed : 60_000;
}

function resolveTotalBudgetMs(env: Record<string, string | undefined>): number {
  const raw = env.STORY_EVAL_TOTAL_BUDGET_MS;
  if (raw === undefined) return 90 * 60_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 90 * 60_000;
}

/** 分支继续生成两场：返回两场场景的玩家可读 narration。 */
async function runBranchScenes(
  forkEntry: ServerGameEntryPoints,
  forkRepo: SqliteGameRepository,
  picker: StrategyPicker,
  rand: () => number,
  env: Record<string, string | undefined>,
): Promise<{ narration: string[] }> {
  const narration: string[] = [];
  const refreshView = async (): Promise<GameSessionView> => {
    const current = await forkEntry.getCurrentGame();
    if (current.status !== "active") throw new Error("fork view unavailable");
    return current.view;
  };
  let view = await refreshView();
  for (let step = 0; step < 2; step += 1) {
    if (view.narrativeGeneration.status === "pending" || view.narrative === null) {
      if (view.narrativeGeneration.status === "pending") {
        await forkEntry.ensureNarrativeGeneration();
        const deadline = Date.now() + resolveSceneWaitMs(env);
        while (Date.now() < deadline) {
          view = await refreshView();
          if (view.narrativeGeneration.status !== "pending") break;
          await sleep(500);
        }
      }
      // 分支场景生成无法继续（动作耗尽/生成失败）：提前停止，产物仍有效。
      if (view.narrative === null && view.battle === null && view.ending === null) break;
    }
    if (view.ending !== null) break;
    if (view.battle !== null) {
      while (view.battle !== null) {
        const result = await forkEntry.performAction({
          intent: { type: "battle_action", action: "attack" },
          expectedRevision: view.revision,
        });
        if (!result.ok) throw new Error(`branch battle action rejected: ${result.code}`);
        view = result.view;
      }
      continue;
    }
    const loaded = await forkRepo.getCurrentGame();
    if (!loaded.ok || loaded.status !== "active") throw new Error("fork record unavailable");
    const scene = loaded.record.state.narrative.currentScene;
    if (scene === null) throw new Error("fork scene vanished");
    narration.push(scene.npcLine === null ? scene.narration : `${scene.narration}\n${scene.npcLine.text}`);
    const pick = picker(loaded.record, rand);
    const result = await forkEntry.performAction({
      intent: { type: "narrative_choice", choiceToken: scene.choices[pick.index]?.choiceToken ?? "" },
      expectedRevision: view.revision,
    });
    if (!result.ok) throw new Error(`branch scene rejected at ${step + 1}: ${result.code}`);
    view = result.view;
  }
  return { narration };
}

function sanitizePathPart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-");
}

/** 主线阶段检查点：同一 blueprint/state 分叉两个独立测试 SQLite 各走一个 choiceToken。 */
async function runCheckpointBranches(args: {
  env: Record<string, string | undefined>;
  dbPath: string;
  artifactDir: string;
  record: GameRecord;
  sceneIndex: number;
  stage: number;
  strategy: "explore" | "objective";
  rand: () => number;
}): Promise<void> {
  const { env, dbPath, artifactDir, sceneIndex, stage, strategy, rand } = args;
  // 读取完整记录并关闭该检查点的读连接（分支写库前不持有陈旧读句柄）。
  const checkpointRead = openEvalRepository(dbPath);
  let checkpointRecord: GameRecord;
  try {
    const loaded = await checkpointRead.getCurrentGame();
    if (!loaded.ok || loaded.status !== "active") throw new Error("checkpoint record unavailable");
    checkpointRecord = loaded.record;
  } finally {
    await checkpointRead.close();
  }
  const scene = checkpointRecord.state.narrative.currentScene;
  if (scene === null) throw new Error("checkpoint scene vanished");
  const choices = scene.choices;
  const stageDir = join(artifactDir, "branches", `stage${stage}`);
  if (choices.length < 2) {
    // 没有两个合法选项：记录 not_applicable，不伪造比较。
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(join(stageDir, "not_applicable.json"), JSON.stringify({
      checkpoint: stage,
      notApplicable: true,
      parentScene: { sceneIndex, sceneId: scene.sceneId, stage },
      actionKeys: choices.map((choice) => choice.actionKey),
      reason: "less_than_two_legal_choices",
    }, null, 2) + "\n", "utf8");
    return;
  }
  const picker: StrategyPicker = strategy === "objective" ? pickObjectiveChoice : pickNarrativeChoice;
  for (const choiceIndex of [0, 1] as const) {
    const choice = choices[choiceIndex];
    const branchDir = join(stageDir, sanitizePathPart(choice.actionKey));
    const forkDbPath = join(tmpRoot, `fork-${stage}-${choiceIndex}-${randomUUID().slice(0, 8)}.sqlite`);
    let forkEntry: ServerGameEntryPoints | null = null;
    let forkRepo: SqliteGameRepository | null = null;
    try {
      forkRepo = openEvalRepository(forkDbPath);
      const created = await forkRepo.createInitialGame({
        gameId: asGameId(`fork-${stage}-${choiceIndex}-${randomUUID()}`),
        blueprint: checkpointRecord.blueprint,
        state: checkpointRecord.state,
        createdAt: checkpointRecord.createdAt,
      });
      if (!created.ok) throw new Error(`fork createInitialGame failed: ${created.code}`);
      forkEntry = createServerGameEntryPoints({
        ...env,
        GAME_DB_PATH: forkDbPath,
        STORY_EVAL_ARTIFACT_DIR: branchDir,
      });
      const ledgerStart = checkpointRecord.state.eventLedger.length;
      // 执行当前 choiceToken（两个分支各执其一）。
      const current = await forkEntry.getCurrentGame();
      if (current.status !== "active") throw new Error("fork view unavailable");
      const view = current.view;
      const forced = await forkEntry.performAction({
        intent: { type: "narrative_choice", choiceToken: choice.choiceToken },
        expectedRevision: view.revision,
      });
      if (!forced.ok) throw new Error(`branch choice rejected: ${forced.code}`);
      const { narration } = await runBranchScenes(forkEntry, forkRepo, picker, rand, env);
      const finalLoaded = await forkRepo.getCurrentGame();
      if (!finalLoaded.ok || finalLoaded.status !== "active") throw new Error("fork final record unavailable");
      const eventsAfter = finalLoaded.record.state.eventLedger
        .slice(ledgerStart)
        .map((event) => toSafeEvent(event));
      const stateDiff = diffStateFacts(
        captureStateFacts(checkpointRecord.state),
        captureStateFacts(finalLoaded.record.state),
      );
      mkdirSync(branchDir, { recursive: true });
      writeFileSync(join(branchDir, "branch.json"), JSON.stringify({
        checkpoint: stage,
        parentScene: { sceneIndex, sceneId: scene.sceneId, stage },
        choiceActionKey: choice.actionKey,
        choiceLabel: choice.label,
        eventsAfter,
        stateDiff,
        narration,
      }, null, 2) + "\n", "utf8");
    } finally {
      await forkEntry?.close();
      await forkRepo?.close();
      try {
        rmSync(forkDbPath, { force: true });
      } catch {
        // Windows 句柄延迟：留待 tmpRoot 收尾清扫。
      }
    }
  }
}

export type StoryEvalJourneyConfig = Readonly<{
  env: Record<string, string | undefined>;
  dbPath: string;
  artifactDir: string;
  strategySeed: number;
  maxScenes: number;
  requireGeneratedOpening: boolean;
  caseId: string;
  strategy: "explore" | "objective";
  modelLabel?: string;
}>;

export type StoryEvalJourneyResult = Readonly<{
  status: "converged" | "max_scenes" | "aborted" | "exhausted" | "generation_failed" | "recovery_loop" | "time_budget" | "incomplete";
  sceneCount: number;
  fallbackScenes: number;
  openingSource: string;
  endingOutcome: string | null;
  completeness: StoryEvalCompleteness;
}>;

export async function runStoryEvalJourney(config: StoryEvalJourneyConfig): Promise<StoryEvalJourneyResult> {
  const { env, dbPath, artifactDir, strategySeed, maxScenes, requireGeneratedOpening, caseId, strategy } = config;
  const profile = resolveStoryEvalProfile(env);
  const branchMode = env.STORY_EVAL_BRANCH_MODE ?? PROFILE_DEFAULTS[profile].branchMode;
  const resumeRequested = env.STORY_EVAL_RESUME === "1";
  const checkpointPaths = storyEvalCheckpointPaths(artifactDir);
  const fingerprint = storyEvalFingerprint({
    caseId,
    strategy,
    strategySeed,
    maxScenes,
    profile,
    branchMode,
    model: config.modelLabel ?? env.AI_MODEL ?? null,
    timeoutMs: resolveStoryEvalTimeoutMs(env),
  });
  const savedProgress = resumeRequested ? readStoryEvalProgress(checkpointPaths.progress) : null;
  if (resumeRequested && savedProgress === null) {
    throw new Error(`story-eval resume checkpoint missing or invalid: ${checkpointPaths.progress}`);
  }
  if (savedProgress !== null) assertResumableFingerprint(fingerprint, savedProgress.fingerprint);
  const branchCheckpointStages = resolveStoryEvalBranchCheckpoints(env);
  const journeyStartedAt = Date.now();
  const timingStartedAt = performance.now();
  const timings = {
    startedAt: new Date(journeyStartedAt).toISOString(),
    openingMs: 0,
    narrativeWaitMs: 0,
    branchMs: 0,
    playerActionMs: 0,
    finalizationMs: 0,
    totalMs: 0,
    finishedAt: null as string | null,
  };
  const totalBudgetMs = resolveTotalBudgetMs(env);
  const rand = mulberry32(hashStringToSeed(String(strategySeed)));
  // v2：按 case 构造输入（v2.json 数据事实源）；未知 caseId 直接失败（门禁保证合法）。
  const storyEvalCase = loadStoryEvalCases().find((item) => item.caseId === caseId);
  if (storyEvalCase === undefined) throw new Error(`unknown story eval case: ${caseId}`);
  const input = storyEvalCase.input;
  let entry: ServerGameEntryPoints | null = null;
  let evalRepository: SqliteGameRepository | null = null;
  const storyRows: StoryEvalStoryRow[] = resumeRequested ? [...readStoryEvalPartialRows(checkpointPaths.partialStory)] : [];
  let status: StoryEvalJourneyResult["status"] = "max_scenes";
  let openingSource = savedProgress?.openingSource ?? "unknown";
  let endingOutcome: string | null = savedProgress?.endingOutcome ?? null;
  let fallbackScenes = savedProgress?.fallbackScenes ?? 0;
  let sceneCount = savedProgress?.sceneCount ?? storyRows.filter((row) => row.kind === "scene").length;
  const branchCheckpointsDone = new Set<number>(savedProgress?.branchCheckpointsDone ?? []);
  const continuationBridges: Readonly<Record<string, unknown>>[] = [...(savedProgress?.continuationBridges ?? [])];
  let trueDeadEnds = 0;
  let recoveryLoops = 0;
  let previousLedgerLength = savedProgress?.previousLedgerLength ?? 0;
  let pendingScene: StoryEvalPendingScene | null = savedProgress?.pendingScene ?? null;
  let nextSceneIndex = savedProgress?.nextSceneIndex ?? 1;
  let manifest: Record<string, unknown> | null = null;
  let checkpointLastError: { sceneIndex: number; message: string } | null = savedProgress?.lastError ?? null;
  const saveCheckpoint = (checkpointStatus: StoryEvalProgress["status"] = "running") => {
    const progress: StoryEvalProgress = {
      checkpointVersion: 1,
      status: checkpointStatus,
      fingerprint,
      nextSceneIndex,
      sceneCount,
      fallbackScenes,
      openingSource,
      endingOutcome,
      previousLedgerLength,
      branchCheckpointsDone: [...branchCheckpointsDone].sort((left, right) => left - right),
      continuationBridges,
      pendingScene,
      lastError: checkpointLastError,
      updatedAt: new Date().toISOString(),
    };
    writeStoryEvalPartialRowsAtomic(checkpointPaths.partialStory, storyRows);
    writeStoryEvalProgressAtomic(checkpointPaths.progress, progress);
  };

  try {
    const capturedBlueprintSource = createCapturedBlueprintSource(env);
    entry = createServerGameEntryPoints(
      { ...env, GAME_DB_PATH: dbPath },
      { scenarioCandidateSourceOverride: capturedBlueprintSource },
    );
    evalRepository = openEvalRepository(dbPath);

    const loadRecord = async () => {
      const loaded = await evalRepository!.getCurrentGame();
      if (!loaded.ok || loaded.status !== "active") throw new Error("eval repository record unavailable");
      return loaded.record;
    };
    const getView = async (): Promise<GameSessionView> => {
      const current = await entry!.getCurrentGame();
      if (current.status !== "active") throw new Error("journey view unavailable");
      return current.view;
    };

    let view: GameSessionView;
    if (resumeRequested) {
      const resumed = await entry.getCurrentGame();
      if (resumed.status !== "active") throw new Error("resume game record unavailable");
      view = resumed.view;
      if (existsSync(join(artifactDir, "manifest.json"))) {
        try {
          const existingManifest: unknown = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8"));
          if (isRecord(existingManifest)) manifest = existingManifest;
        } catch {
          throw new Error("resume manifest is invalid");
        }
      }
    } else {
      const openingStartedAt = performance.now();
      const created = await entry.createGame(input);
      timings.openingMs = performance.now() - openingStartedAt;
      if (!created.ok) throw new Error(`createGame failed: ${created.code}`);
      // requireGeneratedOpening：真实模式要求开局由 AI 生成（离线 fetch-mock 走
      // fallback 开局可接受）；不满足直接失败，避免把非生成开局误记成生成。
      if (requireGeneratedOpening && created.source !== "generated") {
        throw new Error(`opening was not AI-generated: ${created.source}`);
      }
      openingSource = created.source;
      view = await getView();
      previousLedgerLength = (await loadRecord()).state.eventLedger.length;
    }

    if (manifest === null) {
      manifest = {
        gameId: null,
        worldSeed: null,
        strategySeed,
        gameLength: "long",
        model: config.modelLabel ?? null,
        status,
        sceneCount: 0,
        fallbackScenes: 0,
        maxScenes,
        blueprint: null,
        // Task 13（v2）扩展字段：caseId/strategy、gitCommit、contractVersion、
        // 四角色 prompt 版本、temperature、timeoutMs、answerKey（S4 确定性评分所需，
        // 由蓝图结局/敌人/任务结构与最终规则结果生成）。
        caseId,
        strategy,
        gameType: storyEvalCase.input.gameType,
        pairingVersion: env.STORY_EVAL_PAIR_ID === undefined ? null : "paired-v1",
        pairId: env.STORY_EVAL_PAIR_ID ?? null,
        profile,
        branchMode,
        blueprintSource: capturedBlueprintSource === undefined ? "live" : "captured_artifact",
        blueprintPairSource: capturedBlueprintSource === undefined ? "live" : "paired_capture",
        gitCommit: resolveGitCommit(),
        contractVersion: NARRATIVE_CONTRACT_VERSION,
        promptVersions: {
          scenario: SCENARIO_CANDIDATE_CONTRACT_VERSION,
          director: NARRATIVE_CONTRACT_VERSION,
          writer: NARRATIVE_CONTRACT_VERSION,
          npc: NARRATIVE_CONTRACT_VERSION,
        },
        temperature: AI_TEMPERATURE,
        thinkingRoles: resolveAiThinkingRoles(env),
        timeoutMs: resolveStoryEvalTimeoutMs(env),
        maxRoleAttempts: resolveStoryEvalMaxRoleAttempts(env),
        retryBackoffMs: resolveStoryEvalRetryBackoffMs(env),
        answerKey: null,
        continuationBridges,
        trueDeadEnds,
        recoveryLoops,
        timings,
        resumeFingerprint: fingerprint,
      };
    }

    if (!resumeRequested) saveCheckpoint();
    const getCalls = createCachedCallsReader(artifactDir);
    const upsertStoryRow = (row: StoryEvalStoryRow): void => {
      const key = row.kind === "scene" ? row.sceneId ?? String(row.sceneIndex) : `ending:${row.sceneIndex}`;
      const existingIndex = storyRows.findIndex((entry) => (entry.kind === "scene" ? entry.sceneId ?? String(entry.sceneIndex) : `ending:${entry.sceneIndex}`) === key);
      if (existingIndex < 0) storyRows.push(row);
      else storyRows[existingIndex] = row;
      storyRows.sort((left, right) => left.sceneIndex - right.sceneIndex);
    };

    // 若进程在规则 action 已提交、但 partial row 尚未落盘的窗口退出，
    // 先用保存的 ledger 长度补齐这一幕，再从下一幕继续。
    if (pendingScene?.actionCommitted === true) {
      const resumedRecord = await loadRecord();
      const completedRow = {
        ...pendingScene.row,
        actionEvents: resumedRecord.state.eventLedger
          .slice(pendingScene.ledgerLengthBeforeAction)
          .map((event) => toSafeEvent(event)),
      } satisfies StoryEvalStoryRow;
      upsertStoryRow(completedRow);
      previousLedgerLength = resumedRecord.state.eventLedger.length;
      sceneCount = Math.max(sceneCount, pendingScene.row.sceneIndex);
      if (completedRow.fallback === true) fallbackScenes += 1;
      nextSceneIndex = pendingScene.row.sceneIndex + 1;
      pendingScene = null;
      saveCheckpoint();
    }

    for (let sceneIndex = nextSceneIndex; sceneIndex <= maxScenes; sceneIndex += 1) {
      nextSceneIndex = sceneIndex;
      if (Date.now() - journeyStartedAt >= totalBudgetMs) {
        status = "time_budget";
        break;
      }
      // 1. pending 时确保生成并轮询到场景/战斗/结局就绪（带超时）；
      //    生成任务结束仍无场景（规则动作耗尽或生成失败）→ 停止旅程。
      if (view.narrativeGeneration.status === "pending" || view.narrative === null) {
        if (view.narrativeGeneration.status === "pending") {
          const waitStartedAt = performance.now();
          try {
            await entry.ensureNarrativeGeneration();
            const deadline = Date.now() + resolveSceneWaitMs(env);
            while (Date.now() < deadline) {
              view = await getView();
              if (view.narrativeGeneration.status !== "pending") break;
              await sleep(500);
            }
          } finally {
            timings.narrativeWaitMs += performance.now() - waitStartedAt;
          }
        }
        if (view.narrative === null && view.battle === null && view.ending === null) {
          const terminalRecord = await loadRecord();
          const continuation = projectStoryEvalContinuation(terminalRecord.blueprint, terminalRecord.state);
          if (continuation !== null) {
            if (continuationBridges.length >= maxScenes * 2) {
              recoveryLoops += 1;
              status = "recovery_loop";
              break;
            }
            const before = terminalRecord.state.eventLedger.length;
            const result = await entry.performAction({
              intent: continuation.intent,
              expectedRevision: view.revision,
            });
            if (!result.ok) throw new Error(`continuation action rejected: ${result.code}`);
            const afterRecord = await loadRecord();
            continuationBridges.push({
              actionKey: continuation.actionKey,
              label: continuation.label,
              reason: continuation.reason,
              mainStage: deriveContentProgression({ blueprint: afterRecord.blueprint, state: afterRecord.state }).mainStage,
              events: afterRecord.state.eventLedger.slice(before).map((event) => toSafeEvent(event)),
            });
            view = result.view;
            // 规则续行不占叙事场景预算；下一轮继续等待/记录同一 sceneIndex。
            sceneIndex -= 1;
            continue;
          }
          if (canQueueRuntimeNarrativeScene(terminalRecord.blueprint, terminalRecord.state)) {
            status = "generation_failed";
          } else {
            trueDeadEnds += 1;
            status = "exhausted";
          }
          break;
        }
      }
      // 2. 结局：收尾记录。
      if (view.ending !== null) {
        endingOutcome = view.ending.outcome;
        status = "converged";
        const record = await loadRecord();
        const tailEvents = record.state.eventLedger.slice(previousLedgerLength).map((event) => toSafeEvent(event));
        upsertStoryRow({
          kind: "ending",
          sceneIndex,
          endingId: String(record.state.ending?.endingId ?? ""),
          endingName: view.ending.name,
          endingDescription: view.ending.description,
          outcome: endingOutcome,
          newEvents: tailEvents,
        });
        previousLedgerLength = record.state.eventLedger.length;
        nextSceneIndex = sceneIndex + 1;
        saveCheckpoint("completed");
        break;
      }
      // 3. 战斗：attack 优先打完（battle_action 为独立 intent，不占场景序号）。
      if (view.battle !== null) {
        while (view.battle !== null) {
          const result = await entry.performAction({
            intent: { type: "battle_action", action: "attack" },
            expectedRevision: view.revision,
          });
          if (!result.ok) throw new Error(`battle action rejected: ${result.code}`);
          view = result.view;
        }
        // 战斗动作不占叙事场景预算；若战斗在最后一幕启动，回到同一
        // sceneIndex 检查 ending，避免把已经完成的结局误报为 max_scenes。
        sceneIndex -= 1;
        continue;
      }
      // 4. 场景就绪：记录 story 行。
      const record = await loadRecord();
      const scene = record.state.narrative.currentScene;
      if (scene === null) throw new Error("scene vanished before record");
      const stage = deriveContentProgression({ blueprint: record.blueprint, state: record.state }).mainStage;
      const activeMainObjective = toDirectorContext({ blueprint: record.blueprint, state: record.state }).activeMainObjective;
      const calls = getCalls();
      const directorPlan = directorPlanFor(scene.sceneId, calls);
      const resumedPending = pendingScene?.row.sceneId === scene.sceneId ? pendingScene : null;
      const choice = resumedPending === null
        ? pickerFor(strategy)(record, rand)
        : { index: resumedPending.choiceIndex, reason: "resume_pending_choice" };
      const newEvents = record.state.eventLedger
        .slice(previousLedgerLength)
        .map((event) => toSafeEvent(event));
      const storyRow: StoryEvalStoryRow = resumedPending?.row ?? {
        kind: "scene",
        sceneIndex,
        sceneId: scene.sceneId,
        mainStage: stage,
        narration: scene.narration,
        npcLine: scene.npcLine === null ? null : { text: scene.npcLine.text, emotion: scene.npcLine.emotion },
        usedFactIds: scene.usedFactIds.map(String),
        npcUsedFactIds: scene.npcLine === null ? [] : scene.npcLine.usedFactIds.map(String),
        choices: scene.choices.map((entry) => ({ label: entry.label, actionKey: entry.actionKey })),
        directorPlan,
        activeMainObjective,
        memorySummary: storyMemoryOf(record.state).recent,
        npcProfile: npcProfileOf(record, directorPlan),
        relationshipSummary: relationshipSummaryOf(record, directorPlan),
        fallback: scene.source === "fallback",
        playerChoice: { index: choice.index, actionKey: scene.choices[choice.index]?.actionKey ?? "", reason: choice.reason },
        newEvents,
      };
      pendingScene = resumedPending ?? {
        row: storyRow,
        ledgerLengthBeforeAction: previousLedgerLength,
        choiceToken: scene.choices[choice.index]?.choiceToken ?? "",
        choiceIndex: choice.index,
      };
      saveCheckpoint();
      // 4b. 主线阶段检查点：stage ∈ {2,4,6} 且未在该 stage 分支过 → 成对分支。
      if (
        stage !== null &&
        branchCheckpointStages.includes(stage) &&
        !branchCheckpointsDone.has(stage)
      ) {
        const branchStartedAt = performance.now();
        try {
          const stageDir = join(artifactDir, "branches", `stage${stage}`);
          const branchComplete = existsSync(join(stageDir, "not_applicable.json")) || (
            existsSync(stageDir) && readdirSync(stageDir, { withFileTypes: true }).some((entry) => entry.isDirectory() && existsSync(join(stageDir, entry.name, "branch.json")))
          );
          if (!branchComplete) {
          await runCheckpointBranches({
            env,
            dbPath,
            artifactDir,
            record,
            sceneIndex,
            stage,
            strategy,
            rand,
          });
          }
          branchCheckpointsDone.add(stage);
          saveCheckpoint();
        } finally {
          timings.branchMs += performance.now() - branchStartedAt;
        }
      }
// 5. 执行选择。
      const actionStartedAt = performance.now();
      const result = await entry.performAction({
          intent: { type: "narrative_choice", choiceToken: pendingScene.choiceToken },
          expectedRevision: view.revision,
        });
      timings.playerActionMs += performance.now() - actionStartedAt;
      if (!result.ok) throw new Error(`narrative choice rejected at ${sceneIndex}: ${result.code}`);
      const actionRecord = await loadRecord();
      const actionEvents = actionRecord.state.eventLedger
        .slice(pendingScene.ledgerLengthBeforeAction)
        .map((event) => toSafeEvent(event));
      pendingScene = { ...pendingScene, actionCommitted: true };
      saveCheckpoint();
      upsertStoryRow({ ...pendingScene.row, actionEvents });
      previousLedgerLength = actionRecord.state.eventLedger.length;
      sceneCount += 1;
      if (scene.source === "fallback") fallbackScenes += 1;
      pendingScene = null;
      view = result.view;
      // narrative choice 可能刚刚启动战斗；战斗本身不占叙事幕预算，
      // 让下一轮在同一 sceneIndex 消化 battle/ending，避免最后一幕误报 max_scenes。
      if (view.battle !== null) {
        nextSceneIndex = sceneIndex;
        saveCheckpoint();
        sceneIndex -= 1;
      } else {
        nextSceneIndex = sceneIndex + 1;
        saveCheckpoint();
      }
      if (fallbackScenes > sceneCount / 2) {
        status = "aborted";
        saveCheckpoint("failed");
        break;
      }
    }

    // 6. 收尾产物：manifest.json 与 story.jsonl。
    const finalizationStartedAt = performance.now();
    const finalRecord = await loadRecord();
    const blueprint = finalRecord.blueprint;
    manifest.gameId = String(finalRecord.gameId);
    manifest.worldSeed = blueprint.seed;
    manifest.status = status;
    manifest.sceneCount = sceneCount;
    manifest.fallbackScenes = fallbackScenes;
    manifest.trueDeadEnds = trueDeadEnds;
    manifest.recoveryLoops = recoveryLoops;
    manifest.answerKey = buildStoryEvalAnswerKey(blueprint, endingOutcome);
    manifest.blueprint = {
      // 世界名称不在蓝图结构内（domain WorldDefinition 无 name），取会话视图
      // 投影的世界显示名（profile label），保证 manifest 蓝图快照可读。
      world: { name: view.world.name, summary: blueprint.world.summary, tone: blueprint.world.tone, themes: blueprint.world.themes },
      facts: blueprint.world.facts.map((fact) => ({
        id: String(fact.id),
        text: fact.text,
        source: fact.source,
      })),
      locations: blueprint.locations.map((location) => ({
        id: String(location.id),
        name: location.name,
        description: location.description,
        kind: location.kind,
        connectedLocationIds: location.connectedLocationIds.map(String),
        npcIds: location.npcIds.map(String),
        availableItemIds: location.availableItemIds.map(String),
        scale: location.scale ?? "scene",
      })),
      npcs: blueprint.npcs.map((npc) => ({
        id: String(npc.id),
        name: npc.name,
        role: npc.role,
        description: (npc as Record<string, unknown>).description ?? null,
        isCompanion: npc.isCompanion,
        knownFactIds: npc.knownFactIds.map(String),
      })),
      items: blueprint.items.map((item) => ({
        id: String(item.id),
        name: item.name,
        description: item.description,
        kind: item.kind,
        category: item.category ?? null,
        rarity: item.rarity ?? null,
      })),
      enemies: blueprint.enemies.map((enemy) => ({
        id: String(enemy.id),
        name: enemy.name,
        tier: enemy.tier,
        locationId: String(enemy.locationId),
      })),
      quests: blueprint.quests.map((quest) => ({
        id: String(quest.id),
        name: quest.name,
        kind: quest.kind,
        stage: quest.kind === "main" ? quest.stage : null,
        description: quest.description,
        objectives: quest.objectives,
        onSuccess: quest.onSuccess,
        onFailure: quest.onFailure,
      })),
      endings: blueprint.endings.map((ending) => ({
        id: String(ending.id),
        name: ending.name,
        description: ending.description,
      })),
    };
    timings.finalizationMs = performance.now() - finalizationStartedAt;
    timings.totalMs = performance.now() - timingStartedAt;
    timings.finishedAt = new Date().toISOString();
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "story.jsonl"), storyRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    // 7. 产物完整性（spec §7）：incomplete 不可进入分析/评审，门禁非零退出。
    const completeness = validateStoryEvalArtifacts({ calls: getCalls(), story: storyRows, manifest });
    if (!completeness.complete) status = "incomplete";
    saveCheckpoint(status === "incomplete" ? "failed" : "completed");
    return {
      status,
      sceneCount,
      fallbackScenes,
      openingSource,
      endingOutcome,
      completeness,
    };
  } catch (error) {
    checkpointLastError = {
      sceneIndex: nextSceneIndex,
      message: error instanceof Error ? error.message : String(error),
    };
    try {
      saveCheckpoint("failed");
    } catch {
      // 保留原始 journey 错误；checkpoint 写入失败不能掩盖 provider/规则错误。
    }
    throw error;
  } finally {
    await entry?.close();
  }
}

/** 策略选择器：explore 保持原探索优先语义；objective 优先推进主线/任务目标动作。 */
function pickerFor(strategy: "explore" | "objective"): StrategyPicker {
  return strategy === "objective" ? pickObjectiveChoice : pickNarrativeChoice;
}

/** 创建带缓存的 calls 读取器：避免每次循环全量重读 calls.jsonl（O(n²) 退化）。
 *  首次调用全量读取，后续只追加读取新增行。 */
function createCachedCallsReader(artifactDir: string): () => readonly Readonly<Record<string, unknown>>[] {
  let cached: Readonly<Record<string, unknown>>[] = [];
  let lastLength = 0;
  return () => {
    try {
      const current = readFileSync(join(artifactDir, "calls.jsonl"), "utf8");
      const lines = current.trim().split("\n").filter((line) => line !== "");
      if (lines.length <= lastLength && cached.length > 0) return cached;
      // 只解析新增行，追加到缓存。
      for (let index = lastLength; index < lines.length; index += 1) {
        cached = [...cached, JSON.parse(lines[index]) as Readonly<Record<string, unknown>>];
      }
      lastLength = lines.length;
      return cached;
    } catch {
      return cached.length > 0 ? cached : [];
    }
  };
}

/** 假 transport 响应生成器：按 system prompt 首词区分四角色，返回合法 JSON。 */
export function createFakeAiFetch() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages?: { role: string; content: string }[];
    };
    const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
    let content: string;
    if (system.startsWith("You are the world director")) {
      const context = JSON.parse(user) as {
        actionCandidates?: { actionKey: string }[];
        progression?: { allowedPacing?: string[]; mainStage?: number };
      };
      const candidates = context.actionCandidates ?? [];
      // 离线导演确定性策略（镜像真实导演"推进当前目标"的意图）：
      // 按主线阶段优先 objective 相关候选——第 1 幕先移动解锁主线，事实幕
      // 优先调查，其余优先 take_item/未接触 NPC 的 talk，最后 move。
      // 注：Phase 14 离线 createGame 只走 fallback 单段起始锚点（mainStage ≤ 1），
      // 多幕阶段分支偏好保留以兼容未来注入多幕蓝图的旅程。
      const mainStage = context.progression?.mainStage ?? null;
      const preference: ((candidate: { actionKey: string }) => boolean)[] = mainStage === 1
        ? [
          (candidate) => candidate.actionKey.startsWith("move:"),
          (candidate) => candidate.actionKey.startsWith("talk:"),
        ]
        : mainStage === 3 || mainStage === 7
          ? [
            (candidate) => candidate.actionKey.startsWith("investigate:"),
            (candidate) => candidate.actionKey.startsWith("take_item:"),
            (candidate) => candidate.actionKey.startsWith("talk:"),
          ]
          : [
            (candidate) => candidate.actionKey.startsWith("take_item:"),
            (candidate) => candidate.actionKey.startsWith("talk:"),
            (candidate) => candidate.actionKey.startsWith("move:"),
          ];
      const first = preference
        .map((pick) => candidates.find(pick))
        .find((candidate) => candidate !== undefined)?.actionKey
        ?? candidates[0]?.actionKey
        ?? "observe:loc_1";
      // 防重复 key：approveDirectorProposal 对 keyA === keyB 直接 choice_not_legal，
      // 必须从候选里挑一个与 first 不同的 key；候选不足时退回 first（触发审批驳回→
      // 重试→fallback，与生产行为一致；离线旅程构造保证候选 ≥ 2）。
      const second = candidates.find((candidate) => candidate.actionKey !== first)?.actionKey ?? first;
      const pacing = context.progression?.allowedPacing?.at(-1) ?? "setup";
      content = JSON.stringify({
        sceneGoal: "推进当前可行动作",
        tensionLevel: 3,
        focusNpcId: null,
        relevantFactIds: [],
        allowedRevealFactIds: [],
        suggestedActionKeys: [first, second],
        introducedEntities: [],
        pacing,
        proposedNewLocations: [],
        proposedNewNpcs: [],
      });
    } else if (system.startsWith("You are the scene writer")) {
      const context = JSON.parse(user) as { plan?: { suggestedActionKeys?: string[] } };
      const keys = context.plan?.suggestedActionKeys ?? ["observe:loc_1", "observe:loc_2"];
      content = JSON.stringify({
        narration: "你继续前行，眼前的景象与线索逐渐清晰，新的选择摆在面前。",
        usedFactIds: [],
        npcInstruction: null,
        choices: [
          { actionKey: keys[0], label: "继续前行", strategy: "推进当前目标" },
          { actionKey: keys[1], label: "谨慎观察", strategy: "暂缓当前目标" },
        ],
      });
    } else if (system.startsWith("You are one NPC performer")) {
      content = JSON.stringify({ text: "这条路通向你想找的地方。", usedFactIds: [], emotion: "warm" });
    } else {
      // 开局蓝图生成（scenario）：返回明显不合法的 JSON（非对象结构），编译阶段
      // 必然失败 → 走 fallback 开局（离线模式接受；真实模式要求 generated）。
      // 注意：不能返回空对象 {} 等"结构合法但内容为空"的候选，因为编译阶段
      // 可能接受空对象作为合法蓝图，导致离线测试开局不走 fallback。
      content = '{"invalid":true,"_note":"deliberately invalid for offline testing"}';
      // 这条注释提醒：如果编译阶段未来对 `{invalid: true}` 也放行，需同步更新此 mock。
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** 带驳回恢复的假 transport：首次调用返回非法候选触发审批驳回，第二次恢复合法。
 *  用于验证审批驳回→重试→fallback 的事件序列是否正确写入 calls.jsonl。 */
export function createFakeAiFetchWithRejection() {
  // 按 traceId 跟踪调用次数，首次返回非法、后续恢复合法。
  const callCount = new Map<string, number>();
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages?: { role: string; content: string }[];
    };
    const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
    // 按 system prompt 前缀区分角色计数（user 上下文不含 traceId，无法按场景级
    // id 计数；按角色计数保证"首次导演调用被驳回、重试恢复"）。
    const roleKey = system.startsWith("You are the world director")
      ? "director"
      : system.startsWith("You are the scene writer")
        ? "writer"
        : system.startsWith("You are one NPC performer")
          ? "npc"
          : "scenario";
    const count = callCount.get(roleKey) ?? 0;
    callCount.set(roleKey, count + 1);
    let content: string;
    if (system.startsWith("You are the world director") && count === 0) {
      // 首次调用：返回修复层无法代修的非 schema 字段（tensionLevel 越界）触发
      // 审批驳回——非法 actionKey 会被 repairRuntimeNarrativeReferences 换成候选
      // 合法 key，无法触发驳回；tensionLevel 原样透传审批，必然 schema_violation。
      content = JSON.stringify({
        sceneGoal: "推进",
        tensionLevel: 9, focusNpcId: null,
        relevantFactIds: [], allowedRevealFactIds: [],
        suggestedActionKeys: ["move:invalid_1", "move:invalid_2"],
        introducedEntities: [], pacing: "setup",
        proposedNewLocations: [], proposedNewNpcs: [],
      });
    } else if (system.startsWith("You are the world director")) {
      // 恢复调用：返回合法候选。
      const context = JSON.parse(user) as { actionCandidates?: { actionKey: string }[] };
      const candidates = context.actionCandidates ?? [];
      const first = candidates[0]?.actionKey ?? "observe:loc_1";
      const second = candidates.find((candidate) => candidate.actionKey !== first)?.actionKey ?? first;
      content = JSON.stringify({
        sceneGoal: "推进", tensionLevel: 3, focusNpcId: null,
        relevantFactIds: [], allowedRevealFactIds: [],
        suggestedActionKeys: [first, second],
        introducedEntities: [], pacing: "setup",
        proposedNewLocations: [], proposedNewNpcs: [],
      });
    } else if (system.startsWith("You are the scene writer")) {
      const context = JSON.parse(user) as { plan?: { suggestedActionKeys?: string[] } };
      const keys = context.plan?.suggestedActionKeys ?? ["observe:loc_1", "observe:loc_2"];
      content = JSON.stringify({
        narration: "继续前行。", usedFactIds: [], npcInstruction: null,
        choices: [
          { actionKey: keys[0], label: "前行", strategy: "s" },
          { actionKey: keys[1], label: "观察", strategy: "t" },
        ],
      });
    } else if (system.startsWith("You are one NPC performer")) {
      content = JSON.stringify({ text: "台词。", usedFactIds: [], emotion: "warm" });
    } else {
      content = '{"invalid":true}';
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("Story eval journey (offline)", () => {
  it("fetch-mock 全链路跑通：采集/故事流水/manifest 产物完整，零网络", async () => {
    const fetchSpy = createFakeAiFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    const artifactDir = join(tmpRoot, "offline-run");
    const dbPath = join(tmpRoot, "offline.sqlite");
    let result: Awaited<ReturnType<typeof runStoryEvalJourney>>;
    try {
      result = await runStoryEvalJourney({
        env: {
          AI_API_BASE_URL: "http://127.0.0.1:9/v1",
          AI_MODEL: "fake-model",
          AI_API_KEY: "fake-key",
          STORY_EVAL_CAPTURE: "1",
          STORY_EVAL_ARTIFACT_DIR: artifactDir,
        },
        dbPath,
        artifactDir,
        strategySeed: 7,
        caseId: "wuxia-a",
        strategy: "explore",
        maxScenes: 3,
        requireGeneratedOpening: false,
        modelLabel: "fake-model",
      });
      expect(result.status).toBe("max_scenes");
      expect(result.sceneCount).toBe(3);
      expect(result.openingSource).toBe("fallback");
      expect(result.completeness.complete).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }

    // calls.jsonl：source 捕获 + 审批记录齐全。
    const callLines = readFileSync(join(artifactDir, "calls.jsonl"), "utf8").trim().split("\n");
    expect(callLines.length).toBeGreaterThan(0);
    const roles = callLines.map((line) => JSON.parse(line).role).filter((role) => role !== undefined);
    expect(roles).toContain("director");
    expect(roles).toContain("writer");
    const kinds = callLines.map((line) => JSON.parse(line).kind);
    expect(kinds).toContain("plan_approved");
    expect(kinds).toContain("role_approval");

    // story.jsonl：场景行结构完整，导演计划摘要已关联；行携带 v2 证据字段。
    const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
    expect(storyLines).toHaveLength(3);
    for (const line of storyLines) {
      const row = JSON.parse(line) as StoryEvalStoryRow;
      expect(row.kind).toBe("scene");
      expect(row.narration).toBeTruthy();
      // Phase 14：fallback 开局是单段起始锚点（fallback-8，仅 quest_main_1 stage 1）；
      // 任务 talk 完成后进入 resolution 态，mainStage 合法为 null（无 active 主线）。
      expect(row.mainStage === null || Number(row.mainStage) >= 1).toBe(true);
      expect(row.choices).toHaveLength(2);
      expect(row.directorPlan).toMatchObject({ pacing: expect.any(String), tensionLevel: 3 });
      expect(row.playerChoice).toMatchObject({ index: expect.any(Number), reason: expect.any(String) });
      expect(String(row.playerChoice?.reason ?? "")).not.toBe("");
      expect(Array.isArray(row.newEvents)).toBe(true);
      expect(Array.isArray(row.actionEvents)).toBe(true);
      // v2 证据字段：memory 摘要总是数组；NPC 场景才要求 profile/关系摘要。
      expect(Array.isArray(row.memorySummary)).toBe(true);
      if (row.npcLine !== null && row.npcLine !== undefined) {
        expect(row.npcProfile).not.toBeNull();
        expect(typeof row.relationshipSummary).toBe("string");
      }
      // 安全事件：只允许 { type, factId?, entityId?, questId?, endingId? } 字段，
      // 绝不携带 AI 文案、原始响应或 prompt 内容。
      for (const event of row.newEvents ?? []) {
        expect(typeof event.type).toBe("string");
        for (const key of Object.keys(event)) {
          expect(["type", "factId", "entityId", "questId", "endingId"]).toContain(key);
        }
      }
      for (const event of row.actionEvents ?? []) {
        expect(typeof event.type).toBe("string");
        for (const key of Object.keys(event)) {
          expect(["type", "factId", "entityId", "questId", "endingId"]).toContain(key);
        }
      }
    }

    // manifest.json：v2 元数据齐全（caseId/strategy/版本/AI 配置/answerKey）。
    const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.gameId).toBeTruthy();
    expect(manifest.worldSeed).toBeTruthy();
    expect(manifest.status).toBe("max_scenes");
    expect(manifest.sceneCount).toBe(3);
    expect(manifest.caseId).toBe("wuxia-a");
    expect(manifest.strategy).toBe("explore");
    expect(manifest.profile).toBe("baseline");
    expect(manifest.branchMode).toBe("full");
    expect(manifest.maxScenes).toBe(3);
    expect(manifest.contractVersion).toBe(NARRATIVE_CONTRACT_VERSION);
    const promptVersions = manifest.promptVersions as Record<string, unknown>;
    expect(promptVersions.scenario).toBe(SCENARIO_CANDIDATE_CONTRACT_VERSION);
    for (const role of ["director", "writer", "npc"]) {
      expect(promptVersions[role]).toBe(NARRATIVE_CONTRACT_VERSION);
    }
    expect(manifest.temperature).toBe(0.2);
    expect(manifest.thinkingRoles).toEqual([]);
    expect(manifest.timeoutMs).toBe(300_000);
    const timings = manifest.timings as Record<string, unknown>;
    expect(typeof timings.startedAt).toBe("string");
    expect(typeof timings.finishedAt).toBe("string");
    for (const key of ["openingMs", "narrativeWaitMs", "branchMs", "playerActionMs", "finalizationMs", "totalMs"]) {
      expect(typeof timings[key]).toBe("number");
      expect(Number(timings[key])).toBeGreaterThanOrEqual(0);
    }
    expect(manifest.answerKey).toMatchObject({ "main:1": { exactAliases: expect.any(Array) } });
    expect(manifest.gitCommit === null || typeof manifest.gitCommit === "string").toBe(true);
    const blueprint = manifest.blueprint as {
      quests: readonly { kind: string }[];
      endings: readonly unknown[];
      facts: readonly { id: string; source: string }[];
      locations: readonly { id: string; name: string }[];
      items: readonly { id: string }[];
      enemies: readonly { id: string }[];
      world: { name: string };
    };
    expect(blueprint.world.name).toBeTruthy();
    expect(blueprint.facts.length).toBeGreaterThan(0);
    expect(blueprint.locations.length).toBeGreaterThan(0);
    expect(Array.isArray(blueprint.items)).toBe(true);
    expect(Array.isArray(blueprint.enemies)).toBe(true);
    expect(blueprint.quests.some((quest) => quest.kind === "main")).toBe(true);
    // Phase 14：fallback 单段起始锚点不产出物品/敌人/结局静态目录（运行时导演懒生成），允许为空数组。
    expect(Array.isArray(blueprint.endings)).toBe(true);
    expect(blueprint.endings.length).toBe(0);
  }, 90_000);

  it("objective 策略记录任务导向选择理由", async () => {
    const fetchSpy = createFakeAiFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    const artifactDir = join(tmpRoot, "offline-run-objective");
    const dbPath = join(tmpRoot, "offline-objective.sqlite");
    try {
      const result = await runStoryEvalJourney({
        env: {
          AI_API_BASE_URL: "http://127.0.0.1:9/v1",
          AI_MODEL: "fake-model",
          AI_API_KEY: "fake-key",
          STORY_EVAL_CAPTURE: "1",
          STORY_EVAL_ARTIFACT_DIR: artifactDir,
        },
        dbPath,
        artifactDir,
        strategySeed: 7,
        caseId: "wuxia-a",
        strategy: "objective",
        maxScenes: 3,
        requireGeneratedOpening: false,
      });
      expect(result.completeness.complete).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
    expect(storyLines.length).toBeGreaterThan(0);
    for (const line of storyLines) {
      const row = JSON.parse(line) as StoryEvalStoryRow;
      // objective 只产出任务导向理由或 random（同类才用 PRNG）。
      const reason = row.playerChoice?.reason ?? "";
      expect(reason.startsWith("objective:") || reason === "random").toBe(true);
    }
  }, 90_000);

  it("主线阶段检查点：离线 fallback 单段起始锚点合法不产出 branches（stage 2/4/6 不可达），旅程仍完整记录", async () => {
    const fetchSpy = createFakeAiFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    const artifactDir = join(tmpRoot, "offline-run-branches");
    const dbPath = join(tmpRoot, "offline-branches.sqlite");
    let result: Awaited<ReturnType<typeof runStoryEvalJourney>>;
    try {
      result = await runStoryEvalJourney({
        env: {
          AI_API_BASE_URL: "http://127.0.0.1:9/v1",
          AI_MODEL: "fake-model",
          AI_API_KEY: "fake-key",
          STORY_EVAL_CAPTURE: "1",
          STORY_EVAL_ARTIFACT_DIR: artifactDir,
        },
        dbPath,
        artifactDir,
        strategySeed: 7,
        caseId: "wuxia-a",
        strategy: "explore",
        maxScenes: 16,
        requireGeneratedOpening: false,
      });
expect(result.completeness.complete).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }

    // Phase 14：离线 createGame 走 opening 预算（1 幕）校验，fallback 只生成单段起始锚点，
    // 主线阶段永远停在 stage 1（随后进入 resolution mainStage=null），
    // BRANCH_CHECKPOINT_STAGES=[2,4,6] 在离线旅程中不可达，branches/ 目录合法缺失。
    const branchesRoot = join(artifactDir, "branches");
    expect(existsSync(branchesRoot)).toBe(false);
    // validateCandidate + stage 1 起跑：单段锚点任务闭环后即达 resolution，旅程在
    // 合法终态结束（不进入 aborted/incomplete），场景数落在锚点闭环的有限区间。
    expect(result.status).not.toBe("aborted");
    expect(result.status).not.toBe("incomplete");
    // validateScenarioBlueprint 保证首幕即为主线（start quest 单段）。
    const blueprint = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8"))
      .blueprint as { quests: readonly { kind: string; stage: number }[] };
    const mainQuest = blueprint.quests.find((quest) => quest.kind === "main");
    expect(mainQuest?.stage).toBe(1);
    // 旅程产出与 result 计数一致；单段锚点可能因场景供给耗尽提前结束（合法解析态）。
    const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
    expect(storyLines.length).toBe(result.sceneCount);
    expect(storyLines.length).toBeGreaterThan(0);
    for (const line of storyLines) {
      const row = JSON.parse(line) as StoryEvalStoryRow;
      // 单段锚点：scene stage 只会是 1，进入 resolution 后为 null；绝不出现 2/4/6。
      expect(row.mainStage === null || Number(row.mainStage) === 1).toBe(true);
    }
  }, 90_000);

  it("审批驳回→重试→恢复的事件序列正确写入 calls.jsonl（role_approval + plan_approved）", async () => {
    const fetchSpy = createFakeAiFetchWithRejection();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    const artifactDir = join(tmpRoot, "offline-run-rejection");
    const dbPath = join(tmpRoot, "offline-rejection.sqlite");
    try {
      await runStoryEvalJourney({
        env: {
          AI_API_BASE_URL: "http://127.0.0.1:9/v1",
          AI_MODEL: "fake-model",
          AI_API_KEY: "fake-key",
          STORY_EVAL_CAPTURE: "1",
          STORY_EVAL_ARTIFACT_DIR: artifactDir,
        },
        dbPath,
        artifactDir,
        strategySeed: 7,
        caseId: "wuxia-a",
        strategy: "explore",
        maxScenes: 2,
        requireGeneratedOpening: false,
      });
    } finally {
      vi.restoreAllMocks();
    }

    const callLines = readFileSync(join(artifactDir, "calls.jsonl"), "utf8").trim().split("\n");
    const roleApprovals = callLines
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === "role_approval");
    // 至少有一个 role_approval 的 category 不为 null（即审批驳回）。
    const rejected = roleApprovals.filter((record) => record.category !== null);
    expect(rejected.length).toBeGreaterThan(0);
    // 有 plan_approved 记录（恢复后导演计划被批准）。
    const planApproved = callLines
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === "plan_approved");
    expect(planApproved.length).toBeGreaterThan(0);
  }, 90_000);
});

describe("Story eval journey (real AI, opt-in)", () => {
  it.runIf(process.env.RUN_REAL_AI_STORY_EVAL === "1")(
    "记录一局真实 long 故事旅程（门禁脚本注入 env）",
    async () => {
      const artifactDir = process.env.STORY_EVAL_ARTIFACT_DIR;
      const dbPath = process.env.GAME_DB_PATH;
      if (artifactDir === undefined || dbPath === undefined) {
        throw new Error("missing safe story-eval artifact dir or db path");
      }
      const result = await runStoryEvalJourney({
        env: process.env,
        dbPath,
        artifactDir,
        strategySeed: Number(process.env.STORY_EVAL_SEED ?? "0"),
        caseId: process.env.STORY_EVAL_CASE_ID ?? "wuxia-a",
        strategy: process.env.STORY_EVAL_STRATEGY === "objective" ? "objective" : "explore",
        maxScenes: Number(process.env.STORY_EVAL_MAX_SCENES ?? "60"),
        requireGeneratedOpening: true,
        modelLabel: process.env.AI_MODEL,
      });
      // requireGeneratedOpening 已在 runStoryEvalJourney 内部校验（开局非 generated 直接失败）。
      // 完整性失败（incomplete）由断言转成 vitest 非零退出 → 门禁 failed。
      expect(result.completeness.complete).toBe(true);
      expect(result.status).not.toBe("incomplete");
      const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
      expect(storyLines.length).toBeGreaterThan(0);
    },
    Number(process.env.STORY_EVAL_TOTAL_BUDGET_MS ?? (90 * 60_000).toString()) + 600_000,
  );
});
