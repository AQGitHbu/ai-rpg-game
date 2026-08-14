import type {
  LocationId, NpcId, ItemId, FactId, QuestId, EnemyId, EndingId,
  StatBlock, LocationScale, LocationKind, ItemCategory, ItemRarity, ItemStatLine,
  EnemyTier, FactSource, GenerationMetadata,
} from "./worldEntity";
import type { GameEvent } from "./events";
import type { RelationshipValue } from "./relationship";
import type { NarrativeEmotion } from "./narrative";
import type { DialogueAct, StructuredDialogueTopic } from "./action";
import type { TownRuntimeState } from "./townState";
import type { ActiveBattleCombatState } from "./combat";

// ── Entry 类型：定义 + 运行时 ──

export type PlayerState = {
  readonly name: string;
  readonly identity: string;
  readonly stats: StatBlock;
};

export type LocationEntry = {
  readonly id: LocationId;
  readonly name: string;
  readonly description: string;
  readonly kind: LocationKind;
  readonly connectedLocationIds: readonly LocationId[];
  readonly npcIds: readonly NpcId[];
  readonly availableItemIds: readonly ItemId[];
  readonly tags: readonly string[];
  readonly scale?: LocationScale;
  /** 仅 scale="town" 的地点携带：稳定几何 seed + 剧情建筑 slot 绑定（Task 7）。 */
  readonly town?: TownRuntimeState;
};

export type NpcMemory = {
  readonly npcId: NpcId;
  readonly knownFactIds: readonly FactId[];
  readonly hiddenFactIds: readonly FactId[];
  readonly interactionHistory: readonly NpcInteraction[];
  readonly relationship: RelationshipValue;
  readonly emotion: NarrativeEmotion;
  readonly goals: readonly string[];
};

/** 一次与 NPC 的结构化交互记录（Spec §14.2）：规则生成，绝不包含玩家原文。 */
export type NpcInteraction = {
  readonly turnNumber: number;
  readonly actionId: string;
  readonly locationId: LocationId;
  readonly dialogueAct: DialogueAct | "freeform";
  /** Task 5：本轮的结构化主题引用（规则裁决同源）；无主题时为 general 或省略。 */
  readonly topic?: StructuredDialogueTopic;
  readonly topicSummary: string;
  readonly outcome: "positive" | "negative" | "neutral" | "mixed";
  readonly relationshipDelta: number;
  readonly learnedFactIds: readonly FactId[];
  readonly summary: string;
};

export type NpcEntry = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly locationId: LocationId;
  readonly isCompanion: boolean;
  readonly tags: readonly string[];
  readonly met: boolean;
  /** knownFactIds 只存于 memory 内（spec §8.5），不在 NpcEntry 顶层重复存储，避免双源歧义 */
  readonly memory: NpcMemory;
};

export type ItemEntry = {
  readonly id: ItemId;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly tags: readonly string[];
  readonly category?: ItemCategory;
  readonly rarity?: ItemRarity;
  readonly level?: number;
  readonly statLines?: readonly ItemStatLine[];
};

export type WorldFactEntry = {
  readonly factId: FactId;
  readonly text: string;
  readonly source: FactSource;
  readonly discovered: boolean;
  readonly locationId?: LocationId;
};

export type QuestObjective =
  | { readonly kind: "visit_location"; readonly locationId: LocationId }
  | { readonly kind: "talk_to_npc"; readonly npcId: NpcId }
  | { readonly kind: "obtain_item"; readonly itemId: ItemId }
  | { readonly kind: "discover_fact"; readonly factId: FactId }
  | { readonly kind: "defeat_enemy"; readonly enemyId: EnemyId };

// 幕推进（Task 2）：开局任务不引用预生成后续任务；推进由世界演化（Task 3）消费。
export type QuestOutcome =
  | { readonly kind: "advance_story" }
  | { readonly kind: "resolve_story" }
  | { readonly kind: "closed" };

export type QuestEntry = {
  readonly id: QuestId;
  readonly name: string;
  readonly description: string;
  readonly objectives: readonly QuestObjective[];
  readonly onSuccess: QuestOutcome;
  readonly onFailure: QuestOutcome;
  readonly tags: readonly string[];
  readonly kind: "main" | "side";
  readonly stage?: number;
  readonly status: "locked" | "active" | "completed" | "failed" | "closed";
};

export type EnemyEntry = {
  readonly id: EnemyId;
  readonly name: string;
  readonly tier: EnemyTier;
  readonly stats: StatBlock;
  readonly locationId: LocationId;
  readonly tags: readonly string[];
};

