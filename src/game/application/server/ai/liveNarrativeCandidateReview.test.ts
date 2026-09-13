import { describe, expect, it, vi } from "vitest";
import type { AiMessage } from "@ai-game/ai-transport";
import type { NarrativeBundleSourceContext } from "../../narrativeBundleSource";
import { hashNarrativeCandidate } from "../../narrativeCandidateReview";
import { createLiveNarrativeCandidateReview } from "./liveNarrativeCandidateReview";
import type { RpgAiClient } from "./rpgAiClient";
import { createNarrativeBundleSource } from "./liveNarrativeBundleSource";
import observedOpening from "./testing/p1-07-opening-candidate.json";
import { compileOpeningGenerationCandidate } from "@/game/gameplay/rpg/openingGeneration";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { asGenerationId } from "@/game/domain/worldEntity";

const candidate = {
  worldDelta: null,
  currentScene: {
    segments: [{ beatId: "atmosphere", text: "场景" }],
    npcLine: null,
    objectiveLink: null,
    choices: [],
  },
  continuationScenes: [],
  terminal: { kind: "ending" },
} as never;

const reviewContext = {
  kind: "opening",
  jobId: "job-review",
  input: { gameType: "wuxia", gameLength: "short", seed: "review" },
} as unknown as NarrativeBundleSourceContext;

function client(complete: ReturnType<typeof vi.fn>): RpgAiClient {
  return {
    complete,
    policy: () => ({
      thinking: "off",
      timeoutMs: 45_000,
      maxTokens: 2_000,
      jsonMode: "prompt_only",
      maxAttempts: 1,
    }),
  };
}

describe("live narrative candidate reviewer", () => {
  it("projects actual compiler IDs and secret-directory visibility for an opening candidate", async () => {
    // Provider output only, copied from p1-07/S2-public version 1. The observed
    // reviewer incorrectly rejected private facts merely for being in this
    // directory. Replay its real structure through the production adapter.
    const generated = await createNarrativeBundleSource({ aiClient: client(vi.fn().mockResolvedValue({
      ok: true, content: JSON.stringify(observedOpening),
    })) }).generate(reviewContext);
    if (!generated.ok || generated.kind !== "opening") throw new Error("opening fixture failed");
    const compiled = compileOpeningGenerationCandidate({
      candidate: generated.proposal.opening, gameLength: "short",
      generation: { generationId: asGenerationId("review-map"), seed: "review-map", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
      initialNarrative: createFixtureNarrativeRuntimeState(),
    });
    const complete = vi.fn().mockResolvedValue({ ok: true, content: '{"verdict":"pass"}' });
    await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context: reviewContext, proposal: generated.proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(generated.proposal),
    });
    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const bindings = JSON.parse(messages[1]!.content).context.factBindings as { key: string; factId: string; disclosure: string }[];
    expect(bindings.map((entry) => entry.factId)).toEqual(compiled.worldState.worldFacts.map((fact) => String(fact.factId)));
    const privateKeys = generated.proposal.opening.opening.npc.privateFactKeys;
    expect(privateKeys.length).toBeGreaterThan(0);
    expect(bindings.filter((entry) => entry.disclosure === "secret").map((entry) => entry.key)).toEqual(privateKeys);
    for (const binding of bindings.filter((entry) => entry.disclosure === "secret")) {
      expect(compiled.worldState.worldFacts.find((fact) => fact.factId === binding.factId)?.discovered).toBe(false);
    }
  });
  it("gives the reviewer the same opening compiler contract that constrained the author", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: '{"verdict":"pass"}' });
    await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context: reviewContext, proposal: candidate, candidateVersion: 1, candidateHash: hashNarrativeCandidate(candidate),
    });
    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const body = JSON.parse(messages[1]!.content);
    // Regression: p1-07 reviewer demanded removing private keys from their
    // required directory, replacing fact_N IDs, and four choices in a pair.
    expect(body.context.authorPrompt).toContain(body.context.contract);
    expect(body.context.contract).toContain("privateFactKeys 必须引用该目录");
    expect(body.context.contract).toContain("fact_0、fact_1");
    expect(body.context.contract).toContain("不能要求首屏两个选项同时枚举四条路线");
    expect(body.context.contract).toContain("允许在事实目录/history 中建立");
  });
  it("uses the existing narrative_bundle role and returns server-bound defects", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        defects: [{
          scope: "proposal",
          code: "UNSUPPORTED_FACT",
          path: "currentScene.npcLine.usedFactIds",
          reason: "引用未建立的验真器。",
        }],
      }),
    });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });
    const candidateHash = hashNarrativeCandidate(candidate);

    const result = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 2,
      candidateHash,
    });

    expect(result).toMatchObject({
      ok: false,
      candidateVersion: 2,
      candidateHash,
      defects: [{ code: "UNSUPPORTED_FACT" }],
    });
    expect(complete).toHaveBeenCalledWith(
      "narrative_bundle",
      expect.any(Array),
      expect.objectContaining({
        purpose: "narrative_candidate_review",
        trigger: "narrative_candidate_review",
        revision: 2,
      }),
    );
    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    expect(JSON.stringify(messages)).not.toContain("privateContext");
    expect(messages[0]?.content).toContain("scope 只能是 scene、proposal、npc_behavior");
    expect(messages[0]?.content).toContain("code 只能是 MISSED_INPUT、UNSUPPORTED_FACT、DISCLOSURE、ACTION_MISMATCH、BROKEN_CAUSALITY");
  });

  it("does not turn provider failure or an empty verdict into pass", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: false,
      code: "network_error",
      retryable: false,
      latencyMs: 1,
    });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });
    const result = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 1,
      candidateHash: hashNarrativeCandidate(candidate),
    });
    expect(result).toMatchObject({ ok: false, failure: "PROVIDER_FAILURE" });

    complete.mockResolvedValue({ ok: true, content: JSON.stringify({ defects: [] }) });
    const uncertain = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 1,
      candidateHash: hashNarrativeCandidate(candidate),
    });
    expect(uncertain).toMatchObject({ ok: false, failure: "UNCERTAIN" });
  });

  it("normalizes known reviewer aliases into the stable defect vocabulary", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        verdict: "revise",
        defects: [{
          scope: "world",
          code: "private_fact_publicized",
          path: "opening.world.publicFacts[0]",
          reason: "受保护事实被列为公开事实。",
        }],
      }),
    });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });

    const result = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 1,
      candidateHash: hashNarrativeCandidate(candidate),
    });

    expect(result).toMatchObject({ ok: false, defects: [{ code: "DISCLOSURE" }] });
  });
});
