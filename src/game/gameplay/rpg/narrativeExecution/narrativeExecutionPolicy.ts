import type { Action, Interaction } from "@/game/domain/action";
import type { NpcId } from "@/game/domain/worldEntity";
import {
  PROVIDER_GENERATION_KINDS,
  type ProviderGenerationKind,
  type NarrativeSceneRequestKind,
} from "@/game/domain/pendingNarrativeJob";

export type NarrativeExecutionKind = ProviderGenerationKind | "prepared_action" | "rule_only";

export type NarrativeExecutionInput = {
  readonly action: Action;
  readonly interactionKind: "fixed_choice" | "free_text" | null;
  readonly advancesObjective: boolean;
  readonly hasPreparedStep: boolean;
  readonly battleWillResolve: boolean;
  readonly dialogueWillComplete: boolean;
};

export type NarrativeExecutionDecision =
  | {
      readonly kind: "provider";
      readonly generationKind: ProviderGenerationKind;
      readonly sceneRequestKind: Exclude<NarrativeSceneRequestKind, "opening">;
    }
  | { readonly kind: "prepared" }
  | { readonly kind: "rule_only" };

export function providerAllowedFor(kind: unknown): kind is ProviderGenerationKind {
  return PROVIDER_GENERATION_KINDS.some((allowed) => allowed === kind);
}

export function intentProviderAllowedFor(input: {
  readonly interaction: Interaction;
  readonly focusedNpcId: NpcId | null;
}): boolean {
  return input.interaction.kind === "free_text"
    && input.focusedNpcId !== null
    && input.interaction.targetNpcId === input.focusedNpcId;
}

export function decideNarrativeExecution(input: NarrativeExecutionInput): NarrativeExecutionDecision {
  if (input.action.type === "talk" && input.interactionKind !== null) {
    return {
      kind: "provider",
      generationKind: input.interactionKind === "free_text" ? "npc_free_text" : "npc_fixed_choice",
      sceneRequestKind: input.dialogueWillComplete ? "npc_handoff" : "npc_response",
    };
  }
  if (input.advancesObjective || input.hasPreparedStep || input.battleWillResolve) return { kind: "prepared" };
  return { kind: "rule_only" };
}
