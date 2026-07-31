import type { GameTypeId } from "./newGame";
import type { BudgetPolicy } from "./budgetPolicy";

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
export type SceneId = BrandedId<"SceneId">;

// 供编译器（Task 5）和测试铸造 ID 的最小 helper；不做任何格式校验。
export function asGenerationId(raw: string): GenerationId { return raw as GenerationId; }
export function asLocationId(raw: string): LocationId { return raw as LocationId; }
export function asNpcId(raw: string): NpcId { return raw as NpcId; }
export function asQuestId(raw: string): QuestId { return raw as QuestId; }
export function asItemId(raw: string): ItemId { return raw as ItemId; }
export function asEnemyId(raw: string): EnemyId { return raw as EnemyId; }
export function asEndingId(raw: string): EndingId { return raw as EndingId; }
export function asFactId(raw: string): FactId { return raw as FactId; }
export function asSceneId(raw: string): SceneId { return raw as SceneId; }

// ---------------------------------------------------------------------------
// 候选 / 已编译共用的结构模板
// 同一套字段以 IdSet 参数实例化两次：候选用普通字符串，编译后用品牌化 ID。
// ---------------------------------------------------------------------------

type IdSet = {
  generation: string;
  location: string;
  npc: string;
  quest: string;
  item: string;
  enemy: string;
  ending: string;
  fact: string;
  scene: string;
};

type CandidateIds = IdSet;

type CompiledIds = {
  generation: GenerationId;
  location: LocationId;
  npc: NpcId;
  quest: QuestId;
  item: ItemId;
  enemy: EnemyId;
  ending: EndingId;
  fact: FactId;
  scene: SceneId;
};

/** 事实来源标记：区分玩家输入宣称与生成器补全，供校验与展示追溯。 */
export type FactSource = "player_input" | "generated";

type WorldFactOf<I extends IdSet> = {
  readonly id: I["fact"];
  readonly text: string;
  readonly source: FactSource;
};

type WorldDefinitionOf<I extends IdSet> = {
  readonly summary: string;
  readonly tone: string;
  readonly themes: readonly string[];
  readonly facts: readonly WorldFactOf<I>[];
  readonly tags: readonly string[];
};

export type LocationKind = "main" | "hidden";

/** Town 层：地点层级。scene = 两层（大地图→场景）；town = 三层（大地图→小镇→场景）。 */
export type LocationScale = "scene" | "town";

type LocationDefinitionOf<I extends IdSet> = {
  readonly id: I["location"];
  readonly name: string;
  readonly description: string;
  readonly kind: LocationKind;
  readonly connectedLocationIds: readonly I["location"][];
  readonly npcIds: readonly I["npc"][];
  /** Phase 5: 该地点可取得的预定义物品 ID（单个 item 至多出现在一个地点，不得与 startingItemIds 重复）。 */
  readonly availableItemIds: readonly I["item"][];
  readonly tags: readonly string[];
  /** Town 层：可选层级标记；缺省视为 "scene"（旧蓝图/旧存档零迁移，读取经 locationScaleOf）。 */
  readonly scale?: LocationScale;
};

/** 地点层级读取 helper：缺省回 "scene"，调用方不得直接读可选字段。 */
export function locationScaleOf(location: { readonly scale?: LocationScale }): LocationScale {
  return location.scale ?? "scene";
}

type NpcDefinitionOf<I extends IdSet> = {
  readonly id: I["npc"];
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly locationId: I["location"];
  readonly isCompanion: boolean;
  readonly knownFactIds: readonly I["fact"][];
  readonly tags: readonly string[];
};

// Phase 1 唯一允许的可验证 objective 类型（封闭 union，Task 4 校验依赖它）。
type QuestObjectiveOf<I extends IdSet> =
  | { readonly kind: "visit_location"; readonly locationId: I["location"] }
  | { readonly kind: "talk_to_npc"; readonly npcId: I["npc"] }
  | { readonly kind: "obtain_item"; readonly itemId: I["item"] }
  | { readonly kind: "discover_fact"; readonly factId: I["fact"] }
  | { readonly kind: "defeat_enemy"; readonly enemyId: I["enemy"] };

