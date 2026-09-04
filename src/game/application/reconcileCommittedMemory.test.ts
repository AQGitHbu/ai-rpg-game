import { describe, expect, it } from "vitest";
import { reconcileCommittedMemory } from "./reconcileCommittedMemory";
import {
  createEmptyEpisodicMemory,
  rebuildEpisodicMemory,
} from "@/game/domain/episodicMemory";
import { makeCommittedEvent } from "@/game/domain/testing/committedEventFactory";
import { asFactId } from "@/game/domain/worldEntity";

describe("reconcileCommittedMemory", () => {
  it("rebuilds from the ledger being committed, not from stale memory fields", () => {
    const ledger = [
      makeCommittedEvent({ type: "fact_discovered", factId: asFactId("fact_1") } as never, {
        sequence: 0,
      }),
    ];

    expect(reconcileCommittedMemory({
      previous: createEmptyEpisodicMemory(),
      ledger,
    })).toEqual(rebuildEpisodicMemory(ledger));
  });
});
