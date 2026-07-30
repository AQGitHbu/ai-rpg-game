// ---------------------------------------------------------------------------
// Phase 10 Task 4：运行时叙事编排器。
// 串联三角色 source → approve → 组装 NarrativeSceneState。
// 只返回结构化结果，不写入 repository。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint, NarrativeSceneState, NpcId, FactId } from "@/game/domain";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import type { NarrativeActionCandidate, ApprovedDirectorPlan, ApprovedSceneScript } from "@/game/gameplay/rpg/narrative";
import {
  approveDirectorProposal,
  approveSceneScript,
  approveNpcPerformance,
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
  FALLBACK_SCENE_SCRIPT,
} from "./internal/runtimeNarrativeFallbacks";

const MAX_ROLE_ATTEMPTS = 3;

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
  readonly logger?: GameLogger;
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
  const logger = input.logger ?? NOOP_GAME_LOGGER;

  // 构建 action candidates
  const availableActions = projectAvailableActions(blueprint, state);
  const candidates: NarrativeActionCandidate[] = availableActions.map((a) => ({
    actionKey: actionKeyOf(a),
    kind: a.type,
    publicLabel: a.label,
  }));

  // Step 1：投影导演上下文 → 调用导演 source
  const directorContext = toDirectorContext({ blueprint, state });
  let directorAttempt: DirectorAttempt = unavailableDirectorAttempt(traceId);
  let plan: ApprovedDirectorPlan | undefined;
  for (let attempt = 0; attempt < MAX_ROLE_ATTEMPTS; attempt += 1) {
    try {
      directorAttempt = await directorSource.generate({
        traceId: `${traceId}-director${attempt === 0 ? "" : "-retry"}`,
        context: attempt === 0
          ? directorContext as unknown as Record<string, unknown>
          : { ...(directorContext as unknown as Record<string, unknown>), retryInstruction: "Previous proposal was rejected. Return a complete proposal using only the exact IDs and action keys supplied." },
      });
    } catch { continue; }
    if (!directorAttempt.ok) continue;
    const approval = approveDirectorProposal({ proposal: directorAttempt.plan, blueprint, state, candidates });
    if (approval.ok) { plan = approval.value; break; }
    logger.warn("runtime_narrative_approval", { traceId, role: "director", category: approval.category });
  }
  if (plan === undefined) return buildFallbackResult(traceId, directorAttempt, null, false, candidates, state);

  // Step 3：投影编剧上下文 → 调用编剧 source
  const sceneScriptContext = toSceneScriptContext({ blueprint, state, plan });
  let scriptAttempt: SceneScriptAttempt | null = null;
  let script: ApprovedSceneScript | undefined;
  for (let attempt = 0; attempt < MAX_ROLE_ATTEMPTS; attempt += 1) {
    try {
      scriptAttempt = await sceneScriptSource.generate({
        traceId: `${traceId}-script${attempt === 0 ? "" : "-retry"}`,
        context: attempt === 0 ? sceneScriptContext as unknown as Record<string, unknown> : { ...(sceneScriptContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return a complete JSON object with exactly the required fields, two choices, and only supplied IDs." },
      });
    } catch { continue; }
    if (!scriptAttempt.ok) continue;
    const approval = approveSceneScript({ proposal: scriptAttempt.script, plan, blueprint });
    if (approval.ok) { script = approval.value; break; }
    logger.warn("runtime_narrative_approval", { traceId, role: "writer", category: approval.category });
  }
  if (script === undefined || scriptAttempt === null) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, false, candidates, state);

  // Step 5：演员只能收到该 NPC 获批准的事实卡；其输出也必须复核。
  let npcLineAttempted = false;
  let npcLine: NarrativeSceneState["npcLine"] = null;
  let npcApproved = script.npcInstruction === null;
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

    for (let attemptIndex = 0; attemptIndex < MAX_ROLE_ATTEMPTS; attemptIndex += 1) {
      try {
        const attempt = await npcLineSource.generate({
          traceId: `${traceId}-npcLine${attemptIndex === 0 ? "" : "-retry"}`,
          context: attemptIndex === 0 ? npcLineContext as unknown as Record<string, unknown> : { ...(npcLineContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return one complete JSON object using only the supplied fact cards." },
        });
        npcLineAttempted = true;
        if (!attempt.ok) continue;
        const approved = approveNpcPerformance({ proposal: attempt.performance, allowedFactIds: npcInst.allowedFactIds });
        if (!approved.ok) continue;
        npcLine = { npcId: npcInst.npcId as NpcId, text: approved.value.text, emotion: approved.value.emotion, usedFactIds: approved.value.usedFactIds as readonly FactId[] };
        npcApproved = true;
        break;
      } catch { /* bounded same-role retry, then full fallback */ }
    }
  }
  if (!npcApproved) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, npcLineAttempted, candidates, state);

  // Step 6：组装 NarrativeSceneState
  const scene: NarrativeSceneState = {
    sceneId: `${traceId}-scene-${Date.now()}`,
    turn: calculateTurn(state),
    narration: script.narration,
    usedFactIds: script.usedFactIds as unknown as NarrativeSceneState["usedFactIds"],
    npcLine,
    choices: script.choices.map((choice, index) => ({
      choiceToken: `${traceId}-choice:${index}`,
      label: choice.label,
      actionKey: choice.actionKey,
    })) as unknown as NarrativeSceneState["choices"],
    source: "generated",
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
  npcLineAttempted: boolean,
  candidates: readonly NarrativeActionCandidate[],
  state: GameState
): OrchestrateSceneResult {
  const fallbackScene: NarrativeSceneState = {
    sceneId: `${traceId}-fallback-${Date.now()}`,
    turn: calculateTurn(state),
    narration: FALLBACK_SCENE_SCRIPT.narration,
    usedFactIds: [] as unknown as NarrativeSceneState["usedFactIds"],
    npcLine: null,
    choices: [
      {
        choiceToken: `${traceId}-fallback:a`,
        label: candidates[0]?.publicLabel ?? FALLBACK_SCENE_SCRIPT.choices[0].label,
        actionKey: candidates[0]?.actionKey ?? FALLBACK_SCENE_SCRIPT.choices[0].actionKey,
      },
      {
        choiceToken: `${traceId}-fallback:b`,
        label: candidates[1]?.publicLabel ?? FALLBACK_SCENE_SCRIPT.choices[1].label,
        actionKey: candidates[1]?.actionKey ?? FALLBACK_SCENE_SCRIPT.choices[1].actionKey,
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

function unavailableDirectorAttempt(traceId: string): DirectorAttempt {
  return { ok: false, provenance: "unavailable", category: "service_error", diagnostics: { traceId, contractVersion: "runtime-narrative-v1", stage: "failed", category: "service_error" } };
}

function calculateTurn(state: GameState): number {
  return Math.max(0, state.eventLedger.length - 1);
}
