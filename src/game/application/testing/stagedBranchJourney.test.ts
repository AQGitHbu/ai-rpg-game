// 真用例链验收（Plan 2026-09-09 / Task 12 Step 1）。
//
// 两个分支必须从「同一获批状态」分叉：左/右两个 token 共享同一个
// approveDecision 产物与同一份已发布叙事，只在候选身份上不同。禁止手写
// branchDecisions / selectedBranches 字面量来伪造分叉。
//
// 覆盖 Spec §11「两条分支」「假分支」「意图与结果」「条件消费」
// 「正常回合推进」「发布原子性」。

import { describe, it, expect } from "vitest";
import { performTurn } from "@/game/application/performTurn";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import type { ApplyStateInput, GameRecord, GameRepository } from "@/game/application/server/persistence/gameRepository";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import { createFixtureNarrativeScene } from "@/game/domain/narrativeTestFixture.testutil";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { Decision } from "@/game/domain/narrativeBranch";
import {
  LOC_A,
  LOC_B,
  LOC_C,
  NPC_0,
  QUEST_0,
  branchDecision,
  branchStory,
  branchWorld,
} from "@/game/gameplay/rpg/narrativePlanning/branchFixture.testutil";
import { approveDecision, decisionIdOf } from "@/game/gameplay/rpg/narrativePlanning";

const SCENE_ID = "scene_branch";

type Setup = {
  readonly repo: GameRepository;
  readonly record: () => GameRecord | null;
  readonly applyCalls: () => readonly ApplyStateInput[];
  readonly decisionId: string;
  readonly tokenFor: (candidateId: string) => string;
  readonly before: { readonly worldState: WorldState; readonly storyState: StoryState };
};

/**
 * 单一获批状态：左/右候选在同一次 approveDecision 中铸出，两个分支只克隆记录。
 * 返回的 Setup 每个分支一份，但共享同一个 decisionId 与同一份叙事注册表。
 */
function approvedState() {
  const world = branchWorld();
  const baseStory = branchStory();
  const decision = branchDecision();
  const approval = approveDecision({ decision, world, story: baseStory });
  expect(approval.ok).toBe(true);
  const approved: Decision = approval.ok ? approval.value : decision;
  const decisionId = decisionIdOf(approved);
  return { world, baseStory, approved, decisionId };
}

function branchSetup(
  shared: ReturnType<typeof approvedState>,
  actionFor: (candidateId: string) => { type: "talk"; npcId: typeof NPC_0; dialogueAct: "support" | "challenge" },
): Setup {
  const { world, baseStory, approved, decisionId } = shared;
  const makeChoice = (candidateId: string, label: string) => {
    const built = createApprovedChoice({
      sceneId: SCENE_ID,
      basedOnRevision: 0,
      label,
      action: actionFor(candidateId),
      branch: { decisionId, candidateId },
    });
    if (!built.ok) throw new Error(`choice rejected: ${built.reason}`);
    return built.choice;
  };
  const left = makeChoice("left", "去废窑查那批货");
  const right = makeChoice("right", "去义庄查失踪的人");

  const story: StoryState = {
    ...baseStory,
    branchDecisions: { [decisionId]: approved },
    narrative: {
      status: "ready",
      mode: "offline",
      currentScene: {
        ...createFixtureNarrativeScene({
          sceneId: SCENE_ID,
          event: { kind: "dialogue", focusNpcId: NPC_0 },
          choices: [
            { choiceToken: left.choiceToken, label: left.label },
            { choiceToken: right.choiceToken, label: right.label },
          ],
        }),
      },
      choiceRegistry: [left, right],
    },
  };

  let record: GameRecord = {
    gameId: asGameId("g_branch"), worldState: world, storyState: story, revision: 0, createdAt: "2026-09-09",
  };
  const applyCallsHistory: ApplyStateInput[] = [];
  const repo: GameRepository = {
    async createInitialGame() { return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const }; },
    async replaceCurrentGame() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
    async getCurrentGame() { return { ok: true, status: "active", record }; },
    async applyState(input) {
      applyCallsHistory.push(input);
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async applySceneWriteBack() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
    async clearCurrentGame() { return { ok: true as const }; },
  };

  return {
    repo,
    record: () => record,
    applyCalls: () => applyCallsHistory,
    decisionId,
    tokenFor: (candidateId) => (candidateId === "left" ? left.choiceToken : right.choiceToken),
    before: { worldState: world, storyState: story },
  };
}

