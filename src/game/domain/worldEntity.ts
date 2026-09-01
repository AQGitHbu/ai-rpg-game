import type { GameTypeId, GameSetup } from "./newGame";

// ---------------------------------------------------------------------------
// 品牌化稳定 ID
// 显示名称（name）永远不能作为引用；实体间引用只允许使用下列品牌化 ID。
// 品牌手法与 newGame.ts 的 ValidatedNewGameInput 一致：unique symbol 属性。
// ---------------------------------------------------------------------------

declare const scenarioIdBrand: unique symbol;
type BrandedId<Name extends string> = string & { readonly [scenarioIdBrand]: Name };

export type GenerationId = BrandedId<"GenerationId">;
export type LocationId = BrandedId<"LocationId">;
export type NpcId = BrandedId<"NpcId">;
export type QuestId = BrandedId<"QuestId">;
export type ItemId = BrandedId<"ItemId">;
export type EnemyId = BrandedId<"EnemyId">;
export type EndingId = BrandedId<"EndingId">;
export type FactId = BrandedId<"FactId">;
export type PlayerEntityId = BrandedId<"PlayerEntityId">;
export type FactionId = BrandedId<"FactionId">;

// 供编译器（Task 5）和测试铸造 ID 的最小 helper；不做任何格式校验。
export function asGenerationId(raw: string): GenerationId { return raw as GenerationId; }
export function asLocationId(raw: string): LocationId { return raw as LocationId; }
export function asNpcId(raw: string): NpcId { return raw as NpcId; }
export function asQuestId(raw: string): QuestId { return raw as QuestId; }
export function asItemId(raw: string): ItemId { return raw as ItemId; }
export function asEnemyId(raw: string): EnemyId { return raw as EnemyId; }
export function asEndingId(raw: string): EndingId { return raw as EndingId; }
export function asFactId(raw: string): FactId { return raw as FactId; }
export function asPlayerEntityId(raw: string): PlayerEntityId { return raw as PlayerEntityId; }
export function asFactionId(raw: string): FactionId { return raw as FactionId; }

/** 每局恰有一名玩家角色，其 Entity ID 固定，供规则与投影直接引用。 */
export const PLAYER_ENTITY_ID: PlayerEntityId = asPlayerEntityId("player_0");

// ---------------------------------------------------------------------------
// 领域枚举与展示元数据
// ---------------------------------------------------------------------------

/** 事实来源标记：区分玩家输入宣称与生成器补全，供校验与展示追溯。 */
export type FactSource = "player_input" | "generated";

export type LocationKind = "main" | "hidden";

/** Town 层：地点层级。scene = 两层（大地图→场景）；town = 三层（大地图→小镇→场景）。 */
export type LocationScale = "scene" | "town";

/** 地点层级读取 helper：缺省回 "scene"，调用方不得直接读可选字段。 */
export function locationScaleOf(location: { readonly scale?: LocationScale }): LocationScale {
  return location.scale ?? "scene";
}

export type EnemyTier = "normal" | "boss";

/** Phase 1 的简单数值块，玩家与敌人共用。 */
export type StatBlock = {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
  /** 正式战斗属性；旧存档可缺省，由 combatStatsFromLegacy 投影。 */
  readonly maxHp?: number;
  readonly maxEnergy?: number;
  readonly speed?: number;
};

/** 背包界面页签的封闭分类：装备 / 道具 / 材料 / 任务。 */
export type ItemCategory = "equipment" | "consumable" | "material" | "quest";

/**
 * 服务器审批内容使用的封闭归还标记；它不是 ItemCategory，也不参与展示分类推导。
 * 玩家 Action 与 AI 提议都没有写入该 tag 的入口，Entity projection 会原样保留它。
 */
export const RETURN_REQUIRED_ITEM_TAG = "rule:return-required" as const;

/** 展示用稀有度（不参与规则结算）。 */
export type ItemRarity = "common" | "fine" | "rare" | "epic";

/** 展示用属性行（如「攻击力 24」「暴击率 +3%」），只读文本、不进战斗结算。 */
export type ItemStatLine = {
  readonly label: string;
  readonly value: string;
};

// ---------------------------------------------------------------------------
// 生成元数据：初始事件账本与 GameState 复用。
// ---------------------------------------------------------------------------

export type GenerationMetadata = {
  readonly generationId: GenerationId;
  readonly seed: string;
  readonly templateVersion: string;
  readonly inputDigest: string;
  readonly gameType: GameTypeId;
  /** 玩家开局配置（可选）：旧存档无此字段，读取时必须容忍缺省。 */
  readonly setup?: GameSetup;
  /** 开局相似度重试次数；用于记录实际采用的确定性 fallback 分支。 */
  readonly openingAttempt?: number;
};
