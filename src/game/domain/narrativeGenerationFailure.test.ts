import { describe, it, expect } from "vitest";
import type {
  AiFailureKind,
  AiFailurePhase,
  AiGenerationFailure,
  NarrativeGenerationFailure,
} from "./narrativeGenerationFailure";

describe("AiGenerationFailure types", () => {
  it("AiFailureKind 只有两个稳定分类", () => {
    const kinds: AiFailureKind[] = ["AI_CALL_FAILED", "AI_RESPONSE_INVALID"];
    expect(kinds).toHaveLength(2);
  });

  it("AiFailurePhase 覆盖四个生产角色", () => {
    const phases: AiFailurePhase[] = ["opening", "intent", "world", "scene"];
    expect(phases).toHaveLength(4);
  });

  it("AiGenerationFailure 携带 kind 与 phase", () => {
    const failure: AiGenerationFailure = {
      kind: "AI_CALL_FAILED",
      phase: "opening",
    };
    expect(failure.kind).toBe("AI_CALL_FAILED");
    expect(failure.phase).toBe("opening");
  });

  it("NarrativeGenerationFailure 固定 phase 为 scene 并带 failedAt", () => {
    const failure: NarrativeGenerationFailure = {
      kind: "AI_RESPONSE_INVALID",
      phase: "scene",
      failedAt: "2026-08-21T00:00:00.000Z",
    };
    expect(failure.phase).toBe("scene");
    expect(failure.failedAt).toBe("2026-08-21T00:00:00.000Z");
  });

  it("NarrativeGenerationFailure 不允许 phase 为非 scene", () => {
    const invalid = {
      kind: "AI_CALL_FAILED" as const,
      phase: "opening" as const,
      failedAt: "2026-08-21T00:00:00.000Z",
    };
    // @ts-expect-error phase 必须是 scene，赋值 opening 会报类型错误
    const checked: NarrativeGenerationFailure = invalid;
    expect(checked).toBeDefined();
  });
});
