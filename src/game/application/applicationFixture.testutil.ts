import { createBudgetPolicy, validateNewGameInput, type GameState, type NewGameInput, type ScenarioBlueprint } from "@/game/domain";
import {
  compileScenarioBlueprint,
  createFallbackBlueprint,
  initializeGameState,
  loadScenarioProfiles,
  validateScenarioBlueprintCandidate,
  type ScenarioProfiles
} from "@/game/gameplay/rpg/scenario";
import type { CreateGameDependencies } from "./createGame";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateSource
} from "./scenarioGeneration";
import {
  asGameId,
  type ApplyBlueprintExpansionInput,
  type ApplyResolvedActionInput,
  type ApplyResolvedActionResult,
  type CreateInitialGameInput,
  type CreateInitialGameResult,
  type GameRepository,
  type GetCurrentGameRecordResult
} from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// application 测试共用工具：fake repository（stub/spy 端口）、固定注入依赖，
// 以及独立复跑 Phase 1 管线得到期望蓝图/状态的 helper。
// ---------------------------------------------------------------------------

export const TEST_GAME_ID = asGameId("game-test-0001");
export const TEST_CREATED_AT = "2026-07-27T00:00:00.000Z";
export const TEST_TRACE_ID = "trace-test-0001";

/**
 * 默认注入的 unavailable 假 source（纯 inline，不碰 server/ai）：两次尝试都
 * 失败 ⇒ 编排稳定走 fallback，既有测试的蓝图/视图期望与 Phase 2 完全一致。
 */
export function createUnavailableTestScenarioSource(): ScenarioCandidateSource {
  return {
    async generate() {
      return {
        ok: false,
        contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
        origin: "unavailable",
        category: "service_error",
        diagnostics: ["PHASE4A_NO_LIVE_SOURCE"]
      };
    }
  };
}

export type FakeGameRepository = GameRepository & {
  /** spy：记录每次 createInitialGame 收到的完整载荷。 */
  readonly createCalls: CreateInitialGameInput[];
  /** spy：记录每次 applyResolvedAction 收到的完整载荷。 */
  readonly applyCalls: ApplyResolvedActionInput[];
  /** spy：记录每次 applyBlueprintExpansion 收到的完整载荷。 */
  readonly expansionCalls: ApplyBlueprintExpansionInput[];
  setCreateResult(result: CreateInitialGameResult): void;
  setCurrentResult(result: GetCurrentGameRecordResult): void;
  setApplyResult(result: ApplyResolvedActionResult): void;
  setExpansionResult(result: ApplyResolvedActionResult): void;
};

export function createFakeGameRepository(): FakeGameRepository {
  const createCalls: CreateInitialGameInput[] = [];
  const applyCalls: ApplyResolvedActionInput[] = [];
  const expansionCalls: ApplyBlueprintExpansionInput[] = [];
  let createResult: CreateInitialGameResult = { ok: true };
  let currentResult: GetCurrentGameRecordResult = { ok: true, status: "none" };
  let applyResult: ApplyResolvedActionResult = { ok: false, code: "NO_ACTIVE_GAME" };
  let expansionResult: ApplyResolvedActionResult = { ok: false, code: "NO_ACTIVE_GAME" };
  return {
    createCalls,
    applyCalls,
    expansionCalls,
    setCreateResult(result) {
      createResult = result;
    },
    setCurrentResult(result) {
      currentResult = result;
    },
    setApplyResult(result) {
      applyResult = result;
    },
    setExpansionResult(result) {
      expansionResult = result;
    },
    async createInitialGame(input) {
      createCalls.push(input);
      return createResult;
    },
    async getCurrentGame() {
      return currentResult;
    },
    async applyResolvedAction(input) {
      applyCalls.push(input);
      return applyResult;
    },
    async applyBlueprintExpansion(input) {
      expansionCalls.push(input);
      return expansionResult;
    }
  };
}

/** 固定注入依赖：gameId/seed/clock 全部确定，测试不依赖真实时间或随机数。 */
export function createTestDependencies(
  repository: GameRepository,
  overrides: Partial<CreateGameDependencies> = {}
): CreateGameDependencies {
  return {
    repository,
    newGameId: () => TEST_GAME_ID,
    newSeed: () => "seed-from-provider",
    now: () => TEST_CREATED_AT,
    scenarioCandidateSource: createUnavailableTestScenarioSource(),
    newTraceId: () => TEST_TRACE_ID,
    ...overrides
  };
}

/** 独立复跑既有管线，作为 use case 结果的期望基准（与 phase1Regression 同构）。 */
export function runScenarioPipeline(
  input: NewGameInput,
  seed: string,
  profiles: ScenarioProfiles = loadScenarioProfiles()
): { blueprint: ScenarioBlueprint; state: GameState } {
  const validatedInput = validateNewGameInput(input);
  if (!validatedInput.ok) {
    throw new Error(`输入校验失败：${JSON.stringify(validatedInput.errors)}`);
  }
  const candidate = createFallbackBlueprint(validatedInput.value, seed, { profiles });
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(candidate, {
      profile: profiles.gameTypeProfiles[input.gameType],
      policy: createBudgetPolicy(validatedInput.value.gameLength)
    })
  );
  if (!compiled.ok) {
    throw new Error(`编译失败：${JSON.stringify(compiled.issues)}`);
  }
  return { blueprint: compiled.blueprint, state: initializeGameState(compiled.blueprint) };
}
