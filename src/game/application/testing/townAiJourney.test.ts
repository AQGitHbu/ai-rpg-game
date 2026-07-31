/** @vitest-environment node */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  locationScaleOf,
  type NewGameInput,
  type ScenarioBlueprintCandidate
} from "@/game/domain";
import { createGame, type CreateGameDependencies } from "../createGame";
import { generatePendingTownPlan } from "../generatePendingTownPlan";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateSource
} from "../scenarioGeneration";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanCandidateSource } from "../townPlanGeneration";
import { createUnavailableTestScenarioSource } from "../applicationFixture.testutil";
import {
  asGameId,
  type GameRecord,
  type GameRepository
} from "../server/persistence/gameRepository";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "../server/persistence/sqliteGameRepository";
import { createFixtureScenarioCandidateSource } from "../server/ai/fixtureScenarioCandidateSource";
import { createScenarioCandidateSource } from "../server/ai/scenarioCandidateSourceFactory";
import { createTownPlanSource } from "../server/ai/townPlanSourceFactory";
import { createTownPlanFixtureSource } from "../server/ai/townPlanFixtureSource";
import {
  TOWN_PLAN_FIXTURE_VERSION,
  createRecordingTownPlanSource,
  createReplayTownPlanSource,
  type TownPlanRecordedCall
} from "../server/ai/townPlanRecording";
import { prepareTmpRunDir } from "./tmpRunDir.testutil";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";

// ---------------------------------------------------------------------------
// Town 层：真实 AI 的两层（scene）+ 三层（map→town→场景）录制/回放旅程。
// 三个用例镜像 phase10FullJourney：
//   1. 无 AI 的本地 record→replay（fallback 蓝图已含 scene+town，验证 town plan
//      录制/回放管线，始终运行、零网络）；
//   2. 提交的真实 AI golden 回放（fixtureScenarioCandidateSource 复现蓝图 +
//      replay town plan source 复现小镇，始终运行、零网络 + drift 断言）；
//   3. opt-in 真实 AI 录制（RUN_REAL_AI_TOWN_JOURNEY=1）：有界重试直到蓝图同时
//      含 scene 与 town 且 town plan 真实生成，落盘 fixture 供 (2) 复用。
// 录制物只含已解析候选：绝不落 prompt、模型原文或密钥。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const fixture: Phase1Fixture = { ...(wuxiaFixture as unknown as Phase1Fixture), input: { ...(wuxiaFixture as unknown as Phase1Fixture).input, gameLength: "short" } };

const goldenRoot = resolve("data", "fixtures", "town-journey", "v1");
const scenarioFixtureDir = join(goldenRoot, "scenario");
const townPlanFixtureDir = join(goldenRoot, "town-plan");
const SCENARIO_FIXTURE_ID = "town-journey";
const TOWN_JOURNEY_SUMMARY_VERSION = "town-journey-summary-v1" as const;
const fixedNow = "2026-07-31T08:00:00.000Z";

// 共享 tmp/ 策略：创建前先清扫上一轮同前缀残留（见 tmpRunDir.testutil.ts）。
const tmpRoot = prepareTmpRunDir("town-ai-journey-");
const openRepositories: SqliteGameRepository[] = [];

afterAll(async () => {
  vi.restoreAllMocks();
  for (const repository of openRepositories) await repository.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows may retain a SQLite handle briefly; the next run uses a unique path.
  }
});

type TownJourneySummary = Readonly<{
  version: typeof TOWN_JOURNEY_SUMMARY_VERSION;
  mode: "record" | "replay";
  scenarioSource: "generated" | "fallback";
  seed: string;
  sceneLocationCount: number;
  townLocationCount: number;
  townLocationId: string;
  townPlanSource: "offline" | "generated" | "fallback";
  townPlanTheme: string;
  townDistrictCount: number;
  townRequiredBuildingCount: number;
}>;

function openRepository(name: string): SqliteGameRepository {
  const repository = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(join(tmpRoot, `${name}.sqlite`)),
    logError: () => {}
  });
  openRepositories.push(repository);
  return repository;
}

async function loadRecord(repository: GameRepository): Promise<GameRecord> {
  const loaded = await repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") throw new Error("town journey record unavailable");
  return loaded.record;
}

function createGameDeps(
  repository: GameRepository,
  scenarioSource: ScenarioCandidateSource
): CreateGameDependencies {
  return {
    repository,
    newGameId: () => asGameId("town-ai-journey"),
    newSeed: () => fixture.seed,
    now: () => fixedNow,
    scenarioCandidateSource: scenarioSource,
    newTraceId: () => "town-journey-create-trace",
    // 离线叙事模式：createGame 无需 runtimeNarrativeSources；town pending 由本
    // 用例显式置入并交 generatePendingTownPlan 消费（该 use case 不读叙事模式）。
    runtimeNarrativeMode: "offline"
  };
}

