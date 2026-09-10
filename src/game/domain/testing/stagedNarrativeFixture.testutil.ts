// 分阶段剧情生成的共享 fixture（仅测试使用，不从生产导入）。
//
// makeStagedPlan 只提供结构素材：两个在场 NPC、两个可达地点、一处二选一决策，
// 两条候选分别指向不同地点。它不含最终展示文本，避免 fixture 冒充获批产物。

import type { BranchOption } from "../narrativeBranch";
import type { PlanProposal } from "../narrativePlan";
import type { TextPart, Unit, UnitOutput } from "../narrativeUnit";
import type { CommittedNarrativeEvent } from "../events";
import { asNarrativeJobId, asTurnId, episodeIdForTurn, eventIdFor } from "../events";
import type { GenerationMetadata } from "../worldEntity";
import { asGenerationId, asLocationId, asNpcId, asQuestId, PLAYER_ENTITY_ID } from "../worldEntity";
import { createPendingNarrativeJob } from "../pendingNarrativeJob";
import { createInitialStoryState, type StoryState } from "../storyState";
import type { WorldState } from "../worldState";
import { createFixtureNarrativeRuntimeState } from "../narrativeTestFixture.testutil";
import { createWorldStateFixtureWith } from "./worldStateFixture.testutil";
import type { GameRecord } from "@/game/application/server/persistence/gameRepository";
import { asGameId } from "@/game/application/server/persistence/gameRepository";

export const FIXTURE_NPC_A = "npc_0";
export const FIXTURE_NPC_B = "npc_1";
export const FIXTURE_HOME_LOCATION = "loc_0";
export const FIXTURE_ROUTE_LOCATION = "loc_1";
export const FIXTURE_ALT_LOCATION = "loc_2";

export const FIXTURE_NARRATION_UNIT = "narration_current";
export const FIXTURE_NPC_A_UNIT = "character_npc_0";
export const FIXTURE_NPC_B_UNIT = "character_npc_1";
export const FIXTURE_CHOICE_UNIT = "choices_current";

export const FIXTURE_CANDIDATE_ROUTE = "cand_route";
export const FIXTURE_CANDIDATE_ALT = "cand_alt";

function intent(text: string): TextPart {
  return { text, facts: [], evidence: [], beatIds: [] };
}

function branchOption(candidateId: string, locationId: string): BranchOption {
  return {
    candidateId,
    dialogueAct: "offer",
    topic: { kind: "general" },
    target: { kind: "visit_location", locationId },
    publicIntent: intent(`我想去${locationId}看看。`),
    deferredLocation: null,
  };
}

function unit(overrides: Partial<Unit> & Pick<Unit, "key" | "stage">): Unit {
  return {
    point: { stepKey: "current", order: 1 },
    speakerId: null,
    dependencies: [],
    taskFactIds: [],
    requiredObservationKeys: [],
    requiredBeats: [],
    ...overrides,
  };
}

