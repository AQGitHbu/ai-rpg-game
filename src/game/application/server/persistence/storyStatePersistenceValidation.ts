import { parseEpisodicMemory, rebuildEpisodicMemory, type EpisodicMemoryState } from "@/game/domain/episodicMemory";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import { parseNarrativeRuntimeState } from "@/game/domain/narrative";
import {
  classifyStoryStateSchemaVersion,
  type StoryState,
  type PacingNeed,
} from "@/game/domain/storyState";

export type PersistableStoryStateValidationResult =
  | { readonly ok: true; readonly value: StoryState }
  | { readonly ok: false; readonly code: "UNSUPPORTED_RECORD" | "VERSION_MISMATCH" | "INVALID_STORY_STATE" };

type JsonObject = Record<string, unknown>;

const REQUIRED_STORY_KEYS = [
  "version", "turnNumber", "currentAct", "targetActs", "storyProgress", "tension", "nextPacingNeed",
  "budget", "unresolvedThreads", "candidateEventPool", "endingAllowed", "endingProposed", "narrative",
  "prologueShown", "prologueText", "memory", "contract", "evolution",
] as const;
const ALL_STORY_KEYS = [...REQUIRED_STORY_KEYS, "reveal"] as const;
const PACING_NEEDS: readonly PacingNeed[] = ["reveal", "develop", "complicate", "escalate", "climax", "resolve"];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactStoryKeys(value: JsonObject): boolean {
  const actual = Object.keys(value);
  return actual.every((key) => (ALL_STORY_KEYS as readonly string[]).includes(key))
    && REQUIRED_STORY_KEYS.every((key) => key in value && value[key] !== undefined)
    && ("reveal" in value ? value.reveal !== undefined : true);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isReveal(value: unknown): boolean {
  if (value === null) return true;
  return isObject(value)
    && Object.keys(value).length === 2
    && typeof value.questId === "string"
    && isNonNegativeInteger(value.visibleObjectiveIndex);
}

function isStoryShape(value: JsonObject): value is JsonObject & {
  readonly version: number;
  readonly memory: unknown;
  readonly narrative: unknown;
} {
  return hasExactStoryKeys(value)
    && value.version === 8
    && isNonNegativeInteger(value.turnNumber)
    && isNonNegativeInteger(value.currentAct)
    && isNonNegativeInteger(value.targetActs)
    && typeof value.storyProgress === "number" && Number.isFinite(value.storyProgress)
    && typeof value.tension === "number" && Number.isFinite(value.tension)
    && typeof value.nextPacingNeed === "string" && PACING_NEEDS.includes(value.nextPacingNeed as PacingNeed)
    && isObject(value.budget)
    && isStringArray(value.unresolvedThreads)
    && Array.isArray(value.candidateEventPool)
    && typeof value.endingAllowed === "boolean"
    && typeof value.endingProposed === "boolean"
    && isObject(value.contract)
    && typeof value.prologueShown === "boolean"
    && typeof value.prologueText === "string"
    && isObject(value.evolution)
    && (!('reveal' in value) || isReveal(value.reveal));
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** SQLite boundary parser for v8 StoryState. Memory is accepted only when it
 * is byte-for-byte equivalent to the read model rebuilt from the supplied v6 world ledger. */
export function parsePersistableStoryState(
  value: unknown,
  ledger: readonly CommittedNarrativeEvent[],
): PersistableStoryStateValidationResult {
  if (!isObject(value)) return { ok: false, code: "INVALID_STORY_STATE" };
  const classification = classifyStoryStateSchemaVersion(value.version);
  if (!classification.ok) {
    return {
      ok: false,
      code: classification.code === "UNSUPPORTED_RECORD" ? "UNSUPPORTED_RECORD" : "VERSION_MISMATCH",
    };
  }
  if (!isStoryShape(value)) return { ok: false, code: "INVALID_STORY_STATE" };

  const narrative = parseNarrativeRuntimeState(value.narrative);
  if (!narrative.ok) return { ok: false, code: "INVALID_STORY_STATE" };
  const memory = parseEpisodicMemory(value.memory);
  if (!memory.ok) return { ok: false, code: "INVALID_STORY_STATE" };
  const rebuilt = rebuildEpisodicMemory(ledger);
  if (!sameJson(memory.value, rebuilt)) return { ok: false, code: "INVALID_STORY_STATE" };

  return {
    ok: true,
    value: {
      ...value,
      narrative: narrative.value,
      memory: memory.value as EpisodicMemoryState,
    } as StoryState,
  };
}
