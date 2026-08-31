import { describe, expect, it } from "vitest";
import { PLAYER_ENTITY_ID, asFactId, asLocationId, asNpcId } from "../worldEntity";
import type { NpcInteraction } from "../worldEntries";
import {
  FACT_CHANGE_SOURCES,
  NPC_ANCHOR_LIST_MAX,
  NPC_ANCHOR_LIST_MIN,
  NPC_GOAL_PRIORITIES,
  NPC_GOAL_STATUSES,
  NPC_HISTORY_CAP,
  NPC_KNOWLEDGE_CERTAINTIES,
  NPC_KNOWLEDGE_DISCLOSURES,
  RELATIONSHIP_DIMENSION_KEYS,
  RELATIONSHIP_DIMENSION_MAX,
  RELATIONSHIP_DIMENSION_MIN,
  RELATIONSHIP_EVIDENCE_CAP,
  RELATIONSHIP_SEVERITIES,
  RELATIONSHIP_SIGNALS,
  RELATIONSHIP_STAGES,
  RELATIONSHIP_TRENDS,
  compareRelationshipTargetIds,
  validateNpcDynamicState,
  validateNpcHistory,
  validateNpcIdentityAnchors,
  validateNpcKnowledge,
  validateNpcRelationships,
  type DirectedRelationshipEdge,
  type NpcComponentValidationIssue,
  type NpcDynamicStateComponent,
  type NpcGoal,
  type NpcHistoryComponent,
  type NpcIdentityAnchors,
  type NpcKnowledgeComponent,
  type NpcKnowledgeEntry,
  type NpcKnowledgeSource,
  type NpcRelationshipComponent,
  type RelationshipCommitment,
  type RelationshipDimensions,
  type RelationshipEvidence,
} from "./npcComponents";

// ---------------------------------------------------------------------------
// 合法构件：每个测试只篡改它要验证的那一处，避免复合失败原因。
// validator 接受 unknown（SQLite JSON 读回值），因此篡改统一走 untrusted()。
// ---------------------------------------------------------------------------

const ANCHORS: NpcIdentityAnchors = {
  selfConcept: "我是守夜人的女儿，不是谁的附属",
  values: ["不欠人情", "护短"],
  speechStyle: "短句、爱反问",
  capabilityBoundaries: ["不会武功", "不识字"],
  taboos: ["不提母亲"],
};

function goal(overrides: Partial<NpcGoal> = {}): NpcGoal {
  return {
    goalId: "npc_0#goal1",
    horizon: "short",
    description: "守住客栈到秋后",
    priority: 3,
    status: "active",
    reason: "父亲留下的产业",
    ...overrides,
  };
}

const DYNAMIC_STATE: NpcDynamicStateComponent = {
  isCompanion: false,
  met: true,
  emotion: "guarded",
  goals: [goal()],
};

const KNOWN_ENTRY: NpcKnowledgeEntry = {
  factId: asFactId("fact_1"),
  certainty: "known",
  disclosure: "public",
  source: { kind: "initial_world", learnedAtTurn: 0 },
};

const LEARNED_ENTRY: NpcKnowledgeEntry = {
  factId: asFactId("fact_2"),
  certainty: "suspected",
  disclosure: "secret",
  source: {
    kind: "action",
    mode: "player_told",
    actionId: "act_3",
    learnedAtTurn: 4,
    sourceNpcId: asNpcId("npc_1"),
  },
};

const KNOWLEDGE: NpcKnowledgeComponent = { entries: [KNOWN_ENTRY, LEARNED_ENTRY] };

const DIMENSIONS: RelationshipDimensions = { affinity: 20, trust: 10, fear: 0, hostility: -5 };

const EVIDENCE: RelationshipEvidence = {
  evidenceId: "act_1:player_0:supported",
  actionId: "act_1",
  turnNumber: 2,
  signal: "supported",
  severity: "normal",
  summaryKey: "npc.relationship.signal.supported",
};

const DEBT: RelationshipCommitment = {
  kind: "debt",
  commitmentId: "cmt_1",
  direction: "source_owes_target",
  status: "open",
  description: "欠玩家一次人情",
  source: { kind: "action", actionId: "act_1", turnNumber: 2 },
};

const PROMISE: RelationshipCommitment = {
  kind: "promise",
  commitmentId: "cmt_2",
  promisor: "source",
  status: "open",
  description: "承诺秋后送信",
  source: { kind: "initial_world", createdAtTurn: 0, reasonKey: "npc.seed.ally" },
};

function edge(overrides: Partial<DirectedRelationshipEdge> = {}): DirectedRelationshipEdge {
  return {
    targetId: PLAYER_ENTITY_ID,
    dimensions: DIMENSIONS,
    stage: "cooperative",
    trend: "improving",
    commitments: [DEBT],
    evidence: [EVIDENCE],
    origin: { kind: "initial_world", createdAtTurn: 0, reasonKey: "npc.seed.ally" },
    lastChangedAtTurn: 2,
    ...overrides,
  };
}

const RELATIONSHIPS: NpcRelationshipComponent = {
  outgoing: [edge({ targetId: asNpcId("npc_1") }), edge()],
};

function interaction(actionId = "act_1", turnNumber = 1): NpcInteraction {
  return {
    turnNumber,
    actionId,
    locationId: asLocationId("loc_0"),
    dialogueAct: "ask",
    topicSummary: "询问井中事",
    outcome: "positive",
    relationshipDelta: 3,
    learnedFactIds: [asFactId("fact_1")],
    summary: "老周讲了三十年前封井的传闻",
  };
}

const HISTORY: NpcHistoryComponent = {
  interactions: [interaction("act_1", 1), interaction("act_2", 3)],
};

/** 深拷贝到 unknown：模拟从 SQLite JSON 读回的未信任值。 */
function untrusted<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

type Draft = Record<string, unknown>;

function tampered<T>(value: T, mutate: (draft: Draft) => void): unknown {
  const draft = untrusted(value) as Draft;
  mutate(draft);
  return draft;
}

