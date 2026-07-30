import {
  validateNewGameInput,
  type NewGameInput,
  type NewGameInputError,
  type ScenarioBlueprint
} from "@/game/domain";
import {
  compileScenarioBlueprint,
  createFallbackBlueprint,
  initializeGameState,
  loadScenarioProfiles,
  validateScenarioBlueprintCandidate,
  type ScenarioBlueprintIssue,
  type ScenarioProfiles
} from "@/game/gameplay/rpg/scenario";
import { projectGameSessionView, type GameSessionView } from "./gameSessionView";
import { repairScenarioCandidate } from "./scenarioCandidateRecovery";
import type {
  ScenarioCandidateAttempt,
  ScenarioCandidateFailureCategory,
  ScenarioCandidateSource,
  ScenarioGenerationEvent,
  ScenarioGenerationSource
} from "./scenarioGeneration";
import type {
  CreateInitialGameResult,
  GameId,
  GameRepository
} from "./server/persistence/gameRepository";
import type { DirectorSource, NpcLineSource, SceneScriptSource } from "./runtimeNarrative";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";

/**
 * 将校验器的细粒度 issue 收敛为生成契约已有的、可脱敏汇总的失败分类。
 * issue 的顺序由校验器稳定决定；取首项既保留最先阻断生成的原因，又不向日志
 * 泄漏候选内容、字段路径或具体参数。
 */
function classifyValidationFailure(
  issues: readonly ScenarioBlueprintIssue[]
): ScenarioCandidateFailureCategory {
  switch (issues[0]?.code) {
    case "CONTENT_BUDGET_MISMATCH":
    case "MAIN_LOCATION_COUNT_MISMATCH":
    case "HIDDEN_LOCATION_OVERBUDGET":
    case "CORE_NPC_COUNT_OUT_OF_RANGE":
    case "COMPANION_OVERBUDGET":
    case "ENDING_COUNT_MISMATCH":
    case "MAIN_STAGE_OVERBUDGET":
    case "SIDE_QUEST_OVERBUDGET":
      return "budget_exceeded";
    case "DANGLING_REFERENCE":
    case "DANGLING_QUEST_REF":
    case "DANGLING_ENDING_REF":
    case "UNKNOWN_OBJECTIVE_TARGET":
    case "INVALID_ENDING_REQUIREMENT":
      return "reference_broken";
    case "NO_INITIAL_MAIN_QUEST":
    case "MULTIPLE_INITIAL_MAIN_QUESTS":
    case "MISSING_MAIN_STAGE":
    case "LOOP_WITHOUT_CLOSURE":
    case "UNREACHABLE_ENDING":
      return "unreachable_ending";
    case "GAME_TYPE_MISMATCH":
    case "FORBIDDEN_TAG":
      return "cross_type_content";
    case "DUPLICATE_GLOBAL_ID":
    case "DUPLICATE_AVAILABLE_ITEM":
    case "STARTING_ITEM_AVAILABLE_AT_LOCATION":
    case "OPENING_SCENE_HIDDEN_LOCATION":
    case "OPENING_NPC_NOT_AT_LOCATION":
    case "OPENING_SCENE_NO_INVESTIGABLE_FACTS":
    case "DUPLICATE_INVESTIGABLE_FACT":
    case "DUPLICATE_QUEST_ID":
    case "DUPLICATE_ENDING_ID":
      return "illegal_entity";
    default:
      return "schema_violation";
  }
}

// ---------------------------------------------------------------------------
// createGame use case（Task 1 契约 + Phase 4A Task 3 候选编排）。
// 严格顺序：validateNewGameInput → attempt #1（validate/compile 或 repair 一次）
//   → attempt #2 同流程 → createFallbackBlueprint → validate/compile
//   → initializeGameState → repository.createInitialGame 一次 → 投影 GameSessionView。
// source 失败永不变 GENERATION_INVALID（仅 fallback 本身不可编译才返回该码）；
// diagnostics/阶段事件不进 CreateGameResult，observer 仅供契约测试/结构化日志。
// application 不读 process.env / 文件路径 / libsql 类型。
// ---------------------------------------------------------------------------

/** 创建结果的安全来源区分（spec §5）：Phase 4A 起可为 generated 或 fallback。 */
export type GenerationSource = ScenarioGenerationSource;

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
  /** Phase 4A：候选来源 port；生产注入 unavailable source（稳定走 fallback）。 */
  readonly scenarioCandidateSource: ScenarioCandidateSource;
  /** 每次创建一个 traceId：只进 source 请求与日志，绝不进玩家 API 响应。 */
  readonly newTraceId: () => string;
  /** 可选阶段观察者：仅供契约测试/日志；抛错被吞，不写库、不经 API 返回。 */
  readonly generationObserver?: (event: ScenarioGenerationEvent) => void;
  /** 场景 profile 配置：缺省加载内置 data/base 配置，测试可注入变体。 */
  readonly profiles?: ScenarioProfiles;
  /** Optional only for legacy/unit callers; production always injects the three sources. */
  readonly runtimeNarrativeSources?: Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }>;
};

