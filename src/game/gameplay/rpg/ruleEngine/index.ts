import { resolveNpcGift } from "./resolveNpcGift";
import { locationScaleOf } from "@/game/domain/worldEntity";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { EntityId } from "@/game/domain/entity";
import type { Action, Interaction } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import type { NarrativeEventDraft, TurnId, CommittedNarrativeEvent, EventId } from "@/game/domain/events";
import { asTurnId, eventIdFor } from "@/game/domain/events";
import { commitEventDrafts, type EventCommitSource } from "@/game/domain/eventLedger";
import type { TurnResolution } from "@/game/domain/turnResolution";
import { createTurnResolution } from "@/game/domain/turnResolution";
import type { ValidationCode } from "./validateAction";
import { validateAction } from "./validateAction";
import { resolveByType, autoResolveCurrentInvestigation } from "./resolveByType";
import { npcUsedAction, reconcileQuests } from "./reconcileQuests";
import { resolveEnding } from "./resolveEnding";
import { updateStoryMetrics } from "./updateStoryMetrics";
import { propagateKnownFactsWithDrafts } from "./propagateKnownFacts";
import { advanceStoryProgression } from "./advanceStoryProgression";
export { advanceStoryProgression } from "./advanceStoryProgression";
import { approveCandidateEvents, compileCandidateEvent } from "@/game/gameplay/rpg/candidateEvents";
import { advanceStoryReveal } from "@/game/gameplay/rpg/worldEvolution";
import { validateEntityStoreProvenance } from "@/game/domain/entity";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import { advanceStoryThreads } from "@/game/gameplay/rpg/storyThreads";
import { reconcileConfidentialityPromises } from "@/game/gameplay/rpg/storyInteraction";
import { unresolvedStoryThreadIds } from "@/game/domain/storyThreads";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

const DIALOGUE_REQUIRED_TURNS = 2;

function advanceDialogueSession(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
): StoryState {
  if (action.type !== "talk") return storyState;
  const existing = storyState.narrative.dialogueSession;
  const readyScene = storyState.narrative.status === "ready"
    ? storyState.narrative.currentScene
    : null;
  const currentSceneNpcId = readyScene?.event?.kind === "dialogue"
    ? readyScene.event.focusNpcId
    : undefined;
  const currentSceneHasDialogue = readyScene?.npcLine !== null
    && readyScene?.npcLine !== undefined
    && String(currentSceneNpcId) === String(action.npcId);
  // 某些旧流程先展示“与 NPC 交谈”入口，再由下一回合打开正式双选项。
  // 这个入口本身不是玩家对 NPC 台词的回应，不应消耗多轮会话的一轮。
  const isExplicitDialogueResponse = action.dialogueAct !== "ask"
    || action.topic !== undefined
    || action.utterance !== undefined;
  const objectiveRef = currentObjectiveOf(worldState, storyState);
  const objectiveNpcId = objectiveRef === null ? undefined : (() => {
    const quest = worldState.quests.find((entry) => String(entry.id) === String(objectiveRef.questId));
    const objective = quest?.objectives[objectiveRef.objectiveIndex];
    return objective?.kind === "talk_to_npc" ? objective.npcId : undefined;
  })();
  const sameSession = existing !== undefined
    && String(existing.npcId) === String(action.npcId)
    && isExplicitDialogueResponse;
  const isObjectiveDialogueBootstrap = action.dialogueAct === "ask"
    && !isExplicitDialogueResponse
    && String(objectiveNpcId) === String(action.npcId);
  const canStart = isObjectiveDialogueBootstrap
    || sameSession
    || (currentSceneHasDialogue && isExplicitDialogueResponse)
    || (isExplicitDialogueResponse && String(objectiveNpcId) === String(action.npcId));
  if (!canStart) return storyState;

  // 交接到另一名 NPC 时必须开启新的两轮会话；不能继承上一名 NPC 的
  // completed=true，否则新 NPC 的第一项回应会被误判为终句并立即完成目标。
  const requiredTurns = sameSession
    ? existing?.requiredTurns ?? DIALOGUE_REQUIRED_TURNS
    : DIALOGUE_REQUIRED_TURNS;
  const turnCount = isObjectiveDialogueBootstrap
    ? 0
    : sameSession ? existing.turnCount + 1 : 1;
  const dialogueSession = {
    npcId: action.npcId,
    turnCount,
    requiredTurns,
    completed: (sameSession && existing?.completed === true) || turnCount >= requiredTurns,
  };
  return {
    ...storyState,
    narrative: { ...storyState.narrative, dialogueSession },
  };
}

