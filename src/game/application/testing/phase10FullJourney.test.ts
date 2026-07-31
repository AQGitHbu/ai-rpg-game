/** @vitest-environment node */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { budgetPolicyOf, type NewGameInput } from "@/game/domain";
import type {
  DirectorAttempt,
  DirectorSource,
  NpcLineAttempt,
  NpcLineSource,
  SceneScriptAttempt,
  SceneScriptSource,
} from "../runtimeNarrative";
import { NARRATIVE_CONTRACT_VERSION } from "../runtimeNarrative";
import { createGame, type CreateGameDependencies } from "../createGame";
import { generatePendingNarrativeScene } from "../generatePendingNarrativeScene";
import { getCurrentGame } from "../getCurrentGame";
import { performAction, type PerformActionDependencies } from "../performAction";
import {
  createUnavailableTestScenarioSource,
  runScenarioPipeline,
} from "../applicationFixture.testutil";
import {
  asGameId,
  type GameRecord,
  type GameRepository,
} from "../server/persistence/gameRepository";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository,
} from "../server/persistence/sqliteGameRepository";
import {
  createRecordingRuntimeNarrativeSources,
  createReplayRuntimeNarrativeSources,
  type RuntimeNarrativeRecordedCall,
} from "../server/ai/runtimeNarrativeRecording";
import { createRuntimeNarrativeSources } from "../server/ai/runtimeNarrativeSourceFactory";
import {
  JOURNEY_REPORT_VERSION,
  validateJourneyReport,
  type JourneyReport,
} from "./runtimeNarrativeJourney";
import { prepareTmpRunDir } from "./tmpRunDir.testutil";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";

type Phase1Fixture = { input: NewGameInput; seed: string };
type RuntimeSources = Readonly<{
  directorSource: DirectorSource;
  sceneScriptSource: SceneScriptSource;
  npcLineSource: NpcLineSource;
}>;

const fixture: Phase1Fixture = { ...(wuxiaFixture as unknown as Phase1Fixture), input: { ...(wuxiaFixture as unknown as Phase1Fixture).input, gameLength: "short" } };
const baseline = runScenarioPipeline(fixture.input, fixture.seed);
const goldenRoot = resolve("data", "fixtures", "phase10-journey", "v1");
// 共享 tmp/ 策略：创建前先清扫上一轮同前缀残留（见 tmpRunDir.testutil.ts）。
const tmpRoot = prepareTmpRunDir("phase10-full-journey-");
const openRepositories: SqliteGameRepository[] = [];
const fixedNow = "2026-07-30T08:00:00.000Z";

afterAll(async () => {
  vi.restoreAllMocks();
  for (const repository of openRepositories) await repository.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may retain a SQLite handle briefly; the next run uses a unique path.
  }
});

function openRepository(name: string): SqliteGameRepository {
  const repository = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(join(tmpRoot, `${name}.sqlite`)),
    logError: () => {},
  });
  openRepositories.push(repository);
  return repository;
}

/**
 * Curated source used only to bootstrap the first fixture. It follows the same
 * source ports and approvals as live AI, but is never labelled as recorded AI.
 */
