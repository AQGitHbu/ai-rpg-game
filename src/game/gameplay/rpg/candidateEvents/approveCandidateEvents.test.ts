import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { approveCandidateEvents } from "./approveCandidateEvents";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { asNpcId, asFactId, asEnemyId, asLocationId } from "@/game/domain/worldEntity";
import {
  type EnemyEntry, type LocationEntry, type NpcEntry,
  type PlayerState, type WorldFactEntry, type WorldState,
} from "@/game/domain/worldState";
import { asGenerationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";

const NOW = () => "2026-08-09T00:00:00.000Z";

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("gen-1"),
  seed: "seed-1",
  templateVersion: "tpl-1",
  inputDigest: "digest",
  gameType: "wuxia",
};
const PLAYER: PlayerState = { name: "P", identity: "hero", stats: { hp: 30, attack: 10, defense: 5 } };
const LOC_1: LocationEntry = {
  id: asLocationId("loc_1"),
  name: "起点",
  description: "",
  kind: "main",
  connectedLocationIds: [],
  npcIds: [],
  availableItemIds: [],
  tags: [],
};
const NPC_1: NpcEntry = {
  id: asNpcId("npc_1"),
  name: "老者",
  role: "导师",
  description: "",
  locationId: asLocationId("loc_1"),
  isCompanion: false,
  tags: [],
  met: true,
  memory: {
    npcId: asNpcId("npc_1"),
    knownFactIds: [asFactId("fact_1")],
    hiddenFactIds: [],
    interactionHistory: [],
    relationship: { affinity: 0 },
    emotion: "neutral",
    goals: [],
  },
};
const ENEMY_1: EnemyEntry = {
  id: asEnemyId("enemy_1"),
  name: "山贼",
  tier: "normal",
  stats: { hp: 10, attack: 5, defense: 2 },
  locationId: asLocationId("loc_1"),
  tags: [],
};
// 老者已知的事实必须真实存在：当前 Entity Store 会在编译期拒绝悬空的 NPC 事实引用。
const FACT_1: WorldFactEntry = { factId: asFactId("fact_1"), text: "山口旧事", source: "generated", discovered: false, locationId: asLocationId("loc_1") };

function makeWorldState(): WorldState {
  return createWorldStateFixture({
    generation: GENERATION,
    projection: {
      ...emptyProjection({ player: PLAYER, locations: [LOC_1], currentLocationId: LOC_1.id }),
      npcs: [NPC_1],
      enemies: [ENEMY_1],
      worldFacts: [FACT_1],
    },
  });
}

function makeSs(): ReturnType<typeof createInitialStoryState> {
  return createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 4, npcs: 5, quests: 2, events: 0 },
  });
}

function candidate(overrides?: Partial<EventCandidate>): EventCandidate {
  const c: EventCandidate = {
    id: "ce-1",
    kind: "enemy_appears",
    involvedEntityIds: ["enemy_1", "loc_1"],
    prerequisiteFactIds: [],
    proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
    intendedPacing: "complicate",
    reason: "敌人在起点现身",
    proposedAtTurn: 1,
    expiresAtTurn: 4,
    ...overrides,
  };
  return c;
}

describe("approveCandidateEvents 审批失败矩阵", () => {
  it("预算耗尽时拒绝（budget）", () => {
    const ss = { ...makeSs(), budget: { ...makeSs().budget, events: { ...makeSs().budget.events, expanded: 6, max: 6 } } };
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [candidate()] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.rejected.some((r) => r.candidate.id === "ce-1" && r.reasonCode === "budget")).toBe(true);
  });

  it("过期候选拒绝（expired）", () => {
    const ss = { ...makeSs(), turnNumber: 5 };
    const c = candidate({ proposedAtTurn: 1, expiresAtTurn: 4 });
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [c] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.rejected.some((r) => r.reasonCode === "expired")).toBe(true);
  });

  it("同批重复 ID 拒绝（duplicate_id）", () => {
    const ss = makeSs();
    const a = candidate({ id: "ce-dup" });
    const b = candidate({ id: "ce-dup" });
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [a, b] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(1); // 同批去重：只批准先到的一条
    expect(result.rejected.some((r) => r.reasonCode === "duplicate_id")).toBe(true);
  });

  it("实体不存在拒绝（entity_missing）", () => {
    const ss = makeSs();
    const c = candidate({
      kind: "enemy_appears",
      proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_nope"), locationId: asLocationId("loc_1") }],
      involvedEntityIds: ["enemy_nope"],
    });
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [c] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.rejected.some((r) => r.reasonCode === "entity_missing")).toBe(true);
  });

  it("前置事实未满足拒绝（prerequisite_unmet）", () => {
    const ss = makeSs();
    const c = candidate({ prerequisiteFactIds: [asFactId("fact_missing")] });
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [c] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.rejected.some((r) => r.reasonCode === "prerequisite_unmet")).toBe(true);
  });

  it("结局已抵达拒绝（ending_reached）", () => {
    const ss = { ...makeSs(), endingProposed: true };
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [candidate()] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.rejected.some((r) => r.reasonCode === "ending_reached")).toBe(true);
  });

  it("超过每回合 1 条：只批准 1 条，其余保留在池", () => {
    const ss = makeSs();
    const a = candidate({ id: "ce-a", proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }] });
    const b = candidate({ id: "ce-b", proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }] });
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [a, b] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(1);
    expect(result.nextStoryState.candidateEventPool.map((c) => c.id)).toContain("ce-b");
  });
});

describe("approveCandidateEvents 成功路径", () => {
  it("旧候选效果未被审批层识别时仍会通过，故编译器丢弃路径必须兜底", () => {
    const legacyKind = ["npc", "changes", "stance"].join("_");
    const stale = {
      ...candidate({ id: "ce-stale" }),
      kind: legacyKind,
      proposedEffects: [{ kind: legacyKind, npcId: NPC_1.id, stance: "hostile" }],
    } as unknown as EventCandidate;
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: makeSs(), candidates: [stale] }, { now: NOW });

    // validateCandidateEntities 的 switch 会落空；这是编译器 drop reason 的 load-bearing 输入。
    expect(result).toMatchObject({
      approvedCandidates: [{ id: "ce-stale", kind: legacyKind }],
      rejected: [],
      nextStoryState: { candidateEventPool: [] },
    });
  });

  it("批准成功后生成 ApprovedEvent 与审计事件，并消耗事件预算", () => {
    const ss = makeSs();
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [candidate()] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(1);
    expect(result.approvedCandidates[0]!.id).toBe("ce-1");
    expect(result.approvedCandidates[0]!.approvedAtTurn).toBe(ss.turnNumber);
    expect(result.drafts.some((e) => e.payload.type === "candidate_event_approved")).toBe(true);
    expect(result.nextStoryState.budget.events.expanded).toBe(ss.budget.events.expanded + 1);
    // 批准的候选从池移除
    expect(result.nextStoryState.candidateEventPool.map((c) => c.id)).not.toContain("ce-1");
  });

  it("空池返回原状态", () => {
    const ss = makeSs();
    const result = approveCandidateEvents({ worldState: makeWorldState(), storyState: ss, candidates: [] }, { now: NOW });
    expect(result.approvedCandidates.length).toBe(0);
    expect(result.nextStoryState).toBe(ss);
  });
});
