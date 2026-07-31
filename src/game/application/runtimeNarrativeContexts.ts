// ---------------------------------------------------------------------------
// Phase 10 Task 3：三角色最小上下文投影器。
// 每个函数将 domain state → 纯净 context JSON（绝不含 AI prompt 原文、密钥）。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import { actionKeyOf } from "@/game/gameplay/rpg/narrative";
import type { ApprovedDirectorPlan } from "@/game/gameplay/rpg/narrative";
import { projectTownLayerView } from "./townRuntimeView";

const LAST_EVENT_COUNT = 5;

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
  /** 当前地点为就绪 town 时的空间语义；小场景地点缺省。 */
  readonly townSpatial?: TownSpatialContext;
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

  const context: DirectorContext = {
    currentLocationId: String(state.currentLocationId),
    discoveredFactIds,
    narrative: { currentScene: state.narrative.currentScene },
    recentEvents,
    npcIdsPresent,
    actionCandidates,
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
        knownFactTexts: npcDef.knownFactIds.map((fid) => {
          const f = blueprint.world.facts.find((wf) => wf.id === fid);
          return f?.text ?? "???";
        }),
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
  readonly recentEvents: readonly string[];
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

  const recentEvents = state.eventLedger
    .filter((evt) => evt.type !== "narrative_scene_presented")
    .slice(-LAST_EVENT_COUNT)
    .map((evt) => evt.type);

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
    recentEvents,
    speechAct: input.speechAct,
    mayLie: input.mayLie,
  };

  return context;
}
