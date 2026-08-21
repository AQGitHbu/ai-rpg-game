import { describe, it, expect } from "vitest";
import type {
  AiFailureKind,
  AiFailurePhase,
  AiGenerationFailure,
  NarrativeGenerationFailure,
} from "./narrativeGenerationFailure";

describe("narrativeGenerationFailure types", () => {
  it("AiFailureKind only has two stable values", () => {
    const kinds: AiFailureKind[] = ["AI_CALL_FAILED", "AI_RESPONSE_INVALID"];
    expect(kinds).toHaveLength(2);
  });

  it("AiFailurePhase covers four pipeline stages", () => {
    const phases: AiFailurePhase[] = ["opening", "intent", "world", "scene"];
    expect(phases).toHaveLength(4);
  });

  it("AiGenerationFailure carries kind and phase", () => {
    const failure: AiGenerationFailure = {
      kind: "AI_CALL_FAILED",
      phase: "scene",
    };
    expect(failure.kind).toBe("AI_CALL_FAILED");
    expect(failure.phase).toBe("scene");
  });

  it("NarrativeGenerationFailure forces phase=scene and adds failedAt", () => {
    const failure: NarrativeGenerationFailure = {
      kind: "AI_RESPONSE_INVALID",
      phase: "scene",
      failedAt: "2026-08-21T00:00:00.000Z",
    };
    expect(failure.phase).toBe("scene");
    expect(failure.failedAt).toBe("2026-08-21T00:00:00.000Z");
  });
});
