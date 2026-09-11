import { describe, expect, it } from "vitest";
import { realizeObservations } from "./realizeObservations";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asTurnId } from "@/game/domain/events";
import { asFactId, asGenerationId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import type { NpcEntityRecord } from "@/game/domain/entity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import type { BundleStepObservation } from "@/game/domain/narrativeBundle";

function worldWithFact() {
  const projection: EntityCompatibilityProjection = {
    player: { name: "少侠", identity: "过路人", stats: { hp: 100, attack: 10, defense: 5 } },
    locations: [
      { id: asLocationId("loc_0"), name: "渡口", description: "d", kind: "main", connectedLocationIds: [], npcIds: [asNpcId("npc_0"), asNpcId("npc_1")], availableItemIds: [], tags: [], scale: "scene" },
    ],
    currentLocationId: asLocationId("loc_0"),
    unlockedLocationIds: [asLocationId("loc_0")],
    visitedLocationIds: [asLocationId("loc_0")],
    npcs: [
      { id: asNpcId("npc_0"), name: "老陈", role: "知情者", description: "守渡口", locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true, memory: { npcId: asNpcId("npc_0"), knownFactIds: [asFactId("fact_old")], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } },
      { id: asNpcId("npc_1"), name: "哑姑", role: "向导", description: "向导", locationId: asLocationId("loc_0"), isCompanion: false, tags: [], met: true, memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } },
    ],
    items: [],
    inventory: [],
    worldFacts: [
      { factId: asFactId("fact_old"), text: "旧案另有隐情。", source: "generated", discovered: false, locationId: asLocationId("loc_0") },
    ],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    factions: [],
  };
  return createWorldStateFixtureWith({
    generation: {
      generationId: asGenerationId("gen_realize"), seed: "realize-seed", templateVersion: "v2",
      inputDigest: "", gameType: "wuxia",
    },
    base: projection,
  });
}

const OBSERVATION: BundleStepObservation = {
  key: "obs_old",
  factId: "fact_old",
  certainty: "known",
  source: { kind: "witness" },
};

const SPEECH_OBSERVATION: BundleStepObservation = {
  key: "obs_speech",
  factId: "fact_old",
  certainty: "known",
  source: { kind: "speech", speakerId: "npc_0" },
};

describe("realizeObservations", () => {
  it.each(["forgotten", "secret", "suspected"] as const)("消费拒绝来源认知已变化：%s", change => {
    const base = worldWithFact();
    const ws = { ...base, entityStore: { ...base.entityStore, records: base.entityStore.records.map(record =>
      "knowledge" in record && String(record.core.id) === "npc_0"
        ? { ...record, knowledge: { ...record.knowledge, entries: change === "forgotten" ? [] :
          record.knowledge.entries.map(entry => ({ ...entry,
            ...(change === "secret" ? { disclosure: "secret" as const } : { certainty: "suspected" as const }) })) } } : record) } };
    const result = realizeObservations({ worldState: ws, stepId: "s1", observations: [SPEECH_OBSERVATION],
      conditionalEvidence: [{ partIndex: -1, observationKey: "obs_speech", audienceId: "npc_1" }],
      turnId: asTurnId("turn-1"), actionId: "a1", turnNumber: 1,
      episodeKey: "turn", locationId: asLocationId("loc_0"), causeKeys: [] });
    expect(result).toEqual({ ok: false, code: "observation_speech_authority_changed" });
    expect(ws.eventLedger).toBe(base.eventLedger);
  });

  it("无条件证据时原样返回世界状态与空草稿", () => {
    const ws = worldWithFact();
    const result = realizeObservations({
      worldState: ws, stepId: "s1", observations: [], conditionalEvidence: [],
      turnId: asTurnId("turn-1"), actionId: "a1", turnNumber: 1,
      episodeKey: "turn", locationId: asLocationId("loc_0"), causeKeys: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.worldState).toBe(ws);
    expect(result.drafts).toEqual([]);
  });

  it("观察未在条件证据中声明时零写入（条件引用不进入 ledger）", () => {
    const ws = worldWithFact();
    const result = realizeObservations({
      worldState: ws, stepId: "s1", observations: [OBSERVATION], conditionalEvidence: [],
      turnId: asTurnId("turn-1"), actionId: "a1", turnNumber: 1,
      episodeKey: "turn", locationId: asLocationId("loc_0"), causeKeys: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toEqual([]);
  });

  it("NPC 受众的 speech 观察产出事件草稿并写入该 NPC 的知识", () => {
    const ws = worldWithFact();
    const result = realizeObservations({
      worldState: ws, stepId: "s1", observations: [SPEECH_OBSERVATION],
      conditionalEvidence: [{ partIndex: -1, observationKey: "obs_speech", audienceId: "npc_1" }],
      turnId: asTurnId("turn-1"), actionId: "a1", turnNumber: 1,
      episodeKey: "turn", locationId: asLocationId("loc_0"), causeKeys: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.payload).toMatchObject({
      type: "narrative_observed",
      observationKey: "obs_speech",
      audienceId: "npc_1",
      factId: "fact_old",
      certainty: "known",
      source: { kind: "speech", speakerId: "npc_0" },
    });
    // 事件 key 决定了 commitEventDrafts 将铸造的 EventId：必须确定性可预铸。
    expect(result.drafts[0]?.eventKey).toBe("narrative_observed:s1:obs_speech:npc_1");
    const npc1 = result.worldState.entityStore.records.find(
      (record): record is NpcEntityRecord => record.core.kind === "npc" && String(record.core.id) === "npc_1",
    );
    expect(npc1?.knowledge.entries.some((entry) => String(entry.factId) === "fact_old")).toBe(true);
  });

  it("玩家受众只铸造事件，不写 NPC 知识组件", () => {
    const ws = worldWithFact();
    const result = realizeObservations({
      worldState: ws, stepId: "s1", observations: [OBSERVATION],
      conditionalEvidence: [{ partIndex: 0, observationKey: "obs_old", audienceId: "player_0" }],
      turnId: asTurnId("turn-1"), actionId: "a1", turnNumber: 1,
      episodeKey: "turn", locationId: asLocationId("loc_0"), causeKeys: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.drafts).toHaveLength(1);
    expect(result.worldState).toBe(ws);
  });

  it("条件证据引用了不存在的观察时 fail-closed", () => {
    const ws = worldWithFact();
    const result = realizeObservations({
      worldState: ws, stepId: "s1", observations: [OBSERVATION],
      conditionalEvidence: [{ partIndex: 0, observationKey: "obs_missing", audienceId: "player" }],
      turnId: asTurnId("turn-1"), actionId: "a1", turnNumber: 1,
      episodeKey: "turn", locationId: asLocationId("loc_0"), causeKeys: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("observation_source_missing");
  });
});
