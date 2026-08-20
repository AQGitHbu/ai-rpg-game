import type { Interaction, Action } from "@/game/domain/action";
import {
  preClassifyFreeText,
  type IntentContext,
  type IntentParserSource,
  type IntentAuditLink,
} from "@/game/gameplay/rpg/intentParser";
import type { NpcId } from "@/game/domain/worldEntity";

export type ActionChoiceMap = ReadonlyMap<string, Action>;

export type ConvertFreeTextDeps = {
  readonly intentContext: IntentContext;
  readonly intentParserSource?: IntentParserSource;
  /** Task 9：自由输入显式绑定的目标 NPC（如对 NPC 说话/问候），透传给意图源做目标合法性校验。 */
  readonly targetNpcId?: NpcId;
  /** 仅用于关联 intent AI 审计事件，不参与意图判断。 */
  readonly auditLink?: IntentAuditLink;
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

  // A custom response rendered under a focused NPC is dialogue by transport
  // contract. Do not let movement/item keywords escape that authority before
  // the dialogue intent has been classified. The server use case validates
  // that this target is the authoritative scene focus before calling here.
  const targetNpcId = freeTextDeps?.targetNpcId;
  if (targetNpcId !== undefined) {
    if (freeTextDeps?.intentParserSource !== undefined) {
      const classified = await freeTextDeps.intentParserSource.parseIntent(
        text,
        ctx,
        targetNpcId,
        freeTextDeps?.auditLink,
      );
      if (
        classified.ok
        && classified.action.type === "talk"
        && classified.action.npcId === targetNpcId
      ) {
        return { ok: true, action: classified.action };
      }
    }
    return {
      ok: true,
      action: {
        type: "talk",
        npcId: targetNpcId,
        dialogueAct: "ask",
        utterance: text.trim(),
      },
    };
  }

  // 1. 纯规则预分类（零 AI）
  const preClassified = preClassifyFreeText(text, ctx);
  if (preClassified !== null) {
    return { ok: true, action: preClassified };
  }

  // 2. AI 意图解析（如果有 source）；目标 NPC 透传做目标合法性校验
  if (freeTextDeps?.intentParserSource !== undefined) {
    const aiResult = await freeTextDeps.intentParserSource.parseIntent(
      text,
      ctx,
      freeTextDeps.targetNpcId,
      freeTextDeps.auditLink,
    );
    if (aiResult.ok) {
      return { ok: true, action: aiResult.action };
    }
  }

  // 3. 降级为 freeform
  return { ok: true, action: { type: "freeform", intent: "unclassified", rawText: text } };
}
