import type { GameId } from "./server/persistence/gameRepository";
import type { GameRepository } from "./server/persistence/gameRepository";
import type { Action, Interaction } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { convertInteraction, type ActionChoiceMap } from "./actionConverter";
import { resolveTurn } from "@/game/gameplay/rpg/ruleEngine";
import { commitState } from "./stateCommit";
import { asNarrativeJobId, asTurnId, type TurnId } from "@/game/domain/events";
import {
  createPendingNarrativeJob,
  PLAYER_UTTERANCE_MAX_LENGTH,
  type PendingNarrativeJob,
  type StructuredActionSummary,
  type ProviderGenerationKind,
  type NarrativeSceneRequestKind,
} from "@/game/domain/pendingNarrativeJob";
import { buildOutcomeBeats, currentObjectiveOf, deriveObjectiveTransition } from "@/game/gameplay/rpg/narrativeContext";
import { endingDecisionStances } from "@/game/gameplay/rpg/narrativeBundle";
import type { MandatoryNarrativeBeat, ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import { advanceStoryReveal, isActionReleased } from "@/game/gameplay/rpg/worldEvolution";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";
import { consumeNarrativeBundle } from "./consumeNarrativeBundle";
import { consumePreparedContinuation } from "./consumePreparedContinuation";
import { performBattleRound } from "./performBattleRound";
import { appendHistory, playerActionHistoryEntry } from "@/game/domain/narrativeHistory";

export type PerformTurnCommand = {
  readonly gameId: GameId;
  readonly actionId: string;
  readonly interaction: Interaction;
  readonly expectedRevision: number;
  readonly choiceMap: ActionChoiceMap;
};

export type PerformTurnResult =
  | { readonly ok: true; readonly revision: number; readonly resolvedEvent: ResolvedEvent; readonly feedback: string }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "UNKNOWN_CHOICE" | "ACTION_REJECTED" | "AI_CALL_FAILED" | "AI_RESPONSE_INVALID" | "NARRATIVE_CONTINUATION_MISSING" | "NARRATIVE_CONTINUATION_INVALID" | "INFRASTRUCTURE_FAILURE"; readonly feedback: string; readonly failureKind?: AiFailureKind };

export type PerformTurnDeps = {
  readonly repository: GameRepository;
  readonly now: () => string;
  /** 仅用于关联叙事生成审计事件，不进入游戏状态。 */
  readonly auditLink?: AiTextAuditLink;
  /** @deprecated compatibility seam; production never reads it. */
  readonly intentParserSource?: unknown;
  /** @deprecated compatibility seam; production never reads it. */
  readonly worldEvolutionSource?: unknown;
};

/**
 * The read model can expose a focused NPC immediately after entering a newly
 * materialized location. That scene can still be a handoff from the previous
 * speaker, so the authoritative current objective (rather than a recycled
 * npcLine) authorizes the new NPC's custom response input.
 */
function focusedNpcForFreeText(worldState: WorldState, storyState: StoryState): string | null {
  const objective = currentObjectiveOf(worldState, storyState);
  if (objective !== null) {
    const quest = worldState.quests.find((entry) => String(entry.id) === String(objective.questId));
    const objectiveTarget = quest?.objectives[objective.objectiveIndex];
    if (objectiveTarget?.kind === "talk_to_npc") {
      const npc = worldState.npcs.find((entry) => String(entry.id) === String(objectiveTarget.npcId));
      if (npc !== undefined && String(npc.locationId) === String(worldState.currentLocationId)) {
        return String(objectiveTarget.npcId);
      }
    }
  }

  const scene = storyState.narrative.status === "ready"
    ? storyState.narrative.currentScene
    : null;
  return scene?.event?.kind === "dialogue" ? String(scene.event.focusNpcId) : null;
}

/**
 * 纯函数：Action -> 场景生成所需的封闭结构化摘要（不保存 World State / path patch）。
 */
