import type { EnemyId, FactId, ItemId, LocationId, NpcId, QuestId } from "./scenarioBlueprint";
import type { GameState } from "./gameState";

// Phase 11 剧情连续性与结构化记忆（内容推进引擎）。
// 见 docs/superpowers/specs/2026-07-31-phase-11-story-continuity-structured-memory.md §4。
//
// domain 纯类型与纯函数：不读 IO、Date、process.env 或随机数。
// StoryMemoryState 由规则事件账本归约而来；AI 文案、原始响应、prompt、token、
// actionKey、provider config、密钥绝不进入此结构。旧存档缺少 storyMemory 字段时
// 安全回退为同构空记忆，不提高 schemaVersion/stateVersion/GAME_RECORD_VERSION。

/** 结构化剧情记忆版本。旧 v1 存档与新增字段同版本，零迁移读取。 */
export const STORY_MEMORY_VERSION = 1 as const;

/** recent 里程碑的有界保留上限（最后 N 条）。 */
export const STORY_MEMORY_RECENT_LIMIT = 12 as const;

/** 场景节奏标签：由内容推进器按主线阶段约束，director 提案须属于当前 allowed 集合。 */
export type StoryPacing = "setup" | "develop" | "turn" | "climax" | "resolution";

/**
 * 单条结构化里程碑。只携带结构索引（ID 与回合），绝不携带叙事文本、对白、
 * choiceToken、actionKey 或 provider 输出。turn 为事件在 ledger 中的零基下标。
 */
export type StoryMemoryEntry =
  | { readonly kind: "location"; readonly locationId: LocationId; readonly turn: number }
  | { readonly kind: "npc"; readonly npcId: NpcId; readonly locationId: LocationId; readonly turn: number }
  | { readonly kind: "fact"; readonly factId: FactId; readonly turn: number }
  | {
      readonly kind: "quest";
      readonly questId: QuestId;
      readonly status: "unlocked" | "completed" | "failed";
      readonly turn: number;
    }
  | { readonly kind: "item"; readonly itemId: ItemId; readonly locationId: LocationId; readonly turn: number }
  | {
      readonly kind: "battle";
      readonly enemyId: EnemyId;
      readonly outcome: "victory" | "defeat" | "withdraw";
      readonly turn: number;
    }
  | {
      readonly kind: "scene";
      readonly sceneId: string;
      readonly locationId: LocationId;
      readonly focusNpcId: NpcId | null;
      readonly pacing: StoryPacing;
      readonly turn: number;
    };

/** 单个 NPC 的最近结构化接触：仅记录最后接触回合与地点，不含对白或关系数值。 */
export type NpcContinuityMemory = {
  readonly npcId: NpcId;
  readonly lastContactTurn: number;
  readonly lastLocationId: LocationId;
  // Phase 13：可选，旧存档兼容。由 reconcileStoryMemory 从 npc_met.interactionKind 推导生成。
  readonly lastInteractionSummary?: string;
};

/** 版本化、有界的结构化剧情记忆。reducedThroughEventCount 为已归约到的事件数（cursor）。 */
export type StoryMemoryState = {
  readonly version: typeof STORY_MEMORY_VERSION;
  readonly reducedThroughEventCount: number;
  readonly recent: readonly StoryMemoryEntry[];
  readonly npcContacts: readonly NpcContinuityMemory[];
};

/** 新局空记忆：v1、cursor=0、recent 与 npcContacts 均空。 */
export function createEmptyStoryMemory(): StoryMemoryState {
  return {
    version: STORY_MEMORY_VERSION,
    reducedThroughEventCount: 0,
    recent: [],
    npcContacts: []
  };
}

/**
 * 读取 state.storyMemory，缺省（旧存档未写入该字段）时返回同构空记忆。
 * 不抛错、不阻断流程；下一次正常保存写入 v1 memory。
 */
export function storyMemoryOf(state: Pick<GameState, "storyMemory">): StoryMemoryState {
  return state.storyMemory ?? createEmptyStoryMemory();
}
