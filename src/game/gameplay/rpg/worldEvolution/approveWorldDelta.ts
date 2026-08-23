import type {
  WorldState,
  LocationEntry,
  NpcEntry,
  ItemEntry,
  EnemyEntry,
  WorldFactEntry,
  QuestEntry,
  EndingEntry,
  QuestObjective,
  InvestigationApproach,
} from "@/game/domain/worldState";
import type { EndingRequirement } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import {
  budgetAllowsExpansion,
  withinHardLimit,
  consumeExpansion,
  type StoryBudget,
  type BudgetDimensionKey,
} from "@/game/domain/storyBudget";
import type { EvolutionNeed, WorldDeltaProposal, StoryEvolutionState } from "@/game/domain/worldDelta";
import {
  asLocationId, asNpcId, asItemId, asEnemyId, asFactId, asQuestId, asEndingId,
  type LocationId, type NpcId, type ItemId, type EnemyId, type FactId, type QuestId, type EndingId,
} from "@/game/domain/worldEntity";
import { ENEMY_COMBAT_STATS, toStatBlock } from "@/game/domain/combat";
import { deriveKeyEndingNpcId } from "./keyEndingNpc";

// ---------------------------------------------------------------------------
// Task 3：世界演化提议的审批。纯函数，无 IO。
// 职责：需求形状校验、品牌化 ID 铸造、引用解析、预算预占、主线/结局对规则约束。
// 审批产出 ApprovedWorldDeltaCore（完整实体条目 + 下一演化/预算账本），
// 由 materializeWorldDelta 装配预览状态并落账。
// ---------------------------------------------------------------------------

const MIN_ENTITY_NAME_LENGTH = 2;
const MAX_ENTITY_NAME_LENGTH = 40;
const MAX_ENTITY_TEXT_LENGTH = 200;
// 结局分歧是规则层信号，不接受 AI 直接提交的 requirements。关键 NPC 的
// 关系达到 10 进入 trust，低于 10 进入 doubt，保证两条方向互斥且可达。
const TRUST_ENDING_MIN_AFFINITY = 10;
const DOUBT_ENDING_MAX_AFFINITY = TRUST_ENDING_MIN_AFFINITY - 1;

// 调查方式安全边界：显式列表必须恰好 2-3 条；张力在 [-5, 20]。
const MIN_APPROACH_COUNT = 2;
const MAX_APPROACH_COUNT = 3;
const MIN_TENSION_DELTA = -5;
const MAX_TENSION_DELTA = 20;

/**
 * 单条调查方式规范化校验：字段形状/枚举/张力越界/完整正文泄漏/重复 id
 * 任一不通过；正常复用事实关键词是允许的。
 * 返回 null；通过则返回规范后的条目。供审批（过滤语义）与开局校验（严格
 * 语义）共用，两条路径的逐条判定必须一致。
 */
function normalizeApproachEntry(
  entry: InvestigationApproach,
  factText: string,
): InvestigationApproach | null {
  if (typeof entry !== "object" || entry === null) return null;
  const approachId = typeof entry.approachId === "string" ? entry.approachId.trim() : "";
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  const hint = entry.hint === undefined ? undefined : typeof entry.hint === "string" ? entry.hint.trim() : "";
  const qualityValid = entry.evidenceQuality === "clean" || entry.evidenceQuality === "noisy";
  const tensionValid = typeof entry.tensionDelta === "number"
    && Number.isFinite(entry.tensionDelta)
    && entry.tensionDelta >= MIN_TENSION_DELTA
    && entry.tensionDelta <= MAX_TENSION_DELTA;
  if (approachId === "" || label === "" || hint === "" || !qualityValid || !tensionValid) return null;
  const leakTexts = [label, ...(hint === undefined ? [] : [hint])];
  const hardLeak = leakTexts.some((text) => text.includes(factText.trim()));
  if (hardLeak) return null;
  return {
    approachId,
    label,
    ...(hint === undefined ? {} : { hint }),
    evidenceQuality: entry.evidenceQuality,
    tensionDelta: entry.tensionDelta,
  };
}

/**
 * 调查方式审批（世界演化层，防御性校验）：
 * - 缺省/空列表 = 自动揭示，不产生日志；
 * - 逐条校验：approachId/label/hint 非空、quality 枚举、张力在界内、id 唯一、
 *   只有硬泄漏（完整正文子串）拒绝该条目；正常复用事实关键词是允许的；
 * - 只保留校验通过者；显式非空列表过滤后数量不在 2-3 时降级为空列表，
 *   并记录 investigation_approach_invalid（规则层修复，绝不拒绝本轮）。
 */
