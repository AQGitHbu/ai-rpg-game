import type { GameState, ScenarioBlueprint } from "@/game/domain";

// ---------------------------------------------------------------------------
// 持久化端口（Task 1）：application 与 SQLite adapter（后续任务）之间的唯一契约。
// 纯 TypeScript 接口 + 结构化结果：
//   - 零运行时依赖：不导入 @libsql/client、server-only、路径或环境配置；
//   - 失败一律以稳定代码返回，绝不向上抛 SQL/驱动异常文本；
//   - adapter 读取时必须自行完成 JSON 解析、版本与 generationId 一致性校验，
//     不合法数据以 corrupt 返回，不得伪装成可玩存档，也不得自动重置。
// ---------------------------------------------------------------------------

declare const gameIdBrand: unique symbol;

/** 本局存档 ID：面向 API/read model 的稳定标识，与蓝图的 generationId 各司其职。 */
export type GameId = string & { readonly [gameIdBrand]: true };

/** 铸造 GameId：由 server 端注入的 ID provider（如 UUID）调用；不做格式校验。 */
export function asGameId(raw: string): GameId {
  return raw as GameId;
}

/** 完整存档记录：编译蓝图 + 当前状态 + 单调递增 revision + 创建时间。 */
export type GameRecord = {
  readonly gameId: GameId;
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  /** 单调递增 revision：初始游戏为 0，每次成功行动 +1。 */
  readonly revision: number;
  readonly createdAt: string;
};

/** 首次创建的写入载荷：不含 revision（adapter 内部固定写入 0）。 */
export type CreateInitialGameInput = {
  readonly gameId: GameId;
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly createdAt: string;
};

export type CreateInitialGameResult =
  | { readonly ok: true }
  // 已存在当前存档：不覆盖、不删除，由 use case 原样转成业务错误。
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" }
  // 基础设施失败（连接/事务/IO）：稳定代码，细节只进服务端日志。
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

/** 损坏原因：稳定可显示参数，供 UI 提示；不携带原始记录内容。 */
export type CorruptGameReason =
  | "UNPARSEABLE_RECORD"
  | "VERSION_MISMATCH"
  | "GENERATION_MISMATCH";

export type GetCurrentGameRecordResult =
  | { readonly ok: true; readonly status: "none" }
  | { readonly ok: true; readonly status: "active"; readonly record: GameRecord }
  | { readonly ok: true; readonly status: "corrupt"; readonly reason: CorruptGameReason }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

/** 原子行动写入载荷：resolver 已产出的下一状态 + 预期 revision。 */
export type ApplyResolvedActionInput = {
  readonly gameId: GameId;
  /** 调用方读取时的 revision：不匹配则 STALE_GAME_REVISION，不重试不覆盖。 */
  readonly expectedRevision: number;
  readonly nextState: GameState;
};

export type ApplyResolvedActionResult =
  | { readonly ok: true; readonly record: GameRecord }
  | { readonly ok: false; readonly code: "STALE_GAME_REVISION" }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

/** 开发环境重开局：只清除当前槽位及其指向的一局存档。 */
export type ClearCurrentGameResult =
  | { readonly ok: true; readonly status: "cleared" | "none" }
  | { readonly ok: false; readonly code: "INFRASTRUCTURE_FAILURE" };

export interface GameRepository {
  /** 原子创建：蓝图、状态与当前存档指针必须在同一事务内写入，失败整体回滚。 */
  createInitialGame(input: CreateInitialGameInput): Promise<CreateInitialGameResult>;
  /** 读取当前存档：区分无存档 / 可用记录 / 损坏记录 / 基础设施失败。 */
  getCurrentGame(): Promise<GetCurrentGameRecordResult>;
  /**
   * 原子 compare-and-swap 续存档：同一写事务内按 gameId + expectedRevision
   * 条件更新 state JSON 与 revision；不匹配返回 STALE_GAME_REVISION，不重试不覆盖。
   * 持久化层不认识 PlayerIntent 规则语义，只接收 resolver 已产出的 state 数据。
   */
  applyResolvedAction(input: ApplyResolvedActionInput): Promise<ApplyResolvedActionResult>;
}

/** 开发工具的可选持久化能力；不扩大正常 game use case 的测试 stub 责任。 */
export interface DevelopmentGameRepository {
  /** 原子清除当前槽位；调用方负责在 server 端限制为开发环境。 */
  clearCurrentGame(): Promise<ClearCurrentGameResult>;
}
