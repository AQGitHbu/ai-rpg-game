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