// 任务节点的关闭方式：解锁后续任务、抵达结局或显式关闭（无后续）。
type QuestOutcomeOf<I extends IdSet> =
  | { readonly kind: "unlock_quests"; readonly questIds: readonly I["quest"][] }
  | { readonly kind: "reach_ending"; readonly endingId: I["ending"] }
  | { readonly kind: "closed" };

// 正整数，上限由 budgetPolicy.mainActs 决定，结构校验在 questGraph
export type MainQuestStage = number;

type QuestCommonOf<I extends IdSet> = {
  readonly id: I["quest"];
  readonly name: string;
  readonly description: string;
  readonly objectives: readonly QuestObjectiveOf<I>[];
  readonly onSuccess: QuestOutcomeOf<I>;
  readonly onFailure: QuestOutcomeOf<I>;
  readonly tags: readonly string[];
};

type QuestDefinitionOf<I extends IdSet> =
  | (QuestCommonOf<I> & { readonly kind: "main"; readonly stage: MainQuestStage })
  | (QuestCommonOf<I> & { readonly kind: "side" });

export type EnemyTier = "normal" | "boss";

/** Phase 1 的简单数值块，玩家与敌人共用。 */
export type StatBlock = {
  readonly hp: number;
  readonly attack: number;
  readonly defense: number;
};

type EnemyTemplateOf<I extends IdSet> = {
  readonly id: I["enemy"];
  readonly name: string;
  readonly tier: EnemyTier;
  readonly stats: StatBlock;
  /** Phase 6：敌人预置地点；validator 要求地点存在。 */
  readonly locationId: I["location"];
  readonly tags: readonly string[];
};

/** 背包界面页签的封闭分类：装备 / 道具 / 材料 / 任务。 */
export type ItemCategory = "equipment" | "consumable" | "material" | "quest";

/** 展示用稀有度（不参与规则结算）。 */
export type ItemRarity = "common" | "fine" | "rare" | "epic";

/** 展示用属性行（如「攻击力 24」「暴击率 +3%」），只读文本、不进战斗结算。 */
export type ItemStatLine = {
  readonly label: string;
  readonly value: string;
};

type ItemDefinitionOf<I extends IdSet> = {
  readonly id: I["item"];
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly tags: readonly string[];
  // 以下均为可选展示元数据：缺省时由 resolveItemPresentation 按 kind 推导，
  // 旧存档蓝图与不含新字段的 AI 候选零迁移可用。
  readonly category?: ItemCategory;
  readonly rarity?: ItemRarity;
  readonly level?: number;
  readonly statLines?: readonly ItemStatLine[];
};

type EndingRequirementOf<I extends IdSet> =
  | { readonly kind: "quest_completed"; readonly questId: I["quest"] }
  | { readonly kind: "quest_failed"; readonly questId: I["quest"] }
  | { readonly kind: "fact_discovered"; readonly factId: I["fact"] };

type EndingDefinitionOf<I extends IdSet> = {
  readonly id: I["ending"];
  readonly name: string;
  readonly description: string;
  readonly requirements: readonly EndingRequirementOf<I>[];
};

type SceneDefinitionOf<I extends IdSet> = {
  readonly id: I["scene"];
  readonly locationId: I["location"];
  readonly narration: string;
  readonly presentNpcIds: readonly I["npc"][];
  readonly suggestedActions: readonly string[];
  /** Phase 3: 当前场景中可调查的世界事实 ID（opening scene 至少一个）。 */
  readonly investigableFactIds: readonly I["fact"][];
};

type GeneratedPlayerDefinitionOf<I extends IdSet> = {
  readonly name: string;
  readonly identity: string;
  readonly backgroundSummary: string;
  readonly startingLocationId: I["location"];
  readonly startingItemIds: readonly I["item"][];
  readonly baseStats: StatBlock;
};

// ---------------------------------------------------------------------------
// 蓝图：候选 vs 已编译
// ---------------------------------------------------------------------------

