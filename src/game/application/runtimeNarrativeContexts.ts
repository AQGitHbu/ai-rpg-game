// ---------------------------------------------------------------------------
// Phase 10 Task 3：三角色最小上下文投影器。
// 每个函数将 domain state → 纯净 context JSON（绝不含 AI prompt 原文、密钥）。
// ---------------------------------------------------------------------------

import { budgetPolicyOf, relationshipTierOf, storyMemoryOf, type EndingTone, type GameState, type NarrativeTriggerContext, type PlayerNpcChatState, type ScenarioBlueprint, type StoryMemoryEntry } from "@/game/domain";
import { projectAvailableActions, projectRelationshipSummary } from "@/game/gameplay/rpg/actions";
import { actionKeyOf, deriveContentProgression, type ContentProgression } from "@/game/gameplay/rpg/narrative";
import { isQuestObjectiveSatisfied, reconcileMainStoryProgress } from "@/game/gameplay/rpg/quests";
import type { ApprovedDirectorPlan } from "@/game/gameplay/rpg/narrative";
import { projectTownLayerView } from "./townRuntimeView";

const LAST_EVENT_COUNT = 5;
const DIRECTOR_CONTINUITY_LIMIT = 12;
const WRITER_CONTINUITY_LIMIT = 6;

// ---------------------------------------------------------------------------
// Phase 11 连续性投影：把结构化里程碑映射为安全文本（仅具名实体，不含原始 ID/对白/事实原文）。
// ---------------------------------------------------------------------------

type ContinuityMilestone = { readonly text: string };

/** 上一幕的结构化 handoff 卡：不含 AI 原文，只保留地点/NPC/节奏/玩家行动。 */
export type PreviousSceneCard = {
  readonly sceneId: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly focusNpcId: string | null;
  readonly focusNpcName: string | null;
  readonly pacing: string;
  readonly playerActionKey: string | null;
};

function previousSceneCardOf(
  blueprint: ScenarioBlueprint,
  state: GameState,
): PreviousSceneCard | null {
  const previousScene = [...state.eventLedger]
    .reverse()
    .find((event) => event.type === "narrative_scene_presented");
  if (previousScene === undefined || previousScene.type !== "narrative_scene_presented") return null;
  const previousChoice = [...state.eventLedger]
    .reverse()
    .find((event) => event.type === "narrative_choice" && event.sceneId === previousScene.sceneId);
  const focusNpcId = previousScene.focusNpcId === null ? null : String(previousScene.focusNpcId);
  return {
    sceneId: previousScene.sceneId,
    locationId: String(previousScene.locationId),
    locationName: locationNameOf(blueprint, String(previousScene.locationId)),
    focusNpcId,
    focusNpcName: focusNpcId === null ? null : npcNameOf(blueprint, focusNpcId),
    pacing: previousScene.pacing,
    playerActionKey: previousChoice?.type === "narrative_choice" ? previousChoice.actionKey : null,
  };
}

function locationNameOf(blueprint: ScenarioBlueprint, locationId: string): string {
  return blueprint.locations.find((entry) => String(entry.id) === locationId)?.name ?? "未知地点";
}

function npcNameOf(blueprint: ScenarioBlueprint, npcId: string): string {
  return blueprint.npcs.find((entry) => String(entry.id) === npcId)?.name ?? "某人";
}

function questNameOf(blueprint: ScenarioBlueprint, questId: string): string {
  return blueprint.quests.find((entry) => String(entry.id) === questId)?.name ?? "某事";
}

function itemNameOf(blueprint: ScenarioBlueprint, itemId: string): string {
  return blueprint.items.find((entry) => String(entry.id) === itemId)?.name ?? "某物";
}

function enemyNameOf(blueprint: ScenarioBlueprint, enemyId: string): string {
  return blueprint.enemies.find((entry) => String(entry.id) === enemyId)?.name ?? "某敌";
}

