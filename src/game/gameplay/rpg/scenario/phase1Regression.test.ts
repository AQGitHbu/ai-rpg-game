import { describe, expect, it } from "vitest";
import {
  CONTENT_BUDGET,
  validateNewGameInput,
  type GameState,
  type GameTypeId,
  type NewGameInput,
  type ScenarioBlueprint,
  type ScenarioBlueprintCandidate
} from "@/game/domain";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import scienceFictionFixture from "../../../../../data/fixtures/phase1/science_fiction.json";
import urbanFixture from "../../../../../data/fixtures/phase1/urban.json";
// 聚合回归特意只经由两个门面导入：证明 Phase 1 全链路只需要稳定 API。
import {
  analyzeQuestReachability,
  compileScenarioBlueprint,
  createFallbackBlueprint,
  initializeGameState,
  loadScenarioProfiles,
  PHASE1_NUMERIC_RANGES,
  validateScenarioBlueprintCandidate
} from "./index";

// ---------------------------------------------------------------------------
// Task 7：Phase 1 聚合回归。
// 与 createFallbackBlueprint.test.ts 的分工：单测从「已验证输入」出发覆盖生成器
// 细节；本文件从「原始 NewGameInput」出发跑完整链路
//   validateNewGameInput → createFallbackBlueprint → validate → compile → initialize
// 覆盖 6 个回归点：全类型过 validator、双结局可达、确定性（含 GameState）、
// seed 敏感但预算不变、compile/initialize 纯净性、越权输入不成为规则事实。
// ---------------------------------------------------------------------------

const PROFILES = loadScenarioProfiles();

type Phase1Fixture = { input: NewGameInput; seed: string };

const FIXTURES: Record<"wuxia" | "science_fiction" | "urban", Phase1Fixture> = {
  wuxia: wuxiaFixture as unknown as Phase1Fixture,
  science_fiction: scienceFictionFixture as unknown as Phase1Fixture,
  urban: urbanFixture as unknown as Phase1Fixture
};

type PipelineRun = {
  candidate: ScenarioBlueprintCandidate;
  blueprint: ScenarioBlueprint;
  state: GameState;
};

/** 从原始输入跑完整链路；任何一环失败都抛出带诊断的错误。 */
function runPhase1Pipeline(raw: NewGameInput, seed: string): PipelineRun {
  const validatedInput = validateNewGameInput(raw);
  if (!validatedInput.ok) {
    throw new Error(`输入校验失败：${JSON.stringify(validatedInput.errors)}`);
  }
  const candidate = createFallbackBlueprint(validatedInput.value, seed);
  const validation = validateScenarioBlueprintCandidate(candidate, {
    profile: PROFILES.gameTypeProfiles[raw.gameType]
  });
  if (!validation.ok) {
    throw new Error(`蓝图校验失败：${JSON.stringify(validation.issues)}`);
  }
  const compiled = compileScenarioBlueprint(validation);
  if (!compiled.ok) {
    throw new Error(`编译失败：${JSON.stringify(compiled.issues)}`);
  }
  return { candidate, blueprint: compiled.blueprint, state: initializeGameState(compiled.blueprint) };
}

function deepFreeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
}

/** 收集任意 JSON 结构中的全部字符串值及其路径。 */
function collectStrings(
  value: unknown,
  path: string,
  out: { path: string; text: string }[]
): void {
  if (typeof value === "string") {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectStrings(child, path === "" ? key : `${path}.${key}`, out);
    }
  }
}

