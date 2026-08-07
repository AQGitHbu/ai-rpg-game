import { describe, expect, it } from "vitest";
import { validateNewGameInput, createBudgetPolicy, type NewGameInput } from "@/game/domain";
import {
  createFallbackBlueprint,
  loadScenarioProfiles
} from "@/game/gameplay/rpg/scenario";
import type { ScenarioGenerationRequest } from "../../scenarioGeneration";
import { buildScenarioPromptMessages } from "./scenarioPrompt";

// ---------------------------------------------------------------------------
// scenarioPrompt 契约测试：仅用 ScenarioGenerationRequest + 已加载 profiles 构造
// AiMessage[]。要求：system 指令要求只输出 JSON、拒绝模型覆盖规则；user 携带
// 输入 seed、所选 gameType 范围、内容预算与双结局可达性要求。prompt 是 server-only，
// 不导出到 client/fixture/日志（由目录边界守卫保证）。
// ---------------------------------------------------------------------------

const NEW_GAME_INPUT: NewGameInput = {
  gameType: "wuxia",
  characterName: "沈青崖",
  characterIdentity: "落魄镖师",
  characterProfile: "青崖镖局独子，镖局一夜覆灭后流落江湖。",
  personalityTags: ["坚毅", "重情义"],
  worldPremise: "镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜。",
  storyOpening: "暮色四合，主角背着旧刀走进青石镇，镇口贴着一张缉凶告示。",
  narrativeStyle: "novel",
  contentIntensity: "normal"
};

const PROFILES = loadScenarioProfiles();

function buildRequest(): ScenarioGenerationRequest {
  const validated = validateNewGameInput(NEW_GAME_INPUT);
  if (!validated.ok) throw new Error("测试输入必须合法");
  return { input: validated.value, seed: "phase4b-seed-001", traceId: "trace-live-0001" };
}

describe("buildScenarioPromptMessages", () => {
  it("返回至少 system + user 两条消息，角色合法", () => {
    const messages = buildScenarioPromptMessages(buildRequest(), PROFILES);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const message of messages) {
      expect(["system", "user", "assistant"]).toContain(message.role);
      expect(typeof message.content).toBe("string");
      expect(message.content.length).toBeGreaterThan(0);
    }
    expect(messages[0].role).toBe("system");
  });

  it("system 指令要求只输出 JSON 且拒绝模型覆盖规则", () => {
    const [system] = buildScenarioPromptMessages(buildRequest(), PROFILES);
    expect(system.content).toContain("JSON");
    // 明确拒绝模型对系统指令/规则的任何覆盖。
    expect(system.content).toMatch(/忽略|不得覆盖|不接受/);
  });

  it("user 消息携带 seed、玩家输入、gameType 范围与内容预算", () => {
    const messages = buildScenarioPromptMessages(buildRequest(), PROFILES);
    const joined = messages.map((message) => message.content).join("\n");
    // 输入 seed 用于可复现生成。
    expect(joined).toContain("phase4b-seed-001");
    // 玩家提交的开局资料。
    expect(joined).toContain("沈青崖");
    expect(joined).toContain("落魄镖师");
    // 所选 gameType 的约束/标签范围。
    const profile = PROFILES.gameTypeProfiles.wuxia;
    expect(joined).toContain(profile.label);
    expect(joined).toContain(profile.allowedTags[0]);
    // 内容预算数字与双结局要求。
    const policy = createBudgetPolicy("open");
    expect(joined).toContain(String(policy.opening.coreNpcsMax));
    expect(joined).toContain(String(policy.opening.endings));
    expect(joined).toMatch(/结局/);
  });

  it("user 消息指导 Phase 14 开局收窄：起始锚点、序幕与实体数量硬约束", () => {
    const messages = buildScenarioPromptMessages(buildRequest(), PROFILES);
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toContain("1 个主要地点、1 个 NPC、1 个主线任务（stage 1）");
    expect(joined).toContain('startAnchor 固定为 { locationId: "loc_1", npcId: "npc_1", startQuestId: "quest_main_1" }');
    expect(joined).toContain("items / enemies / endings 必须为空数组");
  });

  it("明确锁定任务目标枚举，避免模型把 obtain_item 改写成自然语言同义词", () => {
    const messages = buildScenarioPromptMessages(buildRequest(), PROFILES);
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toContain("objective.kind 只能是 visit_location、talk_to_npc、obtain_item、discover_fact、defeat_enemy");
    expect(joined).toContain("禁止写 collect_item");
  });

  it("要求 stage 1 主线任务目标可验证、结果闭环且无孤儿事实", () => {
    const base = buildRequest();
    const longRequest: ScenarioGenerationRequest = {
      ...base,
      input: { ...base.input, gameLength: "long" },
    };
    const messages = buildScenarioPromptMessages(longRequest, PROFILES);
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toContain("stage 1 主线任务必须有至少一个可验证 objective");
    expect(joined).toContain("onSuccess/onFailure 只能使用 closed（后续任务由运行时解锁）");
    expect(joined).toContain("每条 source=generated 的事实必须至少出现在 openingScene.investigableFactIds 或某个 NPC.knownFactIds 中");
    expect(joined).toContain('"kind":"talk_to_npc","npcId":"npc_1"');
  });

  it("明确锁定开局实体边界：items/enemies/endings 为空、结局方向与序幕必填", () => {
    const messages = buildScenarioPromptMessages(buildRequest(), PROFILES);
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).toContain("items / enemies / endings 必须为空数组");
    expect(joined).toContain("endingDirection 必须含 theme");
    expect(joined).toContain("possibleTones");
    expect(joined).toContain("lockedAt");
    expect(joined).toContain("openingScene 必须含 prologue");
    expect(joined).toContain("tone 只能是 serious / epic / mysterious");
  });

  it("嵌入由同一输入与 seed 派生的完整有效候选样例，作为模型必须遵守的 JSON 契约", () => {
    const request = buildRequest();
    const messages = buildScenarioPromptMessages(request, PROFILES);
    const expectedTemplate = createFallbackBlueprint(request.input, request.seed, {
      profiles: PROFILES
    });
    const userMessage = messages.find((message) => message.role === "user")?.content ?? "";

    expect(userMessage).toContain("严格候选 JSON 契约");
    expect(userMessage).toContain(JSON.stringify(expectedTemplate));
  });

  it("相同 request + profiles 产出确定性一致的消息", () => {
    const a = buildScenarioPromptMessages(buildRequest(), PROFILES);
    const b = buildScenarioPromptMessages(buildRequest(), PROFILES);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
