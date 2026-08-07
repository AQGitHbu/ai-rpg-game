import type { GameRepositoryV2 } from "./server/persistence/gameRepositoryV2";
import type { GameId } from "./server/persistence/gameRepository";
import type { Interaction, Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import { convertInteraction, type ActionChoiceMap } from "./actionConverter";
import { ruleEngine } from "@/game/gameplay/rpg/ruleEngine";
import { commitState } from "./stateCommit";

export type PerformActionV2Command = {
  readonly gameId: GameId;
  readonly actionId: string;
  readonly interaction: Interaction;
  readonly expectedRevision: number;
  readonly choiceMap: ActionChoiceMap;
};

export type PerformActionV2Result =
  | { readonly ok: true; readonly revision: number; readonly resolvedEvent: ResolvedEvent; readonly feedback: string }
  | { readonly ok: false; readonly code: "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "UNKNOWN_CHOICE" | "FREE_TEXT_NOT_SUPPORTED" | "ACTION_REJECTED" | "INFRASTRUCTURE_FAILURE"; readonly feedback: string };

export type PerformActionV2Deps = {
  readonly repository: GameRepositoryV2;
  readonly now: () => string;
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

  const converted = convertInteraction(command.interaction, command.choiceMap);
  if (!converted.ok) {
    return { ok: false, code: converted.reason === "unknown_choice" ? "UNKNOWN_CHOICE" : "FREE_TEXT_NOT_SUPPORTED", feedback: "Conversion failed" };
  }

  const engineResult = ruleEngine(record.worldState, record.storyState, converted.action, command.actionId, { now: deps.now });
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

  return {
    ok: true,
    revision: commitResult.record.revision,
    resolvedEvent: engineResult.resolvedEvent,
    feedback: "Action performed",
  };
}
