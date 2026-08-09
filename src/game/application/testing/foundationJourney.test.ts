import { describe, it, expect } from "vitest";
import { createInMemoryRepo, createJourneyGame, playTurn, playIssuedChoice, playIssuedTravelToUnvisited, advanceScene, loadWorldState, loadStoryState } from "./foundationJourney.testutil";
import type { Action } from "@/game/domain/action";
import type { ActionChoiceMap } from "@/game/application/actionConverter";
import { asNpcId } from "@/game/domain/scenarioBlueprint";

function cmap(entries: readonly [string, Action][]): ActionChoiceMap {
  return new Map(entries as Iterable<[string, Action]>) as ActionChoiceMap;
}

describe("foundation 15-turn journey", () => {
  it("executes 15 successful choice-driven turns, reloads, activates an event, survives a climax, and reaches an ending", async () => {
    const created = await createJourneyGame();
    let store = created.repo;
    let successfulTurns = 0;
    let reloadCount = 0;
    const issuedTokens: string[] = [];
    const accept = (result: Awaited<ReturnType<typeof playTurn>>) => {
      expect(result.ok).toBe(true);
      if (result.ok) successfulTurns += 1;
    };
    const fixed = async (label: string) => {
      const result = await playIssuedChoice(store.repo, label);
      issuedTokens.push(result.choiceToken);
      accept(result);
    };
    const travel = async () => {
      const result = await playIssuedTravelToUnvisited(store.repo);
      issuedTokens.push(result.choiceToken);
      accept(result);
    };
    const scene = async () => expect(await advanceScene(store.repo)).toBe(true);
    const reload = () => {
      const snapshot = store.record();
      if (snapshot === null) throw new Error("reload 缺少存档");
      const next = createInMemoryRepo(created.gameId);
      next.restore(structuredClone(snapshot));
      store = next;
      reloadCount += 1;
    };

    await scene();
    await fixed("交谈"); // 1: fixed NPC entry; completes act 1 and unlocks route
    await scene();
    await fixed("支持"); // 2: server-approved dialogue choice
    await scene();
    accept(await playTurn(store.repo, { kind: "free_text", text: "我相信你，我们一起查明真相", targetNpcId: asNpcId("npc_innkeeper") })); // 3: custom NPC input

    await scene();
    await fixed("休息"); // 4: approves and activates candidate event
    await scene();
    await fixed("探索"); // 5
    await scene();
    reload();

    await travel(); // 6: move to unlocked middle location
    await scene();
    await fixed("拾取"); // 7: obtain quest item
    await scene();
    await fixed("休息"); // 8
    await scene();
    await fixed("探索"); // 9
    await scene();
    reload();

    await travel(); // 10: enter climax location
    await scene();
    await fixed("探索"); // 11
    await scene();
    await fixed("挑战"); // 12: start battle
    await scene();
    reload();
    await fixed("攻击"); // 13
    await scene();
    await fixed("攻击"); // 14
    await scene();
    await fixed("攻击"); // 15: defeat boss, complete final act, resolve ending

    const record = store.record()!;
    expect(successfulTurns).toBeGreaterThanOrEqual(15);
    expect(record.storyState.turnNumber).toBe(successfulTurns);
    expect(reloadCount).toBeGreaterThanOrEqual(3);
    expect(issuedTokens.length).toBeGreaterThanOrEqual(12);
    expect(issuedTokens.every((token) => /^c_[0-9a-f]{16}$/.test(token))).toBe(true);
    expect(record.worldState.eventLedger.some((event) => event.type === "location_unlocked")).toBe(true);
    expect(record.worldState.eventLedger.some((event) => event.type === "item_obtained")).toBe(true);
    expect(record.worldState.eventLedger.some((event) => event.type === "candidate_event_activated")).toBe(true);
    expect(record.worldState.eventLedger.some((event) => event.type === "battle_resolved" && event.outcome === "victory")).toBe(true);
    expect(record.worldState.ending).not.toBeNull();
    expect(record.worldState.eventLedger.some((event) => event.type === "ending_reached")).toBe(true);
  });

  it("creates a validated world, generates prologue, then plays a multi-turn journey with single CAS per turn", async () => {
    const { repo, gameId } = await createJourneyGame();
    expect(repo.record()).not.toBeNull();

    // 开场 pending 生成序幕（确定性）
    expect(await advanceScene(repo.repo)).toBe(true);
    const ss0 = await loadStoryState(repo.repo);
    expect(ss0?.narrative.generation.status).toBe("idle");
    expect(ss0?.turnNumber).toBe(0);

    // 逐回合：每个成功回合恰好一次规则 CAS（applyState 调用）
    const applyBefore = repo.applyCalls().length;

    // 1) NPC 固定 ask（talk → npc_met）
    const t1 = await playTurn(
      repo.repo,
      { kind: "fixed_choice", choiceToken: "tok_talk" },
      cmap([["tok_talk", { type: "talk", npcId: asNpcId("npc_innkeeper"), dialogueAct: "ask" }]]),
    );
    expect(t1.ok).toBe(true);
    expect(repo.applyCalls().length - applyBefore).toBe(1);
    expect(t1.turnNumberAfter).toBe(1);

    // 生成下一场景清空 pending
    expect(await advanceScene(repo.repo)).toBe(true);

    // 2) NPC 固定 support → 关系变化（结构化分化）
    const t2 = await playTurn(
      repo.repo,
      { kind: "fixed_choice", choiceToken: "tok_support" },
      cmap([["tok_support", { type: "talk", npcId: asNpcId("npc_innkeeper"), dialogueAct: "support" }]]),
    );
    expect(t2.ok).toBe(true);
    expect(t2.turnNumberAfter).toBe(2);
    expect(await advanceScene(repo.repo)).toBe(true);

    // 3) 自定义输入（freeform → player_intent_expressed）
    const t3 = await playTurn(repo.repo, { kind: "free_text", text: "我相信你，请告诉我真相" });
    expect(t3.ok).toBe(true);
    expect(t3.turnNumberAfter).toBe(3);
    expect(await advanceScene(repo.repo)).toBe(true);

    // 4) explore → location_explored 主事件
    const t4 = await playTurn(repo.repo, { kind: "fixed_choice", choiceToken: "tok_explore" }, cmap([["tok_explore", { type: "explore" }]]));
    expect(t4.ok).toBe(true);
    expect(t4.turnNumberAfter).toBe(4);
    expect(await advanceScene(repo.repo)).toBe(true);

    // 5) rest → player_rested 主事件
    const t5 = await playTurn(repo.repo, { kind: "fixed_choice", choiceToken: "tok_rest" }, cmap([["tok_rest", { type: "rest" }]]));
    expect(t5.ok).toBe(true);
    expect(t5.turnNumberAfter).toBe(5);
    expect(await advanceScene(repo.repo)).toBe(true);

    // 6) NPC 固定 challenge → 与 support 不同的结构化结果（关系/事件分化）
    const t6 = await playTurn(
      repo.repo,
      { kind: "fixed_choice", choiceToken: "tok_challenge" },
      cmap([["tok_challenge", { type: "talk", npcId: asNpcId("npc_innkeeper"), dialogueAct: "challenge" }]]),
    );
    expect(t6.ok).toBe(true);
    expect(t6.turnNumberAfter).toBe(6);
    expect(await advanceScene(repo.repo)).toBe(true);

    // 7) 自定义输入（越权声明不改变事实，但产生 player_intent_expressed）
    const t7 = await playTurn(repo.repo, { kind: "free_text", text: "我的武功修为达到了百级" });
    expect(t7.ok).toBe(true);
    expect(t7.turnNumberAfter).toBe(7);
    expect(await advanceScene(repo.repo)).toBe(true);

    // 8) 回读快照做"reload"：进程重启后从持久化记录恢复，状态一致
    const snap = repo.record()!;
    const reloaded = createInMemoryRepo(gameId);
    reloaded.restore({ ...snap, storyState: { ...snap.storyState, narrative: { ...snap.storyState.narrative, generation: { status: "idle" } } } });
    const wsReload = await loadWorldState(reloaded.repo);
    expect(String(wsReload?.currentLocationId)).toBe("loc_start");
    const ssReload = await loadStoryState(reloaded.repo);
    expect(ssReload?.turnNumber).toBe(7);
  });

  it("pending job 阻断后续自由行动，直至场景生成（clear）", async () => {
    const { repo } = await createJourneyGame();
    expect(await advanceScene(repo.repo)).toBe(true);

    // 成功回合后进入 pending：下一个非 ack 回合被拒
    const t1 = await playTurn(
      repo.repo,
      { kind: "fixed_choice", choiceToken: "tok_talk" },
      cmap([["tok_talk", { type: "talk", npcId: asNpcId("npc_innkeeper"), dialogueAct: "ask" }]]),
    );
    expect(t1.ok).toBe(true);

    // 未生成场景（pending 仍在）：下一行动被拒
    const blocked = await playTurn(repo.repo, { kind: "fixed_choice", choiceToken: "tok_rest" }, cmap([["tok_rest", { type: "rest" }]]));
    expect(blocked.ok).toBe(false);

    // 生成场景清空 pending 后：合法行动成功
    expect(await advanceScene(repo.repo)).toBe(true);
    const t2 = await playTurn(repo.repo, { kind: "fixed_choice", choiceToken: "tok_rest" }, cmap([["tok_rest", { type: "rest" }]]));
    expect(t2.ok).toBe(true);
  });
});
