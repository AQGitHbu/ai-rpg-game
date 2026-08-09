import type { Action } from "@/game/domain/action";
import { deriveChoiceToken } from "@/game/domain/approvedChoice";

const RUNTIME_CHOICE_SCOPE = "canonical-runtime-actions";

/**
 * Mint the opaque token shared by the canonical projector and action map.
 * The client receives only the result; it never sees or reconstructs Action.
 */
export function deriveRuntimeChoiceToken(action: Action, revision: number): string {
  return deriveChoiceToken({
    sceneId: RUNTIME_CHOICE_SCOPE,
    basedOnRevision: revision,
    action,
  });
}
