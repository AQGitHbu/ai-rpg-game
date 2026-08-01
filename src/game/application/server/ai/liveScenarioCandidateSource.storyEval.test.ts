/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { AiMessage, AiTransport, AiTransportConfig, AiTransportFailureCode } from "@ai-game/ai-transport";
import type { ValidatedNewGameInput } from "@/game/domain";
import type { StoryEvalCallRecord, StoryEvalSink } from "../../storyEvalCaptureTypes";
import { createLiveScenarioCandidateSource } from "./liveScenarioCandidateSource";

const config: AiTransportConfig = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" };

const minimalCandidate = {
  world: { name: "W", summary: "S", tone: "dark", themes: ["t"] },
  openingScene: {},
  player: {},
  locations: [],
  npcs: [],
  quests: [],
  items: [],
  enemies: [],
  endings: [],
};

async function buildSource(records: StoryEvalCallRecord[], responseContent: string) {
  const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: responseContent } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const source = createLiveScenarioCandidateSource({
    transport: (await import("@ai-game/ai-transport")).createOpenAiCompatibleTransport(),
    config,
    buildMessages: (request) => [{ role: "system", content: "scenario prompt" }, { role: "user", content: JSON.stringify(request.input) }],
    audit: { record: () => {} },
    captureSink: sink,
  });
  return { source, fetchSpy };
}

const request = {
  traceId: "t-scenario",
  seed: "test-seed",
  input: { gameType: "wuxia" as const, gameLength: "long" as const, worldPremise: "P", storyOpening: "O" } as unknown as ValidatedNewGameInput,
};

describe("createLiveScenarioCandidateSource captureSink", () => {
  it("成功时捕获完整 ai_call（scenario 角色）且不改返回值", async () => {
    const records: StoryEvalCallRecord[] = [];
    const { source, fetchSpy } = await buildSource(records, JSON.stringify(minimalCandidate));
    try {
      const result = await source.generate(request);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.origin).toBe("live");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("scenario");
    expect(records[0].traceId).toBe("t-scenario");
    expect(records[0].attempt).toBe(1);
    expect(records[0].messages).toHaveLength(2);
    expect(records[0].parsedCandidate).not.toBeNull();
    expect(records[0].failureCategory).toBeNull();
  });

  it("解析失败时记录 rawResponse 与 failureCategory=invalid_json", async () => {
    const records: StoryEvalCallRecord[] = [];
    const { source } = await buildSource(records, "oops");
    try {
      const result = await source.generate(request);
      expect(result.ok).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records[0].rawResponse).toBe("oops");
    expect(records[0].parsedCandidate).toBeNull();
    expect(records[0].failureCategory).toBe("invalid_json");
  });
});
