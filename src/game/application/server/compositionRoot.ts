import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { NewGameInput } from "@/game/domain";
import { createServerConsoleLogger } from "@/game/logging/serverConsoleLogger";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";
import {
  createGame,
  type CreateGameDependencies,
  type CreateGameResult
} from "../createGame";
import type { ScenarioGenerationEvent } from "../scenarioGeneration";
import {
  SCENARIO_CANDIDATE_CONTRACT_VERSION,
  type ScenarioCandidateSource,
} from "../scenarioGeneration";
import { getCurrentGame, type CurrentGameResult } from "../getCurrentGame";
import {
  performAction,
  type PerformActionCommand,
  type PerformActionDependencies,
  type PerformActionResult
} from "../performAction";
import {
  handleNpcDialogue,
  type HandleNpcDialogueCommand,
  type HandleNpcDialogueDependencies,
  type HandleNpcDialogueResult
} from "../handleNpcDialogue";
import { asGameId, type GameId } from "./persistence/gameRepository";
import { createScenarioCandidateSource } from "./ai/scenarioCandidateSourceFactory";
import { createRuntimeNarrativeSources } from "./ai/runtimeNarrativeSourceFactory";
import { createFileStoryEvalSink, createStoryEvalApprovalObserver } from "./ai/storyEvalCapture";
import type { StoryEvalApprovalEvent, StoryEvalSink } from "../storyEvalCaptureTypes";
import { createTownPlanSource } from "./ai/townPlanSourceFactory";
import {
  RuntimeNarrativeTaskCoordinator,
  type NarrativeEnsureResult,
} from "./ai/runtimeNarrativeTaskCoordinator";
import {
  TownPlanTaskCoordinator,
  type TownEnsureResult,
} from "./ai/townPlanTaskCoordinator";
import { createServerSqliteClientFactory } from "./persistence/sqliteClient";
import { createSqliteGameRepository } from "./persistence/sqliteGameRepository";

type Phase1Fixture = { input: NewGameInput; seed: string };
const PHASE10_JOURNEY_BASELINE = wuxiaFixture as unknown as Phase1Fixture;

/** The journey baseline must never make an opening-world provider request. */
function createOfflineJourneyScenarioSource(): ScenarioCandidateSource {
  return {
    async generate() {
      return {
        ok: false,
        contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
        origin: "unavailable",
        category: "service_error",
        diagnostics: ["OFFLINE_PHASE10_JOURNEY_BASELINE"],
      };
    },
  };
}

export type OfflineJourneyGameResult = CreateGameResult | {
  readonly ok: false;
  readonly code: "DEVELOPMENT_TOOLS_DISABLED";
};

// ---------------------------------------------------------------------------
// production composition root（Task 3）：server-only 层唯一的真实依赖装配点。
// 只有这里把真实 SQLite repository（经 sqliteClient 的 env 配置助手解析路径）、
// UUID gameId provider、随机 seed 与真实时钟注入 use case——application 本体
// 始终不读 process.env / 文件路径 / libsql 类型。
// 公开入口只接受 NewGameInput：seed、gameId、数据库路径、生成来源均无从由
// 调用方（API/浏览器）指定。
// ---------------------------------------------------------------------------

/** API 层（Task 4）可直接使用的入口：不暴露 repository、libsql 或路径配置。 */
export type ServerGameEntryPoints = {
  /** 由 server composition root 决定，客户端与 API adapter 不读取环境变量。 */
  readonly developmentToolsEnabled: boolean;
  /** 创建当前本地存档：只承载浏览器允许提交的开局资料。 */
  createGame(input: NewGameInput): Promise<CreateGameResult>;
  /** 开发专用：使用 Phase 10 离线完整旅程的固定开局基线，零 AI 调用。 */
  createOfflineJourneyGame(): Promise<OfflineJourneyGameResult>;
  /** 读取当前本地存档的 read model。 */
  getCurrentGame(): Promise<CurrentGameResult>;
  /** 执行玩家行动：纯规则裁决 + 原子续存档。 */
  performAction(command: PerformActionCommand): Promise<PerformActionResult>;
  /** NPC 自由输入：纯规则分类→闲聊回应或排队叙事场景；自身零 AI 调用。 */
  handleNpcDialogue(command: HandleNpcDialogueCommand): Promise<HandleNpcDialogueResult>;
  /** 快速启动或恢复当前存档的后台叙事生成；绝不等待 provider。 */
  ensureNarrativeGeneration(): Promise<NarrativeEnsureResult>;
  /** 快速启动或恢复当前存档的后台小镇规划生成；绝不等待 provider。 */
  ensureTownGeneration(): Promise<TownEnsureResult>;
  /** 仅 development composition 可调用；生产环境一律返回 disabled。 */
  clearDevelopmentCurrentGame(): Promise<"cleared" | "none" | "disabled" | "unavailable">;
  /** 释放底层 SQLite 客户端：测试清理临时文件 / 进程收尾用；重复调用安全。 */
  close(): Promise<void>;
};

/** 仅供 server 侧 smoke/结构化日志观察生成阶段，绝不由浏览器或 API 提供。 */
export type ServerGameEntryPointOptions = {
  readonly generationObserver?: (event: ScenarioGenerationEvent) => void;
};

// ---------------------------------------------------------------------------
// 评估采集装配（spec §6.2）：仅当 STORY_EVAL_CAPTURE=1 时创建 sink 并注入
// captureSink/approvalObserver；未设置时全 undefined（零开销、零行为变化）。
// run-id 沿用 phase10 惯例：<ISO 时间戳>-<pid>（门禁脚本经 STORY_EVAL_ARTIFACT_DIR 覆盖）。
// ---------------------------------------------------------------------------