/** 录制包装：捕获成功候选的原始 JSON（不改变 source 返回值）。 */
function createRecordingScenarioSource(
  source: ScenarioCandidateSource,
  onCandidate: (candidate: unknown) => void
): ScenarioCandidateSource {
  return {
    async generate(request) {
      const attempt = await source.generate(request);
      if (attempt.ok) onCandidate(attempt.candidate);
      return attempt;
    }
  };
}

/** 零网络回放：始终返回录制到的候选（createGame 仍走完整校验/编译）。 */
function createReplayScenarioSource(candidate: unknown): ScenarioCandidateSource {
  return {
    async generate() {
      return {
        ok: true,
        contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
        origin: "fixture",
        candidate: candidate as ScenarioBlueprintCandidate,
        diagnostics: []
      };
    }
  };
}

/**
 * 一次完整 town 旅程：createGame（含 scene+town 蓝图）→ 置 town pending →
 * generatePendingTownPlan 消费 → 汇总。蓝图缺 scene 或 town 时抛错（供真实 AI
 * 用例的有界重试捕获）。
 */
async function runTownJourney(
  name: string,
  scenarioSource: ScenarioCandidateSource,
  townPlanSource: TownPlanCandidateSource,
  mode: "record" | "replay"
): Promise<TownJourneySummary> {
  const repository = openRepository(name);
  const created = await createGame(
    { input: fixture.input, seed: fixture.seed },
    createGameDeps(repository, scenarioSource)
  );
  if (!created.ok) throw new Error(`town journey create failed: ${created.code}`);

  const record = await loadRecord(repository);
  const blueprint = record.blueprint;
  const townLocations = blueprint.locations.filter((loc) => locationScaleOf(loc) === "town");
  const sceneLocations = blueprint.locations.filter((loc) => locationScaleOf(loc) === "scene");
  if (townLocations.length === 0) throw new Error("blueprint has no town-scale location");
  if (sceneLocations.length === 0) throw new Error("blueprint has no scene-scale location");
  const townLocation = townLocations[0];

  const primed = await repository.applyResolvedAction({
    gameId: record.gameId,
    expectedRevision: record.revision,
    nextState: {
      ...record.state,
      townGeneration: { status: "pending", locationId: townLocation.id, requestedAt: fixedNow }
    }
  });
  if (!primed.ok) throw new Error(`prime town pending failed: ${primed.code}`);

  const result = await generatePendingTownPlan({
    repository,
    newTraceId: () => "town-journey-plan-trace",
    now: () => fixedNow,
    townPlanSource
  });
  if (result !== "saved") throw new Error(`town plan not saved: ${result}`);

  const finalRecord = await loadRecord(repository);
  const town = finalRecord.state.towns.find(
    (entry) => String(entry.locationId) === String(townLocation.id)
  );
  if (town === undefined) throw new Error("town runtime missing after generation");

  return {
    version: TOWN_JOURNEY_SUMMARY_VERSION,
    mode,
    scenarioSource: created.source,
    seed: blueprint.seed,
    sceneLocationCount: sceneLocations.length,
    townLocationCount: townLocations.length,
    townLocationId: String(townLocation.id),
    townPlanSource: town.planSource,
    townPlanTheme: town.plan.theme,
    townDistrictCount: town.plan.districts.length,
    townRequiredBuildingCount: town.plan.requiredBuildings.length
  };
}

