import { describe, expect, it } from "vitest";
import type { GameState, NewGameInput } from "@/game/domain";
import { asNpcId } from "@/game/domain";
import {
  asGameId,
  type ApplyResolvedActionInput,
  type GameRecord,
  type GameRepository,
} from "./server/persistence/gameRepository";
import { generatePendingNarrativeScene } from "./generatePendingNarrativeScene";
import { NARRATIVE_CONTRACT_VERSION } from "./runtimeNarrative";
import { toDirectorContext } from "./runtimeNarrativeContexts";
import { runScenarioPipeline } from "./applicationFixture.testutil";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";

type Phase1Fixture = { input: NewGameInput; seed: string };
const fixture = wuxiaFixture as unknown as Phase1Fixture;

function pendingRecord(): GameRecord {
  const { blueprint, state } = runScenarioPipeline(fixture.input, fixture.seed);
  return {
    gameId: asGameId("pending-narrative-test"),
    blueprint,
    state: {
      ...state,
      narrative: {
        currentScene: null,
        generation: { status: "pending", requestedAt: "2026-07-30T08:00:00.000Z" },
        mode: "ai",
      },
    },
    revision: 4,
    createdAt: "2026-07-30T08:00:00.000Z",
  };
}

function unavailableSources() {
  return {
    directorSource: {
      async generate() {
        return {
          ok: false as const,
          provenance: "unavailable" as const,
          category: "service_error" as const,
          diagnostics: {
            traceId: "test", contractVersion: NARRATIVE_CONTRACT_VERSION,
            stage: "failed" as const, category: "service_error" as const,
          },
        };
      },
    },
    sceneScriptSource: {
      async generate() {
        throw new Error("scene writer must not run after director fallback");
      },
    },
    npcLineSource: {
      async generate() {
        throw new Error("npc performer must not run after director fallback");
      },
    },
  };
}

function repositoryFor(record: GameRecord, apply?: (input: ApplyResolvedActionInput) => void): GameRepository {
  let current = record;
  return {
    async createInitialGame() { return { ok: true }; },
    async getCurrentGame() { return { ok: true as const, status: "active" as const, record: current }; },
    async applyResolvedAction(input) {
      apply?.(input);
      current = { ...current, state: input.nextState, revision: current.revision + 1 };
      return { ok: true as const, record: current };
    },
    async applyBlueprintExpansion(input) {
      current = { ...current, blueprint: input.nextBlueprint, state: input.nextState, revision: current.revision + 1 };
      return { ok: true as const, record: current };
    },
  };
}

