// ---------------------------------------------------------------------------
// Phase 10 Task 3：三角色最小上下文投影器。
// 每个函数将 domain state → 纯净 context JSON（绝不含 AI prompt 原文、密钥）。
// ---------------------------------------------------------------------------

import { budgetPolicyOf, storyMemoryOf, type GameState, type ScenarioBlueprint, type StoryMemoryEntry } from "@/game/domain";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import { actionKeyOf, deriveContentProgression, type ContentProgression } from "@/game/gameplay/rpg/narrative";
import type { ApprovedDirectorPlan } from "@/game/gameplay/rpg/narrative";
import { projectTownLayerView } from "./townRuntimeView";

const LAST_EVENT_COUNT = 5;
const DIRECTOR_CONTINUITY_LIMIT = 12;
const WRITER_CONTINUITY_LIMIT = 6;

// ---------------------------------------------------------------------------
// Phase 11 连续性投影：把结构化里程碑映射为安全文本（仅具名实体，不含原始 ID/对白/事实原文）。
// ---------------------------------------------------------------------------

type ContinuityMilestone = { readonly text: string };

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
    case "scene": return "新的一幕展开";
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
  const view = projectTownLayerView(blueprint, town);
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
  readonly discoveredFactIds: readonly string[];
  readonly narrative: { readonly currentScene: GameState["narrative"]["currentScene"] };
  readonly recentEvents: readonly string[];
  readonly npcIdsPresent: readonly string[];
  readonly actionCandidates: readonly { actionKey: string; kind: string; label: string }[];
  /** Phase 11：当前主线内容推进（阶段、允许的 pacing、active 任务 ID）。 */
  readonly progression: ContentProgression;
  /** Phase 11：当前 active 任务卡（name/description，不含状态机）。 */
  readonly activeQuestCards: readonly { readonly questId: string; readonly name: string; readonly description: string }[];
  /** Phase 11：最近 12 条里程碑安全文本（不含原始 ID/对白）。 */
  readonly recentContinuity: readonly ContinuityMilestone[];
  /** 当前地点为就绪 town 时的空间语义；小场景地点缺省。 */
  readonly townSpatial?: TownSpatialContext;
  /** 预判非 pacing 项闸门：终幕未激活且未达软/硬上限时为 true。 */
  readonly expansionAllowed: boolean;
  /** locationsSoftMax - 当前地点总数；open 档为 null；下限 0。 */
  readonly remainingLocationBudget: number | null;
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

  const context: DirectorContext = {
    currentLocationId: String(state.currentLocationId),
    discoveredFactIds,
    narrative: { currentScene: state.narrative.currentScene },
    recentEvents,
    npcIdsPresent,
    actionCandidates,
    progression: deriveContentProgression({ blueprint, state }),
    activeQuestCards: projectActiveQuestCards(blueprint, state),
    recentContinuity: projectRecentContinuity(state, blueprint, DIRECTOR_CONTINUITY_LIMIT),
    expansionAllowed,
    remainingLocationBudget,
    ...(townSpatial !== undefined ? { townSpatial } : {}),
  };

  return context;
}

// ---------------------------------------------------------------------------
// 编剧上下文
// ---------------------------------------------------------------------------

export type SceneScriptContext = {
  readonly currentLocationId: string;
  readonly plan: Record<string, unknown>;
  readonly npcProfile: Record<string, unknown> | null;
  readonly allowedFactCards: readonly Record<string, unknown>[];
  readonly narrative: { readonly currentScene: GameState["narrative"]["currentScene"] };
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
        // Facts are intentionally absent here. The writer may receive text only
        // through plan-approved allowedFactCards below.
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
    plan: {
      sceneGoal: plan.sceneGoal,
      tensionLevel: plan.tensionLevel,
      focusNpcId: plan.focusNpcId,
      allowedRevealFactIds: plan.allowedRevealFactIds,
      suggestedActionKeys: plan.suggestedActionKeys,
      pacing: plan.pacing,
    },
    npcProfile,
    allowedFactCards,
    narrative: { currentScene: state.narrative.currentScene },
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
  readonly factCards: readonly Record<string, unknown>[];
  /** Phase 11：该 NPC 自身连续性（最后接触回合与地点名），不含对白或关系数值。 */
  readonly ownContinuity: { readonly lastContactTurn: number; readonly lastLocationName: string } | null;
  readonly speechAct: string;
  readonly mayLie: boolean;
};

export type NpcLineContextInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly npcId: string;
  readonly speechAct: string;
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

  const context: NpcLineContext = {
    npcDefinition: npcDef !== undefined
      ? {
          id: String(npcDef.id),
          name: npcDef.name,
          role: npcDef.role,
          // Deliberately omit the NPC's full known-fact list.  The performer
          // receives only the fact cards approved for this exact line.
        }
      : { id: npcId, name: "???", role: "unknown" },
    factCards,
    ownContinuity: projectOwnContinuity(state, blueprint, npcId),
    speechAct: input.speechAct,
    mayLie: input.mayLie,
  };

  return context;
}
