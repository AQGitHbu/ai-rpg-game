import { describe, it, expect } from "vitest";
import { validateOpeningGenerationCandidate } from "./validateOpeningGenerationCandidate";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";

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

describe("validateOpeningGenerationCandidate", () => {
  it("合法开场切片通过（targetActs 与档位一致）", () => {
    const result = validateOpeningGenerationCandidate(validCandidate(), { gameLength: "short", targetActs: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.validated).toEqual(validCandidate());
  });

  it("medium 档要求 targetActs=5", () => {
    const result = validateOpeningGenerationCandidate(validCandidate(), { gameLength: "medium", targetActs: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "contract_target_acts_mismatch",
        params: { expected: 5, actual: 3 },
      }));
    }
  });

  it("targetActs 与 TARGET_ACTS[gameLength] 不一致时拒绝（context.targetActs 是权威）", () => {
    const result = validateOpeningGenerationCandidate(validCandidate(), { gameLength: "short", targetActs: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain("contract_target_acts_mismatch");
    }
  });

  it("publicFacts key 重复时报 duplicate_fact_key", () => {
    const candidate = {
      ...validCandidate(),
      world: {
        ...validCandidate().world,
        publicFacts: [
          { key: "fact_inn", text: "a" },
          { key: "fact_inn", text: "b" },
        ],
      },
    };
    const result = validateOpeningGenerationCandidate(candidate, { gameLength: "short", targetActs: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "duplicate_fact_key" }));
    }
  });

  it("knownFactKeys 引用不存在的 key 时报 unknown_fact_key", () => {
    const candidate = {
      ...validCandidate(),
      opening: {
        ...validCandidate().opening,
        npc: { ...validCandidate().opening.npc, knownFactKeys: ["fact_ghost"] },
      },
    };
    const result = validateOpeningGenerationCandidate(candidate, { gameLength: "short", targetActs: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "unknown_fact_key",
        params: { key: "fact_ghost" },
      }));
    }
  });

  it("privateFactKeys 引用不存在的 key 时报 unknown_fact_key（缺失 key = 校验错误）", () => {
    const candidate = {
      ...validCandidate(),
      opening: {
        ...validCandidate().opening,
        npc: { ...validCandidate().opening.npc, privateFactKeys: ["fact_nope"] },
      },
    };
    const result = validateOpeningGenerationCandidate(candidate, { gameLength: "short", targetActs: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        code: "unknown_fact_key",
        params: { key: "fact_nope" },
      }));
    }
  });

  it("known/private keys 均必须为 publicFacts key 的子集", () => {
    const result = validateOpeningGenerationCandidate(validCandidate(), { gameLength: "short", targetActs: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validated.opening.npc.knownFactKeys.every(
        (key) => result.validated.world.publicFacts.some((fact) => fact.key === key),
      )).toBe(true);
      expect(result.validated.opening.npc.privateFactKeys.every(
        (key) => result.validated.world.publicFacts.some((fact) => fact.key === key),
      )).toBe(true);
    }
  });
});
