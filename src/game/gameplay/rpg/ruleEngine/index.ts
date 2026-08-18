import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action, Interaction } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeEventKind } from "@/game/domain/narrative";
import type { GameEvent, TurnId } from "@/game/domain/events";
import { asTurnId } from "@/game/domain/events";
import type { TurnResolution } from "@/game/domain/turnResolution";
import { createTurnResolution } from "@/game/domain/turnResolution";
import type { ValidationCode } from "./validateAction";
import { validateAction } from "./validateAction";
import { resolveByType } from "./resolveByType";
import { reconcileQuests } from "./reconcileQuests";
import { resolveEnding } from "./resolveEnding";
import { updateStoryMetrics } from "./updateStoryMetrics";
import { propagateKnownFacts } from "./propagateKnownFacts";
import { advanceStoryProgression } from "./advanceStoryProgression";
import { approveCandidateEvents, compileCandidateEvent } from "@/game/gameplay/rpg/candidateEvents";
import { reconcileMaterializedView } from "@/game/domain/materializedView";
import type { RecentBeat, NpcContact } from "@/game/domain/materializedView";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";

const DIALOGUE_REQUIRED_TURNS = 2;

function advanceDialogueSession(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
): StoryState {
  if (action.type !== "talk") return storyState;
  const existing = storyState.narrative.dialogueSession;
  const currentSceneNpcId = storyState.narrative.currentScene?.event?.kind === "dialogue"
    ? storyState.narrative.currentScene.event.focusNpcId
    : undefined;
  const currentSceneHasDialogue = storyState.narrative.currentScene?.npcLine !== null
    && storyState.narrative.currentScene?.npcLine !== undefined
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
  const canStart = sameSession
    || (currentSceneHasDialogue && isExplicitDialogueResponse)
    || (isExplicitDialogueResponse && String(objectiveNpcId) === String(action.npcId));
  if (!canStart) return storyState;

  const requiredTurns = existing?.requiredTurns ?? DIALOGUE_REQUIRED_TURNS;
  const turnCount = sameSession ? existing.turnCount + 1 : 1;
  const dialogueSession = {
    npcId: action.npcId,
    turnCount,
    requiredTurns,
    completed: existing?.completed === true || turnCount >= requiredTurns,
  };
  return {
    ...storyState,
    narrative: { ...storyState.narrative, dialogueSession },
  };
}

export type { ValidationCode };

export type RuleEngineResult =
  | { readonly ok: true; readonly nextWorldState: WorldState; readonly nextStoryState: StoryState; readonly resolvedEvent: ResolvedEvent }
  | { readonly ok: false; readonly code: ValidationCode; readonly feedback: string };