export function buildActionSummary(action: Action): StructuredActionSummary {
  switch (action.type) {
    case "talk": return { kind: "talk", npcId: action.npcId };
    case "move": return { kind: "move", locationId: action.locationId };
    case "explore": return { kind: "explore" };
    case "investigate": return { kind: "investigate", factId: action.factId };
    case "take_item": return { kind: "take_item", itemId: action.itemId };
    case "give_item": return { kind: "give_item", itemId: action.itemId, npcId: action.npcId };
    case "abandon_quest": return { kind: "abandon_quest", questId: action.questId };
    case "attack": return { kind: "attack", enemyId: action.enemyId };
    case "battle_action": return { kind: "battle_action", action: action.action };
    case "ack_prologue": return { kind: "ack_prologue" };
    case "freeform": return { kind: "freeform" };
  }
}

/**
 * 玩家回合统一入口：
 *   校验 → 转换 → 规则编排（resolveTurn）→（条件触发 worldEvolution 修复）→
 *   构造 PendingNarrativeJob → 单次 CAS 同时提交 World/Story(turnNumber+pending job)。
 *
 * 不变式：
 * - 成功回合 applyState 恰好一次；拒绝/blocked/stale/job 构造失败时零写入；
 * - blocked 永不作为 success 提交；
 * - commit 失败绝不返回行动成功（返回保存记录，不从未保存内存投影视图）。
 */