/** 取数组字段的可变视图，用于篡改第 index 项。 */
function draftList(value: unknown, key: string): Draft[] {
  return (value as Draft)[key] as Draft[];
}

/** 取嵌套对象字段的可变视图（嵌套字段在 Draft 上是 unknown，必须先收敛）。 */
function draftObject(value: unknown, key: string): Draft {
  return (value as Draft)[key] as Draft;
}

function edgeAt(draft: Draft, index: number): Draft {
  return draftList(draft, "outgoing")[index];
}

function listAt(draft: Draft, key: string, index: number): Draft {
  return draftList(draft, key)[index];
}

function codesOf(issues: readonly NpcComponentValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function pathsOf(issues: readonly NpcComponentValidationIssue[]): string[] {
  return issues.map((issue) => issue.path);
}

function firstIssue(
  issues: readonly NpcComponentValidationIssue[],
): NpcComponentValidationIssue {
  const [first] = issues;
  if (first === undefined) throw new Error("expected a validation issue");
  return first;
}

// ---------------------------------------------------------------------------
// 封闭值域表
// ---------------------------------------------------------------------------

describe("NPC 组件常量表", () => {
  it("publishes the relationship signal closed set the plan names", () => {
    expect([...RELATIONSHIP_SIGNALS]).toEqual([
      "supported", "challenged", "threatened", "deceived", "offered_help", "reassured",
      "refused", "gave_item", "shared_fact", "fought_together", "betrayed",
      "kept_promise", "broke_promise",
    ]);
    expect(new Set(RELATIONSHIP_SIGNALS).size).toBe(13);
  });

  it("freezes the signal table so no consumer can mutate it", () => {
    expect(Object.isFrozen(RELATIONSHIP_SIGNALS)).toBe(true);
    expect(() => {
      (RELATIONSHIP_SIGNALS as unknown as string[]).push("flattered");
    }).toThrow(TypeError);
  });

  it("declares the seven stages and three trends of the relationship model", () => {
    expect([...RELATIONSHIP_STAGES]).toEqual([
      "unknown", "acquainted", "cooperative", "trusted", "bonded", "wary", "hostile",
    ]);
    expect([...RELATIONSHIP_TRENDS]).toEqual(["improving", "stable", "worsening"]);
    expect([...RELATIONSHIP_SEVERITIES]).toEqual(["normal", "major"]);
  });

  it("keeps the shared caps and closed dimension range as named constants", () => {
    expect(RELATIONSHIP_EVIDENCE_CAP).toBe(12);
    expect(NPC_HISTORY_CAP).toBe(10);
    expect(RELATIONSHIP_DIMENSION_MIN).toBe(-100);
    expect(RELATIONSHIP_DIMENSION_MAX).toBe(100);
    expect([...RELATIONSHIP_DIMENSION_KEYS]).toEqual(["affinity", "trust", "fear", "hostility"]);
    expect(NPC_ANCHOR_LIST_MIN).toBe(1);
    expect(NPC_ANCHOR_LIST_MAX).toBe(4);
    expect([...NPC_GOAL_PRIORITIES]).toEqual([1, 2, 3, 4, 5]);
    expect([...NPC_GOAL_STATUSES]).toEqual(["active", "blocked", "completed", "abandoned"]);
    expect([...NPC_KNOWLEDGE_CERTAINTIES]).toEqual(["known", "suspected"]);
    expect([...NPC_KNOWLEDGE_DISCLOSURES]).toEqual(["public", "conditional", "secret"]);
    expect([...FACT_CHANGE_SOURCES]).toEqual([
      "scene_witness", "player_told", "npc_revealed", "public_broadcast", "faction_shared",
    ]);
  });
});

// ---------------------------------------------------------------------------
// validateNpcIdentityAnchors
// ---------------------------------------------------------------------------

describe("validateNpcIdentityAnchors", () => {
  it("accepts a fully specified anchors object and reports no issue", () => {
    expect(validateNpcIdentityAnchors(untrusted(ANCHORS))).toEqual([]);
  });

  it("allows zero taboos but never zero values or capability boundaries", () => {
    expect(
      validateNpcIdentityAnchors(untrusted({ ...ANCHORS, taboos: [] })),
    ).toEqual([]);
    expect(codesOf(validateNpcIdentityAnchors(untrusted({ ...ANCHORS, values: [] }))))
      .toContain("anchor_count_out_of_range");
    expect(
      codesOf(validateNpcIdentityAnchors(untrusted({ ...ANCHORS, capabilityBoundaries: [] }))),
    ).toContain("anchor_count_out_of_range");
  });

  it("rejects an enumerated anchor list longer than the shared maximum", () => {
    const five = ["一", "二", "三", "四", "五"];
    const issues = validateNpcIdentityAnchors(untrusted({ ...ANCHORS, values: five }));
    expect(codesOf(issues)).toContain("anchor_count_out_of_range");
    expect(pathsOf(issues)).toContain("anchors.values");
    expect(
      codesOf(validateNpcIdentityAnchors(untrusted({ ...ANCHORS, taboos: five }))),
    ).toContain("anchor_count_out_of_range");
    expect(
      codesOf(validateNpcIdentityAnchors(untrusted({ ...ANCHORS, capabilityBoundaries: five }))),
    ).toContain("anchor_count_out_of_range");
  });

  it("rejects duplicated anchor entries inside one list", () => {
    const issues = validateNpcIdentityAnchors(
      untrusted({ ...ANCHORS, values: ["不欠人情", "不欠人情"] }),
    );
    expect(codesOf(issues)).toContain("duplicate_anchor_entry");
    expect(pathsOf(issues)).toContain("anchors.values[1]");
  });

  it("rejects blank or non-string anchor entries", () => {
    const blank = validateNpcIdentityAnchors(
      untrusted({ ...ANCHORS, capabilityBoundaries: ["不会武功", "   "] }),
    );
    expect(codesOf(blank)).toContain("invalid_field_value");
    expect(pathsOf(blank)).toContain("anchors.capabilityBoundaries[1]");

    const notAString = validateNpcIdentityAnchors(
      untrusted({ ...ANCHORS, taboos: [7] }),
    );
    expect(codesOf(notAString)).toContain("invalid_field_value");
  });

  it("rejects a blank self concept or speech style", () => {
    const issues = validateNpcIdentityAnchors(untrusted({ ...ANCHORS, selfConcept: "" }));
    expect(codesOf(issues)).toContain("invalid_field_value");
    expect(pathsOf(issues)).toContain("anchors.selfConcept");
    expect(
      pathsOf(validateNpcIdentityAnchors(untrusted({ ...ANCHORS, speechStyle: 12 }))),
    ).toContain("anchors.speechStyle");
  });

  it("rejects a non-object, a missing field and any extra field", () => {
    expect(codesOf(validateNpcIdentityAnchors(null))).toContain("invalid_component_shape");
    const missing = tampered(ANCHORS, (draft) => {
      delete draft.taboos;
    });
    expect(codesOf(validateNpcIdentityAnchors(missing))).toContain("invalid_component_shape");
    const extra = untrusted({ ...ANCHORS, hiddenMotive: "复仇" });
    const issues = validateNpcIdentityAnchors(extra);
    expect(codesOf(issues)).toContain("invalid_component_shape");
    expect(pathsOf(issues)).toContain("anchors");
    expect(JSON.stringify(issues)).not.toContain("复仇");
  });
});

// ---------------------------------------------------------------------------
// validateNpcDynamicState
// ---------------------------------------------------------------------------

describe("validateNpcDynamicState", () => {
  it("accepts met/companion flags with a closed emotion and typed goals", () => {
    expect(validateNpcDynamicState(untrusted(DYNAMIC_STATE))).toEqual([]);
    expect(validateNpcDynamicState(untrusted({ ...DYNAMIC_STATE, goals: [] }))).toEqual([]);
  });

  it("rejects non-boolean flags", () => {
    const issues = validateNpcDynamicState(untrusted({ ...DYNAMIC_STATE, isCompanion: "yes" }));
    expect(codesOf(issues)).toContain("invalid_field_value");
    expect(pathsOf(issues)).toContain("dynamicState.isCompanion");
    expect(pathsOf(validateNpcDynamicState(untrusted({ ...DYNAMIC_STATE, met: 1 }))))
      .toContain("dynamicState.met");
  });

  it("rejects an emotion outside the narrative emotion set", () => {
    const issues = validateNpcDynamicState(untrusted({ ...DYNAMIC_STATE, emotion: "enraged" }));
    expect(codesOf(issues)).toContain("value_out_of_closed_set");
    expect(pathsOf(issues)).toContain("dynamicState.emotion");
  });

  it("rejects a goal missing a declared field or carrying a foreign one", () => {
    const missing = tampered(DYNAMIC_STATE, (draft) => {
      delete draftList(draft, "goals")[0].reason;
    });
    expect(codesOf(validateNpcDynamicState(missing))).toContain("invalid_component_shape");
    expect(pathsOf(validateNpcDynamicState(missing))).toContain("dynamicState.goals[0]");

    const foreign = tampered(DYNAMIC_STATE, (draft) => {
      draftList(draft, "goals")[0].secretPlan = "burn the guild";
    });
    const issues = validateNpcDynamicState(foreign);
    expect(codesOf(issues)).toContain("invalid_component_shape");
    expect(JSON.stringify(issues)).not.toContain("burn the guild");
  });

  it("rejects a goal priority outside the closed 1..5 ladder", () => {
    for (const priority of [0, 6, 2.5, "3"]) {
      const draft = tampered(DYNAMIC_STATE, (d) => {
        draftList(d, "goals")[0].priority = priority;
      });
      const issues = validateNpcDynamicState(draft);
      expect(codesOf(issues)).toContain("value_out_of_closed_set");
      expect(pathsOf(issues)).toContain("dynamicState.goals[0].priority");
    }
  });

  it("rejects a goal horizon or status outside the closed sets", () => {
    const horizon = tampered(DYNAMIC_STATE, (d) => {
      draftList(d, "goals")[0].horizon = "mid";
    });
    expect(codesOf(validateNpcDynamicState(horizon))).toContain("value_out_of_closed_set");
    const status = tampered(DYNAMIC_STATE, (d) => {
      draftList(d, "goals")[0].status = "paused";
    });
    const issues = validateNpcDynamicState(status);
    expect(codesOf(issues)).toContain("value_out_of_closed_set");
    expect(pathsOf(issues)).toContain("dynamicState.goals[0].status");
  });

  it("rejects a blank goal id, description or reason", () => {
    const draft = tampered(DYNAMIC_STATE, (d) => {
      const first = draftList(d, "goals")[0];
      first.goalId = "";
      first.description = " ";
      first.reason = "";
    });
    const issues = validateNpcDynamicState(draft);
    expect(codesOf(issues)).toContain("invalid_field_value");
    expect(pathsOf(issues)).toContain("dynamicState.goals[0].goalId");
    expect(pathsOf(issues)).toContain("dynamicState.goals[0].description");
    expect(pathsOf(issues)).toContain("dynamicState.goals[0].reason");
  });

  it("rejects two goals minted with the same goalId", () => {
    const issues = validateNpcDynamicState(untrusted({ ...DYNAMIC_STATE, goals: [goal(), goal()] }));
    expect(codesOf(issues)).toContain("duplicate_goal_id");
    expect(pathsOf(issues)).toContain("dynamicState.goals[1].goalId");
  });

  it("rejects goals that is not an array", () => {
    expect(codesOf(validateNpcDynamicState(untrusted({ ...DYNAMIC_STATE, goals: { a: 1 } }))))
      .toContain("invalid_field_value");
  });
});

// ---------------------------------------------------------------------------
// validateNpcKnowledge
// ---------------------------------------------------------------------------

describe("validateNpcKnowledge", () => {
  it("accepts initial-world and action provenance entries", () => {
    expect(validateNpcKnowledge(untrusted(KNOWLEDGE))).toEqual([]);
    expect(
      validateNpcKnowledge(untrusted({
        entries: [{ ...LEARNED_ENTRY, source: { ...LEARNED_ENTRY.source, sourceNpcId: undefined } }],
      })),
    ).toEqual([]);
  });

  it("treats an explicitly undefined optional provenance field as absent", () => {
    const inMemory: NpcKnowledgeComponent = {
      entries: [{
        ...LEARNED_ENTRY,
        source: { kind: "action", mode: "npc_revealed", actionId: "act_5", learnedAtTurn: 6, sourceNpcId: undefined },
      }],
    };
    expect(validateNpcKnowledge(inMemory)).toEqual([]);
  });

  it("rejects an entry without its source", () => {
    const draft = tampered(KNOWLEDGE, (d) => {
      delete draftList(d, "entries")[0].source;
    });
    const issues = validateNpcKnowledge(draft);
    expect(codesOf(issues)).toContain("invalid_component_shape");
    expect(pathsOf(issues)).toContain("knowledge.entries[0]");
  });

  it("rejects an unknown source kind and a source that mixes both variants", () => {
    const unknownKind = tampered(KNOWLEDGE, (d) => {
      draftObject(listAt(d, "entries", 0), "source").kind = "rumor";
    });
    const issues = validateNpcKnowledge(unknownKind);
    expect(codesOf(issues)).toContain("value_out_of_closed_set");
    expect(pathsOf(issues)).toContain("knowledge.entries[0].source.kind");

    const mixed = tampered(KNOWLEDGE, (d) => {
      draftObject(listAt(d, "entries", 0), "source").actionId = "act_9";
    });
    expect(codesOf(validateNpcKnowledge(mixed))).toContain("invalid_component_shape");
  });

  it("requires action provenance to carry a closed mode and a stable actionId", () => {
    const draft = tampered({ entries: [LEARNED_ENTRY] }, (d) => {
      const source = draftList(d, "entries")[0].source as Draft;
      source.mode = "auto_diffusion";
      source.actionId = "";
    });
    const issues = validateNpcKnowledge(draft);
    expect(codesOf(issues)).toContain("value_out_of_closed_set");
    expect(codesOf(issues)).toContain("invalid_field_value");
    expect(pathsOf(issues)).toContain("knowledge.entries[0].source.actionId");
  });

  it("rejects a non-string sourceNpcId on an action entry", () => {
    const draft = tampered({ entries: [LEARNED_ENTRY] }, (d) => {
      (draftList(d, "entries")[0].source as Draft).sourceNpcId = 42;
    });
    expect(pathsOf(validateNpcKnowledge(draft))).toContain("knowledge.entries[0].source.sourceNpcId");
  });

  it("keeps at most one entry per fact id", () => {
    const duplicate = [KNOWN_ENTRY, { ...KNOWN_ENTRY, certainty: "suspected" } as const];
    const issues = validateNpcKnowledge(untrusted({ entries: duplicate }));
    expect(codesOf(issues)).toContain("duplicate_fact_id");
    expect(pathsOf(issues)).toContain("knowledge.entries[1].factId");
  });

  it("rejects certainty and disclosure outside the closed sets", () => {
    for (const [field, bad] of [["certainty", "certain"], ["disclosure", "private"]] as const) {
      const draft = tampered(KNOWLEDGE, (d) => {
        draftList(d, "entries")[0][field] = bad;
      });
      const issues = validateNpcKnowledge(draft);
      expect(codesOf(issues)).toContain("value_out_of_closed_set");
      expect(pathsOf(issues)).toContain(`knowledge.entries[0].${field}`);
    }
  });

  it("rejects a blank fact reference and a negative or fractional learnedAtTurn", () => {
    const blank = tampered(KNOWLEDGE, (d) => {
      draftList(d, "entries")[0].factId = "  ";
    });
    const blankIssues = validateNpcKnowledge(blank);
    expect(codesOf(blankIssues)).toContain("invalid_field_value");
    expect(pathsOf(blankIssues)).toContain("knowledge.entries[0].factId");

    for (const learnedAtTurn of [-1, 2.5, "3"]) {
      const draft = tampered(KNOWLEDGE, (d) => {
        (draftList(d, "entries")[0].source as Draft).learnedAtTurn = learnedAtTurn;
      });
      const issues = validateNpcKnowledge(draft);
      expect(codesOf(issues)).toContain("number_out_of_range");
      expect(pathsOf(issues)).toContain("knowledge.entries[0].source.learnedAtTurn");
    }
  });

  it("rejects a non-object component, a foreign entry key and a missing entries array", () => {
    expect(codesOf(validateNpcKnowledge([]))).toContain("invalid_component_shape");
    expect(codesOf(validateNpcKnowledge(untrusted({ entries: 3 })))).toContain("invalid_field_value");
    const foreign = tampered(KNOWLEDGE, (d) => {
      draftList(d, "entries")[0].text = "国王深夜会见使者";
    });
    const issues = validateNpcKnowledge(foreign);
    expect(codesOf(issues)).toContain("invalid_component_shape");
    expect(JSON.stringify(issues)).not.toContain("国王深夜会见使者");
  });
});

// ---------------------------------------------------------------------------
// validateNpcRelationships
// ---------------------------------------------------------------------------

describe("validateNpcRelationships", () => {
  it("accepts stable-ordered outgoing edges to the player and to another npc", () => {
    expect(validateNpcRelationships(untrusted(RELATIONSHIPS))).toEqual([]);
    expect(validateNpcRelationships(untrusted({ outgoing: [] }))).toEqual([]);
  });

  it("orders edges by the exported comparator so projection and validator agree", () => {
    const shuffled = [edge(), edge({ targetId: asNpcId("npc_9") }), edge({ targetId: asNpcId("npc_1") })];
    const sorted = [...shuffled].sort((a, b) => compareRelationshipTargetIds(a.targetId, b.targetId));
    expect(sorted.map((item) => item.targetId)).toEqual([
      asNpcId("npc_1"), asNpcId("npc_9"), PLAYER_ENTITY_ID,
    ]);
    expect(validateNpcRelationships(untrusted({ outgoing: sorted }))).toEqual([]);
    expect(codesOf(validateNpcRelationships(untrusted({ outgoing: shuffled }))))
      .toContain("relationship_targets_unsorted");
  });

  it("requires every target id to appear once", () => {
    const draft = tampered(RELATIONSHIPS, (d) => {
      const outgoing = draftList(d, "outgoing");
      d.outgoing = [outgoing[0], { ...outgoing[0] }];
    });
    const issues = validateNpcRelationships(draft);
    expect(codesOf(issues)).toContain("duplicate_relationship_target");
    expect(pathsOf(issues)).toContain("relationships.outgoing[1].targetId");
  });

  it("rejects a blank or missing target reference", () => {
    const draft = tampered(RELATIONSHIPS, (d) => {
      draftList(d, "outgoing")[0].targetId = "";
    });
    const issues = validateNpcRelationships(draft);
    expect(codesOf(issues)).toContain("invalid_field_value");
    expect(pathsOf(issues)).toContain("relationships.outgoing[0].targetId");
  });

  it("clamps the four dimensions to the closed -100..100 range", () => {
    for (const dimension of RELATIONSHIP_DIMENSION_KEYS) {
      const draft = tampered(RELATIONSHIPS, (d) => {
        const dims = draftObject(edgeAt(d, 0), "dimensions");
        dims[dimension] = RELATIONSHIP_DIMENSION_MAX + 1;
      });
      const issues = validateNpcRelationships(draft);
      expect(codesOf(issues)).toContain("number_out_of_range");
      expect(pathsOf(issues)).toContain(`relationships.outgoing[0].dimensions.${dimension}`);

      const below = tampered(RELATIONSHIPS, (d) => {
        const dims = draftObject(edgeAt(d, 0), "dimensions");
        dims[dimension] = RELATIONSHIP_DIMENSION_MIN - 1;
      });
      expect(codesOf(validateNpcRelationships(below))).toContain("number_out_of_range");
    }
    const boundary = tampered(RELATIONSHIPS, (d) => {
      const dims = draftObject(edgeAt(d, 0), "dimensions");
      dims.affinity = RELATIONSHIP_DIMENSION_MAX;
      dims.trust = RELATIONSHIP_DIMENSION_MIN;
      dims.fear = 0;
      dims.hostility = 0;
    });
    expect(validateNpcRelationships(boundary)).toEqual([]);
  });

  it("rejects a missing or foreign dimension key", () => {
    const missing = tampered(RELATIONSHIPS, (d) => {
      delete draftObject(edgeAt(d, 0), "dimensions").fear;
    });
    const missingIssues = validateNpcRelationships(missing);
    expect(codesOf(missingIssues)).toContain("invalid_component_shape");
    expect(pathsOf(missingIssues)).toContain("relationships.outgoing[0].dimensions");

    const foreign = tampered(RELATIONSHIPS, (d) => {
      draftObject(edgeAt(d, 0), "dimensions").greed = 40;
    });
    expect(codesOf(validateNpcRelationships(foreign))).toContain("invalid_component_shape");
  });

  it("rejects a non-finite dimension number", () => {
    const draft = tampered(RELATIONSHIPS, (d) => {
      draftObject(edgeAt(d, 0), "dimensions").trust = "high";
    });
    expect(codesOf(validateNpcRelationships(draft))).toContain("invalid_field_value");
  });

  it("rejects a stage or trend outside the closed sets without deciding transitions", () => {
    const stage = tampered(RELATIONSHIPS, (d) => {
      draftList(d, "outgoing")[0].stage = "soulmate";
    });
    const stageIssues = validateNpcRelationships(stage);
    expect(codesOf(stageIssues)).toContain("value_out_of_closed_set");
    expect(pathsOf(stageIssues)).toContain("relationships.outgoing[0].stage");

    const trend = tampered(RELATIONSHIPS, (d) => {
      draftList(d, "outgoing")[0].trend = "volatile";
    });
    expect(codesOf(validateNpcRelationships(trend))).toContain("value_out_of_closed_set");
    // 每一档 stage 都是合法成员：转换图属于 Task 3，本 validator 不做迁移裁决。
    for (const stageName of RELATIONSHIP_STAGES) {
      const draft = tampered(RELATIONSHIPS, (d) => {
        draftList(d, "outgoing")[0].stage = stageName;
      });
      expect(validateNpcRelationships(draft)).toEqual([]);
    }
  });

  it("keeps evidence within the shared cap of twelve entries", () => {
    const atCap = Array.from({ length: RELATIONSHIP_EVIDENCE_CAP }, (_unused, index) =>
      evidenceAt(index));
    expect(validateNpcRelationships(untrusted({
      outgoing: [edge({ evidence: atCap })],
    }))).toEqual([]);

    const overCap = Array.from({ length: RELATIONSHIP_EVIDENCE_CAP + 1 }, (_unused, index) =>
      evidenceAt(index));
    const issues = validateNpcRelationships(untrusted({ outgoing: [edge({ evidence: overCap })] }));
    expect(codesOf(issues)).toContain("relationship_evidence_cap_exceeded");
    expect(pathsOf(issues)).toContain("relationships.outgoing[0].evidence");
  });

  it("requires one evidence id per entry", () => {
    const draft = tampered(RELATIONSHIPS, (d) => {
      const evidence = draftList(edgeAt(d, 0), "evidence");
      d.outgoing = [{ ...edgeAt(d, 0), evidence: [evidence[0], { ...evidence[0] }] }];
    });
    const issues = validateNpcRelationships(draft);
    expect(codesOf(issues)).toContain("duplicate_evidence_id");
    expect(pathsOf(issues)).toContain("relationships.outgoing[0].evidence[1].evidenceId");
  });

  it("requires evidence to name its action, a closed signal and a rule summary key", () => {
    const noAction = tampered(RELATIONSHIPS, (d) => {
      delete draftList(edgeAt(d, 0), "evidence")[0].actionId;
    });
    expect(codesOf(validateNpcRelationships(noAction))).toContain("invalid_component_shape");

    const signal = tampered(RELATIONSHIPS, (d) => {
      draftList(edgeAt(d, 0), "evidence")[0].signal = "flattered";
    });
    const signalIssues = validateNpcRelationships(signal);
    expect(codesOf(signalIssues)).toContain("value_out_of_closed_set");
    expect(pathsOf(signalIssues)).toContain("relationships.outgoing[0].evidence[0].signal");

    const severity = tampered(RELATIONSHIPS, (d) => {
      draftList(edgeAt(d, 0), "evidence")[0].severity = "catastrophic";
    });
    expect(codesOf(validateNpcRelationships(severity))).toContain("value_out_of_closed_set");

    const blankKey = tampered(RELATIONSHIPS, (d) => {
      draftList(edgeAt(d, 0), "evidence")[0].summaryKey = "";
    });
    expect(codesOf(validateNpcRelationships(blankKey))).toContain("invalid_field_value");
  });

  it("discriminates a debt commitment from a promise commitment", () => {
    const debtAsPromise = tampered(RELATIONSHIPS, (d) => {
      const first = draftList(edgeAt(d, 0), "commitments")[0];
      delete first.direction;
      first.promisor = "source";
    });
    expect(codesOf(validateNpcRelationships(debtAsPromise))).toContain("invalid_component_shape");

    const badDirection = tampered(RELATIONSHIPS, (d) => {
      draftList(edgeAt(d, 0), "commitments")[0].direction = "both";
    });
    const directionIssues = validateNpcRelationships(badDirection);
    expect(codesOf(directionIssues)).toContain("value_out_of_closed_set");
    expect(pathsOf(directionIssues)).toContain("relationships.outgoing[0].commitments[0].direction");

    const badPromisor = tampered(RELATIONSHIPS, (d) => {
      const first = draftList(edgeAt(d, 0), "commitments")[0];
      first.kind = "promise";
      delete first.direction;
      first.promisor = "player";
    });
    expect(codesOf(validateNpcRelationships(badPromisor))).toContain("value_out_of_closed_set");
  });

  it("keeps debt and promise status ladders separate", () => {
    const debtReleased = tampered(RELATIONSHIPS, (d) => {
      draftList(edgeAt(d, 0), "commitments")[0].status = "released";
    });
    const debtIssues = validateNpcRelationships(debtReleased);
    expect(codesOf(debtIssues)).toContain("value_out_of_closed_set");
    expect(pathsOf(debtIssues)).toContain("relationships.outgoing[0].commitments[0].status");

    const promiseForgiven = tampered(RELATIONSHIPS, (d) => {
      const commitments = draftList(edgeAt(d, 0), "commitments");
      d.outgoing = [{ ...edgeAt(d, 0), commitments: [{ ...PROMISE, status: "forgiven" }, commitments[0]] }];
    });
    expect(codesOf(validateNpcRelationships(promiseForgiven))).toContain("value_out_of_closed_set");

    for (const status of ["open", "fulfilled", "broken"]) {
      const draft = tampered(RELATIONSHIPS, (d) => {
        draftList(edgeAt(d, 0), "commitments")[0].status = status;
      });
      expect(validateNpcRelationships(draft)).toEqual([]);
    }
    const promiseLadder = tampered(RELATIONSHIPS, (d) => {
      const commitments = draftList(edgeAt(d, 0), "commitments");
      d.outgoing = [{
        ...edgeAt(d, 0),
        commitments: [{ ...PROMISE, status: "released" }, commitments[0]],
      }];
    });
    expect(validateNpcRelationships(promiseLadder)).toEqual([]);
  });

  it("requires one commitment id per edge and a source on every commitment", () => {
    const duplicate = tampered(RELATIONSHIPS, (d) => {
      const commitments = draftList(edgeAt(d, 0), "commitments");
      d.outgoing = [{ ...edgeAt(d, 0), commitments: [commitments[0], { ...commitments[0] }] }];
    });
    const issues = validateNpcRelationships(duplicate);
    expect(codesOf(issues)).toContain("duplicate_commitment_id");
    expect(pathsOf(issues)).toContain("relationships.outgoing[0].commitments[1].commitmentId");

    const noSource = tampered(RELATIONSHIPS, (d) => {
      delete draftList(edgeAt(d, 0), "commitments")[0].source;
    });
    expect(codesOf(validateNpcRelationships(noSource))).toContain("invalid_component_shape");
  });

  it("requires the edge origin to be one of the two relationship sources", () => {
    const noReason = tampered(RELATIONSHIPS, (d) => {
      delete (draftList(d, "outgoing")[0].origin as Draft).reasonKey;
    });
    const reasonIssues = validateNpcRelationships(noReason);
    expect(codesOf(reasonIssues)).toContain("invalid_component_shape");
    expect(pathsOf(reasonIssues)).toContain("relationships.outgoing[0].origin");

    const unknownKind = tampered(RELATIONSHIPS, (d) => {
      (draftList(d, "outgoing")[0].origin as Draft).kind = "ai_suggested";
    });
    const kindIssues = validateNpcRelationships(unknownKind);
    expect(codesOf(kindIssues)).toContain("value_out_of_closed_set");
    expect(pathsOf(kindIssues)).toContain("relationships.outgoing[0].origin.kind");

    const actionOrigin = tampered(RELATIONSHIPS, (d) => {
      draftList(d, "outgoing")[0].origin = { kind: "action", actionId: "act_1", turnNumber: 2 };
    });
    expect(validateNpcRelationships(actionOrigin)).toEqual([]);
  });

  it("rejects negative or fractional turn counters", () => {
    for (const bad of [-1, 1.5, "2"]) {
      const draft = tampered(RELATIONSHIPS, (d) => {
        draftList(d, "outgoing")[0].lastChangedAtTurn = bad;
      });
      const issues = validateNpcRelationships(draft);
      expect(codesOf(issues)).toContain("number_out_of_range");
      expect(pathsOf(issues)).toContain("relationships.outgoing[0].lastChangedAtTurn");
    }
  });

  it("rejects a non-object component, a foreign edge key and a missing outgoing list", () => {
    expect(codesOf(validateNpcRelationships("nope"))).toContain("invalid_component_shape");
    expect(codesOf(validateNpcRelationships(untrusted({ outgoing: {} }))))
      .toContain("invalid_field_value");
    const foreign = tampered(RELATIONSHIPS, (d) => {
      draftList(d, "outgoing")[0].rawDeltas = { affinity: 40 };
    });
    expect(codesOf(validateNpcRelationships(foreign))).toContain("invalid_component_shape");
  });

  it("reports one issue per offending edge instead of stopping at the first", () => {
    const draft = tampered(RELATIONSHIPS, (d) => {
      const outgoing = draftList(d, "outgoing");
      for (const item of outgoing) {
        item.stage = "sworn";
      }
    });
    const issues = validateNpcRelationships(draft);
    expect(issues).toHaveLength(2);
    expect(pathsOf(issues)).toEqual([
      "relationships.outgoing[0].stage",
      "relationships.outgoing[1].stage",
    ]);
  });
});

function evidenceAt(index: number): RelationshipEvidence {
  return {
    ...EVIDENCE,
    evidenceId: `act_${index}:player_0:supported`,
    actionId: `act_${index}`,
    turnNumber: index,
  };
}

// ---------------------------------------------------------------------------
// validateNpcHistory
// ---------------------------------------------------------------------------

describe("validateNpcHistory", () => {
  it("accepts interactions that keep the legacy dialogue shape", () => {
    expect(validateNpcHistory(untrusted(HISTORY))).toEqual([]);
    expect(validateNpcHistory(untrusted({ interactions: [] }))).toEqual([]);
    const withTopic = tampered(HISTORY, (d) => {
      draftList(d, "interactions")[0].topic = { kind: "fact", factId: asFactId("fact_1") };
    });
    expect(validateNpcHistory(withTopic)).toEqual([]);
  });

  it("treats an explicitly undefined optional topic as absent", () => {
    const inMemory: NpcHistoryComponent = { interactions: [{ ...interaction(), topic: undefined }] };
    expect(validateNpcHistory(inMemory)).toEqual([]);
  });

  it("keeps at most ten interactions", () => {
    const atCap = Array.from({ length: NPC_HISTORY_CAP }, (_unused, index) =>
      interaction(`act_${index}`, index));
    expect(validateNpcHistory(untrusted({ interactions: atCap }))).toEqual([]);
    const overCap = Array.from({ length: NPC_HISTORY_CAP + 1 }, (_unused, index) =>
      interaction(`act_${index}`, index));
    const issues = validateNpcHistory(untrusted({ interactions: overCap }));
    expect(codesOf(issues)).toContain("history_cap_exceeded");
    expect(pathsOf(issues)).toContain("history.interactions");
  });

  it("requires one interaction per action id", () => {
    const draft = tampered(HISTORY, (d) => {
      draftList(d, "interactions")[1].actionId = "act_1";
    });
    const issues = validateNpcHistory(draft);
    expect(codesOf(issues)).toContain("duplicate_history_action_id");
    expect(pathsOf(issues)).toContain("history.interactions[1].actionId");
  });

  it("rejects an interaction missing a declared field", () => {
    const draft = tampered(HISTORY, (d) => {
      delete draftList(d, "interactions")[0].summary;
    });
    const issues = validateNpcHistory(draft);
    expect(codesOf(issues)).toContain("invalid_component_shape");
    expect(pathsOf(issues)).toContain("history.interactions[0]");
  });

  it("rejects a dialogue act outside the eight closed acts plus freeform", () => {
    const draft = tampered(HISTORY, (d) => {
      draftList(d, "interactions")[0].dialogueAct = "seduce";
    });
    const issues = validateNpcHistory(draft);
    expect(codesOf(issues)).toContain("value_out_of_closed_set");
    expect(pathsOf(issues)).toContain("history.interactions[0].dialogueAct");
  });

  it("rejects an outcome outside the closed set", () => {
    expect(codesOf(validateNpcHistory(untrusted({
      interactions: [interaction("act_1", 1)].map((item) => ({ ...item, outcome: "catastrophic" })),
    })))).toContain("value_out_of_closed_set");
  });

  it("rejects a negative turn number and a non-numeric relationship delta", () => {
    const draft = tampered(HISTORY, (d) => {
      const first = draftList(d, "interactions")[0];
      first.turnNumber = -1;
      first.relationshipDelta = "up";
    });
    const issues = validateNpcHistory(draft);
    expect(codesOf(issues)).toContain("number_out_of_range");
    expect(codesOf(issues)).toContain("invalid_field_value");
    expect(pathsOf(issues)).toContain("history.interactions[0].turnNumber");
  });

  it("validates the optional structured topic against its own closed kinds", () => {
    const badKind = tampered(HISTORY, (d) => {
      draftList(d, "interactions")[0].topic = { kind: "ending", endingId: "ending_1" };
    });
    expect(codesOf(validateNpcHistory(badKind))).toContain("value_out_of_closed_set");
    const mixedTopic = tampered(HISTORY, (d) => {
      draftList(d, "interactions")[0].topic = { kind: "fact", factId: asFactId("fact_1"), questId: "quest_1" };
    });
    expect(codesOf(validateNpcHistory(mixedTopic))).toContain("invalid_component_shape");
    const general = tampered(HISTORY, (d) => {
      draftList(d, "interactions")[0].topic = { kind: "general" };
    });
    expect(validateNpcHistory(general)).toEqual([]);
  });

  it("rejects a non-array interactions list", () => {
    expect(codesOf(validateNpcHistory(untrusted({ interactions: "act_1" }))))
      .toContain("invalid_field_value");
  });
});

// ---------------------------------------------------------------------------
// 编译期锁定：以下结构必须永远不能赋给公开类型。
// 一旦类型退化（例如改成 Record<string, unknown>），下面每条未被使用的
// ts-expect-error 指令都会让 npm run typecheck 直接失败。
// ---------------------------------------------------------------------------

type DynamicComponentMap = Record<string, Record<string, unknown>>;
type BarePathPatch = Readonly<{ path: string; description: string; operation: "set"; value?: unknown }>;
type LooseNumberBag = Record<string, number>;

const dynamicComponents: DynamicComponentMap = { anchors: { selfConcept: "守夜人的女儿" }, mood: { x: 1 } };
const barePatch: BarePathPatch = {
  path: "knowledge.entries[0].certainty",
  description: "把传闻改成已知",
  operation: "set",
};
const looseNumbers: LooseNumberBag = { kindness: 40, cruelty: -3 };

describe("禁止结构在编译期不可赋值", () => {
  it("rejects a dynamic component map", () => {
    // 运行时事实：这类对象只有任意动态 key，没有任何声明字段。
    // @ts-expect-error 组件必须是固定命名形状，动态组件字典不可赋值
    const degradedAnchors: NpcIdentityAnchors = dynamicComponents;
    // @ts-expect-error 关系组件同样不接受动态 key 字典
    const degradedRelationships: NpcRelationshipComponent = dynamicComponents;
    expect(Object.keys(degradedAnchors).sort()).toEqual(["anchors", "mood"]);
    expect(Object.keys(degradedRelationships).sort()).toEqual(["anchors", "mood"]);
  });

  it("rejects a bare field-path patch object", () => {
    // @ts-expect-error 世界状态更新不使用裸 path patch 结构
    const patchAsKnowledge: NpcKnowledgeComponent = barePatch;
    // @ts-expect-error 裸 patch 也不能冒充动态状态组件
    const patchAsDynamicState: NpcDynamicStateComponent = barePatch;
    expect(Object.keys(patchAsKnowledge).sort()).toEqual(["description", "operation", "path"]);
    expect(Object.keys(patchAsDynamicState).sort()).toEqual(["description", "operation", "path"]);
  });

  it("rejects an arbitrary relationship number object", () => {
    // @ts-expect-error 关系维度不是任意数值字典
    const bagAsDimensions: RelationshipDimensions = looseNumbers;
    // @ts-expect-error 四维之外的数值（greed）不能进入关系维度
    const extraDimension: RelationshipDimensions = { affinity: 0, trust: 0, fear: 0, hostility: 0, greed: 50 };
    expect(Object.keys(bagAsDimensions).sort()).toEqual(["cruelty", "kindness"]);
    expect(Object.keys(extraDimension)).toHaveLength(5);
  });

  it("rejects knowledge and evidence without provenance", () => {
    // @ts-expect-error knowledge entry 必须携带 source 判别联合
    const sourcelessEntry: NpcKnowledgeEntry = { ...KNOWN_ENTRY, source: undefined };
    // @ts-expect-error 关系证据必须绑定产生它的 actionId
    const sourcelessEvidence: RelationshipEvidence = { ...EVIDENCE, actionId: undefined };
    // @ts-expect-error 关系边必须声明初始来源 origin
    const originlessEdge: DirectedRelationshipEdge = { ...edge(), origin: undefined };
    // @ts-expect-error commitment 必须携带 RelationshipSource
    const sourcelessCommitment: RelationshipCommitment = { ...DEBT, source: undefined };
    expect(sourcelessEntry).toBeDefined();
    expect(sourcelessEvidence).toBeDefined();
    expect(originlessEdge).toBeDefined();
    expect(sourcelessCommitment).toBeDefined();
  });

  it("rejects raw strings for branded ids and invented closed-set members", () => {
    // @ts-expect-error 未铸造的裸字符串不能作为 FactId
    const rawFact: NpcKnowledgeEntry = { ...KNOWN_ENTRY, factId: "fact_1" };
    // @ts-expect-error signal 是封闭 union，自造 signal 不合法
    const inventedSignal: RelationshipEvidence = { ...EVIDENCE, signal: "flattered" };
    // @ts-expect-error 知识来源只能是 initial_world 或 action
    const inventedKind: NpcKnowledgeSource = { kind: "rumor", learnedAtTurn: 0 };
    expect(rawFact).toBeDefined();
    expect(inventedSignal).toBeDefined();
    expect(inventedKind.kind).toBeDefined();
    expect(Object.keys(inventedKind)).toEqual(["kind", "learnedAtTurn"]);
  });
});

// ---------------------------------------------------------------------------
// 失败信息只含稳定 code/path
// ---------------------------------------------------------------------------

describe("validation issues 不携带组件正文", () => {
  it("reports only codes and paths for content-bearing failures", () => {
    const sensitive = " King: the private letter ";
    const knowledgeWithDuplicateFact: NpcKnowledgeComponent = {
      entries: [KNOWN_ENTRY, { ...KNOWN_ENTRY, certainty: "suspected" }],
    };
    const samples: readonly (readonly NpcComponentValidationIssue[])[] = [
      validateNpcIdentityAnchors(untrusted({ ...ANCHORS, values: [sensitive, sensitive] })),
      validateNpcDynamicState(untrusted({
        ...DYNAMIC_STATE,
        goals: [goal({ reason: sensitive }), goal({ reason: sensitive })],
      })),
      validateNpcKnowledge(untrusted(knowledgeWithDuplicateFact)),
      validateNpcRelationships(untrusted({ outgoing: [edge(), edge()] })),
      validateNpcHistory(untrusted({
        interactions: [interaction("act_dup", 1), { ...interaction("act_dup", 2), summary: sensitive }],
      })),
    ];
    for (const issues of samples) {
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(typeof issue.code).toBe("string");
        expect(typeof issue.path).toBe("string");
        expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
      }
      expect(JSON.stringify(issues)).not.toContain(sensitive.trim());
    }
    expect(firstIssue(samples[0]).code).toBe("duplicate_anchor_entry");
  });
});
