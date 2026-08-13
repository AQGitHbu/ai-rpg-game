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
import type { WorldEvolutionSource } from "@/game/application/worldEvolutionSource";

// ---------------------------------------------------------------------------
// Step 3：同 seed 分叉旅程。
// 支持/质疑两个分支从同一 seed 出发：都具象化可完成内容、保留各自隔离的
// NPC 记忆，并抵达不同主题的结局方向；每条分支重复 replay 后 WorldState +
// StoryState 逐字节一致（离线确定性）。
//
// 结局分歧由生产规则承载：确定性演化源为两条结局附上关键 NPC（npc_0）的亲和度
// 达成要求（trust 需亲和度 ≥ TRUST_ENDING_MIN_AFFINITY，doubt ≤ 该值-1）。
// 支持分支（支持/信任互动）亲和度走高 → 命中信任结局；质疑分支（质疑/敌意
// 互动）亲和度走低 → 命中质疑结局。同一 stock 离线源、同一 seed、不同玩法
// → 不同结局解析，全程零 AI。
// ---------------------------------------------------------------------------

type Branch = {
  readonly name: "support" | "challenge";
  readonly fixedLabel: "支持" | "质疑";
  readonly customText: string;
};

const SUPPORT: Branch = { name: "support", fixedLabel: "支持", customText: "我相信你，我们一起查明真相" };
const CHALLENGE: Branch = { name: "challenge", fixedLabel: "质疑", customText: "你在撒谎，我会亲自揭穿真相" };

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
  const openingNpcName = store.record()!.worldState.npcs[0]!.name;

  await scene(); // 1: 序幕
  await fixed("交谈"); // 2: 完成第一幕
  await scene(); // 具象化第 2 幕内容
  await fixed(openingNpcName); // 主动重新开启与开场 NPC 的一轮对话
  await scene();
  await fixed(branch.fixedLabel); // 3: 固定分支选项
  await scene();
  await fixed(openingNpcName); // 固定选择后已退出焦点；再次主动交谈后才允许自由输入
  await scene();
  await freeText(branch.customText); // 4: 自定义分支输入
  await scene();
  reload(); // 重载 1
  await fixed("传讯人·2"); // 5: 完成第 2 幕主线
  await scene(); // 具象化第 3 幕内容
  reload(); // 重载 2
  await fixed("传讯人·3"); // 6: 完成最终幕主线
  await scene(); // 具象化结局对（stock 规则要求）
  await fixed("传讯人·2"); // 7: 结局落定
  await scene();
  reload(); // 重载 3

  const record = store.record();
  if (record === null) throw new Error("旅程结束后存档缺失");
  expect(successfulTurns).toBeGreaterThanOrEqual(6);
  expect(record.storyState.turnNumber).toBe(successfulTurns);
  expect(reloads).toBeGreaterThanOrEqual(3);
  expect(record.worldState.ending).not.toBeNull();
  return record;
}

describe("同 seed 的完整选择分叉与多结局（Step 3）", () => {
  it("支持与质疑分支都可完成，规则裁决为不同结局方向（信任 vs 质疑）", async () => {
    const support = await runBranch(SUPPORT, 1);
    const challenge = await runBranch(CHALLENGE, 1);
    const supportNpc = support.worldState.npcs[0]!;
    const challengeNpc = challenge.worldState.npcs[0]!;

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
    expect(supportEnding!.name).toContain("共同承担");
    expect(challengeEnding!.name).toContain("独自揭");
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