describe("Town AI journey (scene + town) record/replay", () => {
  it("records the town plan locally over a fallback scene+town blueprint and replays with zero network", async () => {
    const calls: TownPlanRecordedCall[] = [];
    const recordingTown = createRecordingTownPlanSource(createTownPlanFixtureSource(), {
      append: (call) => { calls.push(call); }
    });
    const recorded = await runTownJourney(
      "local-record",
      createUnavailableTestScenarioSource(),
      recordingTown,
      "record"
    );
    expect(recorded.scenarioSource).toBe("fallback");
    expect(recorded.sceneLocationCount).toBeGreaterThanOrEqual(1);
    expect(recorded.townLocationCount).toBeGreaterThanOrEqual(1);
    expect(recorded.townPlanSource).toBe("generated");
    expect(calls).toHaveLength(1);

    const callsPath = join(tmpRoot, "local-town-plan.jsonl");
    writeFileSync(callsPath, calls.map((call) => JSON.stringify(call)).join("\n") + "\n", "utf8");
    const localized = readFileSync(callsPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as TownPlanRecordedCall);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const replayTown = createReplayTownPlanSource(localized);
    const replayed = await runTownJourney(
      "local-replay",
      createUnavailableTestScenarioSource(),
      replayTown,
      "replay"
    );
    replayTown.assertComplete();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(replayed.townPlanTheme).toBe(recorded.townPlanTheme);
    expect(replayed.townLocationId).toBe(recorded.townLocationId);
    expect(replayed.townRequiredBuildingCount).toBe(recorded.townRequiredBuildingCount);
  });

  it("replays the committed real-AI golden fixture (scene + town) with zero network calls", async () => {
    const expected = JSON.parse(
      readFileSync(join(goldenRoot, "expected-summary.json"), "utf8")
    ) as TownJourneySummary;
    const townCalls = readFileSync(join(townPlanFixtureDir, "calls.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as TownPlanRecordedCall);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const scenarioSource = createFixtureScenarioCandidateSource({
      fixtureRoot: scenarioFixtureDir,
      fixtureId: SCENARIO_FIXTURE_ID
    });
    const replayTown = createReplayTownPlanSource(townCalls);
    const report = await runTownJourney("golden-replay", scenarioSource, replayTown, "replay");
    replayTown.assertComplete();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(report.scenarioSource).toBe("generated");
    expect(report.seed).toBe(expected.seed);
    expect(report.sceneLocationCount).toBe(expected.sceneLocationCount);
    expect(report.townLocationCount).toBe(expected.townLocationCount);
    expect(report.townLocationId).toBe(expected.townLocationId);
    expect(report.townPlanSource).toBe("generated");
    expect(report.townPlanTheme).toBe(expected.townPlanTheme);
    expect(report.townDistrictCount).toBe(expected.townDistrictCount);
    expect(report.townRequiredBuildingCount).toBe(expected.townRequiredBuildingCount);
  });

  it.runIf(process.env.RUN_REAL_AI_TOWN_JOURNEY === "1")(
    "records one opt-in real AI journey with a scene+town blueprint and generated town plan",
    async () => {
      const MAX_ATTEMPTS = 6;
      let scenarioCandidate: unknown = null;
      let townCalls: TownPlanRecordedCall[] = [];
      let recordSummary: TownJourneySummary | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS && recordSummary === null; attempt += 1) {
        const candidates: unknown[] = [];
        const scenarioSource = createRecordingScenarioSource(
          createScenarioCandidateSource(process.env),
          (candidate) => { candidates.push(candidate); }
        );
        const calls: TownPlanRecordedCall[] = [];
        const townPlanSource = createRecordingTownPlanSource(createTownPlanSource(process.env), {
          append: (call) => { calls.push(call); }
        });
        try {
          const summary = await runTownJourney(
            `live-record-${attempt}`,
            scenarioSource,
            townPlanSource,
            "record"
          );
          // 只接受单次干净生成（可确定性回放）且 town plan 真实生成的旅程。
          if (summary.scenarioSource !== "generated" || candidates.length !== 1) continue;
          if (summary.townPlanSource !== "generated") continue;
          scenarioCandidate = candidates[0];
          townCalls = calls;
          recordSummary = summary;
        } catch {
          // 蓝图缺 town/scene 或生成失败：重试下一次真实 AI 采样。
          continue;
        }
      }

      if (recordSummary === null || scenarioCandidate === null) {
        throw new Error("real AI did not produce a clean scene+town journey within bounded retries");
      }

      // 立即零网络复放：同候选 + 录制 town plan → 相同小镇，且 fetch 从未调用。
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const replayTown = createReplayTownPlanSource(townCalls);
      const replaySummary = await runTownJourney(
        "live-replay",
        createReplayScenarioSource(scenarioCandidate),
        replayTown,
        "replay"
      );
      replayTown.assertComplete();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      expect(replaySummary.scenarioSource).toBe("generated");
      expect(replaySummary.townPlanSource).toBe("generated");
      expect(replaySummary.townLocationId).toBe(recordSummary.townLocationId);
      expect(replaySummary.townPlanTheme).toBe(recordSummary.townPlanTheme);

      const artifactDir = process.env.TOWN_JOURNEY_ARTIFACT_DIR;
      if (artifactDir === undefined) throw new Error("missing safe town journey artifact directory");
      const artifactScenarioDir = join(artifactDir, "scenario");
      const artifactTownDir = join(artifactDir, "town-plan");
      mkdirSync(artifactScenarioDir, { recursive: true });
      mkdirSync(artifactTownDir, { recursive: true });
      writeFileSync(
        join(artifactScenarioDir, "manifest.json"),
        JSON.stringify({
          contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
          fixtures: [{ id: SCENARIO_FIXTURE_ID, file: "blueprint.json" }]
        }, null, 2) + "\n",
        "utf8"
      );
      writeFileSync(
        join(artifactScenarioDir, "blueprint.json"),
        JSON.stringify({ candidate: scenarioCandidate }, null, 2) + "\n",
        "utf8"
      );
      writeFileSync(
        join(artifactTownDir, "calls.jsonl"),
        townCalls.map((call) => JSON.stringify(call)).join("\n") + "\n",
        "utf8"
      );
      writeFileSync(
        join(artifactTownDir, "manifest.json"),
        JSON.stringify({
          fixtureVersion: TOWN_PLAN_FIXTURE_VERSION,
          contractVersion: TOWN_PLAN_CONTRACT_VERSION,
          origin: "recorded",
          scenarioFixtureId: SCENARIO_FIXTURE_ID,
          callCount: townCalls.length,
          createdAt: fixedNow
        }, null, 2) + "\n",
        "utf8"
      );
      writeFileSync(
        join(artifactDir, "expected-summary.json"),
        JSON.stringify(recordSummary, null, 2) + "\n",
        "utf8"
      );
    },
    1_800_000
  );
});
