import { describe, it, expect } from "vitest";
import { performBattleRound } from "./performBattleRound";
import { commitState } from "./stateCommit";
import type { GameRepository, GameRecord } from "./server/persistence/gameRepository";
import type { WorldState, BattleStartSnapshot } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { NpcInteraction } from "@/game/domain/worldEntries";
import { asEnemyId, asFactId, asLocationId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { FactId } from "@/game/domain/worldEntity";
import { asCombatantId } from "@/game/domain/combat";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { GameEvent } from "@/game/domain/events";
import {
  compileEntityStoreFromCompatibilityProjection, compileLegacyNpcSync, createEntityStore,
  entitiesOfKind, projectEntityStore, projectNpcEntry,
  type EnemyEntityRecord, type EntityRecord, type EntityStore, type FactEntityRecord,
  type NpcEntityRecord,
} from "@/game/domain/entity";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";

function createInMemoryRepo(record: GameRecord | null): { repo: GameRepository; getRecord: () => GameRecord | null; getApplyCount: () => number } {
  let current: GameRecord | null = record;
  let applyCount = 0;
  return {
    repo: {
      async createInitialGame() { return { ok: true as const }; },
      async getCurrentGame() {
        if (current === null) return { ok: true as const, status: "none" as const };
        return { ok: true as const, status: "active" as const, record: current };
      },
      async applyState(input) {
        applyCount++;
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async applySceneWriteBack(input) {
        if (current === null) return { ok: false, code: "NO_ACTIVE_GAME" as const };
        if (input.expectedRevision !== current.revision) return { ok: false, code: "STALE_GAME_REVISION" as const };
        current = { ...current, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: current.revision + 1 };
        return { ok: true as const, record: current };
      },
      async clearCurrentGame() { return { ok: true as const }; },
      async replaceCurrentGame() { return { ok: true as const }; },
    } as GameRepository,
    getRecord: () => current,
    getApplyCount: () => applyCount,
  };
}

function createBattleWorldState(overrides?: Partial<WorldState>): WorldState {
  const base = createInitialWorldState({
    generation: { generationId: "gen_test" as never, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "测试", identity: "测试身份", stats: { hp: 100, attack: 20, defense: 10 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "测试", description: "测试", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const preBattleSnapshot: BattleStartSnapshot = {
    entityStore: base.entityStore,
    eventLedger: [] as readonly GameEvent[],
  };
  return {
    ...base,
    enemies: [{ id: asEnemyId("enemy_0"), name: "测试敌人", tier: "normal" as never, stats: { maxHp: 50, attack: 10, defense: 5, speed: 10 } as never, locationId: asLocationId("loc_0"), tags: [] }],
    defeatedEnemyIds: [],
    battle: {
      status: "active" as const,
      enemyId: asEnemyId("enemy_0"),
      playerHp: 80,
      enemyHp: 30,
      round: 1,
      preBattleSnapshot,
    },
    ...overrides,
  };
}

function createBattleStoryState(narrative?: StoryState["narrative"]): StoryState {
  const readyNarrative: StoryState["narrative"] = narrative ?? {
    status: "ready" as const,
    mode: "ai" as const,
    currentScene: {
      sceneId: "scene-battle-1",
      turn: 1,
      narration: "战斗即将开始",
      usedFactIds: [],
      npcLine: null,
      choices: [],
      source: "generated" as const,
    },
    choiceRegistry: [],
  };
  return {
    ...createInitialStoryState({
      gameLength: "short" as const,
      initialEntityCounts: { locations: 1, npcs: 0, quests: 0, events: 0 },
      initialNarrative: readyNarrative,
    }),
  };
}

type LegacyRollbackFixture = Readonly<{
  harness: InMemoryHarness;
  snapshotStore: EntityStore;
  snapshotLedger: readonly GameEvent[];
  preBattleNpc: NpcEntityRecord;
  midBattleStore: EntityStore;
  midBattleLedger: readonly GameEvent[];
  midBattleNpc: NpcEntityRecord;
  revision: number;
}>;

/**
 * 与下面的「生产开战」fixture 不同：这里从一场已在跑的 legacy battle 起步，快照显式注入，
 * 因此断言的是 performBattleRound 用的是存档里那一份快照。
 *
 * 关键一步是先走一次非终结回合：战前快照必须自己活过规则层的回合重建，
 * 否则终结回合拿不到快照，回滚就只剩「什么都没变」的假阳性。
 * 快照 ledger 故意留空，与活记录 ledger 不同，好让 ledger 恢复断言也有牙齿。
 */
async function driveLegacyBattleUntilLayersDiverge(): Promise<LegacyRollbackFixture> {
  const worldState = layeredBattleWorld();
  const snapshotStore = worldState.entityStore;
  const snapshotLedger: readonly GameEvent[] = [];
  const preBattleNpc = npcRecordOf(snapshotStore);
  const harness = createInMemoryRepo({
    gameId: GAME_ID,
    worldState: {
      ...worldState,
      battle: {
        status: "active" as const,
        enemyId: ENEMY_ID,
        playerHp: 8,
        enemyHp: 60,
        round: 1,
        preBattleSnapshot: { entityStore: snapshotStore, eventLedger: snapshotLedger },
      },
    },
    storyState: createBattleStoryState(),
    revision: 0,
    createdAt: "2026-01-01",
  });

  const nonTerminal = await performBattleRound(
    {
      gameId: GAME_ID,
      actionId: "legacy_round",
      interactionKind: "fixed_choice",
      action: { type: "battle_action", action: "attack" },
      expectedRevision: 0,
    },
    { repository: harness.repo, now: CLOCK },
  );
  expect(nonTerminal).toMatchObject({ ok: true, outcome: "active" });

  const revision = await writeNpcLayersMidBattle(harness);
  const record = harness.getRecord();
  if (record === null) throw new Error("fixture must keep an active game");
  return {
    harness,
    snapshotStore,
    snapshotLedger,
    preBattleNpc,
    midBattleStore: record.worldState.entityStore,
    midBattleLedger: record.worldState.eventLedger,
    midBattleNpc: npcRecordOf(record.worldState.entityStore),
    revision,
  };
}

/** 终结回合回滚后：整店、整条 record 与 ledger 都必须回到注入快照那一份，且不靠别名通过。 */
function expectRolledBackLegacy(fixture: LegacyRollbackFixture, record: GameRecord): void {
  // 反空转前提：战斗确实写脏了 store 与 ledger，等值断言不是因为两者从头到尾同一个对象。
  expect(fixture.midBattleStore).not.toEqual(fixture.snapshotStore);
  expect(fixture.midBattleLedger).not.toEqual(fixture.snapshotLedger);
  expect(fixture.midBattleNpc.knowledge).not.toEqual(fixture.preBattleNpc.knowledge);
  expect(fixture.midBattleNpc.relationships).not.toEqual(fixture.preBattleNpc.relationships);
  expect(fixture.midBattleNpc.history).not.toEqual(fixture.preBattleNpc.history);

  expect(record.worldState.entityStore).toEqual(fixture.snapshotStore);
  expect(npcRecordOf(record.worldState.entityStore)).toEqual(fixture.preBattleNpc);
  expect(record.worldState.eventLedger).toEqual(fixture.snapshotLedger);
  expect(record.worldState.battle).toEqual({ status: "idle" });
}

describe("performBattleRound", () => {
  it("restores the complete pre-battle entity store after defeat", async () => {
    const fixture = await driveLegacyBattleUntilLayersDiverge();
    const result = await performBattleRound(
      { gameId: GAME_ID, actionId: "defeat", interactionKind: "fixed_choice", action: { type: "battle_action", action: "guard" }, expectedRevision: fixture.revision },
      { repository: fixture.harness.repo, now: CLOCK },
    );
    expect(result).toMatchObject({ ok: true, outcome: "defeat" });
    const record = fixture.harness.getRecord();
    if (record === null) throw new Error("fixture must keep an active game");
    expectRolledBackLegacy(fixture, record);
  });

  it("restores the complete pre-battle entity store after withdraw", async () => {
    const fixture = await driveLegacyBattleUntilLayersDiverge();
    const result = await performBattleRound(
      { gameId: GAME_ID, actionId: "withdraw", interactionKind: "fixed_choice", action: { type: "battle_action", action: "flee" }, expectedRevision: fixture.revision },
      { repository: fixture.harness.repo, now: CLOCK },
    );
    expect(result).toMatchObject({ ok: true, outcome: "withdraw" });
    const record = fixture.harness.getRecord();
    if (record === null) throw new Error("fixture must keep an active game");
    expectRolledBackLegacy(fixture, record);
  });

  it("returns NO_ACTIVE_GAME when no active game exists", async () => {
    const { repo } = createInMemoryRepo(null);
    const action: Action = { type: "battle_action", action: "attack", command: { actorId: asCombatantId("player") } };
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "a1", interactionKind: "fixed_choice", action, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("NO_ACTIVE_GAME");
  });

  it("rejects non-battle actions during active battle", async () => {
    const worldState = createBattleWorldState();
    const storyState = createBattleStoryState();
    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });
    const action: Action = { type: "move", locationId: asLocationId("loc_1") } as never;
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "a1", interactionKind: "fixed_choice", action, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_REJECTED");
  });

  it("rejects when narrative is not ready", async () => {
    const worldState = createBattleWorldState();
    const storyState = createBattleStoryState({
      status: "provider_pending" as const,
      mode: "ai" as const,
      job: {} as never,
      lastPresentedScene: null,
    });
    const { repo } = createInMemoryRepo({
      gameId: "g1" as never,
      worldState,
      storyState,
      revision: 0,
      createdAt: "2026-01-01",
    });
    const action: Action = { type: "battle_action", action: "attack", command: { actorId: asCombatantId("player") } };
    const result = await performBattleRound(
      { gameId: "g1" as never, actionId: "a1", interactionKind: "fixed_choice", action, expectedRevision: 0 },
      { repository: repo, now: () => "2026-01-01" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_REJECTED");
  });
});

// ---------------------------------------------------------------------------
// Task 2 Step 5：战败/撤退回滚必须覆盖 NPC 的每一个分层组件。
//
// 这里的 fixture 手工构造分层 record（分层组件才是事实源），再用生产唯一的组装
// 习惯（createEntityStore + projectEntityStore）重建全部 legacy 兼容字段，
// 因此战斗中被改动的确实是「legacy memory 表达不出来」的那五层。
// ---------------------------------------------------------------------------

const GAME_ID = "g1" as never;
const CLOCK = (): string => "2026-01-01";
const LOC_0 = asLocationId("loc_0");
const NPC_ID = asNpcId("npc_0");
const RIVAL_NPC_ID = asNpcId("npc_2");
const ENEMY_ID = asEnemyId("enemy_0");
const MID_BATTLE_FACT_ID = asFactId("fact_battle_loot");

type InMemoryHarness = ReturnType<typeof createInMemoryRepo>;

function factRecord(id: FactId, text: string): FactEntityRecord {
  return {
    core: { id, kind: "fact", name: `fact:${String(id)}`, createdAtTurn: 0, lifecycle: "active" },
    fact: { text, source: "generated", discovered: true, locationId: LOC_0 },
  };
}

function npcInteraction(actionId: string, turnNumber: number, learnedFactIds: readonly FactId[] = []): NpcInteraction {
  return {
    turnNumber,
    actionId,
    locationId: LOC_0,
    dialogueAct: "ask",
    topicSummary: "打听井钥",
    outcome: "positive",
    relationshipDelta: 1,
    learnedFactIds,
    summary: `${actionId} 的交谈`,
  };
}

/** 战前老周：五个分层组件都带 legacy memory 无法表达的正文。 */
function layeredNpcRecord(): NpcEntityRecord {
  return {
    core: { id: NPC_ID, kind: "npc", name: "老周", createdAtTurn: 0, lifecycle: "active" },
    identity: {
      role: "掌柜",
      description: "客栈掌柜，认得每一位常客。",
      tags: ["shopkeep"],
      anchors: {
        selfConcept: "守夜人",
        values: ["守诺", "护短"],
        speechStyle: "短句带刺",
        capabilityBoundaries: ["不会骑马", "不识水路"],
        taboos: ["不提旧主"],
      },
    },
    position: { locationId: LOC_0, locationOrder: 0 },
    dynamicState: {
      isCompanion: false,
      met: true,
      emotion: "warm",
      goals: [
        { goalId: "npc_0_goal_1", horizon: "short", description: "守住客栈", priority: 2, status: "active", reason: "家业" },
        { goalId: "npc_0_goal_2", horizon: "long", description: "找回弟弟", priority: 4, status: "blocked", reason: "线索断了" },
        { goalId: "npc_0_goal_3", horizon: "long", description: "离开小镇", priority: 5, status: "completed", reason: "年轻时已达成" },
      ],
    },
    knowledge: {
      entries: [
        {
          factId: asFactId("fact_0"), certainty: "known", disclosure: "public",
          source: { kind: "initial_world", learnedAtTurn: 0 },
        },
        {
          factId: asFactId("fact_1"), certainty: "suspected", disclosure: "conditional",
          source: { kind: "action", mode: "npc_revealed", actionId: "seed_act_1", learnedAtTurn: 1, sourceNpcId: RIVAL_NPC_ID },
        },
        {
          factId: asFactId("fact_2"), certainty: "known", disclosure: "secret",
          source: { kind: "action", mode: "player_told", actionId: "seed_act_2", learnedAtTurn: 2 },
        },
      ],
    },
    // 边按 targetId 稳定排序：npc_2 在 player_0 之前。
    relationships: {
      outgoing: [
        {
          targetId: RIVAL_NPC_ID,
          dimensions: { affinity: -20, trust: -5, fear: 10, hostility: 25 },
          stage: "wary",
          trend: "worsening",
          commitments: [{
            kind: "promise", commitmentId: "cmt_rival_1", promisor: "target", status: "broken",
            description: "替旧主隐瞒", source: { kind: "initial_world", createdAtTurn: 0, reasonKey: "seed_promise" },
          }],
          evidence: [{
            evidenceId: "ev_seed_3", actionId: "seed_act_3", turnNumber: 3,
            signal: "broke_promise", severity: "major", summaryKey: "broke_promise",
          }],
          origin: { kind: "initial_world", createdAtTurn: 0, reasonKey: "seed_rivalry" },
          lastChangedAtTurn: 3,
        },
        {
          targetId: PLAYER_ENTITY_ID,
          dimensions: { affinity: 12, trust: 30, fear: 5, hostility: 0 },
          stage: "cooperative",
          trend: "improving",
          commitments: [{
            kind: "debt", commitmentId: "cmt_player_1", direction: "target_owes_source", status: "open",
            description: "欠一次引路", source: { kind: "action", actionId: "seed_act_4", turnNumber: 4 },
          }],
          evidence: [
            {
              evidenceId: "ev_seed_4", actionId: "seed_act_4", turnNumber: 4,
              signal: "shared_fact", severity: "normal", summaryKey: "shared_fact",
            },
            {
              evidenceId: "ev_seed_5", actionId: "seed_act_5", turnNumber: 5,
              signal: "fought_together", severity: "major", summaryKey: "fought_together",
            },
          ],
          origin: { kind: "action", actionId: "seed_act_5", turnNumber: 5 },
          lastChangedAtTurn: 5,
        },
      ],
    },
    history: {
      interactions: [
        npcInteraction("seed_act_4", 4, [asFactId("fact_1")]),
        npcInteraction("seed_act_5", 5, [asFactId("fact_2")]),
      ],
    },
  };
}

function rivalNpcRecord(): NpcEntityRecord {
  return {
    core: { id: RIVAL_NPC_ID, kind: "npc", name: "陆三", createdAtTurn: 0, lifecycle: "active" },
    identity: {
      role: "货郎",
      description: "走村串巷的货郎。",
      tags: ["peddler"],
      anchors: {
        selfConcept: "生意人",
        values: ["逐利"],
        speechStyle: "热络",
        capabilityBoundaries: ["不会武功"],
        taboos: [],
      },
    },
    position: { locationId: LOC_0, locationOrder: 1 },
    dynamicState: { isCompanion: false, met: true, emotion: "neutral", goals: [] },
    knowledge: {
      entries: [{
        factId: asFactId("fact_0"), certainty: "known", disclosure: "public",
        source: { kind: "initial_world", learnedAtTurn: 0 },
      }],
    },
    relationships: { outgoing: [] },
    history: { interactions: [npcInteraction("seed_act_9", 9)] },
  };
}

function enemyRecord(): EnemyEntityRecord {
  return {
    core: { id: ENEMY_ID, kind: "enemy", name: "黑衣刀客", createdAtTurn: 0, lifecycle: "active" },
    enemy: { tier: "normal", stats: { hp: 60, attack: 10, defense: 5 }, tags: ["sword"], defeated: false },
    position: { locationId: LOC_0, locationOrder: 0 },
  };
}

/** 玩家 hp 8 / attack 20 / defense 5：一个非终结回合后必在下一回合战败。 */
function layeredBattleWorld(): WorldState {
  const base = createInitialWorldState({
    generation: { generationId: "gen_test" as never, seed: "test", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "测试", identity: "测试身份", stats: { hp: 8, attack: 20, defense: 5 } },
    startingLocation: {
      id: LOC_0, name: "测试", description: "测试", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
  const records: readonly EntityRecord[] = [
    ...base.entityStore.records,
    factRecord(asFactId("fact_0"), "井钥被人取走"),
    factRecord(asFactId("fact_1"), "旧主死于一场风雪"),
    factRecord(asFactId("fact_2"), "地窖藏着第三把刀"),
    factRecord(MID_BATTLE_FACT_ID, "敌人掉落腰牌"),
    layeredNpcRecord(),
    rivalNpcRecord(),
    enemyRecord(),
  ];
  const store = createEntityStore(records);
  return { ...base, entityStore: store, ...projectEntityStore(store) };
}

function npcRecordOf(store: EntityStore): NpcEntityRecord {
  const record = entitiesOfKind(store, "npc").find((entry) => entry.core.id === NPC_ID);
  if (record === undefined) throw new Error("fixture must carry the layered npc");
  return record;
}

function activeSnapshotOf(worldState: WorldState): BattleStartSnapshot {
  if (worldState.battle.status !== "active" || worldState.battle.preBattleSnapshot === undefined) {
    throw new Error("production battle path must keep a pre-battle snapshot while active");
  }
  return worldState.battle.preBattleSnapshot;
}

/** 战斗回合内可被规则批准的唯一 NPC 写入：候选事件 npc_changes_stance。 */
function stanceCandidateStoryState(): StoryState {
  const candidate: EventCandidate = {
    id: "cand_battle_stance",
    kind: "npc_changes_stance",
    involvedEntityIds: [String(NPC_ID)],
    prerequisiteFactIds: [],
    proposedEffects: [{ kind: "npc_changes_stance", npcId: NPC_ID, stance: "hostile" }],
    intendedPacing: "escalate",
    reason: "战斗逼出敌意",
    proposedAtTurn: 1,
    expiresAtTurn: 99,
  };
  return { ...createBattleStoryState(), candidateEventPool: [candidate] };
}

/**
 * 战斗中改写 knowledge / relationships / history：走唯一的生产写入桥
 * （compileLegacyNpcSync 折叠差量 + sync_npc_legacy_memory 落库 + commitState CAS）。
 * 今天没有任何战斗内规则会写这三层（战斗 resolver 只产 facts: []，
 * propagateKnownFacts 的 audience 尚无生产来源），但回滚契约必须先按分层组件已写入
 * 的世界状态证明，否则 Task 3/5/7 接入战斗内知识、关系与历史时会静默丢档。
 */
async function writeNpcLayersMidBattle(harness: InMemoryHarness): Promise<number> {
  const record = harness.getRecord();
  if (record === null) throw new Error("fixture must keep an active game");
  const before = npcRecordOf(record.worldState.entityStore);
  const legacy = projectNpcEntry(before);
  const layers = compileLegacyNpcSync({
    before,
    afterLegacy: {
      ...legacy,
      memory: {
        ...legacy.memory,
        knownFactIds: [...legacy.memory.knownFactIds, MID_BATTLE_FACT_ID],
        relationship: { affinity: legacy.memory.relationship.affinity + 7 },
        interactionHistory: [
          ...legacy.memory.interactionHistory,
          npcInteraction("mid_battle_act", 2, [MID_BATTLE_FACT_ID]),
        ],
      },
    },
    actionId: "mid_battle_act",
    turnNumber: 2,
    addedKnowledge: [{ factId: MID_BATTLE_FACT_ID, mode: "player_told" }],
  });
  const applied = applyEntityMutations(record.worldState, [{
    kind: "sync_npc_legacy_memory",
    npcId: NPC_ID,
    npc: layers,
  }]);
  if (!applied.ok) throw new Error(`fixture must be able to write npc layers: ${applied.code}`);
  const committed = await commitState(harness.repo, {
    gameId: GAME_ID,
    expectedRevision: record.revision,
    nextWorldState: applied.worldState,
    nextStoryState: record.storyState,
  });
  if (!committed.ok) throw new Error("fixture commit must succeed");
  return committed.record.revision;
}

type MidBattleFixture = Readonly<{
  harness: InMemoryHarness;
  preBattleNpc: NpcEntityRecord;
  preBattleStore: EntityStore;
  preBattleLedger: readonly GameEvent[];
  midBattleNpc: NpcEntityRecord;
  revision: number;
}>;

/** 开战 → 非终结回合（候选改情绪）→ 桥写三层，交给终结回合做回滚断言。 */
async function driveBattleUntilMidBattleNpcWrites(): Promise<MidBattleFixture> {
  const worldState = layeredBattleWorld();
  const preBattleStore = worldState.entityStore;
  const preBattleLedger = worldState.eventLedger;
  const preBattleNpc = npcRecordOf(preBattleStore);
  const harness = createInMemoryRepo({
    gameId: GAME_ID,
    worldState,
    storyState: stanceCandidateStoryState(),
    revision: 0,
    createdAt: "2026-01-01",
  });

  const opened = await performBattleRound(
    {
      gameId: GAME_ID,
      actionId: "open_battle",
      interactionKind: "fixed_choice",
      action: { type: "attack", enemyId: ENEMY_ID },
      expectedRevision: 0,
    },
    { repository: harness.repo, now: CLOCK },
  );
  expect(opened).toMatchObject({ ok: true, outcome: "active" });

  const nonTerminal = await performBattleRound(
    {
      gameId: GAME_ID,
      actionId: "mid_round",
      interactionKind: "fixed_choice",
      action: { type: "battle_action", action: "attack" },
      expectedRevision: 1,
    },
    { repository: harness.repo, now: CLOCK },
  );
  expect(nonTerminal).toMatchObject({ ok: true, outcome: "active" });

  const revision = await writeNpcLayersMidBattle(harness);
  const record = harness.getRecord();
  if (record === null) throw new Error("fixture must keep an active game");
  return {
    harness,
    preBattleNpc,
    preBattleStore,
    preBattleLedger,
    midBattleNpc: npcRecordOf(record.worldState.entityStore),
    revision,
  };
}

/** 回滚后的分层组件必须逐层与战前 deep equal，且整条 record 也要往返。 */
function expectRolledBackToPreBattle(fixture: MidBattleFixture, record: GameRecord): void {
  const restored = npcRecordOf(record.worldState.entityStore);
  // 反空转前提：这四层在战斗中确实被写过，等值断言不是「什么都没变」的假阳性。
  // identity 没有任何战斗内写入路径（桥只覆盖四组件），它由整店恢复兜住。
  expect(fixture.midBattleNpc.dynamicState).not.toEqual(fixture.preBattleNpc.dynamicState);
  expect(fixture.midBattleNpc.knowledge).not.toEqual(fixture.preBattleNpc.knowledge);
  expect(fixture.midBattleNpc.relationships).not.toEqual(fixture.preBattleNpc.relationships);
  expect(fixture.midBattleNpc.history).not.toEqual(fixture.preBattleNpc.history);

  expect(restored.identity).toEqual(fixture.preBattleNpc.identity);
  expect(restored.dynamicState).toEqual(fixture.preBattleNpc.dynamicState);
  expect(restored.knowledge).toEqual(fixture.preBattleNpc.knowledge);
  expect(restored.relationships).toEqual(fixture.preBattleNpc.relationships);
  expect(restored.history).toEqual(fixture.preBattleNpc.history);
  // 整条 record 往返，而不只是 compat memory：core 与 position 同样在恢复范围内。
  expect(restored).toEqual(fixture.preBattleNpc);
  expect(record.worldState.entityStore).toEqual(fixture.preBattleStore);
  expect(record.worldState.eventLedger).toEqual(fixture.preBattleLedger);
  expect(record.worldState.battle).toEqual({ status: "idle" });
  // legacy 投影同步回到战前，但它始终是派生视图而非回滚的事实来源。
  expect(projectNpcEntry(restored)).toEqual(projectNpcEntry(fixture.preBattleNpc));
}

describe("performBattleRound：NPC 分层组件的战前快照与回滚", () => {
  it("captures every NPC layered component in the real pre-battle snapshot", async () => {
    const worldState = layeredBattleWorld();
    const preBattleNpc = npcRecordOf(worldState.entityStore);
    const preBattleStore = worldState.entityStore;
    const { repo, getRecord } = createInMemoryRepo({
      gameId: GAME_ID,
      worldState,
      storyState: stanceCandidateStoryState(),
      revision: 0,
      createdAt: "2026-01-01",
    });

    const result = await performBattleRound(
      {
        gameId: GAME_ID,
        actionId: "open_battle",
        interactionKind: "fixed_choice",
        action: { type: "attack", enemyId: ENEMY_ID },
        expectedRevision: 0,
      },
      { repository: repo, now: CLOCK },
    );
    expect(result).toMatchObject({ ok: true, outcome: "active" });

    const record = getRecord();
    if (record === null) throw new Error("fixture must keep an active game");
    const snapshot = activeSnapshotOf(record.worldState);
    const snapshotNpc = npcRecordOf(snapshot.entityStore);
    // 快照按存档回读的形式（JSON 往返）仍带齐七个键：分层组件一个都不能少。
    const persisted = JSON.parse(JSON.stringify(snapshotNpc)) as NpcEntityRecord;
    expect(Object.keys(persisted).sort()).toEqual([
      "core", "dynamicState", "history", "identity", "knowledge", "position", "relationships",
    ]);
    expect(persisted.identity).toEqual(JSON.parse(JSON.stringify(preBattleNpc.identity)));
    expect(persisted.position).toEqual(JSON.parse(JSON.stringify(preBattleNpc.position)));
    expect(persisted.dynamicState).toEqual(JSON.parse(JSON.stringify(preBattleNpc.dynamicState)));
    expect(persisted.knowledge).toEqual(JSON.parse(JSON.stringify(preBattleNpc.knowledge)));
    expect(persisted.relationships).toEqual(JSON.parse(JSON.stringify(preBattleNpc.relationships)));
    expect(persisted.history).toEqual(JSON.parse(JSON.stringify(preBattleNpc.history)));
    expect(snapshotNpc).toEqual(preBattleNpc);
    expect(snapshot.eventLedger).toEqual(worldState.eventLedger);
    // 战斗回合确实写了活记录：快照与当前 store 必须已经分叉。
    expect(npcRecordOf(record.worldState.entityStore).dynamicState.emotion).toBe("afraid");
    expect(snapshotNpc.dynamicState.emotion).toBe("warm");

    // 反空转 canary：只由 legacy 兼容投影重建的 store 无法还原这些层，
    // 因此后面所有「整条 record 回到战前」的断言都不能靠重建 memory 蒙过去。
    const legacyOnly = npcRecordOf(compileEntityStoreFromCompatibilityProjection({
      projection: projectEntityStore(preBattleStore),
      createdAtTurn: 0,
    }));
    expect(legacyOnly).not.toEqual(preBattleNpc);
  });

  it("restores all five NPC layers after defeat", async () => {
    const fixture = await driveBattleUntilMidBattleNpcWrites();
    const result = await performBattleRound(
      {
        gameId: GAME_ID,
        actionId: "last_round",
        interactionKind: "fixed_choice",
        action: { type: "battle_action", action: "attack" },
        expectedRevision: fixture.revision,
      },
      { repository: fixture.harness.repo, now: CLOCK },
    );
    expect(result).toMatchObject({ ok: true, outcome: "defeat" });
    const record = fixture.harness.getRecord();
    if (record === null) throw new Error("fixture must keep an active game");
    expectRolledBackToPreBattle(fixture, record);
  });

  it("restores all five NPC layers after withdraw", async () => {
    const fixture = await driveBattleUntilMidBattleNpcWrites();
    const result = await performBattleRound(
      {
        gameId: GAME_ID,
        actionId: "withdraw_round",
        interactionKind: "fixed_choice",
        action: { type: "battle_action", action: "flee" },
        expectedRevision: fixture.revision,
      },
      { repository: fixture.harness.repo, now: CLOCK },
    );
    expect(result).toMatchObject({ ok: true, outcome: "withdraw" });
    const record = fixture.harness.getRecord();
    if (record === null) throw new Error("fixture must keep an active game");
    expectRolledBackToPreBattle(fixture, record);
  });
});
