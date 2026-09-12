import { describe, it, expect } from "vitest";
import { compileOpeningGenerationCandidate, compileOpeningStructure } from "./compileOpeningGenerationCandidate";
import { validateOpeningGenerationCandidate } from "./validateOpeningGenerationCandidate";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { StoryState } from "@/game/domain/storyState";
import { asGenerationId, asLocationId, asNpcId, asQuestId, asFactId } from "@/game/domain/worldEntity";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { entitiesOfKind } from "@/game/domain/entity";
import { makeOpeningQualityCandidate } from "@/game/domain/openingSituation.testutil";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { INITIAL_RELATIONSHIP_SEED_POLICY } from "@/game/gameplay/rpg/npcMemory";
import type { NarrativeRuntimeState } from "@/game/domain/narrative";
import { makeLostConvoyOpening } from "@/game/domain/testing/lostConvoyOpening.testutil";

function validCandidate(): OpeningGenerationCandidate {
  return {
    world: {
      summary: "旧盟约正在瓦解的边陲小镇。",
      tone: "江湖沧桑",
      themes: ["探索", "抉择"],
      publicFacts: [
        { key: "fact_inn", text: "沈掌柜守着通往青石古道的消息。" },
        { key: "fact_pact", text: "旧盟书库藏着一份盟誓印谱。" },
      ],
    },
    player: {
      name: "陆遥",
      identity: "流浪剑客",
      backgroundSummary: "为追寻被掩埋的真相独自上路。",
      baseStats: { hp: 100, attack: 10, defense: 5 },
    },
    prologue: "你在听雨客栈醒来，雨声压住了街道上的马蹄。",
    storyContract: {
      version: 1,
      targetActs: 3,
      centralConflict: "旧案背后的盟约正在瓦解",
      endingDirections: [
        { key: "trust", theme: "共同承担真相" },
        { key: "doubt", theme: "独自揭露真相" },
      ],
    },
    opening: {
      location: { name: "听雨客栈", description: "一座临近青石古道的落脚点。", scale: "town" },
      npc: {
        name: "沈掌柜", role: "关键线人", description: "掌握沿途消息的知情人。",
        knownFactKeys: ["fact_inn"], privateFactKeys: ["fact_pact"],
        anchors: { selfConcept: "守住客栈秘密的人", values: ["守诺"], speechStyle: "短句", capabilityBoundaries: ["不会伪证"], taboos: [] },
        goals: [{ horizon: "short", description: "查明幕后势力", priority: 4, reason: "客栈的线索正在消失" }],
      },
      quest: {
        name: "取得沈掌柜的信任", description: "从关键线人口中确认追索方向。",
        objective: { kind: "talk_to_opening_npc" },
      },
      situation: {
        history: [], threads: [{ key: "lead", questionFactKey: "fact_inn", supportingFactKeys: ["fact_pact"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] }],
        npcConnection: { familiarity: "stranger", stance: "neutral", basisHistoryKeys: [] },
        responses: [{ key: "ask_lead", dialogueAct: "ask", topic: { kind: "fact", key: "fact_inn" } }, { key: "challenge_lead", dialogueAct: "challenge", topic: { kind: "thread", key: "lead" } }],
      },
    },
  };
}

function compile(
  candidate: OpeningGenerationCandidate = validCandidate(),
  initialNarrative: NarrativeRuntimeState = createFixtureNarrativeRuntimeState(),
) {
  return compileOpeningGenerationCandidate({
    candidate,
    generation: {
      generationId: asGenerationId("gen_seed"),
      seed: "seed",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia",
    },
    gameLength: "short",
    initialNarrative,
  });
}