export type CreateGameResult =
  | {
      readonly ok: true;
      readonly gameId: GameId;
      readonly source: GenerationSource;
      readonly view: GameSessionView;
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
  const emit = (event: ScenarioGenerationEvent): void => {
    try {
      deps.generationObserver?.(event);
    } catch {
      // observer 只做诊断：任何异常不得影响创建流程。
    }
  };

  // ── 候选编排：最多两次 source 尝试，每次允许一次机械修复；全部失败走 fallback。
  emit({ stage: "requested" });
  const request = { input: validatedInput.value, seed, traceId: deps.newTraceId() };
  let blueprint: ScenarioBlueprint | null = null;
  let source: GenerationSource = "fallback";
  // 默认值保证 fallback 事件始终有一个稳定、可汇总的脱敏原因。
  let lastFailureCategory: ScenarioCandidateFailureCategory = "service_error";

  for (let attemptIndex = 0; attemptIndex < 2 && blueprint === null; attemptIndex += 1) {
    if (attemptIndex === 1) emit({ stage: "retrying" });
    let attempt: ScenarioCandidateAttempt;
    try {
      attempt = await deps.scenarioCandidateSource.generate(request);
    } catch {
      // source 契约外抛错视同失败尝试：绝不外泄、绝不变 GENERATION_INVALID。
      lastFailureCategory = "service_error";
      continue;
    }
    if (!attempt.ok) {
      lastFailureCategory = attempt.category;
      continue;
    }

    emit({ stage: "candidate_received" });
    emit({ stage: "validating" });
    const validation = validateScenarioBlueprintCandidate(attempt.candidate, { profile });
    if (validation.ok) {
      const compiled = compileScenarioBlueprint(validation);
      if (compiled.ok) {
        blueprint = compiled.blueprint;
        source = "generated";
      } else {
        lastFailureCategory = "illegal_entity";
      }
      continue;
    }
    lastFailureCategory = classifyValidationFailure(validation.issues);
    // 一次机械修复：修复成功（非 null）才发 repairing，否则直接重试/fallback。
    const repaired = repairScenarioCandidate(attempt.candidate, { profiles });
    if (repaired === null) continue;
    emit({ stage: "repairing" });
    const repairedValidation = validateScenarioBlueprintCandidate(repaired, { profile });
    if (!repairedValidation.ok) {
      lastFailureCategory = classifyValidationFailure(repairedValidation.issues);
      continue;
    }
    const compiledRepaired = compileScenarioBlueprint(repairedValidation);
    if (compiledRepaired.ok) {
      blueprint = compiledRepaired.blueprint;
      source = "generated";
    } else {
      lastFailureCategory = "illegal_entity";
    }
  }

  if (blueprint === null) {
    emit({ stage: "falling_back", category: lastFailureCategory });
    const candidate = createFallbackBlueprint(validatedInput.value, seed, { profiles });
    const compiled = compileScenarioBlueprint(
      validateScenarioBlueprintCandidate(candidate, { profile })
    );
    if (!compiled.ok) {
      // 仅 fallback 本身不可编译才返回该码：不外泄 issue，也不触及 repository。
      return { ok: false, code: "GENERATION_INVALID" };
    }
    blueprint = compiled.blueprint;
    source = "fallback";
  }

  let state = initializeGameState(blueprint);
  if (deps.runtimeNarrativeSources !== undefined && canQueueRuntimeNarrativeScene(blueprint, state)) {
    // Rules and the initial save complete immediately. The server-side task
    // coordinator later produces the scene and CAS-saves it from this marker.
    state = {
      ...state,
      narrative: { currentScene: null, generation: { status: "pending", requestedAt: deps.now() } },
    };
  }
  const gameId = deps.newGameId();
  let created: CreateInitialGameResult;
  try {
    created = await deps.repository.createInitialGame({
      gameId,
      blueprint,
      state,
      createdAt: deps.now()
    });
  } catch {
    // 端口契约外的意外抛错（adapter 漏网的驱动异常等）：与结构化失败同样
    // 映射稳定代码，异常文本绝不向 API/UI 层泄漏。
    emit({ stage: "failed", category: "persistence_failure" });
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }
  if (!created.ok) {
    emit({ stage: "failed", category: "persistence_failure" });
    return { ok: false, code: created.code };
  }

  emit({ stage: "completed", outcome: source });
  return {
    ok: true,
    gameId,
    source,
    view: projectGameSessionView({
      gameId,
      blueprint,
      state,
      revision: 0,
      worldName: profile.label
    })
  };
}
