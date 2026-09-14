import { createHash } from "node:crypto";
import type { EntityId } from "@/game/domain/entity/entityCore";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { projectObserverEvidence } from "@/game/gameplay/rpg/narrativeMemory";

/**
 * Hash the server-owned source used by one observer's memory package. The
 * payload deliberately contains structured source records, not rendered
 * prose, so a changed event payload, fact/entity state, thread, or permission
 * projection invalidates the derived summary.
 */
export function narrativeMemorySourceFingerprint(input: Readonly<{
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly observerId: EntityId;
  readonly throughSequence?: number;
}>): string {
  const evidence = projectObserverEvidence({
    worldState: input.worldState,
    storyState: input.storyState,
    observerId: input.observerId,
  });
  const throughSequence = input.throughSequence ?? Number.POSITIVE_INFINITY;
  const visible = <T extends { readonly sequence: number }>(entries: readonly T[]) =>
    entries.filter((entry) => entry.sequence <= throughSequence);
  const canonical = {
    formatVersion: 1,
    observerId: String(input.observerId),
    throughSequence: Number.isFinite(throughSequence) ? throughSequence : null,
    history: visible(evidence.history),
    events: visible(evidence.events),
    // The hash may contain private state because it never leaves the server;
    // including the complete store ensures a permission/lifecycle change
    // cannot leave an old derived summary looking current.
    entities: input.worldState.entityStore.records,
    currentLocationId: String(input.worldState.currentLocationId),
    activeThreads: input.storyState.threads,
    dialogueFocus: input.storyState.dialogueFocus,
    delivery: input.storyState.delivery ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