export async function performTurn(
  command: PerformTurnCommand,
  deps: PerformTurnDeps,
): Promise<PerformTurnResult> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Infrastructure error" };
  if (current.status === "none") return { ok: false, code: "NO_ACTIVE_GAME", feedback: "No active game" };
  if (current.status === "corrupt") return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Corrupt game" };

  const { record } = current;
  if (record.revision !== command.expectedRevision) {
    return { ok: false, code: "STALE_GAME_REVISION", feedback: "Stale revision" };
  }

  // Provider states carry no executable choices. Only a ready runtime can
  // accept a gameplay interaction.
  if (record.storyState.narrative.status !== "ready") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "正在编排下一幕，请稍候。" };
  }
  const readyNarrative = record.storyState.narrative;

  if (command.interaction.kind === "free_text") {
    const focusedNpcId = focusedNpcForFreeText(record.worldState, record.storyState);
    if (focusedNpcId === null || String(command.interaction.targetNpcId) !== focusedNpcId) {
    return {
      ok: false,
      code: "ACTION_REJECTED",
      feedback: "自定义对话目标已失效，请使用当前场景重新选择。",
    };
    }
  }

  const freeTextDeps = command.interaction.kind === "free_text"
    ? { targetNpcId: command.interaction.targetNpcId }
    : undefined;

  const converted = await convertInteraction(command.interaction, command.choiceMap, freeTextDeps);
  if (!converted.ok) {
    return { ok: false, code: "UNKNOWN_CHOICE", feedback: "Conversion failed" };
  }

  // 即使客户端携带了旧 choiceMap，隐藏目标也不能绕过当前主线释放游标。
  if (!isActionReleased(record.worldState, record.storyState, converted.action)) {
    return { ok: false, code: "ACTION_REJECTED", feedback: "这条线索还没有展开。" };
  }

  const fixedChoiceToken = command.interaction.kind === "fixed_choice"
    ? command.interaction.choiceToken
    : undefined;
  const dialogueChoiceLabel = fixedChoiceToken === undefined
    ? undefined
    : readyNarrative.choiceRegistry.find((entry) => entry.choiceToken === fixedChoiceToken)?.label;
  const playerHistoryText = command.interaction.kind === "free_text"
    ? command.interaction.text
    : dialogueChoiceLabel ?? command.interaction.choiceToken;

  const isRegisteredSceneChoice = fixedChoiceToken !== undefined
    && readyNarrative.choiceRegistry.some((entry) => (
      entry.choiceToken === fixedChoiceToken
      && entry.sceneId === readyNarrative.currentScene.sceneId
      && entry.basedOnRevision === record.revision
    ));
  const isFormalNarrativeChoice = command.interaction.kind === "fixed_choice"
    && fixedChoiceToken !== undefined
    && isRegisteredSceneChoice
    && (converted.action.type === "abandon_quest"
      || (readyNarrative.currentScene.event?.kind === "dialogue" && converted.action.type === "talk"));

  // A server-authored NPC talk entry point can follow a rule-owned scene
  // (notably after battle victory). It still starts a provider response and
  // must not fall through to prepared-continuation consumption.
  const isNpcTalkEntryPoint = command.interaction.kind === "fixed_choice"
    && converted.action.type === "talk"
    && converted.action.dialogueAct === "ask"
    && !isRegisteredSceneChoice;

  // 结局立场由当前 World/Story 状态证明（结局对已具象化、故事未结算），不经过
  // choiceRegistry：结局包的契约禁止 provider 提交 currentScene choices。
  const submittedAction = converted.action;
  const endingStance = command.interaction.kind === "fixed_choice" && submittedAction.type === "talk"
    ? endingDecisionStances(record.worldState, record.storyState)
      .find((stance) => stance.action.dialogueAct === submittedAction.dialogueAct
        && String(stance.action.npcId) === String(submittedAction.npcId))
    : undefined;

  // 战斗回合是纯规则操作，必须在通用规则/叙事路径之前短路。
  if (
    record.worldState.battle.status === "active"
    && (converted.action.type === "attack" || converted.action.type === "battle_action")
  ) {
    const battleResult = await performBattleRound(
      { gameId: command.gameId, actionId: command.actionId, interactionKind: command.interaction.kind, action: converted.action, expectedRevision: record.revision },
      { repository: deps.repository, now: deps.now },
    );
    if (!battleResult.ok) return { ok: false, code: battleResult.code, feedback: battleResult.feedback };
    return { ok: true, revision: battleResult.revision, resolvedEvent: battleResult.resolvedEvent, feedback: "Action performed" };
  }

  const resolved = resolveTurn(
    record.worldState,
    record.storyState,
    converted.action,
    command.actionId,
    record.revision,
    asTurnId(command.actionId),
    command.interaction.kind,
    { now: deps.now, turnId: asTurnId(command.actionId) },
  );

  if (!resolved.ok) return { ok: false, code: "ACTION_REJECTED", feedback: resolved.feedback };

  const { resolution } = resolved;

  // blocked：零写入，永不作为 success 提交
  if (resolution.primaryResult.status === "blocked") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "被战斗阻止" };
  }

  const worldStateWithBattleHistory = resolution.nextWorldState.battle.status !== "active"
    || resolution.nextWorldState.battle.preBattleSnapshot === undefined
    || resolution.nextWorldState.battle.preBattleSnapshot.history !== undefined
    ? resolution.nextWorldState
    : {
        ...resolution.nextWorldState,
        battle: {
          ...resolution.nextWorldState.battle,
          preBattleSnapshot: {
            ...resolution.nextWorldState.battle.preBattleSnapshot,
            history: record.storyState.history ?? { entries: [] },
          },
        },
      };
  const revealed = advanceStoryReveal({
    worldState: worldStateWithBattleHistory,
    storyState: resolution.nextStoryState,
  });

  // Offline fixture worlds may expose a deterministic item pickup without a
  // provider-owned continuation graph. It is still a normal rule mutation:
  // commit the resolved state atomically and keep the current scene intact.
  // Production AI worlds always use a narrative bundle for this action and do
  // not enter this compatibility path.
  if (
    readyNarrative.mode === "offline"
    && readyNarrative.narrativeBundle === undefined
    && (
      converted.action.type === "take_item"
      || (converted.action.type === "attack"
        && (readyNarrative.preparedContinuation === undefined || readyNarrative.preparedContinuation.steps.length === 0))
    )
    ) {
    const history = revealed.storyState.history ?? { entries: [] };
    const storyForCommit = converted.action.type === "attack"
      && revealed.worldState.battle.status === "active"
      && revealed.storyState.narrative.status === "ready"
      ? (() => {
          const { narrative: _narrative, ...storySnapshot } = record.storyState;
          return {
            ...revealed.storyState,
            narrative: {
              ...revealed.storyState.narrative,
              battleCheckpoint: {
                storySnapshot,
                currentScene: readyNarrative.currentScene,
                choiceRegistry: readyNarrative.choiceRegistry,
                ...(readyNarrative.preparedContinuation === undefined ? {} : { preparedContinuation: readyNarrative.preparedContinuation }),
                ...(readyNarrative.dialogueSession === undefined ? {} : { dialogueSession: readyNarrative.dialogueSession }),
                ...(readyNarrative.dialogueResume === undefined ? {} : { dialogueResume: readyNarrative.dialogueResume }),
              },
            },
          };
        })()
      : revealed.storyState;
    const commitResult = await commitState(deps.repository, {
      gameId: command.gameId,
      expectedRevision: record.revision,
      nextWorldState: revealed.worldState,
      nextStoryState: {
        ...storyForCommit,
        history: appendHistory(history, [playerActionHistoryEntry({
          history,
          action: converted.action,
          actionId: command.actionId,
          text: playerHistoryText,
          sceneId: readyNarrative.currentScene.sceneId,
          revision: record.revision + 1,
          turnNumber: revealed.storyState.turnNumber,
          eventIds: resolution.domainEvents.map((event) => event.eventId),
        })]),
      },
    });
    if (!commitResult.ok) {
      return {
        ok: false,
        code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
        feedback: "Commit failed",
      };
    }
    return {
      ok: true,
      revision: commitResult.record.revision,
      resolvedEvent: resolution.primaryResult,
      feedback: "Action performed",
    };
  }

  const narrative = buildTurnNarrative(
    { worldState: record.worldState, storyState: record.storyState },
    revealed,
    resolution.primaryResult,
    converted.action,
  );
  if (isFormalNarrativeChoice || isNpcTalkEntryPoint || endingStance !== undefined || command.interaction.kind === "free_text") {
    return commitResolution({
      repository: deps.repository,
      gameId: command.gameId,
      actionId: command.actionId,
      expectedRevision: record.revision,
      action: converted.action,
      turnId: resolution.turnId,
      nextWorldState: revealed.worldState,
      nextStoryState: revealed.storyState,
      turnNumber: resolution.turnNumber,
      primaryResult: resolution.primaryResult,
      baseLedgerLength: record.worldState.eventLedger.length,
      now: deps.now(),
      objectiveTransition: narrative.objectiveTransition,
      mandatoryBeats: narrative.mandatoryBeats,
      dialogueChoiceLabel: dialogueChoiceLabel ?? endingStance?.label,
      playerHistoryText,
      generationKind: converted.action.type === "abandon_quest"
        ? "story_exit"
        : command.interaction.kind === "free_text" ? "npc_free_text" : "npc_fixed_choice",
      sceneRequestKind: converted.action.type === "abandon_quest" ? "story_exit" : "npc_response",
    });
  }

  // v7 production only writes narrativeBundle. The prepared-continuation
  // branch remains an offline fixture reader so historical deterministic
  // journey tests can exercise persistence without becoming a live fallback.
  const nextStoryState = readyNarrative.mode === "offline" && readyNarrative.narrativeBundle === undefined
    ? consumePreparedContinuation({
        beforeWorldState: record.worldState,
        beforeStoryState: record.storyState,
        resolvedWorldState: revealed.worldState,
        resolvedStoryState: revealed.storyState,
        action: converted.action,
        postCommitRevision: record.revision + 1,
        resolvedEvent: resolution.primaryResult,
        domainEvents: resolution.domainEvents,
        now: deps.now,
        playerHistoryText,
      })
    : consumeNarrativeBundle({
        beforeStoryState: record.storyState,
        resolvedWorldState: revealed.worldState,
        resolvedStoryState: revealed.storyState,
        action: converted.action,
        actionId: command.actionId,
        postCommitRevision: record.revision + 1,
        resolvedEvent: resolution.primaryResult,
        domainEvents: resolution.domainEvents,
        playerHistoryText,
      });
  if (!nextStoryState.ok) {
    return {
      ok: false,
      code: nextStoryState.code,
      feedback: nextStoryState.code === "NARRATIVE_CONTINUATION_MISSING"
        ? "当前行动没有可消费的预备叙事。"
        : "预备叙事图已失效，请重新开始当前回合。",
    };
  }
  const startsBattle = resolution.domainEvents.some((event) => event.kind === "battle_started");
  const storyForCommit = startsBattle && nextStoryState.nextStoryState.narrative.status === "ready"
    ? (() => {
        const { narrative: _narrative, ...storySnapshot } = record.storyState;
        return {
          ...nextStoryState.nextStoryState,
          narrative: {
            ...nextStoryState.nextStoryState.narrative,
            battleCheckpoint: {
              storySnapshot,
              currentScene: readyNarrative.currentScene,
              choiceRegistry: readyNarrative.choiceRegistry,
              ...(readyNarrative.narrativeBundle === undefined ? {} : { bundle: readyNarrative.narrativeBundle }),
              ...(readyNarrative.preparedContinuation === undefined ? {} : { preparedContinuation: readyNarrative.preparedContinuation }),
              ...(readyNarrative.dialogueSession === undefined ? {} : { dialogueSession: readyNarrative.dialogueSession }),
              ...(readyNarrative.dialogueResume === undefined ? {} : { dialogueResume: readyNarrative.dialogueResume }),
            },
          },
        };
      })()
    : nextStoryState.nextStoryState;
  const commitResult = await commitState(deps.repository, {
    gameId: command.gameId,
    expectedRevision: record.revision,
    nextWorldState: nextStoryState.nextWorldState,
    nextStoryState: storyForCommit,
  });
  if (!commitResult.ok) {
    return {
      ok: false,
      code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE",
      feedback: "Commit failed",
    };
  }
  return {
    ok: true,
    revision: commitResult.record.revision,
    resolvedEvent: resolution.primaryResult,
    feedback: "Action performed",
  };
}

