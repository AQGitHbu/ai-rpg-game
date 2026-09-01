import { describe, it, expect } from "vitest";
import {
  createJourneyGame,
  playTurn,
  playIssuedChoice,
  advanceScene,
  pendingSceneProposal,
  loadGameView,
  loadWorldState,
  loadGameRecord,
} from "./foundationJourney.testutil";
import { PLAYER_ENTITY_ID, asNpcId } from "@/game/domain/worldEntity";
import { entitiesOfKind, projectEntityStore } from "@/game/domain/entity";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { ATMOSPHERE_BEAT_ID } from "@/game/application/approveAndWriteScene";
import { commitState } from "@/game/application/stateCommit";

// ---------------------------------------------------------------------------
// Step 2：叙事落地旅程。
// 验证：自由输入 → 直接 NPC 回应节拍；敌意与信任亲和度 → 不同回应策略；
// 物品/任务/战斗 → 每一场景覆盖全部强制节拍 + objectiveLink 与 HUD 当前目标一致。
// ---------------------------------------------------------------------------

describe("叙事落地旅程（Step 2）", () => {
  it("自由输入 → 直接 NPC 回应节拍", async () => {
    const created = await createJourneyGame(undefined, undefined, "q20", "short");
    const store = created.repo;
    await advanceScene(store.repo);

    // 先完成开场 NPC 的两轮正式回应，不能用一次接触跳过第一幕。
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);

    // 下一幕先释放并执行抵达步骤，抵达后才释放主线 NPC。
    await playIssuedChoice(store.repo, "延伸之地·2");
    await advanceScene(store.repo);

    // 幕交接后，新的主线 NPC 即刻接管焦点；无需先浪费一次“打开对话”回合。
    const current = store.record()!;
    const objective = currentObjectiveOf(current.worldState, current.storyState);
    expect(objective).not.toBeNull();
    const quest = current.worldState.quests.find((entry) => String(entry.id) === String(objective!.questId));
    const objectiveTarget = quest?.objectives[objective!.objectiveIndex];
    expect(objectiveTarget?.kind).toBe("talk_to_npc");
    if (objectiveTarget?.kind !== "talk_to_npc") throw new Error("缺少可对话主线目标");

    // 提交自由输入 + 交接后的主线目标 NPC
    const npcId = objectiveTarget.npcId;
    const turn = await playTurn(store.repo, {
      kind: "free_text",
      text: "我相信你，请你告诉我这里的秘密",
      targetNpcId: asNpcId(npcId),
    });
    expect(turn.ok).toBe(true);

    // 构建场景上下文 + 确定性提案（不写库）
    const pending = await pendingSceneProposal(store.repo);
    expect(pending).not.toBeNull();
    const { context, proposal } = pending!;

    // 断言：提案包含 player_utterance 节拍。
    const utteranceBeat = context.mandatoryBeats.find((b) => b.kind === "player_utterance");
    expect(utteranceBeat).toBeDefined();
    const utteranceSegment = proposal.segments.find((s) => s.beatId === utteranceBeat!.beatId);
    expect(utteranceSegment).toBeDefined();
    expect(utteranceSegment!.text).not.toContain("我相信你");
    expect(utteranceSegment!.text).toContain("能核查");

    // 断言：NPC 台词应答了 player_utterance 节拍。
    expect(proposal.npcLine).not.toBeNull();
    expect(proposal.npcLine!.answeredBeatIds).toContain("player_utterance");

    // 实际生成场景并保存。
    expect(await advanceScene(store.repo)).toBe(true);
  });

  it("敌意与信任亲和度 → 不同回应策略/兜底线", async () => {
    async function runWithAffinity(affinity: number) {
      // seed 统一为 "q20"（与其它 journey 一致；各迭代 repo 独立无冲突）。
      const created = await createJourneyGame(undefined, undefined, "q20", "short");
      const store = created.repo;
      const record = await loadGameRecord(store.repo);
      if (record === null) throw new Error("记录不可用");

      // 开局场景已由 opening provider 生成；先设置关系，再用正式 NPC 选择
      // 触发一次允许的 NPC provider job。
      await advanceScene(store.repo);

      // 直接设置 NPC 分层关系组件的亲和度（不依赖大量回合交互）。
      const current = await loadGameRecord(store.repo);
      if (current === null) throw new Error("记录不可用");
      const npc = current.worldState.npcs[0]!;
      const npcRecord = entitiesOfKind(current.worldState.entityStore, "npc").find((entry) => entry.core.id === npc.id);
      if (npcRecord === undefined) throw new Error("缺少 NPC 权威实体记录");
      const playerEdge = npcRecord.relationships.outgoing.find((edge) => edge.targetId === PLAYER_ENTITY_ID);
      if (playerEdge === undefined) throw new Error("缺少 NPC→player 权威关系边");
      const updatedNpcRecord = {
        ...npcRecord,
        relationships: {
          ...npcRecord.relationships,
          outgoing: npcRecord.relationships.outgoing.map((edge) => edge.targetId === PLAYER_ENTITY_ID
            ? { ...edge, dimensions: { ...edge.dimensions, affinity } }
            : edge),
        },
      };
      const entityStore = {
        ...current.worldState.entityStore,
        records: current.worldState.entityStore.records.map((entry) => entry.core.id === npcRecord.core.id ? updatedNpcRecord : entry),
      };
      const commitResult = await commitState(store.repo, {
        gameId: created.gameId,
        expectedRevision: current.revision,
        nextWorldState: {
          ...current.worldState,
          entityStore,
          ...projectEntityStore(entityStore),
        },
        nextStoryState: current.storyState,
      });
      if (!commitResult.ok) throw new Error(`亲和度注入失败: ${commitResult.code}`);
      const projected = commitResult.record.worldState.npcs.find((entry) => entry.id === npc.id);
      const authoritative = entitiesOfKind(commitResult.record.worldState.entityStore, "npc")
        .find((entry) => entry.core.id === npc.id);
      expect(projected?.memory.relationship.affinity).toBe(affinity);
      expect(authoritative?.relationships.outgoing.find((edge) => edge.targetId === PLAYER_ENTITY_ID)?.dimensions.affinity)
        .toBe(affinity);

      const response = await playTurn(store.repo, {
        kind: "free_text",
        text: "请把你知道的证据和来龙去脉说清楚",
        targetNpcId: asNpcId(npc.id),
      });
      expect(response.ok).toBe(true);

      const pending = await pendingSceneProposal(store.repo);
      if (pending === null) throw new Error("无 pending 场景");
      return pending;
    }

    const hostile = await runWithAffinity(-70);
    const trusted = await runWithAffinity(70);

    // 两种关系档位都必须用 NPC 直接台词，并且承接本轮玩家话语。
    expect(hostile.proposal.npcLine?.text).toContain("这不关你的事");
    expect(trusted.proposal.npcLine?.text).toContain("来龙去脉");
    expect(hostile.proposal.npcLine?.text).not.toMatch(/冷冷地答道|如实答道/);
    expect(trusted.proposal.npcLine?.text).not.toMatch(/坦诚地说|说道|答道/);
    expect(hostile.proposal.npcLine?.emotion).toBe("angry");
    expect(trusted.proposal.npcLine?.emotion).toBe("warm");
  });

  it("物品/任务/战斗 → 场景覆盖全部强制节拍 + objectiveLink == HUD 当前目标", async () => {
    const created = await createJourneyGame(undefined, undefined, "q20", "short");
    const store = created.repo;
    await advanceScene(store.repo);

    // Helper: 对当前 pending 断言场景覆盖全部强制节拍 + objectiveLink 一致性。
    async function assertSceneCoversBeatsAndObjective(requirePending = false) {
      const pending = await pendingSceneProposal(store.repo);
      if (pending === null) {
        expect(requirePending).toBe(false);
        const ready = store.record()?.storyState.narrative;
        expect(ready?.status).toBe("ready");
        if (ready?.status === "ready") {
          expect(["rule", "fixture", "generated"]).toContain(ready.currentScene.source);
        }
        return;
      }
      const { context, proposal } = pending!;

      // 每个强制节拍（排除 atmosphere）恰好对应一个 segment。
      const mandatoryWithoutAtmo = context.mandatoryBeats.filter((b) => b.beatId !== ATMOSPHERE_BEAT_ID);
      const segmentIds = new Set(proposal.segments.map((s) => s.beatId));
      for (const beat of mandatoryWithoutAtmo) {
        expect(segmentIds.has(beat.beatId)).toBe(true);
      }
      // atmosphere 可选，放在最后。
      const atmoSegment = proposal.segments.find((s) => s.beatId === ATMOSPHERE_BEAT_ID);
      if (atmoSegment !== undefined) {
        expect(proposal.segments[proposal.segments.length - 1]!.beatId).toBe(ATMOSPHERE_BEAT_ID);
      }

      // objectiveLink 与 HUD 当前目标一致。
      const record = store.record();
      if (record === null) throw new Error("记录不可用");
      const hud = currentObjectiveOf(record.worldState, record.storyState);
      if (hud === null) {
        expect(proposal.objectiveLink).toBeNull();
      } else {
        expect(proposal.objectiveLink).not.toBeNull();
        expect(proposal.objectiveLink!.questId).toBe(String(hud.questId));
        expect(proposal.objectiveLink!.objectiveIndex).toBe(hud.objectiveIndex);
      }
    }

    // 开场两轮正式交谈 → 完成 quest_0，幕推进。
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);

    await playIssuedChoice(store.repo, "延伸之地·2");
    await advanceScene(store.repo);
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);

    // 物品拾取必须是这条 deterministic sub-journey 的真实前置，不能静默早退。
    const itemView = await loadGameView(store.repo);
    expect(itemView.obtainableItems.length).toBeGreaterThan(0);
    expect(itemView.obtainableItems).toHaveLength(1);
    expect(itemView.obtainableItems[0]?.name).toBe("信物·2");
    const picked = await playIssuedChoice(store.repo, "拾取");
    expect(picked.ok).toBe(true);
    const afterPick = await loadGameView(store.repo);
    expect(afterPick.inventory.length).toBeGreaterThan(itemView.inventory.length);
    await assertSceneCoversBeatsAndObjective();
    expect(await advanceScene(store.repo)).toBe(true);

    // 战斗开始。
    const beforeBattle = await loadGameView(store.repo);
    const battleChoices = beforeBattle.currentLocation.actions.filter((choice) => choice.presentation === "battle");
    expect(battleChoices).toHaveLength(1);
    expect(battleChoices[0]?.label).toContain("守径人·2");
    const started = await playIssuedChoice(store.repo, "挑战");
    expect(started.ok).toBe(true);
    expect((await loadGameView(store.repo)).battle).not.toBeNull();
    // 活跃战斗走直接规则 CAS，不创建 pending 场景。
    expect(await pendingSceneProposal(store.repo)).toBeNull();

    // 战斗回合。
    let battleWon = false;
    for (let i = 0; i < 6; i += 1) {
      const attack = await playIssuedChoice(store.repo, "攻击");
      expect(attack.ok).toBe(true);
      const ws = await loadWorldState(store.repo);
      if (ws!.defeatedEnemyIds.length > 0) {
        battleWon = true;
        await assertSceneCoversBeatsAndObjective();
        expect(await advanceScene(store.repo)).toBe(true);
        break;
      }
      expect(await pendingSceneProposal(store.repo)).toBeNull();
    }
    expect(battleWon).toBe(true);

    // 战斗结算完成当前主线目标并推进幕游标；下一幕的世界边界由后续
    // 正式叙事边界具象化。
    const afterBattle = await loadGameView(store.repo);
    expect(afterBattle.story.currentAct).toBe(3);
    expect(afterBattle.narrativeGeneration.status).toBe("idle");
  });

  it("deterministic NPC response sub-journey → pending 场景覆盖全部强制节拍与 HUD objectiveLink", async () => {
    const created = await createJourneyGame(undefined, undefined, "q20", "short");
    const store = created.repo;
    await advanceScene(store.repo);

    // 走到第二幕主线 NPC，使用真实 free_text action 触发 provider_pending；
    // 这是 offline item/battle compatibility path 之外的显式叙事覆盖子旅程。
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);
    await playIssuedChoice(store.repo, "回应");
    await advanceScene(store.repo);
    await playIssuedChoice(store.repo, "延伸之地·2");
    await advanceScene(store.repo);

    const current = await loadGameRecord(store.repo);
    if (current === null) throw new Error("记录不可用");
    const objective = currentObjectiveOf(current.worldState, current.storyState);
    expect(objective).not.toBeNull();
    const quest = current.worldState.quests.find((entry) => String(entry.id) === String(objective!.questId));
    const target = quest?.objectives[objective!.objectiveIndex];
    expect(target?.kind).toBe("talk_to_npc");
    if (target?.kind !== "talk_to_npc") throw new Error("确定性子旅程缺少 NPC 目标");

    const applyCallsBeforeResponse = store.applyCalls().length;
    const response = await playTurn(store.repo, {
      kind: "free_text",
      text: "请把这条线索的证据和来龙去脉说清楚",
      targetNpcId: asNpcId(target.npcId),
    });
    expect(response.ok).toBe(true);
    expect(store.applyCalls()).toHaveLength(applyCallsBeforeResponse + 1);
    expect(store.applyCalls().at(-1)?.expectedRevision).toBe(current.revision);

    const pending = await pendingSceneProposal(store.repo);
    expect(pending).not.toBeNull();
    const { context, proposal } = pending!;
    const mandatory = context.mandatoryBeats.filter((beat) => beat.beatId !== ATMOSPHERE_BEAT_ID);
    const segmentIds = proposal.segments.map((segment) => segment.beatId);
    expect(new Set(segmentIds).size).toBe(segmentIds.length);
    for (const beat of mandatory) expect(segmentIds).toContain(beat.beatId);
    const atmosphere = proposal.segments.find((segment) => segment.beatId === ATMOSPHERE_BEAT_ID);
    if (atmosphere !== undefined) {
      expect(proposal.segments[proposal.segments.length - 1]!.beatId).toBe(ATMOSPHERE_BEAT_ID);
    }

    const hud = currentObjectiveOf(current.worldState, current.storyState);
    expect(hud).not.toBeNull();
    const objectiveLinkMode = context.objectiveTransition.mode === "advanced_act"
      ? "handoff"
      : context.objectiveTransition.mode === "progressed"
        ? "progress"
        : "hint";
    expect(proposal.objectiveLink).toEqual({
      questId: String(hud!.questId),
      objectiveIndex: hud!.objectiveIndex,
      mode: objectiveLinkMode,
    });
    expect(proposal.npcLine).not.toBeNull();
    expect(proposal.npcLine!.answeredBeatIds).toContain("player_utterance");
    expect(await advanceScene(store.repo)).toBe(true);
    expect((await loadGameView(store.repo)).narrativeGeneration.status).toBe("idle");
  });
});
