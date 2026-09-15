import type { NpcCooperationDefinition, StoryCondition } from "./storyInteraction";
import type { InvestigationApproach } from "./worldEntries";

export type StoryConditionProposal =
  | Readonly<{ kind: "has_item"; itemId: string; ownerId: string }>
  | Readonly<{ kind: "knows_fact"; actorId: string; factId: string }>
  | Readonly<{ kind: "promise_status"; npcId: string; promiseId: string; status: "open" | "fulfilled" | "broken" | "released" }>
  | (Readonly<{ kind: "goal_status"; npcId: string; status: "active" | "blocked" | "completed" | "abandoned" }>
    & (Readonly<{ goalId: string; goalOrdinal?: never }> | Readonly<{ goalOrdinal: number; goalId?: never }>))
  | Readonly<{ kind: "investigation_observed"; npcId: string; factId: string; evidenceQuality: "clean" | "noisy" }>;

export type NpcGoalResolutionProposal = Readonly<{
  completeWhen: readonly StoryConditionProposal[];
  blockWhen: readonly StoryConditionProposal[];
}>;

export type InvestigationApproachProposal = Omit<InvestigationApproach, "requirements" | "witnessNpcIds"> & Readonly<{
  requirements?: readonly StoryConditionProposal[];
  witnessNpcIds?: readonly string[];
}>;

export type NpcCooperationDefinitionProposal = Readonly<{
  operation: NpcCooperationDefinition["operation"];
  requirements: readonly StoryConditionProposal[];
  allowedFactIds: readonly string[];
  allowedAudienceIds: readonly string[];
}>;

export type StoryConsequenceBindingProposal =
  | Readonly<{ kind: "bind_goal_resolution"; npcRef: string; goalOrdinal: number; resolution: NpcGoalResolutionProposal }>
  | Readonly<{ kind: "bind_investigation"; factRef: string; discoveryMode: "investigation"; approaches: readonly InvestigationApproachProposal[] }>
  | Readonly<{ kind: "bind_talk_completion"; questRef: string; npcRef: string; conditions: readonly StoryConditionProposal[] }>
  | Readonly<{ kind: "bind_npc_cooperation"; npcRef: string; definitions: readonly NpcCooperationDefinitionProposal[] }>;

export type StoryConsequenceBindingsProposal = readonly StoryConsequenceBindingProposal[];

export type ResolvedStoryCondition = StoryCondition;

function hasNoUnknownKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}
const MIN_APPROACH_COUNT = 2;
const MAX_APPROACH_COUNT = 3;
const MIN_TENSION_DELTA = -5;
const MAX_TENSION_DELTA = 20;

function isStoryConditionProposal(value: unknown): value is StoryConditionProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const condition = value as Record<string, unknown>;
  if (typeof condition.kind !== "string") return false;
  switch (condition.kind) {
    case "has_item":
      return hasNoUnknownKeys(condition, ["kind", "itemId", "ownerId"])
        && isNonEmptyString(condition.itemId) && isNonEmptyString(condition.ownerId);
    case "knows_fact":
      return hasNoUnknownKeys(condition, ["kind", "actorId", "factId"])
        && isNonEmptyString(condition.actorId) && isNonEmptyString(condition.factId);
    case "promise_status":
      return hasNoUnknownKeys(condition, ["kind", "npcId", "promiseId", "status"])
        && isNonEmptyString(condition.npcId) && isNonEmptyString(condition.promiseId)
        && ["open", "fulfilled", "broken", "released"].includes(condition.status as string);
    case "goal_status": {
      if (!hasNoUnknownKeys(condition, ["kind", "npcId", "status", "goalId", "goalOrdinal"])
        || !isNonEmptyString(condition.npcId)
        || !["active", "blocked", "completed", "abandoned"].includes(condition.status as string)) return false;
      const hasGoalId = isNonEmptyString(condition.goalId);
      const hasGoalOrdinal = Number.isInteger(condition.goalOrdinal) && (condition.goalOrdinal as number) >= 0;
      return hasGoalId !== hasGoalOrdinal
        && (("goalId" in condition) !== ("goalOrdinal" in condition));
    }
    case "investigation_observed":
      return hasNoUnknownKeys(condition, ["kind", "npcId", "factId", "evidenceQuality"])
        && isNonEmptyString(condition.npcId) && isNonEmptyString(condition.factId)
        && ["clean", "noisy"].includes(condition.evidenceQuality as string);
    default:
      return false;
  }
}