export function validateInvestigationApproaches(
  approaches: readonly InvestigationApproach[] | undefined,
  factText: string,
): { readonly approaches: readonly InvestigationApproach[]; readonly logCategories: readonly string[] } {
  if (approaches === undefined || approaches.length === 0) {
    return { approaches: [], logCategories: [] };
  }
  const seenIds = new Set<string>();
  const validated: InvestigationApproach[] = [];
  for (const entry of approaches) {
    const normalized = normalizeApproachEntry(entry, factText);
    if (normalized === null) continue;
    if (seenIds.has(normalized.approachId)) continue;
    seenIds.add(normalized.approachId);
    validated.push(normalized);
  }
  if (validated.length < MIN_APPROACH_COUNT || validated.length > MAX_APPROACH_COUNT) {
    return { approaches: [], logCategories: ["investigation_approach_invalid"] };
  }
  return { approaches: validated, logCategories: [] };
}

/**
 * 严格校验（开局候选用，fail-fast）：显式非空列表必须整体合规——数量 2-3、
 * 每条都通过 normalizeApproachEntry（含完整正文泄漏、重复 id、越界张力）。
 * 任意一条非法即整体拒绝：开局有确定性 fallback，未获批数据绝不能进入
 * compile（compile 对 investigationApproaches 是逐字拷贝，不做任何过滤）。
 */
export function investigationApproachListIsValid(
  approaches: readonly InvestigationApproach[] | undefined,
  factText: string,
): boolean {
  if (approaches === undefined || approaches.length === 0) return true;
  if (approaches.length < MIN_APPROACH_COUNT || approaches.length > MAX_APPROACH_COUNT) return false;
  const seenIds = new Set<string>();
  for (const entry of approaches) {
    const normalized = normalizeApproachEntry(entry, factText);
    if (normalized === null) return false;
    if (seenIds.has(normalized.approachId)) return false;
    seenIds.add(normalized.approachId);
  }
  return true;
}

// 武侠世界允许江湖传闻、奇诡意象，但不允许把另一套题材的实体直接
// 铸造进世界。该门槛放在审批层，而不是只写进 prompt，防止 live AI 的
// 合法 JSON 绕过风格约束，造成“骑士灵魂/远古祭坛/纯净光芒”式漂移。
const WUXIA_FORBIDDEN_TERMS = /魔法|魔力|法术|施法|巫师|精灵|骑士|幽灵|鬼魂|灵魂|祭坛|纯净的光|圣光|魔兽|异界|传送|法阵|咒语|超自然|神谕|结界|元素/;

export type WorldDeltaRejection =
  | "empty_proposal"
  | "no_need"
  | "climax_locked"
  | "budget_exceeded"
  | "hard_limit_exceeded"
  | "genre_constraint"
  | "invalid_location_ref"
  | "town_capacity"
  | "duplicate_name"
  | "unreachable_objective"
  | "main_quest_conflict"
  | "ending_pair_invalid";

/**
 * unreachable_objective 的内部 reason：物化新世界地点时，目标 NPC 必须落在该
 * 新地点（locationRef=new_location）。若 NPC 落在旧地点而幕目标链要求“先到新
 * 地点再与该 NPC 交谈”，该链在空间上矛盾 → 玩家永远看不到目标 NPC。审批层在
 * ID 铸造/预算预占前硬拒绝，而不是把旧地点的 NPC 静默搬迁到新地点。
 */
export const REJECT_REASON_NPC_NOT_AT_NEW_LOCATION = "npc_not_at_new_location" as const;

export type ApprovedWorldDeltaCore = {
  readonly beatSummary: string;
  readonly mintedLocationIds: readonly LocationId[];
  readonly mintedNpcIds: readonly NpcId[];
  readonly mintedItemIds: readonly ItemId[];
  readonly mintedEnemyIds: readonly EnemyId[];
  readonly mintedFactIds: readonly FactId[];
  readonly mintedQuestIds: readonly QuestId[];
  readonly mintedEndingIds: readonly EndingId[];
  readonly newLocations: readonly LocationEntry[];
  readonly newNpcs: readonly NpcEntry[];
  readonly newItems: readonly ItemEntry[];
  readonly newEnemies: readonly EnemyEntry[];
  readonly newFacts: readonly WorldFactEntry[];
  readonly newQuests: readonly QuestEntry[];
  readonly newEndings: readonly EndingEntry[];
  /** 当前城镇内新剧情建筑的 NPC 绑定；不产生世界地图地点。 */
  readonly townBuildingBindings: readonly {
    readonly locationId: LocationId;
    readonly npcId: NpcId;
    readonly displayName: string;
  }[];
  /** item/enemy 的挂载地点（fact 为世界级事实，无地点）。 */
  readonly itemLocationId: LocationId | null;
  readonly enemyLocationId: LocationId | null;
  /** 规则层降级/修复产生的日志类别（如 investigation_approach_invalid），仅非空时携带。 */
  readonly logCategories?: readonly string[];
  readonly nextEvolution: StoryEvolutionState;
  readonly nextBudget: StoryBudget;
};

export type ApproveWorldDeltaResult =
  | { readonly ok: true; readonly approved: ApprovedWorldDeltaCore }
  | { readonly ok: false; readonly code: WorldDeltaRejection; readonly reason: string };

