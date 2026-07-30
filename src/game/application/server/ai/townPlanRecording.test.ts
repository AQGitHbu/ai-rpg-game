import { describe, expect, it, vi } from "vitest";
import {
  TOWN_PLAN_CONTRACT_VERSION,
  type TownPlanCandidateSource,
  type TownPlanRequest
} from "../../townPlanGeneration";
import {
  TOWN_PLAN_FIXTURE_VERSION,
  TownPlanFixtureDriftError,
  createRecordingTownPlanSource,
  createReplayTownPlanSource,
  fingerprintTownPlanRequest,
  type TownPlanRecordedCall
} from "./townPlanRecording";

const baseRequest: TownPlanRequest = {
  locationId: "loc_2",
  locationName: "青石镇",
  locationDescription: "河畔的商贸重镇。",
  locationTags: ["market", "riverside"],
  npcs: [{ id: "npc_1", name: "柳掌柜", role: "merchant" }],
  worldTone: "武侠",
  worldThemes: ["恩怨", "江湖"],
  seed: "seed-x#town#loc_2",
  traceId: "trace-record"
};

const candidate = {
  theme: "青石镇（AI 规划）",
  gridSize: { width: 32, height: 32 },
  districts: [{ type: "market", preferredArea: "center", weight: 3 }]
};

function liveSuccessSource(): TownPlanCandidateSource {
  return {
    generate: vi.fn(async () => ({
      ok: true as const,
      contractVersion: TOWN_PLAN_CONTRACT_VERSION,
      origin: "live" as const,
      candidate,
      diagnostics: []
    }))
  };
}

describe("town plan record/replay", () => {
  it("fingerprint is canonical, key-order stable and masks volatile traceId", () => {
    expect(fingerprintTownPlanRequest(baseRequest))
      .toBe(fingerprintTownPlanRequest({ ...baseRequest, traceId: "trace-different" }));
    expect(fingerprintTownPlanRequest(baseRequest))
      .not.toBe(fingerprintTownPlanRequest({ ...baseRequest, seed: "seed-y#town#loc_2" }));
  });

  it("records parsed candidate in order without leaking prompt/key/response", async () => {
    const calls: TownPlanRecordedCall[] = [];
    const source = createRecordingTownPlanSource(liveSuccessSource(), {
      append: (call) => { calls.push(call); }
    });
    await source.generate(baseRequest);
    await source.generate({ ...baseRequest, traceId: "trace-record-2" });

    expect(calls.map((call) => call.sequence)).toEqual([0, 1]);
    expect(calls[0].result.ok && calls[0].result.candidate).toEqual(candidate);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("trace-record");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("prompt");
  });

  it("replays the recorded candidate with a fresh traceId and zero fetch", async () => {
    const calls: TownPlanRecordedCall[] = [];
    const recorded = createRecordingTownPlanSource(liveSuccessSource(), {
      append: (call) => { calls.push(call); }
    });
    await recorded.generate(baseRequest);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const replay = createReplayTownPlanSource(calls);
    const attempt = await replay.generate({ ...baseRequest, traceId: "trace-replay" });
    replay.assertComplete();

    expect(attempt.ok && attempt.origin).toBe("fixture");
    expect(attempt.ok && attempt.candidate).toEqual(candidate);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("fails loudly on request drift or unconsumed calls", async () => {
    const base: TownPlanRecordedCall = {
      fixtureVersion: TOWN_PLAN_FIXTURE_VERSION,
      contractVersion: TOWN_PLAN_CONTRACT_VERSION,
      sequence: 0,
      requestFingerprint: fingerprintTownPlanRequest(baseRequest),
      result: { ok: true, origin: "live", candidate }
    };
    await expect(createReplayTownPlanSource([base]).generate({ ...baseRequest, seed: "drifted" }))
      .rejects.toBeInstanceOf(TownPlanFixtureDriftError);
    expect(() => createReplayTownPlanSource([base]).assertComplete())
      .toThrow(TownPlanFixtureDriftError);
  });
});
