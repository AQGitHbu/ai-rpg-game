import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { GameId } from "./server/persistence/gameRepository";
import type { Interaction, Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { convertInteraction, type ActionChoiceMap } from "./actionConverter";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import { commitState } from "./stateCommit";
import { buildIntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser/intentParserSource";
import type { ExpansionSource } from "@/game/gameplay/rpg/expansion/expansionSource";
import { runExpansionProposer } from "@/game/gameplay/rpg/expansion";
import { applyApprovedExpansion } from "@/game/gameplay/rpg/expansion/applyExpansion";

export type PerformActionV2Command = {
  readonly gameId: GameId;
  readonly actionId: string;
  readonly interaction: Interaction;
  readonly expectedRevision: number;
  readonly choiceMap: ActionChoiceMap;
};

export type PerformActionV2Result =
  | { readonly ok: true; readonly revision: number; readonly resolvedEvent: ResolvedEvent; readonly feedback: string }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "UNKNOWN_CHOICE" | "ACTION_REJECTED" | "INFRASTRUCTURE_FAILURE"; readonly feedback: string };

export type PerformActionV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
  readonly intentParserSource?: IntentParserSource;
  readonly expansionSource?: ExpansionSource;
};

export async function performActionV2(
  command: PerformActionV2Command,
  deps: PerformActionV2Deps,
): Promise<PerformActionV2Result> {
  const current = await deps.repository.getCurrentGame();
  if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Infrastructure error" };
  if (current.status === "none") return { ok: false, code: "NO_ACTIVE_GAME", feedback: "No active game" };
  if (current.status === "corrupt") return { ok: false, code: "INFRASTRUCTURE_FAILURE", feedback: "Corrupt game" };

  const { record } = current;
  if (record.revision !== command.expectedRevision) {
    return { ok: false, code: "STALE_GAME_REVISION", feedback: "Stale revision" };
  }

  const freeTextDeps = command.interaction.kind === "free_text"
    ? { intentContext: buildIntentContext(record.worldState), intentParserSource: deps.intentParserSource }
    : undefined;

  const converted = await convertInteraction(
    command.interaction,
    command.choiceMap,
    freeTextDeps,
  );
  if (!converted.ok) {
    return { ok: false, code: "UNKNOWN_CHOICE", feedback: "Conversion failed" };
  }

  const engineResult = ruleEngine(record.worldState, record.storyState, converted.action, command.actionId, { now: deps.now });

  // P3: ExpansionProposer — 初判失败时条件触发
  if (!engineResult.ok && deps.expansionSource) {
    const expansion = await runExpansionProposer(
      engineResult,
      record.worldState,
      record.storyState,
      converted.action,
      command.actionId,
      deps.expansionSource,
      { now: deps.now },
    );

    if (expansion.triggered && expansion.approved) {
      if (expansion.reEvaluatedResult?.ok) {
        // 重演算成功：提交重演算结果（含已扩展实体 + 行动效果）
        const commitResult = await commitState(deps.repository, {
          gameId: command.gameId,
          expectedRevision: record.revision,
          nextWorldState: expansion.reEvaluatedResult.nextWorldState,
          nextStoryState: expansion.reEvaluatedResult.nextStoryState,
        });
        if (!commitResult.ok) {
          return { ok: false, code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE", feedback: "Commit failed" };
        }
        return {
          ok: true,
          revision: commitResult.record.revision,
          resolvedEvent: expansion.reEvaluatedResult.resolvedEvent,
          feedback: "Action performed (with expansion)",
        };
      } else {
        // 重演算仍失败：提交已扩展实体（供下一回合使用），但行动本身被拒绝
        const expandedWs = applyApprovedExpansion(record.worldState, expansion.approved, deps.now());
        const expandedSs: StoryState = { ...record.storyState, budget: expansion.nextBudget ?? record.storyState.budget };
        await commitState(deps.repository, {
          gameId: command.gameId,
          expectedRevision: record.revision,
          nextWorldState: expandedWs,
          nextStoryState: expandedSs,
        });
        return { ok: false, code: "ACTION_REJECTED", feedback: engineResult.feedback };
      }
    }
  }

  if (!engineResult.ok) {
    return { ok: false, code: "ACTION_REJECTED", feedback: engineResult.feedback };
  }

  const commitResult = await commitState(deps.repository, {
    gameId: command.gameId,
    expectedRevision: record.revision,
    nextWorldState: engineResult.nextWorldState,
    nextStoryState: engineResult.nextStoryState,
  });

  if (!commitResult.ok) {
    return { ok: false, code: commitResult.code === "STALE_GAME_REVISION" ? "STALE_GAME_REVISION" : "INFRASTRUCTURE_FAILURE", feedback: "Commit failed" };
  }

  // Queue narrative scene generation (spec §7: async pending → ensure → sceneWriteBack)
  const pendingStoryState: StoryState = {
    ...commitResult.record.storyState,
    narrative: {
      ...commitResult.record.storyState.narrative,
      generation: {
        status: "pending",
        requestedAt: deps.now(),
      },
    },
  };

  const pendingCommit = await commitState(deps.repository, {
    gameId: command.gameId,
    expectedRevision: commitResult.record.revision,
    nextWorldState: commitResult.record.worldState,
    nextStoryState: pendingStoryState,
  });

  // Scene queuing failure is non-fatal — action still succeeded
  const finalRevision = pendingCommit.ok ? pendingCommit.record.revision : commitResult.record.revision;

  return {
    ok: true,
    revision: finalRevision,
    resolvedEvent: engineResult.resolvedEvent,
    feedback: "Action performed",
  };
}