function reject(code: WorldDeltaRejection, reason: string): ApproveWorldDeltaResult {
  return { ok: false, code, reason };
}

/** 每类实体的预算维度：quest/ending 归 quests 维度；item/enemy/fact 归 events 维度。 */
function dimensionOf(kind: "location" | "npc" | "quest" | "ending" | "item" | "enemy" | "fact"): BudgetDimensionKey {
  switch (kind) {
    case "location": return "locations";
    case "npc": return "npcs";
    case "quest":
    case "ending": return "quests";
    case "item":
    case "enemy":
    case "fact": return "events";
  }
}

function validName(name: string): boolean {
  const t = name.trim();
  return t.length >= MIN_ENTITY_NAME_LENGTH && t.length <= MAX_ENTITY_NAME_LENGTH;
}

function validText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= MAX_ENTITY_TEXT_LENGTH;
}

function violatesGenre(ws: WorldState, texts: readonly string[]): boolean {
  if (ws.generation.gameType !== "wuxia") return false;
  return texts.some((text) => WUXIA_FORBIDDEN_TERMS.test(text));
}

type MintedIds = {
  readonly locationId: LocationId | null;
  readonly npcId: NpcId | null;
  readonly itemId: ItemId | null;
  readonly enemyId: EnemyId | null;
  readonly factId: FactId | null;
  readonly questId: QuestId | null;
  readonly endingIds: readonly EndingId[];
};

/** 回合修复路径：把行动引用 ID 原样铸造为缺失实体 ID，令重演算能够通过。 */
export type WorldDeltaIdOverride = {
  readonly kind: "location" | "npc" | "item" | "enemy" | "fact";
  readonly id: string;
};

function mintIds(
  ev: StoryEvolutionState,
  p: WorldDeltaProposal,
  override: WorldDeltaIdOverride | undefined,
): MintedIds {
  const dynLocationId = p.newLocation?.placement === "world"
    ? asLocationId(`loc_dyn_${ev.nextLocationOrdinal}`)
    : null;
  const dynNpcId = p.newNpc ? asNpcId(`npc_dyn_${ev.nextNpcOrdinal}`) : null;
  const dynItemId = p.newItem ? asItemId(`item_dyn_${ev.nextItemOrdinal}`) : null;
  const dynEnemyId = p.newEnemy ? asEnemyId(`enemy_dyn_${ev.nextEnemyOrdinal}`) : null;
  const dynFactId = p.newFact ? asFactId(`fact_dyn_${ev.nextFactOrdinal}`) : null;
  return {
    locationId: override?.kind === "location" && dynLocationId !== null
      ? asLocationId(override.id)
      : dynLocationId,
    npcId: override?.kind === "npc" && dynNpcId !== null
      ? asNpcId(override.id)
      : dynNpcId,
    itemId: override?.kind === "item" && dynItemId !== null
      ? asItemId(override.id)
      : dynItemId,
    enemyId: override?.kind === "enemy" && dynEnemyId !== null
      ? asEnemyId(override.id)
      : dynEnemyId,
    factId: override?.kind === "fact" && dynFactId !== null
      ? asFactId(override.id)
      : dynFactId,
    questId: p.nextMainQuest ? asQuestId(`quest_dyn_${ev.nextQuestOrdinal}`) : null,
    endingIds: p.endingPair
      ? [
          asEndingId(`ending_dyn_${ev.nextEndingOrdinal}`),
          asEndingId(`ending_dyn_${ev.nextEndingOrdinal + 1}`),
        ]
      : [],
  };
}

function resolveNpcLocationId(ws: WorldState, p: WorldDeltaProposal, mintedLocationId: LocationId | null): LocationId | null {
  if (p.newNpc!.locationRef.kind === "existing") {
    const ref = p.newNpc!.locationRef.id;
    return ws.locations.some((l) => l.id === ref) ? ref as LocationId : null;
  }
  if (p.newLocation?.placement === "town_building") {
    return asLocationId(p.newLocation.connectFromLocationId);
  }
  return mintedLocationId;
}

function resolveMountedLocationId(
  ws: WorldState,
  p: WorldDeltaProposal,
  ref: "current" | "new_location",
  mintedLocationId: LocationId | null,
): LocationId | null {
  if (ref === "current") {
    return ws.locations.some((l) => l.id === ws.currentLocationId) ? ws.currentLocationId : null;
  }
  if (p.newLocation?.placement === "town_building") {
    return asLocationId(p.newLocation.connectFromLocationId);
  }
  return mintedLocationId;
}

function deriveAnchorObjective(
  p: WorldDeltaProposal,
  ids: MintedIds,
): QuestObjective | null {
  if (p.newNpc && ids.npcId) return { kind: "talk_to_npc", npcId: ids.npcId };
  if (p.newLocation?.placement === "world" && ids.locationId) {
    return { kind: "visit_location", locationId: ids.locationId };
  }
  if (p.newItem && ids.itemId) return { kind: "obtain_item", itemId: ids.itemId };
  if (p.newFact && ids.factId) return { kind: "discover_fact", factId: ids.factId };
  if (p.newEnemy && ids.enemyId) return { kind: "defeat_enemy", enemyId: ids.enemyId };
  return null;
}

