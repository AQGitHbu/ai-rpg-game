/** @vitest-environment node */
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { asLocationId, asNpcId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import { createTownPlanFromLocation, townSeedFor } from "@/game/gameplay/rpg/town";
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
import { getCurrentGame } from "./getCurrentGame";
import { performAction } from "./performAction";
import { generatePendingNarrativeScene } from "./generatePendingNarrativeScene";
import { generatePendingTownPlan } from "./generatePendingTownPlan";
import { toDirectorContext, toSceneScriptContext } from "./runtimeNarrativeContexts";
import { TOWN_PLAN_CONTRACT_VERSION, type TownPlanCandidateSource } from "./townPlanGeneration";
import {
  NARRATIVE_CONTRACT_VERSION,
  type DirectorAttempt,
  type DirectorSource,
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
// Town 主循环 S8 回归：离线全旅程 + AI 模式 town 分支。
//
// Phase 14 开场收窄后 createGame 只产出 1 幕起始锚点，fallback 蓝图不再含
// town 地点；本文件改用 makeValidCandidate 运行时扩展蓝图（runtime_expansion），
// 并把 loc_b 标为 scale="town"（从起点 loc_a 直连），经 real SQLite 直接建档，
// 验证同一套 Town 主循环：
//
//   1) 离线：建档(offline) → move 到 loc_b → 小镇同步生成、view 就绪含语义
//      句子 → 结识 npc_b 后其剧情建筑进入 interactiveBuildings → 全新
//      repository reload 一致 → 语义句子进导演/编剧上下文。
//   2) AI：建档(ai) → 续幕叙事 pending（narrative_choice_followup，世界行动后
//      的真实排队触发；首幕对白协议由编排层测试覆盖）→ generatePendingNarrativeScene
//      物化 → 叙事情节选择 move 到 loc_b → townGeneration pending →
//      generatePendingTownPlan 消费 pending 产出就绪小镇 → 语义句子进叙事上下文。
//
// 全程真实临时 SQLite，路径显式注入，零网络。
// ---------------------------------------------------------------------------

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
// loc_b 为 town 地点（含驻留 NPC npc_b），供离线规划派生剧情建筑。
const TOWN_BLUEPRINT: ScenarioBlueprint = {
  ...RUNTIME_BLUEPRINT,
  locations: RUNTIME_BLUEPRINT.locations.map((location) =>
    String(location.id) === "loc_b" ? { ...location, scale: "town" as const } : location
  )
};

const TOWN_LOCATION_ID = "loc_b";
const TOWN_NPC_ID = (() => {
  const location = TOWN_BLUEPRINT.locations.find((l) => l.id === asLocationId(TOWN_LOCATION_ID));
  if (location === undefined || location.npcIds.length === 0) {
    throw new Error("town 地点应含驻留 NPC");
  }
  return String(location.npcIds[0]);
})();
const TOWN_SEED = townSeedFor(TOWN_BLUEPRINT.seed, TOWN_LOCATION_ID);
const TOWN_PLAN_BASELINE = createTownPlanFromLocation(TOWN_BLUEPRINT, TOWN_LOCATION_ID, TOWN_SEED);

const FIXED_CREATED_AT = "2026-07-31T00:00:00.000Z";
const FIXED_ACTION_TIME = "2026-07-31T10:00:00.000Z";
/** AI 分支使用的续幕触发：narrative_choice_followup（对白分支由编排层测试覆盖）。 */
const FOLLOWUP_TRIGGER = {
  kind: "narrative_choice_followup" as const,
  previousChoiceActionKey: "observe:loc_a"
};

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

/** 直接建档：运行时 town 蓝图 + 指定叙事模式的开局状态。 */
async function seedGame(
  repository: SqliteGameRepository,
  gameId: string,
  narrativeMode: "offline" | "ai"
): Promise<void> {
  const initialState: GameState =
    narrativeMode === "offline"
      ? { ...initializeGameState(TOWN_BLUEPRINT), narrative: { currentScene: null, generation: { status: "idle" }, mode: "offline" } }
      : {
          ...initializeGameState(TOWN_BLUEPRINT),
          narrative: {
            currentScene: null,
            generation: {
              status: "pending",
              requestedAt: FIXED_CREATED_AT,
              triggerContext: FOLLOWUP_TRIGGER
            },
            mode: "ai"
          }
        };
  const created = await repository.createInitialGame({
    gameId: asGameId(gameId),
    blueprint: TOWN_BLUEPRINT,
    state: initialState,
    createdAt: FIXED_CREATED_AT
  });
  expect(created).toEqual({ ok: true });
}

// ---------------------------------------------------------------------------
// 离线全旅程
// ---------------------------------------------------------------------------

describe("Town 主循环回归：离线全旅程", () => {
  it("进 town → 小镇就绪含语义句子 → 结识 npc_b 后可交互 → reload 一致 → 语义进叙事上下文", async () => {
    const repository = openRepository("offline-journey");
    await seedGame(repository, "town-offline-journey", "offline");

    const before = await getCurrentGame({ repository });
    if (before.status !== "active") throw new Error("开局存档不可用");
    expect(before.view.townStatus).toBe("none");
    expect(before.view.town).toBeUndefined();

    const moved = await performAction(
      { intent: { type: "move", locationId: asLocationId(TOWN_LOCATION_ID) }, expectedRevision: before.view.revision },
      { repository, now: () => FIXED_ACTION_TIME }
    );
    if (!moved.ok) throw new Error(`进 town 应当成功：${JSON.stringify(moved)}`);

    // 小镇同步生成：view 就绪、语义句子盛行。
    expect(moved.view.townStatus).toBe("ready");
    const town = moved.view.town;
    if (town === undefined) throw new Error("离线 town 视图应当就绪");
    expect(town.planSource).toBe("offline");
    expect(town.semanticView.sentences.length).toBeGreaterThan(0);
    // Phase 14 小镇入口过滤：未结识的 NPC 建筑不进 interactiveBuildings。
    expect(town.interactiveBuildings).toHaveLength(0);

    // 事件账本记录一次 town_plan_generated（offline）。
    const record = await loadActiveRecord(repository);
    expect(record.state.eventLedger.at(-1)).toEqual({
      type: "town_plan_generated",
      locationId: asLocationId(TOWN_LOCATION_ID),
      planSource: "offline",
      occurredAt: FIXED_ACTION_TIME
    });
    expect(record.state.towns).toHaveLength(1);

    // 结识 npc_b 后：其剧情建筑进入 interactiveBuildings。
    const talked = await performAction(
      { intent: { type: "talk", npcId: asNpcId(TOWN_NPC_ID) }, expectedRevision: moved.view.revision },
      { repository, now: () => FIXED_ACTION_TIME }
    );
    if (!talked.ok) throw new Error(`交谈应当成功：${JSON.stringify(talked)}`);
    if (talked.view.town === undefined) throw new Error("交谈后 town 视图应当就绪");
    expect(talked.view.town.interactiveBuildings.some((b) => b.npcIds.includes(TOWN_NPC_ID))).toBe(true);

    // 全新 repository reload：视图逐字段一致（确定性重建）。
    const reloadRepository = openRepository("offline-journey");
    const reloaded = await getCurrentGame({ repository: reloadRepository });
    if (reloaded.status !== "active") throw new Error("reload 存档不可用");
    expect(JSON.stringify(reloaded.view.town)).toBe(JSON.stringify(talked.view.town));

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

/** 极简导演 source：把当前地点候选中指向 loc_b 的 move 作为首选行动推进。 */
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
            { actionKey: target, label: "走向集镇", strategy: "循路线前进，前往集镇" },
            { actionKey: alternative, label: "再作停留", strategy: "留在原地观察当前局势" }
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
      };
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

const narrativeSources = {
  directorSource: createMoveToTownDirector(),
  sceneScriptSource: createEchoSceneScript(),
  npcLineSource: createIdleNpcLine()
};

describe("Town 主循环回归：AI 模式 town fixture 分支", () => {
  it("建档 → 续幕叙事 pending → 物化 → 行动选择进 town → 生成就绪 → 语义进上下文", async () => {
    const repository = openRepository("ai-journey");
    await seedGame(repository, "town-ai-journey", "ai");

    // 开局 AI 存档：narrative pending（narrative_choice_followup 续幕触发）。
    const opened = await loadActiveRecord(repository);
    expect(opened.state.narrative.mode).toBe("ai");
    expect(opened.state.narrative.generation.status).toBe("pending");

    const taskDeps = { repository, newTraceId: () => "ai-town-task", now: () => FIXED_ACTION_TIME, runtimeNarrativeSources: narrativeSources };
    expect(await generatePendingNarrativeScene(taskDeps)).toBe("saved");

    // 续幕 choice 的权威 actionKey 落在存档 scene 上。
    const withSceneRecord = await loadActiveRecord(repository);
    const scene = withSceneRecord.state.narrative.currentScene;
    if (scene === null) throw new Error("续幕应已就绪");
    const moveChoice = scene.choices.find((choice) =>
      choice.actionKey === `move:${TOWN_LOCATION_ID}`
    );
    if (moveChoice === undefined) throw new Error("续幕应提供进 town 的选项");

    // 选择推进：move 到 loc_b → town 置 pending（AI 存档不同步生成）。
    const advanced = await performAction(
      { intent: { type: "narrative_choice", choiceToken: moveChoice.choiceToken }, expectedRevision: withSceneRecord.revision },
      { repository, now: () => FIXED_ACTION_TIME, runtimeNarrativeSources: narrativeSources }
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

    // ensure 用例消费 pending：town-plan fixture 产出就绪小镇。
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
    // Phase 14 入口过滤在 AI 会话同样生效：未结识前 interactiveBuildings 为空。
    expect(town.interactiveBuildings).toHaveLength(0);

    // 语义句子进导演上下文：AI 叙事可引用位置关系。
    const readyRecord = await loadActiveRecord(repository);
    const directorContext = toDirectorContext({ blueprint: readyRecord.blueprint, state: readyRecord.state });
    expect(directorContext.townSpatial).toBeDefined();
    expect(directorContext.townSpatial?.sentences).toEqual(town.semanticView.sentences);
  });
});