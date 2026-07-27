import {
  validateNewGameInput,
  type NewGameInput,
  type NewGameInputError
} from "@/game/domain";
import {
  compileScenarioBlueprint,
  createFallbackBlueprint,
  initializeGameState,
  loadScenarioProfiles,
  validateScenarioBlueprintCandidate,
  type ScenarioProfiles
} from "@/game/gameplay/rpg/scenario";
import { projectOpeningGameView, type OpeningGameView } from "./openingGameView";
import type { GameId, GameRepository } from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// createGame use case（Task 1 契约）。
// 严格顺序：validateNewGameInput → loadScenarioProfiles + createFallbackBlueprint
//   → validate/compile → initializeGameState → repository.createInitialGame
//   → 投影 OpeningGameView。
// 验证失败立即返回字段错误；任何生成/编译诊断映射为稳定 GENERATION_INVALID，
// 且绝不触及 repository。application 不读 process.env / 文件路径 / libsql 类型。
// ---------------------------------------------------------------------------

/** Phase 2 生成来源固定为 fallback，不调用 AI。 */
export type GenerationSource = "fallback";

/**
 * 创建命令：只承载浏览器允许提交的原始开局资料。
 * `seed` 仅供 server 端测试/组合根注入，浏览器提交不得携带（API adapter 负责拒收）；
 * 生产 seed 由 CreateGameDependencies.newSeed 提供，gameId/时钟同为注入依赖。
 */
export type CreateGameCommand = {
  readonly input: NewGameInput;
  readonly seed?: string;
};

/** 全部依赖注入：确定性由调用方掌控，测试不依赖真实时间或随机数。 */
export type CreateGameDependencies = {
  readonly repository: GameRepository;
  /** 新存档 ID provider：生产为 UUID，测试注入固定值。 */
  readonly newGameId: () => GameId;
  /** 生产 seed provider；command.seed 存在时优先生效。 */
  readonly newSeed: () => string;
  /** 注入时钟：返回 ISO 8601 字符串，用作存档 createdAt。 */
  readonly now: () => string;
  /** 场景 profile 配置：缺省加载内置 data/base 配置，测试可注入变体。 */
  readonly profiles?: ScenarioProfiles;
};

export type CreateGameResult =
  | {
      readonly ok: true;
      readonly gameId: GameId;
      readonly source: GenerationSource;
      readonly view: OpeningGameView;
    }
  // 输入验证失败：字段错误原样透传（含可显示 params），供表单逐字段提示。
  | {
      readonly ok: false;
      readonly code: "INVALID_INPUT";
      readonly fieldErrors: readonly NewGameInputError[];
    }
  // 生成/编译诊断、存档冲突与基础设施失败：只暴露稳定代码，不泄漏内部细节。
  | {
      readonly ok: false;
      readonly code: "GENERATION_INVALID" | "ACTIVE_GAME_EXISTS" | "INFRASTRUCTURE_FAILURE";
    };

export async function createGame(
  command: CreateGameCommand,
  deps: CreateGameDependencies
): Promise<CreateGameResult> {
  const validatedInput = validateNewGameInput(command.input);
  if (!validatedInput.ok) {
    return { ok: false, code: "INVALID_INPUT", fieldErrors: validatedInput.errors };
  }

  const profiles = deps.profiles ?? loadScenarioProfiles();
  const profile = profiles.gameTypeProfiles[validatedInput.value.gameType];
  const seed = command.seed ?? deps.newSeed();
  const candidate = createFallbackBlueprint(validatedInput.value, seed, { profiles });
  const compiled = compileScenarioBlueprint(
    validateScenarioBlueprintCandidate(candidate, { profile })
  );
  if (!compiled.ok) {
    // 规则诊断只映射稳定代码：不外泄 issue 细节，也不触及 repository。
    return { ok: false, code: "GENERATION_INVALID" };
  }

  const state = initializeGameState(compiled.blueprint);
  const gameId = deps.newGameId();
  const created = await deps.repository.createInitialGame({
    gameId,
    blueprint: compiled.blueprint,
    state,
    createdAt: deps.now()
  });
  if (!created.ok) {
    return { ok: false, code: created.code };
  }

  return {
    ok: true,
    gameId,
    source: "fallback",
    view: projectOpeningGameView({
      gameId,
      blueprint: compiled.blueprint,
      state,
      worldName: profile.label
    })
  };
}