export type ActiveMainObjective = {
  readonly questId: string;
  readonly stage: number;
  readonly kind: string;
  readonly targetId: string;
  /** 目标完成所需的直接规则行动；可能当前不可用。 */
  readonly targetActionKey: string;
  /** 当前合法的直接行动，或通往目标地点的第一步移动。 */
  readonly suggestedActionKey: string | null;
};

function objectiveTargetId(objective: ScenarioBlueprint["quests"][number]["objectives"][number]): string {
  switch (objective.kind) {
    case "visit_location": return String(objective.locationId);
    case "talk_to_npc": return String(objective.npcId);
    case "obtain_item": return String(objective.itemId);
    case "discover_fact": return String(objective.factId);
    case "defeat_enemy": return String(objective.enemyId);
  }
}

function objectiveActionKey(objective: ScenarioBlueprint["quests"][number]["objectives"][number]): string {
  switch (objective.kind) {
    case "visit_location": return `move:${objective.locationId}`;
    case "talk_to_npc": return `talk:${objective.npcId}`;
    case "obtain_item": return `take_item:${objective.itemId}`;
    case "discover_fact": return `investigate:${objective.factId}`;
    case "defeat_enemy": return `start_battle:${objective.enemyId}`;
  }
}

function objectiveTargetLocationId(
  blueprint: ScenarioBlueprint,
  objective: ScenarioBlueprint["quests"][number]["objectives"][number],
): string | null {
  switch (objective.kind) {
    case "visit_location": return String(objective.locationId);
    case "talk_to_npc": {
      const npc = blueprint.npcs.find((entry) => String(entry.id) === String(objective.npcId));
      return npc === undefined ? null : String(npc.locationId);
    }
    case "obtain_item": {
      const location = blueprint.locations.find((entry) =>
        entry.availableItemIds.some((itemId) => String(itemId) === String(objective.itemId)),
      );
      return location === undefined ? null : String(location.id);
    }
    case "discover_fact":
      return blueprint.openingScene.investigableFactIds.some((factId) => String(factId) === String(objective.factId))
        ? String(blueprint.openingScene.locationId)
        : null;
    case "defeat_enemy": {
      const enemy = blueprint.enemies.find((entry) => String(entry.id) === String(objective.enemyId));
      return enemy === undefined ? null : String(enemy.locationId);
    }
  }
}

/**
 * 在已解锁地点图上寻找第一步合法移动。只返回 actionCandidates 中存在的
 * move key，避免把规划路径变成新的规则入口；不可达时返回 null。
 */
function nextMoveToward(
  blueprint: ScenarioBlueprint,
  state: GameState,
  targetLocationId: string | null,
  actionCandidates: readonly { readonly actionKey: string }[],
): string | null {
  if (targetLocationId === null || String(state.currentLocationId) === targetLocationId) return null;
  const unlocked = new Set(state.unlockedLocationIds.map(String));
  const legalMoveKeys = new Set(
    actionCandidates
      .map((entry) => entry.actionKey)
      .filter((key) => key.startsWith("move:")),
  );
  const locations = new Map(blueprint.locations.map((entry) => [String(entry.id), entry]));
  const queue: { readonly locationId: string; readonly firstMove: string | null }[] = [
    { locationId: String(state.currentLocationId), firstMove: null },
  ];
  const visited = new Set([String(state.currentLocationId)]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const location = locations.get(current.locationId);
    if (location === undefined) continue;
    for (const connectedId of location.connectedLocationIds) {
      const nextId = String(connectedId);
      if (!unlocked.has(nextId) || visited.has(nextId)) continue;
      visited.add(nextId);
      const firstMove = current.firstMove ?? `move:${nextId}`;
      if (nextId === targetLocationId) {
        return legalMoveKeys.has(firstMove) ? firstMove : null;
      }
      queue.push({ locationId: nextId, firstMove });
    }
  }
  return null;
}

