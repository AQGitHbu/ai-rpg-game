import { describe, expect, it } from "vitest";
import {
  advanceScene,
  createInMemoryRepo,
  createJourneyGame,
  createJourneyEvolutionSource,
  playIssuedChoice,
  playTurn,
  type InMemoryRepo,
} from "./foundationJourney.testutil";
import { asGameId } from "@/game/application/server/persistence/gameRepository";
import { asNpcId } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";

// ---------------------------------------------------------------------------
// Step 3：同 seed 分叉旅程。
// 玩家口吻/非对白两个选项从同一 seed 出发：都具象化可完成内容、保留各自隔离的
// NPC 记忆，并抵达不同主题的结局方向；每条分支重复 replay 后 WorldState +
// StoryState 逐字节一致（离线确定性）。
//
// 结局分歧由生产规则承载：确定性演化源为两条结局附上关键 NPC（stage 最大主线的
// 交谈目标）的亲和度达成要求（trust 需亲和度 ≥ TRUST_ENDING_MIN_AFFINITY，
// doubt ≤ 该值-1）。终幕向该 NPC 提交支持/质疑自由文本驱动其亲和度与情绪分化，
// 与结局方向裁决同源：信任分支（自定义对白）亲和度走高 → 命中信任结局；
// 质疑分支（自定义对白）亲和度走低 → 命中质疑结局。同一 stock 离线源、同一
// seed、不同玩法 → 不同结局解析，全程零 AI。
// ---------------------------------------------------------------------------

type Branch = {
  readonly name: "support" | "challenge";
  readonly fixedLabel: "回应";
  readonly customText: string;
};

const SUPPORT: Branch = { name: "support", fixedLabel: "回应", customText: "我相信你，我们一起查明真相" };
const CHALLENGE: Branch = { name: "challenge", fixedLabel: "回应", customText: "你在撒谎，我会亲自揭穿真相" };

/**
 * 结局锚点 NPC：stage 最大的主线任务中第一个 talk_to_npc 目标；无任何主线
 * 交谈目标时回退开局首位 NPC。与生产规则 deriveKeyEndingNpcId 同规则，但
 * 测试本地实现，不依赖 gameplay 层导入（journey 断言同源可读）。
 */
function finalTalkNpcIdOf(ws: WorldState): string {
  const mainQuests = ws.quests.filter((q) => q.kind === "main").sort((a, b) => (b.stage ?? 0) - (a.stage ?? 0));
  for (const quest of mainQuests) {
    const talk = quest.objectives.find((o) => o.kind === "talk_to_npc");
    if (talk) return String(talk.npcId);
  }
  return String(ws.npcs[0]!.id);
}

async function runBranch(branch: Branch, replay: number) {
  const gameId = asGameId(`divergence_${branch.name}_${replay}`);
  let store: InMemoryRepo = createInMemoryRepo(gameId);
  await createJourneyGame(gameId, store, "shared-branch-seed", "short");
  const source: WorldEvolutionSource = createJourneyEvolutionSource();
  let successfulTurns = 0;
  let reloads = 0;
  const accept = (result: { readonly ok: boolean }) => {
    expect(result.ok).toBe(true);
    if (result.ok) successfulTurns += 1;
  };
  const fixed = async (label: string) => accept(await playIssuedChoice(store.repo, label, source));
  const scene = async () => expect(await advanceScene(store.repo, source)).toBe(true);
  const defeat = async (enemyName: string) => {
    await fixed(enemyName);
    while (store.record()!.worldState.battle.status === "active") await fixed("攻击");
    await scene();
  };
  const finishActEvidence = async (act: number) => {
    await fixed(`信物·${act}`);
    await scene();
    await defeat(`守径人·${act}`);
  };
  const reload = () => {
    const snapshot = store.record();
    if (snapshot === null) throw new Error("reload 缺少存档");
    const next = createInMemoryRepo(gameId);
    next.restore(structuredClone(snapshot));
    store = next;
    reloads += 1;
  };
  const freeText = async (text: string) => {
    const npcId = store.record()!.worldState.npcs[0]!.id;
    accept(await playTurn(store.repo, { kind: "free_text", text, targetNpcId: asNpcId(npcId) }, new Map(), () => "2026-08-09T00:00:00.000Z", source));
  };
  const finalTalkNpcId = (): string => {
    const ws = store.record()!.worldState;
    const mainQuests = ws.quests.filter((q) => q.kind === "main").sort((a, b) => (b.stage ?? 0) - (a.stage ?? 0));
    for (const quest of mainQuests) {
      const talk = quest.objectives.find((o) => o.kind === "talk_to_npc");
      if (talk) return String(talk.npcId);
    }
    return String(ws.npcs[0]!.id);
  };
  const freeTextToFinalNpc = async (text: string) => {
    accept(await playTurn(store.repo, { kind: "free_text", text, targetNpcId: asNpcId(finalTalkNpcId()) }, new Map(), () => "2026-08-09T00:00:00.000Z", source));
  };
  const openingNpcName = store.record()!.worldState.npcs[0]!.name;

  await scene(); // 1: 序幕
  await fixed("交谈"); // 2: 完成第一幕
  await scene(); // 具象化第 2 幕内容
  await fixed(openingNpcName); // 主动重新开启与开场 NPC 的一轮对话
  await scene();
  await fixed(branch.fixedLabel); // 3: 玩家口吻固定回应
  await scene();
  await fixed(openingNpcName); // 固定选择后已退出焦点；再次主动交谈后才允许自由输入
  await scene();
  await freeText(branch.customText); // 4: 自定义分支输入
  await scene();
  reload(); // 重载 1
  await fixed("延伸之地·2"); // 5: 前往第 2 幕地点
  await scene();
  await fixed("传讯人·2"); // 6: 完成第 2 幕主线交谈步骤
  await scene();
  await finishActEvidence(2);
  await scene(); // 具象化第 3 幕内容
  reload(); // 重载 2
  await fixed("延伸之地·3"); // 7: 前往最终幕地点
  await scene();
  await fixed("传讯人·3"); // 8: 完成最终幕主线交谈步骤
  await scene();
  await freeTextToFinalNpc(branch.customText); // 终幕向结局锚点 NPC 提交支持/质疑，驱动亲和度分化
  await scene();
  await finishActEvidence(3);
  await scene(); // 具象化结局对（stock 规则要求）
  await fixed(branch.name === "support" ? "回应" : "质疑"); // 7: 明确选择结局方向后落定
  await scene();
  reload(); // 重载 3

  const record = store.record();
  if (record === null) throw new Error("旅程结束后存档缺失");
  expect(successfulTurns).toBeGreaterThanOrEqual(10);
  expect(record.storyState.turnNumber).toBe(successfulTurns);
  expect(reloads).toBeGreaterThanOrEqual(3);
  expect(record.worldState.ending).not.toBeNull();
  return record;
}

