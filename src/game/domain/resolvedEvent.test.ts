import { describe, it, expect } from "vitest";
import type { ResolvedEvent } from "./resolvedEvent";

describe("ResolvedEvent", () => {
  it("supports five statuses and required eventKind", () => {
    const statuses = ["success", "partial_success", "failure", "blocked", "invalid"] as const;
    const event: ResolvedEvent = {
      actionId: "act_1",
      status: statuses[1]!,
      eventKind: "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
      stateVersion: 1,
    };
    expect(event.status).toBe("partial_success");
  });
});
