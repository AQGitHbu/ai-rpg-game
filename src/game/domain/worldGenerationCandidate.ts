import type {
  LocationDefinitionCandidate,
  ItemDefinitionCandidate,
  EnemyTemplateCandidate,
  QuestDefinitionCandidate,
  EndingDefinitionCandidate,
  StatBlock,
} from "./worldEntity";

// ---------------------------------------------------------------------------
// Task 12：WorldGenerationCandidate 完整领域契约。
//
// 这是 AI 世界源（WorldGenerationSource）产出的原始候选类型：ID 为普通字符串，
// 未经品牌化编译。与全量世界蓝图候选不同，本候选聚焦当前世界生成：
// 公开/隐藏 facts、NPC 初始 known/hidden facts 与 goals、主线任务骨架、结局
// requirements、起始锚点与 opening 预算计数。
//
// 引用和可达性不做静态约束——parser 只做形状/枚举/长度检查，引用校验留给
// gameplay validator（Task 13）。
// ---------------------------------------------------------------------------

/** 阵营候选：玩家可交涉的势力。 */
export type FactionCandidate = {
  readonly factionId: string;
  readonly name: string;
  /** 初始好感：-100..100。 */
  readonly attitudeToPlayer: number;
};

/** 扩展自 NpcDefinitionCandidate，增加初始 hidden facts 与 goals。 */
export type NpcGenerationCandidate = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
  readonly locationId: string;
  readonly isCompanion: boolean;
  /** NPC 初始已知的世界事实 ID（公开）。 */
  readonly knownFactIds: readonly string[];
  /** NPC 初始隐藏的世界事实 ID（秘密）。 */
  readonly hiddenFactIds: readonly string[];
  /** NPC 的短期/长期目标（文本）。 */
  readonly goals: readonly string[];
  readonly tags: readonly string[];
};

export type WorldGenerationCandidate = {
  readonly world: {
    readonly summary: string;
    readonly tone: string;
    readonly themes: readonly string[];
    /** 公开事实：世界基础设定，开局即可见。 */
    readonly publicFacts: readonly { readonly id: string; readonly text: string }[];
    /** 隐藏事实：需调查/剧情揭露的秘密。 */
    readonly hiddenFacts: readonly { readonly id: string; readonly text: string }[];
    readonly tags: readonly string[];
  };
  readonly player: {
    readonly name: string;
    readonly identity: string;
    readonly backgroundSummary: string;
    readonly startingLocationId: string;
    readonly startingItemIds: readonly string[];
    readonly baseStats: StatBlock;
  };
  /** 起始锚点：玩家开局所在的地点/NPC/主线任务/main thread。 */
  readonly startAnchor: {
    readonly locationId: string;
    readonly npcId: string;
    readonly startQuestId: string;
    readonly mainThreadId: string;
  };
  readonly locations: readonly LocationDefinitionCandidate[];
  readonly npcs: readonly NpcGenerationCandidate[];
  readonly items: readonly ItemDefinitionCandidate[];
  readonly enemies: readonly EnemyTemplateCandidate[];
  readonly factions: readonly FactionCandidate[];
  /** 主线（stage 1）1 个 + 支线 0-2 个；stage 递增构成幕骨架。 */
  readonly quests: readonly QuestDefinitionCandidate[];
  /** 至少两个语义不同、requirements 非空的结局。 */
  readonly endings: readonly EndingDefinitionCandidate[];
  /** opening 预算计数：与 BudgetPolicy.opening 对齐，供校验核对。 */
  readonly openingBudget: {
    readonly locationsCount: number;
    readonly npcsCount: number;
    readonly sideQuestsCount: number;
    readonly endingsCount: number;
    readonly townLocationsCount: number;
  };
};

// ---------------------------------------------------------------------------
// schema parser：AI 原始 unknown → WorldGenerationCandidate
// 只做形状/枚举/长度检查，不做引用校验（留给 gameplay validator）。
// ---------------------------------------------------------------------------