/** 幕目标链结构变体：由 seed+act 确定性选择，玩家在结构层无法预测全程流程。 */
export type ActObjectiveShape =
  | "full_chain"
  | "investigation_focus"
  | "confrontation_focus"
  | "errand_focus";

const ACT_OBJECTIVE_SHAPES: readonly ActObjectiveShape[] = [
  "full_chain", "investigation_focus", "confrontation_focus", "errand_focus",
];

const SHAPE_ALLOWED_KINDS: Readonly<Record<ActObjectiveShape, ReadonlySet<string>>> = {
  full_chain: new Set(["discover_fact", "visit_location", "talk_to_npc", "obtain_item", "defeat_enemy"]),
  investigation_focus: new Set(["discover_fact", "talk_to_npc", "obtain_item"]),
  confrontation_focus: new Set(["discover_fact", "talk_to_npc", "defeat_enemy"]),
  errand_focus: new Set(["visit_location", "talk_to_npc", "obtain_item"]),
};

/** 稳定字符串散列（djb2）：仅用于确定性变体选择，无密码学用途。 */
function hashStringToIndex(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** 雪崩混合（xorshift + 乘法）：打破 djb2 输出对输入尾部的线性敏感。 */
function mixBits(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * 由本局 seed 与目标幕次选择目标链结构；同 seed 同幕结果恒定。
 *
 * 注意：不能直接 `hash % 4`，也不能只做一次乘性高位提取。djb2 对“输入尾字符
 * 差 1”（`seed:3` 与 `seed:2` 只差末位 '3'-'2'=1）的输出差恒为奇数；任何乘以
 * 奇数（31≡3 mod 4、2654435761 等）后取低位/高位的桶函数，都会让相邻幕的
 * bucket 差 (奇 × K 的高 2 位 + 进位) ≠ 0——即 act2 与 act3 的 shape 必然不同，
 * 既削弱“结构层不可预测”的意图（act2 命中即可排除 act3 的相同变体），也令任何
 * seed 都无法让两个相邻幕同时命中同一变体（journey 回归无解，实测确认）。必须
 * 经雪崩混合打散后再取高 2 位：实测 5000 样本分布 1226/1230/1265/1279，plan 的
 * 200 样本覆盖四种变体断言通过，且存在对 act2-5 全部命中 `full_chain` 的 seed
 * （`q20`，供 journey 回归使用）。
 */
export function actObjectiveShape(seed: string, act: number): ActObjectiveShape {
  const digest = hashStringToIndex(`${seed}:${act}`);
  const bucket = (mixBits(digest) >>> 30) & 3;
  return ACT_OBJECTIVE_SHAPES[bucket]!;
}

/**
 * 正式幕必须留出可阅读、可验证的过程，而非一次交谈就结束。完整动态幕
 * 按“调查现场 → 前往新地点 → 与人物交谈 → 取得证物 → 处理阻拦”串成
 * 单向主线；提案缺少某类实体时自动跳过该类，但不压缩仍存在的步骤。
 * 结构变体在完整链基础上按 shape 过滤子集；过滤后为空时回退全程链，
 * 仍为空时回落锚点目标（可返回 null）。
 */
export function deriveActObjectives(
  p: WorldDeltaProposal,
  ids: MintedIds,
  shape: ActObjectiveShape,
): readonly QuestObjective[] | null {
  const full: QuestObjective[] = [];
  if (p.newFact && ids.factId) full.push({ kind: "discover_fact", factId: ids.factId });
  if (p.newLocation?.placement === "world" && ids.locationId) {
    full.push({ kind: "visit_location", locationId: ids.locationId });
  }
  if (p.newNpc && ids.npcId) full.push({ kind: "talk_to_npc", npcId: ids.npcId });
  if (p.newItem && ids.itemId) full.push({ kind: "obtain_item", itemId: ids.itemId });
  if (p.newEnemy && ids.enemyId) full.push({ kind: "defeat_enemy", enemyId: ids.enemyId });
  const allowed = SHAPE_ALLOWED_KINDS[shape];
  const shaped = full.filter((objective) => allowed.has(objective.kind));
  // 任何变体都必须保留可达锚点：过滤后为空回退全程链
  let chain: readonly QuestObjective[];
  if (shaped.length > 0) {
    chain = shaped;
  } else if (full.length > 0) {
    chain = full;
  } else {
    const anchor = deriveAnchorObjective(p, ids);
    if (anchor === null) return null;
    chain = [anchor];
  }
  // 物化新地点的幕必须把“抵达新地点”保留在链首：否则该地点永远不会被
  // storyReveal 的 visit_location 释放游标解锁，而后续幕会把 NPC/物品/敌人
  // 挂载到其上，主线目标不可达 → 主线永远无法推进（可完成性不变约束）。
  // 链首保留也维持 materializeWorldDelta 的“首个目标即释放新地点”优化。
  if (p.newLocation?.placement === "world" && ids.locationId && !chain.some((objective) => objective.kind === "visit_location")) {
    chain = [{ kind: "visit_location", locationId: ids.locationId }, ...chain];
  }
  return chain;
}

function ruleOwnedEndingRequirements(
  themeKey: "trust" | "doubt",
  ws: WorldState,
): readonly EndingRequirement[] {
  const keyNpcId = deriveKeyEndingNpcId(ws);
  if (keyNpcId === undefined) return [];
  return themeKey === "trust"
    ? [{ kind: "npc_affinity_at_least", npcId: keyNpcId, value: TRUST_ENDING_MIN_AFFINITY }]
    : [{ kind: "npc_affinity_at_most", npcId: keyNpcId, value: DOUBT_ENDING_MAX_AFFINITY }];
}

/** 审批预算预占：逐实体计数，返回预占后的预算或其对应的拒绝结果。 */
function reserveBudget(
  budget: StoryBudget,
  kinds: readonly ("location" | "npc" | "quest" | "ending" | "item" | "enemy" | "fact")[],
): { budget: StoryBudget } | { code: WorldDeltaRejection; reason: string } {
  let next = budget;
  for (const kind of kinds) {
    const dim = dimensionOf(kind);
    if (!budgetAllowsExpansion(next, dim)) {
      return { code: "budget_exceeded", reason: `soft_${dim}` };
    }
    if (kind === "location" && !withinHardLimit(next, "locations")) {
      return { code: "hard_limit_exceeded", reason: "hard_locations" };
    }
    if (kind === "npc" && !withinHardLimit(next, "npcs")) {
      return { code: "hard_limit_exceeded", reason: "hard_npcs" };
    }
    next = consumeExpansion(next, dim);
  }
  return { budget: next };
}

export function approveWorldDelta(input: {
  readonly proposal: WorldDeltaProposal;
  readonly need: EvolutionNeed;
  readonly ws: WorldState;
  readonly ss: StoryState;
  /** 回合修复路径：把行动引用 ID 原样铸造为缺失实体 ID（只作用于匹配 kind）。 */
  readonly idOverride?: WorldDeltaIdOverride;
}): ApproveWorldDeltaResult {
  const { proposal: p, need, ws, ss } = input;

  if (need.kind === "none") {
    return reject("no_need", "no_evolution_need");
  }

  const hasAnyEntity = p.newLocation !== null || p.newNpc !== null || p.newItem !== null
    || p.newEnemy !== null || p.newFact !== null || p.nextMainQuest !== null || p.endingPair !== null;
  if (!hasAnyEntity) {
    return reject("empty_proposal", "no_content");
  }

  // 需求形状：主线和结局对只能挂在对应需求之上。
  if (need.kind === "next_act" && p.nextMainQuest === null) {
    return reject("main_quest_conflict", "next_act_needs_main_quest");
  }
  if (need.kind !== "next_act" && p.nextMainQuest !== null) {
    return reject("main_quest_conflict", "main_quest_only_for_next_act");
  }
  if (need.kind === "ending_pair" && p.endingPair === null) {
    return reject("ending_pair_invalid", "ending_pair_needs_pair");
  }
  if (need.kind !== "ending_pair" && p.endingPair !== null) {
    return reject("ending_pair_invalid", "pair_only_at_ending");
  }

  // 结局对：两个方向必须主题互斥且名称互异。
  if (p.endingPair !== null) {
    const [a, b] = p.endingPair;
    const themes = new Set([a.themeKey, b.themeKey]);
    if (themes.size !== 2) {
      return reject("ending_pair_invalid", "themes_not_disjoint");
    }
    if (a.name.trim() === b.name.trim()) {
      return reject("ending_pair_invalid", "duplicate_ending_name");
    }
  }

  const ids = mintIds(ss.evolution, p, input.idOverride);

  // 目标链结构变体仅 next_act 消费（下方校验与铸造共用同一次计算，避免两处口径漂移）；
  // pacing / ending_pair 不铸造主线目标链，shape 保持 null。
  let shape: ActObjectiveShape | null = null;
  let actObjectives: readonly QuestObjective[] | null = null;

  // 引用解析：NPC/物品/敌人 的落点地点必须真实存在或本次同池铸造。
  let npcLocationId: LocationId | null = null;
  let itemLocationId: LocationId | null = null;
  let enemyLocationId: LocationId | null = null;
  if (p.newNpc) {
    npcLocationId = resolveNpcLocationId(ws, p, ids.locationId);
    if (npcLocationId === null) return reject("invalid_location_ref", "npc_location");
    // town 的建筑入口有有限槽位，但剧情人物不一定是驻店 NPC。
    // 满槽时保留 locationId 作为“临时在场人物”，由场景层展示和交谈；
    // materializeWorldDelta 会在有空槽时绑定建筑，没有空槽时安全地跳过绑定。
    // 这样幕边界不会因为建筑容量把主线人物铸造到玩家不可见的新地点。
  }
  if (p.newItem) {
    itemLocationId = resolveMountedLocationId(ws, p, p.newItem.locationRef, ids.locationId);
    if (itemLocationId === null) return reject("invalid_location_ref", "item_location");
  }
  if (p.newEnemy) {
    enemyLocationId = resolveMountedLocationId(ws, p, p.newEnemy.locationRef, ids.locationId);
    if (enemyLocationId === null) return reject("invalid_location_ref", "enemy_location");
  }
  const connectFrom = p.newLocation;
  if (connectFrom && !ws.locations.some((l) => l.id === connectFrom.connectFromLocationId)) {
    return reject("invalid_location_ref", "connect_from");
  }
  if (connectFrom?.placement === "town_building") {
    const parent = ws.locations.find((location) => location.id === connectFrom.connectFromLocationId);
    if (
      parent === undefined
      || parent.id !== ws.currentLocationId
      || parent.scale !== "town"
      || parent.town === undefined
    ) {
      return reject("invalid_location_ref", "town_building_parent");
    }
    if (p.newNpc?.locationRef.kind !== "new_location") {
      return reject("invalid_location_ref", "town_building_needs_npc");
    }
    if (!parent.town.slots.some((slot) => slot.boundNpcId === null)) {
      return reject("town_capacity", "town_building_slots_full");
    }
  }

  // 重名约束：新实体不得与既有同名实体撞名（敌人、跨幕任务名一并纳入）。
  if (p.newNpc && ws.npcs.some((n) => n.name === p.newNpc!.name)) return reject("duplicate_name", "npc");
  if (p.newLocation && ws.locations.some((l) => l.name === p.newLocation!.name)) return reject("duplicate_name", "location");
  if (p.newItem && ws.items.some((i) => i.name === p.newItem!.name)) return reject("duplicate_name", "item");
  if (p.newEnemy && ws.enemies.some((e) => e.name === p.newEnemy!.name)) return reject("duplicate_name", "enemy");
  if (p.nextMainQuest && ws.quests.some((q) => q.name === p.nextMainQuest!.name)) return reject("duplicate_name", "quest");
  const proposedNames = [
    ...(p.newNpc ? [p.newNpc.name] : []),
    ...(p.newLocation ? [p.newLocation.name] : []),
    ...(p.newItem ? [p.newItem.name] : []),
    ...(p.newEnemy ? [p.newEnemy.name] : []),
    ...(p.nextMainQuest ? [p.nextMainQuest.name] : []),
    ...(p.endingPair ? p.endingPair.map((e) => e.name) : []),
  ];
  if (new Set(proposedNames).size !== proposedNames.length) return reject("duplicate_name", "proposal_internal");

  // 体裁结构约束（最小集）：名称 2-40 字符，描述/正文非空且 <=200 字符。
  if (p.newNpc && (!validName(p.newNpc.name) || !validText(p.newNpc.role) || !validText(p.newNpc.description))) {
    return reject("genre_constraint", "npc_name_or_text");
  }
  if (p.newLocation && (!validName(p.newLocation.name) || !validText(p.newLocation.description))) {
    return reject("genre_constraint", "location_name_or_text");
  }
  if (p.newItem && (!validName(p.newItem.name) || !validText(p.newItem.description))) {
    return reject("genre_constraint", "item_name_or_text");
  }
  if (p.newEnemy && !validName(p.newEnemy.name)) {
    return reject("genre_constraint", "enemy_name");
  }
  if (p.newFact && !validText(p.newFact.text)) {
    return reject("genre_constraint", "fact_text");
  }
  if (p.nextMainQuest && (!validName(p.nextMainQuest.name) || !validText(p.nextMainQuest.description))) {
    return reject("genre_constraint", "quest_name_or_text");
  }
  if (p.endingPair) {
    for (const e of p.endingPair) {
      if (!validName(e.name) || !validText(e.description)) return reject("genre_constraint", "ending_name_or_text");
    }
  }

  const proposedText = [
    p.beatSummary,
    ...(p.newLocation ? [p.newLocation.name, p.newLocation.description] : []),
    ...(p.newNpc ? [p.newNpc.name, p.newNpc.role, p.newNpc.description, ...p.newNpc.goals] : []),
    ...(p.newItem ? [p.newItem.name, p.newItem.description] : []),
    ...(p.newEnemy ? [p.newEnemy.name] : []),
    ...(p.newFact ? [p.newFact.text] : []),
    ...(p.nextMainQuest ? [p.nextMainQuest.name, p.nextMainQuest.description, p.nextMainQuest.objectiveText] : []),
    ...(p.endingPair ? p.endingPair.flatMap((ending) => [ending.name, ending.description]) : []),
  ];
  if (violatesGenre(ws, proposedText)) {
    return reject("genre_constraint", `game_type_${ws.generation.gameType}`);
  }

  // 主线任务：每幕唯一（一个 act 只能有一个 main quest），且目标必须有可达锚点。
  if (need.kind === "next_act") {
    shape = actObjectiveShape(ws.generation.seed, need.act);
    const stageCollision = ws.quests.some((q) => q.kind === "main" && q.stage === need.act && q.status !== "closed");
    if (stageCollision) return reject("main_quest_conflict", `act_${need.act}_has_main_quest`);
    actObjectives = deriveActObjectives(p, ids, shape);
    if (actObjectives === null) return reject("unreachable_objective", "no_anchor_entity");
  }

  // 空间一致性门槛：幕演化同时铸造 world 新地点、目标 NPC 与主线任务时，该 NPC
  // 必须落在新地点（locationRef=new_location，按 proposal 直接检查）。否则目标链
  // “先抵达新地点、再与该 NPC 交谈”在空间上矛盾，审批通过只会产生玩家被要求去
  // 新地点却永远看不到目标 NPC 的死链。此规则在预算预占/实体条目铸造前硬拒绝，
  // 而不是把旧地点的 NPC 静默搬迁到新地点。其余更具体的原因（invalid_location_ref/
  // duplicate_name/genre_constraint）由前置校验先行使，本门槛只收口仍未触发的组合。
  if (
    need.kind === "next_act"
    && p.nextMainQuest !== null
    && p.newLocation !== null
    && p.newLocation.placement === "world"
    && p.newNpc !== null
    && p.newNpc.locationRef.kind !== "new_location"
  ) {
    return reject("unreachable_objective", REJECT_REASON_NPC_NOT_AT_NEW_LOCATION);
  }

  // 预算预占（在铸造实体前校验，避免无效提议占用序号）。
  const neededKinds: ("location" | "npc" | "quest" | "ending" | "item" | "enemy" | "fact")[] = [];
  if (p.newLocation?.placement === "world") neededKinds.push("location");
  if (p.newNpc) neededKinds.push("npc");
  if (p.newItem) neededKinds.push("item");
  if (p.newEnemy) neededKinds.push("enemy");
  if (p.newFact) neededKinds.push("fact");
  if (p.nextMainQuest) neededKinds.push("quest");
  if (p.endingPair) neededKinds.push("ending", "ending");
  const reserved = reserveBudget(ss.budget, neededKinds);
  if (!("budget" in reserved)) {
    return reject(reserved.code, reserved.reason);
  }

  // 铸造条目。
  const newLocations: LocationEntry[] = [];
  const newNpcs: NpcEntry[] = [];
  const newItems: ItemEntry[] = [];
  const newEnemies: EnemyEntry[] = [];
  const newFacts: WorldFactEntry[] = [];
  const newQuests: QuestEntry[] = [];
  const newEndings: EndingEntry[] = [];
  const townBuildingBindings: {
    locationId: LocationId;
    npcId: NpcId;
    displayName: string;
  }[] = [];
  const logCategories: string[] = [];

  // 如果新幕的目标链先要求抵达同批新地点，调查事实也必须挂在该地点；否则
  // 事实仍被放在旧地点，玩家抵达后无法合法调查，场景候选会退化为不足两项。
  // 目标链仍以“现场调查优先”的形状保持旧地点事实语义，只有首目标确实是
  // visit_location 时才切换挂载位置。
  const newFactLocationId = p.newFact && ids.factId
    && actObjectives?.[0]?.kind === "visit_location"
    && ids.locationId !== null
    ? ids.locationId
    : ws.currentLocationId;

  if (p.newLocation?.placement === "world" && ids.locationId) {
    newLocations.push({
      id: ids.locationId,
      name: p.newLocation.name,
      description: p.newLocation.description,
      kind: "main",
      connectedLocationIds: [p.newLocation.connectFromLocationId as LocationId],
      npcIds: p.newNpc && npcLocationId === ids.locationId && ids.npcId ? [ids.npcId] : [],
      availableItemIds: p.newItem && itemLocationId === ids.locationId && ids.itemId ? [ids.itemId] : [],
      tags: ["dynamic"],
      scale: p.newLocation.scale,
    });
  }

  if (p.newNpc && ids.npcId) {
    newNpcs.push({
      id: ids.npcId,
      name: p.newNpc.name,
      role: p.newNpc.role,
      description: p.newNpc.description,
      locationId: npcLocationId!,
      isCompanion: false,
      tags: ["dynamic"],
      met: false,
      memory: {
        npcId: ids.npcId,
        knownFactIds: p.newFact && p.newFact.visibility === "public" && ids.factId ? [ids.factId] : [],
        hiddenFactIds: p.newFact && p.newFact.visibility === "npc_private" && ids.factId ? [ids.factId] : [],
        interactionHistory: [],
        relationship: { affinity: 0 },
        emotion: "neutral",
        goals: p.newNpc.goals,
      },
    });
    if (p.newLocation?.placement === "town_building") {
      townBuildingBindings.push({
        locationId: asLocationId(p.newLocation.connectFromLocationId),
        npcId: ids.npcId,
        displayName: p.newLocation.name,
      });
    }
  }

  if (p.newItem && ids.itemId) {
    newItems.push({
      id: ids.itemId,
      name: p.newItem.name,
      description: p.newItem.description,
      kind: "misc",
      tags: [`location_id:${itemLocationId!}`],
      category: "quest",
      rarity: "common",
    });
  }

  if (p.newEnemy && ids.enemyId) {
    newEnemies.push({
      id: ids.enemyId,
      name: p.newEnemy.name,
      tier: p.newEnemy.tier,
      stats: toStatBlock(ENEMY_COMBAT_STATS[p.newEnemy.tier]),
      locationId: enemyLocationId!,
      tags: ["dynamic"],
    });
  }

  if (p.newFact && ids.factId) {
    const approachResult = validateInvestigationApproaches(p.newFact.investigationApproaches, p.newFact.text);
    newFacts.push({
      factId: ids.factId,
      text: p.newFact.text,
      source: "generated",
      // public 只表示可在发现后进入玩家事实卡，不能跳过调查动作。
      discovered: false,
      investigationLabel: p.newFact.investigationLabel,
      // 审批通过才落盘：非法列表已在 validateInvestigationApproaches 内降级为空。
      ...(approachResult.approaches.length > 0 ? { investigationApproaches: approachResult.approaches } : {}),
      // 第一阶段必须是玩家当前所在的酒楼后巷/现场调查；否则新地点一
      // 生成就会把“现场线索”错误地放到尚未抵达的地点。
      locationId: newFactLocationId,
    });
    logCategories.push(...approachResult.logCategories);
  }

  if (need.kind === "next_act" && p.nextMainQuest && ids.questId) {
    newQuests.push({
      id: ids.questId,
      name: p.nextMainQuest.name,
      description: p.nextMainQuest.description,
      // need.kind === "next_act" 时上方校验块必然已为 shape 赋值。
      objectives: actObjectives!,
      onSuccess: { kind: "advance_story" },
      onFailure: { kind: "closed" },
      tags: ["dynamic"],
      kind: "main",
      stage: need.act,
      status: "active",
    });
  }

  if (p.endingPair && ids.endingIds.length === 2) {
    newEndings.push(
      {
        id: ids.endingIds[0],
        name: p.endingPair[0].name,
        description: p.endingPair[0].description,
        requirements: ruleOwnedEndingRequirements(p.endingPair[0].themeKey, ws),
      },
      {
        id: ids.endingIds[1],
        name: p.endingPair[1].name,
        description: p.endingPair[1].description,
        requirements: ruleOwnedEndingRequirements(p.endingPair[1].themeKey, ws),
      },
    );
  }

  const nextEvolution: StoryEvolutionState = {
    nextLocationOrdinal: ids.locationId ? ss.evolution.nextLocationOrdinal + 1 : ss.evolution.nextLocationOrdinal,
    nextNpcOrdinal: ids.npcId ? ss.evolution.nextNpcOrdinal + 1 : ss.evolution.nextNpcOrdinal,
    nextItemOrdinal: ids.itemId ? ss.evolution.nextItemOrdinal + 1 : ss.evolution.nextItemOrdinal,
    nextEnemyOrdinal: ids.enemyId ? ss.evolution.nextEnemyOrdinal + 1 : ss.evolution.nextEnemyOrdinal,
    nextFactOrdinal: ids.factId ? ss.evolution.nextFactOrdinal + 1 : ss.evolution.nextFactOrdinal,
    nextQuestOrdinal: ids.questId ? ss.evolution.nextQuestOrdinal + 1 : ss.evolution.nextQuestOrdinal,
    nextEndingOrdinal: ids.endingIds.length > 0
      ? ss.evolution.nextEndingOrdinal + ids.endingIds.length
      : ss.evolution.nextEndingOrdinal,
    status: ss.evolution.status,
  };

  return {
    ok: true,
    approved: {
      beatSummary: p.beatSummary,
      mintedLocationIds: ids.locationId ? [ids.locationId] : [],
      mintedNpcIds: ids.npcId ? [ids.npcId] : [],
      mintedItemIds: ids.itemId ? [ids.itemId] : [],
      mintedEnemyIds: ids.enemyId ? [ids.enemyId] : [],
      mintedFactIds: ids.factId ? [ids.factId] : [],
      mintedQuestIds: ids.questId ? [ids.questId] : [],
      mintedEndingIds: ids.endingIds,
      newLocations,
      newNpcs,
      newItems,
      newEnemies,
      newFacts,
      newQuests,
      newEndings,
      townBuildingBindings,
      itemLocationId,
      enemyLocationId,
      ...(logCategories.length > 0 ? { logCategories } : {}),
      nextEvolution,
      nextBudget: reserved.budget,
    },
  };
}