/** 玩家原文长度上限与 job 构造常量保持一致（spec §7.3 截断）。 */
function clipPlayerUtterance(text: string): string {
  if (Array.from(text).length <= PLAYER_UTTERANCE_MAX_LENGTH) return text;
  return Array.from(text).slice(0, PLAYER_UTTERANCE_MAX_LENGTH).join("");
}

/**
 * Task 4：提交前从规则结果 + before/after 状态纯派生目标转换与强制叙事节拍。
 * 禁止把事件正文/账本字符串丢给 AI 去推断状态变化。
 * Task 5：talk 行动的玩家原话与焦点 NPC 一并注入，强制产出 player_utterance 节拍。
 */
function buildTurnNarrative(
  before: { readonly worldState: WorldState; readonly storyState: StoryState },
  after: { readonly worldState: WorldState; readonly storyState: StoryState },
  primaryResult: ResolvedEvent,
  action: Action,
): { readonly objectiveTransition: ObjectiveTransition; readonly mandatoryBeats: readonly MandatoryNarrativeBeat[] } {
  return {
    objectiveTransition: deriveObjectiveTransition({
      beforeWorldState: before.worldState,
      beforeStoryState: before.storyState,
      afterWorldState: after.worldState,
      afterStoryState: after.storyState,
    }),
    mandatoryBeats: buildOutcomeBeats({
      resolvedEvent: primaryResult,
      beforeWorldState: before.worldState,
      beforeStoryState: before.storyState,
      afterWorldState: after.worldState,
      afterStoryState: after.storyState,
      ...(action.type === "talk"
        ? { utterance: action.utterance, npcId: action.npcId }
        : {}),
    }),
  };
}