function projectActiveMainObjective(
  blueprint: ScenarioBlueprint,
  state: GameState,
  actionCandidates: readonly { readonly actionKey: string }[],
): ActiveMainObjective | null {
  const activeMainIds = new Set(
    state.quests
      .filter((quest) => quest.status === "active")
      .map((quest) => String(quest.questId)),
  );
  const quest = blueprint.quests.find(
    (entry) => entry.kind === "main" && activeMainIds.has(String(entry.id)),
  );
  if (quest === undefined || quest.kind !== "main") return null;
  const objectives = Array.isArray(quest.objectives) ? quest.objectives : [];
  const objective = objectives.find((entry) => !isQuestObjectiveSatisfied(state, entry));
  if (objective === undefined) return null;
  const targetActionKey = objectiveActionKey(objective);
  const directActionAvailable = actionCandidates.some((entry) => entry.actionKey === targetActionKey);
  return {
    questId: String(quest.id),
    stage: quest.stage,
    kind: objective.kind,
    targetId: objectiveTargetId(objective),
    targetActionKey,
    suggestedActionKey: directActionAvailable
      ? targetActionKey
      : nextMoveToward(blueprint, state, objectiveTargetLocationId(blueprint, objective), actionCandidates),
  };
}

export type RuntimeLocationCard = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scale: string | null;
};

export type RuntimeItemCard = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
  readonly category: string;
};

/** 已发现事实的安全卡片；未发现事实永远不进入任何角色上下文。 */
export type RuntimeFactCard = {
  readonly id: string;
  readonly text: string;
  readonly source: string;
};

function currentLocationCardOf(blueprint: ScenarioBlueprint, state: GameState): RuntimeLocationCard {
  const location = blueprint.locations.find((entry) => String(entry.id) === String(state.currentLocationId));
  return location === undefined
    ? { id: String(state.currentLocationId), name: "未知地点", description: "", scale: null }
    : {
        id: String(location.id),
        name: location.name,
        description: location.description,
        scale: location.scale ?? null,
      };
}

function availableItemCardsOf(blueprint: ScenarioBlueprint, state: GameState): readonly RuntimeItemCard[] {
  const location = blueprint.locations.find((entry) => String(entry.id) === String(state.currentLocationId));
  if (location === undefined) return [];
  const inventory = state.inventory ?? [];
  return (location.availableItemIds ?? [])
    .filter((itemId) => !inventory.some((ownedId) => String(ownedId) === String(itemId)))
    .flatMap((itemId) => {
      const item = blueprint.items.find((entry) => String(entry.id) === String(itemId));
      return item === undefined ? [] : [{
        id: String(item.id),
        name: item.name,
        description: item.description,
        kind: item.kind,
        category: item.category ?? "unknown",
      }];
    });
}

function discoveredFactCardsOf(blueprint: ScenarioBlueprint, state: GameState): readonly RuntimeFactCard[] {
  return state.worldFacts
    .filter((factState) => factState.discovered)
    .flatMap((factState) => {
      const fact = blueprint.world.facts.find((entry) => String(entry.id) === String(factState.factId));
      return fact === undefined ? [] : [{
        id: String(fact.id),
        text: fact.text,
        source: fact.source,
      }];
    });
}

/** 单条里程碑 → 安全中文短句（不泄漏原始 ID、对白、事实原文、pacing 枚举）。 */
function continuityMilestoneText(
  entry: StoryMemoryEntry,
  blueprint: ScenarioBlueprint,
  state: GameState,
): string {
  switch (entry.kind) {
    case "location": return `到访${locationNameOf(blueprint, entry.locationId)}`;
    case "npc": return `初会${npcNameOf(blueprint, entry.npcId)}`;
    case "fact": return `线索：${discoveredFactText(blueprint, state, String(entry.factId))}`;
    case "quest":
      return `任务「${questNameOf(blueprint, entry.questId)}」${entry.status === "completed" ? "完成" : entry.status === "failed" ? "失败" : "解锁"}`;
    case "item": return `取得${itemNameOf(blueprint, entry.itemId)}`;
    case "battle":
      return `${entry.outcome === "victory" ? "战胜" : entry.outcome === "defeat" ? "败于" : "撤离"}${enemyNameOf(blueprint, entry.enemyId)}`;
    case "scene":
      return entry.focusNpcId === null
        ? "上一幕展开"
        : `上一幕与${npcNameOf(blueprint, entry.focusNpcId)}交涉`;
  }
}

