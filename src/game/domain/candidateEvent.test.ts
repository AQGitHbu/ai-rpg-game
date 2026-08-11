import { describe, it, expect } from "vitest";
import {
  parseEventCandidate,
  isExpiredCandidate,
  EVENT_CANDIDATE_KINDS,
  type EventCandidate,
  type EventCandidateKind,
  type ProposedEffect,
} from "./candidateEvent";
import { asNpcId, asFactId, asEnemyId, asLocationId } from "./worldEntity";
import type { PacingNeed } from "./storyState";

function baseCandidate(overrides?: Partial<EventCandidate>): EventCandidate {
  const c: EventCandidate = {
    id: "candidate-1",
    kind: "npc_reveals_fact",
    involvedEntityIds: ["npc_1", "fact_1"],
    prerequisiteFactIds: [],
    proposedEffects: [
      { kind: "npc_reveals_fact", npcId: asNpcId("npc_1"), factId: asFactId("fact_1") },
    ],
    intendedPacing: "complicate",
    reason: "NPC 在关键时刻向玩家揭示关键事实",
    proposedAtTurn: 3,
    expiresAtTurn: 6,
    ...overrides,
  };
  return c;
}

describe("EventCandidate 结构化契约", () => {
  it("支持全部 7 种事件 kind，且每条都含结构化执行字段", () => {
    const kinds: EventCandidateKind[] = [
      "npc_reveals_fact",
      "npc_changes_stance",
      "hostile_force_acts",
      "enemy_appears",
      "thread_complicates",
      "thread_resolves",
      "location_state_changes",
    ];
    expect(EVENT_CANDIDATE_KINDS).toEqual(kinds);

    const candidates: EventCandidate[] = [
      baseCandidate(),
      baseCandidate({
        id: "c2",
        kind: "npc_changes_stance",
        involvedEntityIds: ["npc_2"],
        proposedEffects: [{ kind: "npc_changes_stance", npcId: asNpcId("npc_2"), stance: "hostile" }],
      }),
      baseCandidate({
        id: "c3",
        kind: "hostile_force_acts",
        involvedEntityIds: ["loc_3"],
        proposedEffects: [{ kind: "hostile_force_acts", locationId: asLocationId("loc_3"), action: "attack_settlement" }],
      }),
      baseCandidate({
        id: "c4",
        kind: "enemy_appears",
        involvedEntityIds: ["enemy_4", "loc_4"],
        proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_4"), locationId: asLocationId("loc_4") }],
      }),
      baseCandidate({
        id: "c5",
        kind: "thread_complicates",
        involvedEntityIds: ["thread_main"],
        proposedEffects: [{ kind: "thread_complicates", threadId: "thread_main" }],
      }),
      baseCandidate({
        id: "c6",
        kind: "thread_resolves",
        involvedEntityIds: ["thread_main"],
        proposedEffects: [{ kind: "thread_resolves", threadId: "thread_main" }],
      }),
      baseCandidate({
        id: "c7",
        kind: "location_state_changes",
        involvedEntityIds: ["loc_7"],
        proposedEffects: [{ kind: "location_state_changes", locationId: asLocationId("loc_7"), change: "locked" }],
      }),
    ];

    for (const candidate of candidates) {
      expect(candidate.id).toBeTruthy();
      expect(candidate.involvedEntityIds.length).toBeGreaterThan(0);
      expect(candidate.proposedEffects.length).toBeGreaterThan(0);
      expect(typeof candidate.reason).toBe("string");
      expect(candidate.proposedAtTurn).toBeGreaterThan(0);
      expect(candidate.expiresAtTurn).toBeGreaterThan(candidate.proposedAtTurn);
      // 每条 effect 必须可区分 kind，不能只有 description
      expect(candidate.proposedEffects.every((e) => e.kind.length > 0)).toBe(true);
    }
  });

  it("description 不作为唯一执行字段：proposedEffects 为空时拒绝", () => {
    const input = {
      ...baseCandidate(),
      description: "仅有描述，没有可执行效果",
      proposedEffects: [],
    };
    const result = parseEventCandidate(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("no_executable_effect");
    }
  });

  it("proposedEffects 的 kind 必须与 candidate kind 匹配", () => {
    // candidate kind 为 npc_reveals_fact，但 effect kind 为 enemy_appears —— 不匹配
    const input = {
      ...baseCandidate(),
      proposedEffects: [{ kind: "enemy_appears" as const, enemyId: asEnemyId("e1"), locationId: asLocationId("l1") }],
    };
    const result = parseEventCandidate(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("effect_kind_mismatch");
    }
  });

  it("拒绝空 id、未知 kind、过期回合非法", () => {
    const emptyId = parseEventCandidate({ ...baseCandidate({ id: "" }) });
    expect(emptyId.ok).toBe(false);
    if (!emptyId.ok) expect(emptyId.code).toBe("empty_id");

    const unknownKind = parseEventCandidate({ ...baseCandidate(), kind: "mystery_kind" as never });
    expect(unknownKind.ok).toBe(false);
    if (!unknownKind.ok) expect(unknownKind.code).toBe("unknown_kind");

    const badExpiry = parseEventCandidate({ ...baseCandidate({ expiresAtTurn: 2 }) });
    expect(badExpiry.ok).toBe(false);
    if (!badExpiry.ok) expect(badExpiry.code).toBe("invalid_expiry");
  });

  it("合法候选通过 schema 解析，且引用 ID 集合一致", () => {
    const result = parseEventCandidate(baseCandidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.kind).toBe("npc_reveals_fact");
      expect(result.candidate.intendedPacing).toBe("complicate");
      expect(result.candidate.involvedEntityIds).toContain("npc_1");
      expect(result.candidate.proposedEffects[0]!.kind).toBe("npc_reveals_fact");
    }
  });

  it("intendedPacing 必须是合法 PacingNeed 枚举", () => {
    const pacingInputs: readonly (PacingNeed | "bogus")[] = [
      "reveal", "develop", "complicate", "escalate", "climax", "resolve",
    ];
    for (const p of pacingInputs) {
      const result = parseEventCandidate({ ...baseCandidate(), intendedPacing: p });
      if (p === "bogus") {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
      }
    }
  });
});

describe("isExpiredCandidate", () => {
  it("当前回合超过 expiresAtTurn 时判定为过期", () => {
    const c = baseCandidate({ proposedAtTurn: 1, expiresAtTurn: 4 });
    expect(isExpiredCandidate(c, 3)).toBe(false);
    expect(isExpiredCandidate(c, 4)).toBe(true);
    expect(isExpiredCandidate(c, 5)).toBe(true);
  });
});

describe("ProposedEffect 封闭 union", () => {
  it("效果字段可区分、不含任意 path patch", () => {
    const effects: readonly ProposedEffect[] = [
      { kind: "npc_reveals_fact", npcId: asNpcId("npc_1"), factId: asFactId("fact_1") },
      { kind: "npc_changes_stance", npcId: asNpcId("npc_1"), stance: "friendly" },
      { kind: "hostile_force_acts", locationId: asLocationId("loc_1"), action: "attack" },
      { kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") },
      { kind: "thread_complicates", threadId: "thread_1" },
      { kind: "thread_resolves", threadId: "thread_1" },
      { kind: "location_state_changes", locationId: asLocationId("loc_1"), change: "unlocked" },
    ];
    for (const effect of effects) {
      // 每个 effect 都有明确 kind，执行以结构化字段为准，不依赖自由文本
      expect(Object.keys(effect).length).toBeGreaterThan(1);
      expect("kind" in effect).toBe(true);
    }
  });
});
