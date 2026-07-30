// ---------------------------------------------------------------------------
// Phase 10 Task 3：三角色最小上下文投影器。
// 每个函数将 domain state → 纯净 context JSON（绝不含 AI prompt 原文、密钥）。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint } from "@/game/domain";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import { actionKeyOf } from "@/game/gameplay/rpg/narrative";
import type { ApprovedDirectorPlan } from "@/game/gameplay/rpg/narrative";

const LAST_EVENT_COUNT = 5;

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
    .slice(-LAST_EVENT_COUNT)
    .map((evt) => evt.type);

  const availableActions = projectAvailableActions(blueprint, state);
  const actionCandidates = availableActions.map((a) => ({
    actionKey: actionKeyOf(a),
    kind: a.type,
    label: a.label,
  }));

  const context: DirectorContext = {
    currentLocationId: String(state.currentLocationId),
    discoveredFactIds,
    narrative: { currentScene: state.narrative.currentScene },
    recentEvents,
    npcIdsPresent,
    actionCandidates,
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