/** 最近 6 条里程碑的安全文本（director/writer 共用）。 */
function projectRecentContinuity(
  state: GameState,
  blueprint: ScenarioBlueprint,
  limit: number,
): readonly ContinuityMilestone[] {
  return storyMemoryOf(state).recent.slice(-limit).map((entry) => ({
    text: continuityMilestoneText(entry, blueprint, state)
  }));
}

/** 已发现事实才能以文本进入 AI/read-model；损坏 memory 绝不能借此泄漏未发现事实。 */
function discoveredFactText(blueprint: ScenarioBlueprint, state: GameState, factId: string): string {
  const discovered = state.worldFacts.some(
    (entry) => String(entry.factId) === factId && entry.discovered,
  );
  const fact = blueprint.world.facts.find((entry) => String(entry.id) === factId);
  return discovered && fact !== undefined ? fact.text : "一条线索";
}

/** 当前 active 主线/支线任务卡（仅 name + description，不含目标细节或状态机）。 */
function projectActiveQuestCards(blueprint: ScenarioBlueprint, state: GameState): readonly { readonly questId: string; readonly name: string; readonly description: string }[] {
  const active = new Set(state.quests.filter((quest) => quest.status === "active").map((quest) => String(quest.questId)));
  return blueprint.quests
    .filter((entry) => active.has(String(entry.id)))
    .map((entry) => ({ questId: String(entry.id), name: entry.name, description: entry.description }));
}

/** 单个 NPC 的自身连续性：最后接触回合与地点名（不含对白或关系数值）。 */
function projectOwnContinuity(
  state: GameState,
  blueprint: ScenarioBlueprint,
  npcId: string
): { readonly lastContactTurn: number; readonly lastLocationName: string } | null {
  const contact = storyMemoryOf(state).npcContacts.find((entry) => String(entry.npcId) === npcId);
  if (contact === undefined) return null;
  return {
    lastContactTurn: contact.lastContactTurn,
    lastLocationName: locationNameOf(blueprint, contact.lastLocationId)
  };
}

// ---------------------------------------------------------------------------
// 小镇空间语义上下文
// ---------------------------------------------------------------------------

/** 当前地点为就绪 town 时注入的坐标无关空间语义（供 AI 引用位置关系）。 */
export type TownSpatialContext = {
  readonly townName: string;
  /** 确定性方位/邻近句子（如「铁匠铺位于大石镇北侧」）。 */
  readonly sentences: readonly string[];
  readonly buildings: readonly {
    readonly displayName: string;
    readonly area: string;
    readonly buildingType: string;
  }[];
};

/**
 * 当前地点在 state.towns 中已就绪时，投影其语义视图为空间上下文；否则 undefined。
 * 纯坐标无关：只透出方位/邻近句子与具名建筑，绝不含 seed 或几何坐标。
 */
export function toTownSpatialContext(
  blueprint: ScenarioBlueprint,
  state: GameState
): TownSpatialContext | undefined {
  const town = (state.towns ?? []).find(
    (entry) => String(entry.locationId) === String(state.currentLocationId)
  );
  if (town === undefined) return undefined;
  // Phase 14：projectTownLayerView 新增 state 参数（入口过滤对 semanticView 无影响，
  // 但签名要求传入；semanticView 只依赖 snapshot + 镇名，与 interactiveBuildings 无关）。
  const view = projectTownLayerView(blueprint, town, state);
  return {
    townName: view.semanticView.townName,
    sentences: view.semanticView.sentences,
    buildings: view.semanticView.buildings.map((building) => ({
      displayName: building.displayName,
      area: building.area,
      buildingType: building.buildingType
    }))
  };
}

