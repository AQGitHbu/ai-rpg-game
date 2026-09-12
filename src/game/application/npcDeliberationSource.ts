import { isWellFormedEventId, type NarrativeJobId, type EventId } from "@/game/domain/events";
import type { FactId, NpcId } from "@/game/domain/worldEntity";
import type { StoryInteractionProposal } from "@/game/domain/storyInteraction";
import { parseStoryInteractionProposal } from "@/game/domain/storyInteraction";

export type NpcDeliberationInput = Readonly<{
  readonly npcId: NpcId;
  readonly jobId: NarrativeJobId;
  readonly candidateVersion: number;
  /** Private, NPC-scoped structured context. It is never a player-facing prompt. */
  readonly privateContext: string;
}>;

export const NPC_DELIBERATION_RESPONSES = [
  "cooperate",
  "refuse",
  "question",
  "offer_condition",
] as const;

export type NpcDeliberationResponse = (typeof NPC_DELIBERATION_RESPONSES)[number];

export type NpcDeliberationProposal = Readonly<{
  readonly npcId: NpcId;
  readonly goalIds: readonly string[];
  readonly response: NpcDeliberationResponse;
  readonly evidenceEventIds: readonly EventId[];
  readonly discloseFactIds: readonly FactId[];
  readonly interactionProposals: readonly StoryInteractionProposal[];
}>;

export interface NpcDeliberationSource {
  generate(input: NpcDeliberationInput): Promise<
    { readonly ok: true; readonly proposal: NpcDeliberationProposal }
    | { readonly ok: false; readonly code: "PROVIDER_FAILURE" | "INVALID_PROPOSAL" }
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

/** Strict provider boundary parser. Store/ledger authority is deliberately checked later. */
export function parseNpcDeliberationProposal(value: unknown): NpcDeliberationProposal | null {
  if (!isRecord(value)) return null;
  const keys = [
    "npcId",
    "goalIds",
    "response",
    "evidenceEventIds",
    "discloseFactIds",
    "interactionProposals",
  ] as const;
  const allowed = new Set(keys);
  if (keys.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key as typeof keys[number]))) {
    return null;
  }
  if (!isNonEmptyString(value.npcId)
    || !isUniqueStringArray(value.goalIds)
    || !NPC_DELIBERATION_RESPONSES.includes(value.response as NpcDeliberationResponse)
    || !isUniqueStringArray(value.evidenceEventIds)
    || !value.evidenceEventIds.every(isWellFormedEventId)
    || !isUniqueStringArray(value.discloseFactIds)
    || !Array.isArray(value.interactionProposals)) {
    return null;
  }
  const interactionProposals: StoryInteractionProposal[] = [];
  for (const [index, rawProposal] of value.interactionProposals.entries()) {
    const parsed = parseStoryInteractionProposal(rawProposal, `interactionProposals[${index}]`);
    if (!parsed.ok) return null;
    interactionProposals.push(parsed.value);
  }
  return {
    npcId: value.npcId as NpcId,
    goalIds: value.goalIds,
    response: value.response as NpcDeliberationResponse,
    evidenceEventIds: value.evidenceEventIds as EventId[],
    discloseFactIds: value.discloseFactIds as FactId[],
    interactionProposals,
  };
}
