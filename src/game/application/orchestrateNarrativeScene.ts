// ---------------------------------------------------------------------------
// Phase 10 Task 4：运行时叙事编排器。
// 串联三角色 source → approve → 组装 NarrativeSceneState。
// 只返回结构化结果，不写入 repository。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint, NarrativeSceneState, NpcId, FactId, StoryPacing } from "@/game/domain";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import type { NarrativeActionCandidate, ApprovedDirectorPlan, ApprovedSceneScript, BlueprintExpansionDecision } from "@/game/gameplay/rpg/narrative";
import {
  approveDirectorProposal,
  approveSceneScript,
  approveNpcPerformance,
  approveBlueprintExpansion,
  actionKeyOf,
  deriveContentProgression,
} from "@/game/gameplay/rpg/narrative";
import { projectAvailableActions } from "@/game/gameplay/rpg/actions";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type SceneScriptSource, type NpcLineSource, type DirectorAttempt, type SceneScriptAttempt } from "./runtimeNarrative";
import type { StoryEvalApprovalEvent } from "./storyEvalCaptureTypes";
import {
  toDirectorContext,
  toSceneScriptContext,
  toNpcLineContext,
} from "./runtimeNarrativeContexts";
import {
  FALLBACK_SCENE_SCRIPT,
} from "./internal/runtimeNarrativeFallbacks";

const MAX_ROLE_ATTEMPTS = 3;

function resolveRoleAttemptLimit(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 1 && value <= MAX_ROLE_ATTEMPTS
    ? value
    : MAX_ROLE_ATTEMPTS;
}

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
  /** Task 5：审批观察回调——审批结果与已批准导演计划只在本层可见，仅此处可发出。 */
  readonly approvalObserver?: (event: StoryEvalApprovalEvent) => void;
  /** 评估专用重试上限；未传时保持正常运行时的三次尝试。 */
  readonly maxRoleAttempts?: number;
};

