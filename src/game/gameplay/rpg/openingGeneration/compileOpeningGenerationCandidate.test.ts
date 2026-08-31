import { describe, it, expect } from "vitest";
import { compileOpeningGenerationCandidate } from "./compileOpeningGenerationCandidate";
import { validateOpeningGenerationCandidate } from "./validateOpeningGenerationCandidate";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type { StoryState } from "@/game/domain/storyState";
import { asGenerationId, asLocationId, asNpcId, asQuestId, asFactId } from "@/game/domain/worldEntity";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";

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
        knownFactKeys: ["fact_inn"], privateFactKeys: ["fact_pact"], goals: ["查明幕后势力"],
      },
      quest: {
        name: "取得沈掌柜的信任", description: "从关键线人口中确认追索方向。",
        objective: { kind: "talk_to_opening_npc" },
      },
    },
  };
}

function compile(candidate: OpeningGenerationCandidate = validCandidate()) {
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
    initialNarrative: createFixtureNarrativeRuntimeState(),
  });
}

describe("compileOpeningGenerationCandidate", () => {
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