type ScenarioBlueprintShapeOf<I extends IdSet> = {
  readonly schemaVersion: 1;
  readonly generationId: I["generation"];
  readonly seed: string;
  readonly templateVersion: string;
  readonly gameType: GameTypeId;
  readonly inputDigest: string;
  readonly world: WorldDefinitionOf<I>;
  readonly player: GeneratedPlayerDefinitionOf<I>;
  readonly locations: readonly LocationDefinitionOf<I>[];
  readonly npcs: readonly NpcDefinitionOf<I>[];
  readonly quests: readonly QuestDefinitionOf<I>[];
  readonly enemies: readonly EnemyTemplateOf<I>[];
  readonly items: readonly ItemDefinitionOf<I>[];
  readonly endings: readonly EndingDefinitionOf<I>[];
  readonly openingScene: SceneDefinitionOf<I>;
  // 旧存档缺省，读取一律经 budgetPolicyOf
  readonly budgetPolicy?: BudgetPolicy;
};

/** 生成器（AI 或 fallback）产出的原始候选：ID 为普通字符串，未经校验。 */
export type ScenarioBlueprintCandidate = ScenarioBlueprintShapeOf<CandidateIds>;

declare const compiledScenarioBlueprintBrand: unique symbol;

/** 只有 validate/compile（Task 5）成功后才能产生；候选不可直接赋值。 */
export type ScenarioBlueprint = ScenarioBlueprintShapeOf<CompiledIds> & {
  readonly [compiledScenarioBlueprintBrand]: true;
};

// 已编译子定义的公开别名（品牌化 ID）。
export type WorldDefinition = WorldDefinitionOf<CompiledIds>;
export type WorldFact = WorldFactOf<CompiledIds>;
export type LocationDefinition = LocationDefinitionOf<CompiledIds>;
export type NpcDefinition = NpcDefinitionOf<CompiledIds>;
export type QuestDefinition = QuestDefinitionOf<CompiledIds>;
export type QuestObjective = QuestObjectiveOf<CompiledIds>;
export type QuestOutcome = QuestOutcomeOf<CompiledIds>;
export type EnemyTemplate = EnemyTemplateOf<CompiledIds>;
export type ItemDefinition = ItemDefinitionOf<CompiledIds>;
export type EndingDefinition = EndingDefinitionOf<CompiledIds>;
export type EndingRequirement = EndingRequirementOf<CompiledIds>;
export type SceneDefinition = SceneDefinitionOf<CompiledIds>;
export type GeneratedPlayerDefinition = GeneratedPlayerDefinitionOf<CompiledIds>;

// 候选子定义的公开别名（普通字符串 ID），供 Task 4–6 的分析/校验/生成使用。
export type WorldDefinitionCandidate = WorldDefinitionOf<CandidateIds>;
export type WorldFactCandidate = WorldFactOf<CandidateIds>;
export type LocationDefinitionCandidate = LocationDefinitionOf<CandidateIds>;
export type NpcDefinitionCandidate = NpcDefinitionOf<CandidateIds>;
export type QuestDefinitionCandidate = QuestDefinitionOf<CandidateIds>;
export type QuestObjectiveCandidate = QuestObjectiveOf<CandidateIds>;
export type QuestOutcomeCandidate = QuestOutcomeOf<CandidateIds>;
export type EnemyTemplateCandidate = EnemyTemplateOf<CandidateIds>;
export type ItemDefinitionCandidate = ItemDefinitionOf<CandidateIds>;
export type EndingDefinitionCandidate = EndingDefinitionOf<CandidateIds>;
export type EndingRequirementCandidate = EndingRequirementOf<CandidateIds>;
export type SceneDefinitionCandidate = SceneDefinitionOf<CandidateIds>;
export type GeneratedPlayerDefinitionCandidate = GeneratedPlayerDefinitionOf<CandidateIds>;

// ---------------------------------------------------------------------------
// 生成元数据：初始事件账本与 GameState 复用。
// ---------------------------------------------------------------------------

export type GenerationMetadata = {
  readonly generationId: GenerationId;
  readonly seed: string;
  readonly templateVersion: string;
  readonly inputDigest: string;
  readonly gameType: GameTypeId;
};
