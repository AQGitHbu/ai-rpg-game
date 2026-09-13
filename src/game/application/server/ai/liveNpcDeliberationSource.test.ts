import { describe, expect, it, vi } from "vitest";
import type { AiCompletionResult } from "@ai-game/ai-transport";
import { asFactId, asNpcId } from "@/game/domain/worldEntity";
import { asEventId, asNarrativeJobId } from "@/game/domain/events";
import type { RpgAiClient } from "./rpgAiClient";
import { createLiveNpcDeliberationSource } from "./liveNpcDeliberationSource";

const NPC_ID = asNpcId("npc:night_watch");
const JOB_ID = asNarrativeJobId("job:deliberation");
const FACT_ID = asFactId("fact:bridge_footprints");
const EVENT_ID = asEventId("turn:deliberation:evidence");

function clientWith(result: AiCompletionResult): RpgAiClient {
  return {
    complete: vi.fn().mockResolvedValue(result),
    policy: vi.fn().mockReturnValue({
      thinking: "off",
      timeoutMs: 45_000,
      maxTokens: 8_000,
      jsonMode: "prompt_only",
      maxAttempts: 2,
    }),
  };
}

function validResponse(): string {
  return JSON.stringify({
    npcId: NPC_ID,
    goalIds: ["npc:night_watch_goal_1"],
    response: "refuse",
    evidenceEventIds: [EVENT_ID],
    discloseFactIds: [FACT_ID],
    interactionProposals: [],
  });
}

describe("liveNpcDeliberationSource", () => {
  it("uses the existing narrative_bundle role while isolating the private NPC prompt", async () => {
    const aiClient = clientWith({ ok: true, content: validResponse(), latencyMs: 3 });
    const source = createLiveNpcDeliberationSource({ aiClient });
    const result = await source.generate({
      npcId: NPC_ID,
      jobId: JOB_ID,
      candidateVersion: 2,
      privateContext: "PRIVATE NPC CONTEXT: 守夜人知道暗路。PRIVATE_ONLY_MARKER.",
    });

    expect(result).toEqual({
      ok: true,
      proposal: {
        npcId: NPC_ID,
        goalIds: ["npc:night_watch_goal_1"],
        response: "refuse",
        evidenceEventIds: [EVENT_ID],
        discloseFactIds: [FACT_ID],
        interactionProposals: [],
      },
    });
    const [role, messages, context] = vi.mocked(aiClient.complete).mock.calls[0]!;
    expect(role).toBe("narrative_bundle");
    expect(messages[1]?.content).toContain("PRIVATE NPC CONTEXT");
    expect(messages[0]?.content).not.toContain("PRIVATE_ONLY_MARKER");
    for (const field of ["promise_confidentiality", "request_introduction", "request_verification", "share_known_fact", "protectedFactIds", "allowedAudienceIds", "promise_status", "selectedExpression"]) {
      expect(messages[0]?.content).toContain(field);
    }
    expect(context).toMatchObject({ purpose: "npc_deliberation", trigger: "npc_deliberation", jobId: String(JOB_ID) });
  });

  it("fails closed for provider failure and malformed or mismatched proposals", async () => {
    const providerFailure = createLiveNpcDeliberationSource({
      aiClient: clientWith({ ok: false, code: "timeout", retryable: true, latencyMs: 1 }),
    });
    await expect(providerFailure.generate({ npcId: NPC_ID, jobId: JOB_ID, candidateVersion: 1, privateContext: "private" }))
      .resolves.toEqual({ ok: false, code: "PROVIDER_FAILURE" });

    const malformed = createLiveNpcDeliberationSource({
      aiClient: clientWith({ ok: true, content: "not json", latencyMs: 1 }),
    });
    await expect(malformed.generate({ npcId: NPC_ID, jobId: JOB_ID, candidateVersion: 1, privateContext: "private" }))
      .resolves.toEqual({ ok: false, code: "INVALID_PROPOSAL" });

    const mismatched = createLiveNpcDeliberationSource({
      aiClient: clientWith({
        ok: true,
        content: JSON.stringify({ ...JSON.parse(validResponse()), npcId: "npc:other" }),
        latencyMs: 1,
      }),
    });
    await expect(mismatched.generate({ npcId: NPC_ID, jobId: JOB_ID, candidateVersion: 1, privateContext: "private" }))
      .resolves.toEqual({ ok: false, code: "INVALID_PROPOSAL" });
  });

  it("lets private self-knowledge change the NPC response without sharing it with a second call", async () => {
    const complete = vi.fn(async (_role: Parameters<RpgAiClient["complete"]>[0], messages: Parameters<RpgAiClient["complete"]>[1]) => {
      const refuses = messages[1]?.content.includes("PRIVATE_ROUTE") ?? false;
      return {
        ok: true as const,
        content: JSON.stringify({
          ...JSON.parse(validResponse()),
          response: refuses ? "refuse" : "cooperate",
          discloseFactIds: [],
        }),
        latencyMs: 1,
      };
    });
    const aiClient: RpgAiClient = {
      complete,
      policy: vi.fn().mockReturnValue({
        thinking: "off",
        timeoutMs: 45_000,
        maxTokens: 8_000,
        jsonMode: "prompt_only",
        maxAttempts: 2,
      }),
    };
    const source = createLiveNpcDeliberationSource({ aiClient });
    const privateResult = await source.generate({ npcId: NPC_ID, jobId: JOB_ID, candidateVersion: 1, privateContext: "PRIVATE_ROUTE" });
    const publicResult = await source.generate({ npcId: NPC_ID, jobId: JOB_ID, candidateVersion: 1, privateContext: "PUBLIC_CONTEXT" });

    expect(privateResult).toMatchObject({ ok: true, proposal: { response: "refuse" } });
    expect(publicResult).toMatchObject({ ok: true, proposal: { response: "cooperate" } });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0]?.[1][1]?.content).toContain("PRIVATE_ROUTE");
    expect(complete.mock.calls[1]?.[1][1]?.content).not.toContain("PRIVATE_ROUTE");
  });
});
