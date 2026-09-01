import { describe, expect, it } from "vitest";
import type {
  DirectedRelationshipEdge,
  EntityRecord,
  NpcIdentityAnchors,
  NpcKnowledgeEntry,
  NpcEntityRecord,
} from "@/game/domain/entity";
import type { NpcInteraction } from "@/game/domain/worldEntries";
import { asFactId, asLocationId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import {
  buildNpcSpeechAuthority,
  type NpcSpeechAuthority,
} from "./npcSpeechAuthority";

const NPC_A = asNpcId("npc_a");
const NPC_B = asNpcId("npc_b");
const LOCATION = asLocationId("loc_1");
const FACT_PUBLIC = asFactId("fact_public");
const FACT_SECRET = asFactId("fact_secret");

const ANCHORS: NpcIdentityAnchors = {
  selfConcept: "守夜人",
  values: ["守诺", "克制"],
  speechStyle: "短句，少作解释",
  capabilityBoundaries: ["不替人定罪"],
  taboos: ["不泄露无关者的秘密"],
};

function factRecord(factId: typeof FACT_PUBLIC | typeof FACT_SECRET, text: string): EntityRecord {
  return {
    core: { id: factId, kind: "fact", name: factId, createdAtTurn: 0, lifecycle: "active" },
    fact: { text, source: "generated", discovered: true, locationId: LOCATION },
  };
}

function interaction(actionId: string, turnNumber: number): NpcInteraction {
  return {
    turnNumber,
    actionId,
    locationId: LOCATION,
    dialogueAct: "ask",
    topic: { kind: "general" },
    topicSummary: `话题${turnNumber}`,
    outcome: "positive",
    relationshipDelta: 3,
    learnedFactIds: [],
    summary: `结构化交互${turnNumber}`,
  };
}

function edge(targetId: DirectedRelationshipEdge["targetId"]): DirectedRelationshipEdge {
  return {
    targetId,
    dimensions: { affinity: 72, trust: 61, fear: 0, hostility: 0 },
    stage: "trusted",
    trend: "improving",
    commitments: [{
      kind: "debt",
      commitmentId: "debt_1",
      direction: "source_owes_target",
      status: "open",
      description: "守夜人欠玩家一个解释",
      source: { kind: "initial_world", createdAtTurn: 0, reasonKey: "test" },
    }],
    evidence: [{
      evidenceId: `evidence_${String(targetId)}`,
      actionId: "action_1",
      turnNumber: 1,
      signal: "supported",
      severity: "major",
      summaryKey: "support_received",
    }],
    origin: { kind: "initial_world", createdAtTurn: 0, reasonKey: "test" },
    lastChangedAtTurn: 1,
  };
}

function npcRecord(): NpcEntityRecord {
  const knowledge: readonly NpcKnowledgeEntry[] = [
    { factId: FACT_PUBLIC, certainty: "known", disclosure: "public", source: { kind: "initial_world", learnedAtTurn: 0 } },
    { factId: FACT_SECRET, certainty: "known", disclosure: "secret", source: { kind: "initial_world", learnedAtTurn: 0 } },
  ];
  return {
    core: { id: NPC_A, kind: "npc", name: "守夜人", createdAtTurn: 0, lifecycle: "active" },
    identity: { role: "守夜人", description: "看守旧桥", tags: [], anchors: ANCHORS },
    position: { locationId: LOCATION, locationOrder: 0 },
    dynamicState: {
      isCompanion: false,
      met: true,
      emotion: "guarded",
      goals: [{ goalId: "goal_1", horizon: "short", description: "查明失踪的脚印", priority: 1, status: "active", reason: "test" }],
    },
    knowledge: { entries: knowledge },
    relationships: { outgoing: [edge(NPC_B), edge(PLAYER_ENTITY_ID)] },
    history: { interactions: [interaction("action_1", 1), interaction("action_2", 2), interaction("action_2", 2)] },
  };
}

function records(): readonly EntityRecord[] {
  return [
    { core: { id: PLAYER_ENTITY_ID, kind: "player_character", name: "玩家", createdAtTurn: 0, lifecycle: "active" }, identity: { identity: "行者", stats: { hp: 10, attack: 2, defense: 1 } }, position: { locationId: LOCATION, locationOrder: 0 } },
    npcRecord(),
    { core: { id: NPC_B, kind: "npc", name: "旅人", createdAtTurn: 0, lifecycle: "active" }, identity: { role: "旅人", description: "", tags: [], anchors: ANCHORS }, position: { locationId: LOCATION, locationOrder: 1 }, dynamicState: { isCompanion: false, met: true, emotion: "neutral", goals: [] }, knowledge: { entries: [] }, relationships: { outgoing: [] }, history: { interactions: [] } },
    factRecord(FACT_PUBLIC, "桥下留有新鲜脚印"),
    factRecord(FACT_SECRET, "守夜人隐瞒了旧案"),
  ];
}

function authority(): NpcSpeechAuthority {
  return buildNpcSpeechAuthority({
    store: { version: 2, records: records() },
    speakerNpcId: NPC_A,
    sceneVisibleFactIds: [FACT_PUBLIC, FACT_PUBLIC, FACT_SECRET],
    targetContext: { targetId: PLAYER_ENTITY_ID, interactionActionIds: ["action_2", "unknown"] },
  });
}

describe("NpcSpeechAuthority", () => {
  it("projects only the speaker's allowed facts, interactions, anchors, goals and qualitative target relation", () => {
    const result = authority();

    expect(result.allowedFactIds).toEqual([FACT_PUBLIC]);
    expect(result.responseTier).toBe("trusted");
    expect(result.withheldFactIds).toEqual([FACT_SECRET]);
    expect(result.allowedInteractionActionIds).toEqual(["action_2"]);
    expect(result.identityAnchors).toEqual(ANCHORS);
    expect(result.activeGoals).toEqual(["查明失踪的脚印"]);
    expect(result.allowedFactCards).toEqual([{ factId: FACT_PUBLIC, text: "桥下留有新鲜脚印" }]);
    expect(result.recentInteractions.map((item) => item.actionId)).toEqual(["action_1", "action_2"]);
    expect(result.relationship).toEqual({
      targetId: PLAYER_ENTITY_ID,
      stage: "trusted",
      trend: "improving",
      openCommitments: [{ kind: "debt", commitmentId: "debt_1", direction: "source_owes_target", description: "守夜人欠玩家一个解释" }],
    });
    expect(result.evidenceKeys).toEqual(["support_received"]);
    expect(result).not.toHaveProperty("dimensions");
    expect(JSON.stringify(result)).not.toMatch(/"(?:dimensions|affinity|trust|fear|hostility|relationshipDelta)"\s*:/);
    expect(JSON.stringify(result)).not.toContain("守夜人隐瞒了旧案");
  });

  it("keeps stable ordering and removes duplicate fact and interaction IDs", () => {
    const first = authority();
    const second = authority();

    expect(first).toEqual(second);
    expect(new Set(first.allowedFactIds).size).toBe(first.allowedFactIds.length);
    expect(new Set(first.withheldFactIds).size).toBe(first.withheldFactIds.length);
    expect(new Set(first.allowedInteractionActionIds).size).toBe(first.allowedInteractionActionIds.length);
    expect(first.relationships.map((relation) => relation.targetId)).toEqual([NPC_B, PLAYER_ENTITY_ID]);
    expect(first.evidenceKeys.length).toBeLessThanOrEqual(3);
  });

  it("does not read a legacy memory block because the input is the entity store", () => {
    const result = buildNpcSpeechAuthority({
      store: { version: 2, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
    });

    expect(result.allowedFactIds).toEqual([FACT_PUBLIC]);
    expect(result.allowedInteractionActionIds).toEqual(["action_1", "action_2"]);
  });
});