function createCuratedJourneySources(): RuntimeSources {
  const targets = [
    "move:loc_2",
    "move:loc_3",
    "talk:",
    "take_item:",
    "move:loc_4",
    "start_battle:",
  ];
  let sceneIndex = 0;

  const directorSource: DirectorSource = {
    async generate(request) {
      const context = request.context as {
        actionCandidates: readonly { actionKey: string; kind: string; label: string }[];
        npcIdsPresent: readonly string[];
        progression: { allowedPacing: readonly ("setup" | "develop" | "turn" | "climax" | "resolution")[] };
      };
      const prefix = targets[sceneIndex];
      const target = context.actionCandidates.find((candidate) =>
        candidate.actionKey.startsWith(prefix ?? "")
      );
      const alternative = context.actionCandidates.find((candidate) =>
        candidate.actionKey !== target?.actionKey
      );
      if (target === undefined || alternative === undefined) {
        return {
          ok: false,
          provenance: "fixture",
          category: "reference_broken",
          diagnostics: {
            traceId: request.traceId,
            contractVersion: NARRATIVE_CONTRACT_VERSION,
            stage: "failed",
            category: "reference_broken",
          },
        };
      }
      const focusNpcId = target.kind === "talk"
        ? target.actionKey.slice("talk:".length)
        : null;
      const introducedKind = target.kind === "move"
        ? "location"
        : target.kind === "talk"
          ? "npc"
          : target.kind === "take_item"
            ? "item"
            : target.kind === "start_battle"
              ? "enemy"
              : null;
      const introducedId = target.actionKey.slice(target.actionKey.indexOf(":") + 1);
      sceneIndex += 1;
      return {
        ok: true,
        provenance: "generated",
        plan: {
        sceneGoal: `第 ${sceneIndex} 幕：让规则允许的目标自然进入剧情`,
        tensionLevel: Math.min(5, sceneIndex) as 1 | 2 | 3 | 4 | 5,
        focusNpcId,
        relevantFactIds: [],
        allowedRevealFactIds: [],
        suggestedActionKeys: [target.actionKey, alternative.actionKey],
        introducedEntities: introducedKind === null
          ? []
          : [{ kind: introducedKind, id: introducedId }],
          // 蓝图动态化后幕数由 BudgetPolicy 驱动（open 档 5 幕），不再硬编码阶段公式；
          // 直接取上下文 progression.allowedPacing 末位（当前阶段最激进的合法节奏），
          // 否则 approveDirectorProposal 以 continuity_violation 拒绝。
          pacing: context.progression.allowedPacing[context.progression.allowedPacing.length - 1] ?? "develop",
        proposedNewLocations: [],
        proposedNewNpcs: [],
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "candidate_received",
        },
      } satisfies DirectorAttempt;
    },
  };

  const sceneScriptSource: SceneScriptSource = {
    async generate(request) {
      const context = request.context as {
        plan: {
          focusNpcId: string | null;
          suggestedActionKeys: readonly [string, string];
        };
        npcProfile: Record<string, unknown> | null;
      };
      const [target, alternative] = context.plan.suggestedActionKeys;
      return {
        ok: true,
        provenance: "generated",
        script: {
          narration: "局势沿着已经存在的世界规则向前推进，新的线索与道路在眼前展开。",
          usedFactIds: [],
          npcInstruction: context.plan.focusNpcId === null
            ? null
            : {
                npcId: context.plan.focusNpcId,
                speechAct: "warn",
                emotion: "guarded",
                allowedFactIds: [],
                mayLie: false,
              },
          choices: [
            { actionKey: target, label: "执行目标行动", strategy: "推进当前主线" },
            { actionKey: alternative, label: "采取另一行动", strategy: "暂缓当前目标" },
          ],
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "candidate_received",
        },
      } satisfies SceneScriptAttempt;
    },
  };

  const npcLineSource: NpcLineSource = {
    async generate(request) {
      return {
        ok: true,
        provenance: "generated",
        performance: {
          text: "前路并不安全，但你要找的答案就在更深处。",
          usedFactIds: [],
          emotion: "guarded",
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "candidate_received",
        },
      } satisfies NpcLineAttempt;
    },
  };
  return { directorSource, sceneScriptSource, npcLineSource };
}

function createCoverageGuidedSources(sources: RuntimeSources): RuntimeSources {
  return {
    ...sources,
    directorSource: {
      async generate(request) {
        const context = request.context as {
          currentLocationId?: string;
          recentEvents?: readonly string[];
          actionCandidates?: readonly { actionKey: string }[];
        };
        const candidates = context.actionCandidates ?? [];
        const hasNpcMet = context.recentEvents?.includes("npc_met") ?? false;
        const hasTakeItem = candidates.some((candidate) =>
          candidate.actionKey.startsWith("take_item:")
        );
        const preferredPrefixes = context.currentLocationId === "loc_1"
          ? ["move:loc_2"]
          : context.currentLocationId === "loc_2"
            ? ["move:loc_3"]
            : context.currentLocationId === "loc_3"
              ? hasTakeItem
                ? hasNpcMet ? ["take_item:"] : ["talk:"]
                : ["move:loc_4"]
              : context.currentLocationId === "loc_4"
                ? ["start_battle:"]
                : [];
        const target = preferredPrefixes
          .map((prefix) => candidates.find((candidate) => candidate.actionKey.startsWith(prefix)))
          .find((candidate) => candidate !== undefined);
        return sources.directorSource.generate({
          ...request,
          context: target === undefined
            ? request.context
            : { ...request.context, coverageTargetActionKey: target.actionKey },
        });
      },
    },
  };
}

async function loadRecord(repository: GameRepository): Promise<GameRecord> {
  const loaded = await repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") throw new Error("journey record unavailable");
  return loaded.record;
}

function createDeps(repository: GameRepository, sources: RuntimeSources): CreateGameDependencies {
  let trace = 0;
  return {
    repository,
    newGameId: () => asGameId("phase10-full-journey"),
    newSeed: () => fixture.seed,
    now: () => fixedNow,
    scenarioCandidateSource: createUnavailableTestScenarioSource(),
    newTraceId: () => `journey-trace-${trace++}`,
    runtimeNarrativeSources: sources,
  };
}

