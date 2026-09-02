// ---------------------------------------------------------------------------
// Phase 13：NPC 关系值类型。
// 纯 domain 类型，零依赖。单维度好感度，类型预留多维度扩展。
// 旧存档缺省 relationship 字段时安全回退到中立。
// ---------------------------------------------------------------------------

export type RelationshipTier = "hostile" | "cold" | "neutral" | "friendly" | "trusted";

/** 关系值。单维度好感度，结构体预留未来扩展为多维度。 */
export type RelationshipValue = {
  readonly affinity: number;  // -100 ~ +100
};

export const RELATIONSHIP_MIN = -100;
export const RELATIONSHIP_MAX = 100;

/** 关系值 → 档位（纯函数）。 */
export function relationshipTierOf(value: RelationshipValue): RelationshipTier {
  if (value.affinity <= -60) return "hostile";
  if (value.affinity <= -20) return "cold";
  if (value.affinity < 20) return "neutral";
  if (value.affinity < 60) return "friendly";
  return "trusted";
}

/** 安全 clamp 到 [-100, 100]。 */
export function clampAffinity(affinity: number): number {
  return Math.max(RELATIONSHIP_MIN, Math.min(RELATIONSHIP_MAX, affinity));
}
