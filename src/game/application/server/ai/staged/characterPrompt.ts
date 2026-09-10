// staged character prompt（Plan Task 5 Step 3）。
//
// 角色 prompt 只接 SafeContext：人格仅公开结构化面（名/role/emotion/关系档位/
// 受控行为），可说事实 = 说话人可知 ∩ 对受众可披露；隐藏事实与禁区正文绝不进入。

import { renderAiRepairFeedback, type AiContentRepair } from "@/game/application/aiGenerationRetry";
import type { SafeContext } from "@/game/application/narrativeGeneration/perspectiveContext";

/**
 * 同一事实在「可说事实」与「必须披露的观察」两侧 certainty 不一致时列出该事实键。
 * 冲突说明只给键名与取舍规则，不泄漏任何隐藏事实内容。
 */
function contestedFactIds(context: SafeContext): readonly string[] {
  const visible = new Map(context.visibleFacts.map((fact) => [fact.id, fact.certainty]));
  const keys: string[] = [];
  for (const observation of context.requiredObservations) {
    const declared = visible.get(observation.factId);
    if (declared !== undefined && declared !== observation.certainty) keys.push(observation.factId);
  }
  return [...new Set(keys)];
}

/** Builds the single-speaker character prompt from a SafeContext. */
export function buildCharacterPrompt(context: SafeContext, repair?: AiContentRepair): string {
  const persona = context.persona;
  if (persona === null) {
    throw new Error("character prompt requires a persona; narration/choices use other prompts");
  }
  const facts = context.visibleFacts.length > 0
    ? context.visibleFacts.map((fact) => `- ${fact.id}：${fact.text}（certainty=${fact.certainty}）`).join("\n")
    : "- 无";
  const anchors = persona.anchors.length > 0
    ? persona.anchors.map((part) => `- ${part.text}`).join("\n")
    : "-（无公开锚点，按公开身份自然扮演）";
  const goals = persona.goals.length > 0
    ? persona.goals.map((part) => `- ${part.text}`).join("\n")
    : "-（无可公开目标）";
  const prior = context.priorText.length > 0
    ? context.priorText.map((part) => part.text).join("\n")
    : "（无）";
  const beats = context.requiredBeats.length > 0
    ? context.requiredBeats.map((beat) =>
      `- ${beat.beatId}（${beat.kind}）：${beat.instruction}`)
    : ["- 无"];
  const behaviors = persona.behavior.join("、");
  const tasks = context.unit.taskFactIds.length > 0
    ? context.unit.taskFactIds.join("、")
    : "（无）";
  const disclosures = context.requiredObservations.length > 0
    ? context.requiredObservations.map((observation) =>
      `- ${observation.key} → 事实 ${observation.factId}（certainty=${observation.certainty}）`).join("\n")
    : null;
  // 某事实可能同时出现在「可说事实」与「必须披露的观察」里，且两侧 certainty 不同
  // （编译层把 NPC 知识一律标 known，而规划观察可标 suspected）。同一 prompt 出现
  // 两套 certainty 会让模型无所适从，进而触发 unit_output_fact_unavailable。这里
  // 显式说明冲突时以**更低**的 certainty 为准（更保守、且两处审批都接受）。
  const contested = contestedFactIds(context);
  const contestedNote = contested.length > 0
    ? `\n注意：${contested.join("、")} 同时出现在「你可说的事实」与「必须披露的观察」中且 certainty 不同；`
      + "两边冲突时一律按更低的 certainty 写（宁可存疑，不可断言）。\n"
    : "";

  return `你是 RPG 的角色表现 AI。只扮演当前说话人，输出其对玩家说出的台词与情绪；不代替旁白，不替玩家说话，不宣布规则结果。
${repair === undefined ? "" : `\n# 上次生成的校验反馈\n${renderAiRepairFeedback(repair)}\n请依据原契约修复并重新输出完整 JSON。\n`}

# 当前说话人（公开身份）
- 名字：${persona.publicName}
- 身份：${persona.publicRole.text}
- 当前情绪：${persona.emotion}
- 与玩家关系档位：${persona.relationshipTier}
- 受控行为：${behaviors}
${anchors ? `\n# 可公开的人格锚点\n${anchors}` : ""}
${goals ? `\n# 可公开的当前目标\n${goals}` : ""}

# 本单元任务事实（台词只能围绕这些事实组织）
${tasks}

# 你可说的事实（只能引用这些事实；certainty 只可降级，不可升级）
${facts}
${contestedNote}
# 前文（已批准的可见表达，不得复述）
${prior}

# 必选节拍（必须在台词中自然承接，beatIds 原样回填）
${beats.join("\n")}
${disclosures === null ? "" : `
# 本单元必须披露的观察（硬性要求，缺一即整体被拒）
这些话必须由你在本单元的台词里说出来。每一条都必须在**某个 part 的 facts** 里出现对应的事实引用，
且 certainty 不高于下面标注（与标注相同，或降级为 suspected；**绝不可升级**）：
${disclosures}
写法示例：若上面要求披露 fact_0（certainty=known），你至少要有一个 part 写成
{"text":"...","facts":[{"factId":"fact_0","certainty":"known"}],"evidence":[],"beatIds":[]}。
只把 factId 写进 beatIds 或 evidence **不算披露**，必须写进 facts。
`}
# 场景风格
- 题材风格：${context.style}
- 玩家原话：${context.playerUtterance ?? "（无）"}

# 输出契约
只返回一个 JSON 对象：{"stage":"character","speakerId":"${context.unit.speakerId ?? ""}","parts":[{"text":"...","facts":[],"evidence":[],"beatIds":[]}],"emotion":"...","actions":[],"answeredBeatIds":[]}
- parts 是台词句段数组（1 到 12 段，单段不超过 500 字），中文。
- 每个 part 恰有 4 键：text（中文字符串）、facts、evidence、beatIds。**多一个键即整体被拒。**
- facts 是 FactUse 对象数组，**绝不可写成裸事实键数组**：
  每项恰有 2 键 {"factId": 该句引用的事实键, "certainty": "known" 或 "suspected"}；
  正确写法是 [{"factId":"ferryman_waiting","certainty":"known"}]，不是 ["ferryman_waiting"]；
  不引用任何事实时写 []。certainty 取 "known" 或 "suspected"：**不得高于**上方"你可说的事实"
  与"必须披露的观察"里标注的 certainty（两处冲突时按更低的一个；标 known 的可降级写 suspected，
  标 suspected 的绝不可写成 known）。
- evidence：对象数组，通常为 []；引用本单元的观察时写 {"kind":"conditional","observationKey":上方列出的观察键}。
- beatIds：键数组，只能引用上方"必选节拍"列出的 beatId；无则写 []。
- emotion 使用与当前情绪一致的枚举（neutral/warm/guarded/afraid/angry/sad 之一）。
- actions：对象数组，通常为 []；只能引用本单元受控行为里的动作 key，actorId 必须是本说话人。
- answeredBeatIds：键数组，只填本台词**确实承接**了的必选节拍 beatId；无则写 []。
- 受控行为含 withhold_source 时，不得说出被扣留信息的来源；含 express_uncertainty 时，对不确定事实使用传闻语气。
- 禁止输出 labels、actionKeys 等其他 stage 的字段；禁止在台词中宣布选项已被接受或规则效果已发生。`;
}
