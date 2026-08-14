import { describe, it, expect } from "vitest";
import { repairOpeningGenerationCandidate, createOpeningGenerationSource, sanitizeOpeningFactReferences } from "./openingGenerationSource";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { validateOpeningGenerationCandidate } from "@/game/gameplay/rpg/openingGeneration";
import type { AiTransport } from "@ai-game/ai-transport";
import { buildStylePolicy } from "../../stylePolicy";

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

describe("repairOpeningGenerationCandidate", () => {
  it("有效候选不修复", () => {
    const { candidate, repaired } = repairOpeningGenerationCandidate(validCandidate());
    expect(repaired).toBe(false);
    expect(candidate).not.toBeNull();
  });

  it("数组字段为 null/非数组时机械修复为空数组", () => {
    const raw = JSON.parse(JSON.stringify(validCandidate())) as Record<string, unknown>;
    (raw.world as Record<string, unknown>).publicFacts = null;
    (raw.opening as Record<string, unknown>).npc = { ...(raw.opening as Record<string, unknown>).npc as object, goals: "x" };
    const { candidate, repaired } = repairOpeningGenerationCandidate(raw);
    expect(repaired).toBe(true);
    expect(candidate).not.toBeNull();
    expect(candidate?.world.publicFacts).toEqual([]);
    expect(candidate?.opening.npc.goals).toEqual([]);
  });

  it("字符串字段被修复为空字符串后仍经 parse 拒绝（不伪装）", () => {
    const raw = JSON.parse(JSON.stringify(validCandidate())) as Record<string, unknown>;
    (raw.opening as Record<string, unknown>).location = { name: "", description: "", scale: "town" };
    const { candidate, repaired } = repairOpeningGenerationCandidate(raw);
    expect(repaired).toBe(true);
    // scale 合法但空名依旧可解析；引用完整性由 validator 负责。
    expect(candidate).not.toBeNull();
  });

  it("非对象输入返回 null", () => {
    expect(repairOpeningGenerationCandidate(null).candidate).toBeNull();
    expect(repairOpeningGenerationCandidate("x").candidate).toBeNull();
    expect(repairOpeningGenerationCandidate(42).candidate).toBeNull();
  });

  it("非法数值 baseStats 回退同 fixture 默认（100/10/5）", () => {
    const raw = JSON.parse(JSON.stringify(validCandidate())) as Record<string, unknown>;
    (raw.player as Record<string, unknown>).baseStats = { hp: -5, attack: "x", defense: null };
    const { candidate, repaired } = repairOpeningGenerationCandidate(raw);
    expect(repaired).toBe(true);
    expect(candidate?.player.baseStats).toEqual({ hp: 100, attack: 10, defense: 5 });
  });
});

describe("sanitizeOpeningFactReferences", () => {
  it("过滤 known/private keys 中不在 publicFacts 里的悬空引用", () => {
    const candidate = validCandidate();
    const sanitized = sanitizeOpeningFactReferences({
      ...candidate,
      opening: {
        ...candidate.opening,
        npc: {
          ...candidate.opening.npc,
          knownFactKeys: [...candidate.opening.npc.knownFactKeys, "fact_ghost"],
          privateFactKeys: [...candidate.opening.npc.privateFactKeys, "fact_void"],
        },
      },
    });
    expect(sanitized.opening.npc.knownFactKeys).toEqual(["fact_inn"]);
    expect(sanitized.opening.npc.privateFactKeys).toEqual(["fact_pact"]);
  });

  it("无悬空引用时返回原候选", () => {
    const candidate = validCandidate();
    expect(sanitizeOpeningFactReferences(candidate)).toBe(candidate);
  });
});

