import type { GenerationMetadata } from "./scenarioBlueprint";

// 领域事件：纯数据，时间戳等外部信息由调用方传入（domain 不读取时钟）。
// Phase 1 只需要初始化事件；后续阶段在 GameEvent union 中追加新成员。

/** 初始事件账本条目：记录本局的生成元数据（Task 5 初始化时写入）。 */
export type GameInitializedEvent = {
  readonly type: "game_initialized";
  readonly generation: GenerationMetadata;
};

export type GameEvent = GameInitializedEvent;
