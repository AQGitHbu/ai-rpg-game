import { parseEpisodicMemory, rebuildEpisodicMemory, type EpisodicMemoryState } from "@/game/domain/episodicMemory";
import type { CommittedNarrativeEvent } from "@/game/domain/events";
import { isWellFormedEventId } from "@/game/domain/events";
import { parseNarrativeRuntimeState } from "@/game/domain/narrative";
import { parseNarrativeHistory } from "@/game/domain/narrativeHistory";
import {
  classifyStoryStateSchemaVersion,
  STORY_STATE_SCHEMA_VERSION,
  isStoryDeliveryState,
  type StoryState,
  type PacingNeed,
} from "@/game/domain/storyState";
import { parseStoryThread, unresolvedStoryThreadIds } from "@/game/domain/storyThreads";
import { getEntity, type EntityStore } from "@/game/domain/entity";

export type PersistableStoryStateValidationResult =
  | { readonly ok: true; readonly value: StoryState }
  | { readonly ok: false; readonly code: "UNSUPPORTED_RECORD" | "VERSION_MISMATCH" | "INVALID_STORY_STATE" };

type JsonObject = Record<string, unknown>;

const REQUIRED_STORY_KEYS = [
  "version", "turnNumber", "currentAct", "targetActs", "storyProgress", "tension", "nextPacingNeed",
  "budget", "threads", "unresolvedThreads", "candidateEventPool", "endingAllowed", "endingProposed", "narrative",
  "prologueShown", "prologueText", "memory", "history", "contract", "evolution",
  "dialogueFocus",
] as const;
const ALL_STORY_KEYS = [...REQUIRED_STORY_KEYS, "history", "reveal", "delivery"] as const;
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

function isDialogueFocus(value: unknown): value is { readonly eventIds: readonly string[] } | null {
  if (value === null) return true;
  if (!isObject(value) || Object.keys(value).length !== 3) return false;
  return typeof value.npcId === "string"
    && Array.isArray(value.entityIds)
    && value.entityIds.every((id) => typeof id === "string" && id.trim() !== "")
    && new Set(value.entityIds).size === value.entityIds.length
    && Array.isArray(value.eventIds)
    && value.eventIds.every((id) => typeof id === "string" && isWellFormedEventId(id))
    && new Set(value.eventIds).size === value.eventIds.length;
}

function isStoryShape(value: JsonObject): value is JsonObject & {
  readonly version: number;
  readonly memory: unknown;
  readonly narrative: unknown;
  readonly threads: unknown;
} {
  return hasExactStoryKeys(value)
    && value.version === STORY_STATE_SCHEMA_VERSION
    && isNonNegativeInteger(value.turnNumber)
    && isNonNegativeInteger(value.currentAct)
    && isNonNegativeInteger(value.targetActs)
    && typeof value.storyProgress === "number" && Number.isFinite(value.storyProgress)
    && typeof value.tension === "number" && Number.isFinite(value.tension)
    && typeof value.nextPacingNeed === "string" && PACING_NEEDS.includes(value.nextPacingNeed as PacingNeed)
    && isObject(value.budget)
    && Array.isArray(value.threads)
    && value.threads.every((thread, index) => parseStoryThread(thread, `storyState.threads[${index}]`).ok)
    && isStringArray(value.unresolvedThreads)
    && sameJson(value.unresolvedThreads, unresolvedStoryThreadIds(value.threads.flatMap((thread) => {
      const parsed = parseStoryThread(thread);
      return parsed.ok ? [parsed.value] : [];
    })))
    && Array.isArray(value.candidateEventPool)
    && typeof value.endingAllowed === "boolean"
    && typeof value.endingProposed === "boolean"
    && isObject(value.contract)
    && (value.contract.delivery === undefined ? value.delivery === undefined : isStoryDeliveryState(value.delivery))
    && typeof value.prologueShown === "boolean"
    && typeof value.prologueText === "string"
    && isObject(value.evolution)
    && parseNarrativeHistory(value.history).ok
    && isDialogueFocus(value.dialogueFocus)
    && (!('reveal' in value) || isReveal(value.reveal));
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/** SQLite boundary parser for current StoryState. Memory is accepted only when it
 * is byte-for-byte equivalent to the read model rebuilt from the supplied world ledger. */
export function parsePersistableStoryState(
  value: unknown,
  ledger: readonly CommittedNarrativeEvent[],
  entityStore?: EntityStore,
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
  if (isStoryDeliveryState(value.delivery) && entityStore !== undefined) {
    const delivery = value.delivery;
    if (getEntity(entityStore, delivery.itemId)?.core.kind !== "item"
      || getEntity(entityStore, delivery.giverNpcId)?.core.kind !== "npc"
      || (delivery.recipientNpcId !== null && getEntity(entityStore, delivery.recipientNpcId)?.core.kind !== "npc")) {
      return { ok: false, code: "INVALID_STORY_STATE" };
    }
  }

  const narrative = parseNarrativeRuntimeState(value.narrative);
  if (!narrative.ok) return { ok: false, code: "INVALID_STORY_STATE" };
  const memory = parseEpisodicMemory(value.memory);
  if (!memory.ok) return { ok: false, code: "INVALID_STORY_STATE" };
  const history = parseNarrativeHistory(value.history);
  if (!history.ok) return { ok: false, code: "INVALID_STORY_STATE" };
  const rebuilt = rebuildEpisodicMemory(ledger);
  if (!sameJson(memory.value, rebuilt)) return { ok: false, code: "INVALID_STORY_STATE" };
  const focus = value.dialogueFocus;
  if (focus !== null && focus !== undefined && isDialogueFocus(focus)) {
    const eventIds = new Set(ledger.map((event) => String(event.eventId)));
    if (focus.eventIds.some((eventId) => !eventIds.has(String(eventId)))) {
      return { ok: false, code: "INVALID_STORY_STATE" };
    }
  }

  return {
    ok: true,
    value: {
      ...value,
      narrative: narrative.value,
      memory: memory.value as EpisodicMemoryState,
      history: history.value,
    } as StoryState,
  };
}
