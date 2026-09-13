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
import { asEventId } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import {
  authorizeNpcDeliberationOutward,
  buildNpcSpeechAuthority,
  validateNpcSpeechReferences,
  type NpcSpeechAuthority,
} from "./npcSpeechAuthority";

const NPC_A = asNpcId("npc_a");
const NPC_B = asNpcId("npc_b");
const LOCATION = asLocationId("loc_1");
const FACT_PUBLIC = asFactId("fact_public");
const FACT_SECRET = asFactId("fact_secret");
const FACT_ORPHAN = asFactId("fact_orphan");

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
    eventId: asEventId(`evt:test:${actionId}:${turnNumber}`),
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
      supportingEventIds: [asEventId("evt:authority:1")],
    }],
    origin: { kind: "initial_world", createdAtTurn: 0, reasonKey: "test" },
    lastChangedAtTurn: 1,
  };
}

function edgeWithEvidence(
  targetId: DirectedRelationshipEdge["targetId"],
  summaryKeys: readonly string[],
): DirectedRelationshipEdge {
  const base = edge(targetId);
  return {
    ...base,
    evidence: summaryKeys.map((summaryKey, index) => ({
      ...base.evidence[0]!,
      evidenceId: `evidence_${String(targetId)}_${index}`,
      actionId: `action_${index}`,
      turnNumber: index + 1,
      summaryKey,
    })),
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
    { core: { id: PLAYER_ENTITY_ID, kind: "player_character", name: "玩家", createdAtTurn: 0, lifecycle: "active" }, identity: { identity: "行者", stats: { hp: 10, attack: 2, defense: 1 } }, knowledge: { knownFactIds: [] }, position: { locationId: LOCATION, locationOrder: 0 } },
    npcRecord(),
    { core: { id: NPC_B, kind: "npc", name: "旅人", createdAtTurn: 0, lifecycle: "active" }, identity: { role: "旅人", description: "", tags: [], anchors: ANCHORS }, position: { locationId: LOCATION, locationOrder: 1 }, dynamicState: { isCompanion: false, met: true, emotion: "neutral", goals: [] }, knowledge: { entries: [] }, relationships: { outgoing: [] }, history: { interactions: [] } },
    factRecord(FACT_PUBLIC, "桥下留有新鲜脚印"),
    factRecord(FACT_SECRET, "守夜人隐瞒了旧案"),
  ];
}

function authority(): NpcSpeechAuthority {
  return buildNpcSpeechAuthority({
    store: { version: 3, records: records() },
    speakerNpcId: NPC_A,
    sceneVisibleFactIds: [FACT_PUBLIC, FACT_PUBLIC, FACT_SECRET],
    targetContext: { targetId: PLAYER_ENTITY_ID, interactionEventIds: [asEventId("evt:test:action_2:2")] },
  })!;
}

