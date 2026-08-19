import { describe, it, expect } from "vitest";
import {
  createJourneyEvolutionSource,
  createJourneyGame,
  playIssuedChoice,
  advanceScene,
  loadWorldState,
  loadStoryState,
  type InMemoryRepo,
} from "./foundationJourney.testutil";
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";

// ---------------------------------------------------------------------------
// 中篇（5 幕）离线可完成性证明：经真实幕链推进（交谈→取证→战斗→具象化），
// 从第 1 幕一路推进到第 5 幕终点并解析结局。断言 currentAct 到达 targetActs、
// 结局已具象化且已解析、预算各维度仍在软上限内。全程确定性源（零 AI）。
//
// 说明：结局对与 pacing 委托旅程源（其 ending_pair 走 stock 规则要求）；next_act
// 把新 NPC 挂到新幕的延伸之地（新地点，scale=scene，无小镇 slot 上限），玩家每幕
// 先移动到位再交谈，真正串联 5 幕。该旅程曾由旧 foundationJourney 的 5 幕短局覆盖，
// Task 9 重写后曾缺失，此处补齐。
// ---------------------------------------------------------------------------

/** 与旅程源一致，但把下一幕 NPC 挂到新地点（延伸之地·N）而非当前小镇，避免小镇 slot 上限。 */
function createMediumJourneyEvolutionSource(): WorldEvolutionSource {
  const base = createJourneyEvolutionSource();
  return {
    async propose(ctx) {
      if (ctx.need.kind !== "next_act") return base.propose(ctx);
      const act = ctx.need.act;
      const proposal: WorldDeltaProposal = {
        beatSummary: `第${act}幕的传讯人带来新的线索`,
        newLocation: {
          name: `延伸之地·${act}`,
          description: `第${act}幕线索延伸出的一处新地界。`,
          scale: "scene",
          connectFromLocationId: String(ctx.worldState.currentLocationId),
        },
        newNpc: {
          name: `传讯人·${act}`,
          role: "信使",
          description: `风尘仆仆赶来的第${act}幕传讯人。`,
          locationRef: { kind: "new_location" },
          goals: [`传递第${act}幕的线索`],
        },
        newItem: {
          name: `信物·${act}`,
          description: `第${act}幕途中拾得的信物。`,
          locationRef: "new_location",
        },
        newEnemy: {
          name: `守径人·${act}`,
          tier: "normal",
          locationRef: "new_location",
        },
        newFact: null,
        nextMainQuest: {
          name: `循迹第${act}幕`,
          description: `与第${act}幕的传讯人交谈，继续追索。`,
          objectiveText: `与传讯人·${act}交谈`,
        },
        endingPair: null,
      };
      return { proposal };
    },
  };
}

describe("中篇 5 幕离线可完成性", () => {
  it("5 幕全程离线推进到结局：currentAct==targetActs、结局具象化+解析、预算在界内", async () => {
    const created = await createJourneyGame(undefined, undefined, "q20", "medium");
    const store: InMemoryRepo = created.repo;
    const source: WorldEvolutionSource = createMediumJourneyEvolutionSource();
    let successfulTurns = 0;

    const accept = (result: Awaited<ReturnType<typeof playIssuedChoice>>): void => {
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (result.ok) successfulTurns += 1;
    };
    const fixed = async (label: string) => accept(await playIssuedChoice(store.repo, label, source));
    const scene = async () => {
      const ok = await advanceScene(store.repo, source);
      expect(ok).toBe(true);
    };
    const defeat = async (enemyName: string) => {
      await fixed(enemyName);
      while (store.record()?.worldState.battle.status === "active") await fixed("攻击");
      await scene();
    };
    const completeAct = async (act: number) => {
      await fixed(`延伸之地·${act}`);
      await scene();
      await fixed(`传讯人·${act}`);
      await scene();
      await fixed(`信物·${act}`);
      await scene();
      await defeat(`守径人·${act}`);
    };

    // 开局：第 1 幕切片。
    let ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(1);
    expect(ss?.targetActs).toBe(5);

    await scene(); // 序幕
    await fixed("交谈"); // 完成第 1 幕主线 → 具象化第 2 幕
    await scene();
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(2);

    // 后续每幕必须完成交谈、物证和战斗三个连续目标，不能由单次对话跳过。
    await completeAct(2);
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(3);

    await completeAct(3);
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(4);

    await completeAct(4);
    ss = await loadStoryState(store.repo);
    expect(ss?.currentAct).toBe(5);

    await completeAct(5); // 完成第 5 幕主线 → 结局对具象化需求
    await scene(); // 具象化结局对
    let ws = await loadWorldState(store.repo);
    expect(ws?.endings.length).toBeGreaterThanOrEqual(2);

    await fixed("回应"); // 明确选择结局方向后落定
    await scene();

    const record = store.record();
    if (record === null) throw new Error("旅程结束后存档缺失");
    ss = record.storyState;
    ws = record.worldState;

    // 第 5 幕结束，结局已解析。
    expect(ss.currentAct).toBe(ss.targetActs);
    expect(ss.currentAct).toBe(5);
    expect(ws.ending).not.toBeNull();
    expect(ws.eventLedger.some((event) => event.type === "ending_reached")).toBe(true);

    // 预算各维度都在软上限内（expanded <= max）。
    const budget = ss.budget;
    expect(budget.locations.expanded).toBeLessThanOrEqual(budget.locations.max);
    expect(budget.npcs.expanded).toBeLessThanOrEqual(budget.npcs.max);
    expect(budget.quests.expanded).toBeLessThanOrEqual(budget.quests.max);
    expect(budget.events.expanded).toBeLessThanOrEqual(budget.events.max);

    // 真实幕链：每次具象化都经 blueprint_expanded 落账。
    expect(ws.eventLedger.filter((event) => event.type === "blueprint_expanded").length).toBeGreaterThanOrEqual(4);
    expect(successfulTurns).toBeGreaterThanOrEqual(15);
    expect(record.storyState.turnNumber).toBe(successfulTurns);
  });
});
