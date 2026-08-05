// ---------------------------------------------------------------------------
// Phase 10 Task 4：运行时叙事编排器。
// 串联三角色 source → approve → 组装 NarrativeSceneState。
// 只返回结构化结果，不写入 repository。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint, NarrativeSceneState, NpcDialogueInScene, NpcId, FactId, StoryPacing } from "@/game/domain";
import { paginateSpeechText } from "@/game/domain";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import type { NarrativeActionCandidate, NpcInstruction, ApprovedDirectorPlan, ApprovedSceneScript, BlueprintExpansionDecision } from "@/game/gameplay/rpg/narrative";
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
  type NpcLineContext,
} from "./runtimeNarrativeContexts";
import {
  FALLBACK_SCENE_SCRIPT,
} from "./internal/runtimeNarrativeFallbacks";
import { SPEECH_PAGE_CHAR_BUDGET } from "./locationAdventureView";

const MAX_ROLE_ATTEMPTS = 3;

function resolveRoleAttemptLimit(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 1 && value <= MAX_ROLE_ATTEMPTS
    ? value
    : MAX_ROLE_ATTEMPTS;
}

function resolveRetryBackoffMs(value: number | undefined): number {
  return Number.isInteger(value) && value !== undefined && value >= 0 && value <= 5_000 ? value : 0;
}

