import type { EndingDefinition, ScenarioBlueprint } from "@/game/domain";

// ---------------------------------------------------------------------------
// Phase 14 Task 8：将审批通过的结局追加到 blueprint.endings（spec §applyEndingToBlueprint）。
//
// 纯函数：不可变更新——展开蓝图并 append approvedEnding 到 endings[]，绝不
// 修改入参。调用方（application 层）负责通过 CAS（applyBlueprintExpansion）
// 落库新蓝图与 state；本函数不写库、不读 IO。
// ---------------------------------------------------------------------------

export type ApplyEndingToBlueprintInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly approvedEnding: EndingDefinition;
};

/**
 * 把 approvedEnding 追加到 blueprint.endings[]，返回新蓝图（不可变更新）。
 * 不修改原蓝图的任何字段；endings 数组以浅拷贝 + append 方式构造。
 */
export function applyEndingToBlueprint(
  input: ApplyEndingToBlueprintInput,
): ScenarioBlueprint {
  const { blueprint, approvedEnding } = input;
  return {
    ...blueprint,
    endings: [...blueprint.endings, approvedEnding],
  } as ScenarioBlueprint;
}