describe("compileOpeningGenerationCandidate", () => {
  it("玩家亲历失镖可见，陌生掌柜仍不知情，私密事实不向玩家公开", () => {
    const candidate = makeLostConvoyOpening();
    expect(validateOpeningGenerationCandidate(candidate, { gameLength: "short", targetActs: 3 }).ok).toBe(true);
    const { worldState } = compile(candidate);
    expect(worldState.worldFacts.find(fact => fact.factId === "fact_0")?.discovered).toBe(true);
    expect(worldState.npcs[0]?.memory.knownFactIds).not.toContain("fact_0");
    expect(worldState.worldFacts.find(fact => fact.factId === "fact_2")?.discovered).toBe(false);
  });

  it("player-known response topic does not enter NPC knowledge or change discovery", () => {
    const base = makeLostConvoyOpening();
    const candidate = { ...base, opening: { ...base.opening, situation: { ...base.opening.situation,
      responses: [{ ...base.opening.situation.responses[0], topic: { kind: "fact" as const, key: "he_shan_token" } }, base.opening.situation.responses[1]] as const,
    } } };
    expect(validateOpeningGenerationCandidate(candidate, { gameLength: "short", targetActs: 3 }).ok).toBe(true);
    const { worldState } = compile(candidate);
    expect(worldState.worldFacts.find(fact => fact.factId === "fact_0")?.discovered).toBe(true);
    expect(worldState.npcs[0]?.memory.knownFactIds).not.toContain("fact_0");
    expect(worldState.worldFacts.find(fact => fact.factId === "fact_2")?.discovered).toBe(false);
  });

  it("显式空玩家知识不继承 NPC 已知，旧候选缺省保持原行为", () => {
    const candidate = validCandidate();
    const empty = compile({ ...candidate, player: { ...candidate.player, knownFactKeys: [] } });
    expect(empty.worldState.worldFacts.every(fact => !fact.discovered)).toBe(true);
    expect(empty.worldState.npcs[0]?.memory.knownFactIds).toContain("fact_0");
    expect(compile(candidate).worldState.worldFacts.map(fact => fact.discovered)).toEqual([true, false]);
  });

  it("commits opening history and thread into the initialization episode", () => {
    const compiled = compile(makeOpeningQualityCandidate());
    const history = compiled.worldState.eventLedger.find((event) => event.kind === "opening_history_established")!;
    const thread = compiled.worldState.eventLedger.find((event) => event.kind === "opening_thread_established")!;

    expect(history.factIds).toEqual([asFactId("fact_0")]);
    expect(thread.causeEventIds).toContain(history.eventId);
    expect(thread.turnNumber).toBe(0);
    expect(compiled.storyState.memory.episodes[0]?.kind).toBe("initialization");
    expect(compiled.storyState.memory).toEqual(rebuildEpisodicMemory(compiled.worldState.eventLedger));
  });

  it("canonicalizes a thread envelope when its question is also supporting evidence", () => {
    const candidate = makeOpeningQualityCandidate();
    const compiled = compile({
      ...candidate,
      opening: {
        ...candidate.opening,
        situation: {
          ...candidate.opening.situation,
          threads: candidate.opening.situation.threads.map((thread, index) => index === 0
            ? { ...thread, supportingFactKeys: [thread.questionFactKey, ...thread.supportingFactKeys] }
            : thread),
        },
      },
    });
    const thread = compiled.worldState.eventLedger.find((event) => event.kind === "opening_thread_established")!;

    expect(thread.factIds).toEqual([asFactId("fact_1"), asFactId("fact_2"), asFactId("fact_3")]);
    if (thread.payload.type !== "opening_thread_established") throw new Error("missing opening thread payload");
    expect(thread.payload.questionFactId).toBe(asFactId("fact_1"));
    expect(thread.payload.supportingFactIds).toEqual([asFactId("fact_1"), asFactId("fact_2"), asFactId("fact_3")]);
  });

  it("初始化事件提交后，Story memory 由同一 ledger 重建", () => {
    const result = compile(validCandidate());
    expect(result.worldState.eventLedger).toHaveLength(2);
    expect(result.storyState.memory.reducedThroughSequence).toBe(1);
    expect(result.storyState.memory.episodes[0]?.eventIds).toEqual(
      result.worldState.eventLedger.map((event) => event.eventId),
    );
  });

  it.each(["ally", "rival"] as const)("seeds the %s relationship from the rule policy without evidence or commitments", (stance) => {
    const candidate = makeOpeningQualityCandidate();
    const compiled = compile({
      ...candidate,
      opening: {
        ...candidate.opening,
        situation: {
          ...candidate.opening.situation,
          npcConnection: { familiarity: "known", stance, basisHistoryKeys: ["worked_together"] },
        },
      },
    });
    const npc = entitiesOfKind(compiled.worldState.entityStore, "npc")[0]!;
    const edge = npc.relationships.outgoing[0]!;

    expect(edge.dimensions).toEqual(INITIAL_RELATIONSHIP_SEED_POLICY[stance].dimensions);
    expect(edge.stage).toBe(INITIAL_RELATIONSHIP_SEED_POLICY[stance].stage);
    expect(edge.evidence).toEqual([]);
    expect(edge.commitments).toEqual([]);
    expect(edge.origin).toEqual({ kind: "initial_world", createdAtTurn: 0, reasonKey: "worked_together" });
  });

  it("marks a known NPC as met and initializes emotion from the approved opening line", () => {
    const narrative = createFixtureNarrativeRuntimeState({
      sceneId: "opening", turn: 0, narration: "开场", usedFactIds: [], choices: [], source: "generated",
      npcLine: { npcId: asNpcId("npc_0"), text: "先看看记录。", emotion: "guarded", usedFactIds: [], usedEventIds: [] },
    });
    const compiled = compile(makeOpeningQualityCandidate(), narrative);
    const npc = entitiesOfKind(compiled.worldState.entityStore, "npc")[0]!;

    expect(npc.dynamicState.met).toBe(true);
    expect(npc.dynamicState.emotion).toBe("guarded");
    expect(npc.relationships.outgoing[0]?.stage).toBe("acquainted");
  });

  it("从 anchors/goals proposals 显式创建 npc_0 的非占位组件与初始 provenance", () => {
    const candidate = {
      ...validCandidate(),
      opening: {
        ...validCandidate().opening,
        npc: {
          ...validCandidate().opening.npc,
          anchors: {
            selfConcept: "我是守住客栈秘密的人",
            values: ["守诺"],
            speechStyle: "短句，少解释",
            capabilityBoundaries: ["不会替人作伪证"],
            taboos: ["不出卖无辜者"],
          },
          goals: [{ horizon: "long", description: "守住盟约", priority: 5, reason: "这是我留下来的原因" }],
        },
      },
    } as unknown as OpeningGenerationCandidate;

    const { worldState } = compile(candidate);
    const npcRecord = entitiesOfKind(worldState.entityStore, "npc").find((record) => record.core.id === asNpcId("npc_0"));
    expect(npcRecord?.identity.anchors)
      .toEqual(candidate.opening.npc.anchors);
    expect(npcRecord?.dynamicState.goals).toEqual([
      {
        goalId: "npc_0_goal_1", horizon: "long", description: "守住盟约", priority: 5,
        status: "active", reason: "这是我留下来的原因",
      },
    ]);
    expect(npcRecord?.knowledge.entries).toEqual([
      {
        factId: asFactId("fact_0"), certainty: "known", disclosure: "public",
        source: { kind: "initial_world", learnedAtTurn: 0 },
      },
      {
        factId: asFactId("fact_1"), certainty: "known", disclosure: "secret",
        source: { kind: "initial_world", learnedAtTurn: 0 },
      },
    ]);
    expect(npcRecord?.relationships.outgoing).toEqual([{
      targetId: PLAYER_ENTITY_ID,
      dimensions: { affinity: 0, trust: 0, fear: 0, hostility: 0 },
      stage: "unknown", trend: "stable", commitments: [], evidence: [],
      origin: { kind: "initial_world", createdAtTurn: 0, reasonKey: "opening_npc" },
      lastChangedAtTurn: 0,
    }]);
  });

  it("server mints goal IDs from npc id and ordinal, ignoring AI-owned IDs/status", () => {
    const candidate = {
      ...validCandidate(),
      opening: {
        ...validCandidate().opening,
        npc: {
          ...validCandidate().opening.npc,
          anchors: {
            selfConcept: "自洽的人", values: ["守诺"], speechStyle: "简短",
            capabilityBoundaries: ["不会伪证"], taboos: [],
          },
          goals: [
            { horizon: "short", description: "目标一", priority: 2, reason: "原因一" },
            { horizon: "long", description: "目标二", priority: 4, reason: "原因二" },
          ],
        },
      },
    } as unknown as OpeningGenerationCandidate;

    const { worldState } = compile(candidate);
    const npcRecord = entitiesOfKind(worldState.entityStore, "npc").find((record) => record.core.id === asNpcId("npc_0"));
    expect(npcRecord?.dynamicState.goals.map((goal) => goal.goalId))
      .toEqual(["npc_0_goal_1", "npc_0_goal_2"]);
    expect(npcRecord?.dynamicState.goals.every((goal) => goal.status === "active")).toBe(true);
  });

  it("只具象化一个地点/一个 NPC/一个 active 主任务，且无敌人、无结局、无锁定未来任务", () => {
    const { worldState } = compile();
    expect(worldState.locations).toHaveLength(1);
    expect(worldState.npcs).toHaveLength(1);
    expect(worldState.quests).toHaveLength(1);
    expect(worldState.quests[0]?.status).toBe("active");
    expect(worldState.quests[0]?.kind).toBe("main");
    expect(worldState.quests[0]?.stage).toBe(1);
    expect(worldState.quests.filter((quest) => quest.status === "locked")).toEqual([]);
    expect(worldState.enemies).toEqual([]);
    expect(worldState.endings).toEqual([]);
    expect(worldState.items).toEqual([]);
  });

  it("铸造固定 ID：loc_0 / npc_0 / quest_0 与 opening 需要的事实 ID", () => {
    const { worldState } = compile();
    expect(worldState.locations[0]?.id).toBe(asLocationId("loc_0"));
    expect(worldState.npcs[0]?.id).toBe(asNpcId("npc_0"));
    expect(worldState.quests[0]?.id).toBe(asQuestId("quest_0"));
    expect(worldState.currentLocationId).toBe(asLocationId("loc_0"));
    expect(worldState.unlockedLocationIds).toEqual([asLocationId("loc_0")]);
    expect(worldState.visitedLocationIds).toEqual([asLocationId("loc_0")]);
    expect(worldState.worldFacts.map((fact) => fact.factId)).toEqual([asFactId("fact_0"), asFactId("fact_1")]);
  });

  it("talk_to_opening_npc 目标编译为真实 talk_to_npc objective（npc_0）", () => {
    const { worldState } = compile();
    expect(worldState.quests[0]?.objectives).toEqual([{ kind: "talk_to_npc", npcId: asNpcId("npc_0") }]);
    expect(worldState.locations[0]?.npcIds).toEqual([asNpcId("npc_0")]);
    expect(worldState.locations[0]?.scale).toBe("town");
  });

  it("首个任务的 onSuccess 是 advance_story（不引用任何预生成任务），onFailure 是 closed", () => {
    const { worldState } = compile();
    expect(worldState.quests[0]?.onSuccess).toEqual({ kind: "advance_story" });
    expect(worldState.quests[0]?.onFailure).toEqual({ kind: "closed" });
  });

  it("publicFacts 铸为开局可见的世界事实，NPC known/private keys 映射到对应事实 ID", () => {
    const { worldState } = compile();
    const facts = worldState.worldFacts;
    expect(facts).toEqual([
      { factId: asFactId("fact_0"), text: "沈掌柜守着通往青石古道的消息。", source: "generated", discovered: true },
      { factId: asFactId("fact_1"), text: "旧盟书库藏着一份盟誓印谱。", source: "generated", discovered: false },
    ]);
    const npc = worldState.npcs[0]!;
    // 新契约下 memory 由 knowledge 组件重建：knownFactIds 是全部 entry，
    // hiddenFactIds 是 disclosure === "secret" 的子集，因此私有事实同时在两侧。
    expect(npc.memory.knownFactIds).toEqual([asFactId("fact_0"), asFactId("fact_1")]);
    expect(npc.memory.hiddenFactIds).toEqual([asFactId("fact_1")]);
    expect(npc.memory.goals).toEqual(["查明幕后势力"]);
    expect(npc.locationId).toBe(asLocationId("loc_0"));
  });

  it("player 与 generation 落地；开场切片不含任何预生成未来实体", () => {
    const { worldState } = compile();
    expect(worldState.player).toEqual({
      name: "陆遥",
      identity: "流浪剑客",
      stats: { hp: 100, maxHp: 100, maxEnergy: 40, attack: 20, defense: 10, speed: 12 },
    });
    expect(worldState.generation.seed).toBe("seed");
    expect(worldState.generation.gameType).toBe("wuxia");
    const serialized = JSON.stringify(worldState);
    expect(serialized).not.toMatch(/npc_[1-9]|loc_[1-9]|quest_[1-9]|enemy_/);
  });

  it("storyState.contract 来自候选故事契约，序幕写入 prologueText，演化状态 stable", () => {
    const { storyState } = compile();
    expect(storyState.contract).toEqual(validCandidate().storyContract);
    expect(storyState.contract.endingDirections.map((direction) => direction.key)).toEqual(["trust", "doubt"]);
    expect(storyState.prologueText).toBe("你在听雨客栈醒来，雨声压住了街道上的马蹄。");
    expect(storyState.evolution.status).toBe("stable");
    expect(storyState.currentAct).toBe(1);
    expect(storyState.targetActs).toBe(3);
  });

  it("medium 档编译 targetActs=5 且预算按开场计数建立", () => {
    const result = compileOpeningGenerationCandidate({
      candidate: { ...validCandidate(), storyContract: { ...validCandidate().storyContract, targetActs: 5 } },
      generation: {
        generationId: asGenerationId("gen_m"),
        seed: "m",
        templateVersion: "v2",
        inputDigest: "",
        gameType: "fantasy",
      },
      gameLength: "medium",
      initialNarrative: createFixtureNarrativeRuntimeState(),
    });
    const { worldState, storyState } = result;
    expect(storyState.targetActs).toBe(5);
    expect(storyState.contract.targetActs).toBe(5);
    expect(worldState.locations).toHaveLength(1);
    const budget = storyState.budget as StoryState["budget"];
    expect(budget.locations.opening).toBe(1);
    expect(budget.npcs.opening).toBe(1);
    expect(budget.quests.opening).toBe(1);
  });

  it("scale=town 开局地点携带稳定 town 运行时：npc_0 绑定 slot_0，其余 slot 未绑定", () => {
    const { worldState } = compile();
    const location = worldState.locations[0]!;
    expect(location.scale).toBe("town");
    expect(location.town).toBeDefined();
    expect(location.town?.locationId).toBe(asLocationId("loc_0"));
    expect(location.town?.generatorVersion).toBe("town-gen-0.1.0");
    expect(location.town?.slots[0]?.boundNpcId).toBe(asNpcId("npc_0"));
    expect(location.town?.slots.slice(1).every((slot) => slot.boundNpcId === null)).toBe(true);
    expect(location.town?.slots).toHaveLength(3);
  });

  it("town seed 由 generation seed 确定性派生，且不开局具象化未来 NPC 名称", () => {
    const { worldState } = compile();
    const serialized = JSON.stringify(worldState);
    expect(serialized).not.toMatch(/npc_dyn_/);
    expect(worldState.locations[0]?.town?.seed).toBe("seed#town#loc_0");
  });

  it("将候选 publicFacts 已审批的 investigationApproaches 逐条复制进编译事实，保持 discovered 语义", () => {
    const candidate: OpeningGenerationCandidate = {
      ...validCandidate(),
      world: {
        ...validCandidate().world,
        publicFacts: [
          {
            key: "fact_inn",
            text: "沈掌柜守着通往青石古道的消息。",
            investigationApproaches: [
              { approachId: "a", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 2 },
              { approachId: "b", label: "向摊贩打听", evidenceQuality: "noisy", tensionDelta: 4 },
            ],
          },
          { key: "fact_pact", text: "旧盟书库藏着一份盟誓印谱。" },
        ],
      },
    };
    const { worldState } = compile(candidate);
    expect(worldState.worldFacts).toEqual([
      {
        factId: asFactId("fact_0"),
        text: "沈掌柜守着通往青石古道的消息。",
        source: "generated",
        discovered: true,
        investigationApproaches: [
          { approachId: "a", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 2 },
          { approachId: "b", label: "向摊贩打听", evidenceQuality: "noisy", tensionDelta: 4 },
        ],
      },
      { factId: asFactId("fact_1"), text: "旧盟书库藏着一份盟誓印谱。", source: "generated", discovered: false },
    ]);
  });

  it("部分非法列表（3 条中 1 条硬泄漏正文、其余 2 条合法）在开局校验整体拒绝，管线走确定性 fallback——泄漏条目无法以调查选项到达 WorldFactEntry", () => {
    const leaked: OpeningGenerationCandidate = {
      ...validCandidate(),
      world: {
        ...validCandidate().world,
        publicFacts: [
          {
            key: "fact_inn",
            text: "沈掌柜守着通往青石古道的消息。",
            investigationApproaches: [
              { approachId: "a", label: "沈掌柜守着通往青石古道的消息。", evidenceQuality: "clean", tensionDelta: 2 },
              { approachId: "b", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 2 },
              { approachId: "c", label: "向摊贩打听", evidenceQuality: "noisy", tensionDelta: 4 },
            ],
          },
          { key: "fact_pact", text: "旧盟书库藏着一份盟誓印谱。" },
        ],
      },
    };
    const validation = validateOpeningGenerationCandidate(leaked, { gameLength: "short", targetActs: 3 });
    expect(validation.ok).toBe(false);
    if (!validation.ok) {
      expect(validation.issues).toContainEqual(expect.objectContaining({
        code: "invalid_investigation_approaches",
        params: { key: "fact_inn" },
      }));
    }
    // compile 只接收已获批候选（ok:true 才被调用）；被拒绝后管线改走确定性
    // fallback 候选（与 validCandidate() 同构：无任何调查方式），泄漏正文
    // 只允许以事实 text 出现，绝不作为调查选项 label 出现。
    const { worldState } = compile();
    expect(worldState.worldFacts.every((fact) => fact.investigationApproaches === undefined)).toBe(true);
    const serialized = JSON.stringify(worldState);
    expect(serialized).not.toContain("investigationApproaches");
  });
});

