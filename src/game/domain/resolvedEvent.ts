import type { NarrativeEventKind } from "./narrative";
import type { FactId, NpcId } from "./scenarioBlueprint";

export type ResolvedEventStatus = "success" | "partial_success" | "failure" | "blocked" | "invalid";

export type FactChange = {
  readonly factId: FactId;
  readonly change: "discovered" | "hidden" | "revealed";
  readonly audience?: readonly NpcId[];
};

export type StateChange = {
  readonly path: string;
  readonly description: string;
  readonly operation: "set" | "add" | "remove" | "update";
  readonly value?: unknown;
};

export type Cost = { readonly description: string };
export type Reward = { readonly description: string };
export type RejectedEffect = { readonly description: string; readonly reason: string };

export type ResolvedEvent = {
  readonly actionId: string;
  readonly status: ResolvedEventStatus;
  readonly eventKind: NarrativeEventKind;
  readonly facts: readonly FactChange[];
  readonly stateChanges: readonly StateChange[];
  readonly costs: readonly Cost[];
  readonly rewards: readonly Reward[];
  readonly triggeredEvents: readonly string[];
  readonly rejectedEffects: readonly RejectedEffect[];
};
