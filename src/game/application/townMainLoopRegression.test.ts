/** @vitest-environment node */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { asLocationId, type NewGameInput } from "@/game/domain";
import { createTownPlanFromLocation, townSeedFor } from "@/game/gameplay/rpg/town";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { createGame, type CreateGameDependencies } from "./createGame";
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
import { generatePendingNarrativeScene } from "./generatePendingNarrativeScene";
import { generatePendingTownPlan } from "./generatePendingTownPlan";
import { toDirectorContext, toSceneScriptContext } from "./runtimeNarrativeContexts";
import {
  createUnavailableTestScenarioSource,
  runScenarioPipeline,
  TEST_TRACE_ID
} from "./applicationFixture.testutil";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanCandidateSource } from "./townPlanGeneration";
import {
  NARRATIVE_CONTRACT_VERSION,
  type DirectorAttempt,
  type DirectorSource,
  type NpcLineAttempt,
  type NpcLineSource,
  type SceneScriptAttempt,
  type SceneScriptSource
} from "./runtimeNarrative";
import {
  asGameId,
  type GameRecord,
  type GameRepository
} from "./server/persistence/gameRepository";
import { createSqliteClient } from "./server/persistence/sqliteClient";
import {
  createSqliteGameRepository,
  type SqliteGameRepository
} from "./server/persistence/sqliteGameRepository";

// ---------------------------------------------------------------------------
// Town 主循环 S8 回归：离线全旅程 + AI 模式 town fixture 分支。
//
// 开局一律走确定性 fallback 管线（createUnavailableTestScenarioSource），
// fallback 蓝图的 loc_2 固定为 scale="town" 且从起点 loc_1 直连（见
// createFallbackBlueprint），因此旅程「进 town」是稳定路径。
//
// 覆盖：
//   1) 离线：创建(offline) → move 到 loc_2 → 小镇同步生成、view 就绪含剧情
//      建筑与语义句子 → 全新 repository reload 一致 → 语义句子进导演/编剧上下文。
//   2) AI：创建(ai) → 首幕叙事就绪 → 选择推进 move 到 loc_2 → townGeneration
//      pending → generatePendingTownPlan 消费 pending 产出就绪小镇 → 语义句子
//      进叙事上下文。AI town 生成走独立 town-plan source，与叙事录制解耦，
//      故落在本专用回归而非 phase10 黄金旅程，避免与黄金 fixture 耦合。
//
// 全程真实临时 SQLite，路径显式注入，零网络。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const BASELINE = runScenarioPipeline(FIXTURE.input, FIXTURE.seed);

const TOWN_LOCATION_ID = "loc_2";
const TOWN_SEED = townSeedFor(BASELINE.blueprint.seed, TOWN_LOCATION_ID);
const TOWN_PLAN_BASELINE = createTownPlanFromLocation(BASELINE.blueprint, TOWN_LOCATION_ID, TOWN_SEED);

const FIXED_CREATED_AT = "2026-07-31T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-31T10:00:00.000Z";

const RUN_ROOT = join(resolve("tmp"), `town-mainloop-regression-${Date.now()}-${process.pid}`);
mkdirSync(RUN_ROOT, { recursive: true });
const openedRepositories: SqliteGameRepository[] = [];

function openRepository(name: string): SqliteGameRepository {
  const repository = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(join(RUN_ROOT, `${name}.sqlite`)),
    logError: () => {}
  });
  openedRepositories.push(repository);
  return repository;
}

afterAll(async () => {
  for (const repository of openedRepositories) {
    try {
      await repository.close();
    } catch {
      /* 已关闭 */
    }
  }
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* Windows 句柄未释放时留待下次运行清理 */
  }
});

async function loadActiveRecord(repository: GameRepository): Promise<GameRecord> {
  const loaded = await repository.getCurrentGame();
  if (!loaded.ok || loaded.status !== "active") {
    throw new Error(`期望 active 存档，实际：${JSON.stringify(loaded)}`);
  }
  return loaded.record;
}