describe("generatePendingNarrativeScene", () => {
  it("持久化 pending 场景，并在 AI 不可用时保存受控 fallback", async () => {
    const writes: ApplyResolvedActionInput[] = [];
    const result = await generatePendingNarrativeScene({
      repository: repositoryFor(pendingRecord(), (input) => writes.push(input)),
      newTraceId: () => "task-trace-1",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("saved");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expectedRevision).toBe(4);
    expect(writes[0]?.nextState.narrative.generation).toEqual({ status: "idle" });
    expect(writes[0]?.nextState.narrative.currentScene?.source).toBe("fallback");
  });

  it("编排阶段抛出异常时也保存 fallback，避免 pending 无限重试", async () => {
    const writes: ApplyResolvedActionInput[] = [];
    const result = await generatePendingNarrativeScene({
      repository: repositoryFor(pendingRecord(), (input) => writes.push(input)),
      newTraceId: () => "task-trace-throws",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: {
        directorSource: {
          async generate() {
            throw new Error("provider adapter crashed");
          },
        },
        sceneScriptSource: { async generate() { throw new Error("not reached"); } },
        npcLineSource: { async generate() { throw new Error("not reached"); } },
      },
    });

    expect(result).toBe("saved");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.nextState.narrative.generation).toEqual({ status: "idle" });
    expect(writes[0]?.nextState.narrative.currentScene?.source).toBe("fallback");
  });

  it("不是 pending 时零调用 AI、零写入，允许恢复端点安全重复调用", async () => {
    const record = pendingRecord();
    const readyState: GameState = {
      ...record.state,
      narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    };
    let writes = 0;
    const repository = repositoryFor({ ...record, state: readyState }, () => { writes += 1; });
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "unused",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("not_pending");
    expect(writes).toBe(0);
  });

  it("对话回应 followup 桥接：pending 携带 dialogue_response 触发且 currentScene 为 followup 时正常续生成", async () => {
    // performAction 在 followup 被消费时保留 followup 为 currentScene 并排队后继场景
    // （triggerContext.kind === "dialogue_response"）。生成器必须能继续推进，否则玩家
    // 卡死在被拒绝的 ACTION_REJECTED 上。此处用 fallback 源验证守护被放行。
    const base = pendingRecord();
    const bridgeRecord: GameRecord = {
      ...base,
      state: {
        ...base.state,
        narrative: {
          currentScene: {
            sceneId: "followup-scene",
            turn: 1,
            narration: "对方似乎还有话没有说完。",
            usedFactIds: [],
            npcLine: { npcId: asNpcId("npc_1"), text: "事情并不像表面那么简单。", emotion: "guarded", usedFactIds: [] },
            choices: [
              { choiceToken: "f1", label: "继续追问", choiceKind: "dialogue_response", dialogueIntent: "ask_more", actionKey: "dialogue:f1" },
              { choiceToken: "f2", label: "暂且告辞", choiceKind: "dialogue_response", dialogueIntent: "leave", actionKey: "dialogue:f2" },
            ],
            source: "generated",
          },
          generation: {
            status: "pending",
            requestedAt: "2026-07-30T08:00:00.000Z",
          triggerContext: { kind: "dialogue_response", npcId: asNpcId("npc_1"), dialogueIntent: "ask_more", playerText: "哦？" },
          },
          mode: "ai",
        },
      },
    };
    const repository = repositoryFor(bridgeRecord);
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "followup-bridge",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("saved");
    const saved = await repository.getCurrentGame();
    if (!saved.ok || saved.status !== "active") throw new Error("期望 active 存档");
    expect(saved.record.state.narrative.generation.status).toBe("idle");
    // 后继场景覆盖 followup，玩家可以继续行动而不是卡死。
    expect(saved.record.state.narrative.currentScene?.source).toBe("fallback");
  });

  it("pending 但 currentScene 非 followup 桥时仍返回 not_pending", async () => {
    const record = pendingRecord();
    const bridgeRecord: GameRecord = {
      ...record,
      state: {
        ...record.state,
        narrative: {
          currentScene: { sceneId: "mid", turn: 1, narration: "进行中", usedFactIds: [], npcLine: null, choices: [{ choiceToken: "c", label: "继续", actionKey: "x" }, { choiceToken: "d", label: "离开", actionKey: "y" }], source: "generated" },
          generation: { status: "pending", requestedAt: "2026-07-30T08:00:00.000Z" },
          mode: "ai",
        },
      },
    };
    let writes = 0;
    const repository = repositoryFor(bridgeRecord, () => { writes += 1; });
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "non-bridge",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("not_pending");
    expect(writes).toBe(0);
  });
});