function dialogueTopicEntityIds(action: Extract<Action, { readonly type: "talk" }>): readonly EntityId[] {
  if (action.topic === undefined || action.topic.kind === "general") return [];
  if (action.topic.kind === "fact") return [action.topic.factId];
  if (action.topic.kind === "quest") return [action.topic.questId];
  return [];
}

function updateDialogueFocus(
  storyState: StoryState,
  action: Action,
  eventIds: readonly EventId[],
): StoryState {
  const previous = storyState.dialogueFocus ?? null;
  if (action.type === "move") return { ...storyState, dialogueFocus: null };
  if (action.type !== "talk") return storyState;

  const sameNpc = previous !== null && String(previous.npcId) === String(action.npcId);
  const topicIsUnspecified = action.topic === undefined;
  const entityIds: readonly EntityId[] = previous !== null && sameNpc && topicIsUnspecified
    ? previous.entityIds
    : [PLAYER_ENTITY_ID, action.npcId, ...dialogueTopicEntityIds(action)]
      .filter((id, index, all) => all.findIndex((candidate) => String(candidate) === String(id)) === index);
  const retainedEventIds = previous !== null && sameNpc && topicIsUnspecified ? previous.eventIds : [];
  const nextEventIds = [...retainedEventIds, ...eventIds]
    .filter((id, index, all) => all.findIndex((candidate) => String(candidate) === String(id)) === index);
  return {
    ...storyState,
    dialogueFocus: {
      npcId: action.npcId,
      entityIds,
      eventIds: nextEventIds,
    },
  };
}

export type { ValidationCode };

export type RuleEngineResult =
  | { readonly ok: true; readonly nextWorldState: WorldState; readonly nextStoryState: StoryState; readonly resolvedEvent: ResolvedEvent }
  | { readonly ok: false; readonly code: ValidationCode; readonly feedback: string };

export type RuleEngineDeps = { readonly now: () => string; readonly turnId: TurnId };

/** resolveTurn 的返回值：拒绝路径返回稳定 code + feedback，不携带任何写入。 */
export type ResolveTurnResult =
  | { readonly ok: true; readonly resolution: TurnResolution }
  | { readonly ok: false; readonly code: ValidationCode; readonly feedback: string };

function eventKindForAction(action: Action): NarrativeEventKind {
  switch (action.type) {
    case "move": return "travel";
    case "talk": return "dialogue";
    case "investigate": return "investigate";
    case "take_item": return "item";
    case "give_item": return "item";
    case "attack": case "battle_action": return "battle";
    default: return "observe";
  }
}

/**
 * 纯函数规则编排 facade：一次玩家回合的完整确定性结果。
 * 不读取时钟、随机数、环境变量或 DB；turnId/baseRevision/interactionKind 由调用方传入。
 */
