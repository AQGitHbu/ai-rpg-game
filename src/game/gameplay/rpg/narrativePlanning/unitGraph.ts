import type { ChoiceExpression } from "@/game/domain/narrativeBranch";
import type { Observation } from "@/game/domain/narrativeObservation";
import type { Unit } from "@/game/domain/narrativeUnit";
import { MAX_PLAN_UNITS } from "@/game/domain/narrativePlan";

// ---------------------------------------------------------------------------
// 表达单元依赖图：同点内的就绪顺序与整包结构性校验。
// 图必须无环；同一点内未来单元在上游单元通过审批前不可见。
// ---------------------------------------------------------------------------

/** 返回新就绪的单元：依赖已全部通过审批且自身尚未批准；保持输入顺序。 */
export function readyUnits(
  units: readonly Unit[],
  approvedKeys: ReadonlySet<string>,
): readonly Unit[] {
  return units.filter((unit) => !approvedKeys.has(unit.key)
    && unit.dependencies.every((dep) => approvedKeys.has(dep)));
}

export type UnitGraphCheckResult =
  | { readonly ok: true; readonly value: true }
  | { readonly ok: false; readonly code: UnitGraphIssueCode };

export type UnitGraphIssueCode =
  | "duplicate_unit_key"
  | "unknown_dependency"
  | "dependency_cycle"
  | "unit_cap_exceeded"
  | "decision_unit_mismatch"
  | "observation_without_source"
  | "unit_after_decision";

/** 拓扑排序检测环：返回 null 表示无环，否则返回环上任意成员。 */
function findCycle(units: readonly Unit[]): string | null {
  const color = new Map<string, "visiting" | "done">();
  const visit = (key: string): string | null => {
    const state = color.get(key);
    if (state === "visiting") return key;
    if (state === "done") return null;
    color.set(key, "visiting");
    const unit = units.find((u) => u.key === key);
    if (unit !== undefined) {
      for (const dep of unit.dependencies) {
        const cycle = visit(dep);
        if (cycle !== null) return cycle;
      }
    }
    color.set(key, "done");
    return null;
  };
  for (const unit of units) {
    const cycle = visit(unit.key);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * 结构性校验整包单元图：
 * - key 唯一、依赖必须存在、图无环；
 * - 表达单元数 ≤ MAX_PLAN_UNITS（39）；
 * - choices 单元数量与 proposal.decision 的存在性一致（1 个决策单元）；
 * - 有决策时片段至决策点止，不允许排在决策点之后的单元；
 * - 单元要求的观察必须有同 point 的观察来源（无来源知识传播禁止）。
 */
export function checkUnitGraph(input: {
  readonly units: readonly Unit[];
  readonly observations: readonly Observation[];
  readonly decision: ChoiceExpression | null;
}): UnitGraphCheckResult {
  const { units, observations, decision } = input;

  if (units.length > MAX_PLAN_UNITS) return { ok: false, code: "unit_cap_exceeded" };

  const keys = new Set<string>();
  for (const unit of units) {
    if (keys.has(unit.key)) return { ok: false, code: "duplicate_unit_key" };
    keys.add(unit.key);
  }
  for (const unit of units) {
    for (const dep of unit.dependencies) {
      if (!keys.has(dep)) return { ok: false, code: "unknown_dependency" };
    }
  }
  if (findCycle(units) !== null) return { ok: false, code: "dependency_cycle" };

  const choiceUnits = units.filter((u) => u.stage === "choices");
  if (decision === null ? choiceUnits.length !== 0 : choiceUnits.length !== 1) {
    return { ok: false, code: "decision_unit_mismatch" };
  }
  if (decision !== null) {
    const decisionUnit = choiceUnits[0]!;
    for (const unit of units) {
      if (unit.point.stepKey !== decisionUnit.point.stepKey) continue;
      if (unit.point.order > decisionUnit.point.order) {
        return { ok: false, code: "unit_after_decision" };
      }
    }
  }

  for (const unit of units) {
    for (const observationKey of unit.requiredObservationKeys) {
      const sourced = observations.some(
        (o) => o.key === observationKey
          && o.point.stepKey === unit.point.stepKey
          && o.point.order <= unit.point.order
          && (unit.speakerId === null || o.audienceIds.includes(unit.speakerId)),
      );
      if (!sourced) return { ok: false, code: "observation_without_source" };
    }
  }

  return { ok: true, value: true };
}
