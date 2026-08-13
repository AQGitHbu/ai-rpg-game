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

// ---------------------------------------------------------------------------
// Step 1：动态具象化旅程。
// 开局只有 1 地点/1 NPC/1 主线（opening slice）。完成第一段对话后，下一叙事
// 写回必须具象化新 NPC 与新地点/物品；下一场场景必须点名已批准实体。随后继续
// 地图移动 → 小镇 → 场景、物品拾取、战斗，并以 ≥15 个成功回合与 3 次重载
// 抵达结局。journeys 全程确定性源（零 AI）。
// ---------------------------------------------------------------------------

describe("动态具象化旅程（Step 1）", () => {
  it("开局切片 → 首次对话触发具象化 → 拾取/移动/战斗 → ≥15 回合 3 次重载抵达结局", async () => {
    const created = await createJourneyGame(undefined, undefined, "dynamic-materialization-seed", "short");
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
      expect(ok).toBe(true);
    };
    const reload = () => {
      const snapshot = store.record();
      if (snapshot === null) throw new Error("reload 缺少存档");
      const next = createInMemoryRepo(created.gameId);
      next.restore(structuredClone(snapshot));
      store = next;
      reloadCount += 1;
    };
    const fightToVictory = async (label = "攻击") => {
      for (let i = 0; i < 8; i += 1) {
        await fixed(label);
        await scene();
        const ws = await loadWorldState(store.repo);
        if (ws !== null && ws.battle.status === "resolved") return;
      }
      throw new Error("战斗未在预期回合内结束");
    };

    // 开幕切片：只有 loc_0/npc_0/quest_0，无未来实体。
    let ws = await loadWorldState(store.repo);
    let ss = await loadStoryState(store.repo);
    expect(ws?.locations).toHaveLength(1);
    expect(ws?.npcs).toHaveLength(1);
    expect(ws?.quests).toHaveLength(1);
    expect(ws?.items).toHaveLength(0);
    expect(ws?.enemies).toHaveLength(0);
    expect(ss?.currentAct).toBe(1);

    await scene(); // 1: 序幕场景

    await fixed("交谈"); // 2: 与 npc_0 交谈 → quest_0 完成 → 幕推进
    await scene(); // 3: 下一叙事写回 + 世界演化触发

    // 具象化断言：新 NPC + 新地点/物品 已写入世界，且下一场景点名已批准名称。
    ws = await loadWorldState(store.repo);
    ss = await loadStoryState(store.repo);
    expect(ws?.npcs.length).toBeGreaterThanOrEqual(2);
    expect(ws?.locations.length).toBeGreaterThanOrEqual(2);
    expect(ws?.items.length).toBeGreaterThanOrEqual(1);
    expect(ws?.quests.length).toBeGreaterThanOrEqual(2);
    expect(ss?.currentAct).toBe(2);
    const sceneRecord = store.record();
    const sceneNarration = sceneRecord?.storyState.narrative.currentScene?.narration ?? "";
    expect(sceneNarration).toContain("传讯人·2");
    const handoffScene = sceneRecord?.storyState.narrative.currentScene;
    expect(handoffScene?.event?.kind).toBe("observe");
    expect(handoffScene?.choices.some((choice) => choice.label.includes("传讯人·2"))).toBe(true);
    expect(ws?.eventLedger.some((event) => event.type === "blueprint_expanded")).toBe(true);

    await fixed("拾取"); // 4: 物品获取
    await scene();
    ws = await loadWorldState(store.repo);
    expect(ws?.inventory.length).toBeGreaterThanOrEqual(1);

    await fixed("挑战"); // 5: 战斗开始
    await scene();
    await fightToVictory();
    ws = await loadWorldState(store.repo);
    expect(ws?.defeatedEnemyIds.length).toBeGreaterThanOrEqual(1);
    reload(); // 重载 1

    await fixed("延伸之地·2"); // 6: 地图移动到新地点
    await scene();
    await fixed("前往"); // 7: 移动回小镇
    await scene();
    reload(); // 重载 2

    await fixed("传讯人·2"); // 8: 完成第 2 幕主线 → 幕推进
    await scene();
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(3);

    await fixed("拾取"); // 9: 第 3 幕物品
    await scene();
    await fixed("挑战"); // 10: 第 3 幕战斗
    await scene();
    await fightToVictory();
    reload(); // 重载 3

    await fixed("传讯人·3"); // 11: 完成第 3 幕主线
    await scene();
    await fixed("交谈"); // 12: 结局落定

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
    expect(record.worldState.eventLedger.some((event) => event.type === "location_visited")).toBe(true);
  });

  it("单次 CAS 不变式：每个成功回合恰好一次规则提交，pending 阻断自由行动", async () => {
    const created = await createJourneyGame(undefined, undefined, "dynamic-cas-seed", "short");
    const store = created.repo;
    await advanceScene(store.repo);

    const applyBefore = store.applyCalls().length;
    await playIssuedChoice(store.repo, "交谈");
    const applyAfterTurn = store.applyCalls().length;
    expect(applyAfterTurn - applyBefore).toBe(1);

    // pending 未清空时，非 ack 行动被拒（零写入）。
    const blocked = await playTurn(
      store.repo,
      { kind: "free_text", text: "我想到处看看" },
    );
    expect(blocked.ok).toBe(false);
    expect(store.applyCalls().length - applyAfterTurn).toBe(0);

    expect(await advanceScene(store.repo)).toBe(true);
    const unblocked = await playIssuedChoice(store.repo, "传讯人");
    expect(unblocked.ok).toBe(true);
  });
});
