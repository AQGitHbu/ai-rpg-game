import { describe, expect, it } from "vitest";
import { asNpcId, type GameState, type NewGameInput } from "@/game/domain";
import { classifyFreeDialogue } from "@/game/gameplay/rpg/actions";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";
import { handleNpcDialogue, type HandleNpcDialogueDependencies } from "./handleNpcDialogue";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";
import {
  createFakeGameRepository,
  runScenarioPipeline,
  TEST_CREATED_AT,
  TEST_GAME_ID
} from "./applicationFixture.testutil";
import { type GameRecord } from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// handleNpcDialogue use case 契约测试（spec §5.2/5.3）。
// 闲聊路径零 CAS 写入；叙事路径单次 CAS 写入 pending + playerNpcChat；
// offline / canQueue=false 降级为闲聊；pending / stale 复用既有拒绝语义。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline({ ...FIXTURE.input, gameLength: "short" }, FIXTURE.seed);

const FIXED_TIME = "2026-07-27T10:00:00.000Z";
// npc_1 位于开局地点 loc_1；含探索动词「去」⇒ 分类为 narrative。
const NARRATIVE_TEXT = "我想出去走走，去外面看一眼";
// 无任务关键词/实体名/探索动词且 ≥4 字 ⇒ 分类为 chat。
const CHAT_TEXT = "今天天气真不错啊";

function buildActiveRecord(): GameRecord {
  return {
    gameId: TEST_GAME_ID,
    blueprint: PIPELINE.blueprint,
    state: PIPELINE.state,
    revision: 0,
    createdAt: TEST_CREATED_AT
  };
}

/** 三个 generate 都抛错：handleNpcDialogue 本身绝不能调用 AI source。 */
function fakeNarrativeSources() {
  return {
    directorSource: {
      async generate(): Promise<never> {
        throw new Error("handleNpcDialogue 不得调用 directorSource");
      }
    },
    sceneScriptSource: {
      async generate(): Promise<never> {
        throw new Error("handleNpcDialogue 不得调用 sceneScriptSource");
      }
    },
    npcLineSource: {
      async generate(): Promise<never> {
        throw new Error("handleNpcDialogue 不得调用 npcLineSource");
      }
    }
  };
}

function buildDeps(
  repository: ReturnType<typeof createFakeGameRepository>,
  overrides: Partial<HandleNpcDialogueDependencies> = {}
): HandleNpcDialogueDependencies {
  return {
    repository,
    now: () => FIXED_TIME,
    runtimeNarrativeSources: fakeNarrativeSources(),
    ...overrides
  };
}

