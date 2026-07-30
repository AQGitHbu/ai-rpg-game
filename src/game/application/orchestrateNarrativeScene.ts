// ---------------------------------------------------------------------------
// Phase 10 Task 4：运行时叙事编排器。
// 串联三角色 source → approve → 组装 NarrativeSceneState。
// 只返回结构化结果，不写入 repository。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint, NarrativeSceneState } from "@/game/domain";
import type { NarrativeActionCandidate } from "@/game/gameplay/rpg/narrative";
import {
  approveDirectorProposal,
  approveSceneScript,
  actionKeyOf,
} from "@/game/gameplay/rpg/narrative";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import type {
  DirectorSource,
  SceneScriptSource,
  NpcLineSource,
  DirectorAttempt,
  SceneScriptAttempt,
} from "./runtimeNarrative";
import {
  toDirectorContext,
  toSceneScriptContext,
  toNpcLineContext,
} from "./runtimeNarrativeContexts";
import {
  FALLBACK_DIRECTOR_PLAN,
  FALLBACK_SCENE_SCRIPT,
} from "./internal/runtimeNarrativeFallbacks";

// ---------------------------------------------------------------------------
// 输入 / 输出
// ---------------------------------------------------------------------------

export type OrchestrateNarrativeSceneInput = {
  readonly traceId: string;
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly directorSource: DirectorSource;
  readonly sceneScriptSource: SceneScriptSource;
  readonly npcLineSource: NpcLineSource;
};

export type OrchestrateSceneResult = {
  readonly scene: NarrativeSceneState;
  readonly provenance: "generated" | "fixture" | "fallback";
  readonly diagnostics: {
    readonly director: DirectorAttempt;
    readonly script: SceneScriptAttempt | null;
    readonly npcLineAttempted: boolean;
  };
};

// ---------------------------------------------------------------------------
// 编排主函数
// ---------------------------------------------------------------------------

export async function orchestrateNarrativeScene(
  input: OrchestrateNarrativeSceneInput
): Promise<OrchestrateSceneResult> {
  const { traceId, blueprint, state, directorSource, sceneScriptSource, npcLineSource } = input;

  // 构建 action candidates
  const availableActions = projectAvailableActions(blueprint, state);
  const candidates: NarrativeActionCandidate[] = availableActions.map((a) => ({
    actionKey: actionKeyOf(a),
    kind: a.type,
    publicLabel: a.label,
  }));

  // Step 1：投影导演上下文 → 调用导演 source
  const directorContext = toDirectorContext({ blueprint, state });
  const directorAttempt = await directorSource.generate({
    traceId: `${traceId}-director`,
    context: directorContext as unknown as Record<string, unknown>,
  });

  // Step 2：规则审批导演计划（失败即 fallback）
  if (!directorAttempt.ok) {
    return buildFallbackResult(traceId, directorAttempt, null, false);
  }

  const planApproval = approveDirectorProposal({
    proposal: directorAttempt.plan,
    blueprint,
    state,
    candidates,
  });

  if (!planApproval.ok) {
    return buildFallbackResult(traceId, directorAttempt, null, false);
  }

  const plan = planApproval.value;

  // Step 3：投影编剧上下文 → 调用编剧 source
  const sceneScriptContext = toSceneScriptContext({ blueprint, state, plan });
  const scriptAttempt = await sceneScriptSource.generate({
    traceId: `${traceId}-script`,
    context: sceneScriptContext as unknown as Record<string, unknown>,
  });

  // Step 4：规则审批场景脚本（失败即 fallback）
  if (!scriptAttempt.ok) {
    return buildFallbackResult(traceId, directorAttempt, scriptAttempt, false);
  }

  const scriptApproval = approveSceneScript({
    proposal: scriptAttempt.script,
    plan,
    blueprint,
  });

  if (!scriptApproval.ok) {
    return buildFallbackResult(traceId, directorAttempt, scriptAttempt, false);
  }

  const script = scriptApproval.value;

  // Step 5：演员 NPC 台词（可选，fire-and-forget）
  let npcLineAttempted = false;
  if (script.npcInstruction !== null) {
    const npcInst = script.npcInstruction;
    const npcLineContext = toNpcLineContext({
      blueprint,
      state,
      npcId: npcInst.npcId,
      speechAct: npcInst.speechAct,
      allowedFactIds: npcInst.allowedFactIds,
      mayLie: npcInst.mayLie,
    });

    try {
      await npcLineSource.generate({
        traceId: `${traceId}-npcLine`,
        context: npcLineContext as unknown as Record<string, unknown>,
      });
      npcLineAttempted = true;
    } catch {
      // 演员调用失败不阻断流程
    }
  }

  // Step 6：组装 NarrativeSceneState
  const scene: NarrativeSceneState = {
    sceneId: `${traceId}-scene-${Date.now()}`,
    turn: calculateTurn(state),
    narration: script.narration,
    usedFactIds: script.usedFactIds as unknown as NarrativeSceneState["usedFactIds"],
    npcLine: null,
    choices: script.choices.map((choice, index) => ({
      choiceToken: `${traceId}-choice:${index}`,
      label: choice.label,
      actionKey: choice.actionKey,
    })) as unknown as NarrativeSceneState["choices"],
    source: scriptAttempt.provenance === "fixture" ? "fallback" : "generated",
  };

  return {
    scene,
    provenance: scriptAttempt.provenance === "fixture" ? "fixture" : "generated",
    diagnostics: {
      director: directorAttempt,
      script: scriptAttempt,
      npcLineAttempted,
    },
  };
}

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

function buildFallbackResult(
  traceId: string,
  directorAttempt: DirectorAttempt,
  scriptAttempt: SceneScriptAttempt | null,
  npcLineAttempted: boolean
): OrchestrateSceneResult {
  const fallbackScene: NarrativeSceneState = {
    sceneId: `${traceId}-fallback-${Date.now()}`,
    turn: 0,
    narration: FALLBACK_SCENE_SCRIPT.narration,
    usedFactIds: [] as unknown as NarrativeSceneState["usedFactIds"],
    npcLine: null,
    choices: [
      {
        choiceToken: `${traceId}-fallback:a`,
        label: FALLBACK_SCENE_SCRIPT.choices[0].label,
        actionKey: FALLBACK_SCENE_SCRIPT.choices[0].actionKey,
      },
      {
        choiceToken: `${traceId}-fallback:b`,
        label: FALLBACK_SCENE_SCRIPT.choices[1].label,
        actionKey: FALLBACK_SCENE_SCRIPT.choices[1].actionKey,
      },
    ],
    source: "fallback",
  };

  return {
    scene: fallbackScene,
    provenance: "fallback",
    diagnostics: {
      director: directorAttempt,
      script: scriptAttempt,
      npcLineAttempted,
    },
  };
}

function calculateTurn(state: GameState): number {
  return Math.max(0, state.eventLedger.length - 1);
}
