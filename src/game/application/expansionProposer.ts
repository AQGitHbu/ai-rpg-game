import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";
import type { ExpansionSource, ExpansionSourceResult } from "@/game/gameplay/rpg/expansion/expansionSource";
import type { ExpansionResult } from "@/game/gameplay/rpg/expansion/expansionTypes";
import { checkExpansionTrigger, runExpansionProposer } from "@/game/gameplay/rpg/expansion";

// ---------------------------------------------------------------------------
// Task 28：application 层 Expansion 编排（从 performTurn 抽出，独立可测）。
//
// 职责：纯触发 →（条件）await source 提案 → 纯审批/重演算。
// - source 抛错或返回失败时以“无提案”降级，绝不炸穿回合流水线。
// - 只做编排与状态映射，不写状态、不做 AI 调用；提案的审批/应用/重演算
//   全部由 gameplay expansion 纯函数负责。
// ---------------------------------------------------------------------------

export type RunExpansionProposerInput = {
  readonly initialResult: RuleEngineResult;
  readonly ws: WorldState;
  readonly ss: StoryState;
  readonly action: Action;
  readonly actionId: string;
  readonly expansionSource: ExpansionSource | undefined;
  readonly now: () => string;
};

/**
 * application 编排 Expansion：纯触发 →（条件）await source 提案 → 纯审批/重演算。
 * source 抛错或返回失败时以“无提案”降级，绝不炸穿回合流水线。
 */
export async function runExpansionOrchestration(input: RunExpansionProposerInput): Promise<ExpansionResult> {
  const trigger = checkExpansionTrigger(input.initialResult, input.ws, input.ss, input.action);
  if (!trigger.triggered || !input.expansionSource) {
    return runExpansionProposer(
      input.initialResult,
      input.ws,
      input.ss,
      input.action,
      input.actionId,
      null,
      { now: input.now },
    );
  }
  let sourceResult: ExpansionSourceResult;
  try {
    sourceResult = await input.expansionSource.propose({
      worldState: input.ws,
      storyState: input.ss,
      action: input.action,
      triggerReason: trigger.reason,
    });
  } catch {
    // AI/source 失败：不破坏普通行动拒绝语义，本轮按“无提案”处理（零写入）
    return runExpansionProposer(
      input.initialResult,
      input.ws,
      input.ss,
      input.action,
      input.actionId,
      null,
      { now: input.now },
    );
  }
  return runExpansionProposer(
    input.initialResult,
    input.ws,
    input.ss,
    input.action,
    input.actionId,
    sourceResult.proposals,
    { now: input.now },
  );
}
