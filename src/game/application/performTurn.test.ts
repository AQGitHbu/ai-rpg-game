import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect } from "vitest";
import { performTurn } from "./performTurn";
import { buildChoiceMap } from "./buildChoiceMap";
import type {
  ApplyStateInput,
  GameRecord,
  GameRepository,
} from "./server/persistence/gameRepository";
import { asGameId } from "./server/persistence/gameRepository";
import { type LocationEntry, type NpcEntry } from "@/game/domain/worldState";
import type { CommittedNarrativeEvent, NarrativeEventPayload } from "@/game/domain/events";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { projectEntityStore, type EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import {
  createWorldStateFixtureWith,
  updateWorldStateFixture,
  type WorldStateFixtureOverrides,
} from "@/game/domain/testing/worldStateFixture.testutil";
import { createInitialStoryState } from "@/game/domain/storyState";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import { asLocationId, asNpcId, asGenerationId, asEnemyId, asQuestId, asItemId, asFactId, asEndingId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { asEventId, asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createPendingNarrativeJob, type PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import { ENEMY_COMBAT_STATS, PLAYER_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import { buildEncounter } from "@/game/gameplay/rpg/ruleEngine/buildEncounter";
import { createTurnOrder } from "@/game/gameplay/rpg/ruleEngine/combatMath";

function createSpyRepo(ws: WorldState, ss: StoryState): {
  repo: GameRepository;
  applyCalls: () => readonly ApplyStateInput[];
  record: () => GameRecord | null;
} {
  let record: GameRecord = {
    gameId: asGameId("g1"), worldState: ws, storyState: ss, revision: 0, createdAt: "2026-01-01",
  };
  const applyCallsHistory: ApplyStateInput[] = [];
  const repo: GameRepository = {
    async createInitialGame(input) {
      if (record !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async replaceCurrentGame() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
    async getCurrentGame() {
      return { ok: true, status: "active", record };
    },
    async applyState(input) {
      applyCallsHistory.push(input);
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async applySceneWriteBack(input) {
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async clearCurrentGame() { return { ok: true as const }; },
  };
  return { repo, record: () => record, applyCalls: () => applyCallsHistory };
}

const loc1: LocationEntry = {
  id: asLocationId("loc_1"), name: "客栈", description: "t", kind: "main",
  connectedLocationIds: [asLocationId("loc_2")], npcIds: [asNpcId("npc_1")], availableItemIds: [], tags: [],
};
const loc2: LocationEntry = {
  id: asLocationId("loc_2"), name: "街道", description: "t", kind: "main",
  connectedLocationIds: [asLocationId("loc_1")], npcIds: [], availableItemIds: [], tags: [],
};
const npc1: NpcEntry = {
  id: asNpcId("npc_1"), name: "老板", role: "路人", description: "t",
  locationId: asLocationId("loc_1"), isCompanion: false, tags: [], met: false,
  memory: { npcId: asNpcId("npc_1"), knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] },
};

const GENERATION: GenerationMetadata = {
  generationId: asGenerationId("g1"), seed: "s", templateVersion: "v2", inputDigest: "", gameType: "wuxia",
};

const BASE_PROJECTION: EntityCompatibilityProjection = {
  player: { name: "p", identity: "i", stats: { hp: 100, attack: 10, defense: 5 } },
  locations: [loc1, loc2],
  currentLocationId: loc1.id,
  unlockedLocationIds: [loc1.id, loc2.id],
  visitedLocationIds: [loc1.id],
  npcs: [npc1],
  items: [],
  inventory: [],
  worldFacts: [],
  quests: [],
  enemies: [],
  defeatedEnemyIds: [],
  factions: [],
};

const INITIALIZED_LEDGER: readonly CommittedNarrativeEvent[] = [
  makeCommittedEvent({ type: "game_initialized", generation: GENERATION } as unknown as NarrativeEventPayload),
];

function buildWorldState(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return createWorldStateFixtureWith(
    { generation: GENERATION, base: BASE_PROJECTION },
    { eventLedger: INITIALIZED_LEDGER, ...overrides },
  );
}

function buildStoryState(): StoryState {
  return createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 2, npcs: 1, quests: 0, events: 0 } });
}

/** 世界带上一条主线任务：首个目标与老板交谈，第二个目标获取盟誓印谱。 */
function buildWorldWithMainQuest(overrides: WorldStateFixtureOverrides = {}): WorldState {
  return buildWorldState({
    quests: [{
      id: asQuestId("quest_0"),
      name: "查明真相",
      description: "查清矿坑的真相",
      objectives: [
        { kind: "talk_to_npc", npcId: asNpcId("npc_1") },
        { kind: "obtain_item", itemId: asItemId("item_seal") },
      ],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: [],
      kind: "main",
      stage: 1,
      status: "active",
    }],
    items: [{ id: asItemId("item_seal"), name: "盟誓印谱", description: "刻着盟约的印谱", kind: "quest", tags: [] }],
    ...overrides,
  });
}

function buildFocusedDialogueStoryState(focusNpcId = asNpcId("npc_1")): StoryState {
  const base = buildStoryState();
  const support = createApprovedChoice({
    sceneId: "scene-focused",
    basedOnRevision: 0,
    label: "支持",
    action: { type: "talk", npcId: focusNpcId, dialogueAct: "support" },
  });
  const challenge = createApprovedChoice({
    sceneId: "scene-focused",
    basedOnRevision: 0,
    label: "质疑",
    action: { type: "talk", npcId: focusNpcId, dialogueAct: "challenge" },
  });
  if (!support.ok || !challenge.ok) throw new Error("focused dialogue fixture invalid");
  return {
    ...base,
    narrative: {
      ...base.narrative,
      status: "ready",
      currentScene: {
        sceneId: "scene-focused",
        turn: 0,
        narration: "老板等着你的回应。",
        usedFactIds: [],
        npcLine: { npcId: focusNpcId, text: "你怎么看？", emotion: "neutral", usedFactIds: [], usedEventIds: [] },
        choices: [
          { choiceToken: support.choice.choiceToken, label: support.choice.label },
          { choiceToken: challenge.choice.choiceToken, label: challenge.choice.label },
        ],
        source: "fixture",
        event: { kind: "dialogue", focusNpcId },
        npcDialogues: [{ npcId: focusNpcId, npcName: "老板", npcRole: "路人", speechPages: ["你怎么看？"], usedFactIds: [], usedEventIds: [] }],
      },
      choiceRegistry: [support.choice, challenge.choice],
    },
  };
}

function pendingNarrative(storyNarrative: StoryState["narrative"]): Extract<StoryState["narrative"], { status: "provider_pending" }> {
  if (storyNarrative.status !== "provider_pending") throw new Error("expected provider_pending narrative fixture");
  return storyNarrative;
}

function firstApprovedChoice(story: StoryState) {
  if (story.narrative.status !== "ready") throw new Error("expected ready narrative fixture");
  const choice = story.narrative.choiceRegistry[0];
  if (choice === undefined) throw new Error("expected approved choice fixture");
  return choice;
}

function buildFocusedAskDialogueStoryState(): StoryState {
  const story = buildFocusedDialogueStoryState();
  if (story.narrative.status !== "ready") throw new Error("expected ready narrative fixture");
  const ask = createApprovedChoice({
    sceneId: story.narrative.currentScene.sceneId,
    basedOnRevision: 0,
    label: "询问",
    action: { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" },
  });
  if (!ask.ok) throw new Error("ask choice fixture invalid");
  return {
    ...story,
    narrative: {
      ...story.narrative,
      currentScene: {
        ...story.narrative.currentScene,
        choices: [{ choiceToken: ask.choice.choiceToken, label: ask.choice.label }],
      },
      choiceRegistry: [ask.choice],
    },
  };
}

function makePendingJob(): PendingNarrativeJob {
  const result = createPendingNarrativeJob({
    jobId: asNarrativeJobId("existing-job"),
    turnId: asTurnId("existing-turn"),
    actionId: "act_existing",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    resolvedEvent: {
      actionId: "act_existing", status: "success", eventKind: "dialogue",
      facts: [], stateChanges: [], costs: [], rewards: [], triggeredEvents: [], rejectedEffects: [],
    },
    domainEventIds: [asEventId("turn-1:event-1")],
    requestedAt: "2026-01-02",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  });
  if (!result.ok) throw new Error("fixture job 构造失败");
  return result.job;
}

function buildPendingStoryState(): StoryState {
  const ss = buildStoryState();
  return {
    ...ss,
    narrative: { status: "provider_pending", mode: ss.narrative.mode, job: makePendingJob(), lastPresentedScene: null },
  };
}

describe("performTurn 单次 CAS 提交", () => {
  const talkAction: Action = { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "ask" };

  it("正式放弃主线只提交一次 A，并创建无焦点 NPC 的 story_exit pending job", async () => {
    const world = buildWorldWithMainQuest();
    const base = buildStoryState();
    if (base.narrative.status !== "ready") throw new Error("expected ready narrative fixture");
    const abandon = createApprovedChoice({
      sceneId: base.narrative.currentScene.sceneId,
      basedOnRevision: 0,
      label: "放弃这项委托",
      action: { type: "abandon_quest", questId: asQuestId("quest_0") },
    });
    if (!abandon.ok) throw new Error("abandon choice fixture invalid");
    const story: StoryState = {
      ...base,
      narrative: {
        ...base.narrative,
        currentScene: { ...base.narrative.currentScene, choices: [{ choiceToken: abandon.choice.choiceToken, label: abandon.choice.label }] },
        choiceRegistry: [abandon.choice],
      },
    };
    const { repo, applyCalls, record } = createSpyRepo(world, story);

    const result = await performTurn({
      gameId: asGameId("g1"),
      actionId: "act_abandon",
      interaction: { kind: "fixed_choice", choiceToken: abandon.choice.choiceToken },
      expectedRevision: 0,
      choiceMap: new Map([[abandon.choice.choiceToken, abandon.choice.action]]),
    }, { repository: repo, now: () => "2026-01-02" });

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const saved = record();
    expect(saved?.worldState.eventLedger.some((event) => event.kind === "quest_abandoned")).toBe(true);
    const job = saved?.storyState.narrative.status === "provider_pending" ? saved.storyState.narrative.job : undefined;
    expect(job?.generationKind).toBe("story_exit");
    expect(job?.sceneRequestKind).toBe("story_exit");
    expect(job?.focusNpcId).toBeUndefined();
    expect(job?.actionSummary).toEqual({ kind: "abandon_quest", questId: "quest_0" });
  });

  it("显式 offline fixture 可继续消费旧终幕选择", async () => {
    const questId = asQuestId("quest_final");
    const questOutcome = makeCommittedEvent({ type: "quest_completed", questId }, { eventId: asEventId("turn_final:quest_completed"), sequence: 1, questIds: [questId] });
    const finalWorld = buildWorldState({
      eventLedger: [...INITIALIZED_LEDGER, questOutcome],
      quests: [{
        id: questId,
        name: "终幕主线",
        description: "查明真相",
        objectives: [{ kind: "visit_location", locationId: asLocationId("loc_1") }],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 3,
        status: "completed",
      }],
      endings: [
        {
          id: asEndingId("ending_trust"),
          name: "共担真相",
          description: "与盟友共同揭露真相。",
          requirements: [{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_1"), value: 1 }],
        },
        {
          id: asEndingId("ending_doubt"),
          name: "独自揭露",
          description: "独自追查到底。",
          requirements: [{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_1"), value: 0 }],
        },
      ],
    });
    const baseFinalStory = buildFocusedDialogueStoryState();
    const boundThread = { ...baseFinalStory.threads[0]!, questIds: [questId], status: "advanced" as const };
    const finalStory = {
      ...baseFinalStory,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 100,
      endingAllowed: true,
      threads: [boundThread],
      unresolvedThreads: [boundThread.id],
    };
    const supportToken = finalStory.narrative.status === "ready"
      ? finalStory.narrative.currentScene.choices[0]?.choiceToken
      : undefined;
    if (supportToken === undefined) throw new Error("ending fixture missing support choice");
    const { repo, applyCalls, record } = createSpyRepo(finalWorld, finalStory);

    const result = await performTurn({
      gameId: asGameId("g1"),
      actionId: "act_final_choice",
      interaction: { kind: "fixed_choice", choiceToken: supportToken },
      expectedRevision: 0,
      choiceMap: new Map([[supportToken, { type: "talk", npcId: asNpcId("npc_1"), dialogueAct: "support" }]]),
    }, { repository: repo, now: () => "2026-01-02" });

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    expect(record()?.worldState.ending).not.toBeNull();
  });

  it("结局包内没有可消费步骤时，服务端铸造的结局立场仍可结算结局", async () => {
    const base = buildStoryState();
    const questId = asQuestId("quest_final");
    const questOutcome = makeCommittedEvent({ type: "quest_completed", questId }, { eventId: asEventId("turn_final:quest_completed"), sequence: 1, questIds: [questId] });
    const finalWorld = buildWorldState({
      eventLedger: [...INITIALIZED_LEDGER, questOutcome],
      quests: [{
        id: questId,
        name: "终幕主线",
        description: "查明真相",
        objectives: [{ kind: "visit_location", locationId: asLocationId("loc_1") }],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: [],
        kind: "main",
        stage: 3,
        status: "completed",
      }],
      endings: [
        {
          id: asEndingId("ending_trust"),
          name: "共担真相",
          description: "与盟友共同揭露真相。",
          requirements: [{ kind: "npc_affinity_at_least", npcId: asNpcId("npc_1"), value: 1 }],
        },
        {
          id: asEndingId("ending_doubt"),
          name: "独自揭露",
          description: "独自追查到底。",
          requirements: [{ kind: "npc_affinity_at_most", npcId: asNpcId("npc_1"), value: 0 }],
        },
      ],
    });
    const finalWorldWithSecret = updateWorldStateFixture(finalWorld, {
      worldFacts: [{ factId: asFactId("fact_secret"), text: "保密事实", discovered: true, source: "generated", locationId: asLocationId("loc_1") }],
    });
    const boundThread = { ...base.threads[0]!, questIds: [questId], status: "advanced" as const };
    let endingStory: StoryState = {
      ...base,
      currentAct: 3,
      targetActs: 3,
      storyProgress: 100,
      endingAllowed: true,
      threads: [boundThread],
      unresolvedThreads: [boundThread.id],
      narrative: {
        status: "ready",
        mode: "ai",
        currentScene: {
          sceneId: "scene-ending-pair",
          turn: 0,
          narration: "两条路都摆在面前，他必须做出选择。",
          usedFactIds: [],
          npcLine: null,
          choices: [],
          source: "generated",
        },
        choiceRegistry: [],
      },
    };
    // Produce the conditional scenes through the real approval producer at turn 0.
    const approved = approveNarrativeBundle({
      proposal: {
        worldDelta: null,
        currentScene: { segments: [{ beatId: "atmosphere", text: "两条路都摆在面前，他必须做出选择。" }], npcLine: null, objectiveLink: null, choices: [] },
        continuationScenes: [], terminal: { kind: "ending" },
        endingOutcomes: [
          { themeKey: "trust", choiceLabel: "共同承担", scene: { segments: [{ beatId: "atmosphere", text: "两人共同平息渡口纠纷。" }], npcLine: null, objectiveLink: null, choices: [] } },
          { themeKey: "doubt", choiceLabel: "保持疑虑", scene: { segments: [{ beatId: "atmosphere", text: "你独自承担后果，渡口争议暂时平息。" }], npcLine: null, objectiveLink: null, choices: [] } },
        ],
      },
      worldState: finalWorld, storyState: endingStory,
      transition: { before: null, completed: [], after: null, mode: "unchanged" },
      evolutionNeed: { kind: "none" }, jobId: asNarrativeJobId("job_ending_pair"), basedOnRevision: 0, mandatoryBeats: [],
      eventContext: { turnId: asTurnId("generation"), actionId: "generation", turnNumber: 0, domainEventIds: [], episodeKey: "generation" },
      now: () => "2026-01-01",
    });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(`${approved.code}:${approved.detail}`);
    const approvedOutcomes = approved.approved.bundle.endingOutcomes!;
    expect(approvedOutcomes.map(outcome => outcome.scene.turn)).toEqual([0, 0]);
    endingStory = { ...approved.approved.nextStoryStatePreview, narrative: {
      status: "ready", mode: "ai", currentScene: approved.approved.currentScene,
      choiceRegistry: approved.approved.choiceRegistry, narrativeBundle: approved.approved.bundle,
    } };
    const choiceMap = buildChoiceMap(finalWorld, endingStory, 0);
    const supportToken = [...choiceMap.entries()].find(([, action]) =>
      action.type === "talk" && action.dialogueAct === "support")?.[0];
    if (supportToken === undefined) throw new Error("ending stance token missing");
    const missingStory: StoryState = {
      ...endingStory,
      narrative: endingStory.narrative.status === "ready" ? {
        ...endingStory.narrative,
        narrativeBundle: { ...endingStory.narrative.narrativeBundle!, endingOutcomes: undefined },
      } : endingStory.narrative,
    };
    const missingRepo = createSpyRepo(finalWorld, missingStory);
    const missing = await performTurn({
      gameId: asGameId("g1"), actionId: "act_missing_outcome",
      interaction: { kind: "fixed_choice", choiceToken: supportToken }, expectedRevision: 0, choiceMap,
    }, { repository: missingRepo.repo, now: () => "2026-01-02" });
    expect(missing).toMatchObject({ ok: false, code: "NARRATIVE_CONTINUATION_MISSING" });
    expect(missingRepo.applyCalls()).toHaveLength(0);
    const { repo, applyCalls, record } = createSpyRepo(finalWorld, endingStory);

    const result = await performTurn({
      gameId: asGameId("g1"),
      actionId: "act_ending_stance",
      interaction: { kind: "fixed_choice", choiceToken: supportToken },
      expectedRevision: 0,
      choiceMap,
    }, { repository: repo, now: () => "2026-01-02" });

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    expect(record()?.worldState.ending?.endingId).toBe(asEndingId("ending_trust"));
    expect(record()?.storyState.narrative.status).toBe("ready");
    const savedNarrative = record()?.storyState.narrative;
    expect(savedNarrative?.status === "ready" && savedNarrative.currentScene).toEqual({ ...approvedOutcomes[0]!.scene, turn: 1 });
    expect(approvedOutcomes[0]!.scene.turn).toBe(0);
    expect(savedNarrative?.status === "ready" && savedNarrative.narrativeBundle?.endingOutcomes).toEqual(approvedOutcomes);
    expect(record()?.worldState.eventLedger.some(event => event.kind === "ending_reached")).toBe(true);
    expect(record()?.worldState.eventLedger.filter(event => event.kind === "narrative_scene_presented")).toHaveLength(1);
    expect(savedNarrative?.status === "ready" && savedNarrative.currentScene.turn).toBe(1);
    expect(record()?.storyState.turnNumber).toBe(1);
    expect(record()?.worldState.eventLedger.filter(event => event.kind === "ending_reached" || event.kind === "narrative_scene_presented").map(event => event.turnNumber)).toEqual([1, 1]);
    expect(record()?.storyState.history?.entries.filter(entry => entry.actionId === "act_ending_stance").map(entry => entry.turnNumber)).toEqual([1, 1]);

    const forcedEntityStore = {
        ...finalWorldWithSecret.entityStore,
        records: finalWorldWithSecret.entityStore.records.map((entity) => entity.core.id === "npc_1" ? {
          ...entity,
          relationships: { outgoing: [{
            targetId: PLAYER_ENTITY_ID,
            dimensions: { affinity: 1, trust: 0, fear: 0, hostility: 0 }, stage: "acquainted", trend: "stable",
            commitments: [{
              kind: "promise", commitmentId: "broken_confidentiality", promisor: "target", status: "broken", description: "保守秘密",
              source: { kind: "initial_world", createdAtTurn: 0, reasonKey: "opening" },
              confidentiality: { protectedFactIds: [asFactId("fact_secret")], allowedAudienceIds: [PLAYER_ENTITY_ID, asNpcId("npc_1")], fulfillment: { kind: "story_delivery" } },
            }], evidence: [], origin: { kind: "initial_world", createdAtTurn: 0, reasonKey: "opening" }, lastChangedAtTurn: 0,
          }] },
        } as never : entity),
    };
    const forcedWorld: WorldState = {
      ...finalWorldWithSecret,
      ...projectEntityStore(forcedEntityStore),
      entityStore: forcedEntityStore,
    };
    const forcedRepo = createSpyRepo(forcedWorld, endingStory);
    const forced = await performTurn({
      gameId: asGameId("g1"), actionId: "act_forced_doubt",
      interaction: { kind: "fixed_choice", choiceToken: supportToken }, expectedRevision: 0, choiceMap,
    }, { repository: forcedRepo.repo, now: () => "2026-01-02" });
    expect(forced.ok).toBe(true);
    expect(forcedRepo.record()?.worldState.ending?.endingId).toBe(asEndingId("ending_doubt"));
    const forcedNarrative = forcedRepo.record()?.storyState.narrative;
    expect(forcedNarrative?.status === "ready" && forcedNarrative.currentScene).toEqual({ ...approvedOutcomes[1]!.scene, turn: 1 });
    expect(forcedNarrative?.status === "ready" && forcedNarrative.currentScene.turn).toBe(1);
    expect(JSON.stringify(forcedRepo.record()?.storyState.history)).toContain("共同承担");
    expect(JSON.stringify(forcedRepo.record()?.storyState.history)).toContain("你独自承担后果");
    expect(JSON.stringify(forcedRepo.record()?.storyState.history)).not.toContain("两人共同平息渡口纠纷");
    expect(forcedRepo.record()?.worldState.eventLedger.filter(event => event.kind === "ending_reached")).toHaveLength(1);
    expect(forcedRepo.record()?.worldState.eventLedger.filter(event => event.kind === "narrative_scene_presented")).toHaveLength(1);
    const repeated = await performTurn({
      gameId: asGameId("g1"), actionId: "act_forced_doubt",
      interaction: { kind: "fixed_choice", choiceToken: supportToken }, expectedRevision: 0, choiceMap,
    }, { repository: forcedRepo.repo, now: () => "2026-01-02" });
    expect(repeated).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
    expect(forcedRepo.applyCalls()).toHaveLength(1);
  });

  it("活跃战斗推进直接 CAS，不创建 pending narrative job", async () => {
    const enemy = {
      id: asEnemyId("enemy_1"), name: "灰狼", tier: "normal" as const,
      stats: toStatBlock(ENEMY_COMBAT_STATS.normal), locationId: asLocationId("loc_1"), tags: [],
    };
    const modern = buildWorldState({
      player: { name: "p", identity: "i", stats: toStatBlock(PLAYER_COMBAT_STATS) },
      enemies: [enemy],
    });
    const encounter = buildEncounter(modern, enemy.id);
    const active = {
      status: "active" as const,
      enemyId: enemy.id,
      enemyIds: [enemy.id],
      playerHp: 100,
      enemyHp: 55,
      round: 1,
      combatants: encounter,
      turnOrder: createTurnOrder(encounter),
      turnIndex: 0,
      enemyIntents: [],
      downedEnemyIds: [],
      lastAdvance: [],
    };
    const { repo, record, applyCalls } = createSpyRepo({ ...modern, battle: active }, buildStoryState());
    const action: Action = {
      type: "battle_action",
      action: "attack",
      command: { actorId: "ally:protagonist" as never, targetId: "enemy:enemy_1" as never },
    };
    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "battle_1", interaction: { kind: "fixed_choice", choiceToken: "battle" }, expectedRevision: 0, choiceMap: new Map([["battle", action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const saved = record();
    expect(saved?.storyState.narrative.status).toBe("ready");
    // Task 8: active battle rounds no longer create rule-owned scenes;
    // storyState stays unchanged from before the battle action.
    expect(saved?.worldState.battle.status).toBe("active");
  });

  it("战斗结算缺少精确预备结果时零写入并返回稳定缺失码", async () => {
    const enemy = {
      id: asEnemyId("enemy_1"), name: "灰狼", tier: "normal" as const,
      stats: toStatBlock(ENEMY_COMBAT_STATS.normal), locationId: asLocationId("loc_1"), tags: [],
    };
    const base = buildWorldState();
    const beforeLedger = base.eventLedger;
    const battleStarted = makeCommittedEvent(
      { type: "battle_started", enemyId: enemy.id },
      {
        eventId: asEventId("battle:rollback"),
        turnId: asTurnId("battle-start"),
        sequence: beforeLedger.length,
        targetIds: [enemy.id],
        locationId: loc1.id,
      },
    );
    const world = buildWorldState({
      enemies: [enemy],
      eventLedger: [...beforeLedger, battleStarted],
      battle: {
        status: "active",
        enemyId: enemy.id,
        playerHp: 1,
        enemyHp: enemy.stats.hp,
        round: 1,
        battleKey: "battle:rollback",
        preBattleSnapshot: {
          entityStore: base.entityStore,
          eventLedger: beforeLedger,
        },
      },
    });
    const { repo, record, applyCalls } = createSpyRepo(world, buildStoryState());
    const action: Action = { type: "battle_action", action: "guard" };
    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "battle_defeat", interaction: { kind: "fixed_choice", choiceToken: "battle" }, expectedRevision: 0, choiceMap: new Map([["battle", action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    // Task 8: defeat/withdraw now restores pre-battle checkpoint via performBattleRound.
    // The battle is set to idle, player stats and event ledger are restored.
    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const saved = record();
    expect(saved?.worldState.battle.status).toBe("idle");
    expect(saved?.worldState.player.stats).toEqual(base.player.stats);
    expect(saved?.worldState.eventLedger).toBe(beforeLedger);
  });

  it.each([
    { label: "prepared continuation", source: "prepared" as const, terminalAction: { type: "battle_action", action: "guard" } as const },
    { label: "narrative bundle", source: "bundle" as const, terminalAction: { type: "battle_action", action: "flee" } as const },
  ])("真实 performTurn 战斗 checkpoint 恢复 $label 的完整 ready narrative", async ({ source, terminalAction }) => {
    const enemy = {
      id: asEnemyId("enemy_checkpoint"), name: "灰狼", tier: "normal" as const,
      stats: toStatBlock(ENEMY_COMBAT_STATS.normal), locationId: loc1.id, tags: [],
    };
    const world = buildWorldState({
      player: { name: "p", identity: "i", stats: toStatBlock(PLAYER_COMBAT_STATS) },
      enemies: [enemy],
    });
    const baseStory = buildStoryState();
    if (baseStory.narrative.status !== "ready") throw new Error("fixture narrative must be ready");
    const choice = createApprovedChoice({
      sceneId: "scene-before-checkpoint-battle",
      basedOnRevision: 0,
      label: "迎战",
      action: { type: "attack", enemyId: enemy.id },
    });
    if (!choice.ok) throw new Error("checkpoint choice fixture invalid");
    const beforeScene = {
      ...baseStory.narrative.currentScene,
      sceneId: "scene-before-checkpoint-battle",
      choices: [{ choiceToken: choice.choice.choiceToken, label: choice.choice.label }],
      event: { kind: "observe" as const, locationId: loc1.id },
    };
    const preparedContinuation = {
      originJobId: asNarrativeJobId("job-battle-checkpoint-prepared"),
      steps: [{
        stepId: "battle-start",
        objectiveKey: "battle",
        consumptionGroupKey: "battle",
        trigger: { kind: "battle_started" as const, enemyId: enemy.id },
        scene: {
          segments: [{ beatId: "battle", text: "灰狼扑来。" }],
          event: { kind: "battle" as const, enemyId: enemy.id },
          npcLine: null,
          objectiveLink: null,
          choiceSeeds: [],
          source: "fixture" as const,
        },
        nextStepIds: [],
      }],
      activeStepIds: ["battle-start"],
    };
    const narrativeBundle = {
      contractVersion: 3 as const,
      originJobId: asNarrativeJobId("job-battle-checkpoint-bundle"),
      steps: [{
        stepId: "battle-start",
        objectiveKey: "battle",
        consumptionGroupKey: "battle",
        trigger: { kind: "battle_started" as const, enemyId: enemy.id },
        scene: {
          segments: [{ beatId: "battle", text: "灰狼扑来。" }],
          event: { kind: "battle" as const, enemyId: enemy.id },
          npcLine: null,
          objectiveLink: null,
          choiceSeeds: [],
          source: "fixture" as const,
        },
        nextStepIds: [],
      }],
      activeStepIds: ["battle-start"],
      terminal: { kind: "next_decision" as const, target: { kind: "continuation_step" as const, stepId: "battle-start" } },
    };
    const dialogueResume = {
      objectiveKey: "quest_0:0",
      npcId: npc1.id,
      locationId: loc1.id,
      scene: beforeScene,
      choiceRegistry: [choice.choice],
    };
    const story: StoryState = {
      ...baseStory,
      narrative: {
        ...baseStory.narrative,
        currentScene: beforeScene,
        choiceRegistry: [choice.choice],
        dialogueSession: { npcId: npc1.id, turnCount: 1, requiredTurns: 2, completed: false },
        dialogueResume,
        ...(source === "prepared"
          ? { preparedContinuation }
          : { mode: "ai" as const, narrativeBundle }),
      },
    };
    const { repo, record } = createSpyRepo(world, story);
    const opening = await performTurn({
      gameId: asGameId("g1"),
      actionId: `open-${source}-checkpoint-battle`,
      interaction: { kind: "fixed_choice", choiceToken: choice.choice.choiceToken },
      expectedRevision: 0,
      choiceMap: new Map([[choice.choice.choiceToken, choice.choice.action]]),
    }, { repository: repo, now: () => "2026-01-02" });
    expect(opening.ok).toBe(true);
    const opened = record();
    if (opened === null || opened.worldState.battle.status !== "active" || opened.storyState.narrative.status !== "ready") {
      throw new Error("performTurn must create an active battle with ready narrative");
    }
    const checkpoint = opened.storyState.narrative.battleCheckpoint;
    if (checkpoint === undefined) throw new Error("battle checkpoint must be persisted");
    expect(checkpoint.choiceRegistry).toEqual([choice.choice]);
    expect(checkpoint.dialogueResume).toEqual(dialogueResume);
    if (source === "prepared") expect(checkpoint.preparedContinuation).toEqual(preparedContinuation);
    else expect(checkpoint.bundle).toEqual(narrativeBundle);

    const activeBattle = opened.worldState.battle;
    if (activeBattle.preBattleSnapshot === undefined || activeBattle.combatants === undefined) {
      throw new Error("modern battle must retain its world snapshot");
    }
    expect(activeBattle.preBattleSnapshot.history).toEqual(story.history);
    const midBattle = {
      ...activeBattle,
      playerHp: 1,
      combatants: activeBattle.combatants.map((unit) => unit.source.kind === "protagonist" ? { ...unit, hp: 1 } : unit),
    };
    const midNarrative = {
      ...opened.storyState.narrative,
      currentScene: { ...opened.storyState.narrative.currentScene, narration: "战中暂态" },
      choiceRegistry: [],
      dialogueSession: { npcId: npc1.id, turnCount: 2, requiredTurns: 2, completed: true },
      dialogueResume: { ...dialogueResume, objectiveKey: "mutated-during-battle" },
    };
    await repo.applyState({
      gameId: asGameId("g1"),
      expectedRevision: opened.revision,
      nextWorldState: {
        ...opened.worldState,
        battle: midBattle,
        eventLedger: [...opened.worldState.eventLedger, {
          // CommittedNarrativeEvent envelope for test
      ...makeCommittedEvent({ type: "npc_dialogue_completed", npcId: npc1.id } as unknown as NarrativeEventPayload, { sequence: opened.worldState.eventLedger.length }),
      actionId: "mid-battle-action-evidence", committedAt: "2026-01-02",
        }],
      },
      nextStoryState: { ...opened.storyState, narrative: midNarrative },
    });
    const ended = await performTurn({
      gameId: asGameId("g1"),
      actionId: `end-${source}-checkpoint-battle`,
      interaction: { kind: "fixed_choice", choiceToken: choice.choice.choiceToken },
      expectedRevision: opened.revision + 1,
      choiceMap: new Map([[choice.choice.choiceToken, terminalAction]]),
    }, { repository: repo, now: () => "2026-01-02" });
    expect(ended).toMatchObject({ ok: true });
    const restored = record();
    if (restored === null) throw new Error("restored record must persist");
    expect(restored.storyState).toEqual({
      ...story,
      memory: rebuildEpisodicMemory(world.eventLedger),
    });
    expect(restored.worldState.eventLedger).toEqual(world.eventLedger);
  });

  it("非决策行动没有 bundle step 时零写入", async () => {
    const store = createSpyRepo(buildWorldState(), buildStoryState());
    const result = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "move-without-bundle-step",
        interaction: { kind: "fixed_choice", choiceToken: "move" },
        expectedRevision: 0,
        choiceMap: new Map([["move", { type: "move", locationId: loc2.id }]]),
      },
      { repository: store.repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "NARRATIVE_CONTINUATION_MISSING" });
    expect(store.applyCalls()).toHaveLength(0);
    expect(store.record()?.revision).toBe(0);
  });

  it("成功回合 applyState 恰好一次，单次写入同时包含 WorldState、StoryState.turnNumber 和 pending job", async () => {
    const story = buildFocusedAskDialogueStoryState();
    const choice = firstApprovedChoice(story);
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), story);

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken }, expectedRevision: 0, choiceMap: new Map([[choice.choiceToken, choice.action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    // 单次提交：不存在第二次“非致命” commit
    expect(applyCalls()).toHaveLength(1);

    const written = applyCalls()[0]!;
    const saved = record()!;
    expect(saved.revision).toBe(1);
    expect(saved.worldState).toBe(written.nextWorldState);
    expect(saved.storyState).toBe(written.nextStoryState);
    expect(saved.storyState.turnNumber).toBe(1);
    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.jobId).toBe("job_act_1");
    expect(generation.job.turnId).toBe("act_1");
    expect(generation.job.turnNumber).toBe(1);
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.focusNpcId).toBe("npc_1");
    expect(generation.job.domainEventIds).toEqual([
      "act_1:npc_interaction_recorded:npc_1:act_1",
      "act_1:npc_met:npc_1",
    ]);
    expect(generation.job.requestedAt).toBe("2026-01-02");
  });

  it("pending job.resolvedEvent 等于真实 TurnResolution.primaryResult，basedOnRevision 等于提交后 revision", async () => {
    const story = buildFocusedAskDialogueStoryState();
    const choice = firstApprovedChoice(story);
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), story);

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken }, expectedRevision: 0, choiceMap: new Map([[choice.choiceToken, choice.action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    // resolvedEvent：与规则引擎真实产出的 primaryResult 完全一致（actionId/状态/事件种类/触发事件）
    expect(generation.job.resolvedEvent).toEqual({
      actionId: "act_1",
      status: "success",
      eventKind: "dialogue",
      facts: [],
      stateChanges: [{ path: "npcs[npc_1].met", description: "与老板交谈", operation: "set" }],
      costs: [],
      rewards: [],
      triggeredEvents: ["npc_interaction_recorded", "npc_met"],
      rejectedEffects: [],
    });
    // basedOnRevision 等于提交后的 revision（record.revision = expectedRevision + 1）
    expect(generation.job.basedOnRevision).toBe(saved.revision);
    expect(generation.job.basedOnRevision).toBe(1);
  });

  it("正式已批准二选一创建 pending", async () => {
    const story = buildFocusedDialogueStoryState();
    const choice = firstApprovedChoice(story);
    const { repo, record, applyCalls } = createSpyRepo(buildWorldWithMainQuest(), story);

    const result = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "dialogue_first_response",
        interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken },
        expectedRevision: 0,
        choiceMap: new Map([[choice.choiceToken, choice.action]]),
      },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(applyCalls()).toHaveLength(1);
    expect(generation.job.actionId).toBe("dialogue_first_response");
    expect(generation.job.utterance).toBeUndefined();
  });

  it("消费到达步骤后，将其 NPC 二选一作为下一次正式决策", async () => {
    const npc2: NpcEntry = {
      ...npc1, id: asNpcId("npc_2"), name: "驿站守夜人", locationId: loc2.id,
      memory: { ...npc1.memory, npcId: asNpcId("npc_2") },
    };
    const baseWorld = buildWorldState();
    const world = updateWorldStateFixture(baseWorld, { npcs: [...baseWorld.npcs, npc2] });
    const story = buildStoryState();
    const preparedStory: StoryState = {
      ...story,
      narrative: {
        status: "ready",
        mode: story.narrative.mode,
        currentScene: {
          sceneId: "scene-before-arrival", turn: 0, narration: "动身前往驿站。", usedFactIds: [], npcLine: null,
          choices: [], source: "fixture", event: { kind: "travel", locationId: loc2.id },
        },
        choiceRegistry: [],
        narrativeBundle: {
          contractVersion: 3,
          originJobId: asNarrativeJobId("arrival-job"),
          activeStepIds: ["move:loc_2"],
          terminal: { kind: "next_decision", target: { kind: "continuation_step", stepId: "move:loc_2" } },
          steps: [{
            stepId: "move:loc_2", objectiveKey: "arrival", consumptionGroupKey: "arrival",
            trigger: { kind: "move", locationId: loc2.id }, nextStepIds: [],
            scene: {
              segments: [{ beatId: "arrival", text: "守夜人站在门前。" }],
              event: { kind: "travel", locationId: loc2.id },
              npcLine: { npcId: npc2.id, text: "来者何人？", emotion: "guarded", usedFactIds: [], usedEventIds: [], answeredBeatIds: [] },
              objectiveLink: null,
              choiceSeeds: [
                { label: "表明身份", action: { type: "talk", npcId: npc2.id, dialogueAct: "support" } },
                { label: "先行试探", action: { type: "talk", npcId: npc2.id, dialogueAct: "challenge" } },
              ],
              source: "generated",
            },
          }],
        },
      },
    };
    const { repo, record } = createSpyRepo(world, preparedStory);

    const move = await performTurn({
      gameId: asGameId("g1"), actionId: "arrive", interaction: { kind: "fixed_choice", choiceToken: "move" }, expectedRevision: 0,
      choiceMap: new Map([["move", { type: "move", locationId: loc2.id }]]),
    }, { repository: repo, now: () => "2026-01-02" });

    expect(move.ok).toBe(true);
    const arrived = record()!;
    const presented = arrived.worldState.eventLedger.filter((event) => event.kind === "narrative_scene_presented");
    expect(presented).toHaveLength(1);
    expect(arrived.storyState.memory.recentScenes.at(-1)?.sceneEventId).toBe(presented[0]?.eventId);
    expect(presented[0]?.turnId).toBe("arrive");
    expect(presented[0]?.causeEventIds).toContain(arrived.worldState.eventLedger.find((event) => event.kind === "location_visited")?.eventId);
    if (arrived.storyState.narrative.status !== "ready") throw new Error("arrival should be ready");
    expect(arrived.storyState.narrative.currentScene.event).toEqual({ kind: "dialogue", focusNpcId: npc2.id });
    const decision = arrived.storyState.narrative.choiceRegistry[0]!;

    const response = await performTurn({
      gameId: asGameId("g1"), actionId: "arrival-response", interaction: { kind: "fixed_choice", choiceToken: decision.choiceToken }, expectedRevision: 1,
      choiceMap: new Map([[decision.choiceToken, decision.action]]),
    }, { repository: repo, now: () => "2026-01-02" });

    expect(response.ok).toBe(true);
    expect(record()!.storyState.narrative.status).toBe("provider_pending");
  });

  it("free_text 行动携带 utterance 进入 pending job", async () => {
    const { repo, record } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_2", interaction: { kind: "free_text", text: "和老板聊聊", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("和老板聊聊");
    expect(generation.job.focusNpcId).toBe("npc_1");
    // Task 5 Step 4：talk + 玩家原话 → 强制 player_utterance 节拍进入 job
    const utteranceBeat = generation.job.mandatoryBeats.find((b: PendingNarrativeJob["mandatoryBeats"][number]) => b.kind === "player_utterance");
    expect(utteranceBeat).toBeDefined();
    expect(utteranceBeat?.subjectIds).toEqual(["npc_1"]);
  });

  it("pending 期间拒绝推进世界（ack_prologue 例外仍允许尝试）", async () => {
    const ws = buildWorldState();
    const { repo, applyCalls } = createSpyRepo(ws, buildPendingStoryState());

    const rejected = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_3", interaction: { kind: "fixed_choice", choiceToken: "tok_talk" }, expectedRevision: 0, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("ACTION_REJECTED");

    const ackResult = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_4", interaction: { kind: "fixed_choice", choiceToken: "tok_ack" }, expectedRevision: 0, choiceMap: new Map([["tok_ack", { type: "ack_prologue" }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    // ack 是展示标记例外：不被 pending 栅栏拦截（无事件回合最终因无法建立 job 零写入）
    expect(ackResult.ok).toBe(false);
    expect(applyCalls()).toHaveLength(0);
  });

  it("pending 期间自由文本同样被拒绝，且零写入", async () => {
    const ws = buildWorldState();
    const { repo, applyCalls } = createSpyRepo(ws, buildPendingStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_6", interaction: { kind: "free_text", text: "和老板聊聊" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(result.feedback).toBe("正在编排下一幕，请稍候。");
    expect(applyCalls()).toHaveLength(0);
  });

  it("CAS stale 时不返回行动成功且零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_1" }, expectedRevision: 99, choiceMap: new Map([["tok_talk", talkAction]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("STALE_GAME_REVISION");
    expect(applyCalls()).toHaveLength(0);
  });

  it("unknown choice 零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "nope" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("UNKNOWN_CHOICE");
    expect(applyCalls()).toHaveLength(0);
  });

  it("未知地点是客户端行动错误，不触发世界 AI 且零写入", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_nope") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(result.failureKind).toBeUndefined();
    expect(applyCalls()).toHaveLength(0);
  });

  it("blocked（战斗中 move）→ 零写入，绝不以 success 提交", async () => {
    const ws: WorldState = {
      ...buildWorldState(),
      battle: { status: "active", enemyId: asEnemyId("enemy_1"), playerHp: 80, enemyHp: 80, round: 1 },
    };
    const { repo, applyCalls } = createSpyRepo(ws, buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_2") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("ACTION_REJECTED");
    expect(applyCalls()).toHaveLength(0);
  });

  it("非决策 ack_prologue 没有 bundle step 时零写入", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_5", interaction: { kind: "fixed_choice", choiceToken: "tok_ack" }, expectedRevision: 0, choiceMap: new Map([["tok_ack", { type: "ack_prologue" }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "NARRATIVE_CONTINUATION_MISSING" });
    expect(applyCalls()).toHaveLength(0);
    expect(record()?.revision).toBe(0);
  });

  it("没有活跃对局 → NO_ACTIVE_GAME", async () => {
    const repo: GameRepository = {
      async createInitialGame() { return { ok: true as const }; },
      async replaceCurrentGame() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
      async getCurrentGame() { return { ok: true, status: "none" }; },
      async applyState() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
      async applySceneWriteBack() { return { ok: false as const, code: "NO_ACTIVE_GAME" as const }; },
      async clearCurrentGame() { return { ok: true as const }; },
    };

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_1", interaction: { kind: "fixed_choice", choiceToken: "tok_1" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NO_ACTIVE_GAME");
  });

});

const npcStrangerChoice: Map<string, Action> = new Map([["tok_stranger", { type: "talk", npcId: asNpcId("npc_stranger"), dialogueAct: "ask" }]]);

describe("performTurn provider boundary（Task 7）", () => {
  it("未知 NPC 是客户端行动错误且零写入", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_npc", interaction: { kind: "fixed_choice", choiceToken: "tok_stranger" }, expectedRevision: 0, choiceMap: npcStrangerChoice },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
    expect(record()?.worldState.npcs.some((npc) => npc.id === "npc_stranger")).toBe(false);
  });

  it("未知地点是客户端行动错误且零写入", async () => {
    const wsMystery = buildWorldState();
    const { repo, record, applyCalls } = createSpyRepo(wsMystery, buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_exp_move", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_mystery") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
    expect(record()?.worldState.locations.some((location) => location.id === "loc_mystery")).toBe(false);
  });

  it("正式已批准 NPC 二选一创建 pending", async () => {
    const story = buildFocusedDialogueStoryState();
    const choice = firstApprovedChoice(story);
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), story);
    const legal = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_e1", interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken }, expectedRevision: 0, choiceMap: new Map([[choice.choiceToken, choice.action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );
    expect(legal.ok).toBe(true);
    if (!legal.ok) return;
    expect(legal.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);

    expect(pendingNarrative(record()!.storyState.narrative).status).toBe("provider_pending");
  });
});

// ---------------------------------------------------------------------------
// Task 9：自由文本与固定选择统一回合入口（目标 NPC 对话行为 / freeform 事件）
// ---------------------------------------------------------------------------

describe("performTurn 自由文本端到端（Task 9）", () => {
  it("rejects a non-focused target and writes nothing", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "invalid-target", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_2") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
  });

  it("rejects a missing free-text target and writes nothing", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "missing-target", interaction: { kind: "free_text", text: "我相信你" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
  });

  it("keeps location-like text addressed to the focused NPC as dialogue", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "focused-dialogue", interaction: { kind: "free_text", text: "去街道看看", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    expect(record()!.worldState.currentLocationId).toBe(asLocationId("loc_1"));
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("去街道看看");
  });

  it("accepts focused custom dialogue after entering a new location before the scene event becomes dialogue", async () => {
    const story = buildFocusedDialogueStoryState();
    if (story.narrative.status !== "ready") throw new Error("focused scene fixture missing");
    const currentScene = story.narrative.currentScene;
    const { repo, applyCalls } = createSpyRepo(buildWorldWithMainQuest(), {
      ...story,
      narrative: {
        ...story.narrative,
        currentScene: {
          ...currentScene,
          event: { kind: "travel", locationId: asLocationId("loc_1") },
        },
      },
    });

    const result = await performTurn(
      {
        gameId: asGameId("g1"),
        actionId: "focused-after-travel",
        interaction: { kind: "free_text", text: "我带来了这枚染血腰牌，你知道失踪镖队吗？", targetNpcId: asNpcId("npc_1") },
        expectedRevision: 0,
        choiceMap: new Map(),
      },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
  });

  it("lets an in-location main-objective NPC replace a stale dialogue focus for custom input", async () => {
    const secondNpc: NpcEntry = {
      ...npc1,
      id: asNpcId("npc_2"),
      name: "传讯人",
      memory: { ...npc1.memory, npcId: asNpcId("npc_2") },
    };
    const world = buildWorldState({
      npcs: [npc1, secondNpc],
      quests: [{
        id: asQuestId("quest_handoff"), name: "循迹", description: "与传讯人核对线索",
        objectives: [{ kind: "talk_to_npc", npcId: secondNpc.id }],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" }, tags: [],
        kind: "main", stage: 1, status: "active",
      }],
    });
    const { repo, record, applyCalls } = createSpyRepo(world, buildFocusedDialogueStoryState(npc1.id));

    const result = await performTurn(
      {
        gameId: asGameId("g1"), actionId: "handoff-custom-input",
        interaction: { kind: "free_text", text: "我带来了腰牌，请把你亲眼看见的经过说清楚。", targetNpcId: secondNpc.id },
        expectedRevision: 0, choiceMap: new Map(),
      },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status === "provider_pending") expect(generation.job.focusNpcId).toBe(secondNpc.id);
  });

  it("同一 NPC 连续两个 ready 场景的自定义输入使用不同 actionId，各自形成记忆与 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const first = await performTurn(
      { gameId: asGameId("g1"), actionId: "uuid-1", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const afterFirst = record()!;
    const sceneWrite = await repo.applySceneWriteBack({
      gameId: afterFirst.gameId,
      expectedRevision: afterFirst.revision,
      nextWorldState: afterFirst.worldState,
      nextStoryState: {
        ...afterFirst.storyState,
        narrative: {
          status: "ready",
          mode: "ai",
          currentScene: {
            sceneId: "scene-1",
            turn: 1,
            narration: "老板等着你的下一句话。",
            usedFactIds: [],
            npcLine: { npcId: asNpcId("npc_1"), text: "请继续。", emotion: "neutral", usedFactIds: [], usedEventIds: [] },
            choices: [
              { choiceToken: "tok-1", label: "继续询问" },
              { choiceToken: "tok-2", label: "提出质疑" },
            ],
            source: "fixture",
            event: { kind: "dialogue", focusNpcId: asNpcId("npc_1") },
          },
          choiceRegistry: [],
        },
        candidateEventPool: afterFirst.storyState.candidateEventPool,
      },
    });
    expect(sceneWrite.ok).toBe(true);
    if (!sceneWrite.ok) return;

    const second = await performTurn(
      { gameId: asGameId("g1"), actionId: "uuid-2", interaction: { kind: "free_text", text: "你在撒谎", targetNpcId: asNpcId("npc_1") }, expectedRevision: sceneWrite.record.revision, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-03" },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const saved = record()!;
    const history = saved.worldState.npcs.find((npc) => npc.id === asNpcId("npc_1"))!.memory.interactionHistory;
    expect(history.map((entry) => entry.actionId)).toEqual(["uuid-1", "uuid-2"]);
    expect(new Set(history.map((entry) => entry.actionId)).size).toBe(2);
    expect(saved.storyState.turnNumber).toBe(2);

    expect(applyCalls()).toHaveLength(2);
    const pendingJobs = applyCalls().map((call) => pendingNarrative(call.nextStoryState.narrative));
    expect(pendingJobs.every((generation) => generation.status === "provider_pending")).toBe(true);
    expect(pendingJobs.map((generation) => generation.status === "provider_pending" ? generation.job.actionId : null)).toEqual(["uuid-1", "uuid-2"]);
    expect(pendingJobs.map((generation) => generation.status === "provider_pending" ? generation.job.turnId : null)).toEqual(["uuid-1", "uuid-2"]);
  });

  it("短问候也提交真实回合，并在 CAS 后留下可生成回应的 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "uuid-greeting", interaction: { kind: "free_text", text: "嗨", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    const saved = record()!;
    expect(saved.storyState.turnNumber).toBe(1);
    expect(saved.worldState.npcs[0]!.memory.interactionHistory).toHaveLength(1);
    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.actionId).toBe("uuid-greeting");
    expect(generation.job.utterance).toBe("嗨");
  });

  it("自定义输入按中性 ask 规则结算并创建 pending job", async () => {
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_sup", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision).toBe(1);
    expect(applyCalls()).toHaveLength(1);

    const saved = record()!;
    const npc = saved.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    expect(npc.met).toBe(true);
    // 自定义输入不在本地解析情感/意图；按中性 ask 结算。
    expect(npc.memory.relationship.affinity).toBe(0);
    expect(npc.memory.emotion).toBe("neutral");
    expect(npc.memory.interactionHistory[0]!.relationshipDelta).toBe(0);
    expect(npc.memory.interactionHistory[0]!.summary).toContain("关系+0");

    const generation = pendingNarrative(saved.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.actionSummary).toEqual({ kind: "talk", npcId: "npc_1" });
    expect(generation.job.utterance).toBe("我相信你");
    expect(generation.job.focusNpcId).toBe("npc_1");
  });

  it("不同自定义措辞不触发本地意图分类，使用同一中性 ask 结算", async () => {
    const supportRepo = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());
    const sup = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_sup", interaction: { kind: "free_text", text: "我相信你", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: supportRepo.repo, now: () => "2026-01-02" },
    );
    expect(sup.ok).toBe(true);

    const challengeRepo = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());
    const cha = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_cha", interaction: { kind: "free_text", text: "你在撒谎", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: challengeRepo.repo, now: () => "2026-01-02" },
    );
    expect(cha.ok).toBe(true);
    if (!cha.ok) return;

    const supportNpc = supportRepo.record()!.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    const challengeNpc = challengeRepo.record()!.worldState.npcs.find((n) => n.id === asNpcId("npc_1"))!;
    expect(challengeNpc.memory.relationship.affinity).toBe(0);
    expect(challengeNpc.memory.relationship.affinity).toBe(supportNpc.memory.relationship.affinity);
    expect(challengeNpc.memory.interactionHistory[0]!.relationshipDelta).toBe(0);
    expect(supportNpc.memory.interactionHistory[0]!.relationshipDelta).toBe(0);
    const chaGen = pendingNarrative(challengeRepo.record()!.storyState.narrative);
    expect(chaGen.status).toBe("provider_pending");
    if (chaGen.status !== "provider_pending") return;
    expect(chaGen.job.resolvedEvent.triggeredEvents).toContain("npc_met");
  });

  it("没有权威 NPC 目标的自由输入被拒绝", async () => {
    const { repo, applyCalls } = createSpyRepo(buildWorldState(), buildStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_free", interaction: { kind: "free_text", text: "我的等级升到100" }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "ACTION_REJECTED" });
    expect(applyCalls()).toHaveLength(0);
  });

  it("遗留意图源不参与自由输入；合法输入仍创建 pending", async () => {
    const legacyIntentSource = { async parseIntent() { throw new Error("must not run"); } };
    const { repo, record, applyCalls } = createSpyRepo(buildWorldState(), buildFocusedDialogueStoryState());

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_fail", interaction: { kind: "free_text", text: "我的武功升到一百级", targetNpcId: asNpcId("npc_1") }, expectedRevision: 0, choiceMap: new Map() },
      { repository: repo, now: () => "2026-01-02", intentParserSource: legacyIntentSource },
    );

    expect(result.ok).toBe(true);
    expect(applyCalls()).toHaveLength(1);
    expect(pendingNarrative(record()!.storyState.narrative).job.utterance).toBe("我的武功升到一百级");
  });
});

