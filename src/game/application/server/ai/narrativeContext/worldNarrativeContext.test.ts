import { describe, expect, it } from "vitest";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import {
  asEnemyId,
  asFactId,
  asGenerationId,
  asItemId,
  asLocationId,
  asNpcId,
  asQuestId,
} from "@/game/domain/worldEntity";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity/entityProjection";
import { createWorldStateFixture } from "@/game/domain/testing/worldStateFixture.testutil";
import type { WorldEvolutionSourceContext } from "@/game/application/worldEvolutionSource";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { compileWorldNarrativeContext } from "./worldNarrativeContext";
import { asEventId } from "@/game/domain/events";
import { asTurnId } from "@/game/domain/events";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { createMainStoryThread } from "@/game/domain/storyThreads";

function makeWorldContext(need: EvolutionNeed) {
  const locA = asLocationId("loc_a");
  const locB = asLocationId("loc_b");
  const npcId = asNpcId("npc_1");
  const itemId = asItemId("item_1");
  const enemyId = asEnemyId("enemy_1");
  const questId = asQuestId("quest_1");
  const publicFactId = asFactId("fact_public");
  const hiddenFactId = asFactId("fact_hidden");
  const unrevealedFactId = asFactId("fact_UNREVEALED_ID_MARKER");

  const generation: GenerationMetadata = {
    generationId: asGenerationId("gen_world_context"),
    seed: "world-context-seed",
    templateVersion: "v2",
    inputDigest: "digest",
    gameType: "wuxia",
    setup: {
      characterName: "沈青",
      characterIdentity: "落魄镖师",
      personalityTags: ["谨慎"],
      worldPremise: "江湖镖局与门派暗线交错，失踪的镖银牵动各方势力。",
      storyOpening: "沈青在山城客栈接到追查失踪商队的委托。",
      narrativeStyle: "cinematic",
      contentIntensity: "normal",
    },
  };

  const projection: EntityCompatibilityProjection = {
    player: { name: "沈青", identity: "落魄镖师", stats: { hp: 100, attack: 10, defense: 8 } },
    locations: [
      {
        id: locA,
        name: "客栈",
        description: "雨夜中的山城客栈。",
        kind: "main",
        connectedLocationIds: [locB],
        npcIds: [npcId],
        availableItemIds: [itemId],
        tags: ["山城"],
        scale: "scene",
      },
      {
        id: locB,
        name: "北巷",
        description: "通往旧码头的狭窄巷道。",
        kind: "hidden",
        connectedLocationIds: [locA],
        npcIds: [],
        availableItemIds: [],
        tags: ["线索"],
        scale: "scene",
      },
    ],
    currentLocationId: locA,
    unlockedLocationIds: [locA, locB],
    visitedLocationIds: [locA],
    npcs: [{
      id: npcId,
      name: "老板",
      role: "客栈掌柜",
      description: "熟悉来往客商的掌柜。",
      locationId: locA,
      isCompanion: false,
      tags: ["客栈"],
      met: true,
      memory: {
        npcId,
        knownFactIds: [publicFactId],
        hiddenFactIds: [hiddenFactId],
        interactionHistory: [{ eventId: asEventId("evt:test:action_private:4"), turnNumber: 4,
          actionId: "action_private",
          locationId: locA,
          dialogueAct: "ask",
          topicSummary: "PRIVATE_INTERACTION_MEMORY_MARKER",
          outcome: "neutral",
          relationshipDelta: 2,
          learnedFactIds: [publicFactId],
          summary: "PRIVATE_INTERACTION_MEMORY_MARKER",
        }],
        relationship: { affinity: 42 },
        emotion: "guarded",
        goals: ["守住客栈声誉"],
      },
    }],
    items: [{
      id: itemId,
      name: "账册",
      description: "记录货运去向的旧账册。",
      kind: "quest",
      tags: ["证物"],
    }],
    inventory: [],
    worldFacts: [
      {
        factId: publicFactId,
        text: "Fact discovered: fact_public，商队最后在北巷卸货。",
        source: "generated",
        discovered: true,
        locationId: locA,
      },
      {
        factId: hiddenFactId,
        text: "掌柜私下替内应传递密信。",
        source: "generated",
        discovered: false,
        locationId: locA,
      },
      {
        factId: unrevealedFactId,
        text: "尚未发现的账册夹层暗记。",
        source: "generated",
        discovered: false,
        locationId: locA,
      },
    ],
    quests: [{
      id: questId,
      name: "追查失踪商队",
      description: "从客栈账册和北巷痕迹中找出商队下落。",
      objectives: [{ kind: "talk_to_npc", npcId }],
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: ["主线"],
      kind: "main",
      stage: 2,
      status: "active",
    }],
    enemies: [{
      id: enemyId,
      name: "拦路人",
      tier: "normal",
      stats: { hp: 25, attack: 8, defense: 4 },
      locationId: locB,
      tags: ["埋伏"],
    }],
    defeatedEnemyIds: [],
    factions: [],
  };

  return {
    worldState: createWorldStateFixture({ generation, projection }),
    storyState: {
      version: 11,
      turnNumber: 7,
      currentAct: 2,
      targetActs: 3,
      storyProgress: 48,
      tension: 55,
      nextPacingNeed: "complicate",
      budget: {
        locations: { opening: 1, expanded: 1, max: 8 },
        npcs: { opening: 1, expanded: 0, max: 10 },
        quests: { opening: 1, expanded: 0, max: 4 },
        events: { opening: 1, expanded: 2, max: 6 },
        hardLimit: { locations: 40, npcs: 30 },
      },
      threads: [createMainStoryThread("merchant_caravan")],
      unresolvedThreads: ["merchant_caravan"],
      candidateEventPool: [],
      endingAllowed: false,
      endingProposed: false,
      narrative: createFixtureNarrativeRuntimeState(),
      prologueShown: true,
      prologueText: "",
      memory: rebuildEpisodicMemory([
        makeCommittedEvent({ type: "fact_discovered", factId: publicFactId }, {
          turnId: asTurnId("turn:6"),
          eventId: asEventId("turn:6:fact_discovered"),
          turnNumber: 6,
          locationId: locA,
          factIds: [publicFactId],
        }),
      ]),
      history: { entries: [] },
      contract: {
        version: 1,
        targetActs: 3,
        centralConflict: "镖银失踪牵出门派内应",
        endingDirections: [
          { key: "trust", theme: "与同伴共担真相" },
          { key: "doubt", theme: "独自揭露阴谋" },
        ],
      },
      evolution: {
        nextLocationOrdinal: 2,
        nextNpcOrdinal: 1,
        nextItemOrdinal: 1,
        nextEnemyOrdinal: 1,
        nextFactOrdinal: 2,
        nextQuestOrdinal: 1,
        nextEndingOrdinal: 0,
        status: "needs_next_act",
      },
      reveal: { questId, visibleObjectiveIndex: 0 },
    },
    need,
    reason: "scene_evolution",
    action: { type: "investigate", factId: unrevealedFactId, approachId: "inspect_ledger" },
  } satisfies WorldEvolutionSourceContext;
}