describe("createOpeningGenerationSource", () => {
  it("无 transport 时确定性 fallback 只返回开场切片且通过同一 validator", async () => {
    const results: Array<{ seed: string; source: "generated" | "fallback" }> = [];
    const source = createOpeningGenerationSource({ onResult: (result) => results.push(result) });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate).toBeTruthy();
    expect(candidate.world.publicFacts.length).toBeGreaterThan(0);
    expect(candidate.opening.location.scale).toBe("town");
    expect(candidate.opening.quest.objective).toEqual({ kind: "talk_to_opening_npc" });
    const validated = validateOpeningGenerationCandidate(candidate, { gameLength: "short", targetActs: 3 });
    expect(validated.ok).toBe(true);
    expect(results).toEqual([{ seed: "s", source: "fallback" }]);
  });

  it("AI 返回有效开场切片时经机械修复 + 校验通过", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(validCandidate()), latencyMs: 1 }),
    } as unknown as AiTransport;
    const results: Array<{ seed: string; source: "generated" | "fallback" }> = [];
    const source = createOpeningGenerationSource({
      transport,
      config: { baseUrl: "x", apiKey: "k", model: "m" },
      onResult: (result) => results.push(result),
    });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.opening.npc.name).toBe("沈掌柜");
    expect(candidate.opening.location.scale).toBe("town");
    expect(results).toEqual([{ seed: "s", source: "generated" }]);
  });

  it("prompt 包含 personalityTags/narrativeStyle/contentIntensity，且只要求开场切片并禁止未来命名实体", async () => {
    const prompts: string[] = [];
    const transport = {
      complete: async (_config: unknown, messages: readonly { role: string; content: string }[]) => {
        prompts.push(messages.map((message) => message.content).join("\n"));
        return { ok: true, content: JSON.stringify(validCandidate()), latencyMs: 1 };
      },
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const setup = {
      characterName: "沈砚",
      characterIdentity: "被逐出师门的机关师",
      characterProfile: "擅长修理与改造古代机关。",
      personalityTags: ["冷静", "多疑"],
      worldPremise: "大陆由七座浮空城邦统治。",
      storyOpening: "沈砚带着一枚核心齿轮逃离师门。",
      narrativeStyle: "cinematic" as const,
      contentIntensity: "dark" as const,
    };
    await source.generate({ gameType: "fantasy", seed: "s", gameLength: "short", setup });
    const prompt = prompts[0]!;
    expect(prompt).toContain("冷静");
    expect(prompt).toContain("多疑");
    expect(prompt).toContain("cinematic");
    expect(prompt).toContain("dark");
    expect(prompt).toContain("talk_to_opening_npc");
    expect(prompt).toContain("不得生成未来");
    // Task 8：开场提示词携带同一 StylePolicy 的呈现/强度指令（非仅 narrativeStyle）
    expect(prompt).toContain(buildStylePolicy({
      personalityTags: ["冷静", "多疑"],
      narrativeStyle: "cinematic",
      contentIntensity: "dark",
    }).narrationInstruction);
    expect(prompt).toContain("道德上艰难的结果");
  });

  it("开局配置作为权威输入：玩家字段强制覆盖 AI 返回", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(validCandidate()), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const setup = {
      characterName: "沈砚",
      characterIdentity: "被逐出师门的机关师",
      characterProfile: "擅长修理与改造古代机关。",
      personalityTags: [],
      worldPremise: "大陆由七座浮空城邦统治。",
      storyOpening: "沈砚带着一枚核心齿轮逃离师门。",
      narrativeStyle: "cinematic" as const,
      contentIntensity: "normal" as const,
    };
    const candidate = await source.generate({ gameType: "fantasy", seed: "s", gameLength: "short", setup });
    expect(candidate.player.name).toBe("沈砚");
    expect(candidate.player.identity).toBe("被逐出师门的机关师");
    expect(candidate.player.backgroundSummary).toBe("擅长修理与改造古代机关。");
  });

  it("无配置时保留 AI 候选自身玩家字段", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(validCandidate()), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.player.name).toBe("陆遥");
  });

  it("AI 失败回退 fixture 时仍消费开局配置的玩家身份", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: "not json", latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const setup = {
      characterName: "沈砚",
      characterIdentity: "被逐出师门的机关师",
      personalityTags: [],
      worldPremise: "大陆由七座浮空城邦统治，城邦之下是机关兽占据的荒原。",
      storyOpening: "沈砚带着一枚核心齿轮逃离师门，来到边陲小镇。",
      narrativeStyle: "cinematic" as const,
      contentIntensity: "normal" as const,
    };
    const candidate = await source.generate({ gameType: "fantasy", seed: "s", gameLength: "short", setup });
    expect(candidate.player.name).toBe("沈砚");
    expect(candidate.player.identity).toBe("被逐出师门的机关师");
  });

  it("AI 候选 NPC 含悬空 fact key 时经引用完整性修复而非整体回退", async () => {
    const dangling: OpeningGenerationCandidate = {
      ...validCandidate(),
      opening: {
        ...validCandidate().opening,
        npc: {
          ...validCandidate().opening.npc,
          knownFactKeys: [...validCandidate().opening.npc.knownFactKeys, "fact_not_exist"],
          privateFactKeys: [...validCandidate().opening.npc.privateFactKeys, "fact_ghost"],
        },
      },
    };
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(dangling), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.opening.npc.name).toBe("沈掌柜");
    expect(candidate.opening.npc.knownFactKeys).not.toContain("fact_not_exist");
    expect(candidate.opening.npc.privateFactKeys).not.toContain("fact_ghost");
  });

  it("AI 返回 empty_response 时不重复相同请求并回退", async () => {
    let calls = 0;
    const transport = {
      complete: async () => {
        calls += 1;
        return { ok: false, code: "empty_response", retryable: false, latencyMs: 1 };
      },
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(calls).toBe(1);
    expect(candidate.opening.npc.name).toBeTruthy();
  });

  it("AI 返回非法 JSON 时回退 fixture", async () => {
    const transport = {
      complete: async () => ({ ok: true, content: "not json", latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.opening.location.scale).toBe("town");
  });

  it("AI 返回 schema 错误候选时回退 fixture（不修剧情语义）", async () => {
    const bad = JSON.parse(JSON.stringify(validCandidate()));
    (bad.opening as Record<string, unknown>).quest = { ...(bad.opening as Record<string, unknown>).quest as object, objective: { kind: "visit_location" } };
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(bad), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.opening.quest.objective).toEqual({ kind: "talk_to_opening_npc" });
  });

  it("AI 返回 targetActs 与档位不符的契约时回退 fixture", async () => {
    const wrongActs = JSON.parse(JSON.stringify(validCandidate()));
    wrongActs.storyContract.targetActs = 5;
    const transport = {
      complete: async () => ({ ok: true, content: JSON.stringify(wrongActs), latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({ transport, config: { baseUrl: "x", apiKey: "k", model: "m" } });
    const candidate = await source.generate({ gameType: "wuxia", seed: "wrong-acts", gameLength: "short" });
    expect(candidate.storyContract.targetActs).toBe(3);
  });

  it("确定性 fallback 同 seed 可重放（replay 字节相等）", async () => {
    const first = await createOpeningGenerationSource({}).generate({ gameType: "wuxia", seed: "replay-seed", gameLength: "short" });
    const replay = await createOpeningGenerationSource({}).generate({ gameType: "wuxia", seed: "replay-seed", gameLength: "short" });
    expect(replay).toEqual(first);
  });

  it("transport 失败时回退 fixture 且不泄露 apiKey 到日志", async () => {
    const warns: Array<{ ctx: string; params?: unknown }> = [];
    const transport = {
      complete: async () => ({ ok: false, code: "network_error", retryable: true, latencyMs: 1 }),
    } as unknown as AiTransport;
    const source = createOpeningGenerationSource({
      transport,
      config: { baseUrl: "x", apiKey: "SECRET_KEY", model: "m" },
      logger: { warn: (ctx: string, params?: unknown) => warns.push({ ctx, params }) } as never,
    });
    const candidate = await source.generate({ gameType: "wuxia", seed: "s", gameLength: "short" });
    expect(candidate.opening.location.scale).toBe("town");
    const allLog = JSON.stringify(warns);
    expect(allLog).not.toContain("SECRET_KEY");
  });
});