export type EndingEntry = {
  readonly id: EndingId;
  readonly name: string;
  readonly description: string;
  readonly requirements: readonly (EndingRequirement)[];
};

export type EndingRequirement =
  | { readonly kind: "quest_completed"; readonly questId: QuestId }
  | { readonly kind: "quest_failed"; readonly questId: QuestId }
  | { readonly kind: "fact_discovered"; readonly factId: FactId }
  | { readonly kind: "npc_affinity_at_least"; readonly npcId: NpcId; readonly value: number }
  | { readonly kind: "npc_affinity_at_most"; readonly npcId: NpcId; readonly value: number };

export type FactionEntry = {
  readonly factionId: string;
  readonly name: string;
  readonly attitudeToPlayer: number;
};

export type BattleState =
  | { readonly status: "idle" }
  | ({ readonly status: "active"; readonly enemyId: EnemyId; readonly enemyIds?: readonly EnemyId[]; readonly playerHp: number; readonly enemyHp: number; readonly round: number; readonly battleKey?: string; readonly preBattleSnapshot?: BattleStartSnapshot }
    & Partial<ActiveBattleCombatState>)
  | { readonly status: "resolved"; readonly enemyId: EnemyId; readonly outcome: "victory" | "defeat" | "withdraw"; readonly battleKey?: string };

export type BattleStartSnapshot = {
  readonly playerStats: PlayerState["stats"];
  readonly defeatedEnemyIds: readonly EnemyId[];
  readonly eventLedger: readonly GameEvent[];
};

export type EndingState = { readonly endingId: EndingId; readonly outcome: "success" | "failure" } | null;

// ── World State ──

export type WorldState = {
  readonly version: 2;
  readonly generation: GenerationMetadata;
  readonly player: PlayerState;
  readonly locations: readonly LocationEntry[];
  readonly currentLocationId: LocationId;
  readonly unlockedLocationIds: readonly LocationId[];
  readonly visitedLocationIds: readonly LocationId[];
  readonly npcs: readonly NpcEntry[];
  readonly items: readonly ItemEntry[];
  readonly inventory: readonly ItemId[];
  readonly worldFacts: readonly WorldFactEntry[];
  readonly quests: readonly QuestEntry[];
  readonly enemies: readonly EnemyEntry[];
  readonly defeatedEnemyIds: readonly EnemyId[];
  readonly battle: BattleState;
  readonly endings: readonly EndingEntry[];
  readonly ending: EndingState;
  readonly factions: readonly FactionEntry[];
  readonly eventLedger: readonly GameEvent[];
};

// ── 纯函数 ──

export function findLocation(ws: WorldState, id: LocationId): LocationEntry | undefined {
  return ws.locations.find((l) => l.id === id);
}

export function findNpc(ws: WorldState, id: NpcId): NpcEntry | undefined {
  return ws.npcs.find((n) => n.id === id);
}

export function findItem(ws: WorldState, id: ItemId): ItemEntry | undefined {
  return ws.items.find((i) => i.id === id);
}

export function findQuest(ws: WorldState, id: QuestId): QuestEntry | undefined {
  return ws.quests.find((q) => q.id === id);
}

export function appendLocation(ws: WorldState, loc: LocationEntry): WorldState {
  return { ...ws, locations: [...ws.locations, loc] };
}

export function appendNpc(ws: WorldState, npc: NpcEntry): WorldState {
  return { ...ws, npcs: [...ws.npcs, npc] };
}

export function appendItem(ws: WorldState, item: ItemEntry): WorldState {
  return { ...ws, items: [...ws.items, item] };
}

export function appendEnemy(ws: WorldState, enemy: EnemyEntry): WorldState {
  return { ...ws, enemies: [...ws.enemies, enemy] };
}

export function createInitialWorldState(input: {
  generation: GenerationMetadata;
  player: PlayerState;
  startingLocation: LocationEntry;
  startingItemIds: readonly ItemId[];
}): WorldState {
  // 最小初始状态——实际开局实体由 createGame 通过 AI 生成后追加填充
  return {
    version: 2,
    generation: input.generation,
    player: input.player,
    locations: [input.startingLocation],
    currentLocationId: input.startingLocation.id,
    unlockedLocationIds: [input.startingLocation.id],
    visitedLocationIds: [input.startingLocation.id],
    npcs: [],
    items: [],
    inventory: [...input.startingItemIds],
    worldFacts: [],
    quests: [],
    enemies: [],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    endings: [],
    ending: null,
    factions: [],
    eventLedger: [{
      type: "game_initialized",
      generation: input.generation,
    }],
  };
}
