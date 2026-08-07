import type { LocationEntry, NpcEntry, ItemEntry, EnemyEntry, WorldFactEntry } from "@/game/domain/worldState";
import type { StoryBudget } from "@/game/domain/storyBudget";
import type { RuleEngineResult } from "@/game/gameplay/rpg/ruleEngine";

/** 扩展提案——AI 返回的原始提案，待审批 */
export type ExpansionProposal =
  | {
      readonly kind: "location";
      readonly name: string;
      readonly description: string;
      readonly scale: "scene" | "town";
      readonly connectFromLocationId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "npc";
      readonly name: string;
      readonly role: string;
      readonly description: string;
      readonly locationId: string;
    }
  | {
      readonly kind: "item";
      readonly name: string;
      readonly description: string;
      readonly kind_hint: string;
      readonly tags: readonly string[];
      readonly locationId: string;
    }
  | {
      readonly kind: "enemy";
      readonly name: string;
      readonly tier: "normal" | "boss";
      readonly stats: { readonly hp: number; readonly attack: number; readonly defense: number };
      readonly locationId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "fact";
      readonly text: string;
      readonly locationId: string;
      readonly reason: string;
    };

/** 审批拒绝原因 */
export type ExpansionRejection =
  | "budget_exceeded"
  | "hard_limit_exceeded"
  | "invalid_payload"
  | "id_collision"
  | "reference_broken"
  | "pacing_locked"
  | "endgame_locked";

/** 已审批的扩展——通过审批的提案，转换为 Entry 类型 */
export type ApprovedExpansion = {
  readonly newLocations: readonly LocationEntry[];
  readonly newNpcs: readonly NpcEntry[];
  readonly newItems: readonly ItemEntry[];
  readonly newEnemies: readonly EnemyEntry[];
  readonly newFacts: readonly WorldFactEntry[];
  readonly budgetConsumed: {
    readonly locations: number;
    readonly npcs: number;
    readonly items: number;
    readonly enemies: number;
    readonly facts: number;
  };
};

/** 扩展触发原因 */
export type ExpansionTriggerReason =
  | "entity_not_found"
  | "low_tension"
  | "quest_gap";

/** 扩展结果 */
export type ExpansionResult = {
  readonly triggered: boolean;
  readonly reason: ExpansionTriggerReason | "no_trigger";
  readonly approved: ApprovedExpansion | null;
  readonly nextBudget: StoryBudget | null;
  readonly reEvaluatedResult: RuleEngineResult | null;
  readonly rejectedProposals: readonly { readonly proposal: ExpansionProposal; readonly reason: ExpansionRejection }[];
};