async function waitBeforeRoleRetry(backoffMs: number, attemptIndex: number, maxAttempts: number): Promise<void> {
  if (backoffMs === 0 || attemptIndex >= maxAttempts - 1) return;
  const delayMs = Math.min(backoffMs * (2 ** attemptIndex), 5_000);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Phase 14：调用演员 source 并按 maxRoleAttempts 重试，返回批准后的对白文本。
 * 复用焦点 NPC 的审批路径与重试退避策略；失败返回 null（不阻塞场景组装）。
 * 仅用于非焦点 NPC 的对白生成——焦点 NPC 的对白仍走原有路径以保留 npcLine 结构。
 */
async function generateNpcLineTextWithRetry(args: {
  readonly traceId: string;
  readonly npcLineSource: NpcLineSource;
  readonly npcLineContext: NpcLineContext;
  readonly allowedFactIds: readonly string[];
  readonly unresolvedItemNames: readonly string[];
  readonly maxRoleAttempts: number;
  readonly retryBackoffMs: number;
  readonly approvalObserver?: (event: StoryEvalApprovalEvent) => void;
}): Promise<string | null> {
  for (let attemptIndex = 0; attemptIndex < args.maxRoleAttempts; attemptIndex += 1) {
    try {
      const attempt = await args.npcLineSource.generate({
        traceId: `${args.traceId}${"-retry".repeat(attemptIndex)}`,
        context: attemptIndex === 0
          ? args.npcLineContext as unknown as Record<string, unknown>
          : { ...(args.npcLineContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return one complete JSON object using only the supplied fact cards." },
      });
      if (!attempt.ok) {
        await waitBeforeRoleRetry(args.retryBackoffMs, attemptIndex, args.maxRoleAttempts);
        continue;
      }
      const approved = approveNpcPerformance({
        proposal: attempt.performance,
        allowedFactIds: args.allowedFactIds,
        unresolvedItemNames: args.unresolvedItemNames,
      });
      args.approvalObserver?.({ kind: "role_approval", traceId: args.traceId, role: "npc", attempt: attemptIndex + 1, category: approved.ok ? null : approved.category });
      if (!approved.ok) continue;
      return approved.value.text;
    } catch { /* bounded same-role retry */ }
  }
  return null;
}

/**
 * Phase 14：收集场景内所有在场 NPC 的对白分页。
 * - 焦点 NPC（script.npcInstruction.npcId）：复用已批准的 npcLine.text 分页。
 * - 非焦点 NPC：若 additionalNpcInstructions 含其指令，调用演员生成；否则仅记录在场（speechPages=[]）。
 * 在场 NPC 列表来自 state.npcs 中位于当前地点的 NPC，与 projectDialogues 口径一致。
 */
async function collectNpcDialogues(args: {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly script: ApprovedSceneScript;
  readonly npcLine: NarrativeSceneState["npcLine"];
  readonly npcLineSource: NpcLineSource;
  readonly plan: ApprovedDirectorPlan;
  readonly traceId: string;
  readonly unresolvedItemNames: readonly string[];
  readonly maxRoleAttempts: number;
  readonly retryBackoffMs: number;
  readonly approvalObserver?: (event: StoryEvalApprovalEvent) => void;
  readonly onNpcLineAttempted: () => void;
}): Promise<readonly NpcDialogueInScene[]> {
  const presentNpcIds = args.state.npcs
    .filter((n) => String(n.locationId) === String(args.state.currentLocationId))
    .map((n) => n.npcId);
  const focusNpcId = args.script.npcInstruction?.npcId ?? null;
  const dialogues: NpcDialogueInScene[] = [];

  for (const npcId of presentNpcIds) {
    const npc = args.blueprint.npcs.find((n) => String(n.id) === String(npcId));
    if (npc === undefined) continue;
    const isFocusNpc = focusNpcId !== null && String(focusNpcId) === String(npcId);

    // 焦点 NPC：复用已批准的 npcLine（可能为 null 当 npcInstruction 为 null）
    if (isFocusNpc && args.npcLine !== null) {
      dialogues.push({
        npcId,
        npcName: npc.name,
        npcRole: npc.role,
        speechPages: paginateSpeechText(args.npcLine.text, SPEECH_PAGE_CHAR_BUDGET),
      });
      continue;
    }

    // 非焦点 NPC：查找 additionalNpcInstructions；缺失则仅记录在场
    const instruction: NpcInstruction | undefined = args.script.additionalNpcInstructions
      ?.find((i) => String(i.npcId) === String(npcId));
    if (instruction === undefined) {
      dialogues.push({
        npcId,
        npcName: npc.name,
        npcRole: npc.role,
        speechPages: [],
      });
      continue;
    }

    const npcLineContext = toNpcLineContext({
      blueprint: args.blueprint,
      state: args.state,
      npcId: String(npcId),
      speechAct: instruction.speechAct,
      sceneGoal: args.plan.sceneGoal,
      suggestedActionKeys: args.plan.suggestedActionKeys,
      requestedEmotion: instruction.emotion,
      allowedFactIds: instruction.allowedFactIds,
      mayLie: instruction.mayLie,
    });
    args.onNpcLineAttempted();
    const text = await generateNpcLineTextWithRetry({
      traceId: `${args.traceId}-npcLine-${String(npcId)}`,
      npcLineSource: args.npcLineSource,
      npcLineContext,
      allowedFactIds: instruction.allowedFactIds,
      unresolvedItemNames: args.unresolvedItemNames,
      maxRoleAttempts: args.maxRoleAttempts,
      retryBackoffMs: args.retryBackoffMs,
      approvalObserver: args.approvalObserver,
    });
    dialogues.push({
      npcId,
      npcName: npc.name,
      npcRole: npc.role,
      speechPages: text !== null ? paginateSpeechText(text, SPEECH_PAGE_CHAR_BUDGET) : [],
    });
  }
  return dialogues;
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
  /** 评估专用 provider 失败退避；未传时保持正常运行时零额外等待。 */
  readonly retryBackoffMs?: number;
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
  const retryBackoffMs = resolveRetryBackoffMs(input.retryBackoffMs);

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
    } catch {
      await waitBeforeRoleRetry(retryBackoffMs, attempt, maxRoleAttempts);
      continue;
    }
    if (!directorAttempt.ok) {
      await waitBeforeRoleRetry(retryBackoffMs, attempt, maxRoleAttempts);
      continue;
    }
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
  if (plan === undefined) {
    const objective = directorContext.activeMainObjective;
    return buildFallbackResult(
      traceId,
      directorAttempt,
      null,
      false,
      candidates,
      state,
      fallbackPacing,
      undefined,
      [objective?.suggestedActionKey, objective?.targetActionKey].filter((key): key is string => typeof key === "string"),
    );
  }

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
    } catch {
      await waitBeforeRoleRetry(retryBackoffMs, attempt, maxRoleAttempts);
      continue;
    }
    if (!scriptAttempt.ok) {
      await waitBeforeRoleRetry(retryBackoffMs, attempt, maxRoleAttempts);
      continue;
    }
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
  if (script === undefined || scriptAttempt === null) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, false, candidates, state, fallbackPacing, plan);

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
      suggestedActionKeys: plan.suggestedActionKeys,
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
        if (!attempt.ok) {
          await waitBeforeRoleRetry(retryBackoffMs, attemptIndex, maxRoleAttempts);
          continue;
        }
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
  if (!npcApproved) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, npcLineAttempted, candidates, state, fallbackPacing, plan);

  // Phase 14：为场景内每个在场 NPC 收集对白分页——焦点 NPC 复用已批准的 npcLine，
  // 非焦点 NPC 在编剧提供 additionalNpcInstructions 时单独调用演员；无指令的在场
  // NPC 仅记录为在场（speechPages 为空）。失败不阻塞场景组装（speechPages 为空）。
  const npcDialogues = await collectNpcDialogues({
    blueprint,
    state,
    script,
    npcLine,
    npcLineSource,
    plan,
    traceId,
    unresolvedItemNames,
    maxRoleAttempts,
    retryBackoffMs,
    approvalObserver: input.approvalObserver,
    onNpcLineAttempted: () => { npcLineAttempted = true; },
  });

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
    npcDialogues,
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
  pacing: StoryPacing,
  approvedPlan: ApprovedDirectorPlan | undefined,
  preferredActionKeys: readonly string[] = [],
): OrchestrateSceneResult {
  // 当导演计划已通过、但编剧或演员失败时，仍保留计划中的合法行动顺序。
  // 旧逻辑直接取 candidates 前两项，可能把主线目标挤出 fallback 选项，
  // 造成一次 provider 故障就变成“看/闲聊”而不是继续推进主线。
  const candidateByKey = new Map(candidates.map((candidate) => [candidate.actionKey, candidate]));
  const orderedCandidates: NarrativeActionCandidate[] = [];
  for (const actionKey of approvedPlan?.suggestedActionKeys ?? preferredActionKeys) {
    const candidate = candidateByKey.get(actionKey);
    if (candidate !== undefined && !orderedCandidates.some((entry) => entry.actionKey === candidate.actionKey)) {
      orderedCandidates.push(candidate);
    }
  }
  for (const candidate of candidates) {
    if (!orderedCandidates.some((entry) => entry.actionKey === candidate.actionKey)) orderedCandidates.push(candidate);
    if (orderedCandidates.length >= 2) break;
  }
  const fallbackCandidates = orderedCandidates.length >= 2 ? orderedCandidates : candidates;
  const fallbackScene: NarrativeSceneState = {
    sceneId: `${traceId}-fallback-${Date.now()}`,
    turn: calculateTurn(state),
    narration: FALLBACK_SCENE_SCRIPT.narration,
    usedFactIds: [] as unknown as NarrativeSceneState["usedFactIds"],
    npcLine: null,
    choices: [
      {
        choiceToken: `${traceId}-fallback:a`,
        label: fallbackCandidates[0]?.publicLabel ?? FALLBACK_SCENE_SCRIPT.choices[0].label,
        actionKey: fallbackCandidates[0]?.actionKey ?? FALLBACK_SCENE_SCRIPT.choices[0].actionKey,
      },
      {
        choiceToken: `${traceId}-fallback:b`,
        label: fallbackCandidates[1]?.publicLabel ?? FALLBACK_SCENE_SCRIPT.choices[1].label,
        actionKey: fallbackCandidates[1]?.actionKey ?? FALLBACK_SCENE_SCRIPT.choices[1].actionKey,
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
