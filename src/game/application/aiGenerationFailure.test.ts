import { describe, it, expect } from "vitest";
import {
  AiGenerationError,
  classifyAiFailure,
} from "./aiGenerationFailure";
import type { AiFailurePhase } from "@/game/domain/narrativeGenerationFailure";

describe("AiGenerationError", () => {
  it("携带稳定 kind、phase 与 message，不使用 parameter-property 语法", () => {
    const error = new AiGenerationError(
      "AI_CALL_FAILED",
      "scene",
      "provider returned 503",
    );
    expect(error.name).toBe("AiGenerationError");
    expect(error.kind).toBe("AI_CALL_FAILED");
    expect(error.phase).toBe("scene");
    expect(error.message).toBe("provider returned 503");
    expect(error).toBeInstanceOf(Error);
  });

  it("kind 是 readonly（@ts-expect-error 在 typecheck 时验证）", () => {
    const error = new AiGenerationError(
      "AI_RESPONSE_INVALID",
      "intent",
      "invalid json",
    );
    // @ts-expect-error kind 是 readonly，类型层面禁止赋值；
    // 如果 kind 不是 readonly，@ts-expect-error 会在 typecheck 时报错
    error.kind = "AI_CALL_FAILED";
    expect(error).toBeDefined();
  });
});

describe("classifyAiFailure", () => {
  const callFailedCategories = [
    "transport",
    "unavailable",
    "timeout",
    "rate_limit",
    "service_error",
    "empty_response",
  ] as const;

  const responseInvalidCategories = [
    "invalid_json",
    "invalid_schema",
    "invalid_reference",
    "approval_rejected",
  ] as const;

  for (const category of callFailedCategories) {
    it(`分类 ${category} → AI_CALL_FAILED`, () => {
      const result = classifyAiFailure({ phase: "scene", category });
      expect(result.kind).toBe("AI_CALL_FAILED");
    });
  }

  for (const category of responseInvalidCategories) {
    it(`分类 ${category} → AI_RESPONSE_INVALID`, () => {
      const result = classifyAiFailure({ phase: "world", category });
      expect(result.kind).toBe("AI_RESPONSE_INVALID");
    });
  }

  it("unknown 分类 → AI_CALL_FAILED", () => {
    const result = classifyAiFailure({ phase: "opening", category: "unknown" });
    expect(result.kind).toBe("AI_CALL_FAILED");
  });

  it("保留传入的 phase", () => {
    const phases: AiFailurePhase[] = ["opening", "intent", "world", "scene"];
    for (const phase of phases) {
      const result = classifyAiFailure({ phase, category: "transport" });
      expect(result.phase).toBe(phase);
    }
  });
});