// ---------------------------------------------------------------------------
// 导演上下文
// ---------------------------------------------------------------------------

export type DirectorContext = {
  readonly currentLocationId: string;
  /** 当前地点的安全世界卡，供导演稳定引用地点语义。 */
  readonly currentLocationCard: RuntimeLocationCard;
  /** 当前地点尚未取得的可见物品卡；不代表已执行拾取规则。 */
  readonly availableItemCards: readonly RuntimeItemCard[];
  readonly discoveredFactIds: readonly string[];
  /** 已发现事实的文本卡；与 discoveredFactIds 同源，不包含隐藏事实。 */
  readonly discoveredFactCards: readonly RuntimeFactCard[];
  readonly narrative: { readonly currentScene: GameState["narrative"]["currentScene"] };
  readonly previousScene: PreviousSceneCard | null;
  readonly recentEvents: readonly string[];
  readonly npcIdsPresent: readonly string[];
  readonly actionCandidates: readonly { actionKey: string; kind: string; label: string }[];
  /** Phase 11：当前主线内容推进（阶段、允许的 pacing、active 任务 ID）。 */
  readonly progression: ContentProgression;
  /** Phase 11：当前 active 任务卡（name/description，不含状态机）。 */
  readonly activeQuestCards: readonly { readonly questId: string; readonly name: string; readonly description: string }[];
  /** 当前 active 主线的第一个未满足目标及其合法 action 映射。 */
  readonly activeMainObjective: ActiveMainObjective | null;
  /** Phase 11：最近 12 条里程碑安全文本（不含原始 ID/对白）。 */
  readonly recentContinuity: readonly ContinuityMilestone[];
  /** 当前地点为就绪 town 时的空间语义；小场景地点缺省。 */
  readonly townSpatial?: TownSpatialContext;
  /** 预判非 pacing 项闸门：终幕未激活且未达软/硬上限时为 true。 */
  readonly expansionAllowed: boolean;
  /** locationsSoftMax - 当前地点总数；open 档为 null；下限 0。 */
  readonly remainingLocationBudget: number | null;
  /** Phase 14：主线进度达 endingDirection.lockedAt 且未提议过结局时为 true，导演可提议结局。 */
  readonly endingProposalAllowed: boolean;
  /** Phase 14：结局方向骨架（主题与允许基调），供导演在 endingProposalAllowed 时对齐。 */
  readonly endingDirection: { readonly theme: string; readonly possibleTones: readonly EndingTone[] };
  /** NPC 自由输入触发时的上下文线索：导演独立判断是否采纳，不强制。 */
  readonly playerNpcChat?: PlayerNpcChatState;
  /** 当前生成只服务于这一触发，不再由导演把全部合法动作拼成一幕。 */
  readonly triggerContext?: NarrativeTriggerContext;
};

export type DirectorContextInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
};

