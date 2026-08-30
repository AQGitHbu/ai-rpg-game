import { describe, it, expect } from "vitest";
import { compileCandidateEvent } from "./compileCandidateEvent";
import type { ApprovedEventCandidate } from "./approveCandidateEvents";
import { asNpcId, asFactId, asEnemyId, asLocationId, asGenerationId, type GenerationMetadata } from "@/game/domain/worldEntity";
import { findNpc } from "@/game/domain/worldState";
import type {
  EnemyEntry, LocationEntry, NpcEntry, PlayerState, WorldFactEntry, WorldState,
} from "@/game/domain/worldState";
import type { EventCandidate } from "@/game/domain/candidateEvent";
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
  connectedLocationIds: [asLocationId("loc_2")],
  npcIds: [],
  availableItemIds: [],
  tags: [],
};
const LOC_2: LocationEntry = {
  id: asLocationId("loc_2"),
  name: "岔路",
  description: "",
  kind: "main",
  connectedLocationIds: [asLocationId("loc_1")],
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
// 老者已知的事实必须真实存在：v3 会在编译期拒绝悬空的 NPC 事实引用。
const FACT_1: WorldFactEntry = { factId: asFactId("fact_1"), text: "老者守口的旧事", source: "generated", discovered: false, locationId: asLocationId("loc_1") };
const FACT_2: WorldFactEntry = { factId: asFactId("fact_2"), text: "密道在古井之下", source: "generated", discovered: false, locationId: asLocationId("loc_1") };

function makeWorldState(): WorldState {
  return createWorldStateFixture({
    generation: GENERATION,
    projection: {
      ...emptyProjection({ player: PLAYER, locations: [LOC_1, LOC_2], currentLocationId: LOC_1.id }),
      npcs: [NPC_1],
      enemies: [ENEMY_1],
      worldFacts: [FACT_1, FACT_2],
    },
  });
}

function approved(kind: EventCandidate["kind"]): ApprovedEventCandidate {
  const base: EventCandidate = {
    id: "ce-1",
    kind,
    involvedEntityIds: [],
    prerequisiteFactIds: [],
    proposedEffects: [],
    intendedPacing: "complicate",
    reason: "reason",
    proposedAtTurn: 1,
    expiresAtTurn: 4,
  };
  return { ...base, approvedAtTurn: 1 };
}

describe("compileCandidateEvent 每种 kind 至少编译为真实领域事件", () => {
  it("npc_reveals_fact → fact_discovered 事件 + 事实被发现", () => {
    const c: ApprovedEventCandidate = {
      ...approved("npc_reveals_fact"),
      proposedEffects: [{ kind: "npc_reveals_fact", npcId: asNpcId("npc_1"), factId: asFactId("fact_2") }],
      involvedEntityIds: ["npc_1", "fact_2"],
    };
    const result = compileCandidateEvent(makeWorldState(), c, { now: NOW });
    expect(result.events.some((e) => e.type === "fact_discovered")).toBe(true);
    expect(result.events.some((e) => e.type === "candidate_event_activated")).toBe(true);
    const fact = result.worldState.worldFacts.find((f) => f.factId === asFactId("fact_2"));
    expect(fact?.discovered).toBe(true);
  });

  it("npc_changes_stance → 关系/情绪结构化变化事件", () => {
    const c: ApprovedEventCandidate = {
      ...approved("npc_changes_stance"),
      proposedEffects: [{ kind: "npc_changes_stance", npcId: asNpcId("npc_1"), stance: "friendly" }],
      involvedEntityIds: ["npc_1"],
    };
    const result = compileCandidateEvent(makeWorldState(), c, { now: NOW });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.type === "candidate_event_activated")).toBe(true);
    const npcAfter = findNpc(result.worldState, asNpcId("npc_1"));
    expect(npcAfter?.memory.emotion).not.toBe("neutral");
  });

  it("hostile_force_acts → 张力/威胁结构事件，World 不被任意修改", () => {
    const c: ApprovedEventCandidate = {
      ...approved("hostile_force_acts"),
      proposedEffects: [{ kind: "hostile_force_acts", locationId: asLocationId("loc_1"), action: "attack_settlement" }],
      involvedEntityIds: ["loc_1"],
    };
    const result = compileCandidateEvent(makeWorldState(), c, { now: NOW });
    // 必须产生真实事件，而非仅 tension 文本
    expect(result.events.some((e) => e.type === "candidate_event_activated")).toBe(true);
    expect(result.events.filter((e) => e.type !== "candidate_event_activated").length).toBeGreaterThan(0);
  });

  it("enemy_appears → 敌人地点遭遇结构化事件", () => {
    const c: ApprovedEventCandidate = {
      ...approved("enemy_appears"),
      proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
      involvedEntityIds: ["enemy_1", "loc_1"],
    };
    const result = compileCandidateEvent(makeWorldState(), c, { now: NOW });
    expect(result.events.filter((e) => e.type !== "candidate_event_activated").length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.type === "candidate_event_activated")).toBe(true);
  });

  it("thread_complicates / thread_resolves 产生结构化事件", () => {
    for (const kind of ["thread_complicates", "thread_resolves"] as const) {
      const c: ApprovedEventCandidate = {
        ...approved(kind),
        proposedEffects: kind === "thread_complicates"
          ? [{ kind: "thread_complicates", threadId: "thread_main" }]
          : [{ kind: "thread_resolves", threadId: "thread_main" }],
        involvedEntityIds: ["thread_main"],
      };
      const result = compileCandidateEvent(makeWorldState(), c, { now: NOW });
      expect(result.events.filter((e) => e.type !== "candidate_event_activated").length).toBeGreaterThan(0);
      expect(result.events.some((e) => e.type === "candidate_event_activated")).toBe(true);
    }
  });

  it("location_state_changes → 地点状态结构事件", () => {
    const c: ApprovedEventCandidate = {
      ...approved("location_state_changes"),
      proposedEffects: [{ kind: "location_state_changes", locationId: asLocationId("loc_2"), change: "unlocked" }],
      involvedEntityIds: ["loc_2"],
    };
    const result = compileCandidateEvent(makeWorldState(), c, { now: NOW });
    expect(result.events.filter((e) => e.type !== "candidate_event_activated").length).toBeGreaterThan(0);
    expect(result.worldState.unlockedLocationIds).toContain(asLocationId("loc_2"));
  });

  it("编译不产生任意 path patch：未知 effect kind 直接拒绝", () => {
    const bad = {
      ...approved("npc_reveals_fact"),
      proposedEffects: [{ kind: "arbitrary_patch", path: "x" }],
    };
    // 运行时拒绝未知 effect kind（封闭 union 之外一律报错）
    expect(() => compileCandidateEvent(makeWorldState(), bad as unknown as ApprovedEventCandidate, { now: NOW }))
      .toThrow();
  });
});