function isConditionArray(value: unknown): value is readonly StoryConditionProposal[] {
  return Array.isArray(value) && value.every(isStoryConditionProposal);
}

function isInvestigationApproachProposal(value: unknown): value is InvestigationApproachProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const approach = value as Record<string, unknown>;
  if (!hasNoUnknownKeys(approach, ["approachId", "label", "hint", "evidenceQuality", "tensionDelta", "requirements", "witnessNpcIds"])
    || !isNonEmptyString(approach.approachId)
    || !isNonEmptyString(approach.label)
    || (approach.hint !== undefined && !isNonEmptyString(approach.hint))
    || !["clean", "noisy"].includes(approach.evidenceQuality as string)
    || typeof approach.tensionDelta !== "number"
    || !Number.isFinite(approach.tensionDelta)
    || approach.tensionDelta < MIN_TENSION_DELTA
    || approach.tensionDelta > MAX_TENSION_DELTA) return false;
  return (approach.requirements === undefined || isConditionArray(approach.requirements))
    && (approach.witnessNpcIds === undefined
      || (isStringArray(approach.witnessNpcIds) && approach.witnessNpcIds.every(isNonEmptyString)));
}

export function isStoryConsequenceBindingsProposal(value: unknown): value is StoryConsequenceBindingsProposal {
  if (!Array.isArray(value) || value.length > 8) return false;
  return value.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const binding = entry as Record<string, unknown>;
    switch (binding.kind) {
      case "bind_goal_resolution": {
        const resolution = binding.resolution;
        return hasNoUnknownKeys(binding, ["kind", "npcRef", "goalOrdinal", "resolution"])
          && isNonEmptyString(binding.npcRef)
          && Number.isInteger(binding.goalOrdinal) && (binding.goalOrdinal as number) >= 0
          && typeof resolution === "object" && resolution !== null && !Array.isArray(resolution)
          && hasNoUnknownKeys(resolution as Record<string, unknown>, ["completeWhen", "blockWhen"])
          && isConditionArray((resolution as Record<string, unknown>).completeWhen)
          && isConditionArray((resolution as Record<string, unknown>).blockWhen)
          && ((resolution as Record<string, unknown>).completeWhen as unknown[]).length <= 4
          && ((resolution as Record<string, unknown>).blockWhen as unknown[]).length <= 4;
      }
      case "bind_investigation":
        return hasNoUnknownKeys(binding, ["kind", "factRef", "discoveryMode", "approaches"])
          && isNonEmptyString(binding.factRef)
          && binding.discoveryMode === "investigation"
          && Array.isArray(binding.approaches)
          && binding.approaches.length >= MIN_APPROACH_COUNT
          && binding.approaches.length <= MAX_APPROACH_COUNT
          && binding.approaches.every(isInvestigationApproachProposal);
      case "bind_talk_completion":
        return hasNoUnknownKeys(binding, ["kind", "questRef", "npcRef", "conditions"])
          && isNonEmptyString(binding.questRef)
          && isNonEmptyString(binding.npcRef)
          && isConditionArray(binding.conditions) && binding.conditions.length > 0;
      case "bind_npc_cooperation": {
        if (!hasNoUnknownKeys(binding, ["kind", "npcRef", "definitions"])
          || !isNonEmptyString(binding.npcRef)
          || !Array.isArray(binding.definitions) || binding.definitions.length > 2) return false;
        return binding.definitions.every((definition) => {
          if (typeof definition !== "object" || definition === null || Array.isArray(definition)) return false;
          const value = definition as Record<string, unknown>;
          return hasNoUnknownKeys(value, ["operation", "requirements", "allowedFactIds", "allowedAudienceIds"])
            && ["request_introduction", "request_verification"].includes(value.operation as string)
            && isConditionArray(value.requirements)
            && isStringArray(value.allowedFactIds)
            && value.allowedFactIds.every(isNonEmptyString)
            && isStringArray(value.allowedAudienceIds)
            && value.allowedAudienceIds.every(isNonEmptyString);
        });
      }
      default:
        return false;
    }
  });
}