export function toDirectorContext(input: DirectorContextInput): DirectorContext {
  const { blueprint, state } = input;

  const discoveredFactIds = state.worldFacts
    .filter((f) => f.discovered)
    .map((f) => String(f.factId));
  const discoveredFactCards = discoveredFactCardsOf(blueprint, state);

  const npcIdsPresent = state.npcs
    .filter((n) => n.locationId === state.currentLocationId)
    .map((n) => String(n.npcId));

  const recentEvents = state.eventLedger
    .filter((evt) => evt.type !== "narrative_scene_presented")
    .slice(-LAST_EVENT_COUNT)
    .map((evt) => evt.type);

  const availableActions = projectAvailableActions(blueprint, state);
  const actionCandidates = availableActions.map((a) => ({
    actionKey: actionKeyOf(a),
    kind: a.type,
    label: a.label,
  }));

  const townSpatial = toTownSpatialContext(blueprint, state);

  const policy = budgetPolicyOf(blueprint);
  const locationCount = blueprint.locations.length;
  const softMax = policy.expansion.locationsSoftMax;
  const hardMax = policy.safety.locationsHardMax;
  const finalAct = policy.mainActs;
  const activeMainQuest = state.quests.find((q) => q.status === "active");
  const mainQuestDefs = blueprint.quests.filter((q) => q.kind === "main");
  const activeMainDef = activeMainQuest !== undefined
    ? mainQuestDefs.find((qd) => qd.id === activeMainQuest.questId)
    : undefined;
  const isEndgame = activeMainDef !== undefined && activeMainDef.stage === finalAct;
  const atHardCap = locationCount >= hardMax;
  const atSoftCap = softMax !== null && locationCount >= softMax;
  const expansionAllowed = !isEndgame && !atHardCap && !atSoftCap;
  const remainingLocationBudget = softMax === null ? null : Math.max(0, softMax - locationCount);

  // NPC 自由输入的上下文只挂在 pending 变体上：场景 ready 后 generation 收窄
  // 回 idle 自动丢弃，不会污染下一轮场景的导演上下文。
  const playerNpcChat =
    state.narrative.generation.status === "pending"
      ? state.narrative.generation.playerNpcChat
      : undefined;

  // Phase 14：主线进度达 endingDirection.lockedAt 且未提议过结局 → 允许导演提议结局。
  // deps.now 未在统计逻辑中读取（纯计数），传确定性空串占位即可。
  // 防御性守卫：旧测试 fixture 或迁移期 state 可能缺 mainStoryProgress/endingDirection，
  // 此时降级为 endingProposalAllowed=false（不提议结局），避免运行时崩溃。
  const hasEndingProgress = state.mainStoryProgress !== undefined && blueprint.endingDirection !== undefined;
  const endingProposalAllowed = hasEndingProgress
    ? reconcileMainStoryProgress(blueprint, state, { now: () => "" }).shouldProposeEnding
    : false;
  const endingDirection = blueprint.endingDirection !== undefined
    ? {
        theme: blueprint.endingDirection.theme,
        possibleTones: blueprint.endingDirection.possibleTones,
      }
    : { theme: "", possibleTones: [] as readonly EndingTone[] };

  const context: DirectorContext = {
    currentLocationId: String(state.currentLocationId),
    currentLocationCard: currentLocationCardOf(blueprint, state),
    availableItemCards: availableItemCardsOf(blueprint, state),
    discoveredFactIds,
    discoveredFactCards,
    narrative: { currentScene: state.narrative.currentScene },
    previousScene: previousSceneCardOf(blueprint, state),
    recentEvents,
    npcIdsPresent,
    actionCandidates,
    progression: deriveContentProgression({ blueprint, state }),
    activeQuestCards: projectActiveQuestCards(blueprint, state),
    activeMainObjective: projectActiveMainObjective(blueprint, state, actionCandidates),
    recentContinuity: projectRecentContinuity(state, blueprint, DIRECTOR_CONTINUITY_LIMIT),
    expansionAllowed,
    remainingLocationBudget,
    endingProposalAllowed,
    endingDirection,
    ...(townSpatial !== undefined ? { townSpatial } : {}),
    ...(playerNpcChat !== undefined ? { playerNpcChat } : {}),
    ...(state.narrative.generation.status === "pending" && state.narrative.generation.triggerContext !== undefined
      ? { triggerContext: state.narrative.generation.triggerContext }
      : {}),
  };

  return context;
}

// ---------------------------------------------------------------------------
// 编剧上下文
// ---------------------------------------------------------------------------

