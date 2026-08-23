export type NarrativeContextAuthority = "rule" | "state" | "event" | "plan" | "memory" | "lore";
export type NarrativeContextRetention = "mandatory" | "optional";
export type NarrativeContextSlot =
  | "system_rules" | "world_canon" | "story_contract" | "current_state"
  | "current_resolution" | "current_location" | "focus_character"
  | "relationships" | "relevant_events" | "recent_scenes"
  | "director_guidance" | "player_action" | "legal_actions" | "output_contract";

export type NarrativeContextBlock = Readonly<{
  id: string;
  slot: NarrativeContextSlot;
  title: string;
  content: string;
  authority: NarrativeContextAuthority;
  retention: NarrativeContextRetention;
  priority: number;
  conflictKey?: string;
  source: Readonly<{ kind: string; refs: readonly string[] }>;
}>;

export type NarrativeContextDropReason = "empty" | "duplicate" | "conflict" | "budget";

export type CompiledNarrativeContextBlock = NarrativeContextBlock & Readonly<{
  estimatedTokens: number;
}>;

export type DroppedNarrativeContextBlock = Readonly<{
  id: string;
  slot: NarrativeContextSlot;
  sourceKind: string;
  sourceRefs: readonly string[];
  estimatedTokens: number;
  reason: NarrativeContextDropReason;
}>;

export type NarrativeContextManifest = Readonly<{
  compilerVersion: 1;
  maxEstimatedTokens: number;
  selectedEstimatedTokens: number;
  overflowEstimatedTokens: number;
  selected: readonly Omit<DroppedNarrativeContextBlock, "reason">[];
  dropped: readonly DroppedNarrativeContextBlock[];
}>;

export type CompiledNarrativeContext = Readonly<{
  selected: readonly CompiledNarrativeContextBlock[];
  dropped: readonly DroppedNarrativeContextBlock[];
  selectedEstimatedTokens: number;
  overflowEstimatedTokens: number;
  manifest: NarrativeContextManifest;
}>;

export const NARRATIVE_CONTEXT_COMPILER_VERSION = 1 as const;
export const NARRATIVE_CONTEXT_HEADER = "[NARRATIVE_CONTEXT v1]" as const;
export const NARRATIVE_CONTEXT_AUTHORITY_ORDER: readonly NarrativeContextAuthority[] = [
  "rule", "state", "event", "plan", "memory", "lore",
];
export const NARRATIVE_CONTEXT_DROP_REASON_ORDER: readonly NarrativeContextDropReason[] = [
  "empty", "duplicate", "conflict", "budget",
];
export const NARRATIVE_CONTEXT_SLOT_ORDER: readonly NarrativeContextSlot[] = [
  "system_rules", "world_canon", "story_contract", "current_state",
  "current_resolution", "current_location", "focus_character", "relationships",
  "relevant_events", "recent_scenes", "director_guidance", "player_action",
  "legal_actions", "output_contract",
];
