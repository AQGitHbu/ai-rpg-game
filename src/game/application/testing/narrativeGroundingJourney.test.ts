import { describe, it, expect } from "vitest";
import {
  createJourneyGame,
  playTurn,
  playIssuedChoice,
  advanceScene,
  pendingSceneProposal,
  loadWorldState,
  loadStoryState,
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
    const created = await createJourneyGame(undefined, undefined, "grounding-utterance", "short");
    const store = created.repo;
    await advanceScene(store.repo);

    // 先通过交谈让 NPC 在场景中
    await playIssuedChoice(store.repo, "交谈");
    await advanceScene(store.repo);

    // 用 scene 对话的 support 选项构建对话场景，使焦点 NPC 可接收自由输入
    await playIssuedChoice(store.repo, "支持");
    await advanceScene(store.repo);

    // 提交自由输入 + 目标 NPC
    const npcId = store.record()!.worldState.npcs[0]!.id;
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
    expect(utteranceSegment!.text).toContain("我相信你");

    // 断言：NPC 台词应答了 player_utterance 节拍。
    expect(proposal.npcLine).not.toBeNull();
    expect(proposal.npcLine!.answeredBeatIds).toContain("player_utterance");

    // 实际生成场景并保存。
    expect(await advanceScene(store.repo)).toBe(true);
  });

  it("敌意与信任亲和度 → 不同回应策略/兜底线", async () => {
    async function runWithAffinity(affinity: number) {
      const created = await createJourneyGame(undefined, undefined, `grounding-affinity-${affinity}`, "short");
      const store = created.repo;
      const record = await loadGameRecord(store.repo);
      if (record === null) throw new Error("记录不可用");

      // 先建立指向 npc_0 的 dialogue 场景（自由输入要求当前场景焦点 NPC 匹配）。
      await advanceScene(store.repo);
      await playIssuedChoice(store.repo, "交谈");
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

      // 提交自由输入（当前场景仍是指向 npc_0 的 dialogue）。
      const npcId = store.record()!.worldState.npcs[0]!.id;
      await playTurn(store.repo, {
        kind: "free_text",
        text: "你愿意告诉我真相吗？",
        targetNpcId: asNpcId(npcId),
      });

      const pending = await pendingSceneProposal(store.repo);
      if (pending === null) throw new Error("无 pending 场景");
      return pending;
    }

    const hostile = await runWithAffinity(-70);
    const trusted = await runWithAffinity(70);

    // 敌意 NPC 台词含"冷冷地答道"；信任 NPC 含"坦诚地说"。
    expect(hostile.proposal.npcLine?.text).toContain("冷冷地答道");
    expect(trusted.proposal.npcLine?.text).toContain("坦诚地说");
    expect(hostile.proposal.npcLine?.emotion).toBe("angry");
    expect(trusted.proposal.npcLine?.emotion).toBe("warm");
  });

  it("物品/任务/战斗 → 场景覆盖全部强制节拍 + objectiveLink == HUD 当前目标", async () => {
    const created = await createJourneyGame(undefined, undefined, "grounding-beats", "short");
    const store = created.repo;
    await advanceScene(store.repo);

    // Helper: 对当前 pending 断言场景覆盖全部强制节拍 + objectiveLink 一致性。
    async function assertSceneCoversBeatsAndObjective() {
      const pending = await pendingSceneProposal(store.repo);
      expect(pending).not.toBeNull();
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

    // 回合 1: 交谈 → 完成 quest_0，幕推进。
    await playIssuedChoice(store.repo, "交谈");
    await advanceScene(store.repo);

    // 物品拾取。
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

    // 完成第 2 幕主线。
    await playIssuedChoice(store.repo, "传讯人·2");
    await assertSceneCoversBeatsAndObjective();
    expect(await advanceScene(store.repo)).toBe(true);
  });
});