export type SceneScriptContext = {
  readonly currentLocationId: string;
  /** 当前地点的安全世界卡，避免编剧只能看到地点 ID。 */
  readonly currentLocationCard: RuntimeLocationCard;
  /** 当前地点尚未取得的可见物品卡。 */
  readonly availableItemCards: readonly RuntimeItemCard[];
  readonly plan: Record<string, unknown>;
  readonly npcProfile: Record<string, unknown> | null;
  readonly allowedFactCards: readonly Record<string, unknown>[];
  readonly narrative: { readonly currentScene: GameState["narrative"]["currentScene"] };
  readonly previousScene: PreviousSceneCard | null;
  readonly actionCandidates: readonly { actionKey: string; kind: string; label: string }[];
  /** Phase 11：当前主线内容推进与最近 6 条里程碑安全文本。 */
  readonly progression: ContentProgression;
  readonly recentContinuity: readonly ContinuityMilestone[];
  /** 当前地点为就绪 town 时的空间语义；小场景地点缺省。 */
  readonly townSpatial?: TownSpatialContext;
};

export type SceneScriptContextInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly plan: ApprovedDirectorPlan;
};

export function toSceneScriptContext(input: SceneScriptContextInput): SceneScriptContext {
  const { blueprint, state, plan } = input;

  const allowedFactCards = plan.allowedRevealFactIds
    .map((factId) => {
      const def = blueprint.world.facts.find((f) => String(f.id) === factId);
      if (def === undefined) return { id: factId, text: "???", source: "unknown" };
      return { id: String(def.id), text: def.text, source: def.source };
    });

  let npcProfile: Record<string, unknown> | null = null;
  if (plan.focusNpcId !== null) {
    const npcDef = blueprint.npcs.find((n) => String(n.id) === plan.focusNpcId);
    if (npcDef !== undefined) {
      npcProfile = {
        id: String(npcDef.id),
        name: npcDef.name,
        role: npcDef.role,
        // IDs are permission metadata only; fact text still arrives solely via
        // plan-approved allowedFactCards below.
        knownFactIds: npcDef.knownFactIds.map((factId) => String(factId)),
      };
    }
  }

  const availableActions = projectAvailableActions(blueprint, state);
  const actionCandidates = availableActions.map((a) => ({
    actionKey: actionKeyOf(a),
    kind: a.type,
    label: a.label,
  }));

  const townSpatial = toTownSpatialContext(blueprint, state);

  const context: SceneScriptContext = {
    currentLocationId: String(state.currentLocationId),
    currentLocationCard: currentLocationCardOf(blueprint, state),
    availableItemCards: availableItemCardsOf(blueprint, state),
    plan: {
      sceneGoal: plan.sceneGoal,
      tensionLevel: plan.tensionLevel,
      focusNpcId: plan.focusNpcId,
      relevantFactIds: plan.relevantFactIds,
      allowedRevealFactIds: plan.allowedRevealFactIds,
      suggestedActionKeys: plan.suggestedActionKeys,
      ...(plan.eventKind !== undefined ? { eventKind: plan.eventKind } : {}),
      pacing: plan.pacing,
    },
    npcProfile,
    allowedFactCards,
    narrative: { currentScene: state.narrative.currentScene },
    previousScene: previousSceneCardOf(blueprint, state),
    actionCandidates,
    progression: deriveContentProgression({ blueprint, state }),
    recentContinuity: projectRecentContinuity(state, blueprint, WRITER_CONTINUITY_LIMIT),
    ...(townSpatial !== undefined ? { townSpatial } : {}),
  };

  return context;
}

// ---------------------------------------------------------------------------
// 演员上下文
// ---------------------------------------------------------------------------

