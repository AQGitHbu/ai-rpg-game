import { describe, it, expect } from "vitest";
import {
  createInMemoryRepo,
  createJourneyGame,
  playTurn,
  playIssuedChoice,
  advanceScene,
  loadGameView,
  loadWorldState,
  loadStoryState,
  loadGameRecord,
  createJourneyEvolutionSource,
  type InMemoryRepo,
} from "./foundationJourney.testutil";
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";
import { readyScene } from "@/game/domain/narrativeTestFixture.testutil";

// ---------------------------------------------------------------------------
// Step 1：动态具象化旅程。
// 开局只有 1 地点/1 NPC/1 主线（opening slice）。完成第一段对话后，下一叙事
// 写回可以具象化完整新幕，但玩家可见链路必须按“前往 → 交谈 → 取证 → 战斗”
// 逐步释放。随后继续地图移动、场景、物品拾取、战斗，并以 ≥15 个成功回合与 3 次重载
// 抵达结局。journeys 全程确定性源（零 AI）。
// ---------------------------------------------------------------------------

describe("动态具象化旅程（Step 1）", () => {
  it("同地点新目标的 ambient 台词不能冒充正式开场，点击后才创建目标 NPC provider job", async () => {
    const created = await createJourneyGame(undefined, undefined, "same-town-dialogue", "short");
    const fallbackEvolution = createJourneyEvolutionSource();
    const sameTownEvolution: WorldEvolutionSource = {
      async propose(context) {
        if (context.need.kind !== "next_act") return fallbackEvolution.propose(context);
        return {
          ok: true,
          proposal: {
            beatSummary: "老茶头把线索交给同镇的赵文远",
            newLocation: {
              name: "废弃当铺",
              description: "镇东一间久未开门的旧当铺。",
              scale: "scene",
              placement: "town_building",
              connectFromLocationId: String(context.worldState.currentLocationId),
            },
            newNpc: {
              name: "赵文远",
              role: "州府师爷",
              description: "负责拟定缉凶告示，暂住在镇东当铺。",
              locationRef: { kind: "new_location" },
              goals: ["查清告示背后的旧案"],
            },
            newItem: null,
            newEnemy: null,
            newFact: null,
            nextMainQuest: {
              name: "当铺暗影",
              description: "向赵文远查问缉凶告示。",
              objectiveText: "与赵文远交谈",
            },
            endingPair: null,
          },
        };
      },
    };

    await advanceScene(created.repo.repo, sameTownEvolution);
    const firstTalk = await playIssuedChoice(created.repo.repo, "回应", sameTownEvolution);
    expect(firstTalk.ok).toBe(true);
    expect(await advanceScene(created.repo.repo, sameTownEvolution)).toBe(true);
    const secondTalk = await playIssuedChoice(created.repo.repo, "回应", sameTownEvolution);
    expect(secondTalk.ok).toBe(true);
    expect(await advanceScene(created.repo.repo, sameTownEvolution)).toBe(true);

    const handoffView = await loadGameView(created.repo.repo);
    const zhaoBeforeTalk = handoffView.narrative.npcDialogues.find((entry) => entry.name === "赵文远");
    expect(handoffView.story.currentObjectiveLabel).toBe("与赵文远交谈");
    expect(zhaoBeforeTalk?.speechPages).toEqual([]);
    expect(zhaoBeforeTalk?.choices).toEqual([]);
    expect(zhaoBeforeTalk?.freeInputEnabled).toBe(false);
    expect(zhaoBeforeTalk?.startChoice?.label).toBe("与赵文远交谈");

    const startTalk = await playIssuedChoice(created.repo.repo, "赵文远", sameTownEvolution);
    expect(startTalk.ok).toBe(true);
    const pending = await loadGameRecord(created.repo.repo);
    expect(pending?.storyState.narrative.status).toBe("provider_pending");
    if (pending?.storyState.narrative.status !== "provider_pending") return;
    expect(pending.storyState.narrative.job.focusNpcId).toBe("npc_dyn_1");
    expect(pending.storyState.narrative.job.generationKind).toBe("npc_fixed_choice");
    expect(pending.storyState.narrative.job.sceneRequestKind).toBe("npc_response");

    expect(await advanceScene(created.repo.repo, sameTownEvolution)).toBe(true);
    const ready = await loadGameView(created.repo.repo);
    const zhaoReady = ready.narrative.npcDialogues.find((entry) => entry.name === "赵文远");
    expect(zhaoReady?.speechPages.length).toBeGreaterThan(0);
    expect(zhaoReady?.choices).toHaveLength(2);
    expect(zhaoReady?.freeInputEnabled).toBe(true);
    expect(zhaoReady?.startChoice).toBeUndefined();
  });

  it("开局切片 → 首次对话触发具象化 → 拾取/移动/战斗 → ≥15 回合 3 次重载抵达结局", async () => {
    const created = await createJourneyGame(undefined, undefined, "q20", "short");
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

    await fixed("回应"); // 2: 与 npc_0 第一轮正式交谈
    await scene();
    await fixed("回应"); // 3: 第二轮正式交谈 → quest_0 完成 → 幕推进
    await scene(); // 4: 下一叙事写回 + 世界演化触发

    // 具象化断言：完整新幕已写入世界，但第一可见目标只有前往新地点。
    ws = await loadWorldState(store.repo);
    ss = await loadStoryState(store.repo);
    expect(ws?.npcs.length).toBeGreaterThanOrEqual(2);
    expect(ws?.locations.length).toBeGreaterThanOrEqual(2);
    expect(ws?.items.length).toBeGreaterThanOrEqual(1);
    expect(ws?.quests.length).toBeGreaterThanOrEqual(2);
    expect(ss?.currentAct).toBe(2);
    const sceneRecord = store.record();
    const sceneNarration = sceneRecord === null ? "" : readyScene(sceneRecord.storyState).narration;
    expect(sceneNarration).not.toContain("传讯人·2");
    expect(ss?.reveal).toEqual({ questId: "quest_dyn_1", visibleObjectiveIndex: 0 });
    expect(ws?.unlockedLocationIds).toContain("loc_dyn_1");
    const handoffScene = sceneRecord === null ? null : readyScene(sceneRecord.storyState);
    expect(handoffScene?.event?.kind).toBe("observe");
    expect(handoffScene?.choices).toEqual([]);
    const handoffView = await loadGameView(store.repo);
    expect(handoffView.worldMap.locations.find((location) => location.name === "延伸之地·2")?.travelChoice?.label)
      .toContain("前往延伸之地·2");
    expect(ws?.eventLedger.some((event) => event.type === "blueprint_expanded")).toBe(true);

    await fixed("延伸之地·2"); // 4: 前往新地点，释放 NPC
    await scene();
    expect((await loadStoryState(store.repo))?.reveal?.visibleObjectiveIndex).toBe(1);
    await fixed("传讯人·2"); // 5: 第一轮正式交谈
    await scene();
    await fixed("传讯人·2"); // 6: 第二轮正式交谈后释放物品
    await scene();
    expect((await loadStoryState(store.repo))?.reveal?.visibleObjectiveIndex).toBe(2);
    await fixed("拾取"); // 7: 物品获取后释放敌人
    await scene();
    ws = await loadWorldState(store.repo);
    expect(ws?.inventory.length).toBeGreaterThanOrEqual(1);

    await fixed("挑战"); // 8: 战斗开始
    await scene();
    await fightToVictory();
    ws = await loadWorldState(store.repo);
    expect(ws?.defeatedEnemyIds.length).toBeGreaterThanOrEqual(1);
    reload(); // 重载 1

    reload(); // 重载 2

    await fixed("延伸之地·3"); // 9: 第 3 幕先前往新地点
    await scene();
    await fixed("传讯人·3"); // 10: 第 3 幕第一轮正式交谈
    await scene();
    await fixed("传讯人·3"); // 11: 第 3 幕第二轮正式交谈
    await scene();
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(3);

    await fixed("拾取"); // 12: 第 3 幕物品
    await scene();
    await fixed("挑战"); // 13: 第 3 幕战斗
    await scene();
    await fightToVictory();
    reload(); // 重载 3

    // 规则层若已在最终 NPC 的明确立场回合落定结局，后续不再生成
    // provider 场景，也不应继续寻找不存在的“回应”选项；兼容两种
    // 合法的确定性旅程收尾时序。
    const afterBattle = await loadWorldState(store.repo);
    if (afterBattle?.ending === null) {
      const endingView = await loadGameView(store.repo);
      const hasEndingResponse = endingView.narrative.npcDialogues.some((dialogue) => dialogue.choices.length > 0)
        || endingView.narrative.choices.length > 0;
      if (!hasEndingResponse) {
        await fixed("继续追查");
        await scene();
      }
      if ((await loadWorldState(store.repo))?.ending === null) {
        await fixed("回应"); // 完成短篇最后一幕后选择结局方向
        await scene();
      }
      if ((await loadWorldState(store.repo))?.ending === null) {
        await fixed("回应"); // 明确选择结局方向后落定
      }
    }

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
    const created = await createJourneyGame(undefined, undefined, "q20", "short");
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
    const unblocked = await playIssuedChoice(store.repo, "回应");
    expect(unblocked.ok).toBe(true);
  });
});
