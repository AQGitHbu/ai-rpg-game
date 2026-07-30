import { describe, expect, it } from "vitest";
import { createRuntimeNarrativeFixtureSources } from "./runtimeNarrativeFixtureSource";
import { NARRATIVE_CONTRACT_VERSION } from "../../runtimeNarrative";

describe("runtimeNarrativeFixtureSource", () => {
  const sources = createRuntimeNarrativeFixtureSources();

  it("导演 source 返回 fixture plan", async () => {
    const attempt = await sources.directorSource.generate({
      traceId: "test-director",
      context: {},
    });
    expect(attempt.ok).toBe(true);
    if (attempt.ok) {
      expect(attempt.plan.sceneGoal).toBe("fixture 目标：展示叙事能力");
      expect(attempt.provenance).toBe("fixture");
      expect(attempt.diagnostics.contractVersion).toBe(NARRATIVE_CONTRACT_VERSION);
    }
  });

  it("编剧 source 返回 fixture script", async () => {
    const attempt = await sources.sceneScriptSource.generate({
      traceId: "test-script",
      context: {},
    });
    expect(attempt.ok).toBe(true);
    if (attempt.ok) {
      expect(attempt.script.narration).toBe("你来到一处安静的地方。微风吹过，带来远方的消息。");
      expect(attempt.script.choices).toHaveLength(2);
    }
  });

  it("演员 source 返回 fixture performance", async () => {
    const attempt = await sources.npcLineSource.generate({
      traceId: "test-npc-line",
      context: {},
    });
    expect(attempt.ok).toBe(true);
    if (attempt.ok) {
      expect(attempt.performance.text).toBe("你好，旅行者。");
      expect(attempt.performance.emotion).toBe("neutral");
    }
  });
});
