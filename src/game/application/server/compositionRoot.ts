import { randomUUID } from "node:crypto";
import type { NewGameInput } from "@/game/domain";
import {
  createGame,
  type CreateGameDependencies,
  type CreateGameResult
} from "../createGame";
import { getCurrentGame, type CurrentGameResult } from "../getCurrentGame";
import {
  performAction,
  type PerformActionCommand,
  type PerformActionDependencies,
  type PerformActionResult
} from "../performAction";
import { asGameId, type GameId } from "./persistence/gameRepository";
import { createScenarioCandidateSource } from "./ai/scenarioCandidateSourceFactory";
import { createServerSqliteClientFactory } from "./persistence/sqliteClient";
import { createSqliteGameRepository } from "./persistence/sqliteGameRepository";

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
  /** 读取当前本地存档的 read model。 */
  getCurrentGame(): Promise<CurrentGameResult>;
  /** 执行玩家行动：纯规则裁决 + 原子续存档。 */
  performAction(command: PerformActionCommand): Promise<PerformActionResult>;
  /** 仅 development composition 可调用；生产环境一律返回 disabled。 */
  clearDevelopmentCurrentGame(): Promise<"cleared" | "none" | "disabled" | "unavailable">;
  /** 释放底层 SQLite 客户端：测试清理临时文件 / 进程收尾用；重复调用安全。 */
  close(): Promise<void>;
};

/**
 * 装配一套真实入口：env 记录仅经 sqliteClient 的工厂解析 GAME_DB_PATH，
 * 测试注入指向 tmp/ 的记录，生产默认 process.env（本层是唯一允许读取处）。
 */
export function createServerGameEntryPoints(
  env: Record<string, string | undefined> = process.env
): ServerGameEntryPoints {
  const repository = createSqliteGameRepository({
    clientFactory: createServerSqliteClientFactory(env)
  });
  const dependencies: CreateGameDependencies = {
    repository,
    // 生产 provider：UUID 存档 ID、随机 seed、真实时钟（ISO 8601）。
    newGameId: (): GameId => asGameId(randomUUID()),
    newSeed: () => randomUUID(),
    now: () => new Date().toISOString(),
    // Phase 4B：按 AI 运行时配置装配 source——配置有效走 live，否则 unavailable
    // （玩家稳定走 fallback）。fixture source 绝不按 env 切入生产。
    // traceId 只进 source 请求与脱敏审计，不传 observer。
    scenarioCandidateSource: createScenarioCandidateSource(env),
    newTraceId: () => randomUUID()
  };
  const performDeps: PerformActionDependencies = {
    repository,
    now: () => new Date().toISOString()
  };
  return {
    developmentToolsEnabled: env.NODE_ENV === "development",
    // 刻意不透传 command.seed：浏览器/API 无法指定 seed 或 gameId。
    createGame: (input) => createGame({ input }, dependencies),
    getCurrentGame: () => getCurrentGame({ repository }),
    performAction: (command) => performAction(command, performDeps),
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