type CommitResolutionInput = {
  readonly repository: GameRepository;
  readonly gameId: GameId;
  readonly actionId: string;
  readonly expectedRevision: number;
  readonly action: Action;
  readonly turnId: TurnId;
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
  readonly turnNumber: number;
  readonly primaryResult: ResolvedEvent;
  readonly baseLedgerLength: number;
  readonly now: string;
  readonly objectiveTransition: ObjectiveTransition;
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  readonly dialogueChoiceLabel?: string;
  readonly playerHistoryText: string;
  readonly generationKind: ProviderGenerationKind | null;
  readonly sceneRequestKind: NarrativeSceneRequestKind | null;
};

/**
 * 单次 CAS 提交：世界事实 + 回合号 + pending job 一并写入；
 * job 构造失败（如零事件回合）或 commit 失败时零写入 / 不返回成功。
 */
async function commitResolution(input: CommitResolutionInput): Promise<PerformTurnResult> {
  if (input.generationKind === null || input.sceneRequestKind === null) {
    const history = input.nextStoryState.history ?? { entries: [] };
    const commitResult = await commitState(input.repository, {
      gameId: input.gameId,
      expectedRevision: input.expectedRevision,
      nextWorldState: input.nextWorldState,
      nextStoryState: {
        ...input.nextStoryState,
        history: appendHistory(history, [playerActionHistoryEntry({
          history,
          action: input.action,
          actionId: input.actionId,
          text: input.playerHistoryText,
          sceneId: input.nextStoryState.narrative.status === "ready"
            ? input.nextStoryState.narrative.currentScene.sceneId
            : `scene-${input.actionId}`,
          revision: input.expectedRevision + 1,
          turnNumber: input.turnNumber,
          eventIds: input.nextWorldState.eventLedger.slice(input.baseLedgerLength).map((event) => event.eventId),
        })]),
      },
    });
    if (!commitResult.ok) {
      return {
        ok: false,
        code: commitResult.code === "STALE_GAME_REVISION"
          ? "STALE_GAME_REVISION"
          : "INFRASTRUCTURE_FAILURE",
        feedback: "Commit failed",
      };
    }
    return {
      ok: true,
      revision: commitResult.record.revision,
      resolvedEvent: input.primaryResult,
      feedback: "Action performed",
    };
  }

  const built = createPendingNarrativeJob({
    jobId: asNarrativeJobId(`job_${input.actionId}`),
    turnId: input.turnId,
    actionId: input.actionId,
    expectedRevision: input.expectedRevision,
    turnNumber: input.turnNumber,
    actionSummary: buildActionSummary(input.action),
    // Task 9：talk 带 utterance；freeform 把（截断后的）玩家原文带进 job，
    // 供叙事回应；其余行动不携带玩家原文。
    utterance: input.action.type === "talk"
      ? input.action.utterance
      : input.action.type === "freeform"
        ? clipPlayerUtterance(input.action.rawText)
        : undefined,
    resolvedEvent: input.primaryResult,
    domainEventIds: input.nextWorldState.eventLedger
      .slice(input.baseLedgerLength)
      .map((event) => event.eventId),
    focusNpcId: input.action.type === "talk" ? input.action.npcId : undefined,
    ...(input.action.type === "talk"
      ? {
          selectedDialogue: {
            dialogueAct: input.action.dialogueAct,
            ...(input.action.topic === undefined ? {} : { topic: input.action.topic }),
            ...((input.dialogueChoiceLabel ?? input.action.utterance) === undefined
              ? {}
              : { label: input.dialogueChoiceLabel ?? input.action.utterance }),
          },
        }
      : {}),
    requestedAt: input.now,
    objectiveTransition: input.objectiveTransition,
    mandatoryBeats: input.mandatoryBeats,
    generationKind: input.generationKind,
    sceneRequestKind: input.sceneRequestKind,
  });
  if (!built.ok) {
    return { ok: false, code: "ACTION_REJECTED", feedback: "本回合无法形成叙事任务" };
  }
  const pendingJob: PendingNarrativeJob = built.job;
  const currentNarrative = input.nextStoryState.narrative;
  if (currentNarrative.status !== "ready") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "叙事状态已失效" };
  }

  const nextStoryState: StoryState = {
    ...input.nextStoryState,
    history: (() => {
      const history = input.nextStoryState.history ?? { entries: [] };
      return appendHistory(history, [playerActionHistoryEntry({
        history,
        action: input.action,
        actionId: input.actionId,
        text: input.playerHistoryText,
        sceneId: currentNarrative.currentScene.sceneId,
        revision: input.expectedRevision + 1,
        turnNumber: input.turnNumber,
        eventIds: input.nextWorldState.eventLedger.slice(input.baseLedgerLength).map((event) => event.eventId),
        jobId: pendingJob.jobId,
      })]);
    })(),
    narrative: {
      status: "provider_pending",
      mode: currentNarrative.mode,
      job: pendingJob,
      lastPresentedScene: currentNarrative.currentScene,
      ...(currentNarrative.dialogueSession === undefined
        ? {}
        : { dialogueSession: currentNarrative.dialogueSession }),
    },
  };

  const commitResult = await commitState(input.repository, {
    gameId: input.gameId,
    expectedRevision: input.expectedRevision,
    nextWorldState: input.nextWorldState,
    nextStoryState,
  });
  if (!commitResult.ok) {
    return { ok: false, code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE", feedback: "Commit failed" };
  }

  return {
    ok: true,
    revision: commitResult.record.revision,
    resolvedEvent: input.primaryResult,
    feedback: "Action performed",
  };
}
