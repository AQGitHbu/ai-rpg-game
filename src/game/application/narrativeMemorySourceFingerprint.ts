import { createHash } from "node:crypto";
import type { EntityId } from "@/game/domain/entity/entityCore";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { projectObserverEvidence } from "@/game/gameplay/rpg/narrativeMemory";

type Source = Readonly<{ worldState: WorldState; storyState: StoryState }>;

/** Object insertion order is not part of source identity. Array order is. */
export function canonicalMemoryJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalMemoryJson(value)).digest("hex");
}

/** A summary covers a History prefix, never an Event sequence interval. */
export function narrativeMemorySourceFingerprint(input: Source & Readonly<{
  observerId: EntityId;
  throughSequence?: number;
}>): string {
  const evidence = projectObserverEvidence(input);
  const history = evidence.history.filter((entry) => entry.sequence <= (input.throughSequence ?? Infinity));
  const eventIds = new Set(history.flatMap((entry) => entry.eventIds.map(String)));
  return fingerprint({
    formatVersion: 2,
    policyVersion: "memory-p2/1",
    observerId: input.observerId,
    throughSequence: input.throughSequence ?? null,
    history,
    // Visibility is recomputed against current permissions. Unrelated future
    // events, Entity changes and tail History do not invalidate this prefix.
    events: evidence.events.filter((event) => eventIds.has(String(event.eventId))),
  });
}

/** The fixed job input needs the current source, not just its summary prefix. */
export function preparedNarrativeMemorySourceFingerprint(input: Source & Readonly<{
  playerObserverId: EntityId;
  npcObserverId?: EntityId;
}>): string {
  const narrative = input.storyState.narrative;
  let job: unknown = null;
  if (narrative.status === "provider_pending" || narrative.status === "provider_failed") {
    const { attempt: _attempt, ...sourceJob } = narrative.job;
    job = sourceJob;
  }
  return fingerprint({
    formatVersion: 2,
    policyVersion: "memory-p2/1",
    generationId: input.worldState.generation.generationId,
    player: projectObserverEvidence({ ...input, observerId: input.playerObserverId }),
    npc: input.npcObserverId === undefined ? null : projectObserverEvidence({ ...input, observerId: input.npcObserverId }),
    entities: input.worldState.entityStore.records,
    currentLocationId: input.worldState.currentLocationId,
    activeThreads: input.storyState.threads,
    dialogueFocus: input.storyState.dialogueFocus,
    delivery: input.storyState.delivery ?? null,
    job,
  });
}