describe("NpcSpeechAuthority", () => {
  it("projects only the speaker's allowed facts, interactions, anchors, goals and qualitative target relation", () => {
    const result = authority();

    expect(result.allowedFactIds).toEqual([FACT_PUBLIC]);
    expect(result.responseTier).toBe("trusted");
    expect(result.withheldFactIds).toEqual([FACT_SECRET]);
    expect(result.allowedEventIds).toEqual([asEventId("evt:authority:1"), asEventId("evt:test:action_2:2")]);
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
    expect(new Set(first.allowedEventIds).size).toBe(first.allowedEventIds.length);
    expect(first.relationships.map((relation) => relation.targetId)).toEqual([PLAYER_ENTITY_ID]);
    expect(first.evidenceKeys.length).toBeLessThanOrEqual(3);
  });

  it("does not read a legacy memory block because the input is the entity store", () => {
    const result = buildNpcSpeechAuthority({
    store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
    })!;

    expect(result.allowedFactIds).toEqual([FACT_PUBLIC]);
    expect(result.allowedEventIds).toEqual([asEventId("evt:test:action_1:1"), asEventId("evt:test:action_2:2")]);
  });

  it("crops relations and evidence to an explicitly requested NPC target", () => {
    const result = buildNpcSpeechAuthority({
    store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: NPC_B },
    })!;

    expect(result.relationships.map((relation) => relation.targetId)).toEqual([NPC_B]);
    expect(result.relationship?.targetId).toBe(NPC_B);
    expect(result.evidenceKeys).toEqual(["support_received"]);
  });

  it("returns no relation or evidence when target is absent", () => {
    const result = buildNpcSpeechAuthority({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
    })!;

    expect(result.relationships).toEqual([]);
    expect(result.relationship).toBeUndefined();
    expect(result.evidenceKeys).toEqual([]);
  });

  it("fails closed for an unknown target instead of exposing remote edges", () => {
    const unknownTarget = asNpcId("npc_unknown");
    const speaker = {
      ...npcRecord(),
      relationships: { outgoing: [edge(unknownTarget), edge(NPC_B), edge(PLAYER_ENTITY_ID)] },
    };
    const result = buildNpcSpeechAuthority({
    store: { version: 3, records: records().map((record) => record.core.id === NPC_A ? speaker : record) },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: unknownTarget },
    })!;

    expect(result.relationships).toEqual([]);
    expect(result.relationship).toBeUndefined();
    expect(result.evidenceKeys).toEqual([]);
  });

  it("caps more than three real evidence keys after stable deduplication", () => {
    const speaker = {
      ...npcRecord(),
      relationships: {
        outgoing: [edgeWithEvidence(PLAYER_ENTITY_ID, ["zeta", "alpha", "delta", "beta", "alpha"])],
      },
    };
    const result = buildNpcSpeechAuthority({
    store: { version: 3, records: records().map((record) => record.core.id === NPC_A ? speaker : record) },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: PLAYER_ENTITY_ID },
    })!;

    expect(result.evidenceKeys).toEqual(["alpha", "beta", "delta"]);
  });

  it("keeps empty history empty and returns null for an unknown speaker", () => {
    const speaker = { ...npcRecord(), history: { interactions: [] } };
    const result = buildNpcSpeechAuthority({
    store: { version: 3, records: records().map((record) => record.core.id === NPC_A ? speaker : record) },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
    })!;
    expect(result.recentInteractions).toEqual([]);
    expect(buildNpcSpeechAuthority({
    store: { version: 3, records: records() },
      speakerNpcId: asNpcId("npc_missing"),
      sceneVisibleFactIds: [],
    })).toBeNull();
  });

  it("requires every allowed fact ID to have a fact record and a matching card", () => {
    const speaker = {
      ...npcRecord(),
      knowledge: {
        entries: [
          ...npcRecord().knowledge.entries,
          { factId: FACT_ORPHAN, certainty: "known" as const, disclosure: "public" as const, source: { kind: "initial_world" as const, learnedAtTurn: 0 } },
        ],
      },
    };
    const result = buildNpcSpeechAuthority({
      store: { version: 3, records: records().map((record) => record.core.id === NPC_A ? speaker : record) },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC, FACT_ORPHAN, asFactId("fact_scene_unknown")],
      targetContext: { targetId: PLAYER_ENTITY_ID },
    })!;

    expect(result.allowedFactIds).toEqual([FACT_PUBLIC]);
    expect(result.withheldFactIds).toEqual([FACT_ORPHAN, FACT_SECRET]);
    expect(result.allowedFactCards.map((card) => card.factId)).toEqual(result.allowedFactIds);
    expect(result.allowedFactCards).toEqual([{ factId: FACT_PUBLIC, text: "桥下留有新鲜脚印" }]);
    expect(result.allowedFactIds).not.toContain(asFactId("fact_scene_unknown"));
  });

  it("filters event references that are absent from the ledger or do not involve the speaker", () => {
    const validInteraction = makeCommittedEvent({
      type: "npc_interaction_recorded",
      npcId: NPC_A,
      dialogueAct: "ask",
    }, {
      eventId: asEventId("evt:test:action_2:2"),
      actorIds: [NPC_A],
      targetIds: [PLAYER_ENTITY_ID],
    });
    const unrelatedEvent = makeCommittedEvent({
      type: "npc_interaction_recorded",
      npcId: NPC_B,
      dialogueAct: "ask",
    }, {
      eventId: asEventId("turn:interaction:unrelated"),
      actorIds: [NPC_B],
      targetIds: [PLAYER_ENTITY_ID],
    });
    const result = buildNpcSpeechAuthority({
    store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      eventLedger: [validInteraction, unrelatedEvent],
      targetContext: {
        targetId: PLAYER_ENTITY_ID,
        interactionEventIds: [
          validInteraction.eventId,
          unrelatedEvent.eventId,
          asEventId("turn:interaction:missing"),
        ],
      },
    });

    expect(result?.allowedEventIds).toEqual([validInteraction.eventId]);
  });

  it("rejects a used event unless the committed ledger proves the speaker participated", () => {
    const unrelatedEvent = makeCommittedEvent({
      type: "npc_interaction_recorded",
      npcId: NPC_B,
      dialogueAct: "ask",
    }, {
      eventId: asEventId("turn:interaction:unrelated"),
      actorIds: [NPC_B],
      targetIds: [PLAYER_ENTITY_ID],
    });
    const authority = buildNpcSpeechAuthority({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      eventLedger: [unrelatedEvent],
      targetContext: { targetId: PLAYER_ENTITY_ID },
    })!;

    expect(validateNpcSpeechReferences({
      authority,
      usedFactIds: [],
      usedEventIds: [unrelatedEvent.eventId],
      eventLedger: [unrelatedEvent],
      speakerNpcId: NPC_A,
    })).toEqual({ ok: false, code: "invalid_event_reference" });
  });

  it("rejects a private disclosure and invalid evidence before creating an outward projection", () => {
    const rejectedFact = authorizeNpcDeliberationOutward({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC, FACT_SECRET],
      targetContext: { targetId: PLAYER_ENTITY_ID },
      proposal: {
        response: "refuse",
        goalIds: ["goal_1"],
        evidenceEventIds: [],
        discloseFactIds: [FACT_SECRET],
        interactionProposals: [],
      },
    });
    expect(rejectedFact).toEqual({ ok: false, code: "invalid_fact_disclosure" });

    const rejectedEvidence = authorizeNpcDeliberationOutward({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: PLAYER_ENTITY_ID },
      proposal: {
        response: "cooperate",
        goalIds: [],
        evidenceEventIds: [asEventId("turn:missing:evidence")],
        discloseFactIds: [],
        interactionProposals: [],
      },
    });
    expect(rejectedEvidence).toEqual({ ok: false, code: "invalid_event_reference" });
  });

  it("returns only approved outward fields and never forwards private context or goals", () => {
    const result = authorizeNpcDeliberationOutward({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: PLAYER_ENTITY_ID },
      proposal: {
        response: "cooperate",
        goalIds: ["goal_1"],
        evidenceEventIds: [asEventId("evt:test:action_2:2")],
        discloseFactIds: [FACT_PUBLIC],
        interactionProposals: [],
      },
    });

    expect(result).toEqual({
      ok: true,
      projection: {
        npcId: NPC_A,
        response: "cooperate",
        evidenceEventIds: [asEventId("evt:test:action_2:2")],
        discloseFactIds: [FACT_PUBLIC],
        interactionProposals: [],
      },
    });
    if (result.ok) {
      expect(result.projection).not.toHaveProperty("goalIds");
      expect(result.projection).not.toHaveProperty("privateContext");
    }
  });

  it("does not let an interaction proposal bypass audience-specific disclosure authority", () => {
    const result = authorizeNpcDeliberationOutward({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC, FACT_SECRET],
      targetContext: { targetId: PLAYER_ENTITY_ID },
      proposal: {
        response: "offer_condition",
        goalIds: [],
        evidenceEventIds: [],
        discloseFactIds: [],
        interactionProposals: [{
          proposalKey: "secret_share",
          npcId: NPC_A,
          operation: "request_introduction",
          condition: [],
          factIds: [FACT_SECRET],
          goalIds: [],
          promiseId: null,
          audienceIds: [NPC_B],
          evidenceEventIds: [],
        }],
      },
    });

    expect(result).toEqual({ ok: false, code: "invalid_fact_disclosure" });
  });

  it("rejects goal references that are not current goals of the deliberating NPC", () => {
    const result = authorizeNpcDeliberationOutward({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: PLAYER_ENTITY_ID },
      proposal: {
        response: "question",
        goalIds: ["goal:not_owned"],
        evidenceEventIds: [],
        discloseFactIds: [],
        interactionProposals: [],
      },
    });

    expect(result).toEqual({ ok: false, code: "invalid_interaction_proposal" });
  });

  it("applies current-goal ownership checks to nested interaction proposals", () => {
    const result = authorizeNpcDeliberationOutward({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: PLAYER_ENTITY_ID },
      proposal: {
        response: "offer_condition",
        goalIds: [],
        evidenceEventIds: [],
        discloseFactIds: [],
        interactionProposals: [{
          proposalKey: "bad_goal",
          npcId: NPC_A,
          operation: "share_known_fact",
          condition: [],
          factIds: [FACT_PUBLIC],
          goalIds: ["goal:not_owned"],
          promiseId: null,
          audienceIds: [PLAYER_ENTITY_ID],
          evidenceEventIds: [],
        }],
      },
    });

    expect(result).toEqual({ ok: false, code: "invalid_interaction_proposal" });
  });

  it("keeps verification and fact-sharing operation requirements at the NPC boundary", () => {
    const result = authorizeNpcDeliberationOutward({
      store: { version: 3, records: records() },
      speakerNpcId: NPC_A,
      sceneVisibleFactIds: [FACT_PUBLIC],
      targetContext: { targetId: PLAYER_ENTITY_ID },
      proposal: {
        response: "offer_condition",
        goalIds: [],
        evidenceEventIds: [],
        discloseFactIds: [],
        interactionProposals: [{
          proposalKey: "verification_without_evidence",
          npcId: NPC_A,
          operation: "request_verification",
          condition: [],
          factIds: [FACT_PUBLIC],
          goalIds: [],
          promiseId: null,
          audienceIds: [PLAYER_ENTITY_ID],
          evidenceEventIds: [],
        }],
      },
    });

    expect(result).toEqual({ ok: false, code: "invalid_interaction_proposal" });
  });
});