function actionDeps(repository: GameRepository, sources: RuntimeSources): PerformActionDependencies {
  let trace = 1;
  return {
    repository,
    now: () => fixedNow,
    newTraceId: () => `journey-trace-${trace++}`,
    runtimeNarrativeSources: sources,
  };
}

function narrativeTaskDeps(repository: GameRepository, sources: RuntimeSources) {
  let trace = 0;
  return {
    repository,
    newTraceId: () => `journey-task-trace-${trace++}`,
    now: () => fixedNow,
    runtimeNarrativeSources: sources,
  };
}

async function runJourney(
  name: string,
  sources: RuntimeSources,
  mode: "record" | "replay",
  getAiCalls: () => number = () => 13,
): Promise<JourneyReport> {
  const repository = openRepository(name);
  const created = await createGame(
    { input: fixture.input, seed: fixture.seed },
    createDeps(repository, sources),
  );
  if (!created.ok) throw new Error("journey create failed");
  const taskDeps = narrativeTaskDeps(repository, sources);
  async function materializePendingScene() {
    const generated = await generatePendingNarrativeScene(taskDeps);
    if (generated !== "saved") throw new Error(`pending narrative was not saved: ${generated}`);
    const current = await getCurrentGame({ repository });
    if (current.status !== "active") throw new Error("generated narrative view unavailable");
    return current.view;
  }
  let view = await materializePendingScene();
  let narrativeChoices = 0;
  let generatedNpcLines = view.narrative?.npcLine === null ? 0 : 1;
  let reloadConsistent = true;
  let mandatoryFallbacks = (await loadRecord(repository)).state.narrative.currentScene?.source === "fallback" ? 1 : 0;
  if (mode === "record" && mandatoryFallbacks > 0) {
    throw new Error("mandatory narrative fallback");
  }
  const deps = actionDeps(repository, sources);

  for (let index = 0; index < 6; index += 1) {
    const choice = view.narrative?.choices[0];
    if (choice === undefined) throw new Error("guided narrative choice unavailable");
    const result = await performAction({
      intent: { type: "narrative_choice", choiceToken: choice.choiceToken },
      expectedRevision: view.revision,
    }, deps);
    if (!result.ok) {
      throw new Error(`guided narrative choice rejected at ${index}: ${result.code}`);
    }
    narrativeChoices += 1;
    view = result.view;
    if (view.narrativeGeneration.status === "pending") {
      view = await materializePendingScene();
    }
    if (view.narrative?.npcLine !== null && view.narrative?.npcLine !== undefined) {
      generatedNpcLines += 1;
    }
    mandatoryFallbacks += (await loadRecord(repository)).state.narrative.currentScene?.source === "fallback" ? 1 : 0;
    if (mode === "record" && mandatoryFallbacks > 0) {
      throw new Error("mandatory narrative fallback");
    }
    const reloaded = await getCurrentGame({ repository });
    reloadConsistent &&= reloaded.status === "active" &&
      JSON.stringify(reloaded.view) === JSON.stringify(view);
  }

  expect(view.battle).not.toBeNull();
  while (view.battle !== null) {
    const result = await performAction({
      intent: { type: "battle_action", action: "attack" },
      expectedRevision: view.revision,
    }, { repository, now: () => fixedNow });
    if (!result.ok) throw new Error("battle action rejected");
    view = result.view;
  }

  const record = await loadRecord(repository);
  const eventTypes = record.state.eventLedger.map((event) => event.type);
  const report: JourneyReport = {
    version: JOURNEY_REPORT_VERSION,
    mode,
    outcome: view.ending?.outcome ?? "unfinished",
    turns: view.revision,
    aiCalls: getAiCalls(),
    maxTurns: 20,
    maxAiCalls: 40,
    reloadConsistent,
    contentBudgetValid: (() => {
      const policy = budgetPolicyOf(record.blueprint);
      const mainCount = record.blueprint.locations.filter((entry) => entry.kind === "main").length;
      return mainCount >= policy.opening.mainLocationsMin &&
        mainCount <= policy.opening.mainLocationsMax &&
        record.blueprint.endings.length === policy.opening.endings &&
        record.blueprint.npcs.length >= policy.opening.coreNpcsMin &&
        record.blueprint.npcs.length <= policy.opening.coreNpcsMax;
    })(),
    mandatoryFallbacks,
    coverage: {
      narrativeChoices,
      generatedNpcLines,
      firstVisitedLocations: eventTypes.filter((type) => type === "location_visited").length,
      firstMetNpcs: eventTypes.filter((type) => type === "npc_met").length,
      obtainedItems: eventTypes.filter((type) => type === "item_obtained").length,
      battlesStarted: eventTypes.filter((type) => type === "battle_started").length,
      battlesWon: eventTypes.filter((type) => type === "enemy_defeated").length,
    },
  };
  // 蓝图动态化：真实导演可能在旅程中提议扩展（loc_dyn_*/npc_dyn_*）。剔除动态
  // 实体与锚点上的动态反向连边后，基础蓝图必须与 baseline 逐字一致（运行时层不得篡改既有内容）。
  const strippedBlueprint = {
    ...record.blueprint,
    locations: record.blueprint.locations
      .filter((loc) => !/^loc_dyn_\d+$/.test(String(loc.id)))
      .map((loc) => ({
        ...loc,
        connectedLocationIds: loc.connectedLocationIds.filter((id) => !/^loc_dyn_\d+$/.test(String(id))),
      })),
    npcs: record.blueprint.npcs.filter((npc) => !/^npc_dyn_\d+$/.test(String(npc.id))),
  };
  expect(strippedBlueprint).toEqual(baseline.blueprint);
  return report;
}

