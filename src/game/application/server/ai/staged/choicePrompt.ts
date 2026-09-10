// staged choice prompt（Plan Task 5 Step 3）。
//
// 选项是玩家视角：从已审批 choiceExpression 投影候选意图（ending 臂不需要
// RouteTarget）。只返回两条 id/label；label 只能是玩家直接说出的对白，
// 禁止前缀、效果说明与表演动作。

import { renderAiRepairFeedback, type AiContentRepair } from "@/game/application/aiGenerationRetry";
import type { SafeContext } from "@/game/application/narrativeGeneration/perspectiveContext";

/** Builds the choice-label prompt from a SafeContext. */
export function buildChoicePrompt(context: SafeContext, repair?: AiContentRepair): string {
  const options = context.options.map((option) =>
    `- ${option.candidateId}（act=${option.dialogueAct}）：${option.publicIntent.text}`);
  const prior = context.priorText.length > 0
    ? context.priorText.map((part) => part.text).join("\n")
    : "（无）";
  const kind = context.choiceKind === "ending"
    ? "终幕选择：两个候选是 trust（支持）与 doubt（质疑）两种抽象立场，都是开放价值方向，不是已决定的结局。"
    : "普通对话决策：两个候选是对同一焦点的不同对话意图。";

  return `你是 RPG 的选项表达 AI。为当前决策的两条候选拟写玩家视角的 label。只返回玩家直接说出的对白；禁止叙述、前缀、效果说明与表演动作，不得替玩家承诺结果。
${repair === undefined ? "" : `\n# 上次生成的校验反馈\n${renderAiRepairFeedback(repair)}\n请依据原契约修复并重新输出完整 JSON。\n`}

# 决策类型
${kind}

# 已批准的候选意图（candidateId 原样回填，label 忠于各自意图）
${options.join("\n")}

# 前文（已批准的可见表达，保持衔接，不得复述）
${prior}

# 场景风格
- 题材风格：${context.style}

# 输出契约
只返回一个 JSON 对象：{"stage":"choices","labels":[{"candidateId":"...","label":"..."},{"candidateId":"...","label":"..."}]}
- labels 恰好两条；candidateId 与上方候选一一对应；label 是一句玩家对该焦点 NPC 说的中文对白（不超过 80 字）。
- label 中不得出现"前往/拿出/调出"等物理行动冒充对话，不得包含规则效果、提示前缀或方括号注记。`;
}
