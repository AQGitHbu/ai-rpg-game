/** @vitest-environment node */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { locationScaleOf, type GameState, type ScenarioBlueprint } from "@/game/domain";
import {
  compileScenarioBlueprint,
  initializeGameState,
  validateScenarioBlueprintCandidate
} from "@/game/gameplay/rpg/scenario";
import {
  makeValidCandidate,
  TEST_POLICY,
  TEST_PROFILE
} from "@/game/gameplay/rpg/scenario/scenarioBlueprintFixture.testutil";
import { generatePendingTownPlan } from "../generatePendingTownPlan";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanCandidateSource } from "../townPlanGeneration";
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
import { createTownPlanSource } from "../server/ai/townPlanSourceFactory";
import { createTownPlanFixtureSource } from "../server/ai/townPlanFixtureSource";
import {
  TOWN_PLAN_FIXTURE_VERSION,
  createRecordingTownPlanSource,
  createReplayTownPlanSource,
  type TownPlanRecordedCall
} from "../server/ai/townPlanRecording";
import { prepareTmpRunDir } from "./tmpRunDir.testutil";

// ---------------------------------------------------------------------------
// Town 层：小镇规划的录制/回放旅程。
// Phase 14：开场收窄后 createGame 只产出 1 幕起始锚点，不再直接产出
// scene+town 蓝图；本文件改用 makeValidCandidate 运行时扩展蓝图
// （runtime_expansion，loc_b 标为 town，含 4 个 scene 地点），经 real SQLite
// 直接建档，验证 town-plan 录制/回放管线：
//   1. 本地 record→replay：fixture town-plan source 录制一条调用，立即零网络
//      回放——同蓝图 + 同 seed ⇒ 同小镇；
//   2. 提交的 golden 小镇规划回放：fixtureScenarioCandidate 缯宝——
//      replay 已提交 town-plan 录制条目，始终运行、零网络 + drift 断言；
//   3. opt-in 真实 AI 录制（RUN_REAL_AI_TOWN_JOURNEY=1）：复用真实
//      townPlanSource（provider），有界重试到真实生成成功，落盘 fixture 供 (2) 复用。
// 录制物只含已解析候选：绝不落 prompt、模型原文或密钥。
// ---------------------------------------------------------------------------

const goldenRoot = resolve("data", "fixtures", "town-journey", "v1");
const townPlanFixtureDir = join(goldenRoot, "town-plan");
const TOWN_JOURNEY_SUMMARY_VERSION = "town-journey-summary-v2" as const;
const fixedNow = "2026-07-31T08:00:00.000Z";

function compileRuntimeBlueprint(): ScenarioBlueprint {
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(makeValidCandidate(), {
      profile: TEST_PROFILE,
      policy: TEST_POLICY,
      phase: "runtime_expansion"
    })
  );
  if (!compiled.ok) {
    throw new Error(`fixture 蓝图应当合法：${JSON.stringify(compiled.issues)}`);
  }
  return compiled.blueprint;
}

const RUNTIME_BLUEPRINT = compileRuntimeBlueprint();
// loc_b 已标 town（运行时蓝图中 loc_b 含 npc_b，离线规划可派生剧情建筑）。
const TOWN_BLUEPRINT: ScenarioBlueprint = {
  ...RUNTIME_BLUEPRINT,
  locations: RUNTIME_BLUEPRINT.locations.map((location) =>
    String(location.id) === "loc_b" ? { ...location, scale: "town" as const } : location
  )
};

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

/**
 * 一次完整 town 旅程：runtime 扩展蓝图（含 town）直接建档 → 置 town pending →
 * generatePendingTownPlan 消费 → 汇总。蓝图缺 scene 或 town 时抛错（契约回归
 * 提示），真实 AI 用例仍可用有界重试包装。
 */
async function runTownJourney(
  name: string,
  townPlanSource: TownPlanCandidateSource,
  mode: "record" | "replay"
): Promise<TownJourneySummary> {
  const repository = openRepository(name);
  const state: GameState = {
    ...initializeGameState(TOWN_BLUEPRINT),
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "offline" },
  };
  const created = await repository.createInitialGame({
    gameId: asGameId(`town-ai-journey-${name}`),
    blueprint: TOWN_BLUEPRINT,
    state,
    createdAt: fixedNow,
  });
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
  it("records the town plan locally over the runtime-expansion blueprint and replays with zero network", async () => {
    const calls: TownPlanRecordedCall[] = [];
    const recordingTown = createRecordingTownPlanSource(createTownPlanFixtureSource(), {
      append: (call) => { calls.push(call); }
    });
    const recorded = await runTownJourney(
      "local-record",
      recordingTown,
      "record"
    );
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

  it("replays the committed golden town-plan fixture with zero network calls", async () => {
    const expected = JSON.parse(
      readFileSync(join(goldenRoot, "expected-summary.json"), "utf8")
    ) as TownJourneySummary;
    const townCalls = readFileSync(join(townPlanFixtureDir, "calls.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as TownPlanRecordedCall);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const replayTown = createReplayTownPlanSource(townCalls);
    const report = await runTownJourney("golden-replay", replayTown, "replay");
    replayTown.assertComplete();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(report.version).toBe(expected.version);
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
    "records one opt-in real AI town journey and replays it with zero network",
    async () => {
      const MAX_ATTEMPTS = 6;
      let townCalls: TownPlanRecordedCall[] = [];
      let recordSummary: TownJourneySummary | null = null;

      for (let attempt = 0; attempt < MAX_ATTEMPTS && recordSummary === null; attempt += 1) {
        const calls: TownPlanRecordedCall[] = [];
        const townPlanSource = createRecordingTownPlanSource(createTownPlanSource(process.env), {
          append: (call) => { calls.push(call); }
        });
        try {
          const summary = await runTownJourney(
            `live-record-${attempt}`,
            townPlanSource,
            "record"
          );
          // 只接受单次干净生成（可确定性回放）且 town plan 真实生成的旅程。
          if (summary.townPlanSource !== "generated") continue;
          townCalls = calls;
          recordSummary = summary;
        } catch {
          // provider 故障/小镇派生异常：重试下一次真实采样。
          continue;
        }
      }

      if (recordSummary === null) {
        throw new Error("real AI town plan provider did not produce a clean plan within bounded retries");
      }

      // 立即零网络复放：录制 town plan → 相同小镇，且 fetch 从未调用。
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const replayTown = createReplayTownPlanSource(townCalls);
      const replaySummary = await runTownJourney(
        "live-replay",
        replayTown,
        "replay"
      );
      replayTown.assertComplete();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      expect(replaySummary.townPlanSource).toBe("generated");
      expect(replaySummary.townLocationId).toBe(recordSummary.townLocationId);
      expect(replaySummary.townPlanTheme).toBe(recordSummary.townPlanTheme);

      const artifactDir = process.env.TOWN_JOURNEY_ARTIFACT_DIR;
      if (artifactDir === undefined) throw new Error("missing safe town journey artifact directory");
      const artifactTownDir = join(artifactDir, "town-plan");
      mkdirSync(artifactTownDir, { recursive: true });
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