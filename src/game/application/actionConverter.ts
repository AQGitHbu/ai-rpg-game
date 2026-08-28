import type { Interaction, Action } from "@/game/domain/action";
import type { NpcId } from "@/game/domain/worldEntity";

export type ActionChoiceMap = ReadonlyMap<string, Action>;

export type ConvertFreeTextDeps = {
  /** @deprecated 仅供旧离线测试调用；运行时不读取。 */
  readonly intentContext?: unknown;
  /** @deprecated 运行时不读取，保留以便旧测试显式证明没有调用。 */
  readonly intentParserSource?: unknown;
  /** @deprecated 运行时不读取。 */
  readonly auditLink?: unknown;
  /** 自定义输入只能提交给已经由当前场景授权的焦点 NPC。 */
  readonly targetNpcId?: NpcId;
};

export type ConvertResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unknown_choice" };

export async function convertInteraction(
  interaction: Interaction,
  choiceMap: ActionChoiceMap,
  freeTextDeps?: ConvertFreeTextDeps,
): Promise<ConvertResult> {
  if (interaction.kind === "fixed_choice") {
    const action = choiceMap.get(interaction.choiceToken);
    if (action === undefined) return { ok: false, reason: "unknown_choice" };
    return { ok: true, action };
  }

  // 自定义输入是一个正式叙事边界。它不做独立的意图 AI 调用；唯一的
  // NarrativeBundleSource 会连同原文理解其语气和语义。
  const targetNpcId = freeTextDeps?.targetNpcId;
  if (targetNpcId !== undefined) {
    return {
      ok: true,
      action: {
        type: "talk",
        npcId: targetNpcId,
        dialogueAct: "ask",
        utterance: interaction.text.trim(),
      },
    };
  }
  return { ok: false, reason: "unknown_choice" };
}
