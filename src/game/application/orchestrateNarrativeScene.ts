// ---------------------------------------------------------------------------
// Phase 10 Task 4：运行时叙事编排器。
// 串联三角色 source → approve → 组装 NarrativeSceneState。
// 只返回结构化结果，不写入 repository。
// ---------------------------------------------------------------------------

import { asEnemyId, asFactId, asItemId, asLocationId, asNpcId, PLAYER_DIALOGUE_RESPONSE_LABELS, type GameState, type ScenarioBlueprint, type NarrativeEventKind, type NarrativeEventState, type NarrativeSceneState, type NarrativeDialogueFollowupState, type NpcDialogueInScene, type NpcId, type FactId, type StoryPacing } from "@/game/domain";
import { paginateSpeechText } from "@/game/domain";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import type { NarrativeActionCandidate, NpcInstruction, ApprovedDirectorPlan, ApprovedSceneScript, BlueprintExpansionDecision, EndingApprovalDecision } from "@/game/gameplay/rpg/narrative";
import {
  approveDirectorProposal,
  approveSceneScript,
  approveNpcPerformance,
  approveBlueprintExpansion,
  approveEndingProposal,
  actionKeyOf,
  deriveContentProgression,
} from "@/game/gameplay/rpg/narrative";
import { reconcileMainStoryProgress, type ReconcileQuestsDependencies } from "@/game/gameplay/rpg/quests";
import { composeNpcSpeech, projectAvailableActions } from "@/game/gameplay/rpg/actions";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type SceneScriptSource, type NpcLineSource, type DirectorAttempt, type SceneScriptAttempt, type NarrativeGenerationProgress, type NarrativeRoleStage } from "./runtimeNarrative";
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
/**
 * Normal runtime calls keep the 120s provider ceiling.  The first scene is a
 * special UX path: if the provider cannot answer promptly, the deterministic
 * fallback is already a valid atomic scene and should unblock the player.
 */
const FAST_FIRST_SCENE_TIMEOUT_MS = 30_000;

/**
 * Phase 14：reconcileMainStoryProgress 的 deps 占位。该函数当前统计逻辑不读
 * now()（仅基于 blueprint.quests 与 state.quests 的纯交集计数），故此处传入
 * 确定性空字符串即可；保留参数仅为与 spec 签名对齐。
 */
const NOOP_QUEST_DEPS: ReconcileQuestsDependencies = { now: () => "" };

/**
 * Phase 14：达阈值且导演提议结局时跑 8 步闸门；否则返回 undefined。
 * 纯只读——绝不修改 state/blueprint，仅返回审批决定供调用方落库。
 *
 * 防御性守卫：旧测试 fixture 或迁移期 state 可能缺 mainStoryProgress/
 * endingDirection（Phase 14 才引入的字段），此时降级为不提议结局
 * （返回 undefined），避免运行时崩溃。与 runtimeNarrativeContexts 的
 * hasEndingProgress 守卫口径一致。
 */
