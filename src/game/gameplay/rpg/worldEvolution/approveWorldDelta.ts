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
  /** item/enemy 的挂载地点（fact 为世界级事实，无地点）。 */
  readonly itemLocationId: LocationId | null;
  readonly enemyLocationId: LocationId | null;
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
  const dynLocationId = p.newLocation ? asLocationId(`loc_dyn_${ev.nextLocationOrdinal}`) : null;
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
  return mintedLocationId;
}

function townHasNpcSlot(ws: WorldState, locationId: LocationId): boolean {
  const location = ws.locations.find((entry) => entry.id === locationId);
  return location?.town === undefined || location.town.slots.some((slot) => slot.boundNpcId === null);
}

function resolveMountedLocationId(
  ws: WorldState,
  ref: "current" | "new_location",
  mintedLocationId: LocationId | null,
): LocationId | null {
  if (ref === "current") {
    return ws.locations.some((l) => l.id === ws.currentLocationId) ? ws.currentLocationId : null;
  }
  return mintedLocationId;
}

function deriveAnchorObjective(
  p: WorldDeltaProposal,
  ids: MintedIds,
): QuestObjective | null {
  if (p.newNpc && ids.npcId) return { kind: "talk_to_npc", npcId: ids.npcId };
  if (p.newLocation && ids.locationId) return { kind: "visit_location", locationId: ids.locationId };
  if (p.newItem && ids.itemId) return { kind: "obtain_item", itemId: ids.itemId };
  if (p.newFact && ids.factId) return { kind: "discover_fact", factId: ids.factId };
  if (p.newEnemy && ids.enemyId) return { kind: "defeat_enemy", enemyId: ids.enemyId };
  return null;
}

function ruleOwnedEndingRequirements(
  themeKey: "trust" | "doubt",
  ws: WorldState,
): readonly EndingRequirement[] {
  const keyNpcId = ws.npcs[0]?.id;
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

  // 引用解析：NPC/物品/敌人 的落点地点必须真实存在或本次同池铸造。
  let npcLocationId: LocationId | null = null;
  let itemLocationId: LocationId | null = null;
  let enemyLocationId: LocationId | null = null;
  if (p.newNpc) {
    npcLocationId = resolveNpcLocationId(ws, p, ids.locationId);
    if (npcLocationId === null) return reject("invalid_location_ref", "npc_location");
    // town 层的剧情建筑是有限槽位；不允许把动态 NPC 写入已满的小镇，
    // 否则装配阶段无法绑定入口，玩家也无法从三层 UI 触达该 NPC。
    if (p.newNpc.locationRef.kind === "existing" && !townHasNpcSlot(ws, npcLocationId)) {
      return reject("town_capacity", "npc_town_slots_full");
    }
  }
  if (p.newItem) {
    itemLocationId = resolveMountedLocationId(ws, p.newItem.locationRef, ids.locationId);
    if (itemLocationId === null) return reject("invalid_location_ref", "item_location");
  }
  if (p.newEnemy) {
    enemyLocationId = resolveMountedLocationId(ws, p.newEnemy.locationRef, ids.locationId);
    if (enemyLocationId === null) return reject("invalid_location_ref", "enemy_location");
  }
  const connectFrom = p.newLocation;
  if (connectFrom && !ws.locations.some((l) => l.id === connectFrom.connectFromLocationId)) {
    return reject("invalid_location_ref", "connect_from");
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

  // 主线任务：每幕唯一（一个 act 只能有一个 main quest），且目标必须有可达锚点。
  if (need.kind === "next_act") {
    const stageCollision = ws.quests.some((q) => q.kind === "main" && q.stage === need.act && q.status !== "closed");
    if (stageCollision) return reject("main_quest_conflict", `act_${need.act}_has_main_quest`);
    const objective = deriveAnchorObjective(p, ids);
    if (objective === null) return reject("unreachable_objective", "no_anchor_entity");
  }

  // 预算预占（在铸造实体前校验，避免无效提议占用序号）。
  const neededKinds: ("location" | "npc" | "quest" | "ending" | "item" | "enemy" | "fact")[] = [];
  if (p.newLocation) neededKinds.push("location");
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

  if (p.newLocation && ids.locationId) {
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
    const boss = p.newEnemy.tier === "boss";
    newEnemies.push({
      id: ids.enemyId,
      name: p.newEnemy.name,
      tier: p.newEnemy.tier,
      stats: boss ? { hp: 100, attack: 15, defense: 8 } : { hp: 30, attack: 8, defense: 4 },
      locationId: enemyLocationId!,
      tags: ["dynamic"],
    });
  }

  if (p.newFact && ids.factId) {
    newFacts.push({
      factId: ids.factId,
      text: p.newFact.text,
      source: "generated",
      discovered: p.newFact.visibility === "public",
      // 提案协议中的 fact 没有单独 locationRef：同批新地点优先，否则挂到
      // 当前地点，保证调查入口能从权威世界状态投影出来。
      locationId: ids.locationId ?? ws.currentLocationId,
    });
  }

  if (need.kind === "next_act" && p.nextMainQuest && ids.questId) {
    newQuests.push({
      id: ids.questId,
      name: p.nextMainQuest.name,
      description: p.nextMainQuest.description,
      objectives: [deriveAnchorObjective(p, ids)!],
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
      itemLocationId,
      enemyLocationId,
      nextEvolution,
      nextBudget: reserved.budget,
    },
  };
}