/** 与既有测试同形的默认动作映射：left→support，right→challenge。 */
const branchAction = (candidateId: string) => ({
  type: "talk" as const,
  npcId: NPC_0,
  dialogueAct: candidateId === "left" ? ("support" as const) : ("challenge" as const),
});

function setup(): Setup {
  return branchSetup(approvedState(), branchAction);
}

async function run(candidateId: "left" | "right", setup_: Setup) {
  return performTurn(
    {
      gameId: asGameId("g_branch"),
      actionId: `act_${candidateId}`,
      interaction: { kind: "fixed_choice", choiceToken: setup_.tokenFor(candidateId) },
      expectedRevision: 0,
      choiceMap: buildChoiceMap(setup_.before.worldState, setup_.before.storyState, 0),
    },
    { repository: setup_.repo, now: () => "2026-09-09T00:00:00.000Z" },
  );
}

describe("staged branch journey", () => {
  it("两个分支从同一获批状态分叉：共享 decisionId 与叙事，只有候选不同", async () => {
    // 单一获批状态：两个分支各自克隆记录，而不是各自重新批准一套决策。
    const shared = approvedState();
    const leftSetup = branchSetup(shared, branchAction);
    const rightSetup = branchSetup(shared, branchAction);
    expect(leftSetup.decisionId).toBe(rightSetup.decisionId);

    const left = await run("left", leftSetup);
    const right = await run("right", rightSetup);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);

    const leftRecord = leftSetup.record();
    const rightRecord = rightSetup.record();
    if (leftRecord === null || rightRecord === null) throw new Error("missing record");

    // 两条路线确实不同，且都来自同一 decisionId。
    expect(leftRecord.storyState.selectedBranches[shared.decisionId]).toBe("left");
    expect(rightRecord.storyState.selectedBranches[shared.decisionId]).toBe("right");

    const leftQuest = leftRecord.worldState.quests.find((q) => String(q.id) === String(QUEST_0));
    const rightQuest = rightRecord.worldState.quests.find((q) => String(q.id) === String(QUEST_0));
    expect(leftQuest?.objectives).toEqual([{ kind: "visit_location", locationId: LOC_B }]);
    expect(rightQuest?.objectives).toEqual([{ kind: "visit_location", locationId: LOC_C }]);
    expect(leftQuest).not.toEqual(rightQuest);

    // 分支不能替玩家移动：玩家仍在原地点，任务没有提前结算。
    expect(String(leftRecord.worldState.currentLocationId)).toBe(String(LOC_A));
    expect(String(rightRecord.worldState.currentLocationId)).toBe(String(LOC_A));
    expect(leftQuest?.status).toBe("active");
    expect(rightQuest?.status).toBe("active");
  });

  it("两个候选的公开意图不同：不是只换地点名的假分支", () => {
    const shared = approvedState();
    const intents = shared.approved.options.map((option) => option.publicIntent.text);
    expect(new Set(intents).size).toBe(2);
    const targets = shared.approved.options.map((option) =>
      option.target?.kind === "visit_location" ? String(option.target.locationId) : option.target?.kind);
    expect(new Set(targets).size).toBe(2);
  });

  it("commits exactly once and emits one branch event", async () => {
    const setup_ = setup();
    const result = await run("left", setup_);
    expect(result.ok).toBe(true);
    expect(setup_.applyCalls()).toHaveLength(1);
    const record = setup_.record();
    if (record === null) throw new Error("missing record");
    const branchEvents = record.worldState.eventLedger.filter((e) => e.kind === "narrative_branch_selected");
    expect(branchEvents).toHaveLength(1);
    expect(branchEvents[0]?.payload).toMatchObject({
      type: "narrative_branch_selected",
      candidateId: "left",
      target: { kind: "visit_location", locationId: LOC_B },
    });
  });

  it("rejects a token whose decision is no longer in the server registry", async () => {
    const setup_ = setup();
    const record = setup_.record();
    if (record === null) throw new Error("missing record");
    // 服务端 registry 被清空：客户端拿着同样的 token 也不能再造出分支。
    const emptied: GameRecord = {
      ...record,
      storyState: { ...record.storyState, branchDecisions: {} },
    };
    let current = emptied;
    const repo: GameRepository = {
      ...setup_.repo,
      async getCurrentGame() { return { ok: true, status: "active", record: current }; },
      async applyState(input) {
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true, record: current };
      },
    };
    const result = await performTurn(
      {
        gameId: asGameId("g_branch"),
        actionId: "act_orphan",
        interaction: { kind: "fixed_choice", choiceToken: setup_.tokenFor("left") },
        expectedRevision: 0,
        choiceMap: buildChoiceMap(emptied.worldState, emptied.storyState, 0),
      },
      { repository: repo, now: () => "2026-09-09T00:00:00.000Z" },
    );
    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
  });

  it("replaying the same token against an already-selected branch writes nothing", async () => {
    const setup_ = setup();
    const first = await run("left", setup_);
    expect(first.ok).toBe(true);
    const record = setup_.record();
    if (record === null || !first.ok) throw new Error("missing record");
    const second = await performTurn(
      {
        gameId: asGameId("g_branch"),
        actionId: "act_replay",
        interaction: { kind: "fixed_choice", choiceToken: setup_.tokenFor("left") },
        expectedRevision: first.revision,
        choiceMap: buildChoiceMap(record.worldState, record.storyState, first.revision),
      },
      { repository: setup_.repo, now: () => "2026-09-09T00:00:00.000Z" },
    );
    // 同一分支被再次提交时规则层按 stale 拒绝，不产生第二次写入。
    expect(second.ok).toBe(false);
    expect(setup_.applyCalls()).toHaveLength(1);
  });

  it("意图不自动产生后果：talk 分支不移动、不结算、不发放奖励", async () => {
    const setup_ = setup();
    const before = setup_.before.worldState;
    const result = await run("left", setup_);
    expect(result.ok).toBe(true);
    const record = setup_.record();
    if (record === null) throw new Error("missing record");

    expect(String(record.worldState.currentLocationId)).toBe(String(before.currentLocationId));
    expect(record.worldState.inventory).toEqual(before.inventory);
    expect(record.worldState.ending).toBe(before.ending);
    // 只有目标被改写，没有新的 quest 被凭空创建或结算。
    expect(record.worldState.quests).toHaveLength(before.quests.length);
  });

  it("过期 revision 的选择被拒绝，零越权写入", async () => {
    const setup_ = setup();
    // 用错误的 expectedRevision 提交：规则层必须拒绝且不落任何写入。
    const stale = await performTurn(
      {
        gameId: asGameId("g_branch"),
        actionId: "act_stale",
        interaction: { kind: "fixed_choice", choiceToken: setup_.tokenFor("left") },
        expectedRevision: 7,
        choiceMap: buildChoiceMap(setup_.before.worldState, setup_.before.storyState, 7),
      },
      { repository: setup_.repo, now: () => "2026-09-09T00:00:00.000Z" },
    );
    expect(stale.ok).toBe(false);
    expect(setup_.applyCalls()).toHaveLength(0);
    expect(setup_.record()?.revision).toBe(0);
  });

  it("条件消费：未选中的分支不会出现对应目标或事件", async () => {
    const setup_ = setup();
    const result = await run("left", setup_);
    expect(result.ok).toBe(true);
    const record = setup_.record();
    if (record === null) throw new Error("missing record");

    const quest = record.worldState.quests.find((q) => String(q.id) === String(QUEST_0));
    const objectives = quest?.objectives ?? [];
    // 选中左支：不得同时出现右支目标；事件账本只记录被选中的那一条。
    expect(objectives).toEqual([{ kind: "visit_location", locationId: LOC_B }]);
    expect(objectives.some((objective) =>
      objective.kind === "visit_location" && String(objective.locationId) === String(LOC_C))).toBe(false);

    const branchEvents = record.worldState.eventLedger.filter((e) => e.kind === "narrative_branch_selected");
    expect(branchEvents).toHaveLength(1);
    expect(branchEvents[0]?.payload).toMatchObject({ candidateId: "left" });
  });
});