export type NpcLineContext = {
  readonly npcDefinition: Record<string, unknown>;
  /** 当前场景的规则目标，帮助演员把台词服务于推进而非泛泛聊天。 */
  readonly sceneGoal: string;
  /** 本幕已获导演批准、且规则层确认合法的下一步动作；只提供安全标签。 */
  readonly nextActionCandidates: readonly { actionKey: string; kind: string; label: string }[];
  /** 若存在，表示导演希望 NPC 帮玩家理解的首选行动。 */
  readonly recommendedNextActionKey: string | null;
  /** 玩家公开身份；不包含原始输入或隐藏记忆。 */
  readonly playerName: string;
  /** 演员所在地点的安全语义卡。 */
  readonly currentLocationCard: RuntimeLocationCard;
  readonly previousScene: PreviousSceneCard | null;
  readonly factCards: readonly Record<string, unknown>[];
  /** Phase 11：该 NPC 自身连续性（最后接触回合与地点名），不含对白或关系数值。 */
  readonly ownContinuity: { readonly lastContactTurn: number; readonly lastLocationName: string } | null;
  readonly speechAct: string;
  /** 编剧请求的情绪；演员只能在此意图内表现，输出仍由审批层复核。 */
  readonly requestedEmotion: string;
  readonly mayLie: boolean;
  // Phase 13：NPC 关系值（好感度档位、数值、交互摘要），供演员调整台词语气与态度。
  readonly relationshipTier: string;
  readonly relationshipAffinity: number;
  readonly relationshipSummary: string;
  /** 玩家本轮真正说的话；NPC 演员只能看到当前被寻址的这一轮输入。 */
  readonly playerMessage?: string;
};

export type NpcLineContextInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly npcId: string;
  readonly speechAct: string;
  readonly sceneGoal?: string;
  /** 导演已批准的两个候选；仅与规则层投影的合法动作取交集。 */
  readonly suggestedActionKeys?: readonly string[];
  readonly requestedEmotion?: string;
  readonly allowedFactIds: readonly string[];
  readonly mayLie: boolean;
};

export function toNpcLineContext(input: NpcLineContextInput): NpcLineContext {
  const { blueprint, state, npcId, allowedFactIds } = input;

  const npcDef = blueprint.npcs.find((n) => String(n.id) === npcId);

  const factCards = allowedFactIds
    .map((factId) => {
      const def = blueprint.world.facts.find((f) => String(f.id) === factId);
      if (def === undefined) return { id: factId, text: "???", source: "unknown" };
      return { id: String(def.id), text: def.text, source: def.source };
    });

  const suggestedKeys = new Set(input.suggestedActionKeys ?? []);
  const legalActions = projectAvailableActions(blueprint, state).map((action) => ({
    actionKey: actionKeyOf(action),
    kind: action.type,
    label: action.label,
  }));
  const nextActionCandidates = legalActions.filter((action) => suggestedKeys.has(action.actionKey));
  const recommendedNextActionKey = nextActionCandidates[0]?.actionKey ?? null;

  // Phase 13：读取关系值
  const npcState = state.npcs.find((n) => String(n.npcId) === npcId);
  const relationship = npcState?.relationship ?? { affinity: 0 };
  const tier = relationshipTierOf(relationship);
  const summary = projectRelationshipSummary(state, blueprint, npcId);
  const playerMessage = state.narrative.generation.status === "pending" &&
    state.narrative.generation.playerNpcChat?.npcId === npcId
    ? state.narrative.generation.playerNpcChat.playerText
    : undefined;

  const context: NpcLineContext = {
    npcDefinition: npcDef !== undefined
      ? {
          id: String(npcDef.id),
          name: npcDef.name,
          role: npcDef.role,
          description: npcDef.description ?? "",
          // Deliberately omit the NPC's full known-fact list.  The performer
          // receives only the fact cards approved for this exact line.
        }
      : { id: npcId, name: "???", role: "unknown" },
    sceneGoal: input.sceneGoal ?? "推进当前场景目标",
    nextActionCandidates,
    recommendedNextActionKey,
    playerName: blueprint.player.name,
    currentLocationCard: currentLocationCardOf(blueprint, state),
    previousScene: previousSceneCardOf(blueprint, state),
    factCards,
    ownContinuity: projectOwnContinuity(state, blueprint, npcId),
    speechAct: input.speechAct,
    requestedEmotion: input.requestedEmotion ?? "neutral",
    mayLie: input.mayLie,
    // Phase 13：
    relationshipTier: tier,
    relationshipAffinity: relationship.affinity,
    relationshipSummary: summary,
    ...(playerMessage !== undefined ? { playerMessage } : {}),
  };
  return context;
}
