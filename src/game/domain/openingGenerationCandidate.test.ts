import { describe, it, expect } from "vitest";
import { parseOpeningGenerationCandidate, type OpeningGenerationCandidate } from "./openingGenerationCandidate";

// 模拟 AI 原始 unknown 输入：保持 key 可读写、子对象可展开，但值仍是 unknown。
type RawCandidate = Record<string, unknown> & {
  readonly world: Record<string, unknown>;
  readonly player: Record<string, unknown>;
  readonly storyContract: Record<string, unknown>;
  readonly opening: {
    readonly location: Record<string, unknown>;
    readonly npc: Record<string, unknown>;
    readonly quest: Record<string, unknown>;
  };
};

function rawCandidate(): RawCandidate {
  return validCandidate() as unknown as RawCandidate;
}

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

describe("parseOpeningGenerationCandidate", () => {
  it("requires situation and preserves its exact parsed structure", () => {
    const candidate = validCandidate();
    expect(parseOpeningGenerationCandidate(candidate)).toMatchObject({ ok: true, value: { opening: { situation: candidate.opening.situation } } });
    const missing = rawCandidate();
    delete (missing.opening as Record<string, unknown>).situation;
    expect(parseOpeningGenerationCandidate(missing)).toEqual({ ok: false, code: "INVALID_OPENING_SITUATION" });
  });

  it("接受带完整 anchors 与 typed goal proposals 的开场 NPC", () => {
    const base = rawCandidate();
    const candidate = {
      ...base,
      opening: {
        ...base.opening,
        npc: {
          ...base.opening.npc,
          anchors: {
            selfConcept: "我是守住客栈秘密的人",
            values: ["守诺"],
            speechStyle: "短句，少解释",
            capabilityBoundaries: ["不会替人作伪证"],
            taboos: ["不出卖无辜者"],
          },
          goals: [{ horizon: "short", description: "查明幕后势力", priority: 4, reason: "客栈的线索正在消失" }],
        },
      },
    };

    const result = parseOpeningGenerationCandidate(candidate);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.opening.npc.anchors).toEqual(candidate.opening.npc.anchors);
      expect(result.value.opening.npc.goals).toEqual(candidate.opening.npc.goals);
    }
  });

  it("拒绝 malformed/duplicate/over-limit anchors and goals without defaults", () => {
    const base = rawCandidate();
    const npc = {
      ...base.opening.npc,
      anchors: {
        selfConcept: "",
        values: ["守诺", "守诺", "一", "二", "三"],
        speechStyle: "短句",
        capabilityBoundaries: ["不会伪证"],
        taboos: [],
        extra: "不得接受",
      },
      goals: [
        { horizon: "mid", description: "目标", priority: 6, reason: "原因" },
        { horizon: "short", description: "目标", priority: 3, reason: "原因" },
      ],
    };

    const result = parseOpeningGenerationCandidate({
      ...base,
      opening: { ...base.opening, npc },
    });

    expect(result).toEqual({ ok: false, code: "INVALID_OPENING_NPC" });
    expect(JSON.stringify(result)).not.toContain("legacy_import");
  });

  it("拒绝 goalId/status 以及 nested anchor/goal unknown keys", () => {
    const base = rawCandidate();
    const npc = {
      ...base.opening.npc,
      anchors: {
        selfConcept: "我是守住客栈秘密的人",
        values: ["守诺"],
        speechStyle: "短句",
        capabilityBoundaries: ["不会伪证"],
        taboos: [],
        role: "不应出现在 anchors",
      },
      goals: [{ horizon: "short", description: "查明幕后势力", priority: 4, reason: "客栈的线索正在消失", goalId: "ai_minted", status: "active" }],
    };

    expect(parseOpeningGenerationCandidate({ ...base, opening: { ...base.opening, npc } }))
      .toEqual({ ok: false, code: "INVALID_OPENING_NPC" });
  });

  it("接受完整合法候选并原样保留字段", () => {
    const result = parseOpeningGenerationCandidate(validCandidate());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(validCandidate());
      expect(result.value.opening.location.scale).toBe("town");
      expect(result.value.opening.quest.objective).toEqual({ kind: "talk_to_opening_npc" });
      expect(result.value.storyContract.targetActs).toBe(3);
    }
  });

  it("非对象输入返回 NOT_AN_OBJECT", () => {
    for (const raw of [null, "x", 42, [], true]) {
      expect(parseOpeningGenerationCandidate(raw)).toEqual({ ok: false, code: "NOT_AN_OBJECT" });
    }
  });

  it("world 缺失或类型错误返回 INVALID_WORLD", () => {
    const base = rawCandidate();
    expect(parseOpeningGenerationCandidate({ ...base, world: null })).toEqual({ ok: false, code: "INVALID_WORLD" });
    expect(parseOpeningGenerationCandidate({ ...base, world: { ...base.world, summary: 42 } }))
      .toEqual({ ok: false, code: "INVALID_WORLD_TEXT" });
    expect(parseOpeningGenerationCandidate({ ...base, world: { ...base.world, themes: "探索" } }))
      .toEqual({ ok: false, code: "INVALID_WORLD_LISTS" });
  });

  it("publicFacts 条目必须为 { key, text } 字符串", () => {
    const base = rawCandidate();
    const world = { ...base.world, publicFacts: [{ key: 1, text: "x" }] };
    expect(parseOpeningGenerationCandidate({ ...base, world })).toEqual({ ok: false, code: "INVALID_FACT" });
    expect(parseOpeningGenerationCandidate({ ...base, world: { ...base.world, publicFacts: "nope" } }))
      .toEqual({ ok: false, code: "INVALID_FACT" });
  });

  it("player 缺失/文本错误/数值非法返回对应错误码", () => {
    const base = rawCandidate();
    expect(parseOpeningGenerationCandidate({ ...base, player: null })).toEqual({ ok: false, code: "INVALID_PLAYER" });
    expect(parseOpeningGenerationCandidate({ ...base, player: { ...base.player, name: 7 } }))
      .toEqual({ ok: false, code: "INVALID_PLAYER_TEXT" });
    expect(parseOpeningGenerationCandidate({ ...base, player: { ...base.player, baseStats: { hp: "x" } } }))
      .toEqual({ ok: false, code: "INVALID_PLAYER_STATS" });
  });

  it("prologue 必须为字符串", () => {
    const base = rawCandidate();
    expect(parseOpeningGenerationCandidate({ ...base, prologue: 42 })).toEqual({ ok: false, code: "INVALID_PROLOGUE" });
  });

  it("storyContract 必须完整：version/targetActs/endingDirections 固定形状", () => {
    const base = rawCandidate();
    expect(parseOpeningGenerationCandidate({ ...base, storyContract: null }))
      .toEqual({ ok: false, code: "INVALID_STORY_CONTRACT" });
    expect(parseOpeningGenerationCandidate({ ...base, storyContract: { ...base.storyContract, targetActs: 4 } }))
      .toEqual({ ok: false, code: "INVALID_STORY_CONTRACT" });
    expect(parseOpeningGenerationCandidate({
      ...base,
      storyContract: { ...base.storyContract, endingDirections: [{ key: "trust", theme: "t" }] },
    })).toEqual({ ok: false, code: "INVALID_ENDING_DIRECTION" });
  });

  it("opening 子结构必须完整且 objective 只允许 talk_to_opening_npc", () => {
    const base = rawCandidate();
    expect(parseOpeningGenerationCandidate({ ...base, opening: null })).toEqual({ ok: false, code: "INVALID_OPENING" });
    expect(parseOpeningGenerationCandidate({ ...base, opening: { ...base.opening, location: { ...base.opening.location, scale: "scene" } } }))
      .toEqual({ ok: false, code: "INVALID_OPENING_LOCATION" });
    expect(parseOpeningGenerationCandidate({ ...base, opening: { ...base.opening, npc: { ...base.opening.npc, knownFactKeys: "fact_inn" } } }))
      .toEqual({ ok: false, code: "INVALID_OPENING_NPC" });
    expect(parseOpeningGenerationCandidate({ ...base, opening: { ...base.opening, quest: { ...base.opening.quest, objective: { kind: "visit_location" } } } }))
      .toEqual({ ok: false, code: "INVALID_OPENING_QUEST" });
  });

  it("player 数值字段缺失时默认 0（形状检查不造假）", () => {
    const base = rawCandidate();
    const result = parseOpeningGenerationCandidate({ ...base, player: { ...base.player, baseStats: { hp: 100 } } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.player.baseStats).toEqual({ hp: 100, attack: 0, defense: 0 });
    }
  });

  it("copies approved investigationApproaches onto parsed public fact entries", () => {
    const candidate: OpeningGenerationCandidate = {
      ...validCandidate(),
      world: {
        ...validCandidate().world,
        publicFacts: [
          {
            key: "fact_inn",
            text: "沈掌柜守着通往青石古道的消息。",
            investigationApproaches: [
              { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
              { approachId: "ask", label: "向沈掌柜打听", evidenceQuality: "noisy", tensionDelta: 12 },
            ],
          },
        ],
      },
    };
    const result = parseOpeningGenerationCandidate(candidate);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.world.publicFacts[0]?.investigationApproaches).toEqual([
        { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean", tensionDelta: 4 },
        { approachId: "ask", label: "向沈掌柜打听", evidenceQuality: "noisy", tensionDelta: 12 },
      ]);
    }
  });

  it("rejects public fact entries with malformed investigationApproaches", () => {
    const base = rawCandidate();
    const world = {
      ...base.world,
      publicFacts: [
        { key: "fact_inn", text: "x", investigationApproaches: [{ approachId: 1, label: "x", evidenceQuality: "clean", tensionDelta: 4 }] },
      ],
    };
    expect(parseOpeningGenerationCandidate({ ...base, world })).toEqual({ ok: false, code: "INVALID_FACT" });
  });
});
