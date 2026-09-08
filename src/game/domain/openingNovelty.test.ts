import { describe, expect, it } from "vitest";
import type { OpeningGenerationCandidate } from "./openingGenerationCandidate";
import {
  createOpeningNoveltyRecord,
  isOpeningTooSimilar,
  openingNoveltySimilarity,
} from "./openingNovelty";

function candidate(input: {
  readonly location: string;
  readonly building: string;
  readonly npc: string;
  readonly role: string;
  readonly fact: string;
  readonly conflict: string;
  readonly profile: OpeningGenerationCandidate["opening"]["variationProfile"];
}): OpeningGenerationCandidate {
  return {
    world: {
      summary: "边镇的旧案正在重新浮出水面。",
      tone: "克制悬疑",
      themes: ["调查", "选择"],
      publicFacts: [{ key: "fact_lead", text: input.fact }],
    },
    player: { name: "沈砚", identity: "调查者", backgroundSummary: "", baseStats: { hp: 100, attack: 10, defense: 5 } },
    prologue: "一桩旧案把主角引到边镇。",
    storyContract: {
      version: 1,
      targetActs: 3,
      centralConflict: input.conflict,
      endingDirections: [
        { key: "trust", theme: "与线人合作" },
        { key: "doubt", theme: "独自查证" },
      ],
    },
    opening: {
      location: { name: input.location, description: "一处还留着昨夜痕迹的地点。", buildingName: input.building, scale: "town" },
      npc: {
        name: input.npc,
        role: input.role,
        description: "他掌握一部分现场情况。",
        knownFactKeys: ["fact_lead"],
        privateFactKeys: [],
        anchors: { selfConcept: "守住真相的人", values: ["守诺"], speechStyle: "简短", capabilityBoundaries: ["不会伪证"], taboos: [] },
        goals: [{ horizon: "short", description: "查明真相", priority: 4, reason: "线索不能消失" }],
      },
      quest: { name: "核对开场线索", description: "先把现场线索核对清楚。", objective: { kind: "talk_to_opening_npc" } },
      situation: {
        history: [], threads: [{ key: "lead", questionFactKey: "fact_lead", supportingFactKeys: [], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] }],
        npcConnection: { familiarity: "stranger", stance: "neutral", basisHistoryKeys: [] },
        responses: [{ key: "ask_lead", dialogueAct: "ask", topic: { kind: "fact", key: "fact_lead" } }, { key: "challenge_lead", dialogueAct: "challenge", topic: { kind: "thread", key: "lead" } }],
      },
      ...(input.profile === undefined ? {} : { variationProfile: input.profile }),
    },
  };
}

function record(candidateValue: OpeningGenerationCandidate, createdAt = "2026-01-01") {
  return createOpeningNoveltyRecord({ candidate: candidateValue, gameType: "wuxia", createdAt });
}

describe("opening novelty", () => {
  it("同一故事即使只替换 NPC 名称也会被识别为重复", () => {
    const first = record(candidate({
      location: "青石镇北巷", building: "北巷茶棚", npc: "老陈", role: "目击者",
      fact: "酒楼后巷留下车轮印", conflict: "有人正在掩盖车队经过的证据",
      profile: { sceneFrame: "street", npcArchetype: "witness", leadType: "trace", conflictMode: "concealment" },
    }));
    const renamed = record(candidate({
      location: "青石镇北巷", building: "北巷茶棚", npc: "韩七", role: "目击者",
      fact: "酒楼后巷留下车轮印", conflict: "有人正在掩盖车队经过的证据",
      profile: { sceneFrame: "street", npcArchetype: "witness", leadType: "trace", conflictMode: "concealment" },
    }));

    expect(openingNoveltySimilarity(first, renamed)).toBeGreaterThanOrEqual(0.78);
    expect(isOpeningTooSimilar(renamed, [first])).toBe(true);
  });

  it("保留相同 NPC 名称但改变故事结构时不应被名字禁用", () => {
    const first = record(candidate({
      location: "青石镇北巷", building: "北巷茶棚", npc: "老陈", role: "目击者",
      fact: "酒楼后巷留下车轮印", conflict: "有人正在掩盖车队经过的证据",
      profile: { sceneFrame: "street", npcArchetype: "witness", leadType: "trace", conflictMode: "concealment" },
    }));
    const differentStory = record(candidate({
      location: "青石镇漕渠古渡", building: "漕渠账房", npc: "老陈", role: "漕运司书",
      fact: "三年前的粮船编号在今年重新出现", conflict: "两方势力正在争夺被隐去的漕银账目",
      profile: { sceneFrame: "market", npcArchetype: "official", leadType: "document", conflictMode: "dispute" },
    }));

    expect(openingNoveltySimilarity(first, differentStory)).toBeLessThan(0.78);
    expect(isOpeningTooSimilar(differentStory, [first])).toBe(false);
  });

  it("相同候选可重放出稳定指纹", () => {
    const value = candidate({
      location: "青石镇北巷", building: "北巷茶棚", npc: "老陈", role: "目击者",
      fact: "酒楼后巷留下车轮印", conflict: "有人正在掩盖车队经过的证据",
      profile: { sceneFrame: "street", npcArchetype: "witness", leadType: "trace", conflictMode: "concealment" },
    });
    expect(record(value)).toEqual(record(value));
  });
});