describe("compileOpeningStructure", () => {
  it("不依赖 initialNarrative：产出正式 provider_pending 结构状态", () => {
    const structure = compileOpeningStructure({
      candidate: validCandidate(),
      generation: {
        generationId: asGenerationId("gen_seed"),
        seed: "seed",
        templateVersion: "v2",
        inputDigest: "",
        gameType: "wuxia",
      },
      gameLength: "short",
      seed: "seed",
    });
    expect(structure.storyState.narrative.status).toBe("provider_pending");
    expect(structure.worldState.quests).toHaveLength(1);
    expect(String(structure.worldState.currentLocationId)).toBe("loc_0");
  });

  it("seed 显式传入：town 几何只由显式 seed 决定且确定性可复现", () => {
    const generation = {
      generationId: asGenerationId("gen_seed"),
      seed: "ignored-generation-seed",
      templateVersion: "v2",
      inputDigest: "",
      gameType: "wuxia",
    } as const;
    const a = compileOpeningStructure({ candidate: validCandidate(), generation, gameLength: "short", seed: "seed-a" });
    const b = compileOpeningStructure({ candidate: validCandidate(), generation, gameLength: "short", seed: "seed-b" });
    const aTown = JSON.stringify(a.worldState.entityStore);
    const bTown = JSON.stringify(b.worldState.entityStore);
    // generation.seed 不再参与结构几何：显式 seed 不同 → town 几何不同
    expect(aTown).not.toBe(bTown);
    expect(a).toEqual(compileOpeningStructure({ candidate: validCandidate(), generation, gameLength: "short", seed: "seed-a" }));
  });

  it("旧入口仍是结构编译 + 叙事安装的兼容包装", () => {
    const narrative = createFixtureNarrativeRuntimeState();
    const compiled = compileOpeningGenerationCandidate({
      candidate: validCandidate(),
      generation: {
        generationId: asGenerationId("gen_seed"),
        seed: "seed",
        templateVersion: "v2",
        inputDigest: "",
        gameType: "wuxia",
      },
      gameLength: "short",
      initialNarrative: narrative,
    });
    expect(compiled.storyState.narrative).toBe(narrative);
  });
});
