/** @vitest-environment node */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import type { GameSessionView } from "../gameSessionView";
import { createServerGameEntryPoints, type ServerGameEntryPoints } from "../server/compositionRoot";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository, type SqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { deriveContentProgression } from "@/game/gameplay/rpg/narrative";
import type { StoryEvalStoryRow } from "./storyEvalArtifacts";
import { buildStoryEvalInput, hashStringToSeed, mulberry32, pickNarrativeChoice } from "./storyEvalStrategy";

// ---------------------------------------------------------------------------
// 评估旅程本体（spec §7）：经 createServerGameEntryPoints 驱动（唯一能命中
// §6.2 采集装配点、且与浏览器局同一条服务端路径的方式）。驱动侧另开评估专用
// 只读 repository（createSqliteGameRepository + 同一 GAME_DB_PATH）读取
// actionKey/主线阶段/世界 seed/蓝图快照——不经过客户端投影，不破坏安全红线。
// 离线模式（默认）：global fetch 被 mock，零网络零计费；真实模式仅在
// RUN_REAL_AI_STORY_EVAL=1 时启用（由门禁脚本 storyEvalJourney.mjs 注入）。
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

/** 按 sceneId 前缀 traceId 关联 calls.jsonl 中的 plan_approved 记录（spec §6.3）。 */
function directorPlanFor(sceneId: string, calls: readonly Readonly<Record<string, unknown>>[]): Readonly<Record<string, unknown>> | null {
  const record = calls.find((call) =>
    call.kind === "plan_approved" &&
    typeof call.traceId === "string" &&
    sceneId.startsWith(call.traceId),
  );
  return record !== undefined ? (record.planSummary as Readonly<Record<string, unknown>>) : null;
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
  status: "converged" | "max_scenes" | "aborted" | "incomplete";
  sceneCount: number;
  fallbackScenes: number;
  openingSource: string;
  endingOutcome: string | null;
  completeness: Readonly<{ complete: boolean; missing: readonly string[] }>;
}>;

export async function runStoryEvalJourney(config: StoryEvalJourneyConfig): Promise<StoryEvalJourneyResult> {
  const { env, dbPath, artifactDir, strategySeed, maxScenes, requireGeneratedOpening } = config;
  const rand = mulberry32(hashStringToSeed(String(strategySeed)));
  const { input } = buildStoryEvalInput("long", strategySeed);
  let entry: ServerGameEntryPoints | null = null;
  let evalRepository: SqliteGameRepository | null = null;
  const storyRows: StoryEvalStoryRow[] = [];
  let status: StoryEvalJourneyResult["status"] = "max_scenes";
  let openingSource = "unknown";
  let endingOutcome: string | null = null;
  let fallbackScenes = 0;
  let sceneCount = 0;

  try {
    entry = createServerGameEntryPoints({ ...env, GAME_DB_PATH: dbPath });
    evalRepository = openEvalRepository(dbPath);

    const created = await entry.createGame(input);
    if (!created.ok) throw new Error(`createGame failed: ${created.code}`);
    // requireGeneratedOpening：真实模式要求开局由 AI 生成（离线 fetch-mock 走
    // fallback 开局可接受）；不满足直接失败，避免把非生成开局误记成生成。
    if (requireGeneratedOpening && created.source !== "generated") {
      throw new Error(`opening was not AI-generated: ${created.source}`);
    }
    openingSource = created.source;

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

    let view = await getView();
    let previousLedgerLength = (await loadRecord()).state.eventLedger.length;
    const manifest: Record<string, unknown> = {
      gameId: null,
      worldSeed: null,
      strategySeed,
      gameLength: "long",
      model: config.modelLabel ?? null,
      status,
      sceneCount: 0,
      fallbackScenes: 0,
      blueprint: null,
      // Task 13 扩展字段：caseId/strategy、gitCommit、NARRATIVE_CONTRACT_VERSION、
      // 四角色 prompt 版本、temperature、timeoutMs、answerKey（S4 确定性评分所需，
      // 由蓝图结局/敌人/任务结构与最终规则结果生成）。
    };
    const getCalls = createCachedCallsReader(artifactDir);

    for (let sceneIndex = 1; sceneIndex <= maxScenes; sceneIndex += 1) {
      // 1. pending 时确保生成并轮询到场景/战斗/结局就绪（带超时）。
      if (view.narrativeGeneration.status === "pending" || view.narrative === null) {
        await entry.ensureNarrativeGeneration();
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          view = await getView();
          if (view.narrative !== null || view.battle !== null || view.ending !== null) break;
          await sleep(500);
        }
        if (view.narrative === null && view.battle === null && view.ending === null) {
          throw new Error("narrative generation timeout");
        }
      }
      // 2. 结局：收尾记录。
      if (view.ending !== null) {
        endingOutcome = view.ending.outcome;
        status = "converged";
        const record = await loadRecord();
        const tailEvents = record.state.eventLedger
          .slice(previousLedgerLength)
          .map((event) => ({ type: event.type }));
        storyRows.push({ kind: "ending", sceneIndex, outcome: endingOutcome, newEvents: tailEvents });
        previousLedgerLength = record.state.eventLedger.length;
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
        continue;
      }
      // 4. 场景就绪：记录 story 行。
      const record = await loadRecord();
      const scene = record.state.narrative.currentScene;
      if (scene === null) throw new Error("scene vanished before record");
      const stage = deriveContentProgression({ blueprint: record.blueprint, state: record.state }).mainStage;
      const calls = getCalls();
      const choice = pickNarrativeChoice(record, rand);
      const newEvents = record.state.eventLedger
        .slice(previousLedgerLength)
        .map((event) => ({ type: event.type }));
      storyRows.push({
        kind: "scene",
        sceneIndex,
        sceneId: scene.sceneId,
        mainStage: stage,
        narration: scene.narration,
        npcLine: scene.npcLine === null ? null : { text: scene.npcLine.text, emotion: scene.npcLine.emotion },
        choices: scene.choices.map((entry) => ({ label: entry.label, actionKey: entry.actionKey })),
        directorPlan: directorPlanFor(scene.sceneId, calls),
        fallback: scene.source === "fallback",
        playerChoice: { index: choice.index, actionKey: scene.choices[choice.index]?.actionKey ?? "", reason: choice.reason },
        newEvents,
        // Task 13 扩展字段：memorySummary、npcProfile/relationship/lastInteractionSummary、
        // newEvents 安全结构 { type, factId?, entityId?, questId?, endingId? }、
        // directorPlan.allowedRevealFactIds、introducedEntities 与扩展实体 ID。
      });
      previousLedgerLength = record.state.eventLedger.length;
      sceneCount += 1;
      if (scene.source === "fallback") fallbackScenes += 1;
      if (fallbackScenes > sceneCount / 2) {
        status = "aborted";
        break;
      }
      // 5. 执行选择。
      const result = await entry.performAction({
        intent: { type: "narrative_choice", choiceToken: scene.choices[choice.index]?.choiceToken ?? "" },
        expectedRevision: view.revision,
      });
      if (!result.ok) throw new Error(`narrative choice rejected at ${sceneIndex}: ${result.code}`);
      view = result.view;
    }

    // 6. 收尾产物：manifest.json 与 story.jsonl。
    const finalRecord = await loadRecord();
    const blueprint = finalRecord.blueprint;
    manifest.gameId = String(finalRecord.gameId);
    manifest.worldSeed = blueprint.seed;
    manifest.status = status;
    manifest.sceneCount = sceneCount;
    manifest.fallbackScenes = fallbackScenes;
    manifest.blueprint = {
      // 世界名称不在蓝图结构内（domain WorldDefinition 无 name），取会话视图
      // 投影的世界显示名（profile label），保证 manifest 蓝图快照可读。
      world: { name: view.world.name, summary: blueprint.world.summary, tone: blueprint.world.tone, themes: blueprint.world.themes },
      npcs: blueprint.npcs.map((npc) => ({
        id: String(npc.id),
        name: npc.name,
        role: npc.role,
        description: (npc as Record<string, unknown>).description ?? null,
        isCompanion: npc.isCompanion,
        knownFactIds: npc.knownFactIds.map(String),
      })),
      quests: blueprint.quests.map((quest) => ({
        id: String(quest.id),
        name: quest.name,
        kind: quest.kind,
        stage: quest.kind === "main" ? quest.stage : null,
        description: quest.description,
      })),
      endings: blueprint.endings.map((ending) => ({
        id: String(ending.id),
        name: ending.name,
        description: ending.description,
      })),
    };
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "story.jsonl"), storyRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } finally {
    await entry?.close();
  }
  // completeness：产物完整性快照（story.jsonl 有行且未因异常中断即视为 complete；
  // missing 由 Task 13 按评分所需产物清单扩展）。
  const missing: string[] = [];
  if (storyRows.length === 0) missing.push("story");
  return {
    status,
    sceneCount,
    fallbackScenes,
    openingSource,
    endingOutcome,
    completeness: { complete: missing.length === 0, missing },
  };
}

