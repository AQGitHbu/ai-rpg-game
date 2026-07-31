import { describe, expect, it, vi } from "vitest";
import { NARRATIVE_CONTRACT_VERSION } from "../../runtimeNarrative";
import {
  RUNTIME_NARRATIVE_FIXTURE_VERSION,
  RuntimeNarrativeFixtureDriftError,
  createRecordingRuntimeNarrativeSources,
  createReplayRuntimeNarrativeSources,
  fingerprintNarrativeContext,
  type RuntimeNarrativeRecordedCall,
} from "./runtimeNarrativeRecording";

const plan = {
  sceneGoal: "推进调查",
  tensionLevel: 2 as const,
  focusNpcId: null,
  relevantFactIds: [],
  allowedRevealFactIds: [],
  suggestedActionKeys: ["observe", "move:loc_2"] as const,
  introducedEntities: [],
  pacing: "develop" as const,
        proposedNewLocations: [],
        proposedNewNpcs: [],
};

const script = {
  narration: "风把远处的钟声送进巷口。",
  usedFactIds: [],
  npcInstruction: null,
  choices: [
    { actionKey: "observe", label: "观察四周", strategy: "先收集线索" },
    { actionKey: "move:loc_2", label: "前往街口", strategy: "主动推进" },
  ] as const,
};

function generatedSources() {
  return {
    directorSource: { generate: vi.fn(async (request: { traceId: string }) => ({ ok: true as const, provenance: "generated" as const, plan, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" as const } })) },
    sceneScriptSource: { generate: vi.fn(async (request: { traceId: string }) => ({ ok: true as const, provenance: "generated" as const, script, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" as const } })) },
    npcLineSource: { generate: vi.fn(async (request: { traceId: string }) => ({ ok: true as const, provenance: "generated" as const, performance: { text: "别在这里久留。", usedFactIds: [], emotion: "afraid" as const }, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" as const } })) },
  };
}

describe("runtime narrative record/replay", () => {
  it("fingerprint is canonical and changes with projected context", () => {
    expect(fingerprintNarrativeContext({ a: 1, nested: { y: 2, x: 3 } }))
      .toBe(fingerprintNarrativeContext({ nested: { x: 3, y: 2 }, a: 1 }));
    expect(fingerprintNarrativeContext({ a: 1 })).not.toBe(fingerprintNarrativeContext({ a: 2 }));
    expect(fingerprintNarrativeContext({
      narrative: { sceneId: "run-a", choices: [{ choiceToken: "token-a", label: "A" }] },
    })).toBe(fingerprintNarrativeContext({
      narrative: { sceneId: "run-b", choices: [{ choiceToken: "token-b", label: "A" }] },
    }));
  });

  it("records parsed role results and hashes in global order", async () => {
    const calls: RuntimeNarrativeRecordedCall[] = [];
    const sources = createRecordingRuntimeNarrativeSources(generatedSources(), {
      append: (call) => { calls.push(call); },
    });
    await sources.directorSource.generate({ traceId: "secret-trace", context: { actionCandidates: ["observe"] } });
    await sources.sceneScriptSource.generate({ traceId: "secret-trace", context: { plan } });
    await sources.npcLineSource.generate({ traceId: "secret-trace", context: { npc: "npc_1" } });

    expect(calls.map((call) => [call.sequence, call.role])).toEqual([[0, "director"], [1, "writer"], [2, "npc"]]);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("secret-trace");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("prompt");
  });

  it("replays exact sequence with current trace ids and zero fetch", async () => {
    const calls: RuntimeNarrativeRecordedCall[] = [];
    const recorded = createRecordingRuntimeNarrativeSources(generatedSources(), { append: (call) => { calls.push(call); } });
    const directorRequest = { traceId: "record-director", context: { state: 1 } };
    const writerRequest = { traceId: "record-writer", context: { state: 2 } };
    await recorded.directorSource.generate(directorRequest);
    await recorded.sceneScriptSource.generate(writerRequest);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const replay = createReplayRuntimeNarrativeSources(calls);
    const replayedDirector = await replay.directorSource.generate({ ...directorRequest, traceId: "replay-director" });
    const replayedWriter = await replay.sceneScriptSource.generate({ ...writerRequest, traceId: "replay-writer" });
    replay.assertComplete();

    expect(replayedDirector.ok && replayedDirector.plan).toEqual(plan);
    expect(replayedDirector.diagnostics.traceId).toBe("replay-director");
    expect(replayedWriter.ok && replayedWriter.script).toEqual(script);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("fails loudly on context drift or unconsumed calls", async () => {
    const base: RuntimeNarrativeRecordedCall = {
      fixtureVersion: RUNTIME_NARRATIVE_FIXTURE_VERSION,
      contractVersion: NARRATIVE_CONTRACT_VERSION,
      sequence: 0,
      role: "director",
      requestFingerprint: fingerprintNarrativeContext({ state: 1 }),
      result: { ok: true, plan },
    };
    await expect(createReplayRuntimeNarrativeSources([base]).directorSource.generate({
      traceId: "replay",
      context: { state: 2 },
    })).rejects.toBeInstanceOf(RuntimeNarrativeFixtureDriftError);
    expect(() => createReplayRuntimeNarrativeSources([base]).assertComplete())
      .toThrow(RuntimeNarrativeFixtureDriftError);
  });
});