export type ParseWorldGenerationCandidateResult =
  | { readonly ok: true; readonly value: WorldGenerationCandidate }
  | { readonly ok: false; readonly code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function asRecordList(value: unknown): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isRecord)) return null;
  return value;
}

export function parseWorldGenerationCandidate(
  input: unknown,
): ParseWorldGenerationCandidateResult {
  if (!isRecord(input)) return { ok: false, code: "NOT_AN_OBJECT" };
  const { world, player, startAnchor, locations, npcs, items, enemies, factions, quests, endings, openingBudget } = input;

  if (!isRecord(world)) return { ok: false, code: "INVALID_WORLD" };
  if (!isRecord(player)) return { ok: false, code: "INVALID_PLAYER" };
  if (!isRecord(startAnchor)) return { ok: false, code: "INVALID_START_ANCHOR" };

  if (typeof world.summary !== "string" || typeof world.tone !== "string") return { ok: false, code: "INVALID_WORLD_TEXT" };
  if (!isStringArray(world.themes) || !isStringArray(world.tags)) return { ok: false, code: "INVALID_WORLD_LISTS" };

  const publicFacts = asRecordList(world.publicFacts);
  const hiddenFacts = asRecordList(world.hiddenFacts);
  if (publicFacts === null || hiddenFacts === null) return { ok: false, code: "INVALID_FACTS" };
  for (const f of [...publicFacts, ...hiddenFacts]) {
    if (typeof f.id !== "string" || typeof f.text !== "string") return { ok: false, code: "INVALID_FACT" };
  }

  if (typeof player.name !== "string" || typeof player.identity !== "string") return { ok: false, code: "INVALID_PLAYER_TEXT" };
  if (typeof player.startingLocationId !== "string") return { ok: false, code: "INVALID_PLAYER_LOCATION" };
  if (!isStringArray(player.startingItemIds)) return { ok: false, code: "INVALID_PLAYER_ITEMS" };
  if (!isRecord(player.baseStats)) return { ok: false, code: "INVALID_PLAYER_STATS" };

  if (typeof startAnchor.locationId !== "string" || typeof startAnchor.npcId !== "string") return { ok: false, code: "INVALID_ANCHOR_IDS" };
  if (typeof startAnchor.startQuestId !== "string" || typeof startAnchor.mainThreadId !== "string") return { ok: false, code: "INVALID_ANCHOR_THREAD" };

  const locationsList = asRecordList(locations);
  const npcsList = asRecordList(npcs);
  const itemsList = asRecordList(items);
  const enemiesList = asRecordList(enemies);
  const factionsList = asRecordList(factions);
  const questsList = asRecordList(quests);
  const endingsList = asRecordList(endings);
  if (
    locationsList === null || npcsList === null || itemsList === null ||
    enemiesList === null || factionsList === null || questsList === null ||
    endingsList === null
  ) {
    return { ok: false, code: "INVALID_ENTITY_LISTS" };
  }

  // 主线任务骨架：至少一个主任务；支线 0-2。
  const mainQuests = questsList.filter((q) => q.kind === "main");
  const sideQuests = questsList.filter((q) => q.kind === "side");
  if (mainQuests.length < 1) return { ok: false, code: "MISSING_MAIN_QUEST" };
  if (sideQuests.length > 2) return { ok: false, code: "TOO_MANY_SIDE_QUESTS" };

  // 结局：至少两个，且每个 requirements 非空（语义不同）。
  if (endingsList.length < 2) return { ok: false, code: "TOO_FEW_ENDINGS" };
  for (const e of endingsList) {
    if (!Array.isArray(e.requirements) || e.requirements.length === 0) {
      return { ok: false, code: "EMPTY_ENDING_REQUIREMENTS" };
    }
    for (const requirement of e.requirements) {
      if (!isRecord(requirement) || typeof requirement.kind !== "string") {
        return { ok: false, code: "INVALID_ENDING_REQUIREMENT" };
      }
      if (
        (requirement.kind === "quest_completed" || requirement.kind === "quest_failed")
        && typeof requirement.questId !== "string"
      ) return { ok: false, code: "INVALID_ENDING_REQUIREMENT" };
      if (requirement.kind === "fact_discovered" && typeof requirement.factId !== "string") {
        return { ok: false, code: "INVALID_ENDING_REQUIREMENT" };
      }
      if (
        (requirement.kind === "npc_affinity_at_least" || requirement.kind === "npc_affinity_at_most")
        && (typeof requirement.npcId !== "string" || !isNumber(requirement.value))
      ) return { ok: false, code: "INVALID_ENDING_REQUIREMENT" };
      if (![
        "quest_completed",
        "quest_failed",
        "fact_discovered",
        "npc_affinity_at_least",
        "npc_affinity_at_most",
      ].includes(requirement.kind)) return { ok: false, code: "INVALID_ENDING_REQUIREMENT" };
    }
  }

  if (!isRecord(openingBudget)) return { ok: false, code: "INVALID_OPENING_BUDGET" };
  if (
    !isNumber(openingBudget.locationsCount) ||
    !isNumber(openingBudget.npcsCount) ||
    !isNumber(openingBudget.sideQuestsCount) ||
    !isNumber(openingBudget.endingsCount) ||
    !isNumber(openingBudget.townLocationsCount)
  ) {
    return { ok: false, code: "INVALID_OPENING_BUDGET_COUNTS" };
  }

  const value: WorldGenerationCandidate = {
    world: {
      summary: world.summary,
      tone: world.tone,
      themes: world.themes,
      publicFacts: publicFacts.map((f) => ({ id: f.id as string, text: f.text as string })),
      hiddenFacts: hiddenFacts.map((f) => ({ id: f.id as string, text: f.text as string })),
      tags: world.tags,
    },
    player: {
      name: player.name as string,
      identity: player.identity as string,
      backgroundSummary: typeof player.backgroundSummary === "string" ? player.backgroundSummary : "",
      startingLocationId: player.startingLocationId as string,
      startingItemIds: player.startingItemIds as readonly string[],
      baseStats: {
        hp: isNumber(player.baseStats.hp) ? player.baseStats.hp : 0,
        attack: isNumber(player.baseStats.attack) ? player.baseStats.attack : 0,
        defense: isNumber(player.baseStats.defense) ? player.baseStats.defense : 0,
      },
    },
    startAnchor: {
      locationId: startAnchor.locationId as string,
      npcId: startAnchor.npcId as string,
      startQuestId: startAnchor.startQuestId as string,
      mainThreadId: startAnchor.mainThreadId as string,
    },
    locations: locationsList as never,
    npcs: npcsList.map((n) => ({
      id: n.id as string,
      name: n.name as string,
      role: n.role as string,
      description: n.description as string,
      locationId: n.locationId as string,
      isCompanion: Boolean(n.isCompanion),
      knownFactIds: isStringArray(n.knownFactIds) ? n.knownFactIds : [],
      hiddenFactIds: isStringArray(n.hiddenFactIds) ? n.hiddenFactIds : [],
      goals: isStringArray(n.goals) ? n.goals : [],
      tags: isStringArray(n.tags) ? n.tags : [],
    })) as never,
    items: itemsList as never,
    enemies: enemiesList as never,
    factions: factionsList.map((f) => ({
      factionId: f.factionId as string,
      name: f.name as string,
      attitudeToPlayer: isNumber(f.attitudeToPlayer) ? f.attitudeToPlayer : 0,
    })),
    quests: questsList as never,
    endings: endingsList as never,
    openingBudget: {
      locationsCount: openingBudget.locationsCount as number,
      npcsCount: openingBudget.npcsCount as number,
      sideQuestsCount: openingBudget.sideQuestsCount as number,
      endingsCount: openingBudget.endingsCount as number,
      townLocationsCount: openingBudget.townLocationsCount as number,
    },
  };

  return { ok: true, value };
}