describe("generatePendingNarrativeScene：Phase 11 场景提交事件与记忆原子写入", () => {
  it("ready 场景应用后：narrative_scene_presented 事件、memory、currentScene 与 cleared pending 同一次写入", async () => {
    const repository = repositoryFor(pendingRecord());
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "phase11-scene",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("saved");
    const record = await repository.getCurrentGame();
    if (!record.ok || record.status !== "active") throw new Error("期望 active 存档");
    // 提交事件落在 ledger 末尾，且只携带结构索引。
    const last = record.record.state.eventLedger.at(-1);
    expect(last?.type).toBe("narrative_scene_presented");
    if (last?.type === "narrative_scene_presented") {
      expect(last.sceneId).toBe(record.record.state.narrative.currentScene?.sceneId);
      expect(last.locationId).toBe(record.record.state.currentLocationId);
      expect(last.occurredAt).toBe("2026-07-31T01:02:03.000Z");
      expect(Object.keys(last).sort()).toEqual([
        "focusNpcId", "locationId", "occurredAt", "pacing", "revealedFactIds", "sceneId", "type"
      ]);
    }
    // memory 与 ledger 同步；场景就绪（currentScene 设置即视图 ready），pending 已清。
    expect(record.record.state.storyMemory?.reducedThroughEventCount).toBe(record.record.state.eventLedger.length);
    expect(record.record.state.narrative.currentScene).not.toBeNull();
    expect(record.record.state.narrative.generation.status).toBe("idle");
  });

  it("apply 命中 STALE 时：场景事件被丢弃、memory 与旧 state 不变", async () => {
    const pending = pendingRecord();
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() {
        return { ok: true as const, status: "active" as const, record: pending };
      },
      async applyResolvedAction() {
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      },
      async applyBlueprintExpansion() {
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      },
    };
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "phase11-stale",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("stale");
    const record = await repository.getCurrentGame();
    if (!record.ok || record.status !== "active") throw new Error("期望 active 存档");
    // 陈旧写入被整体丢弃：事件未追加、memory 未推进。
    expect(record.record.state.eventLedger.at(-1)?.type).not.toBe("narrative_scene_presented");
    expect(record.record.state.storyMemory?.reducedThroughEventCount).toBe(0);
    expect(record.record.state.narrative.generation.status).toBe("pending");
  });

  it("序幕 ack 造成 revision 过期时：复用已完成场景并基于最新 revision 落库", async () => {
    const original = pendingRecord();
    let current = original;
    let applyCount = 0;
    const expectedRevisions: number[] = [];
    const repository: GameRepository = {
      async createInitialGame() { return { ok: true }; },
      async getCurrentGame() {
        return { ok: true as const, status: "active" as const, record: current };
      },
      async applyResolvedAction(input) {
        applyCount += 1;
        expectedRevisions.push(input.expectedRevision);
        if (applyCount === 1) {
          // The prologue acknowledgement commits while the provider work is
          // in flight; the generated scene itself has not been consumed.
          current = {
            ...current,
            revision: 5,
            state: { ...current.state, prologueShown: true },
          };
          return { ok: false as const, code: "STALE_GAME_REVISION" as const };
        }
        current = { ...current, revision: 6, state: input.nextState };
        return { ok: true as const, record: current };
      },
      async applyBlueprintExpansion() {
        return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      },
    };

    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "phase14-rebase",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("saved");
    expect(expectedRevisions).toEqual([4, 5]);
    expect(current.state.prologueShown).toBe(true);
    expect(current.state.narrative.currentScene?.source).toBe("fallback");
    expect(current.state.narrative.generation).toEqual({ status: "idle" });
  });
});

describe("generatePendingNarrativeScene：playerNpcChat 单次消费（spec §8 纪律 3）", () => {
  it("场景 ready 后 state.narrative.generation 不含 playerNpcChat", async () => {
    // 构造：pending 变体携带自由输入快照（NPC 对话触发路径写入的形态）。
    const base = pendingRecord();
    const record: GameRecord = {
      ...base,
      state: {
        ...base.state,
        narrative: {
          currentScene: null,
          generation: {
            status: "pending",
            requestedAt: "2026-07-30T08:00:00.000Z",
            playerNpcChat: {
              npcId: asNpcId("npc_1"),
              playerText: "我想去废弃矿坑",
              npcName: "铁匠",
              npcRole: "铁匠铺老板",
            },
          },
          mode: "ai",
        },
      },
    };
    const repository = repositoryFor(record);
    const result = await generatePendingNarrativeScene({
      repository,
      newTraceId: () => "chat-consume",
      now: () => "2026-07-31T01:02:03.000Z",
      runtimeNarrativeSources: unavailableSources(),
    });

    expect(result).toBe("saved");
    const saved = await repository.getCurrentGame();
    if (!saved.ok || saved.status !== "active") throw new Error("期望 active 存档");
    const generation = saved.record.state.narrative.generation;
    // ready 后 generation 收窄回 idle：pending 变体的 playerNpcChat 随类型丢弃。
    expect(generation.status).toBe("idle");
    expect((generation as { playerNpcChat?: unknown }).playerNpcChat).toBeUndefined();
    // 下一轮导演上下文不会读到上一次自由输入（不跨场景残留）。
    const context = toDirectorContext({ blueprint: saved.record.blueprint, state: saved.record.state });
    expect(context.playerNpcChat).toBeUndefined();
  });
});
