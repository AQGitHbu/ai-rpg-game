import {
  reconcileEpisodicMemory,
  type EpisodicMemoryState,
} from "@/game/domain/episodicMemory";
import type { CommittedNarrativeEvent } from "@/game/domain/events";

/** Build the memory read model from the exact ledger that is about to cross a CAS boundary. */
export function reconcileCommittedMemory(input: Readonly<{
  readonly previous: EpisodicMemoryState;
  readonly ledger: readonly CommittedNarrativeEvent[];
}>): EpisodicMemoryState {
  return reconcileEpisodicMemory(input);
}