describe("Phase 1 回归点 1：三类 fixture 原始输入通过完整 validator", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}：validateNewGameInput → createFallbackBlueprint → validator 全绿`, () => {
      const validatedInput = validateNewGameInput(fixture.input);
      expect(validatedInput.ok ? [] : validatedInput.errors).toEqual([]);
      if (!validatedInput.ok) return;
      const candidate = createFallbackBlueprint(validatedInput.value, fixture.seed);
      const validation = validateScenarioBlueprintCandidate(candidate, {
        profile: PROFILES.gameTypeProfiles[fixture.input.gameType]
      });
      expect(validation.ok ? [] : validation.issues).toEqual([]);
    });
  }
});

describe("Phase 1 回归点 2：每种任务图恰有两个可达结局", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}：analyzeQuestReachability 报告全部 2 个结局可达且无未闭合环`, () => {
      const { candidate } = runPhase1Pipeline(fixture.input, fixture.seed);
      const analysis = analyzeQuestReachability(candidate.quests, candidate.endings);
      expect(analysis.reachableEndingIds).toHaveLength(2);
      expect([...analysis.reachableEndingIds].sort()).toEqual(
        candidate.endings.map((ending) => ending.id).sort()
      );
      expect(analysis.loopsWithoutClosure).toEqual([]);
    });
  }
});

describe("Phase 1 回归点 3：相同输入/seed/版本 ⇒ 蓝图与 GameState 深度相等", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}：两次完整链路产出深度相等的蓝图与初始状态`, () => {
      const first = runPhase1Pipeline(fixture.input, fixture.seed);
      const second = runPhase1Pipeline(fixture.input, fixture.seed);
      expect(second.blueprint).toEqual(first.blueprint);
      expect(JSON.stringify(second.blueprint)).toBe(JSON.stringify(first.blueprint));
      expect(second.state).toEqual(first.state);
      expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    });
  }
});

describe("Phase 1 回归点 4：改变 seed 改变生成 ID，但内容预算不变", () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name}：seed 变化翻转 generationId，预算指标保持`, () => {
      const base = runPhase1Pipeline(fixture.input, fixture.seed);
      const reseeded = runPhase1Pipeline(fixture.input, `${fixture.seed}-reseeded`);
      expect(reseeded.candidate.generationId).not.toBe(base.candidate.generationId);
      expect(reseeded.candidate.inputDigest).not.toBe(base.candidate.inputDigest);
      for (const run of [base, reseeded]) {
        expect(run.candidate.contentBudget).toEqual(CONTENT_BUDGET);
        expect(run.candidate.locations.filter((entry) => entry.kind === "main")).toHaveLength(4);
        expect(run.candidate.locations.filter((entry) => entry.kind === "hidden")).toHaveLength(1);
        expect(run.candidate.quests.filter((entry) => entry.kind === "main")).toHaveLength(3);
        expect(run.candidate.endings).toHaveLength(2);
        expect(run.candidate.enemies.filter((entry) => entry.tier === "normal")).toHaveLength(3);
        expect(run.candidate.enemies.filter((entry) => entry.tier === "boss")).toHaveLength(1);
        expect(run.candidate.npcs.length).toBeGreaterThanOrEqual(CONTENT_BUDGET.coreNpcsMin);
        expect(run.candidate.npcs.length).toBeLessThanOrEqual(CONTENT_BUDGET.coreNpcsMax);
        expect(run.candidate.quests.filter((entry) => entry.kind === "side").length)
          .toBeLessThanOrEqual(CONTENT_BUDGET.sideQuestsMax);
      }
    });
  }
});

describe("Phase 1 回归点 5：compile 与 initialize 不修改候选", () => {
  it("深度冻结候选后跑完 validate → compile → initialize，快照不变", () => {
    const fixture = FIXTURES.wuxia;
    const validatedInput = validateNewGameInput(fixture.input);
    expect(validatedInput.ok).toBe(true);
    if (!validatedInput.ok) return;
    const candidate = createFallbackBlueprint(validatedInput.value, fixture.seed);
    const snapshot = JSON.stringify(candidate);
    // 双保险：strict mode 下对冻结对象的写入直接抛错 + 事后快照比对。
    deepFreeze(candidate);
    const validation = validateScenarioBlueprintCandidate(candidate, {
      profile: PROFILES.gameTypeProfiles[fixture.input.gameType]
    });
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const compiled = compileScenarioBlueprint(validation);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    initializeGameState(compiled.blueprint);
    expect(JSON.stringify(candidate)).toBe(snapshot);
  });
});