describe("handleNpcDialogue", () => {
  it("闲聊输入 → 返回 chat，零 CAS 写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    // 前置：确认输入确实分类为 chat。
    expect(classifyFreeDialogue(record.blueprint, record.state, asNpcId("npc_1"), CHAT_TEXT)).toBe("chat");

    const result = await handleNpcDialogue(
      { npcId: asNpcId("npc_1"), text: CHAT_TEXT, expectedRevision: 0 },
      buildDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("chat");
    if (result.kind !== "chat") return;
    expect(result.npcSpeech.length).toBeGreaterThan(0);
    expect(result.view.revision).toBe(0);
    // 闲聊路径零写入。
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("叙事触发输入 → 返回 narrative_trigger，CAS 写入 pending + playerNpcChat", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });
    // 前置：确认输入分类为 narrative 且当前状态允许排队。
    expect(classifyFreeDialogue(record.blueprint, record.state, asNpcId("npc_1"), NARRATIVE_TEXT)).toBe("narrative");
    expect(canQueueRuntimeNarrativeScene(record.blueprint, record.state)).toBe(true);

    const pendingState: GameState = {
      ...record.state,
      narrative: {
        currentScene: null,
        generation: { status: "pending", requestedAt: FIXED_TIME },
        mode: "ai"
      }
    };
    repository.setApplyResult({ ok: true, record: { ...record, state: pendingState, revision: 1 } });

    const result = await handleNpcDialogue(
      { npcId: asNpcId("npc_1"), text: NARRATIVE_TEXT, expectedRevision: 0 },
      buildDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("narrative_trigger");
    expect(repository.applyCalls).toHaveLength(1);
    const saved = repository.applyCalls[0].nextState;
    expect(saved.narrative.currentScene).toBeNull();
    expect(saved.narrative.generation.status).toBe("pending");
    if (saved.narrative.generation.status !== "pending") return;
    expect(saved.narrative.generation.requestedAt).toBe(FIXED_TIME);
    // playerNpcChat 快照随 pending 变体写入：npcName/npcRole 从蓝图查表填充。
    const npc = record.blueprint.npcs.find((n) => String(n.id) === "npc_1");
    expect(saved.narrative.generation.playerNpcChat).toEqual({
      npcId: asNpcId("npc_1"),
      playerText: NARRATIVE_TEXT,
      npcName: npc?.name,
      npcRole: npc?.role
    });
    // 负向验收（spec §10 第 10 条）：自由输入不经过 resolveAction，
    // 不产生 npc_met 事件、不改变 met 状态。
    expect(saved.npcs).toEqual(record.state.npcs);
    expect(saved.eventLedger).toEqual(record.state.eventLedger);
  });

  it("已有 pending → ACTION_REJECTED，零写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    const pendingRecord: GameRecord = {
      ...record,
      state: {
        ...record.state,
        narrative: {
          currentScene: null,
          generation: { status: "pending", requestedAt: FIXED_TIME },
          mode: "ai"
        }
      }
    };
    repository.setCurrentResult({ ok: true, status: "active", record: pendingRecord });

    const result = await handleNpcDialogue(
      { npcId: asNpcId("npc_1"), text: NARRATIVE_TEXT, expectedRevision: 0 },
      buildDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("stale revision → STALE_GAME_REVISION，零写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await handleNpcDialogue(
      { npcId: asNpcId("npc_1"), text: CHAT_TEXT, expectedRevision: 7 },
      buildDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE_GAME_REVISION");
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("offline 模式叙事输入降级为 chat，零写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    const offlineRecord: GameRecord = {
      ...record,
      state: {
        ...record.state,
        narrative: { ...record.state.narrative, mode: "offline" }
      }
    };
    repository.setCurrentResult({ ok: true, status: "active", record: offlineRecord });

    const result = await handleNpcDialogue(
      { npcId: asNpcId("npc_1"), text: NARRATIVE_TEXT, expectedRevision: 0 },
      buildDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("chat");
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("canQueueRuntimeNarrativeScene=false 时叙事输入降级为 chat，零写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    // 收缩合法行动：全部事实已发现、全部 NPC 已结识、当前地点已观察
    // ⇒ 只剩 move 一个合法行动（<2），排队资格为 false。
    const sparseState: GameState = {
      ...record.state,
      worldFacts: record.state.worldFacts.map((fact) => ({ ...fact, discovered: true })),
      npcs: record.state.npcs.map((npc) => ({ ...npc, met: true })),
      eventLedger: [
        ...record.state.eventLedger,
        {
          type: "location_observed" as const,
          locationId: record.state.currentLocationId,
          occurredAt: FIXED_TIME
        }
      ]
    };
    repository.setCurrentResult({
      ok: true,
      status: "active",
      record: { ...record, state: sparseState }
    });
    // 前置：分类仍为 narrative，但排队资格为 false。
    expect(classifyFreeDialogue(record.blueprint, sparseState, asNpcId("npc_1"), NARRATIVE_TEXT)).toBe("narrative");
    expect(canQueueRuntimeNarrativeScene(record.blueprint, sparseState)).toBe(false);

    const result = await handleNpcDialogue(
      { npcId: asNpcId("npc_1"), text: NARRATIVE_TEXT, expectedRevision: 0 },
      buildDeps(repository)
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("chat");
    expect(repository.applyCalls).toHaveLength(0);
  });

  it("NPC ID 不在蓝图中 → ACTION_REJECTED，零写入", async () => {
    const repository = createFakeGameRepository();
    const record = buildActiveRecord();
    repository.setCurrentResult({ ok: true, status: "active", record });

    const result = await handleNpcDialogue(
      { npcId: asNpcId("npc_nonexistent"), text: CHAT_TEXT, expectedRevision: 0 },
      buildDeps(repository)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(repository.applyCalls).toHaveLength(0);
  });
});