/** 结构骨架：规划素材，不含最终旁白/台词/选项 label。 */
export function makeStagedPlan(): PlanProposal {
  return {
    opening: null,
    worldDelta: null,
    steps: [],
    units: [
      unit({ key: FIXTURE_NARRATION_UNIT, stage: "narration", point: { stepKey: "current", order: 1 } }),
      unit({
        key: FIXTURE_NPC_A_UNIT,
        stage: "character",
        point: { stepKey: "current", order: 2 },
        speakerId: FIXTURE_NPC_A,
      }),
      unit({
        key: FIXTURE_NPC_B_UNIT,
        stage: "character",
        point: { stepKey: "current", order: 3 },
        speakerId: FIXTURE_NPC_B,
      }),
      unit({
        key: FIXTURE_CHOICE_UNIT,
        stage: "choices",
        point: { stepKey: "current", order: 4 },
        dependencies: [FIXTURE_NARRATION_UNIT, FIXTURE_NPC_A_UNIT, FIXTURE_NPC_B_UNIT],
      }),
    ],
    observations: [],
    actions: [],
    decision: {
      kind: "ordinary",
      point: { stepKey: "current", order: 4 },
      npcId: FIXTURE_NPC_A,
      options: [
        branchOption(FIXTURE_CANDIDATE_ROUTE, FIXTURE_ROUTE_LOCATION),
        branchOption(FIXTURE_CANDIDATE_ALT, FIXTURE_ALT_LOCATION),
      ],
    },
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
}

/** 有效角色表现输出；测试可局部替换字段制造非法输入。 */
export function makeCharacterOutput(speakerId = FIXTURE_NPC_A): Extract<UnitOutput, { stage: "character" }> {
  return {
    stage: "character",
    speakerId,
    parts: [{ text: "先坐吧，路上不好走。", facts: [], evidence: [], beatIds: [] }],
    emotion: "neutral",
    actions: [],
    answeredBeatIds: [],
  };
}

/** 有效选项表达输出：两条纯对白 label。 */
export function makeChoiceOutput(): Extract<UnitOutput, { stage: "choices" }> {
  return {
    stage: "choices",
    labels: [
      { candidateId: FIXTURE_CANDIDATE_ROUTE, label: "我跟你去北岭看看。" },
      { candidateId: FIXTURE_CANDIDATE_ALT, label: "我不替你送信，我要当面问清楚。" },
    ],
  };
}

/** 有效旁白输出；测试可局部替换 parts。 */
export function makeNarrationOutput(): Extract<UnitOutput, { stage: "narration" }> {
  return {
    stage: "narration",
    parts: [{ text: "风从门缝里挤进来，烛火偏了一下。", facts: [], evidence: [], beatIds: [] }],
    actionKeys: [],
  };
}

// ---------------------------------------------------------------------------
// 决策（decision）fixture：带对话任务的权威世界 + provider_pending 记录。
//
// 与 opening fixture 的区别在于「世界必须能承载一次决策」：需要一个可对话的
// NPC、一条以 talk_to_npc 为目标的进行中任务，以及与该 NPC 相关的已提交事件
// （审批事件铸造要求 domainEventIds 指向账本中真实存在的因果事件）。
// decision 的两个候选必须与描述符图 current_scene_choice_1/2 对齐。
// ---------------------------------------------------------------------------

export const FIXTURE_DECISION_NPC = "npc_dyn_1";
export const FIXTURE_DECISION_QUEST = "quest_1";
export const FIXTURE_DECISION_LOC_TOWN = "loc_town";
export const FIXTURE_DECISION_LOC_SCENE = "loc_dyn_1";

export const FIXTURE_DECISION_CANDIDATE_A = "current_scene_choice_1";
export const FIXTURE_DECISION_CANDIDATE_B = "current_scene_choice_2";

function decisionBranchOption(
  candidateId: string,
  dialogueAct: BranchOption["dialogueAct"],
): BranchOption {
  return {
    candidateId,
    dialogueAct,
    topic: { kind: "general" },
    target: { kind: "talk_to_npc", npcId: FIXTURE_DECISION_NPC },
    publicIntent: intent(dialogueAct === "support" ? "我先顺着他说。" : "我直接问他。"),
    deferredLocation: null,
  };
}

/** 与描述符图 current_scene_choice_1/2 对齐的决策计划（骨架，无展示文本）。 */
export function makeDecisionPlan(): PlanProposal {
  return {
    opening: null,
    worldDelta: null,
    steps: [],
    units: [
      unit({ key: FIXTURE_NARRATION_UNIT, stage: "narration", point: { stepKey: "current", order: 1 } }),
      unit({
        key: FIXTURE_NPC_A_UNIT,
        stage: "character",
        point: { stepKey: "current", order: 2 },
        speakerId: FIXTURE_DECISION_NPC,
      }),
      unit({
        key: FIXTURE_CHOICE_UNIT,
        stage: "choices",
        point: { stepKey: "current", order: 3 },
        dependencies: [FIXTURE_NARRATION_UNIT, FIXTURE_NPC_A_UNIT],
      }),
    ],
    observations: [],
    actions: [],
    decision: {
      kind: "ordinary",
      point: { stepKey: "current", order: 3 },
      npcId: FIXTURE_DECISION_NPC,
      options: [
        decisionBranchOption(FIXTURE_DECISION_CANDIDATE_A, "support"),
        decisionBranchOption(FIXTURE_DECISION_CANDIDATE_B, "challenge"),
      ],
    },
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
}

/** 决策候选的纯对白 label；candidateId 与 makeDecisionPlan 对齐。 */
export function makeDecisionChoiceOutput(): UnitOutput {
  return {
    stage: "choices",
    labels: [
      { candidateId: FIXTURE_DECISION_CANDIDATE_A, label: "我先顺着他说。" },
      { candidateId: FIXTURE_DECISION_CANDIDATE_B, label: "我不替你送信，我要当面问清楚。" },
    ],
  };
}

// ---------------------------------------------------------------------------
// 开局（opening）计划 fixture：结构与实体 ID 由 compileOpeningStructure 铸造，
// 这里只提供规划素材。decision 的两个候选必须与 situation.responses 的 key 对齐
// （ask_lead / challenge_lead），否则安装时 resolveOpeningResponses 会对不上。
// ---------------------------------------------------------------------------

export const FIXTURE_OPENING_NARRATION_UNIT = "narration_current";
export const FIXTURE_OPENING_CHARACTER_UNIT = "character_npc_0";
export const FIXTURE_OPENING_CHOICE_UNIT = "choices_current";

function openingBranchOption(candidateId: string, label: string): BranchOption {
  return {
    candidateId,
    dialogueAct: "ask",
    topic: { kind: "general" },
    // 开局候选的真实 action 由 resolveOpeningResponses 从 situation.responses 铸造；
    // 这里的 target 只是结构占位，必须与开局 NPC 对上。
    target: { kind: "talk_to_npc", npcId: FIXTURE_NPC_A },
    publicIntent: intent(label),
    deferredLocation: null,
  };
}

/** 开局表达输出：两条纯对白 label，candidateId 与 situation.responses 对齐。 */
export function makeOpeningChoiceOutput(): UnitOutput {
  return {
    stage: "choices",
    labels: [
      { candidateId: "ask_lead", label: "把你知道的线索先告诉我。" },
      { candidateId: "challenge_lead", label: "你先说清楚你自己跟这事有什么关系。" },
    ],
  };
}

/**
 * 用给定 candidate 构造 opening 计划：一个旁白、一个角色、一个选项单元。
 * candidate 由调用方从 fixture 世界生成源取得，保证与 situation 自洽。
 */
export function makeOpeningStagedPlan(
  opening: NonNullable<PlanProposal["opening"]>,
): PlanProposal {
  return {
    opening,
    worldDelta: null,
    steps: [],
    units: [
      unit({ key: FIXTURE_OPENING_NARRATION_UNIT, stage: "narration", point: { stepKey: "current", order: 1 } }),
      unit({
        key: FIXTURE_OPENING_CHARACTER_UNIT,
        stage: "character",
        point: { stepKey: "current", order: 2 },
        speakerId: FIXTURE_NPC_A,
      }),
      unit({
        key: FIXTURE_OPENING_CHOICE_UNIT,
        stage: "choices",
        point: { stepKey: "current", order: 3 },
        dependencies: [FIXTURE_OPENING_NARRATION_UNIT, FIXTURE_OPENING_CHARACTER_UNIT],
      }),
    ],
    observations: [],
    actions: [],
    decision: {
      kind: "ordinary",
      point: { stepKey: "current", order: 3 },
      npcId: FIXTURE_NPC_A,
      options: [
        openingBranchOption("ask_lead", "把你知道的线索先告诉我。"),
        openingBranchOption("challenge_lead", "你先说清楚你自己跟这事有什么关系。"),
      ],
    },
    terminal: { kind: "next_decision", target: { kind: "current_scene" } },
  };
}

// ---------------------------------------------------------------------------
// 决策世界与 provider_pending 记录：供 decisionJob / generatePendingNarrativeBundle
// 两类测试共用同一套权威输入，避免夹具在两个测试文件里各自漂移。
// ---------------------------------------------------------------------------

const DECISION_GENERATION: GenerationMetadata = {
  generationId: asGenerationId("gen_decision_fixture"),
  seed: "decision-seed",
  templateVersion: "v2",
  inputDigest: "",
  gameType: "wuxia",
};

/** 带一条 talk_to_npc 任务的权威世界：含 game_initialized + npc_met 两条真实事件。 */
export function createDecisionWorldFixture(): WorldState {
  const npcId = asNpcId(FIXTURE_DECISION_NPC);
  const questId = asQuestId(FIXTURE_DECISION_QUEST);
  const townId = asLocationId(FIXTURE_DECISION_LOC_TOWN);
  const sceneId = asLocationId(FIXTURE_DECISION_LOC_SCENE);

  const ledger: readonly CommittedNarrativeEvent[] = [{
    eventId: eventIdFor(asTurnId("init:fixture"), "game_initialized"),
    sequence: 0,
    turnId: asTurnId("init:fixture"),
    turnNumber: 0,
    episodeId: episodeIdForTurn(asTurnId("init:fixture")),
    kind: "game_initialized",
    actorIds: [PLAYER_ENTITY_ID],
    targetIds: [PLAYER_ENTITY_ID],
    locationId: null,
    causeEventIds: [],
    factIds: [],
    questIds: [],
    outcome: "neutral",
    salience: 50,
    committedAt: "2026-01-01T00:00:00Z",
    payload: { type: "game_initialized", generation: DECISION_GENERATION },
  }, {
    eventId: eventIdFor(asTurnId("turn-1"), "npc_met"),
    sequence: 1,
    turnId: asTurnId("turn-1"),
    turnNumber: 1,
    episodeId: episodeIdForTurn(asTurnId("turn-1")),
    kind: "npc_met",
    actorIds: [PLAYER_ENTITY_ID],
    targetIds: [npcId],
    locationId: sceneId,
    causeEventIds: [],
    factIds: [],
    questIds: [],
    outcome: "neutral",
    salience: 40,
    committedAt: "2026-09-09T08:00:00.000Z",
    payload: { type: "npc_met", npcId, interactionKind: "greet" },
  }];

  return createWorldStateFixtureWith(
    {
      generation: DECISION_GENERATION,
      base: {
        player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
        locations: [
          { id: townId, name: "小镇", description: "山脚下的小镇。", kind: "main", connectedLocationIds: [sceneId], npcIds: [], availableItemIds: [], tags: [], scale: "town" },
          { id: sceneId, name: "破庙", description: "一座破败的庙宇。", kind: "main", connectedLocationIds: [townId], npcIds: [npcId], availableItemIds: [], tags: [], scale: "scene" },
        ],
        currentLocationId: sceneId,
        unlockedLocationIds: [townId, sceneId],
        visitedLocationIds: [townId, sceneId],
        npcs: [{
          id: npcId,
          name: "老乞丐",
          role: "破庙守夜人",
          description: "一个白发苍苍的老乞丐。",
          locationId: sceneId,
          isCompanion: false,
          tags: [],
          met: false,
          memory: { npcId, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
        }],
        items: [],
        inventory: [],
        worldFacts: [],
        quests: [],
        enemies: [],
        defeatedEnemyIds: [],
        factions: [],
      },
    },
    {
      eventLedger: ledger,
      quests: [{
        id: questId,
        name: "主线",
        description: "追查破庙异状。",
        objectives: [{ kind: "talk_to_npc", npcId }],
        onSuccess: { kind: "advance_story" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 1,
        status: "active",
      }],
    },
  );
}

/** 决策 fixture 的 story：entityCounts 与世界规模一致，narrative 为 ready 骨架。 */
export function createDecisionStoryFixture(): StoryState {
  return createInitialStoryState({
    gameLength: "short",
    initialEntityCounts: { locations: 2, npcs: 1, quests: 1, events: 0 },
    initialNarrative: createFixtureNarrativeRuntimeState(),
  });
}

/** 已提交的 provider_pending 记录：包含待生成决策 job（objectiveTransition.after 非空）。 */
export function createPendingDecisionRecord(revision = 0, gameId = "game-decision"): GameRecord {
  const built = createPendingNarrativeJob({
    jobId: asNarrativeJobId("decision-pending"),
    turnId: asTurnId("turn-1"),
    actionId: "action-1",
    expectedRevision: revision,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId(FIXTURE_DECISION_NPC) },
    resolvedEvent: {
      actionId: "action-1", status: "success", eventKind: "observe",
      facts: [], stateChanges: [], costs: [], rewards: [],
      triggeredEvents: [], rejectedEffects: [],
    },
    domainEventIds: [eventIdFor(asTurnId("turn-1"), "npc_met")],
    focusNpcId: asNpcId(FIXTURE_DECISION_NPC),
    requestedAt: "2026-09-09T08:00:00.000Z",
    objectiveTransition: {
      before: null,
      completed: [],
      after: { questId: asQuestId(FIXTURE_DECISION_QUEST), objectiveIndex: 0, label: "对话" },
      mode: "progressed",
    },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!built.ok) {
    throw new Error(`pending decision job 构造失败: ${built.errors.map((e) => e.code).join(",")}`);
  }
  const fixture = createFixtureNarrativeRuntimeState();
  return {
    gameId: asGameId(gameId),
    worldState: createDecisionWorldFixture(),
    storyState: {
      ...createDecisionStoryFixture(),
      narrative: {
        status: "provider_pending",
        mode: "ai",
        job: built.job,
        lastPresentedScene: fixture.status === "ready" ? fixture.currentScene : null,
      },
    },
    revision,
    createdAt: "2026-09-09T08:00:00.000Z",
  };
}