function createDeps(
  repository: GameRepository,
  gameId: string,
  overrides: Partial<CreateGameDependencies> = {}
): CreateGameDependencies {
  return {
    repository,
    newGameId: () => asGameId(gameId),
    newSeed: () => FIXTURE.seed,
    now: () => FIXED_CREATED_AT,
    scenarioCandidateSource: createUnavailableTestScenarioSource(),
    newTraceId: () => TEST_TRACE_ID,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 离线全旅程
// ---------------------------------------------------------------------------

describe("Town 主循环回归：离线全旅程", () => {
  it("进 town → 小镇就绪含剧情建筑与语义句子 → reload 一致 → 语义进叙事上下文", async () => {
    const repository = openRepository("offline-journey");
    const created = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createDeps(repository, "town-offline-journey", { runtimeNarrativeMode: "offline" })
    );
    expect(created.ok).toBe(true);

    const before = await getCurrentGame({ repository });
    if (before.status !== "active") throw new Error("开局存档不可用");
    expect(before.view.townStatus).toBe("none");
    expect(before.view.town).toBeUndefined();

    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId(TOWN_LOCATION_ID) }, expectedRevision: before.view.revision },
      { repository, now: () => FIXED_ACTION_TIME }
    );
    if (!moved.ok) throw new Error(`进 town 应当成功：${JSON.stringify(moved)}`);

    // 小镇同步生成：view 就绪、剧情建筑与语义句子俱在。
    expect(moved.view.townStatus).toBe("ready");
    const town = moved.view.town;
    if (town === undefined) throw new Error("离线 town 视图应当就绪");
    expect(town.planSource).toBe("offline");
    expect(town.interactiveBuildings.length).toBeGreaterThan(0);
    expect(town.semanticView.sentences.length).toBeGreaterThan(0);
    // 剧情建筑必与蓝图 NPC 反查绑定。
    for (const building of town.interactiveBuildings) {
      expect(building.npcIds.length).toBeGreaterThan(0);
    }

    // 事件账本记录一次 town_plan_generated（offline）。
    const record = await loadActiveRecord(repository);
    expect(record.state.eventLedger.at(-1)).toMatchObject({
      type: "town_plan_generated",
      planSource: "offline"
    });
    expect(record.state.towns).toHaveLength(1);

    // 全新 repository reload：视图逐字段一致（确定性重建）。
    const reloadRepository = openRepository("offline-journey");
    const reloaded = await getCurrentGame({ repository: reloadRepository });
    if (reloaded.status !== "active") throw new Error("reload 存档不可用");
    expect(JSON.stringify(reloaded.view.town)).toBe(JSON.stringify(town));

    // 语义句子进导演与编剧上下文（AI 叙事可引用位置关系）。
    const directorContext = toDirectorContext({ blueprint: record.blueprint, state: record.state });
    expect(directorContext.townSpatial).toBeDefined();
    expect(directorContext.townSpatial?.sentences).toEqual(town.semanticView.sentences);
    const sceneContext = toSceneScriptContext({
      blueprint: record.blueprint,
      state: record.state,
      plan: {
        sceneGoal: "探查小镇",
        tensionLevel: 2,
        focusNpcId: null,
        relevantFactIds: [],
        allowedRevealFactIds: [],
        suggestedActionKeys: [`observe:${TOWN_LOCATION_ID}`, `observe:${TOWN_LOCATION_ID}`],
        introducedEntities: [],
        pacing: "develop",
        proposedNewLocations: [],
        proposedNewNpcs: []
      }
    });
    expect(sceneContext.townSpatial?.townName.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AI 模式 town fixture 分支
// ---------------------------------------------------------------------------

/** 极简导演 source：把当前地点候选中指向 loc_2 的 move 作为首选行动推进。 */
function createMoveToTownDirector(): DirectorSource {
  return {
    async generate(request) {
      const context = request.context as {
        actionCandidates: readonly { actionKey: string; kind: string; label: string }[];
      };
      const target = context.actionCandidates.find((candidate) =>
        candidate.actionKey === `move:${TOWN_LOCATION_ID}`
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
            category: "reference_broken"
          }
        } satisfies DirectorAttempt;
      }
      return {
        ok: true,
        provenance: "generated",
        plan: {
          sceneGoal: "循世界规则推进：走向那座集镇",
          tensionLevel: 2,
          focusNpcId: null,
          relevantFactIds: [],
          allowedRevealFactIds: [],
          suggestedActionKeys: [target.actionKey, alternative.actionKey],
          introducedEntities: [{ kind: "location", id: TOWN_LOCATION_ID }],
          pacing: "develop",
        proposedNewLocations: [],
        proposedNewNpcs: []
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "candidate_received"
        }
      } satisfies DirectorAttempt;
    }
  };
}

function createEchoSceneScript(): SceneScriptSource {
  return {
    async generate(request) {
      const context = request.context as {
        plan: { suggestedActionKeys: readonly [string, string] };
      };
      const [target, alternative] = context.plan.suggestedActionKeys;
      return {
        ok: true,
        provenance: "generated",
        script: {
          narration: "路在脚下延伸，集镇的轮廓已在前方浮现。",
          usedFactIds: [],
          npcInstruction: null,
          choices: [
            { actionKey: target, label: "走向集镇", strategy: "推进主线" },
            { actionKey: alternative, label: "再作停留", strategy: "暂缓" }
          ]
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "candidate_received"
        }
      } satisfies SceneScriptAttempt;
    }
  };
}

function createIdleNpcLine(): NpcLineSource {
  return {
    async generate(request) {
      return {
        ok: true,
        provenance: "generated",
        performance: { text: "……", usedFactIds: [], emotion: "neutral" },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "candidate_received"
        }
      } satisfies NpcLineAttempt;
    }
  };
}