export type RuleEngineDeps = { readonly now: () => string };

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
  const validation = validateAction(worldState, action);
  if (!validation.ok) {
    return { ok: false, code: validation.code, feedback: `Action rejected: ${validation.code}` };
  }

  const resolved = resolveByType(worldState, action, {
    now: deps.now,
    actionId,
    turnNumber: storyState.turnNumber,
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

  // P4 Step 1: NPC knownFactIds 传播
  const propagatedWs = propagateKnownFacts(resolved.nextWorldState, resolved.facts);

  // Spec §13.1 固定顺序：resolve → propagate → reconcile quests → advance act/
  // derive endingAllowed → approve candidate events → update tension/progress →
  // resolve ending（最后，禁止在 endingAllowed 更新前调用）→ reconcile view。
  // 领域事件严格按 resolver → quest → ending 顺序聚合；ledger 对齐由此保证。

  // Step 1: 任务推进（使用传播后的 WS）
  const dialogueStoryState = advanceDialogueSession(propagatedWs, storyState, action);
  const dialogueSession = dialogueStoryState.narrative.dialogueSession;
  const dialogueSessionAdvanced = dialogueStoryState !== storyState;
  const quests = reconcileQuests(propagatedWs, deps, !dialogueSessionAdvanced || dialogueSession === undefined
    ? undefined
    : {
        talkToNpcSession: {
          npcId: String(dialogueSession.npcId),
          completed: dialogueSession.completed,
        },
      });
  // 初步 domainEvents：resolver + quest（ending 事件在 Step 5 结算后追加）
  const domainEvents: GameEvent[] = [...resolved.events, ...quests.events];

  // Step 2: 幕推进 + storyProgress + endingAllowed 推导（§13.1 在 resolveEnding 之前）
  const progression = advanceStoryProgression(
    quests.nextWorldState,
    dialogueStoryState,
    domainEvents,
  );

  // Step 3: candidateEventPool 审批（纯规则）+ 编译批准候选为真实领域事件
  const approval = approveCandidateEvents(
    {
      worldState: quests.nextWorldState,
      storyState: progression.nextStoryState,
      candidates: progression.nextStoryState.candidateEventPool,
    },
    { now: deps.now },
  );
  const candidateFlowEvents: GameEvent[] = [...approval.events];
  let afterCandidateWs = quests.nextWorldState;
  for (const candidate of approval.approvedCandidates) {
    const compiled = compileCandidateEvent(afterCandidateWs, candidate, { now: deps.now });
    afterCandidateWs = compiled.worldState;
    candidateFlowEvents.push(...compiled.events);
  }
  // 候选事件及其审计事件纳入本回合领域事件流（供张力/结局/ledger 归约）
  const domainEventsWithCandidate: GameEvent[] = [...domainEvents, ...candidateFlowEvents];

  // Step 4: 张力/进度更新（storyProgress 由 advanceStoryProgression 推导，此处只更新 tension）
  const nextStoryState = updateStoryMetrics(approval.nextStoryState, domainEventsWithCandidate);

  // Step 5: 结局结算只消费终幕的明确立场。结局对已具象化后，探索、
  // 移动或开战仍然是正常游戏行动，不能因为 endingAllowed 已为 true 而
  // 把玩家直接送进结局。
  const isExplicitEndingDecision = action.type === "talk"
    && (action.dialogueAct === "support" || action.dialogueAct === "challenge")
    && afterCandidateWs.endings.length >= 2;
  const ending = isExplicitEndingDecision
    ? resolveEnding(afterCandidateWs, nextStoryState, deps)
    : { nextWorldState: afterCandidateWs, nextStoryState, events: [] };
  const finalDomainEvents: GameEvent[] = [...domainEventsWithCandidate, ...ending.events];

  // Step 6: 物化视图增量归约
  const prevBeats = storyState.recentBeats as readonly RecentBeat[];
  const prevContacts = storyState.npcContacts as readonly NpcContact[];
  const prev = { recentBeats: prevBeats, npcContacts: prevContacts, reducedThroughEventCount: storyState.reducedThroughEventCount };
  const newView = reconcileMaterializedView(
    prev,
    ending.nextWorldState.eventLedger,
    ending.nextWorldState.currentLocationId,
  );

  const nextStoryStateWithView: StoryState = {
    ...nextStoryState,
    recentBeats: newView.recentBeats as readonly unknown[],
    npcContacts: newView.npcContacts as readonly unknown[],
    reducedThroughEventCount: newView.reducedThroughEventCount,
  };

  // eventLedger 与 finalDomainEvents 严格对齐：只追加本回合按序产生的事件；无事件时保持原对象不变
  const nextWorldState: WorldState = finalDomainEvents.length === 0
    ? ending.nextWorldState
    : {
        ...ending.nextWorldState,
        eventLedger: [...worldState.eventLedger, ...finalDomainEvents],
      };

  // 构建最终 ResolvedEvent（作为 TurnResolution.primaryResult）
  const primaryResult: ResolvedEvent = {
    actionId,
    status: resolved.status,
    eventKind: eventKindForAction(action),
    stateChanges: resolved.stateChanges,
    facts: resolved.facts,
    costs: [],
    rewards: [],
    triggeredEvents: [...finalDomainEvents.map((e) => e.type), ...approval.approvedCandidates.map((e) => e.id)],
    rejectedEffects: [],
  };

  const resolution = createTurnResolution({
    turnId,
    baseRevision,
    interactionKind,
    action,
    primaryResult,
    domainEvents: finalDomainEvents,
    nextWorldState,
    previousStoryState: storyState,
    nextStoryState: nextStoryStateWithView,
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
