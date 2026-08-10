import { describe, it, expect } from "vitest";
import { createJourneyGame } from "./foundationJourney.testutil";
import { commitState } from "@/game/application/stateCommit";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { projectGameSessionView } from "@/game/application/gameSessionView";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import { asNpcId } from "@/game/domain/scenarioBlueprint";
import type { StoryState } from "@/game/domain/storyState";

// ---------------------------------------------------------------------------
// 回归：ackPrologue 不递增 revision（方案 B）。
// 原 bug：ackPrologue 经 applyState 无条件 revision+1，使基于旧 revision
// 铸造的 choiceRegistry 全部失效 → 开局 dialogue 场景（焦点 NPC，如沈掌柜）
// 的固定选项在投影阶段被过滤（basedOnRevision !== revision），对话 UI 无
// 固定选项（且服务端 choiceMap 也无 token，点击会 UNKNOWN_CHOICE）。
// 修复后：prologueShown 是 UI 元数据，不改变世界状态，revision 保持不变。
// ---------------------------------------------------------------------------
describe("ackPrologue 不递增 revision，场景固定选项保持有效", () => {
  it("dialogue 场景生成后确认序章：revision 不变，焦点 NPC 对话仍投影出 2 个固定选项且 choiceMap 可解析", async () => {
    const created = await createJourneyGame();
    const repo = created.repo.repo;

    const current = await repo.getCurrentGame();
    if (!current.ok || current.status !== "active") throw new Error("存档不可用");
    const { worldState, storyState } = current.record;
    const npcId = asNpcId("npc_innkeeper");

    // 注入一个 dialogue 场景：2 个 talk 固定选项（复现用户存档形态）
    const sceneId = "scene-regression-ack";
    const basedOnRevision = current.record.revision + 1; // = 1
    const choiceA = createApprovedChoice({
      sceneId,
      basedOnRevision,
      label: "表示愿意支持沈掌柜",
      action: { type: "talk", npcId, dialogueAct: "support" },
    });
    const choiceB = createApprovedChoice({
      sceneId,
      basedOnRevision,
      label: "质疑他的说法",
      action: { type: "talk", npcId, dialogueAct: "challenge" },
    });
    if (!choiceA.ok || !choiceB.ok) throw new Error("fixture approval failed");

    const scene: StoryState["narrative"]["currentScene"] = {
      sceneId,
      turn: storyState.turnNumber,
      narration: "沈掌柜注视着你。",
      usedFactIds: [],
      npcLine: { npcId, text: "客官，您来得正好。", emotion: "neutral", usedFactIds: [] },
      choices: [
        { choiceToken: choiceA.choice.choiceToken, label: choiceA.choice.label },
        { choiceToken: choiceB.choice.choiceToken, label: choiceB.choice.label },
      ],
      source: "generated",
      event: { kind: "dialogue", focusNpcId: npcId },
      npcDialogues: [],
    };

    const writeBack = await repo.applySceneWriteBack({
      gameId: current.record.gameId,
      expectedRevision: current.record.revision,
      nextNarrative: {
        ...storyState.narrative,
        currentScene: scene,
        generation: { status: "idle" },
        choiceRegistry: [choiceA.choice, choiceB.choice],
      },
      nextCandidateEventPool: storyState.candidateEventPool,
    });
    expect(writeBack.ok).toBe(true);

    // 场景写回后 rev 0 → 1，基于 onRevision 与 revision 一致：基线投影 2 个选项
    const afterWrite = await repo.getCurrentGame();
    if (!afterWrite.ok || afterWrite.status !== "active") throw new Error("存档不可用");
    expect(afterWrite.record.revision).toBe(1);
    let view = projectGameSessionView(
      afterWrite.record.worldState, afterWrite.record.storyState, afterWrite.record.revision, "s",
    );
    const focusDialogue = view.narrative.npcDialogues.find((dialogue) => dialogue.freeInputEnabled);
    expect(focusDialogue).toBeDefined();
    expect(focusDialogue?.choices).toHaveLength(2);

    // 模拟生产 ackPrologue：只置 prologueShown，不递增 revision
    const commit = await commitState(repo, {
      gameId: afterWrite.record.gameId,
      expectedRevision: afterWrite.record.revision,
      nextWorldState: afterWrite.record.worldState,
      nextStoryState: { ...afterWrite.record.storyState, prologueShown: true },
      incrementRevision: false,
    });
    expect(commit.ok).toBe(true);
    if (!commit.ok) return;
    expect(commit.record.revision).toBe(1); // revision 未漂移（原 bug：会变成 2）
    expect(commit.record.storyState.prologueShown).toBe(true);

    // ack 后投影：焦点 NPC 对话仍有 2 个固定选项
    view = projectGameSessionView(
      commit.record.worldState, commit.record.storyState, commit.record.revision, "s",
    );
    const focusAfter = view.narrative.npcDialogues.find((dialogue) => dialogue.freeInputEnabled);
    expect(focusAfter).toBeDefined();
    expect(focusAfter?.choices).toHaveLength(2);

    // 服务端 choiceMap 仍能解析这两个 token（点击不会 UNKNOWN_CHOICE）
    const map = buildChoiceMap(commit.record.worldState, commit.record.storyState, commit.record.revision);
    for (const choice of focusAfter?.choices ?? []) {
      expect(map.has(choice.choiceToken)).toBe(true);
    }
  });
});