export function resolveTurn(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
  actionId: string,
  baseRevision: number,
  turnId: TurnId,
  interactionKind: Interaction["kind"],
  deps: RuleEngineDeps,
): ResolveTurnResult {
  const validation = validateAction(worldState, action, storyState);
  if (!validation.ok) {
    return { ok: false, code: validation.code, feedback: `Action rejected: ${validation.code}` };
  }

  const resolved = resolveByType(worldState, action, {
    now: deps.now,
    actionId,
    turnNumber: storyState.turnNumber,
    turnId,
    storyState,
  });
  if (!resolved.ok) {
    return { ok: false, code: "INTENT_NOT_ROUTED", feedback: resolved.feedback };
  }

  // blocked：不推进任务/结局/张力，不推进回合，保持同一状态对象
  if (resolved.status === "blocked") {
    const primaryResult: ResolvedEvent = {
      actionId,
      status: "blocked",
      eventKind: eventKindForAction(action),
      stateChanges: [],
      facts: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [{ description: "被战斗阻止", reason: "battle_active" }],
    };
    return {
      ok: true,
      resolution: {
        turnId,
        actionId,
        baseRevision,
        turnNumber: storyState.turnNumber,
        interactionKind,
        action,
        primaryResult,
        domainEvents: [],
        nextWorldState: resolved.nextWorldState,
        nextStoryState: storyState,
      },
    };
  }

  // P4 Step 1: NPC knownFactIds 传播（知识写入必须带本轮真实 actionId/turn）
  const propagated = propagateKnownFactsWithDrafts(resolved.nextWorldState, resolved.facts, {
    actionId,
    turnNumber: storyState.turnNumber,
    eventId: eventIdFor(deps.turnId, `fact_propagated:${actionId}`),
    turnId: deps.turnId,
  });
  const propagatedWs = propagated.worldState;

  // Spec §13.1 固定顺序：resolve → propagate → reconcile quests → advance act/
  // derive endingAllowed → approve candidate events → update tension/progress →
  // resolve ending（最后，禁止在 endingAllowed 更新前调用）→ reconcile view。
  // 领域事件严格按 resolver → quest → ending 顺序聚合；ledger 对齐由此保证。

  // Step 1: 任务推进（使用传播后的 WS）
  const dialogueStoryState = advanceDialogueSession(propagatedWs, storyState, action);
  const previousDialogueSession = storyState.narrative.dialogueSession;
  const dialogueSession = dialogueStoryState.narrative.dialogueSession;
  const dialogueEvents: NarrativeEventDraft[] = dialogueSession !== undefined
    && dialogueSession.completed
    && (
      previousDialogueSession === undefined
      || String(previousDialogueSession.npcId) !== String(dialogueSession.npcId)
      || !previousDialogueSession.completed
    )
    ? [{ eventKey: `npc_dialogue_completed:${dialogueSession.npcId}`, episodeKey: "normal", actorIds: [dialogueSession.npcId], targetIds: [dialogueSession.npcId], locationId: propagatedWs.currentLocationId, causeKeys: [], factIds: [], questIds: [], outcome: "success", salience: 30, payload: { type: "npc_dialogue_completed", npcId: dialogueSession.npcId } }]
    : [];
  // 当前会话是 talk_to_npc 是否完成的权威游标。即使本回合不是正式回应，
  // 也要持续传入；否则 ask 写入的 met=true 或随后一次移动/探索会让通用
  // objective 判定绕过两轮会话，直接完成当前 NPC 目标。
  const quests = reconcileQuests(propagatedWs, { now: deps.now }, dialogueSession === undefined
    ? undefined
    : {
        talkToNpcSession: {
          npcId: String(dialogueSession.npcId),
          completed: dialogueSession.completed,
        },
        ...(action.type === "talk" ? {
          actionContext: {
            participantNpcId: String(action.npcId),
            actionId,
            turnNumber: storyState.turnNumber,
            turnId,
            actionWasAlreadyUsed: npcUsedAction(worldState, String(action.npcId), actionId),
          },
        } : {}),
      });
  // 初步 domainEvents：resolver + 对话完成 + quest（ending 在 Step 5 追加）
  const domainEvents: NarrativeEventDraft[] = [
    ...resolved.drafts,
    ...propagated.drafts,
    ...dialogueEvents,
    ...quests.drafts,
  ];

  // Step 1b: 先在本规则回合内推进一次 reveal 游标，再判断抵达后是否已经进入
  // discover_fact。此前这里仍使用回合开始时的 dialogueStoryState，导致 move
  // 完成 visit_location 后游标停在旧目标；带 investigationApproaches 的事实又
  // 不投影 investigate 按钮，于是新地点出现“无 action”死路。
  // 同地点连续事实按事实数量有界确认；城镇建筑事实等待明确的到达边界。
  // 自动事件、目标推进、张力和 eventLedger 仍属于同一个规则回合/CAS。
  const revealedAtBoundary = advanceStoryReveal({
    worldState: quests.nextWorldState,
    storyState: dialogueStoryState,
  });
  let ruleWorldState = revealedAtBoundary.worldState;
  let ruleStoryState = revealedAtBoundary.storyState;
  let questEvents = quests.drafts;
  const gift = action.type === "talk" && dialogueEvents.length > 0
    ? resolveNpcGift(ruleWorldState, ruleStoryState, action.npcId)
    : { ok: true as const, nextWorldState: ruleWorldState, drafts: [], stateChanges: [] };
  if (!gift.ok) return { ok: false, code: "INVALID_RESOLUTION", feedback: "NPC 赠物状态无效。" };
  if (gift.drafts.length > 0) {
    const afterGift = reconcileQuests(gift.nextWorldState, { now: deps.now }, dialogueSession === undefined ? undefined : {
      talkToNpcSession: { npcId: String(dialogueSession.npcId), completed: dialogueSession.completed },
    });
    const giftReveal = advanceStoryReveal({ worldState: afterGift.nextWorldState, storyState: ruleStoryState });
    ruleWorldState = giftReveal.worldState;
    ruleStoryState = giftReveal.storyState;
    questEvents = [...questEvents, ...gift.drafts, ...afterGift.drafts];
  }
  const currentLocation = ruleWorldState.locations.find(location => location.id === ruleWorldState.currentLocationId);
  const atTown = currentLocation !== undefined && locationScaleOf(currentLocation) === "town";
  // A shared town container cannot prove entry into the objective's building.
  const canDiscover = !atTown || action.type === "explore" || action.type === "take_item";
  for (let remaining = canDiscover ? ruleWorldState.worldFacts.length : 0; remaining > 0; remaining -= 1) {
    const automatic = autoResolveCurrentInvestigation(ruleWorldState, ruleStoryState);
    if (automatic.drafts.length === 0) break;
    const after = reconcileQuests(automatic.nextWorldState, { now: deps.now }, dialogueSession === undefined ? undefined : {
      talkToNpcSession: { npcId: String(dialogueSession.npcId), completed: dialogueSession.completed },
    });
    const revealed = advanceStoryReveal({ worldState: after.nextWorldState, storyState: ruleStoryState });
    ruleWorldState = revealed.worldState;
    ruleStoryState = revealed.storyState;
    questEvents = [...questEvents, ...automatic.drafts, ...after.drafts];
  }
  const allQuestEvents = questEvents;
  domainEvents.splice(0, domainEvents.length, ...resolved.drafts, ...propagated.drafts, ...dialogueEvents, ...allQuestEvents);

  // Step 2: 幕推进 + storyProgress + endingAllowed 推导（§13.1 在 resolveEnding 之前）
  const progression = advanceStoryProgression(
    ruleWorldState,
    ruleStoryState,
    domainEvents,
  );

  // Step 3: candidateEventPool 审批（纯规则）+ 编译批准候选为真实领域事件
  const approval = approveCandidateEvents(
    {
      worldState: ruleWorldState,
      storyState: progression.nextStoryState,
      candidates: progression.nextStoryState.candidateEventPool,
    },
    { now: deps.now },
  );
  const candidateFlowEvents: NarrativeEventDraft[] = [...approval.drafts];
  let afterCandidateWs = ruleWorldState;
  for (const candidate of approval.approvedCandidates) {
    // 候选编译内的 NPC 写入沿用本回合真实行动：candidate.id 不是证据，不得充当 actionId。
    const compiled = compileCandidateEvent(afterCandidateWs, candidate, {
      actionId,
      turnNumber: storyState.turnNumber,
    });
    afterCandidateWs = compiled.worldState;
    candidateFlowEvents.push(...compiled.drafts);
  }
  // 候选事件及其审计事件纳入本回合领域事件流（供张力/结局/ledger 归约）
  const domainEventsWithCandidate: NarrativeEventDraft[] = [...domainEvents, ...candidateFlowEvents];

  // Step 4: 张力/进度更新（storyProgress 由 advanceStoryProgression 推导，此处只更新 tension）
  const nextStoryState = updateStoryMetrics(approval.nextStoryState, domainEventsWithCandidate);

  // Step 5: 结局结算只消费终幕的明确立场。结局对已具象化后，探索、
  // 移动或开战仍然是正常游戏行动，不能因为 endingAllowed 已为 true 而
  // 把玩家直接送进结局。
  const isExplicitEndingDecision = action.type === "talk"
    && (action.dialogueAct === "support" || action.dialogueAct === "challenge")
    && afterCandidateWs.endings.length >= 2;
  const ending = isExplicitEndingDecision
    ? resolveEnding(afterCandidateWs, nextStoryState)
    : { nextWorldState: afterCandidateWs, nextStoryState, drafts: [] as readonly NarrativeEventDraft[] };
  const finalDomainEvents: NarrativeEventDraft[] = [...domainEventsWithCandidate, ...ending.drafts];

  // eventLedger 与 finalDomainEvents 严格对齐：通过 commitEventDrafts 一次提交
  const commitSource: EventCommitSource = {
    turnId,
    turnNumber: storyState.turnNumber + 1,
    committedAt: deps.now(),
    actionId,
  };
  let committedEvents: readonly CommittedNarrativeEvent[] = [];
  let nextWorldState: WorldState = ending.nextWorldState;
  if (finalDomainEvents.length > 0) {
    const commitResult = commitEventDrafts({
      ledger: ending.nextWorldState.eventLedger,
      drafts: finalDomainEvents,
      source: commitSource,
      entityStore: ending.nextWorldState.entityStore,
    });
    if (!commitResult.ok) {
      return { ok: false, code: "INVALID_RESOLUTION", feedback: `事件提交失败: ${commitResult.code}` };
    }
    committedEvents = commitResult.appended;
    nextWorldState = { ...ending.nextWorldState, eventLedger: commitResult.ledger };
  }
  nextWorldState = reconcileConfidentialityPromises(nextWorldState, ending.nextStoryState);
  const provenanceIssue = validateEntityStoreProvenance(nextWorldState.entityStore, nextWorldState.eventLedger)[0];
  if (provenanceIssue !== undefined) {
    return { ok: false, code: "INVALID_RESOLUTION", feedback: `NPC 事件证据无效: ${provenanceIssue.entityId ?? "unknown"}` };
  }

  // Threads are advanced only from the events that actually entered the ledger;
  // tentative drafts and unsaved provider output cannot close a story concern.
  const threads = advanceStoryThreads({
    worldState: nextWorldState,
    threads: ending.nextStoryState.threads,
    eventIds: committedEvents.map((event) => event.eventId),
  });
  const finalStoryState: StoryState = updateDialogueFocus({
    ...ending.nextStoryState,
    threads,
    unresolvedThreads: unresolvedStoryThreadIds(threads),
  }, action, committedEvents.map((event) => event.eventId));

  // 构建最终 ResolvedEvent（作为 TurnResolution.primaryResult）
  const primaryResult: ResolvedEvent = {
    actionId,
    status: resolved.status,
    eventKind: eventKindForAction(action),
    stateChanges: [...resolved.stateChanges, ...gift.stateChanges],
    facts: resolved.facts,
    costs: [],
    rewards: [],
    triggeredEvents: [...committedEvents.map((e) => e.kind), ...approval.approvedCandidates.map((e) => e.id)],
    rejectedEffects: [],
  };

  const resolution = createTurnResolution({
    turnId,
    baseRevision,
    interactionKind,
    action,
    primaryResult,
    domainEvents: committedEvents,
    nextWorldState,
    previousStoryState: storyState,
    nextStoryState: finalStoryState,
  });

  return { ok: true, resolution };
}

/**
 * 兼容包装：过渡期保留旧调用方（worldEvolution 预览重演算等）的签名；
 * turnId/baseRevision 由包装器按输入派生，只用于内部编排，不回传。
 */
export function ruleEngine(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
  actionId: string,
  deps: RuleEngineDeps,
): RuleEngineResult {
  const result = resolveTurn(
    worldState,
    storyState,
    action,
    actionId,
    worldState.eventLedger.length,
    asTurnId(actionId),
    "fixed_choice",
    deps,
  );
  if (!result.ok) {
    return { ok: false, code: result.code, feedback: result.feedback };
  }
  const { resolution } = result;
  return {
    ok: true,
    nextWorldState: resolution.nextWorldState,
    nextStoryState: resolution.nextStoryState,
    resolvedEvent: resolution.primaryResult,
  };
}
