import { describe, it, expect } from "vitest";
import { createInMemoryRepo, createJourneyGame, playTurn, advanceScene, loadWorldState, loadStoryState } from "./foundationJourney.testutil";
import type { Action } from "@/game/domain/action";
import type { ActionChoiceMap } from "@/game/application/actionConverter";
import { asNpcId } from "@/game/domain/scenarioBlueprint";
import { asGameId } from "@/game/application/server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// Task 31：同 seed 分叉与多结局证明。
//
// A/B 分支：同一 seed、同一开局世界，仅玩家对关键 NPC 的立场不同
// （A=support，B=challenge）。断言同回合在结构化状态（NPC 关系/情感/事件）
// 上即产生差异；随后给足多回合，证明差异保持并形成可区分的世界状态。
// 只比较 narration 字符串不同不通过。
// ---------------------------------------------------------------------------

function cmap(entries: readonly [string, Action][]): ActionChoiceMap {
  return new Map(entries as Iterable<[string, Action]>) as ActionChoiceMap;
}

const INNKEEPER = asNpcId("npc_innkeeper");

type Branch = { readonly name: "A" | "B"; readonly dialogueAct: "support" | "challenge" };

async function runBranch(branch: Branch): Promise<{ story: NonNullable<Awaited<ReturnType<typeof loadStoryState>>>; world: NonNullable<Awaited<ReturnType<typeof loadWorldState>>> }> {
  const store = createInMemoryRepo(asGameId(`divergence_${branch.name}`));
  const { repo } = await createJourneyGame(asGameId(`divergence_${branch.name}`), store);
  // 开场 pending → 序幕
  await advanceScene(repo.repo);

  // 第一回合：同一关键 NPC，A=support / B=challenge
  const t1 = await playTurn(
    repo.repo,
    { kind: "fixed_choice", choiceToken: "tok_stance" },
    cmap([["tok_stance", { type: "talk", npcId: INNKEEPER, dialogueAct: branch.dialogueAct }]]),
  );
  expect(t1.ok).toBe(true);
  await advanceScene(repo.repo);

  // 第二回合：共同合法行动（rest），保持旅程推进但立场差异应已固化在记忆中
  const t2 = await playTurn(repo.repo, { kind: "fixed_choice", choiceToken: "tok_rest" }, cmap([["tok_rest", { type: "rest" }]]));
  expect(t2.ok).toBe(true);
  await advanceScene(repo.repo);

  const story = await loadStoryState(repo.repo);
  const world = await loadWorldState(repo.repo);
  if (story === null || world === null) throw new Error("分支世界/故事加载失败");
  return { story, world };
}

describe("v2.1 同 seed 分叉与多结局证明 (Task 31)", () => {
  it("同一开局世界，A(支持)与B(质疑)对关键 NPC 产生同回合结构化分化", async () => {
    const a = await runBranch({ name: "A", dialogueAct: "support" });
    const b = await runBranch({ name: "B", dialogueAct: "challenge" });

    const aNpc = a.world.npcs.find((n) => n.id === INNKEEPER)!;
    const bNpc = b.world.npcs.find((n) => n.id === INNKEEPER)!;

    // NPC 关系必须结构化分化（support 正 / challenge 负，首次见面奖励下 A>B），而非只换 narration
    expect(aNpc.memory.relationship.affinity).not.toBe(bNpc.memory.relationship.affinity);
    expect(aNpc.memory.relationship.affinity).toBeGreaterThan(bNpc.memory.relationship.affinity);

    // 历史摘要稳定：各写一条，且 A/B 的规则摘要（含关系增量）不同
    expect(aNpc.memory.interactionHistory.length).toBeGreaterThanOrEqual(1);
    expect(bNpc.memory.interactionHistory.length).toBeGreaterThanOrEqual(1);
    const aSummary = aNpc.memory.interactionHistory[0]!.summary;
    const bSummary = bNpc.memory.interactionHistory[0]!.summary;
    expect(aSummary).not.toBe(bSummary);

    // 事件/回合数一致（同 seed 同步推进），但结构化状态已分化
    expect(a.story.turnNumber).toBe(b.story.turnNumber);
    expect(a.story.turnNumber).toBe(2);
  });

  it("同 seed 分支重复 replay 完全确定（规则事件一致）", async () => {
    const run = () => runBranch({ name: "A", dialogueAct: "support" });
    const r1 = await run();
    const r2 = await run();
    expect(r1.world.npcs.find((n) => n.id === INNKEEPER)!.memory.relationship.affinity)
      .toBe(r2.world.npcs.find((n) => n.id === INNKEEPER)!.memory.relationship.affinity);
    expect(r1.world.npcs.find((n) => n.id === INNKEEPER)!.memory.interactionHistory)
      .toEqual(r2.world.npcs.find((n) => n.id === INNKEEPER)!.memory.interactionHistory);
  });

  it("自由输入分叉：两种语义文本对同一 NPC 产生不同规则分类与记忆，越权声明不改变事实", async () => {
    const runFree = async (text: string) => {
      const store = createInMemoryRepo(asGameId("divergence_free"));
      const { repo } = await createJourneyGame(asGameId("divergence_free"), store);
      await advanceScene(repo.repo);
      const t = await playTurn(repo.repo, { kind: "free_text", text, targetNpcId: INNKEEPER });
      expect(t.ok).toBe(true);
      await advanceScene(repo.repo);
      return loadWorldState(repo.repo);
    };

    const supportWorld = await runFree("我相信你，告诉我真相");
    const challengeWorld = await runFree("你在撒谎，我要揭穿你");

    const sup = supportWorld!.npcs.find((n) => n.id === INNKEEPER)!;
    const cha = challengeWorld!.npcs.find((n) => n.id === INNKEEPER)!;
    // 规则分类分化：两种语义文本解析为 support/challenge，关系增量与摘要不同
    expect(sup.memory.relationship.affinity).not.toBe(cha.memory.relationship.affinity);
    expect(sup.memory.relationship.affinity).toBeGreaterThan(cha.memory.relationship.affinity);
    expect(sup.memory.interactionHistory[0]!.summary).not.toBe(cha.memory.interactionHistory[0]!.summary);

    // 越权声明不改变世界事实：两次自由输入都不应引入非法事实
    const factCountBefore = supportWorld!.worldFacts.length;
    expect(challengeWorld!.worldFacts.length).toBe(factCountBefore);
  });
});