/** town-plan fixture source：首次即返回合法候选（baseline 换主题），必过校验。 */
function createTownPlanFixtureSource(): TownPlanCandidateSource {
  return {
    async generate() {
      return {
        ok: true,
        contractVersion: TOWN_PLAN_CONTRACT_VERSION,
        origin: "fixture",
        candidate: { ...TOWN_PLAN_BASELINE, theme: "AI 规划的集镇" },
        diagnostics: []
      };
    }
  };
}

describe("Town 主循环回归：AI 模式 town fixture 分支", () => {
  it("首幕就绪 → 选择进 town → townGeneration pending → 生成就绪 → 语义进上下文", async () => {
    const repository = openRepository("ai-journey");
    const sources = {
      directorSource: createMoveToTownDirector(),
      sceneScriptSource: createEchoSceneScript(),
      npcLineSource: createIdleNpcLine()
    };

    const created = await createGame(
      { input: FIXTURE.input, seed: FIXTURE.seed },
      createDeps(repository, "town-ai-journey", { runtimeNarrativeSources: sources })
    );
    expect(created.ok).toBe(true);

    // 开局 AI 存档：narrative pending。先物化首幕（loc_1）。
    const opened = await loadActiveRecord(repository);
    expect(opened.state.narrative.mode).toBe("ai");
    expect(opened.state.narrative.generation.status).toBe("pending");

    const taskDeps = { repository, newTraceId: () => "ai-town-task", now: () => FIXED_ACTION_TIME, runtimeNarrativeSources: sources };
    expect(await generatePendingNarrativeScene(taskDeps)).toBe("saved");

    // 首幕 choice 的权威 actionKey 落在存档 scene 上（视图对客户端脱敏）。
    const withSceneRecord = await loadActiveRecord(repository);
    const scene = withSceneRecord.state.narrative.currentScene;
    if (scene === null) throw new Error("首幕应已就绪");
    const moveChoice = scene.choices.find((choice) =>
      choice.actionKey === `move:${TOWN_LOCATION_ID}`
    );
    if (moveChoice === undefined) throw new Error("首幕应提供进 town 的选项");

    // 选择推进：move 到 loc_2 → town 置 pending（AI 存档不同步生成）。
    const advanced = await performAction(
      { intent: { type: "narrative_choice", choiceToken: moveChoice.choiceToken }, expectedRevision: withSceneRecord.revision },
      { repository, now: () => FIXED_ACTION_TIME, runtimeNarrativeSources: sources }
    );
    if (!advanced.ok) throw new Error(`叙事选择应当成功：${JSON.stringify(advanced)}`);
    expect(advanced.view.townStatus).toBe("pending");
    expect(advanced.view.town).toBeUndefined();

    const pendingRecord = await loadActiveRecord(repository);
    expect(pendingRecord.state.townGeneration).toMatchObject({
      status: "pending",
      locationId: asLocationId(TOWN_LOCATION_ID)
    });
    expect(pendingRecord.state.towns).toHaveLength(0);

    // ensure 用例消费 pending：town-plan fixture source 产出就绪小镇。
    const townTaskDeps = {
      repository,
      newTraceId: () => "ai-town-plan-task",
      now: () => FIXED_ACTION_TIME,
      townPlanSource: createTownPlanFixtureSource()
    };
    expect(await generatePendingTownPlan(townTaskDeps)).toBe("saved");

    const ready = await getCurrentGame({ repository });
    if (ready.status !== "active") throw new Error("就绪视图不可用");
    expect(ready.view.townStatus).toBe("ready");
    const town = ready.view.town;
    if (town === undefined) throw new Error("AI town 视图应当就绪");
    expect(town.planSource).toBe("generated");
    // AI 候选主题经 generateTown 编译进权威快照（脱敏后仍保留 plan）。
    expect(town.snapshot.plan.theme).toBe("AI 规划的集镇");
    expect(town.semanticView.sentences.length).toBeGreaterThan(0);

    // 语义句子进导演上下文：AI 叙事可引用位置关系。
    const readyRecord = await loadActiveRecord(repository);
    const directorContext = toDirectorContext({ blueprint: readyRecord.blueprint, state: readyRecord.state });
    expect(directorContext.townSpatial).toBeDefined();
    expect(directorContext.townSpatial?.sentences).toEqual(town.semanticView.sentences);
  });
});