export type OrchestrateSceneResult = {
  readonly scene: NarrativeSceneState;
  readonly provenance: "generated" | "fixture" | "fallback";
  /** Phase 11：本场景的节奏标签——生成场景取自导演受批准的 plan.pacing；fallback 取阶段派生值。 */
  readonly pacing: StoryPacing;
  /** 已批准 director plan 的焦点 NPC；不能从可选台词结果反推。 */
  readonly focusNpcId: NpcId | null;
  /** 蓝图动态化：本幕扩展提案的纯语义审批结果；fallback 固定 none_proposed。 */
  readonly expansionDecision: BlueprintExpansionDecision;
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
  const maxRoleAttempts = resolveRoleAttemptLimit(input.maxRoleAttempts);

  // 构建 action candidates
  const availableActions = projectAvailableActions(blueprint, state);
  const candidates: NarrativeActionCandidate[] = availableActions.map((a) => ({
    actionKey: actionKeyOf(a),
    kind: a.type,
    publicLabel: a.label,
  }));
  // Phase 11：fallback 场景无导演声明的 pacing，按当前主线阶段派生一个受控值
  // （生成场景则取导演受批准的 plan.pacing）。
  const fallbackPacing = deriveContentProgression({ blueprint, state }).allowedPacing.at(-1) ?? "setup";

  // Step 1：投影导演上下文 → 调用导演 source
  const directorContext = toDirectorContext({ blueprint, state });
  let directorAttempt: DirectorAttempt = unavailableDirectorAttempt(traceId);
  let plan: ApprovedDirectorPlan | undefined;
  let continuityViolationLogged = false;
  for (let attempt = 0; attempt < maxRoleAttempts; attempt += 1) {
    try {
      directorAttempt = await directorSource.generate({
        traceId: `${traceId}-director${"-retry".repeat(attempt)}`,
        context: attempt === 0
          ? directorContext as unknown as Record<string, unknown>
          : { ...(directorContext as unknown as Record<string, unknown>), retryInstruction: "Previous proposal was rejected. Return a complete proposal using only the exact IDs and action keys supplied." },
      });
    } catch { continue; }
    if (!directorAttempt.ok) continue;
    const approval = approveDirectorProposal({ proposal: directorAttempt.plan, blueprint, state, candidates });
    input.approvalObserver?.({ kind: "role_approval", traceId, role: "director", attempt: attempt + 1, category: approval.ok ? null : approval.category });
    if (approval.ok) {
      plan = approval.value;
      input.approvalObserver?.({ kind: "plan_approved", traceId, attempt: attempt + 1, planSummary: approval.value as unknown as Record<string, unknown> });
      break;
    }
    // Phase 11：同场景内 pacing continuity_violation 至多告警一次（重试不重复）。
    if (approval.category === "continuity_violation") {
      if (!continuityViolationLogged) {
        continuityViolationLogged = true;
        logger.warn("runtime_narrative_approval", { traceId, role: "director", category: approval.category });
      }
    } else {
      logger.warn("runtime_narrative_approval", { traceId, role: "director", category: approval.category });
    }
  }
  if (plan === undefined) return buildFallbackResult(traceId, directorAttempt, null, false, candidates, state, fallbackPacing);

  // Step 3：投影编剧上下文 → 调用编剧 source
  const sceneScriptContext = toSceneScriptContext({ blueprint, state, plan });
  const currentLocation = blueprint.locations.find((location) => String(location.id) === String(state.currentLocationId));
  const inventory = new Set((state.inventory ?? []).map(String));
  const unresolvedItemNames = currentLocation === undefined
    ? []
    : (currentLocation.availableItemIds ?? []).flatMap((itemId) => {
        if (inventory.has(String(itemId))) return [];
        const item = blueprint.items.find((entry) => String(entry.id) === String(itemId));
        return item === undefined ? [] : [item.name];
      });
  let scriptAttempt: SceneScriptAttempt | null = null;
  let script: ApprovedSceneScript | undefined;
  for (let attempt = 0; attempt < maxRoleAttempts; attempt += 1) {
    try {
      scriptAttempt = await sceneScriptSource.generate({
        traceId: `${traceId}-script${"-retry".repeat(attempt)}`,
        context: attempt === 0 ? sceneScriptContext as unknown as Record<string, unknown> : { ...(sceneScriptContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return a complete JSON object with exactly the required fields, two choices, and only supplied IDs." },
      });
    } catch { continue; }
    if (!scriptAttempt.ok) continue;
    const approval = approveSceneScript({
      proposal: scriptAttempt.script,
      plan,
      blueprint,
      unresolvedItemNames,
    });
    input.approvalObserver?.({ kind: "role_approval", traceId, role: "writer", attempt: attempt + 1, category: approval.ok ? null : approval.category });
    if (approval.ok) { script = approval.value; break; }
    logger.warn("runtime_narrative_approval", { traceId, role: "writer", category: approval.category });
  }
  if (script === undefined || scriptAttempt === null) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, false, candidates, state, fallbackPacing);

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
      sceneGoal: plan.sceneGoal,
      requestedEmotion: npcInst.emotion,
      allowedFactIds: npcInst.allowedFactIds,
      mayLie: npcInst.mayLie,
    });

    for (let attemptIndex = 0; attemptIndex < maxRoleAttempts; attemptIndex += 1) {
      try {
        const attempt = await npcLineSource.generate({
          traceId: `${traceId}-npcLine${"-retry".repeat(attemptIndex)}`,
          context: attemptIndex === 0 ? npcLineContext as unknown as Record<string, unknown> : { ...(npcLineContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return one complete JSON object using only the supplied fact cards." },
        });
        npcLineAttempted = true;
        if (!attempt.ok) continue;
        const approved = approveNpcPerformance({
          proposal: attempt.performance,
          allowedFactIds: npcInst.allowedFactIds,
          unresolvedItemNames,
        });
        input.approvalObserver?.({ kind: "role_approval", traceId, role: "npc", attempt: attemptIndex + 1, category: approved.ok ? null : approved.category });
        if (!approved.ok) continue;
        npcLine = { npcId: npcInst.npcId as NpcId, text: approved.value.text, emotion: approved.value.emotion, usedFactIds: approved.value.usedFactIds as readonly FactId[] };
        npcApproved = true;
        break;
      } catch { /* bounded same-role retry, then full fallback */ }
    }
  }
  if (!npcApproved) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, npcLineAttempted, candidates, state, fallbackPacing);

  // Step 6：组装 NarrativeSceneState
  const expansionDecision = approveBlueprintExpansion({ blueprint, state, plan });
  input.approvalObserver?.({ kind: "expansion_decision", traceId, decision: expansionDecision });
  const scene: NarrativeSceneState = {
    sceneId: `${traceId}-scene-${Date.now()}`,
    turn: calculateTurn(state),
    narration: script.narration,
    usedFactIds: script.usedFactIds as unknown as NarrativeSceneState["usedFactIds"],
    npcLine,
    choices: script.choices.map((choice, index) => {
      // AI may phrase a choice attractively, but only the rule candidate knows
      // what its actionKey actually does. Persisting that candidate label keeps
      // a move from being presented as an observe (and vice versa).
      const candidate = candidates.find((entry) => entry.actionKey === choice.actionKey);
      if (candidate === undefined) throw new Error("approved action candidate disappeared");
      return {
        choiceToken: `${traceId}-choice:${index}`,
        label: candidate.publicLabel,
        actionKey: choice.actionKey,
      };
    }) as unknown as NarrativeSceneState["choices"],
    source: "generated",
  };

  return {
    scene,
    provenance: scriptAttempt.provenance === "fixture" ? "fixture" : "generated",
    pacing: plan.pacing,
    focusNpcId: plan.focusNpcId as NpcId | null,
    expansionDecision,
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
  state: GameState,
  pacing: StoryPacing
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
    pacing,
    focusNpcId: null,
    expansionDecision: { ok: false, reason: "none_proposed" },
    diagnostics: {
      director: directorAttempt,
      script: scriptAttempt,
      npcLineAttempted,
    },
  };
}

function unavailableDirectorAttempt(traceId: string): DirectorAttempt {
  return { ok: false, provenance: "unavailable", category: "service_error", diagnostics: { traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed", category: "service_error" } };
}

function calculateTurn(state: GameState): number {
  return Math.max(0, state.eventLedger.length - 1);
}
