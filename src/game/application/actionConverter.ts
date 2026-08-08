import type { Interaction, Action } from "@/game/domain/action";
import type { IntentContext } from "@/game/gameplay/rpg/intentParser/intentContext";
import { preClassifyFreeText } from "@/game/gameplay/rpg/intentParser/preClassify";
import type { IntentParserSource } from "@/game/gameplay/rpg/intentParser/intentParserSource";
import type { NpcId } from "@/game/domain/scenarioBlueprint";

export type ActionChoiceMap = ReadonlyMap<string, Action>;

export type ConvertFreeTextDeps = {
  readonly intentContext: IntentContext;
  readonly intentParserSource?: IntentParserSource;
  /** Task 9：自由输入显式绑定的目标 NPC（如对 NPC 说话/问候），透传给意图源做目标合法性校验。 */
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

  // free_text 路径
  const text = interaction.text;
  const ctx = freeTextDeps?.intentContext;

  // 无上下文时直接 freeform
  if (ctx === undefined) {
    return { ok: true, action: { type: "freeform", intent: "unclassified", rawText: text } };
  }

  // 1. 纯规则预分类（零 AI）
  const preClassified = preClassifyFreeText(text, ctx);
  if (preClassified !== null) {
    return { ok: true, action: preClassified };
  }

  // 2. AI 意图解析（如果有 source）；目标 NPC 透传做目标合法性校验
  if (freeTextDeps?.intentParserSource !== undefined) {
    const aiResult = await freeTextDeps.intentParserSource.parseIntent(text, ctx, freeTextDeps.targetNpcId);
    if (aiResult.ok) {
      return { ok: true, action: aiResult.action };
    }
  }

  // 3. 降级为 freeform
  return { ok: true, action: { type: "freeform", intent: "unclassified", rawText: text } };
}
