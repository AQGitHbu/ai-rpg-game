import type { Action, Interaction } from "./action";
import type { GameEvent, TurnId } from "./events";
import type { ResolvedEvent } from "./resolvedEvent";
import type { StoryState } from "./storyState";
import type { WorldState } from "./worldState";

/**
 * 一次玩家回合的完整规则编排结果。它只携带领域数据，不执行持久化或其它 IO。
 */
export type TurnResolution = {
  readonly turnId: TurnId;
  readonly actionId: string;
  /** 执行规则前的 DB revision；schema version 与回合号不从它派生。 */
  readonly baseRevision: number;
  /** 本次回合提交后对应的回合号。 */
  readonly turnNumber: number;
  readonly interactionKind: Interaction["kind"];
  readonly action: Action;
  readonly primaryResult: ResolvedEvent;
  /** 本回合产生的完整、有序领域事件。 */
  readonly domainEvents: readonly GameEvent[];
  readonly nextWorldState: WorldState;
  readonly nextStoryState: StoryState;
};

export type CreateTurnResolutionInput = Omit<
  TurnResolution,
  "turnNumber" | "domainEvents" | "nextStoryState"
> & {
  readonly domainEvents: readonly GameEvent[];
  readonly previousStoryState: StoryState;
  readonly nextStoryState: StoryState;
};

/**
 * 收敛规则结果并且只推进一个玩家回合。事件数量不会影响 turnNumber。
 */
export function createTurnResolution(
  input: CreateTurnResolutionInput,
): TurnResolution {
  const {
    previousStoryState,
    nextStoryState,
    domainEvents,
    ...resolution
  } = input;
  const turnNumber = previousStoryState.turnNumber + 1;

  return {
    ...resolution,
    turnNumber,
    domainEvents: [...domainEvents],
    nextStoryState: {
      ...nextStoryState,
      turnNumber,
    },
  };
}