describe("worldNarrativeContext", () => {
  it("next_act Prompt 包含 story contract、节奏、近期事件、活动任务和实体索引", () => {
    const prompt = compileWorldNarrativeContext(makeWorldContext({ kind: "next_act", act: 3 })).prompt;
    expect(prompt).toContain("镖银失踪牵出门派内应");
    expect(prompt).toContain("currentAct=2");
    expect(prompt).toContain("tension=55");
    expect(prompt).toContain("complicate");
    expect(prompt).toContain("追查失踪商队");
    expect(prompt).toContain("fact_discovered");
    expect(prompt).toContain("loc_a=客栈");
    expect(prompt).toContain("npc_1=老板");
  });

  it("next_act 声明全部增量字段、要求 nextMainQuest 并禁止 endingPair", () => {
    const prompt = compileWorldNarrativeContext(makeWorldContext({ kind: "next_act", act: 3 })).prompt;
    for (const field of ["newLocation", "newNpc", "newItem", "newEnemy", "newFact", "nextMainQuest"]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain('必须输出一个 placement="world" 的 newLocation');
    expect(prompt).toContain("不能直接叙述中心冲突已解决或写出结局");
    expect(prompt).toContain("只有对应剩余容量大于 0 才能输出");
    expect(prompt).toContain("endingPair 字段必须完全省略");
  });

  it("ending_pair 要求恰好 trust/doubt 并禁止 nextMainQuest", () => {
    const prompt = compileWorldNarrativeContext(makeWorldContext({ kind: "ending_pair", finalAct: 3 })).prompt;
    expect(prompt).toContain('"themeKey":"trust"');
    expect(prompt).toContain('"themeKey":"doubt"');
    expect(prompt).toContain("nextMainQuest 字段必须完全省略");
  });

  it("pacing 只允许一个必要实体或事实并禁止任务和结局", () => {
    const prompt = compileWorldNarrativeContext(makeWorldContext({ kind: "pacing", pacingNeed: "complicate" })).prompt;
    expect(prompt).toContain("只补充一个必要的新实体或事实");
    expect(prompt).toContain("nextMainQuest 和 endingPair");
    expect(prompt).toContain("必须完全省略");
  });

  it("事实 schema 声明 investigationLabel 与 2-3 条调查方式合法字段", () => {
    const prompt = compileWorldNarrativeContext(makeWorldContext({ kind: "next_act", act: 3 })).prompt;
    expect(prompt).toContain("investigationLabel");
    expect(prompt).toContain("investigationApproaches");
    expect(prompt).toContain('"evidenceQuality":"clean或noisy"');
    expect(prompt).toContain("tensionDelta=-5..20");
  });

  it("Prompt 不含账本、NPC 私密记忆、交互历史或裸关系值", () => {
    const prompt = compileWorldNarrativeContext(makeWorldContext({ kind: "next_act", act: 3 })).prompt;
    expect(prompt).not.toContain("eventLedger");
    expect(prompt).not.toContain("PRIVATE_INTERACTION_MEMORY_MARKER");
    expect(prompt).not.toContain("hiddenFactIds");
    expect(prompt).not.toContain("interactionHistory");
    expect(prompt).not.toContain("affinity=");
    expect(prompt).not.toContain("fact_hidden");
    expect(prompt).not.toContain("UNREVEALED_ID_MARKER");
    expect(prompt).not.toContain("掌柜私下替内应传递密信");
    expect(prompt).toContain("fact_public");
    expect(JSON.stringify(compileWorldNarrativeContext(makeWorldContext({ kind: "next_act", act: 3 })).manifest))
      .not.toContain("fact_hidden");
    expect(JSON.stringify(compileWorldNarrativeContext(makeWorldContext({ kind: "next_act", act: 3 })).manifest))
      .not.toContain("UNREVEALED_ID_MARKER");
  });
});
