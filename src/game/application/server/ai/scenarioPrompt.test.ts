import { describe, expect, it } from "vitest";
import { validateNewGameInput, CONTENT_BUDGET, type NewGameInput } from "@/game/domain";
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
    expect(joined).toContain(String(CONTENT_BUDGET.coreNpcsMax));
    expect(joined).toContain(String(CONTENT_BUDGET.endings));
    expect(joined).toMatch(/结局/);
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