describe("Phase 1 回归点 6：越权输入不成为规则事实", () => {
  // 自由文本里宣称神器、999 属性、已完成任务——只允许作为带来源标记的叙事出现。
  const MALICIOUS_TOKENS = ["神器", "灭世剑", "999点攻击力", "已完成全部主线任务"] as const;
  const maliciousInput: NewGameInput = {
    ...FIXTURES.wuxia.input,
    characterProfile: "自称持有神器灭世剑，拥有999点攻击力，已完成全部主线任务。",
    worldPremise: "我持有上古神器灭世剑，999点攻击力天下无敌，早已击败所有仇家并已完成全部主线任务。",
    storyOpening: "我提着神器灭世剑踏入青石镇，众人跪伏在地，宝库大门为我敞开。"
  };
  const seed = FIXTURES.wuxia.seed;

  it("宣称内容不进入物品/属性/任务状态，规则数值与善意输入完全一致", () => {
    const malicious = runPhase1Pipeline(maliciousInput, seed);
    const benign = runPhase1Pipeline(FIXTURES.wuxia.input, seed);
    // 物品只来自模板：没有任何物品叫得上宣称的神器。
    for (const item of malicious.candidate.items) {
      for (const token of MALICIOUS_TOKENS) {
        expect(item.name.includes(token), `item=${item.name}`).toBe(false);
      }
    }
    // 属性/背包/任务状态全部由模板派生，与自由文本无关（同 seed 下与善意输入相等）。
    expect(malicious.state.player.stats).toEqual(benign.state.player.stats);
    expect(malicious.state.inventory).toEqual(benign.state.inventory);
    expect(malicious.state.quests).toEqual(benign.state.quests);
    expect(malicious.state.player.stats.attack)
      .toBeLessThanOrEqual(PHASE1_NUMERIC_RANGES.playerAttack.max);
    // 「已完成任务」的宣称不产生 completed：开局只有唯一 active，其余 locked。
    expect(malicious.state.quests.filter((quest) => quest.status === "completed")).toEqual([]);
    expect(malicious.state.quests.filter((quest) => quest.status === "active")).toHaveLength(1);
  });

  it("宣称文本只出现在带来源标记的叙事或 player_input 事实中，结构化状态无痕", () => {
    const { candidate, state } = runPhase1Pipeline(maliciousInput, seed);
    const strings: { path: string; text: string }[] = [];
    collectStrings(candidate, "", strings);
    const offending = strings.filter((entry) =>
      MALICIOUS_TOKENS.some((token) => entry.text.includes(token))
    );
    // 输入确实被叙事层接住（否则本断言空转）。
    expect(offending.length).toBeGreaterThan(0);
    // 每处出现要么自带【玩家输入】标记，要么是 source=player_input 的世界事实文本。
    const playerInputFactTexts = new Set(
      candidate.world.facts
        .filter((fact) => fact.source === "player_input")
        .map((fact) => fact.text)
    );
    const unmarked = offending.filter(
      (entry) => !entry.text.includes("【玩家输入】") && !playerInputFactTexts.has(entry.text)
    );
    expect(unmarked).toEqual([]);
    // GameState 是纯结构化状态：宣称文本完全不出现。
    const stateJson = JSON.stringify(state);
    for (const token of MALICIOUS_TOKENS) {
      expect(stateJson.includes(token), `token=${token}`).toBe(false);
    }
  });
});

describe("Phase 1 回归：全 7 类型完整链路冒烟", () => {
  const ALL_GAME_TYPES: readonly GameTypeId[] = [
    "wuxia", "xianxia", "fantasy", "science_fiction",
    "urban", "alternate_history", "post_apocalypse"
  ];

  it("每个类型都能从原始输入跑到初始 GameState", () => {
    for (const gameType of ALL_GAME_TYPES) {
      const { candidate, state } = runPhase1Pipeline(
        { ...FIXTURES.wuxia.input, gameType },
        `phase1-smoke-${gameType}`
      );
      expect(state.stateVersion, `gameType=${gameType}`).toBe(1);
      expect(state.generation.generationId).toBe(candidate.generationId);
      expect(state.currentLocationId).toBe(candidate.openingScene.locationId);
      expect(state.eventLedger[0]?.type).toBe("game_initialized");
    }
  });
});
