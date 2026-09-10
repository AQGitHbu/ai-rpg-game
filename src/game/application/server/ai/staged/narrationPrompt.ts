// staged narration prompt（Plan Task 5 Step 3）。
//
// 旁白是玩家视角：persona 为 null，只携带玩家可见事实、前文、受控行动与
// requiredBeats。输出契约不含任何 NPC 台词字段；最终展示文本只能来自这里。

import { renderAiRepairFeedback, type AiContentRepair } from "@/game/application/aiGenerationRetry";
import type { SafeContext } from "@/game/application/narrativeGeneration/perspectiveContext";

/** Builds the player-perspective narration prompt from a SafeContext. */
export function buildNarrationPrompt(context: SafeContext, repair?: AiContentRepair): string {
  const facts = context.visibleFacts.length > 0
    ? context.visibleFacts.map((fact) => `- ${fact.id}：${fact.text}（certainty=${fact.certainty}）`).join("\n")
    : "- 无";
  const prior = context.priorText.length > 0
    ? context.priorText.map((part) => part.text).join("\n")
    : "（无）";
  const beats = context.requiredBeats.length > 0
    ? context.requiredBeats.map((beat) =>
      `- ${beat.beatId}（${beat.kind}）：${beat.instruction}`)
    : ["- 无"];
  const actions = context.allowedActions.length > 0
    ? context.allowedActions.map((action) =>
      `- ${action.key}（${action.kind}，actor=${action.actorId}）`)
    : ["- 无"];

  return `你是 RPG 的旁白 AI。以玩家视角为当前场景写一段紧凑的旁白；不替玩家做决定，不写任何 NPC 台词或对白。
${repair === undefined ? "" : `\n# 上次生成的校验反馈\n${renderAiRepairFeedback(repair)}\n请依据原契约修复并重新输出完整 JSON。\n`}

# 场景风格
- 题材风格：${context.style}
- 玩家原话：${context.playerUtterance ?? "（无）"}

# 玩家可见事实（facts 里**只能**引用这里列出的 id；**一个都不许自己编**；不得泄露其他信息）
${facts}

# 前文（已批准的可见表达，保持连贯，不得复述）
${prior}

# 必选节拍（必须在旁白中自然承接，beatIds 原样回填）
${beats.join("\n")}

# 可引用的表演动作（actionKeys 只能引用这些 key）
${actions.join("\n")}

# 输出契约
只返回一个 JSON 对象：{"stage":"narration","parts":[{"text":"...","facts":[],"evidence":[],"beatIds":[]}],"actionKeys":[]}
- parts 是正文句段数组（1 到 12 段，单段不超过 500 字），中文。
- 每个 part 恰有 4 键：text（中文字符串）、facts、evidence、beatIds。**多一个键即整体被拒。**
- facts 是 FactUse 对象数组，**绝不可写成裸事实键数组**：
  每项恰有 2 键 {"factId": 该句引用的事实键, "certainty": "known" 或 "suspected"}；
  factId **只能取上方"玩家可见事实"里逐条列出的 id**（形如 fact_0），**不得使用任何其他名字、不得自己发明**；
  不引用任何事实时写 []。certainty 必须与上方标注一致，不得升级。
  若上方"玩家可见事实"为「无」，则所有 part 的 facts 一律写 []。
- evidence：对象数组，通常为 []。引用已提交事件写 {"kind":"committed","eventId":事件键}；
  引用本单元的观察写 {"kind":"conditional","observationKey":观察键}（本单元没有观察要求时只能用 []）。
- beatIds：键数组，只能引用上方"必选节拍"列出的 beatId；无则写 []。
- actionKeys：只能引用上方"可引用的表演动作"里列出的 key；无则写 []。
- 禁止输出角色台词、选项 label 等其他 stage 的字段；本单元没有说话人。`;
}
