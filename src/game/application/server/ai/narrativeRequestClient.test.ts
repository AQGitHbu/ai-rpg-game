import { describe, expect, it, vi } from "vitest";
import type { AiMessage } from "@ai-game/ai-transport";
import type { RpgAiClient } from "./rpgAiClient";
import { createNarrativeRequestClient } from "./narrativeRequestClient";

const messages: readonly AiMessage[] = [{ role: "user", content: "{}" }];

function fakeClient(complete: RpgAiClient["complete"]): RpgAiClient {
  return {
    complete,
    policy: () => ({ thinking: "off", timeoutMs: 45_000, maxTokens: 8_000, jsonMode: "prompt_only", maxAttempts: 2 }),
  };
}

describe("narrative request client", () => {
  it("maps each purpose to the narrative bundle role and purpose-specific policy", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: "{}", latencyMs: 1 });
    const client = createNarrativeRequestClient({ aiClient: fakeClient(complete) });

    await client.completeNarrativeRequest({
      purpose: "author",
      messages,
      auditContext: { purpose: "narrative_bundle_generation", trigger: "initialization" },
      signal: new AbortController().signal,
    });
    await client.completeNarrativeRequest({
      purpose: "review",
      messages,
      auditContext: { purpose: "narrative_candidate_review", trigger: "review" },
      signal: new AbortController().signal,
    });

    expect(complete).toHaveBeenNthCalledWith(
      1,
      "narrative_bundle",
      messages,
      expect.objectContaining({ purpose: "narrative_bundle_generation" }),
      expect.objectContaining({ policyOverride: expect.objectContaining({ timeoutMs: 240_000, maxAttempts: 2, thinking: "on", jsonMode: "prompt_only", maxTokens: undefined }) }),
    );
    expect(complete).toHaveBeenNthCalledWith(
      2,
      "narrative_bundle",
      messages,
      expect.objectContaining({ purpose: "narrative_candidate_review" }),
      expect.objectContaining({ policyOverride: expect.objectContaining({ timeoutMs: 120_000, maxAttempts: 2, thinking: "on", jsonMode: "prompt_only", maxTokens: undefined }) }),
    );
  });

  it("forwards cancellation and reserves every transport attempt through the RPG client", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: false, code: "aborted", retryable: false, latencyMs: 1 });
    const reserve = vi.fn().mockResolvedValue(false);
    const signal = new AbortController().signal;
    const client = createNarrativeRequestClient({ aiClient: fakeClient(complete) });

    await client.completeNarrativeRequest({
      purpose: "npc_deliberation",
      messages,
      auditContext: { purpose: "npc_deliberation", trigger: "npc_deliberation" },
      signal,
      reserveHttpAttempt: reserve,
    });

    expect(complete).toHaveBeenCalledWith(
      "narrative_bundle",
      messages,
      expect.any(Object),
      expect.objectContaining({ signal, beforeTransportAttempt: reserve }),
    );
  });
});