function computeEndingDecision(
  blueprint: ScenarioBlueprint,
  state: GameState,
  plan: ApprovedDirectorPlan,
): EndingApprovalDecision | undefined {
  if (blueprint.endingDirection === undefined || state.mainStoryProgress === undefined) {
    return undefined;
  }
  // Fix Round 1：取 reconcileMainStoryProgress 派生的 currentAct（基于 state.quests
  // 计数）传入闸门，而非让闸门读 persisted state.mainStoryProgress.currentAct
  // ——后者在 performAction 写回前可能滞后，会使 not_locked 闸门恒为拒绝。
  const { currentAct, shouldProposeEnding } = reconcileMainStoryProgress(blueprint, state, NOOP_QUEST_DEPS);
  if (!shouldProposeEnding) return undefined;
  if (plan.proposedEnding === undefined) return undefined;
  return approveEndingProposal({ blueprint, state, proposed: plan.proposedEnding, currentAct });
}

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
  readonly timeoutMs?: number;
  readonly approvalObserver?: (event: StoryEvalApprovalEvent) => void;
}): Promise<string | null> {
  for (let attemptIndex = 0; attemptIndex < args.maxRoleAttempts; attemptIndex += 1) {
    try {
      const attempt = await args.npcLineSource.generate({
        traceId: `${args.traceId}${"-retry".repeat(attemptIndex)}`,
        context: attemptIndex === 0
          ? args.npcLineContext as unknown as Record<string, unknown>
          : { ...(args.npcLineContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return one complete JSON object using only the supplied fact cards." },
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
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
  readonly timeoutMs?: number;
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
      timeoutMs: args.timeoutMs,
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
  /** 生产开局快速路径：初始场景只做一次角色尝试，失败立即 fallback。 */
  readonly fastFirstScene?: boolean;
  /** 仅报告脱敏的角色阶段进度，不暴露 provider 或提示词细节。 */
  readonly progressObserver?: (progress: NarrativeGenerationProgress) => void;
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
  /**
   * Phase 14：结局推演闸门审批结果。仅当主线进度达阈值且导演提议了结局时计算；
   * fallback 场景与未达阈值/未提议场景为 undefined。本层只读计算，不修改
   * state/blueprint——blueprint 扩展与 mainStoryProgress.endingProposed 写回
   * 由调用方（generatePendingNarrativeScene）经 CAS 落库。
   */
  readonly endingDecision?: EndingApprovalDecision;
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
  const initialOpening = state.narrative.generation.status === "pending" &&
    state.narrative.generation.triggerContext?.kind === "initial_opening";
  const maxRoleAttempts = input.fastFirstScene && initialOpening
    ? 1
    : resolveRoleAttemptLimit(input.maxRoleAttempts);
  const retryBackoffMs = resolveRetryBackoffMs(input.retryBackoffMs);
  const roleTimeoutMs = input.fastFirstScene && initialOpening
    ? FAST_FIRST_SCENE_TIMEOUT_MS
    : undefined;
  const completedRoleStages = new Set<NarrativeRoleStage>();
  function reportProgress(role: NarrativeRoleStage, attempt: number, stageCompleted = false): void {
    if (stageCompleted) completedRoleStages.add(role);
    input.progressObserver?.({
      completedCalls: completedRoleStages.size,
      totalCalls: 3,
      currentRole: role,
      attempt,
    });
  }

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
    reportProgress("director", attempt + 1);
    try {
      directorAttempt = await directorSource.generate({
        traceId: `${traceId}-director${"-retry".repeat(attempt)}`,
        context: attempt === 0
          ? directorContext as unknown as Record<string, unknown>
          : { ...(directorContext as unknown as Record<string, unknown>), retryInstruction: "Previous proposal was rejected. Return a complete proposal using only the exact IDs and action keys supplied." },
        ...(roleTimeoutMs === undefined ? {} : { timeoutMs: roleTimeoutMs }),
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
      reportProgress("director", attempt + 1, true);
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
      blueprint,
      fallbackPacing,
      undefined,
      [objective?.suggestedActionKey, objective?.targetActionKey].filter((key): key is string => typeof key === "string"),
    );
  }

  // 将导演的旧 action 计划收敛为一个原子事件。开局/交谈触发优先锁定
  // 当前 NPC；只有没有对话触发时，才从第一条合法行动推导世界事件。
  let event = resolveNarrativeEvent(plan, state, candidates);
  if (event?.kind === "dialogue" && (plan.focusNpcId === null || plan.eventKind === undefined)) {
    plan = {
      ...plan,
      eventKind: "dialogue",
      eventTargetId: String(event.focusNpcId),
      focusNpcId: event.focusNpcId,
    };
    event = resolveNarrativeEvent(plan, state, candidates);
  }
  if (event !== undefined && plan.eventTargetId === undefined && isRuntimeEventTarget(event)) {
    plan = { ...plan, eventTargetId: runtimeTargetIdOf(event) };
    event = resolveNarrativeEvent(plan, state, candidates);
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
    reportProgress("writer", attempt + 1);
    try {
      scriptAttempt = await sceneScriptSource.generate({
        traceId: `${traceId}-script${"-retry".repeat(attempt)}`,
        context: attempt === 0 ? sceneScriptContext as unknown as Record<string, unknown> : { ...(sceneScriptContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return a complete JSON object with exactly the required fields, two choices, and only supplied IDs." },
        ...(roleTimeoutMs === undefined ? {} : { timeoutMs: roleTimeoutMs }),
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
      eventKind: event?.kind,
      ...(plan.eventTargetId !== undefined ? { eventTargetId: plan.eventTargetId } : {}),
    });
    input.approvalObserver?.({ kind: "role_approval", traceId, role: "writer", attempt: attempt + 1, category: approval.ok ? null : approval.category });
    if (approval.ok) {
      reportProgress("writer", attempt + 1, true);
      script = approval.value;
      break;
    }
    logger.warn("runtime_narrative_approval", { traceId, role: "writer", category: approval.category });
  }
  if (script === undefined || scriptAttempt === null) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, false, candidates, state, blueprint, fallbackPacing, plan);

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
      reportProgress("npc", attemptIndex + 1);
      try {
        const attempt = await npcLineSource.generate({
          traceId: `${traceId}-npcLine${"-retry".repeat(attemptIndex)}`,
          context: attemptIndex === 0 ? npcLineContext as unknown as Record<string, unknown> : { ...(npcLineContext as unknown as Record<string, unknown>), retryInstruction: "Previous output failed approval. Return one complete JSON object using only the supplied fact cards." },
          ...(roleTimeoutMs === undefined ? {} : { timeoutMs: roleTimeoutMs }),
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
        reportProgress("npc", attemptIndex + 1, true);
        npcLine = { npcId: npcInst.npcId as NpcId, text: approved.value.text, emotion: approved.value.emotion, usedFactIds: approved.value.usedFactIds as readonly FactId[] };
        npcApproved = true;
        break;
      } catch { /* bounded same-role retry, then full fallback */ }
    }
  }
  if (!npcApproved) return buildFallbackResult(traceId, directorAttempt, scriptAttempt, npcLineAttempted, candidates, state, blueprint, fallbackPacing, plan);

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
    timeoutMs: roleTimeoutMs,
    approvalObserver: input.approvalObserver,
    onNpcLineAttempted: () => { npcLineAttempted = true; },
  });

  // Step 6：组装 NarrativeSceneState
  const expansionDecision = approveBlueprintExpansion({ blueprint, state, plan });
  input.approvalObserver?.({ kind: "expansion_decision", traceId, decision: expansionDecision });
  // Phase 14：主线进度达阈值且导演提议结局时跑 8 步闸门（只读，不修改 state/blueprint）。
  const endingDecision = computeEndingDecision(blueprint, state, plan);
  const scene: NarrativeSceneState = {
    sceneId: `${traceId}-scene-${Date.now()}`,
    turn: calculateTurn(state),
    narration: script.narration,
    usedFactIds: script.usedFactIds as unknown as NarrativeSceneState["usedFactIds"],
    npcLine,
    ...(event !== undefined ? { event } : {}),
    choices: script.choices.map((choice, index) => {
      if (event?.kind === "dialogue") {
        return {
          choiceToken: `${traceId}-choice:${index}`,
          label: PLAYER_DIALOGUE_RESPONSE_LABELS[index],
          choiceKind: "dialogue_response" as const,
          dialogueIntent: choice.dialogueIntent ?? `dialogue_response_${index + 1}`,
          // Narrative choices retain one opaque server-side string for the
          // persisted token lookup; it is never passed to rule resolvers.
          actionKey: `dialogue:${traceId}:${index}`,
        };
      }
      const eventActionKey = event !== undefined ? actionKeyForEvent(event) : undefined;
      if (eventActionKey !== undefined && choice.actionKey === eventActionKey) {
        return {
          choiceToken: `${traceId}-choice:${index}`,
          label: choice.label,
          actionKey: eventActionKey,
        };
      }
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

  const dialogueFollowups = event?.kind === "dialogue"
    ? buildPreGeneratedDialogueFollowups({
        blueprint,
        state,
        focusNpcId: event.focusNpcId,
        choices: scene.choices,
        candidates,
        currentNpcLine: npcLine,
      })
    : undefined;

  return {
    scene: dialogueFollowups === undefined ? scene : { ...scene, dialogueFollowups },
    provenance: scriptAttempt.provenance === "fixture" ? "fixture" : "generated",
    pacing: plan.pacing,
    focusNpcId: event?.kind === "dialogue" ? event.focusNpcId : plan.focusNpcId as NpcId | null,
    expansionDecision,
    ...(endingDecision !== undefined ? { endingDecision } : {}),
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

export function createDeterministicNarrativeFallback(input: {
  readonly traceId: string;
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly preferredActionKeys?: readonly string[];
}): OrchestrateSceneResult {
  const availableActions = projectAvailableActions(input.blueprint, input.state);
  const candidates: NarrativeActionCandidate[] = availableActions.map((action) => ({
    actionKey: actionKeyOf(action),
    kind: action.type,
    publicLabel: action.label,
  }));
  const pacing = deriveContentProgression({ blueprint: input.blueprint, state: input.state }).allowedPacing.at(-1) ?? "setup";
  return buildFallbackResult(
    input.traceId,
    unavailableDirectorAttempt(input.traceId),
    null,
    false,
    candidates,
    input.state,
    input.blueprint,
    pacing,
    undefined,
    input.preferredActionKeys,
  );
}

function buildFallbackResult(
  traceId: string,
  directorAttempt: DirectorAttempt,
  scriptAttempt: SceneScriptAttempt | null,
  npcLineAttempted: boolean,
  candidates: readonly NarrativeActionCandidate[],
  state: GameState,
  blueprint: ScenarioBlueprint,
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
  const fallbackEvent = resolveNarrativeEvent(approvedPlan, state, candidates);
  const fallbackNpc = fallbackEvent?.kind === "dialogue"
    ? blueprint.npcs.find((npc) => String(npc.id) === String(fallbackEvent.focusNpcId))
    : undefined;
  const fallbackNpcDialogues = fallbackEvent?.kind === "dialogue" && fallbackNpc !== undefined
    ? [{
        npcId: fallbackEvent.focusNpcId,
        npcName: fallbackNpc.name,
        npcRole: fallbackNpc.role,
        speechPages: paginateSpeechText(
          composeNpcSpeech(blueprint, state, fallbackEvent.focusNpcId),
          SPEECH_PAGE_CHAR_BUDGET,
        ),
      }]
    : undefined;
  const fallbackScene: NarrativeSceneState = {
    sceneId: `${traceId}-fallback-${Date.now()}`,
    turn: calculateTurn(state),
    narration: FALLBACK_SCENE_SCRIPT.narration,
    usedFactIds: [] as unknown as NarrativeSceneState["usedFactIds"],
    npcLine: null,
    ...(fallbackEvent !== undefined ? { event: fallbackEvent } : {}),
    choices: [
      {
        choiceToken: `${traceId}-fallback:a`,
        label: fallbackEvent?.kind === "dialogue"
          ? PLAYER_DIALOGUE_RESPONSE_LABELS[0]
          : fallbackCandidates[0]?.publicLabel ?? FALLBACK_SCENE_SCRIPT.choices[0].label,
        ...(fallbackEvent?.kind === "dialogue"
          ? { choiceKind: "dialogue_response" as const, dialogueIntent: "ask_current_situation" }
          : {}),
        actionKey: fallbackEvent?.kind === "dialogue"
          ? `dialogue:${traceId}:fallback:a`
          : fallbackCandidates[0]?.actionKey ?? FALLBACK_SCENE_SCRIPT.choices[0].actionKey,
      },
      {
        choiceToken: `${traceId}-fallback:b`,
        label: fallbackEvent?.kind === "dialogue"
          ? PLAYER_DIALOGUE_RESPONSE_LABELS[1]
          : fallbackCandidates[1]?.publicLabel ?? FALLBACK_SCENE_SCRIPT.choices[1].label,
        ...(fallbackEvent?.kind === "dialogue"
          ? { choiceKind: "dialogue_response" as const, dialogueIntent: "challenge_recent_repair" }
          : {}),
        actionKey: fallbackEvent?.kind === "dialogue"
          ? `dialogue:${traceId}:fallback:b`
          : fallbackCandidates[1]?.actionKey ?? FALLBACK_SCENE_SCRIPT.choices[1].actionKey,
      },
    ],
    source: "fallback",
    ...(fallbackNpcDialogues !== undefined ? { npcDialogues: fallbackNpcDialogues } : {}),
  };

  const dialogueFollowups = fallbackEvent?.kind === "dialogue"
    ? buildPreGeneratedDialogueFollowups({
        blueprint,
        state,
        focusNpcId: fallbackEvent.focusNpcId,
        choices: fallbackScene.choices,
        candidates,
        currentNpcLine: null,
      })
    : undefined;

  return {
    scene: dialogueFollowups === undefined ? fallbackScene : { ...fallbackScene, dialogueFollowups },
    provenance: "fallback",
    pacing,
    focusNpcId: fallbackEvent?.kind === "dialogue" ? fallbackEvent.focusNpcId : null,
    expansionDecision: { ok: false, reason: "none_proposed" },
    diagnostics: {
      director: directorAttempt,
      script: scriptAttempt,
      npcLineAttempted,
    },
  };
}

/**
 * Dialogue choices are a small local branch point.  Prepare both immediate
 * NPC replies while the current scene is being assembled so selecting one
 * never turns a conversational response into a world-event generation wait.
 * The hint only names an already legal public action; it is not a hidden
 * future event or a rules mutation.
 */
function buildPreGeneratedDialogueFollowups(args: {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly focusNpcId: NpcId;
  readonly choices: NarrativeSceneState["choices"];
  readonly candidates: readonly NarrativeActionCandidate[];
  readonly currentNpcLine: NarrativeSceneState["npcLine"];
}): readonly [NarrativeDialogueFollowupState, NarrativeDialogueFollowupState] | undefined {
  const npc = args.blueprint.npcs.find((entry) => String(entry.id) === String(args.focusNpcId));
  if (npc === undefined) return undefined;
  const discoveredFact = args.state.worldFacts
    .filter((fact) => fact.discovered)
    .map((fact) => args.blueprint.world.facts.find((entry) => String(entry.id) === String(fact.factId)))
    .find((fact) => fact !== undefined);
  const clue = discoveredFact?.text ?? "眼前的线索还不完整";
  const nextWorldAction = args.candidates.find((candidate) => !candidate.actionKey.startsWith("talk:"));
  const nextEventHint = nextWorldAction === undefined
    ? "这段对话暂告一段落，接下来可以继续寻找线索。"
    : `这段对话暂告一段落，接下来可以${nextWorldAction.publicLabel}。`;
  const emotion = args.currentNpcLine?.emotion ?? "neutral";
  const usedFactIds = args.currentNpcLine?.usedFactIds ?? [];
  const makeFollowup = (index: 0 | 1): NarrativeDialogueFollowupState => ({
    dialogueIntent: args.choices[index].dialogueIntent ?? `dialogue_response_${index + 1}`,
    narration: index === 0
      ? `你请${npc.name}说明目前的状况，对方斟酌片刻后压低了声音。`
      : `你继续追问事情的缘由，${npc.name}的神色变得凝重起来。`,
    npcLine: {
      npcId: args.focusNpcId,
      text: index === 0
        ? `${npc.name}说道：“目前的状况和${clue}有关，但还有几处细节没有查清。”`
        : `${npc.name}回答道：“事情的缘由要从${clue}说起，真正的关键还在后面。”`,
      emotion,
      usedFactIds,
    },
    nextEventHint,
  });
  return [makeFollowup(0), makeFollowup(1)];
}

function resolveNarrativeEvent(
  plan: ApprovedDirectorPlan | undefined,
  state: GameState,
  candidates: readonly NarrativeActionCandidate[],
): NarrativeEventState | undefined {
  const trigger = state.narrative.generation.status === "pending"
    ? state.narrative.generation.triggerContext
    : undefined;
  const triggerNpcId = trigger !== undefined &&
    (trigger.kind === "initial_opening" || trigger.kind === "talk" || trigger.kind === "free_input" || trigger.kind === "dialogue_response")
    ? trigger.npcId
    : undefined;
  const selectedActionKey = plan?.suggestedActionKeys[0] ?? candidates[0]?.actionKey;
  const inferredKind = actionKindOf(selectedActionKey);
  const kind: NarrativeEventKind | undefined = plan?.eventKind ?? (
    trigger !== undefined &&
    (trigger.kind === "initial_opening" || trigger.kind === "talk" || trigger.kind === "free_input")
      ? "dialogue"
      : inferredKind === "dialogue" ? undefined : inferredKind
  );
  if (kind === undefined) return undefined;

  switch (kind) {
    case "dialogue": {
      const npcId = plan?.focusNpcId !== undefined && plan.focusNpcId !== null
        ? asNpcId(plan.focusNpcId)
        : triggerNpcId;
      if (npcId === null || npcId === undefined) return undefined;
      const present = state.npcs.some((npc) => String(npc.npcId) === String(npcId) && String(npc.locationId) === String(state.currentLocationId));
      return present ? { kind, focusNpcId: npcId } : undefined;
    }
    case "investigate": {
      const factId = plan?.eventTargetId ?? targetFromAction(candidates, "investigate:", plan?.suggestedActionKeys[0]) ??
        (plan?.proposedNewFacts?.length === 1 ? "runtime:new_fact" : undefined);
      return factId === undefined ? undefined : { kind, factId: asFactId(factId) };
    }
    case "item": {
      const itemId = plan?.eventTargetId ?? targetFromAction(candidates, "take_item:", plan?.suggestedActionKeys[0]) ??
        (plan?.proposedNewItems?.length === 1 ? "runtime:new_item" : undefined);
      return itemId === undefined ? undefined : { kind, itemId: asItemId(itemId) };
    }
    case "battle": {
      const enemyId = plan?.eventTargetId ?? targetFromAction(candidates, "start_battle:", plan?.suggestedActionKeys[0]) ??
        (plan?.proposedNewEnemies?.length === 1 ? "runtime:new_enemy" : undefined);
      return enemyId === undefined ? undefined : { kind, enemyId: asEnemyId(enemyId) };
    }
    case "travel": {
      const locationId = plan?.eventTargetId ?? targetFromAction(candidates, "move:", plan?.suggestedActionKeys[0]);
      return locationId === undefined ? undefined : { kind, locationId: asLocationId(locationId) };
    }
    case "observe": {
      const locationId = plan?.eventTargetId ?? targetFromAction(candidates, "observe:", plan?.suggestedActionKeys[0]);
      return locationId === undefined ? undefined : { kind, locationId: asLocationId(locationId) };
    }
  }
}

function actionKindOf(actionKey: string | undefined): NarrativeEventKind | undefined {
  if (actionKey === undefined) return undefined;
  if (actionKey.startsWith("investigate:")) return "investigate";
  if (actionKey.startsWith("take_item:")) return "item";
  if (actionKey.startsWith("start_battle:")) return "battle";
  if (actionKey.startsWith("move:")) return "travel";
  if (actionKey.startsWith("observe:")) return "observe";
  if (actionKey.startsWith("talk:")) return "dialogue";
  return undefined;
}

function targetFromAction(candidates: readonly NarrativeActionCandidate[], prefix: string, preferredActionKey?: string): string | undefined {
  const key = preferredActionKey?.startsWith(prefix)
    ? preferredActionKey
    : candidates.find((candidate) => candidate.actionKey.startsWith(prefix))?.actionKey;
  return key?.slice(prefix.length);
}

function isRuntimeEventTarget(event: NarrativeEventState): boolean {
  return event.kind === "investigate" && String(event.factId) === "runtime:new_fact" ||
    event.kind === "item" && String(event.itemId) === "runtime:new_item" ||
    event.kind === "battle" && String(event.enemyId) === "runtime:new_enemy";
}

function runtimeTargetIdOf(event: NarrativeEventState): string {
  switch (event.kind) {
    case "investigate": return String(event.factId);
    case "item": return String(event.itemId);
    case "battle": return String(event.enemyId);
    default: return "";
  }
}

function actionKeyForEvent(event: NarrativeEventState): string | undefined {
  switch (event.kind) {
    case "investigate": return `investigate:${String(event.factId)}`;
    case "item": return `take_item:${String(event.itemId)}`;
    case "battle": return `start_battle:${String(event.enemyId)}`;
    case "travel": return `move:${String(event.locationId)}`;
    case "observe": return `observe:${String(event.locationId)}`;
    case "dialogue": return undefined;
  }
}

function unavailableDirectorAttempt(traceId: string): DirectorAttempt {
  return { ok: false, provenance: "unavailable", category: "service_error", diagnostics: { traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed", category: "service_error" } };
}

function calculateTurn(state: GameState): number {
  return Math.max(0, state.eventLedger.length - 1);
}
