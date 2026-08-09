import { describe, expect, it } from "vitest";
import {
  advanceScene,
  createInMemoryRepo,
  createJourneyGame,
  playIssuedChoice,
  playIssuedTravelToUnvisited,
  playTurn,
  type InMemoryRepo,
} from "./foundationJourney.testutil";
import { asGameId } from "@/game/application/server/persistence/gameRepository";

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
  await createJourneyGame(gameId, store, "shared-branch-seed");
  let successfulTurns = 0;
  let reloads = 0;
  const accept = (result: { readonly ok: boolean }) => {
    expect(result.ok).toBe(true);
    if (result.ok) successfulTurns += 1;
  };
  const fixed = async (label: string) => accept(await playIssuedChoice(store.repo, label));
  const travel = async () => accept(await playIssuedTravelToUnvisited(store.repo));
  const scene = async () => expect(await advanceScene(store.repo)).toBe(true);
  const reload = () => {
    const snapshot = store.record();
    if (snapshot === null) throw new Error("reload 缺少存档");
    const next = createInMemoryRepo(gameId);
    next.restore(structuredClone(snapshot));
    store = next;
    reloads += 1;
  };

  await scene();
  await fixed("交谈"); // 1: unlock act 2 route
  await scene();
  await fixed(branch.fixedLabel); // 2: fixed NPC branch
  await scene();
  const npcId = store.record()!.worldState.npcs[0]!.id;
  accept(await playTurn(store.repo, { kind: "free_text", text: branch.customText, targetNpcId: npcId })); // 3: custom NPC branch
  await scene();
  await fixed("休息"); // 4: activate branch event
  await scene();
  await fixed("探索"); // 5
  await scene();
  reload();
  await travel(); // 6
  await scene();
  await fixed("拾取"); // 7: unlock act 3 route
  await scene();
  await fixed("休息"); // 8
  await scene();
  await fixed("探索"); // 9
  await scene();
  reload();
  await travel(); // 10
  await scene();
  await fixed("探索"); // 11
  await scene();
  await fixed("挑战"); // 12: start climax battle
  await scene();
  reload();
  await fixed("攻击"); // 13
  await scene();
  await fixed("攻击"); // 14
  await scene();
  await fixed("攻击"); // 15: resolve climax and ending

  const record = store.record();
  if (record === null) throw new Error("旅程结束后存档缺失");
  expect(successfulTurns).toBeGreaterThanOrEqual(15);
  expect(record.storyState.turnNumber).toBe(successfulTurns);
  expect(reloads).toBeGreaterThanOrEqual(3);
  expect(record.worldState.ending).not.toBeNull();
  return record;
}

describe("同 seed 的完整选择分叉与多结局", () => {
  it("支持与质疑分支都可完成，并形成关系、候选事件与结局差异", async () => {
    const support = await runBranch(SUPPORT, 1);
    const challenge = await runBranch(CHALLENGE, 1);
    const supportNpc = support.worldState.npcs[0]!;
    const challengeNpc = challenge.worldState.npcs[0]!;

    expect(supportNpc.memory.relationship.affinity).toBeGreaterThan(challengeNpc.memory.relationship.affinity);
    expect(supportNpc.memory.interactionHistory).not.toEqual(challengeNpc.memory.interactionHistory);
    expect(supportNpc.memory.emotion).toBe("warm");
    expect(challengeNpc.memory.emotion).toBe("afraid");
    const supportCandidate = support.worldState.eventLedger.find((event) => event.type === "candidate_event_activated");
    const challengeCandidate = challenge.worldState.eventLedger.find((event) => event.type === "candidate_event_activated");
    expect(supportCandidate?.type === "candidate_event_activated" ? supportCandidate.candidateId : null).toContain("stance-friendly");
    expect(challengeCandidate?.type === "candidate_event_activated" ? challengeCandidate.candidateId : null).toContain("stance-hostile");
    expect(support.worldState.ending?.endingId).not.toBe(challenge.worldState.ending?.endingId);
    expect(String(support.worldState.ending?.endingId)).toBe("ending_trust");
    expect(String(challenge.worldState.ending?.endingId)).toBe("ending_doubt");
  });

  it("每条完整分支重复 replay 的规则状态与事件账本完全确定", async () => {
    const supportOne = await runBranch(SUPPORT, 1);
    const supportTwo = await runBranch(SUPPORT, 2);
    const challengeOne = await runBranch(CHALLENGE, 1);
    const challengeTwo = await runBranch(CHALLENGE, 2);

    expect(supportTwo.worldState).toEqual(supportOne.worldState);
    expect(supportTwo.storyState).toEqual(supportOne.storyState);
    expect(challengeTwo.worldState).toEqual(challengeOne.worldState);
    expect(challengeTwo.storyState).toEqual(challengeOne.storyState);
  });
});
