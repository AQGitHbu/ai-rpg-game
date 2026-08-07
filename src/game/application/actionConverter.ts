import type { Interaction, Action } from "@/game/domain/action";

export type ActionChoiceMap = ReadonlyMap<string, Action>;

export type ConvertResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unknown_choice" | "free_text_not_supported" };

export function convertInteraction(interaction: Interaction, choiceMap: ActionChoiceMap): ConvertResult {
  if (interaction.kind === "fixed_choice") {
    const action = choiceMap.get(interaction.choiceToken);
    if (action === undefined) return { ok: false, reason: "unknown_choice" };
    return { ok: true, action };
  }
  return { ok: false, reason: "free_text_not_supported" };
}