describe("Phase 10 complete narrative journey", () => {
  it("replays the committed golden fixture with zero network calls (Phase 11: re-recorded with stage-aware pacing)", async () => {
    const calls = readFileSync(join(goldenRoot, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as RuntimeNarrativeRecordedCall);
    const expected = JSON.parse(
      readFileSync(join(goldenRoot, "expected-summary.json"), "utf8"),
    ) as JourneyReport;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const replay = createReplayRuntimeNarrativeSources(calls);
    const report = await runJourney(
      "golden-replay",
      createCoverageGuidedSources(replay),
      "replay",
      () => calls.length,
    );
    replay.assertComplete();
    expect(validateJourneyReport(report)).toEqual([]);
    expect(report.outcome).toBe(expected.outcome);
    expect(report.turns).toBe(expected.turns);
    expect(report.aiCalls).toBe(expected.aiCalls);
    expect(report.coverage).toEqual(expected.coverage);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("records parsed outputs locally and replays the same successful journey with zero AI", async () => {
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(1_785_379_200_000);
    const calls: RuntimeNarrativeRecordedCall[] = [];
    const recordedSources = createRecordingRuntimeNarrativeSources(
      createCuratedJourneySources(),
      { append: (call) => { calls.push(call); } },
    );
    const recorded = await runJourney("record", recordedSources, "record");
    expect(validateJourneyReport(recorded)).toEqual([]);
    expect(calls).toHaveLength(13);

    const callsPath = join(tmpRoot, "calls.jsonl");
    writeFileSync(callsPath, calls.map((call) => JSON.stringify(call)).join("\n") + "\n", "utf8");
    const localized = readFileSync(callsPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as RuntimeNarrativeRecordedCall);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const replaySources = createReplayRuntimeNarrativeSources(localized);
    const replayed = await runJourney("replay", replaySources, "replay");
    replaySources.assertComplete();
    expect(validateJourneyReport(replayed)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(replayed.coverage).toEqual(recorded.coverage);
    fetchSpy.mockRestore();
    dateSpy.mockRestore();
  }, 30_000);

  it.runIf(process.env.RUN_REAL_AI_JOURNEY === "1")(
    "records one opt-in real AI journey as a replay candidate",
    async () => {
      const calls: RuntimeNarrativeRecordedCall[] = [];
      const recorded = createRecordingRuntimeNarrativeSources(
        createRuntimeNarrativeSources(process.env),
        {
        append: (call) => { calls.push(call); },
        },
      );
      const guided = createCoverageGuidedSources(recorded);
      const report = await runJourney("live-record", guided, "record", () => calls.length);
      const issues = validateJourneyReport(report);
      const replay = createReplayRuntimeNarrativeSources(calls);
      const replayReport = await runJourney(
        "live-immediate-replay",
        createCoverageGuidedSources(replay),
        "replay",
        () => calls.length,
      );
      replay.assertComplete();
      expect(validateJourneyReport(replayReport)).toEqual([]);
      expect(replayReport.coverage).toEqual(report.coverage);

      const artifactDir = process.env.PHASE10_JOURNEY_ARTIFACT_DIR;
      if (artifactDir === undefined) throw new Error("missing safe journey artifact directory");
      mkdirSync(artifactDir, { recursive: true });
      writeFileSync(
        join(artifactDir, "calls.jsonl"),
        calls.map((call) => JSON.stringify(call)).join("\n") + "\n",
        "utf8",
      );
      writeFileSync(
        join(artifactDir, "manifest.json"),
        JSON.stringify({
          fixtureVersion: "runtime-narrative-fixture-v1",
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          origin: "recorded",
          blueprintFixture: "phase1/wuxia",
          callCount: calls.length,
          createdAt: fixedNow,
        }, null, 2) + "\n",
        "utf8",
      );
      writeFileSync(
        join(artifactDir, "expected-summary.json"),
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      );
      expect(issues).toEqual([]);
    },
    1_800_000,
  );
});