describe("同 seed 的完整选择分叉与多结局（Step 3）", () => {
  it("玩家口吻/自定义质疑分支都可完成，规则裁决为不同结局方向", async () => {
    const support = await runBranch(SUPPORT, 1);
    const challenge = await runBranch(CHALLENGE, 1);
    const supportNpc = support.worldState.npcs.find((n) => String(n.id) === finalTalkNpcIdOf(support.worldState))!;
    const challengeNpc = challenge.worldState.npcs.find((n) => String(n.id) === finalTalkNpcIdOf(challenge.worldState))!;

    // 隔离的 NPC 记忆分叉：支持 → 更高的亲和度、热络情绪；质疑 → 更低的亲和度、防备情绪。
    expect(supportNpc.memory.relationship.affinity).toBeGreaterThan(challengeNpc.memory.relationship.affinity);
    expect(supportNpc.memory.interactionHistory).not.toEqual(challengeNpc.memory.interactionHistory);
    expect(supportNpc.memory.emotion).toBe("warm");
    expect(challengeNpc.memory.emotion).toBe("guarded");

    // 结局对以规则要求铸造：两条结局附有互斥的亲和度门槛。
    const supportEnding = support.worldState.endings.find((e) => e.id === support.worldState.ending?.endingId);
    const challengeEnding = challenge.worldState.endings.find((e) => e.id === challenge.worldState.ending?.endingId);
    expect(supportEnding).toBeDefined();
    expect(challengeEnding).toBeDefined();
    expect(supportEnding!.requirements.length).toBeGreaterThan(0);
    expect(challengeEnding!.requirements.length).toBeGreaterThan(0);

    // 支持分支命中信任方向；质疑分支命中质疑方向——离线（零 AI）也能靠规则区分。
    expect(supportEnding!.name).toContain("共同揭露");
    expect(challengeEnding!.name).toContain("独自追查");
    expect(supportEnding!.name).not.toBe(challengeEnding!.name);

    expect(support.worldState.eventLedger.some((event) => event.type === "ending_reached")).toBe(true);
    expect(challenge.worldState.eventLedger.some((event) => event.type === "ending_reached")).toBe(true);
  });

  it("每条完整分支重复 replay 的规则状态与事件账本完全确定（离线深比较）", async () => {
    const supportOne = await runBranch(SUPPORT, 1);
    const supportTwo = await runBranch(SUPPORT, 2);
    const challengeOne = await runBranch(CHALLENGE, 1);
    const challengeTwo = await runBranch(CHALLENGE, 2);

    expect(supportTwo.worldState).toEqual(supportOne.worldState);
    expect(supportTwo.storyState).toEqual(supportOne.storyState);
    expect(challengeTwo.worldState).toEqual(challengeOne.worldState);
    expect(challengeTwo.storyState).toEqual(challengeOne.storyState);

    // 分叉间世界状态确实不同（NPC 记忆与结局解析），但不是同一份状态的别名。
    expect(supportOne.worldState).not.toEqual(challengeOne.worldState);
  });
});
