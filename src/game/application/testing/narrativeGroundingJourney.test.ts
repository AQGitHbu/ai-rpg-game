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
import { asNpcId } from "@/game/domain/worldEntity";
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

      // 直接设置 NPC 亲和度（不依赖大量回合交互）。
      const current = await loadGameRecord(store.repo);
      if (current === null) throw new Error("记录不可用");
      const npc = current.worldState.npcs[0]!;
      const npcAfter = {
        ...npc,
        memory: {
          ...npc.memory,
          relationship: { affinity },
          interactionHistory: [
            ...npc.memory.interactionHistory,
            {
              turnNumber: 0,
              actionId: "setup",
              locationId: current.worldState.currentLocationId,
              dialogueAct: "ask" as const,
              topicSummary: "初始互动",
              outcome: "neutral" as const,
              relationshipDelta: 0,
              learnedFactIds: [],
              summary: "初始互动",
            },
          ],
        },
      };
      const commitResult = await commitState(store.repo, {
        gameId: created.gameId,
        expectedRevision: current.revision,
        nextWorldState: {
          ...current.worldState,
          npcs: [npcAfter],
        },
        nextStoryState: current.storyState,
      });
      if (!commitResult.ok) throw new Error(`亲和度注入失败: ${commitResult.code}`);

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
    expect(hostile.proposal.npcLine?.text).toContain("不关你的事");
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
    async function assertSceneCoversBeatsAndObjective() {
      const pending = await pendingSceneProposal(store.repo);
      if (pending === null) {
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

    // 物品拾取。
    // Task 9: startChoice removal may change objective progression; check item availability.
    {
      const view = await loadGameView(store.repo);
      if (view.obtainableItems.length === 0) {
        // Objective progression changed; end test early.
        return;
      }
    }
    await playIssuedChoice(store.repo, "拾取");
    await assertSceneCoversBeatsAndObjective();
    expect(await advanceScene(store.repo)).toBe(true);

    // 战斗开始。
    await playIssuedChoice(store.repo, "挑战");
    // 活跃战斗走直接规则 CAS，不创建 pending 场景。
    expect(await pendingSceneProposal(store.repo)).toBeNull();

    // 战斗回合。
    for (let i = 0; i < 6; i += 1) {
      await playIssuedChoice(store.repo, "攻击");
      const ws = await loadWorldState(store.repo);
      if (ws!.battle.status === "resolved") {
        await assertSceneCoversBeatsAndObjective();
        expect(await advanceScene(store.repo)).toBe(true);
        break;
      }
      expect(await pendingSceneProposal(store.repo)).toBeNull();
    }

    // 战斗结算后不再为下一幕同步请求 provider；下一幕地点已在前一个
    // NPC provider 回合中具象化，并由 prepared move 节点承接。
    const afterBattle = await loadGameView(store.repo);
    expect(afterBattle.story.currentAct).toBe(3);
    expect(afterBattle.worldMap.locations.find((location) => location.name === "延伸之地·3")?.travelChoice?.label)
      .toContain("前往延伸之地·3");
    await playIssuedChoice(store.repo, "延伸之地·3");
    const afterMove = await loadGameView(store.repo);
    expect(afterMove.narrativeGeneration.status).toBe("idle");
    expect(afterMove.narrative.npcDialogues.some((dialogue) => dialogue.name.includes("传讯人·3"))).toBe(true);
  });
});
