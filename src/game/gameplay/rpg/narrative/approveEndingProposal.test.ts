import { describe, expect, it } from "vitest";
import {
  asEndingId,
  asFactId,
  asLocationId,
  asNpcId,
  asQuestId,
  asSceneId,
  type EndingRequirement,
  type EndingTone,
  type GameState,
  type ProposedEnding,
  type QuestId,
  type ScenarioBlueprint,
} from "@/game/domain";
import { approveEndingProposal, type EndingApprovalDecision } from "./approveEndingProposal";

// ---------------------------------------------------------------------------
// approveEndingProposal 8 步闸门测试（Phase 14 Task 8）。
// 闸门顺序：none_proposed → invalid_payload → not_locked → already_proposed
//   → tone_mismatch → requirements_invalid → requirements_unsatisfiable → 通过。
// ---------------------------------------------------------------------------

const LOCKED_AT = 2;

function buildBlueprint(opts?: {
  readonly lockedAt?: number;
  readonly possibleTones?: readonly EndingTone[];
  readonly extraQuestIds?: readonly QuestId[];
}): ScenarioBlueprint {
  const mainQuests = [
    asQuestId("q_main_1"),
    asQuestId("q_main_2"),
    ...(opts?.extraQuestIds ?? []),
  ].map((id, index) => ({
    id,
    name: `主线${index + 1}`,
    description: `主线任务描述${index + 1}`,
    kind: "main" as const,
    stage: index + 1,
    objectives: [{ kind: "visit_location" as const, locationId: asLocationId("loc_1") }],
    onSuccess: { kind: "closed" as const },
    onFailure: { kind: "closed" as const },
    tags: [],
  }));
  return {
    schemaVersion: 2,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: {
      summary: "测试世界",
      tone: "沉稳",
      themes: ["正义"],
      facts: [{ id: asFactId("fact_1"), text: "事实", source: "player_input" }],
      tags: [],
    },
    player: {
      name: "Player",
      identity: "Hero",
      backgroundSummary: "背景",
      startingLocationId: asLocationId("loc_1"),
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 },
    },
    startAnchor: {
      locationId: asLocationId("loc_1"),
      npcId: asNpcId("npc_1"),
      startQuestId: asQuestId("q_main_1"),
    },
    endingDirection: {
      theme: "反元抉择",
      possibleTones: opts?.possibleTones ?? (["triumph", "bittersweet"] as const),
      lockedAt: opts?.lockedAt ?? LOCKED_AT,
    },
    locations: [
      {
        id: asLocationId("loc_1"),
        name: "地点1",
        description: "描述1",
        kind: "main",
        connectedLocationIds: [],
        npcIds: [],
        availableItemIds: [],
        tags: [],
      },
    ],
    npcs: [
      {
        id: asNpcId("npc_1"),
        name: "NPC1",
        role: "角色",
        description: "描述",
        locationId: asLocationId("loc_1"),
        isCompanion: false,
        knownFactIds: [],
        tags: [],
      },
    ],
    quests: mainQuests,
    enemies: [],
    items: [],
    endings: [],
    openingScene: {
      id: asSceneId("scene_opening"),
      locationId: asLocationId("loc_1"),
      narration: "开始",
      presentNpcIds: [],
      suggestedActions: [],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

function buildState(opts?: {
  readonly currentAct?: number;
  readonly endingProposed?: boolean;
  readonly questStatuses?: ReadonlyArray<{ readonly questId: QuestId; readonly status: string }>;
  readonly factDiscovered?: boolean;
}): GameState {
  const questStatuses = opts?.questStatuses ?? [
    { questId: asQuestId("q_main_1"), status: "completed" },
    { questId: asQuestId("q_main_2"), status: "completed" },
  ];
  return {
    stateVersion: 1,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia",
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_1"),
    unlockedLocationIds: [asLocationId("loc_1")],
    visitedLocationIds: [asLocationId("loc_1")],
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_1"), met: false }],
    quests: questStatuses.map((q) => ({
      questId: q.questId,
      status: q.status as GameState["quests"][number]["status"],
    })),
    inventory: [],
    worldFacts: [{ factId: asFactId("fact_1"), discovered: opts?.factDiscovered ?? true }],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null },
    prologueShown: true,
    mainStoryProgress: {
      currentAct: opts?.currentAct ?? LOCKED_AT,
      endingProposed: opts?.endingProposed ?? false,
    },
    eventLedger: [],
  } as unknown as GameState;
}

const VALID_PROPOSED_ENDING: ProposedEnding = {
  name: "归隐山林",
  description: "主角放下恩怨，遁入山林。",
  tone: "triumph",
  requirements: [{ kind: "quest_completed", questId: asQuestId("q_main_1") }],
  reason: "玩家在主线中选择了和平路线。",
};

describe("approveEndingProposal", () => {
  it("none_proposed: 未提议时拒绝", () => {
    const blueprint = buildBlueprint();
    const state = buildState();
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: undefined,
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("none_proposed");
  });

  it("invalid_payload: name 为空字符串时拒绝", () => {
    const blueprint = buildBlueprint();
    const state = buildState();
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: { ...VALID_PROPOSED_ENDING, name: "" },
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_payload");
  });

  it("invalid_payload: tone 非法枚举时拒绝", () => {
    const blueprint = buildBlueprint();
    const state = buildState();
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: { ...VALID_PROPOSED_ENDING, tone: "unknown" as EndingTone },
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_payload");
  });

  it("invalid_payload: requirements 非数组时拒绝", () => {
    const blueprint = buildBlueprint();
    const state = buildState();
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: { ...VALID_PROPOSED_ENDING, requirements: "not-an-array" as unknown as readonly EndingRequirement[] },
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_payload");
  });

  it("not_locked: 未达 lockedAt 阈值时拒绝", () => {
    const blueprint = buildBlueprint({ lockedAt: 5 });
    const state = buildState({ currentAct: 2 });
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: VALID_PROPOSED_ENDING,
      currentAct: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_locked");
  });

  it("already_proposed: 已提议过时拒绝", () => {
    const blueprint = buildBlueprint();
    const state = buildState({ endingProposed: true });
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: VALID_PROPOSED_ENDING,
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("already_proposed");
  });

  it("tone_mismatch: 基调不在 possibleTones 内时拒绝", () => {
    const blueprint = buildBlueprint({ possibleTones: ["triumph"] });
    const state = buildState();
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: { ...VALID_PROPOSED_ENDING, tone: "tragedy" },
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tone_mismatch");
  });

  it("requirements_invalid: requirements 引用的 questId 不存在时拒绝", () => {
    const blueprint = buildBlueprint();
    const state = buildState();
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: {
        ...VALID_PROPOSED_ENDING,
        requirements: [{ kind: "quest_completed", questId: asQuestId("q_not_exist") }],
      },
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("requirements_invalid");
  });

  it("requirements_unsatisfiable: 所有 requirements 引用的 quest 已 failed 时拒绝", () => {
    const blueprint = buildBlueprint();
    const state = buildState({
      questStatuses: [
        { questId: asQuestId("q_main_1"), status: "failed" },
        { questId: asQuestId("q_main_2"), status: "active" },
      ],
    });
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: {
        ...VALID_PROPOSED_ENDING,
        requirements: [{ kind: "quest_completed", questId: asQuestId("q_main_1") }],
      },
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("requirements_unsatisfiable");
  });

  it("审批通过时返回 approvedEnding（含生成的 id 与转换后的字段）", () => {
    const blueprint = buildBlueprint();
    const state = buildState();
    const result: EndingApprovalDecision = approveEndingProposal({
      blueprint,
      state,
      proposed: VALID_PROPOSED_ENDING,
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.approvedEnding.name).toBe(VALID_PROPOSED_ENDING.name);
      expect(result.approvedEnding.description).toBe(VALID_PROPOSED_ENDING.description);
      expect(result.approvedEnding.requirements).toEqual(VALID_PROPOSED_ENDING.requirements);
      // id 必须是 ending_dyn_<n> 形态
      expect(String(result.approvedEnding.id)).toMatch(/^ending_dyn_\d+$/);
      // 不携带 tone / reason（EndingDefinition 无此字段）
      expect("tone" in result.approvedEnding).toBe(false);
      expect("reason" in result.approvedEnding).toBe(false);
    }
  });

  it("审批通过的 id 随已有 endings 递增", () => {
    const blueprint = buildBlueprint();
    const blueprintWithExistingEnding = {
      ...blueprint,
      endings: [
        {
          id: asEndingId("ending_dyn_3"),
          name: "旧结局",
          description: "旧描述",
          requirements: [],
        },
      ],
    } as unknown as ScenarioBlueprint;
    const state = buildState();
    const result = approveEndingProposal({
      blueprint: blueprintWithExistingEnding,
      state,
      proposed: VALID_PROPOSED_ENDING,
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(String(result.approvedEnding.id)).toBe("ending_dyn_4");
    }
  });

  // Fix Round 1 回归：persisted state.mainStoryProgress.currentAct 在 performAction
  // 写回前可能滞后（如初始值 0）。旧实现读 persisted 值会使 not_locked 闸门恒为拒绝，
  // 结局审批在生产中永不通过。新签名改用调用方派生传入的 currentAct——此处 persisted=0
  // 但派生 currentAct=2 >= lockedAt=2，应通过 not_locked 并最终批准。
  it("not_locked 闸门使用传入的派生 currentAct 而非 persisted 值——stale persisted 不影响判定", () => {
    const blueprint = buildBlueprint();
    const state = buildState({ currentAct: 0 });
    const result = approveEndingProposal({
      blueprint,
      state,
      proposed: VALID_PROPOSED_ENDING,
      currentAct: LOCKED_AT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      // 明确断言：不应是 not_locked（证明未读 stale persisted currentAct=0）
      expect(result.reason).not.toBe("not_locked");
    }
  });
});
