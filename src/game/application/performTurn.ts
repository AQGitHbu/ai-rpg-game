import type { GameId } from "./server/persistence/gameRepository";
import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
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
  type PendingNarrativeJob,
  type StructuredActionSummary,
} from "@/game/domain/pendingNarrativeJob";
import { buildIntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser/intentParserSource";
import type { ExpansionSource } from "@/game/gameplay/rpg/expansion/expansionSource";
import { runExpansionProposer } from "@/game/gameplay/rpg/expansion";
import { applyApprovedExpansion } from "@/game/gameplay/rpg/expansion/applyExpansion";

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
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
  readonly intentParserSource?: IntentParserSource;
  /**
   * TODO(Task 6)：ExpansionProposer 按计划在 Task 6 正式迁移/收敛；
   * 当前在 performTurn 内部保留 P3 行为（触发 → 审批 → 重演算），
   * 全部路径都只走单次 CAS。
   */
  readonly expansionSource?: ExpansionSource;
};

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
    case "use_item": return { kind: "use_item", itemId: action.itemId, ...(action.targetId !== undefined ? { targetId: action.targetId } : {}) };
    case "give_item": return { kind: "give_item", itemId: action.itemId, npcId: action.targetNpcId };
    case "attack": return { kind: "attack", enemyId: action.enemyId };
    case "battle_action": return { kind: "battle_action", action: action.action };
    case "interact": return { kind: "interact", targetId: action.targetId };
    case "rest": return { kind: "rest" };
    case "accept_quest": return { kind: "accept_quest", questId: action.questId };
    case "narrative_choice": return { kind: "narrative_choice", choiceToken: action.choiceToken };
    case "ack_prologue": return { kind: "ack_prologue" };
    case "freeform": return { kind: "freeform" };
  }
}

/**
 * 玩家回合统一入口（P0/P1 修复的核心用例，替代 performActionV2 双 CAS 流程）：
 *   校验 → 转换 → 规则编排（resolveTurn）→（条件触发 Expansion）→
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

  const freeTextDeps = command.interaction.kind === "free_text"
    ? { intentContext: buildIntentContext(record.worldState), intentParserSource: deps.intentParserSource }
    : undefined;

  const converted = await convertInteraction(command.interaction, command.choiceMap, freeTextDeps);
  if (!converted.ok) {
    return { ok: false, code: "UNKNOWN_CHOICE", feedback: "Conversion failed" };
  }

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
    // P3：ExpansionProposer —— 初判失败且命中实体缺失时条件触发；批准则单次 CAS 提交
    if (deps.expansionSource) {
      const expansion = await runExpansionProposer(
        { ok: false, code: resolved.code, feedback: resolved.feedback },
        record.worldState,
        record.storyState,
        converted.action,
        command.actionId,
        deps.expansionSource,
        { now: deps.now },
      );

      if (expansion.triggered && expansion.approved) {
        if (expansion.reEvaluatedResult?.ok) {
          // 重演算成功：单次 CAS 提交（含已扩展实体 + 行动效果 + pending job）
          return commitResolution({
            repository: deps.repository,
            gameId: command.gameId,
            actionId: command.actionId,
            expectedRevision: record.revision,
            action: converted.action,
            turnId: asTurnId(command.actionId),
            nextWorldState: expansion.reEvaluatedResult.nextWorldState,
            nextStoryState: expansion.reEvaluatedResult.nextStoryState,
            turnNumber: expansion.reEvaluatedResult.nextStoryState.turnNumber,
            primaryResult: expansion.reEvaluatedResult.resolvedEvent,
            baseLedgerLength: record.worldState.eventLedger.length,
            now: deps.now(),
          });
        }
        // 重演算仍失败：只提交已扩展实体（供下一回合使用），行动本身被拒绝
        const expandedWs = applyApprovedExpansion(record.worldState, expansion.approved, deps.now());
        const expandedSs: StoryState = { ...record.storyState, budget: expansion.nextBudget ?? record.storyState.budget };
        const commitResult = await commitState(deps.repository, {
          gameId: command.gameId,
          expectedRevision: record.revision,
          nextWorldState: expandedWs,
          nextStoryState: expandedSs,
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

  return commitResolution({
    repository: deps.repository,
    gameId: command.gameId,
    actionId: command.actionId,
    expectedRevision: record.revision,
    action: converted.action,
    turnId: resolution.turnId,
    nextWorldState: resolution.nextWorldState,
    nextStoryState: resolution.nextStoryState,
    turnNumber: resolution.turnNumber,
    primaryResult: resolution.primaryResult,
    baseLedgerLength: record.worldState.eventLedger.length,
    now: deps.now(),
  });
}

type CommitResolutionInput = {
  readonly repository: GameRepositoryV2;
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
    utterance: input.action.type === "talk" ? input.action.utterance : undefined,
    resolvedEvent: input.primaryResult,
    domainEventRange: {
      fromLedgerIndex: input.baseLedgerLength,
      toLedgerIndexExclusive: input.nextWorldState.eventLedger.length,
    },
    focusNpcId: input.action.type === "talk" ? input.action.npcId : undefined,
    requestedAt: input.now,
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