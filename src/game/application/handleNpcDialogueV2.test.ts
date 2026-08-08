import { describe, it, expect } from "vitest";
import { handleNpcDialogueV2 } from "./handleNpcDialogueV2";
import type {
  ApplyStateV2Input,
  GameRecordV2,
  GameRepositoryV2,
} from "./server/persistence/gameRepositoryV2";
import { asGameId } from "./server/persistence/gameRepository";
import {
  createInitialWorldState,
  appendLocation,
  appendNpc,
  type LocationEntry,
  type NpcEntry,
} from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { asLocationId, asNpcId, asGenerationId } from "@/game/domain/scenarioBlueprint";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { createRuleIntentParserV2 } from "./server/ai/liveIntentParserSourceV2";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";

// ---------------------------------------------------------------------------
// Task 9：handleNpcDialogueV2 成为 thin adapter —— 内部构造 Interaction.free_text
// 并调用 performTurn；不再直接写 playerNpcChat pending。聊天路径不再零 CAS 旁路。
// ---------------------------------------------------------------------------

function createSpyRepo(ws: WorldState, ss: StoryState): {
  repo: GameRepositoryV2;
  applyCalls: () => readonly ApplyStateV2Input[];
  record: () => GameRecordV2 | null;
} {
  let record: GameRecordV2 = {
    gameId: asGameId("g1"), worldState: ws, storyState: ss, revision: 0, createdAt: "2026-01-01",
  };
  const applyCallsHistory: ApplyStateV2Input[] = [];
  const repo: GameRepositoryV2 = {
    async createInitialGame(input) {
      if (record !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async getCurrentGame() {
      return { ok: true, status: "active", record };
    },
    async applyState(input) {
      applyCallsHistory.push(input);
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async applySceneWriteBack(input) {
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, storyState: { ...record.storyState, narrative: input.nextNarrative, candidateEventPool: input.nextCandidateEventPool }, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async clearCurrentGame() { return { ok: true as const }; },
  };
  return { repo, record: () => record, applyCalls: () => applyCallsHistory };
}

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
};
const npc1: NpcEntry = {
  id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

function buildWorldState(): WorldState {
  const base = createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: loc1,
    startingItemIds: [],
  });
  return { ...appendNpc(base, npc1), unlockedLocationIds: [asLocationId("loc_1")] };
}

function buildStoryState(): StoryState {
  return createInitialStoryState({ gameLength: "short", initialEntityCounts: { locations: 1, npcs: 1, quests: 0, events: 0 } });
}

function makePendingJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("existing-job"),
    turnId: asTurnId("existing-turn"),
    actionId: "act_existing",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    resolvedEvent: {
      actionId: "act_existing", status: "success", eventKind: "dialogue",
      facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    requestedAt: "2026-01-02",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

describe("handleNpcDialogueV2 thin adapter（Task 9）", () => {
  it("轻量问候走 performTurn：形成受规则记录的对话回合（不再零 CAS 旁路）", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_1"), text: "你好", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createRuleIntentParserV2() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("chat");
    if (result.kind === "chat") expect(result.npcSpeech.length).toBeGreaterThan(0);
    // 问候回合真实记录：一次 CAS 写入，revision 推进，NPC 已结识
    expect(result.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    const npc = saved.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    expect(npc.met).toBe(true);
    expect(saved.worldState.eventLedger.some((e) => e.type === "npc_met")).toBe(true);
    // 规则记录的对话回合同样进入 pending 编排
    expect(saved.storyState.narrative.generation.status).toBe("pending");
  });

  it("普通输入 → narrative_trigger：performTurn 单次 CAS + NPC 记忆 + pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_1"), text: "我相信你", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createRuleIntentParserV2() },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("narrative_trigger");
    expect(result.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    const npc = saved.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    expect(npc.memory.relationship.affinity).toBe(8);
    const generation = saved.storyState.narrative.generation;
    expect(generation.status).toBe("pending");
    if (generation.status !== "pending") return;
    expect(generation.job.utterance).toBe("我相信你");
    expect(generation.job.focusNpcId).toBe("npc_1");
  });

  it("NPC 不在场 → NPC_NOT_PRESENT 且零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_ghost"), text: "你好", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createRuleIntentParserV2() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NPC_NOT_PRESENT");
    expect(applyCalls()).toHaveLength(0);
  });

  it("NPC 存在于世界但不在当前地点 → NPC_NOT_PRESENT 且零写入（不降级 freeform 写入）", async () => {
    // npc_2 在 loc_2（未解锁/不可达），玩家在 loc_1 —— 属于"不在场"
    const farNpc: NpcEntry = {
      ...npc1,
      id: asNpcId("npc_2"),
      name: "远方的商人",
      locationId: asLocationId("loc_2"),
    };
    const world = { ...buildWorldState(), npcs: [...buildWorldState().npcs, farNpc] };
    const { repo, applyCalls } = createSpyRepo(world, buildStoryState());

    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_2"), text: "我相信你", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createRuleIntentParserV2() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NPC_NOT_PRESENT");
    expect(applyCalls()).toHaveLength(0);
  });

  it("pending 期间自由文本被拒绝且零写入", async () => {
    const base = buildStoryState();
    const ss: StoryState = {
      ...base,
      narrative: { ...base.narrative, generation: { status: "pending", job: makePendingJob() } },
    };
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), ss);

    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_1"), text: "我相信你", expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createRuleIntentParserV2() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_REJECTED");
    expect(applyCalls()).toHaveLength(0);
  });

  it("stale revision → STALE_GAME_REVISION 且零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await handleNpcDialogueV2(
      { npcId: asNpcId("npc_1"), text: "我相信你", expectedRevision: 99 },
      { repository: repo, now: () => "2026-01-02", intentParserSource: createRuleIntentParserV2() },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("STALE_GAME_REVISION");
    expect(applyCalls()).toHaveLength(0);
  });
});