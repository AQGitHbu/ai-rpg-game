import { describe, expect, it } from "vitest";
import { aiRepairAuditContext, createAiSourceFailure, persistedAiRepairReason, repairFromSourceFailure, renderAiRepairFeedback } from "./aiGenerationRetry";

describe("shared AI retry feedback", () => {
  it("persists allowlisted stable details but excludes model/entity identifiers even when ASCII", () => {
    expect(persistedAiRepairReason({ attempt: 1, reason: "invalid_schema", detail: "world_delta_invalid" })).toBe("invalid_schema:world_delta_invalid");
    expect(persistedAiRepairReason({ attempt: 1, reason: "invalid_schema", detail: "duplicate_step_keys" })).toBe("invalid_schema:duplicate_step_keys");
    expect(persistedAiRepairReason({ attempt: 1, reason: "provider_failure", detail: "timeout" })).toBe("provider_failure:timeout");
    expect(persistedAiRepairReason({ attempt: 1, reason: "invalid_schema", detail: "event_commit_failed" })).toBe("invalid_schema:event_commit_failed");
    for (const detail of ["duplicate_name:npc:bob", "duplicate_name:npc:张三", "raw response body", "a".repeat(200)]) {
      expect(persistedAiRepairReason({ attempt: 1, reason: "approval_rejected", rejectionCode: "world_delta_rejected", detail })).toBe("approval:world_delta_rejected");
    }
    // 模型自造节拍 ID 与实体 ID 是纯小写 ASCII，字符正则无法区分，必须靠码表排除。
    expect(persistedAiRepairReason({ attempt: 1, reason: "approval_rejected", rejectionCode: "invented_beat_id", detail: "reflection" })).toBe("approval:invented_beat_id");
    expect(persistedAiRepairReason({ attempt: 1, reason: "approval_rejected", rejectionCode: "dialogue_focus_line_missing", detail: "npc_dyn_3" })).toBe("approval:dialogue_focus_line_missing");
  });
  it.each(["opening", "intent", "world", "scene"] as const)("keeps source failure identity and detail for %s", (phase) => {
    const failure = createAiSourceFailure(phase, "invalid_schema", "invalid_schema", "invalid_reference");
    const repair = repairFromSourceFailure(failure, 2);
    expect(failure.failure).toEqual({ kind: "AI_RESPONSE_INVALID", phase });
    expect(repair).toEqual({ attempt: 2, reason: "invalid_schema", detail: "invalid_reference" });
    expect(renderAiRepairFeedback(repair)).toContain("细分原因=invalid_reference");
    expect(aiRepairAuditContext(repair)).toEqual({ origin: "normal", mechanism: "content_repair", attempt: 2, reason: "invalid_schema" });
  });

  it("never relabels transport failure as invalid JSON", () => {
    const result = createAiSourceFailure("scene", "timeout", undefined, "timeout");
    expect(repairFromSourceFailure(result, 1)).toEqual({ attempt: 1, reason: "provider_failure", detail: "timeout" });
    expect(result.repairReason).toBeUndefined();
  });

  it("preserves manual origin and approval code, without putting free text into audit reason", () => {
    const repair = { attempt: 3, reason: "approval_rejected", rejectionCode: "world_delta_rejected", detail: "duplicate_name:npc:某人" };
    expect(aiRepairAuditContext(repair, { origin: "manual_failed_job", mechanism: "initial", attempt: 0 })).toEqual({ origin: "manual_failed_job", mechanism: "content_repair", attempt: 3, reason: "approval_rejected:world_delta_rejected" });
    expect(renderAiRepairFeedback(repair)).toContain("duplicate_name:npc:某人");
    expect(renderAiRepairFeedback(undefined)).toBe("");
  });
});