export function resolveStoryEvalAssembly(env: Record<string, string | undefined>): Readonly<{
  captureSink: StoryEvalSink | undefined;
  approvalObserver: ((event: StoryEvalApprovalEvent) => void) | undefined;
}> {
  if (env.STORY_EVAL_CAPTURE !== "1") {
    return { captureSink: undefined, approvalObserver: undefined };
  }
  const artifactDir = env.STORY_EVAL_ARTIFACT_DIR ??
    resolve("artifacts", "story-eval", `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  const sink = createFileStoryEvalSink(artifactDir);
  return { captureSink: sink, approvalObserver: createStoryEvalApprovalObserver(sink) };
}

/**
 * 装配一套真实入口：env 记录仅经 sqliteClient 的工厂解析 GAME_DB_PATH，
 * 测试注入指向 tmp/ 的记录，生产默认 process.env（本层是唯一允许读取处）。
 */
export function createServerGameEntryPoints(
  env: Record<string, string | undefined> = process.env,
  options: ServerGameEntryPointOptions = {}
): ServerGameEntryPoints {
  const storyEval = resolveStoryEvalAssembly(env);
  const logger = createServerConsoleLogger();
  const repository = createSqliteGameRepository({
    clientFactory: createServerSqliteClientFactory(env),
    logError: (operation) => logger.error("sqlite_repository_failure", { operation })
  });
  const runtimeNarrativeSources = createRuntimeNarrativeSources(env, { logger, captureSink: storyEval.captureSink });
  const dependencies: CreateGameDependencies = {
    repository,
    // 生产 provider：UUID 存档 ID、随机 seed、真实时钟（ISO 8601）。
    newGameId: (): GameId => asGameId(randomUUID()),
    newSeed: () => randomUUID(),
    now: () => new Date().toISOString(),
    // Phase 4B：按 AI 运行时配置装配 source——配置有效走 live，否则 unavailable
    // （玩家稳定走 fallback）。fixture source 绝不按 env 切入生产。
    // traceId 只进 source 请求与脱敏审计；observer 仅接收脱敏阶段事件。
    scenarioCandidateSource: createScenarioCandidateSource(env, { logger, captureSink: storyEval.captureSink }),
    newTraceId: () => randomUUID(),
    generationObserver: options.generationObserver,
    runtimeNarrativeSources,
  };
  const performDeps: PerformActionDependencies = {
    repository,
    now: () => new Date().toISOString(),
    newTraceId: () => randomUUID(),
    runtimeNarrativeSources
  };
  // 与 performDeps 共享同一 repository/时钟/sources 引用：对话触发的 pending
  // 与行动触发的 pending 走完全相同的持久化与恢复链路。
  const npcDialogueDeps: HandleNpcDialogueDependencies = {
    repository,
    now: () => new Date().toISOString(),
    runtimeNarrativeSources
  };
  const offlineJourneyDependencies: CreateGameDependencies = {
    ...dependencies,
    scenarioCandidateSource: createOfflineJourneyScenarioSource(),
    runtimeNarrativeMode: "offline",
  };
  const narrativeCoordinator = new RuntimeNarrativeTaskCoordinator({
    repository,
    newTraceId: () => randomUUID(),
    now: () => new Date().toISOString(),
    runtimeNarrativeSources,
    logger,
    approvalObserver: storyEval.approvalObserver,
  }, logger);
  const townPlanCoordinator = new TownPlanTaskCoordinator({
    repository,
    newTraceId: () => randomUUID(),
    now: () => new Date().toISOString(),
    townPlanSource: createTownPlanSource(env, { logger }),
  }, logger);
  return {
    developmentToolsEnabled: env.NODE_ENV === "development",
    // 刻意不透传 command.seed：浏览器/API 无法指定 seed 或 gameId。
    createGame: (input) => createGame({ input }, dependencies),
    createOfflineJourneyGame: () => {
      if (env.NODE_ENV !== "development") {
        return Promise.resolve({ ok: false, code: "DEVELOPMENT_TOOLS_DISABLED" });
      }
      return createGame({
        input: PHASE10_JOURNEY_BASELINE.input,
        seed: PHASE10_JOURNEY_BASELINE.seed,
      }, offlineJourneyDependencies);
    },
    getCurrentGame: () => getCurrentGame({ repository }),
    performAction: (command) => performAction(command, performDeps),
    handleNpcDialogue: (command) => handleNpcDialogue(command, npcDialogueDeps),
    ensureNarrativeGeneration: () => narrativeCoordinator.ensure(),
    ensureTownGeneration: () => townPlanCoordinator.ensure(),
    clearDevelopmentCurrentGame: async () => {
      if (env.NODE_ENV !== "development") return "disabled";
      const result = await repository.clearCurrentGame();
      if (!result.ok) return "unavailable";
      return result.status;
    },
    close: () => repository.close()
  };
}

// 进程内单例：API route（Task 4）共用同一 repository/客户端，惰性创建。
let productionEntryPoints: ServerGameEntryPoints | null = null;

/** 生产入口单例：首次调用时按 process.env 装配，此后复用同一连接。 */
export function getServerGameEntryPoints(): ServerGameEntryPoints {
  if (productionEntryPoints === null) {
    productionEntryPoints = createServerGameEntryPoints();
  }
  return productionEntryPoints;
}
