import { describe, it, expect } from "vitest";
import {
  createInMemoryRepo,
  createJourneyGame,
  playTurn,
  playIssuedChoice,
  advanceScene,
  loadWorldState,
  loadStoryState,
  type InMemoryRepo,
} from "./foundationJourney.testutil";
import type { Action } from "@/game/domain/action";
import type { ActionChoiceMap } from "@/game/application/actionConverter";
import { asNpcId } from "@/game/domain/worldEntity";

function cmap(entries: readonly [string, Action][]): ActionChoiceMap {
  return new Map(entries as Iterable<[string, Action]>) as ActionChoiceMap;
}

// ---------------------------------------------------------------------------
// Foundation 完整动态闭环旅程：
// opening slice（仅 1 地点/NPC/任务）→ 首次对话触发具象化 → 物品/移动/战斗
// → 幕推进 → 小镇与场景 → 结局。journeys 全程确定性源（零 AI），并注入
// worldEvolutionSource 使幕边界具象化真实触发（旧 harness 以 undefined 运行，
// 这正是 act-boundary / quest_advanced fallback 之前未被覆盖的原因）。
// ---------------------------------------------------------------------------

describe("foundation 动态闭环旅程", () => {
  it("从开局切片走到具象化、小镇、场景与结局：≥15 回合、3 次重载、单次 CAS", async () => {
    const created = await createJourneyGame(undefined, undefined, "foundation-dynamic-seed", "short");
    let store: InMemoryRepo = created.repo;
    let successfulTurns = 0;
    let reloadCount = 0;
    const issuedTokens: string[] = [];

    const accept = (result: Awaited<ReturnType<typeof playTurn>>): void => {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) successfulTurns += 1;
    };
    const fixed = async (label: string) => {
      const result = await playIssuedChoice(store.repo, label);
      issuedTokens.push(result.choiceToken);
      accept(result);
    };
    const scene = async () => {
      const ok = await advanceScene(store.repo);
      expect(ok, "场景生成应保存").toBe(true);
    };
    const reload = () => {
      const snapshot = store.record();
      if (snapshot === null) throw new Error("reload 缺少存档");
      const next = createInMemoryRepo(created.gameId);
      next.restore(structuredClone(snapshot));
      store = next;
      reloadCount += 1;
    };
    const fightToVictory = async () => {
      for (let i = 0; i < 8; i += 1) {
        await fixed("攻击");
        await scene();
        const ws = await loadWorldState(store.repo);
        if (ws !== null && ws.battle.status === "resolved") return;
      }
      throw new Error("战斗未在预期回合内结束");
    };

    // 序幕：开局只有 opening slice。
    let ws = await loadWorldState(store.repo);
    let ss = await loadStoryState(store.repo);
    expect(ws?.locations).toHaveLength(1);
    expect(ws?.npcs).toHaveLength(1);
    expect(ws?.quests).toHaveLength(1);
    expect(ss?.prologueText).not.toBe("");

    await scene(); // 序幕场景（确定性）

    // 回合 1：与开局 NPC 交谈 → 第一幕完成。
    const applyBefore = store.applyCalls().length;
    await fixed("交谈");
    expect(store.applyCalls().length - applyBefore).toBe(1); // 单次 CAS
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(2);

    // 场景写回 + 世界演化具象化。
    await scene();
    ws = await loadWorldState(store.repo);
    expect(ws?.npcs.length).toBeGreaterThanOrEqual(2);
    expect(ws?.locations.length).toBeGreaterThanOrEqual(2);
    expect(ws?.quests.length).toBeGreaterThanOrEqual(2);
    expect(ws?.eventLedger.some((event) => event.type === "blueprint_expanded")).toBe(true);
    reload(); // 重载 1：从持久化记录恢复后状态一致

    // 物品获取。
    await fixed("拾取");
    await scene();
    ws = await loadWorldState(store.repo);
    expect(ws?.inventory.length).toBeGreaterThanOrEqual(1);

    // 战斗（起战 → 攻击至胜利）。
    await fixed("挑战");
    await scene();
    await fightToVictory();
    ws = await loadWorldState(store.repo);
    expect(ws?.battle.status).toBe("resolved");
    expect(ws?.defeatedEnemyIds.length).toBeGreaterThanOrEqual(1);

    // 地图移动：小镇（loc_0）→ 新延伸之地 → 回到小镇。
    await fixed("延伸之地");
    await scene();
    ws = await loadWorldState(store.repo);
    expect(ws?.currentLocationId !== undefined).toBe(true);
    await fixed("前往"); // 回到小镇
    await scene();
    reload(); // 重载 2

    // 完成第 2 幕主线 → 第 3 幕具象化。
    await fixed("传讯人·2");
    await scene();
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(3);

    // 第 3 幕：再取物品、再战、完成主线。
    await fixed("拾取");
    await scene();
    await fixed("挑战");
    await scene();
    await fightToVictory();
    reload(); // 重载 3

    await fixed("传讯人·3"); // 完成最终幕主线 → 结局对具象化
    await scene();
    ws = await loadWorldState(store.repo);
    expect(ws?.endings.length).toBeGreaterThanOrEqual(2);

    await fixed("回应"); // 明确选择结局方向后落定
    await scene();

    const record = store.record();
    if (record === null) throw new Error("旅程结束后存档缺失");
    expect(successfulTurns).toBeGreaterThanOrEqual(15);
    expect(record.storyState.turnNumber).toBe(successfulTurns);
    expect(reloadCount).toBeGreaterThanOrEqual(3);
    expect(issuedTokens.length).toBeGreaterThanOrEqual(12);
    expect(issuedTokens.every((token) => /^c_[0-9a-f]{16}$/.test(token))).toBe(true);
    expect(record.worldState.ending).not.toBeNull();
    expect(record.worldState.eventLedger.some((event) => event.type === "ending_reached")).toBe(true);
    expect(record.worldState.eventLedger.some((event) => event.type === "item_obtained")).toBe(true);
    expect(record.worldState.eventLedger.some((event) => event.type === "battle_resolved" && event.outcome === "victory")).toBe(true);
  });

  it("pending job 阻断后续自由行动，直至场景生成（clear）", async () => {
    const created = await createJourneyGame();
    const store = created.repo;
    expect(await advanceScene(store.repo)).toBe(true);

    const applyBefore = store.applyCalls().length;
    const t1 = await playTurn(
      store.repo,
      { kind: "fixed_choice", choiceToken: "tok_talk" },
      cmap([["tok_talk", { type: "talk", npcId: asNpcId("npc_0"), dialogueAct: "ask" }]]),
    );
    expect(t1.ok).toBe(true);
    expect(store.applyCalls().length - applyBefore).toBe(1);

    // 未生成场景（pending 仍在）：下一行动被拒。
    const blocked = await playTurn(store.repo, { kind: "fixed_choice", choiceToken: "tok_explore" }, cmap([["tok_explore", { type: "explore" }]]));
    expect(blocked.ok).toBe(false);

    // 生成场景清空 pending 后：合法行动成功。
    expect(await advanceScene(store.repo)).toBe(true);
    const t2 = await playTurn(store.repo, { kind: "fixed_choice", choiceToken: "tok_explore" }, cmap([["tok_explore", { type: "explore" }]]));
    expect(t2.ok).toBe(true);
  });
});
