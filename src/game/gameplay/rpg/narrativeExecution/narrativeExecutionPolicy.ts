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
  /** 非对白行动刚完成一幕/结局前置目标，需要一次场景编排来装配边界内容。 */
  readonly worldBoundaryNeedsPreparation?: boolean;
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
  if (input.action.type === "abandon_quest" && input.interactionKind === "fixed_choice") {
    return { kind: "provider", generationKind: "story_exit", sceneRequestKind: "story_exit" };
  }
  if (input.interactionKind === "free_text" && input.action.type === "freeform") {
    return { kind: "provider", generationKind: "npc_free_text", sceneRequestKind: "npc_response" };
  }
  if (input.action.type === "talk" && input.interactionKind !== null) {
    return {
      kind: "provider",
      generationKind: input.interactionKind === "free_text" ? "npc_free_text" : "npc_fixed_choice",
      sceneRequestKind: input.dialogueWillComplete ? "npc_handoff" : "npc_response",
    };
  }
  if (
    input.worldBoundaryNeedsPreparation === true
    && input.action.type !== "talk"
    && !input.hasPreparedStep
  ) {
    return { kind: "provider", generationKind: "npc_fixed_choice", sceneRequestKind: "npc_response" };
  }
  // Item exchange is a deterministic inventory boundary. It only consumes a
  // prepared scene when one was explicitly projected; otherwise the rule
  // result owns its local presentation even when the item completes a quest.
  if ((input.action.type === "take_item" || input.action.type === "give_item") && !input.hasPreparedStep) {
    return { kind: "rule_only" };
  }
  // 目标推进本身不等于存在可消费的 prepared continuation。比如玩家
  // 重返一个调查地点时，规则层可能在移动回合自动确认 discover_fact，
  // 但该移动没有对应的 AI 预备节点；此时必须保留规则场景并继续展示
  // 推进后的目标，不能把一次合法移动送进 continuation missing 错误。
  if (input.hasPreparedStep || input.battleWillResolve) return { kind: "prepared" };
  return { kind: "rule_only" };
}
