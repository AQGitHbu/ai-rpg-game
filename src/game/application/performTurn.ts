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
} from "@/game/domain/pendingNarrativeJob";
import { buildIntentContext, type IntentParserSource } from "@/game/gameplay/rpg/intentParser";
import { deriveEvolutionNeed } from "@/game/gameplay/rpg/worldEvolution";
import { buildOutcomeBeats, currentObjectiveOf, deriveObjectiveTransition } from "@/game/gameplay/rpg/narrativeContext";
import type { MandatoryNarrativeBeat, ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import { evolveWorld, repairIdOverrideForAction } from "./evolveWorld";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import { advanceStoryReveal, isActionReleased } from "@/game/gameplay/rpg/worldEvolution";

export type PerformTurnCommand = {
  readonly gameId: GameId;
  readonly actionId: string;
  readonly interaction: Interaction;
  readonly expectedRevision: number;
  readonly choiceMap: ActionChoiceMap;
};

export type PerformTurnResult =
  | { readonly ok: true; readonly revision: number; readonly resolvedEvent: ResolvedEvent; readonly feedback: string }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "UNKNOWN_CHOICE" | "ACTION_REJECTED" | "INFRASTRUCTURE_FAILURE"; readonly feedback: string };

export type PerformTurnDeps = {
  readonly repository: GameRepository;
  readonly now: () => string;
  readonly intentParserSource?: IntentParserSource;
  /** 仅用于关联 intent/world AI 审计事件，不进入游戏状态。 */
  readonly auditLink?: AiTextAuditLink;
  /**
   * Task 3：worldEvolution 由 application 编排——source 只负责产出提案
   * （await 由 performTurn 完成），gameplay `worldEvolution/` 仅做纯决策。
   * 触发→审批→预览→重演算全部路径都只走单次 CAS。
   */
  readonly worldEvolutionSource?: WorldEvolutionSource;
  /** 生产 live 路径关闭确定性世界演化降级；测试/离线调用默认保留兼容行为。 */
  readonly allowDeterministicWorldEvolutionFallback?: boolean;
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

  const scene = storyState.narrative.currentScene;
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

  // spec §11.4: pending 期间不允许玩家再次推进世界（ack_prologue 例外，
  // 仅能经 fixed_choice 达成；free_text 无法解析为 ack_prologue，同样被拦）
  if (record.storyState.narrative.generation.status === "pending") {
    const isAck =
      command.interaction.kind === "fixed_choice" &&
      command.choiceMap.get(command.interaction.choiceToken)?.type === "ack_prologue";
    if (!isAck) {
      return { ok: false, code: "ACTION_REJECTED", feedback: "正在编排下一幕，请稍候。" };
    }
  }

  if (command.interaction.kind === "free_text" && command.interaction.targetNpcId !== undefined) {
    const focusedNpcId = focusedNpcForFreeText(record.worldState, record.storyState);
    if (focusedNpcId !== command.interaction.targetNpcId) {
      return {
        ok: false,
        code: "ACTION_REJECTED",
        feedback: "自定义对话目标已失效，请使用当前场景重新选择。",
      };
    }
  }

  const freeTextDeps = command.interaction.kind === "free_text"
    ? {
        intentContext: buildIntentContext(record.worldState, record.storyState),
        intentParserSource: deps.intentParserSource,
        targetNpcId: command.interaction.targetNpcId,
        auditLink: deps.auditLink,
      }
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
    : record.storyState.narrative.choiceRegistry?.find((entry) => entry.choiceToken === fixedChoiceToken)?.label;

  const resolved = resolveTurn(
    record.worldState,
    record.storyState,
    converted.action,
    command.actionId,
    record.revision,
    asTurnId(command.actionId),
    command.interaction.kind,
    { now: deps.now },
  );

  if (!resolved.ok) {
    // Task 3：回合修复路径——未知实体引用（UNKNOWN_*）强制节奏需求
    // complicate；非未知失败按常规需求派生。命中且装配成功才允许提交，
    // 否则保持零写入并保留原始拒绝信息。
    const repairMode = UNKNOWN_REPAIR_CODES.has(resolved.code);
    const need: EvolutionNeed = repairMode
      ? { kind: "pacing", pacingNeed: "complicate" }
      : deriveEvolutionNeed(record.worldState, record.storyState);

    // 未注入演化源时不主动演化：保持纯规则拒绝（零写入），仅当配置了 source 才装配。
    if (need.kind !== "none" && deps.worldEvolutionSource !== undefined) {
      const outcome = await evolveWorld({
        need,
        worldState: record.worldState,
        storyState: record.storyState,
        source: deps.worldEvolutionSource,
        allowDeterministicFallback: deps.allowDeterministicWorldEvolutionFallback,
        action: converted.action,
        reason: resolved.code,
        auditLink: deps.auditLink,
        idOverride: repairMode ? repairIdOverrideForAction(converted.action) : undefined,
        now: deps.now,
      });
      if (outcome.ok) {
        const reEvaluated = resolveTurn(
          outcome.delta.previewWorldState,
          outcome.delta.previewStoryState,
          converted.action,
          command.actionId,
          record.revision,
          asTurnId(command.actionId),
          command.interaction.kind,
          { now: deps.now },
        );
        if (reEvaluated.ok && reEvaluated.resolution.primaryResult.status === "success") {
          const revealed = advanceStoryReveal({
            worldState: reEvaluated.resolution.nextWorldState,
            storyState: reEvaluated.resolution.nextStoryState,
          });
          // 重演算成功：单次 CAS 提交（含已世界演化实体 + 行动效果 + pending job）
          const narrative = buildTurnNarrative(
            { worldState: record.worldState, storyState: record.storyState },
            revealed,
            reEvaluated.resolution.primaryResult,
            converted.action,
          );
          return commitResolution({
            repository: deps.repository,
            gameId: command.gameId,
            actionId: command.actionId,
            expectedRevision: record.revision,
            action: converted.action,
            turnId: reEvaluated.resolution.turnId,
            nextWorldState: revealed.worldState,
            nextStoryState: revealed.storyState,
            turnNumber: reEvaluated.resolution.turnNumber,
            primaryResult: reEvaluated.resolution.primaryResult,
            baseLedgerLength: record.worldState.eventLedger.length,
            now: deps.now(),
            objectiveTransition: narrative.objectiveTransition,
            mandatoryBeats: narrative.mandatoryBeats,
            dialogueChoiceLabel,
          });
        }
        // 重演算仍失败：实体提交必须真实发生（供下一回合使用），行动本身被拒绝。
        const commitResult = await commitState(deps.repository, {
          gameId: command.gameId,
          expectedRevision: record.revision,
          nextWorldState: outcome.delta.previewWorldState,
          nextStoryState: outcome.delta.previewStoryState,
        });
        if (!commitResult.ok) {
          return { ok: false, code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE", feedback: "Commit failed" };
        }
        return { ok: false, code: "ACTION_REJECTED", feedback: resolved.feedback };
      }
    }
    return { ok: false, code: "ACTION_REJECTED", feedback: resolved.feedback };
  }

  const { resolution } = resolved;

  // blocked：零写入，永不作为 success 提交
  if (resolution.primaryResult.status === "blocked") {
    return { ok: false, code: "ACTION_REJECTED", feedback: "被战斗阻止" };
  }

  // 战斗失败不进入叙事生成：按用户可理解的“两态战斗”规则，恢复到本场
  // 战斗开始前的世界/剧情状态，玩家可以立即重新挑战同一场战斗。
  if (
    converted.action.type === "battle_action"
    && resolution.nextWorldState.battle.status === "resolved"
    && resolution.nextWorldState.battle.outcome === "defeat"
  ) {
    const restoredWorldState = restoreAfterBattleDefeat(record.worldState);
    const commitResult = await commitState(deps.repository, {
      gameId: command.gameId,
      expectedRevision: record.revision,
      nextWorldState: restoredWorldState,
      nextStoryState: record.storyState,
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
      feedback: "战斗失败，已恢复到战斗开始前，可以重新挑战。",
    };
  }

  const revealed = advanceStoryReveal({
    worldState: resolution.nextWorldState,
    storyState: resolution.nextStoryState,
  });

  // 活跃战斗是低延迟规则路径：只要本次推进后仍在战斗中，直接 CAS
  // 提交队列状态，不创建 PendingNarrativeJob，也不等待 AI 场景编排。
  // 终结战斗仍继续走下方叙事任务路径，保证结局/任务有表现机会。
  if (
    resolution.nextWorldState.battle.status === "active"
    && (converted.action.type === "attack" || converted.action.type === "battle_action")
  ) {
    const commitResult = await commitState(deps.repository, {
      gameId: command.gameId,
      expectedRevision: record.revision,
      nextWorldState: revealed.worldState,
      nextStoryState: revealed.storyState,
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
    dialogueChoiceLabel,
  });
}

function restoreAfterBattleDefeat(worldState: WorldState): WorldState {
  const battle = worldState.battle;
  if (battle.status !== "active" || battle.preBattleSnapshot === undefined) {
    return { ...worldState, battle: { status: "idle" } };
  }
  return {
    ...worldState,
    player: { ...worldState.player, stats: battle.preBattleSnapshot.playerStats },
    defeatedEnemyIds: battle.preBattleSnapshot.defeatedEnemyIds,
    eventLedger: battle.preBattleSnapshot.eventLedger,
    battle: { status: "idle" },
  };
}

/** Task 3：可经回合修复路径装配的未知实体引用代码。 */
const UNKNOWN_REPAIR_CODES: ReadonlySet<string> = new Set([
  "UNKNOWN_NPC",
  "UNKNOWN_LOCATION",
  "UNKNOWN_FACT",
  "UNKNOWN_ITEM",
  "UNKNOWN_ENEMY",
]);

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
};

/**
 * 单次 CAS 提交：世界事实 + 回合号 + pending job 一并写入；
 * job 构造失败（如零事件回合）或 commit 失败时零写入 / 不返回成功。
 */
async function commitResolution(input: CommitResolutionInput): Promise<PerformTurnResult> {
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
    domainEventRange: {
      fromLedgerIndex: input.baseLedgerLength,
      toLedgerIndexExclusive: input.nextWorldState.eventLedger.length,
    },
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
  });
  if (!built.ok) {
    return { ok: false, code: "ACTION_REJECTED", feedback: "本回合无法形成叙事任务" };
  }
  const pendingJob: PendingNarrativeJob = built.job;

  const nextStoryState: StoryState = {
    ...input.nextStoryState,
    narrative: {
      ...input.nextStoryState.narrative,
      generation: { status: "pending", job: pendingJob },
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