function readCalls(artifactDir: string): readonly Readonly<Record<string, unknown>>[] {
  try {
    return readFileSync(join(artifactDir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
  } catch {
    return [];
  }
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
        progression?: { allowedPacing?: string[] };
      };
      const candidates = context.actionCandidates ?? [];
      const first = candidates[0]?.actionKey ?? "observe:loc_1";
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
        caseId: "offline-wuxia-a",
        strategy: "explore",
        maxScenes: 3,
        requireGeneratedOpening: false,
        modelLabel: "fake-model",
      });
      expect(result.status).toBe("max_scenes");
      expect(result.sceneCount).toBe(3);
      expect(result.openingSource).toBe("fallback");
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

    // story.jsonl：场景行结构完整，导演计划摘要已关联。
    const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
    expect(storyLines).toHaveLength(3);
    for (const line of storyLines) {
      const row = JSON.parse(line) as StoryEvalStoryRow;
      expect(row.kind).toBe("scene");
      expect(row.narration).toBeTruthy();
      expect(row.mainStage).not.toBeNull(); // 主线 quest 存在时总是数字（deriveContentProgression）
      expect(Number(row.mainStage)).toBeGreaterThanOrEqual(1);
      expect(row.choices).toHaveLength(2);
      expect(row.directorPlan).toMatchObject({ pacing: expect.any(String), tensionLevel: 3 });
      expect(row.playerChoice).toMatchObject({ index: expect.any(Number), reason: expect.any(String) });
      expect(Array.isArray(row.newEvents)).toBe(true);
    }

    // manifest.json：gameId/世界 seed/蓝图快照。
    const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.gameId).toBeTruthy();
    expect(manifest.worldSeed).toBeTruthy();
    expect(manifest.status).toBe("max_scenes");
    expect(manifest.sceneCount).toBe(3);
    const blueprint = manifest.blueprint as { quests: readonly { kind: string }[]; endings: readonly unknown[]; world: { name: string } };
    expect(blueprint.world.name).toBeTruthy();
    expect(blueprint.quests.some((quest) => quest.kind === "main")).toBe(true);
    expect(blueprint.endings.length).toBeGreaterThan(0);
  });

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
        caseId: "offline-wuxia-a",
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
  });
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
      const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
      expect(storyLines.length).toBeGreaterThan(0);
    },
    1_800_000,
  );
});
