import type { FactId } from "@/game/domain/worldEntity";
import type { RelationshipTier } from "@/game/domain/relationship";
import { DIALOGUE_TIER_CANDIDNESS, DIALOGUE_REVEAL_THRESHOLD } from "@/game/gameplay/rpg/dialogue/dialogueResolution";

// ---------------------------------------------------------------------------
// Task 5 Step 1：关系档位 → NPC 回应政策（tone/initiative/披露边界）。
// 纯函数：同一 tier 恒定映射；披露集合由规则常量推导（不交给 AI 自选）。
// ---------------------------------------------------------------------------

export type NpcResponsePolicy = {
  readonly tier: RelationshipTier;
  readonly toneInstruction: string;
  readonly initiative: "refuse" | "guarded" | "reactive" | "helpful" | "proactive";
  readonly allowedDisclosureFactIds: readonly FactId[];
  readonly privateKnowledgeIds: readonly FactId[];
};

const POLICY_BY_TIER: Readonly<
  Record<RelationshipTier, { readonly toneInstruction: string; readonly initiative: NpcResponsePolicy["initiative"] }>
> = {
  hostile: {
    toneInstruction: "简短冷淡，拒绝配合，只做必要回应。",
    initiative: "refuse",
  },
  cold: {
    toneInstruction: "谨慎防备，回答简短，只谈表面的公事。",
    initiative: "guarded",
  },
  neutral: {
    toneInstruction: "就事论事，照实回答，不主动展开。",
    initiative: "reactive",
  },
  friendly: {
    toneInstruction: "温和友好，乐于帮忙，适度主动提供帮助。",
    initiative: "helpful",
  },
  trusted: {
    toneInstruction: "坦诚相待，主动说明情况并给出建议。",
    initiative: "proactive",
  },
};

export function createNpcResponsePolicy(input: {
  readonly tier: RelationshipTier;
  readonly allowedDisclosureFactIds: readonly FactId[];
  readonly privateKnowledgeIds: readonly FactId[];
}): NpcResponsePolicy {
  const base = POLICY_BY_TIER[input.tier];
  return {
    tier: input.tier,
    toneInstruction: base.toneInstruction,
    initiative: base.initiative,
    allowedDisclosureFactIds: [...input.allowedDisclosureFactIds],
    privateKnowledgeIds: [...input.privateKnowledgeIds],
  };
}

/**
 * 披露集合（规则所有）：已知且非私密，且该档位的基线坦诚度达标。
 * 与 dialogueResolution 的披露裁决同源（ask 压力为零时的口径）。
 */
export function selectAllowedDisclosureFactIds(input: {
  readonly tier: RelationshipTier;
  readonly knownFactIds: readonly FactId[];
  readonly hiddenFactIds: readonly FactId[];
}): FactId[] {
  const candid = DIALOGUE_TIER_CANDIDNESS[input.tier] >= DIALOGUE_REVEAL_THRESHOLD;
  if (!candid) return [];
  return input.knownFactIds.filter((id) => !input.hiddenFactIds.includes(id));
}