it("accepts the diagnostic npc_met companion evidence through deliberation and scene speech gates", () => {
  // p1-diag-01 returned both event IDs twice; npc_met has no separate interaction row.
  const actionId = "S1-diagnostic-action-0";
  const npcId = asNpcId("npc_0");
  const raw = '{"npcId":"npc_0","goalIds":["npc_0_goal_1","npc_0_goal_2"],"response":"question","evidenceEventIds":["S1-diagnostic-action-0:npc_interaction_recorded:npc_0:S1-diagnostic-action-0","S1-diagnostic-action-0:npc_met:npc_0"],"discloseFactIds":[],"interactionProposals":[]}';
  const proposal = JSON.parse(raw);
  const met = makeCommittedEvent({ type: "npc_met", npcId }, {
    eventId: asEventId(proposal.evidenceEventIds[1]), actionId, actorIds: [PLAYER_ENTITY_ID], targetIds: [npcId],
  });
  const talked = makeCommittedEvent({ type: "npc_interaction_recorded", npcId, dialogueAct: "ask" }, {
    eventId: asEventId(proposal.evidenceEventIds[0]), actionId, actorIds: [PLAYER_ENTITY_ID], targetIds: [npcId],
  });
  const original = npcRecord();
  const speaker: NpcEntityRecord = { ...original, core: { ...original.core, id: npcId },
    dynamicState: { ...original.dynamicState, goals: proposal.goalIds.map((goalId: string) => ({ ...original.dynamicState.goals[0]!, goalId })) },
    history: { interactions: [{ ...interaction(actionId, 1), eventId: talked.eventId }] },
  };
  const store = { version: 3 as const, records: [...records().filter(record => record.core.id !== NPC_A), speaker] };
  const input = { store, speakerNpcId: npcId, sceneVisibleFactIds: [FACT_PUBLIC],
    eventLedger: [met, talked], targetContext: { targetId: PLAYER_ENTITY_ID }, proposal };
  expect(authorizeNpcDeliberationOutward(input).ok).toBe(true);
  const authority = buildNpcSpeechAuthority(input)!;
  expect(validateNpcSpeechReferences({ authority, usedFactIds: [], usedEventIds: proposal.evidenceEventIds,
    eventLedger: input.eventLedger, speakerNpcId: npcId })).toEqual({ ok: true });
  expect(authorizeNpcDeliberationOutward({ ...input, eventLedger: [talked] }).ok).toBe(false);
  expect(authorizeNpcDeliberationOutward({ ...input, eventLedger: [talked, { ...met, targetIds: [NPC_B] }] }).ok).toBe(false);
  expect(authorizeNpcDeliberationOutward({ ...input, proposal: { ...proposal, discloseFactIds: [FACT_SECRET] } }).ok).toBe(false);
});

