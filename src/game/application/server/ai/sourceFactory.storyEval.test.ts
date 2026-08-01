/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import { validateNewGameInput, type NewGameInput } from "@/game/domain";
import wuxiaFixture from "../../../../../data/fixtures/phase1/wuxia.json";
import type { StoryEvalCallRecord, StoryEvalSink } from "./storyEvalCapture";
import { createRuntimeNarrativeSources } from "./runtimeNarrativeSourceFactory";
import { createScenarioCandidateSource } from "./scenarioCandidateSourceFactory";

const validEnv = {
  AI_API_BASE_URL: "http://127.0.0.1:9/v1",
  AI_MODEL: "test-model",
  AI_API_KEY: "test-key",
};

/** request.input 是 branded ValidatedNewGameInput：沿用域校验而非强转。 */
const scenarioInput = (() => {
  const validated = validateNewGameInput(
    (wuxiaFixture as unknown as { input: NewGameInput }).input
  );
  if (!validated.ok) throw new Error("fixture 输入必须合法");
  return validated.value;
})();

describe("source factories captureSink passthrough", () => {
  it("runtimeNarrativeSourceFactory 透传 captureSink 到 live source", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
        relevantFactIds: [], allowedRevealFactIds: [],
        suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
        introducedEntities: [], pacing: "setup",
        proposedNewLocations: [], proposedNewNpcs: [],
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createRuntimeNarrativeSources(validEnv, { captureSink: sink });
      const result = await sources.directorSource.generate({
        traceId: "t-factory",
        context: {
          actionCandidates: [
            { actionKey: "observe:loc_a", kind: "observe", label: "观察" },
            { actionKey: "move:loc_b", kind: "move", label: "前往" },
          ],
          npcIdsPresent: [],
          discoveredFactIds: [],
          progression: { allowedPacing: ["setup"] },
        } as unknown as Record<string, unknown>,
      });
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("director");
  });

  it("scenarioCandidateSourceFactory 透传 captureSink 到 live source", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        world: {}, openingScene: {}, player: {},
        locations: [], npcs: [], quests: [], items: [], enemies: [], endings: [],
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const source = createScenarioCandidateSource(validEnv, { captureSink: sink });
      const result = await source.generate({
        traceId: "t-factory-scenario",
        seed: "test-seed",
        input: scenarioInput,
      });
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("scenario");
  });
});
