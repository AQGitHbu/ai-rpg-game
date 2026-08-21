import { describe, it, expect } from "vitest";
import {
  AiGenerationError,
  classifyAiFailure,
  type AiFailureCategory,
} from "./aiGenerationFailure";

describe("AiGenerationError", () => {
  it("carries stable kind and phase", () => {
    const error = new AiGenerationError(
      "AI_CALL_FAILED",
      "scene",
      "transport timeout",
    );
    expect(error.name).toBe("AiGenerationError");
    expect(error.kind).toBe("AI_CALL_FAILED");
    expect(error.phase).toBe("scene");
    expect(error.message).toBe("transport timeout");
  });

  it("is an Error subclass", () => {
    const error = new AiGenerationError(
      "AI_RESPONSE_INVALID",
      "opening",
      "bad json",
    );
    expect(error).toBeInstanceOf(Error);
  });
});

describe("classifyAiFailure", () => {
  const callFailedCategories: AiFailureCategory[] = [
    "transport",
    "unavailable",
    "timeout",
    "rate_limit",
    "service_error",
    "empty_response",
  ];

  const responseInvalidCategories: AiFailureCategory[] = [
    "invalid_json",
    "invalid_schema",
    "invalid_reference",
    "approval_rejected",
  ];

  it.each(callFailedCategories)(
    "maps %s to AI_CALL_FAILED",
    (category) => {
      const result = classifyAiFailure({ phase: "scene", category });
      expect(result.kind).toBe("AI_CALL_FAILED");
      expect(result.phase).toBe("scene");
    },
  );

  it.each(responseInvalidCategories)(
    "maps %s to AI_RESPONSE_INVALID",
    (category) => {
      const result = classifyAiFailure({ phase: "world", category });
      expect(result.kind).toBe("AI_RESPONSE_INVALID");
      expect(result.phase).toBe("world");
    },
  );

  it("maps unknown to AI_CALL_FAILED (conservative)", () => {
    const result = classifyAiFailure({ phase: "intent", category: "unknown" });
    expect(result.kind).toBe("AI_CALL_FAILED");
  });

  it("preserves the phase in the result", () => {
    for (const phase of ["opening", "intent", "world", "scene"] as const) {
      const result = classifyAiFailure({ phase, category: "transport" });
      expect(result.phase).toBe(phase);
    }
  });
});