it("only accepts explicit current events with ledger proof and NPC participation", () => {
  const event = makeCommittedEvent({ type: "npc_met", npcId: NPC_A }, {
    eventId: asEventId("current:npc_met:npc_a"), actorIds: [PLAYER_ENTITY_ID], targetIds: [NPC_A],
  });
  const input = { store: { version: 3 as const, records: records() }, speakerNpcId: NPC_A, sceneVisibleFactIds: [],
    targetContext: { targetId: PLAYER_ENTITY_ID, currentEventIds: [event.eventId] } };
  expect(buildNpcSpeechAuthority({ ...input, eventLedger: [event] })?.allowedEventIds).toContain(event.eventId);
  expect(buildNpcSpeechAuthority(input)?.allowedEventIds).not.toContain(event.eventId);
  expect(buildNpcSpeechAuthority({ ...input, eventLedger: [{ ...event, targetIds: [NPC_B] }] })?.allowedEventIds).not.toContain(event.eventId);
});


describe("committed confidentiality disclosure boundary", () => {
  function setup(status: "open" | "broken" | "released" | "fulfilled" = "open") {
    const pledgeEvent = makeCommittedEvent({ type: "story_interaction_resolved", interactionId: "interaction:pledge", npcId: NPC_A,
      operation: "promise_confidentiality", factIds: [], audienceIds: [PLAYER_ENTITY_ID], evidenceEventIds: [] },
      { actionId: "pledge_action", outcome: "success" });
    const npc = npcRecord();
    const pledged: NpcEntityRecord = { ...npc, relationships: { outgoing: [{ ...edge(PLAYER_ENTITY_ID), commitments: [{
      kind: "promise", commitmentId: "cmt:action:pledge_action:open_promise:interaction:pledge", promisor: "target", status,
      description: "relationship.promise.confidentiality", source: { kind: "action", actionId: "pledge_action", turnNumber: 1 },
      confidentiality: { protectedFactIds: [FACT_SECRET], allowedAudienceIds: [PLAYER_ENTITY_ID, NPC_A], fulfillment: { kind: "story_delivery" } },
    }] }] } };
    return { store: { version: 3 as const, records: records().map(record => record.core.id === NPC_A ? pledged : record) },
      speakerNpcId: NPC_A, sceneVisibleFactIds: [FACT_PUBLIC], targetContext: { targetId: PLAYER_ENTITY_ID }, eventLedger: [pledgeEvent] };
  }
  const proposal = { response: "offer_condition" as const, evidenceEventIds: [], discloseFactIds: [], interactionProposals: [{
    proposalKey: "introduce", npcId: NPC_A, operation: "request_introduction" as const, condition: [], factIds: [FACT_SECRET],
    goalIds: [], promiseId: null, audienceIds: [PLAYER_ENTITY_ID], evidenceEventIds: [],
  }] };
  it("permits the real introduction offer after a committed pledge but withholds unspoken secret from speech", () => {
    const input = setup();
    expect(authorizeNpcDeliberationOutward({ ...input, proposal }).ok).toBe(true);
    expect(buildNpcSpeechAuthority(input)?.allowedFactIds).not.toContain(FACT_SECRET);
    expect(authorizeNpcDeliberationOutward({ ...input, proposal: { ...proposal, discloseFactIds: [FACT_SECRET] } })).toMatchObject({ ok: false, code: "invalid_fact_disclosure" });
    expect(buildNpcSpeechAuthority({ ...input, sceneVisibleFactIds: [FACT_PUBLIC, FACT_SECRET] })?.allowedFactIds).not.toContain(FACT_SECRET);
    const disclosed = { ...input, sceneVisibleFactIds: [FACT_PUBLIC, FACT_SECRET], store: { ...input.store, records: input.store.records.map(record => record.core.kind === "player_character" ? { ...(record as import("@/game/domain/entity").PlayerEntityRecord), knowledge: { knownFactIds: [FACT_SECRET] } } : record) } };
    expect(buildNpcSpeechAuthority(disclosed)?.allowedFactIds).toContain(FACT_SECRET);
  });
  it("requires actual matching selected promise evidence, not only a commitment component", () => {
    expect(authorizeNpcDeliberationOutward({ ...setup(), eventLedger: [], proposal }).ok).toBe(false);
    const input = setup();
    expect(authorizeNpcDeliberationOutward({ ...input, eventLedger: input.eventLedger.map(event => ({ ...event, actionId: "unrelated" })), proposal }).ok).toBe(false);
  });
  for (const status of ["broken", "released"] as const) it(`does not unlock a ${status} pledge`, () => {
    expect(authorizeNpcDeliberationOutward({ ...setup(status), proposal }).ok).toBe(false);
  });
  for (const status of ["fulfilled", "broken", "released"] as const) it(`can retell already disclosed facts after ${status}, but cannot authorize a fresh introduction`, () => {
    const input = setup(status);
    const disclosure = makeCommittedEvent({ type: "story_interaction_resolved", interactionId: "interaction:introduce", npcId: NPC_A,
      operation: "request_introduction", factIds: [FACT_SECRET], audienceIds: [PLAYER_ENTITY_ID], evidenceEventIds: [] },
      { actionId: "intro_action", outcome: "success", actorIds: [PLAYER_ENTITY_ID, NPC_A] });
    const known = { ...input, sceneVisibleFactIds: [FACT_PUBLIC, FACT_SECRET], store: { ...input.store, records: input.store.records.map(record => record.core.kind === "player_character" ? { ...(record as import("@/game/domain/entity").PlayerEntityRecord), knowledge: { knownFactIds: [FACT_SECRET] } } : record) } };
    expect(buildNpcSpeechAuthority(known)?.allowedFactIds).not.toContain(FACT_SECRET);
    const disclosed = { ...known, eventLedger: [...input.eventLedger, disclosure] };
    expect(buildNpcSpeechAuthority(disclosed)?.allowedFactIds).toContain(FACT_SECRET);
    expect(buildNpcSpeechAuthority({ ...disclosed, sceneVisibleFactIds: [FACT_PUBLIC] })?.allowedFactIds).not.toContain(FACT_SECRET);
    expect(buildNpcSpeechAuthority({ ...disclosed, store: input.store })?.allowedFactIds).not.toContain(FACT_SECRET);
    expect(buildNpcSpeechAuthority({ ...disclosed, targetContext: { targetId: NPC_B } })?.allowedFactIds).not.toContain(FACT_SECRET);
    expect(authorizeNpcDeliberationOutward({ ...disclosed, proposal }).ok).toBe(false);
  });
  it("does not extend the agreement to a bystander or another speaker", () => {
    expect(authorizeNpcDeliberationOutward({ ...setup(), proposal: { ...proposal, interactionProposals: [{ ...proposal.interactionProposals[0]!, audienceIds: [PLAYER_ENTITY_ID, NPC_B] }] } }).ok).toBe(false);
    expect(authorizeNpcDeliberationOutward({ ...setup(), speakerNpcId: NPC_B, proposal }).ok).toBe(false);
  });
});