// ---------------------------------------------------------------------------
// Task 4：performTurn 在提交前把规则结果/任务变化转成 objectiveTransition 与
// mandatoryBeats，并随 pending job 一起持久化（非占位值）。
// ---------------------------------------------------------------------------

describe("performTurn 叙事节拍与目标转换（Task 4）", () => {
  it("目标推进回合：job 携带真实 objectiveTransition（before/completed/after）与 quest_progress 节拍", async () => {
    const story = buildFocusedAskDialogueStoryState();
    const choice = firstApprovedChoice(story);
    const { repo, record, applyCalls } = createSpyRepo(buildWorldWithMainQuest(), story);

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_quest", interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken }, expectedRevision: 0, choiceMap: new Map([[choice.choiceToken, choice.action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const generation = pendingNarrative(record()!.storyState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;

    // 完成 talk 目标 → progressed：completed 记录旧目标，after 指向下一个未完成目标
    expect(generation.job.objectiveTransition.mode).toBe("progressed");
    expect(generation.job.objectiveTransition.before).toEqual({ questId: "quest_0", objectiveIndex: 0, label: "与老板交谈" });
    expect(generation.job.objectiveTransition.completed).toEqual([{ questId: "quest_0", objectiveIndex: 0, label: "与老板交谈" }]);
    expect(generation.job.objectiveTransition.after).toEqual({ questId: "quest_0", objectiveIndex: 1, label: "获取盟誓印谱" });
    // 本回合真实产出的节拍：subjectIds 引用实体 ID，instruction 来自当前状态
    expect(generation.job.mandatoryBeats).toContainEqual(expect.objectContaining({
      kind: "quest_progress",
      subjectIds: ["quest_0"],
      instruction: expect.stringContaining("与老板交谈"),
    }));
  });

  it("非决策行动不消费候选事件，也不写入规则场景", async () => {
    const enemyWs = buildWorldState({
      enemies: [{
        id: asEnemyId("enemy_1"), name: "山贼", tier: "normal",
        stats: { hp: 10, attack: 5, defense: 2 },
        locationId: asLocationId("loc_1"), tags: [],
      }],
    });
    const candidate: EventCandidate = {
      id: "ce-1",
      kind: "enemy_appears",
      involvedEntityIds: ["enemy_1", "loc_1"],
      prerequisiteFactIds: [],
      proposedEffects: [{ kind: "enemy_appears", enemyId: asEnemyId("enemy_1"), locationId: asLocationId("loc_1") }],
      intendedPacing: "complicate",
      reason: "敌人在客栈现身",
      proposedAtTurn: 1,
      expiresAtTurn: 9,
    };
    const ss = { ...buildStoryState(), candidateEventPool: [candidate] };
    const { repo, applyCalls } = createSpyRepo(enemyWs, ss);

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_battle", interaction: { kind: "fixed_choice", choiceToken: "tok_move" }, expectedRevision: 0, choiceMap: new Map([["tok_move", { type: "move", locationId: asLocationId("loc_2") }]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result).toMatchObject({ ok: false, code: "NARRATIVE_CONTINUATION_MISSING" });
    expect(applyCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 3：规则层自动揭示——NPC 交接后同一回合自动发现无 approach 的必经事实，
// 与 npc_met/quest_completed 一起在单次 CAS 提交，job 覆盖完整 domainEventIds。
// ---------------------------------------------------------------------------

describe("performTurn — 自动揭示必经事实（Task 3）", () => {
  it("交谈完成交接后同回合自动发现事实并完成任务，单次 CAS 且 job 覆盖自动事件", async () => {
    const FACT_1_ID = asFactId("fact_1");
    const world = buildWorldState({
      worldFacts: [{ factId: FACT_1_ID, text: "车轮印", source: "generated", discovered: false, locationId: asLocationId("loc_1") }],
      quests: [{
        id: asQuestId("quest_0"), name: "查明真相", description: "查清车轮印的来路",
        objectives: [
          { kind: "talk_to_npc", npcId: asNpcId("npc_1") },
          { kind: "discover_fact", factId: FACT_1_ID },
        ],
        onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        tags: [], kind: "main", stage: 1, status: "active",
      }],
    });
    const story = buildFocusedAskDialogueStoryState();
    const choice = firstApprovedChoice(story);
    const { repo, applyCalls } = createSpyRepo(world, story);

    const result = await performTurn(
      { gameId: asGameId("g1"), actionId: "act_handoff", interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken }, expectedRevision: 0, choiceMap: new Map([[choice.choiceToken, choice.action]]) },
      { repository: repo, now: () => "2026-01-02" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(applyCalls()).toHaveLength(1);
    const applied = applyCalls()[0]!;
    // 事实发现、任务完成与 npc_met 同回合按序落账（自动事件无 approach 元数据）
    expect(applied.nextWorldState.eventLedger.map((event) => event.kind)).toEqual([
      "game_initialized", "npc_interaction_recorded", "npc_met", "fact_discovered", "quest_completed",
    ]);
    const autoEvent = applied.nextWorldState.eventLedger.find((event) => event.kind === "fact_discovered");
    if (autoEvent?.payload.type === "fact_discovered") {
      expect(autoEvent.payload.factId).toBe(FACT_1_ID);
      expect(autoEvent.payload.approachId).toBeUndefined();
      expect(autoEvent.payload.evidenceQuality).toBeUndefined();
      expect(autoEvent.payload.tensionDelta).toBeUndefined();
    }
    expect(applied.nextWorldState.worldFacts[0]?.discovered).toBe(true);
    expect(applied.nextWorldState.quests[0]?.status).toBe("completed");
    // pending job 覆盖本回合全部 3 个新事件（base ledger 长度为 1）
    const generation = pendingNarrative(applied.nextStoryState.narrative);
    expect(generation.status).toBe("provider_pending");
    if (generation.status !== "provider_pending") return;
    expect(generation.job.domainEventIds).toEqual([
      "act_handoff:npc_interaction_recorded:npc_1:act_handoff",
      "act_handoff:npc_met:npc_1",
      "act_handoff:fact_discovered:fact_1",
      "act_handoff:quest_completed:quest_0",
    ]);
  });
});

import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";
import { projectGameSessionView } from "./gameSessionView";

describe("NPC 赠物与对话同次提交", () => {
  function fixture(acquisition: "scene" | "npc_gift") {
    const itemId = asItemId("item_gift");
    const world = buildWorldState({
      npcs: [{ ...npc1, met: true }],
      locations: [{ ...loc1, availableItemIds: [itemId] }, loc2],
      items: [{ id: itemId, name: "密信", description: "记录线索的信", kind: "quest", tags: [] }],
      enemies: [{ id: asEnemyId("gift_guard"), name: "拦路人", locationId: loc1.id, tier: "normal", stats: { hp: 20, attack: 5, defense: 2 }, tags: [] }],
      quests: [{ id: asQuestId("quest_gift"), name: "追查信物", description: "获得信物并处理拦路人", kind: "main", stage: 1, status: "active", tags: [], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        objectives: [{ kind: "talk_to_npc", npcId: npc1.id }, { kind: "obtain_item", itemId, ...(acquisition === "npc_gift" ? { giftFromNpcId: npc1.id } : {}) }, { kind: "defeat_enemy", enemyId: asEnemyId("gift_guard") }, { kind: "talk_to_npc", npcId: npc1.id }] }],
    });
    const changed = acquisition === "npc_gift" ? applyEntityMutations(world, [{ kind: "transfer_item", itemId, owner: { kind: "npc", npcId: npc1.id } }]) : { ok: true as const, worldState: world };
    if (!changed.ok) throw new Error("gift fixture ownership failed");
    const base = buildFocusedDialogueStoryState();
    if (base.narrative.status !== "ready") throw new Error("not ready");
    const story: StoryState = { ...base, reveal: { questId: asQuestId("quest_gift"), visibleObjectiveIndex: 0 }, narrative: {
      ...base.narrative, mode: "ai", currentScene: { ...base.narrative.currentScene, source: "generated" },
      dialogueSession: { npcId: npc1.id, turnCount: 1, requiredTurns: 2, completed: false },
    } };
    return { world: changed.worldState, story, itemId };
  }
  it.each(["scene", "npc_gift"] as const)("%s 在真实对白请求内保持取物方式，并仅提交一次", async acquisition => {
    const before = fixture(acquisition);
    const saved = createSpyRepo(before.world, before.story);
    const token = firstApprovedChoice(before.story).choiceToken;
    const command = { gameId: asGameId("g1"), actionId: "finish-gift-dialogue", expectedRevision: 0, choiceMap: buildChoiceMap(before.world, before.story, 0), interaction: { kind: "fixed_choice" as const, choiceToken: token } };
    expect(projectGameSessionView(before.world, before.story, 0, "gift").obtainableItems).toEqual([]);
    const result = await performTurn(command, { repository: saved.repo, now: () => "2026-01-01T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    expect(saved.applyCalls()).toHaveLength(1);
    const record = saved.record()!;
    expect(record.worldState.inventory).toEqual(acquisition === "npc_gift" ? [before.itemId] : []);
    expect(record.storyState.turnNumber).toBe(before.story.turnNumber + 1);
    expect(record.storyState.memory).toEqual(rebuildEpisodicMemory(record.worldState.eventLedger));
    const pending = pendingNarrative(record.storyState.narrative);
    expect(pending.job.actionSummary).toEqual({ kind: "talk", npcId: npc1.id });
    const beats = pending.job.mandatoryBeats.filter(beat => beat.kind === "item_obtained");
    if (acquisition === "npc_gift") {
      expect(beats).toContainEqual(expect.objectContaining({ subjectIds: [before.itemId, npc1.id], instruction: "老板将「密信」交给你" }));
      expect(pending.job.objectiveTransition.after?.objectiveIndex).toBe(2);
      expect(record.worldState.eventLedger.filter(event => event.kind === "item_obtained")).toHaveLength(1);
    } else {
      expect(beats).toEqual([]);
      expect(pending.job.objectiveTransition.after?.objectiveIndex).toBe(1);
    }
    const graph = buildNarrativeBundleDescriptors({ worldState: record.worldState, storyState: record.storyState, transition: pending.job.objectiveTransition });
    expect(graph.steps.some(step => step.trigger.kind === "take_item")).toBe(acquisition === "scene");
    expect(await performTurn(command, { repository: saved.repo, now: () => "2026-01-01T00:00:00.000Z" })).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
    expect(saved.applyCalls()).toHaveLength(1);
  });
  it("赠物对白 CAS 冲突后保留原 NPC 归属、回合与叙事", async () => {
    const before = fixture("npc_gift");
    const saved = createSpyRepo(before.world, before.story);
    let writes = 0;
    const repo: GameRepository = { ...saved.repo, async applyState() { writes += 1; return { ok: false, code: "STALE_GAME_REVISION" }; } };
    const result = await performTurn({ gameId: asGameId("g1"), actionId: "gift-conflict", expectedRevision: 0, choiceMap: buildChoiceMap(before.world, before.story, 0), interaction: { kind: "fixed_choice", choiceToken: firstApprovedChoice(before.story).choiceToken } }, { repository: repo, now: () => "2026-01-01T00:00:00.000Z" });
    expect(result).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
    expect(writes).toBe(1);
    expect(saved.record()!.worldState).toEqual(before.world);
    expect(saved.record()!.storyState).toEqual(before.story);
  });
});

import { createTownRuntime, bindNpcToTownSlot } from "@/game/gameplay/rpg/town";
import { approveNarrativeBundle } from "./approveNarrativeBundle";
import { commitEventDrafts } from "@/game/domain/eventLedger";
import type { NarrativeBundleProposal } from "@/game/domain/narrativeBundle";

describe("生产城镇建筑到达续接", () => {
  it("从生产 descriptor 审批事实首步，opaque 建筑进入同次发现连续事实并显示已生成对白", async () => {
    const town = bindNpcToTownSlot(createTownRuntime({ locationId: loc1.id, seed: "fact-arrival" }), npc1.id).town;
    const factIds = [asFactId("town_tracks"), asFactId("town_seal")];
    const questId = asQuestId("town_fact_quest");
    const world = buildWorldState({
      locations: [{ ...loc1, scale: "town", town }, loc2],
      worldFacts: factIds.map((factId, index) => ({ factId, text: `现场线索${index}`, source: "generated", discovered: false, locationId: loc1.id })),
      quests: [{ id: questId, name: "进入现场", description: "查明两条线索后听取口供", kind: "main", stage: 1, status: "active", tags: [], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" },
        objectives: [...factIds.map(factId => ({ kind: "discover_fact" as const, factId })), { kind: "talk_to_npc", npcId: npc1.id }] }],
    });
    const base = buildFocusedDialogueStoryState();
    const story: StoryState = { ...base, reveal: { questId, visibleObjectiveIndex: 0 } };
    const transition = { before: null, completed: [], after: { questId, objectiveIndex: 0, label: "进入现场" }, mode: "progressed" as const };
    const graph = buildNarrativeBundleDescriptors({ worldState: world, storyState: story, transition });
    expect(graph.steps.map(step => step.trigger.kind)).toEqual(["explore"]);
    expect(graph.currentChoiceCandidates).toEqual([]);
    const proposal: NarrativeBundleProposal = {
      worldDelta: null,
      currentScene: { segments: [{ beatId: "atmosphere", text: "老板请你到屋内查看。" }], npcLine: null, objectiveLink: { questId, objectiveIndex: 0, mode: "hint" }, choices: [] },
      continuationScenes: graph.steps.map(step => ({ stepKey: step.stepKey, scene: {
        segments: [{ beatId: "atmosphere", text: "屋内的脚印与印痕证实了来者的路线。" }],
        npcLine: { npcId: npc1.id, text: "你已经看见线索了，现在可以问我。", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
        objectiveLink: { questId, objectiveIndex: step.authority.objectiveIndex, mode: "progress" },
        choices: step.choiceCandidates.map((candidate, index) => ({ candidateId: candidate.candidateId, label: index === 0 ? "请说出实情。" : "请解释这些痕迹。" })),
      } })),
      terminal: graph.terminal,
    };
    const eventSource = { turnId: asTurnId("town-generation"), actionId: "town-generation", turnNumber: 0, committedAt: "2026-01-01T00:00:00.000Z" };
    const approved = approveNarrativeBundle({ proposal, worldState: world, storyState: story, transition, evolutionNeed: { kind: "none" }, jobId: asNarrativeJobId("town-arrival"), basedOnRevision: 0, mandatoryBeats: [],
      eventContext: { ...eventSource, domainEventIds: [], episodeKey: "town-generation" }, now: () => eventSource.committedAt });
    expect(approved.ok).toBe(true);
    if (!approved.ok) throw new Error(approved.code);
    const committed = commitEventDrafts({ ledger: world.eventLedger, drafts: approved.approved.eventDrafts, source: eventSource, entityStore: approved.approved.nextWorldState.entityStore });
    if (!committed.ok) throw new Error(committed.code);
    const readyWorld = { ...approved.approved.nextWorldState, eventLedger: committed.ledger };
    const readyStory: StoryState = { ...approved.approved.nextStoryStatePreview, narrative: { status: "ready", mode: "ai", currentScene: approved.approved.currentScene, choiceRegistry: approved.approved.choiceRegistry, narrativeBundle: approved.approved.bundle } };
    const beforeView = projectGameSessionView(readyWorld, readyStory, 0, "town");
    expect(beforeView.currentLocation.actions.some(choice => choice.presentation === "explore" || choice.presentation === "investigate")).toBe(false);
    const token = beforeView.currentLocation.town!.interactiveBuildings.find(building => building.npcId === npc1.id)!.arrivalChoiceToken!;
    expect(token).toBeDefined();
    const saved = createSpyRepo(readyWorld, readyStory);
    const result = await performTurn({ gameId: asGameId("g1"), actionId: "enter-approved-building", expectedRevision: 0, choiceMap: buildChoiceMap(readyWorld, readyStory, 0), interaction: { kind: "fixed_choice", choiceToken: token } }, { repository: saved.repo, now: () => eventSource.committedAt });
    expect(result.ok).toBe(true);
    expect(saved.applyCalls()).toHaveLength(1);
    const after = saved.record()!;
    expect(after.worldState.worldFacts.every(fact => fact.discovered)).toBe(true);
    expect(after.worldState.eventLedger.filter(event => event.kind === "fact_discovered")).toHaveLength(2);
    expect(after.storyState.narrative.status).toBe("ready");
    expect(after.storyState.turnNumber).toBe(story.turnNumber + 1);
    const afterView = projectGameSessionView(after.worldState, after.storyState, after.revision, "town");
    const dialogue = afterView.narrative.npcDialogues.find(entry => entry.npcId === npc1.id)!;
    expect(dialogue.speechPages.join("")).toContain("你已经看见线索了");
    expect(dialogue.choices).toHaveLength(2);
    expect(dialogue.choices.every(choice => buildChoiceMap(after.worldState, after.storyState, after.revision).has(choice.choiceToken))).toBe(true);
    expect(afterView.currentLocation.town!.interactiveBuildings.every(building => building.arrivalChoiceToken === undefined)).toBe(true);
  });
});

describe("opening dialogue intent persistence boundaries", () => {
  function sameActStory(): StoryState {
    const base = buildFocusedDialogueStoryState();
    if (base.narrative.status !== "ready") throw new Error("not ready");
    const choices = [
      createApprovedChoice({ sceneId: base.narrative.currentScene.sceneId, basedOnRevision: 0, label: "问任务", action: { type: "talk", npcId: npc1.id, dialogueAct: "ask", topic: { kind: "quest", questId: asQuestId("quest_0") } } }),
      createApprovedChoice({ sceneId: base.narrative.currentScene.sceneId, basedOnRevision: 0, label: "问问题", action: { type: "talk", npcId: npc1.id, dialogueAct: "ask", topic: { kind: "thread", threadId: "thread_init_problem" } } }),
    ];
    if (!choices[0].ok || !choices[1].ok) throw new Error("choice invalid");
    const approved = [choices[0].choice, choices[1].choice];
    return { ...base, narrative: { ...base.narrative, currentScene: { ...base.narrative.currentScene, choices: approved.map((choice) => ({ choiceToken: choice.choiceToken, label: choice.label })) }, choiceRegistry: approved } };
  }

  it("same act with different topics creates distinct tokens and preserves each job topic", async () => {
    const story = sameActStory();
    if (story.narrative.status !== "ready") throw new Error("not ready");
    expect(new Set(story.narrative.currentScene.choices.map((choice) => choice.choiceToken)).size).toBe(2);
    const topics: unknown[] = [];
    for (const choice of story.narrative.currentScene.choices) {
      const saved = createSpyRepo(buildWorldWithMainQuest(), story);
      const result = await performTurn({ gameId: asGameId("g1"), actionId: choice.choiceToken, expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken }, choiceMap: buildChoiceMap(saved.record()!.worldState, story, 0) }, { repository: saved.repo, now: () => "2026-09-09" });
      if (!result.ok) throw new Error(JSON.stringify(result));
      topics.push(pendingNarrative(saved.record()!.storyState.narrative).job.selectedDialogue?.topic);
    }
    expect(topics).toEqual([{ kind: "quest", questId: "quest_0" }, { kind: "thread", threadId: "thread_init_problem" }]);
  });

  it("invalid token and CAS failure persist no history; retrying the same command is idempotent", async () => {
    const story = sameActStory();
    const world = buildWorldWithMainQuest();
    const saved = createSpyRepo(world, story);
    expect(await performTurn({ gameId: asGameId("g1"), actionId: "bad", expectedRevision: 0, interaction: { kind: "fixed_choice", choiceToken: "bad" }, choiceMap: new Map() }, { repository: saved.repo, now: () => "2026-09-09" })).toMatchObject({ ok: false, code: "UNKNOWN_CHOICE" });
    expect(saved.record()!.worldState.eventLedger).toEqual(world.eventLedger);
    if (story.narrative.status !== "ready") throw new Error("not ready");
    const token = story.narrative.currentScene.choices[0]!.choiceToken;
    const command = { gameId: asGameId("g1"), actionId: "same-job", expectedRevision: 0, interaction: { kind: "fixed_choice" as const, choiceToken: token }, choiceMap: buildChoiceMap(world, story, 0) };
    const beforeCas = saved.record()!;
    const staleRepository: GameRepository = { ...saved.repo, async applyState() { return { ok: false, code: "STALE_GAME_REVISION" }; } };
    expect(await performTurn(command, { repository: staleRepository, now: () => "2026-09-09" })).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
    expect(saved.record()).toEqual(beforeCas);
    const first = await performTurn(command, { repository: saved.repo, now: () => "2026-09-09" });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const after = saved.record()!.worldState.eventLedger;
    expect(await performTurn(command, { repository: saved.repo, now: () => "2026-09-09" })).toMatchObject({ ok: false, code: "STALE_GAME_REVISION" });
    expect(saved.record()!.worldState.eventLedger).toEqual(after);
  });
});
