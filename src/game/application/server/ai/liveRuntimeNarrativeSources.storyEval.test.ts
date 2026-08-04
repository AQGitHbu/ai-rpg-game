/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { AiTransport } from "@ai-game/ai-transport";
import type { StoryEvalCallRecord, StoryEvalSink } from "../../storyEvalCaptureTypes";
import { createLiveRuntimeNarrativeSources } from "./liveRuntimeNarrativeSources";

const config = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" };

const contextWithCandidates = {
  actionCandidates: [
    { actionKey: "observe:loc_a", kind: "observe", label: "观察" },
    { actionKey: "move:loc_b", kind: "move", label: "前往" },
  ],
  npcIdsPresent: [],
  discoveredFactIds: [],
  progression: { allowedPacing: ["setup"] },
};

function okFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("createLiveRuntimeNarrativeSources captureSink", () => {
  it("三角色各捕获一条完整 ai_call，且不改 source 返回值", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = okFetch(JSON.stringify({
      sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
      relevantFactIds: [], allowedRevealFactIds: [],
      suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
      introducedEntities: [], pacing: "setup",
      proposedNewLocations: [], proposedNewNpcs: [],
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: await createTransport(), config, captureSink: sink });

      const director = await sources.directorSource.generate({
        traceId: "t-director",
        context: { ...contextWithCandidates, coverageTargetActionKey: "observe:loc_a" } as unknown as Record<string, unknown>,
      });
      expect(director.ok).toBe(true);

      const writer = await sources.sceneScriptSource.generate({
        traceId: "t-script", // 编排层 writer 请求的真实后缀形态（orchestrateNarrativeScene）
        context: {
          plan: { suggestedActionKeys: ["observe:loc_a", "move:loc_b"] },
          actionCandidates: contextWithCandidates.actionCandidates,
          allowedFactCards: [],
          npcProfile: null,
        } as unknown as Record<string, unknown>,
      });
      expect(writer.ok).toBe(true);

      const npc = await sources.npcLineSource.generate({
        traceId: "t-npcLine", // 编排层 npc 请求的真实后缀形态（orchestrateNarrativeScene）
        context: {
          factCards: [],
          npcProfile: { id: "npc_1", name: "N", role: "村民" },
        } as unknown as Record<string, unknown>,
      });
      expect(npc.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.role)).toEqual(["director", "writer", "npc"]);
    for (const record of records) {
      expect(record.attempt).toBe(1);
      expect(record.messages.length).toBeGreaterThanOrEqual(2);
      expect(record.rawResponse).toContain("suggestedActionKeys");
      expect(record.parsedCandidate).not.toBeNull();
      expect(record.failureCategory).toBeNull();
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    }
    // traceId 归一化为场景级 id（去角色/重试后缀）——与编排层审批事件共用关联键
    expect(records.map((record) => record.traceId)).toEqual(["t", "t", "t"]);
    expect(records[0].messages[0].content).toContain("Main-quest progression is the priority");
    expect(records[0].messages[0].content).toContain("Blueprint expansion is a rare fallback");
  });

  it("同场景重试 attempt 递增（含 3 次尝试），跨场景不泄漏（无全局计数器）", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = okFetch(JSON.stringify({
      sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
      relevantFactIds: [], allowedRevealFactIds: [],
      suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
      introducedEntities: [], pacing: "setup",
      proposedNewLocations: [], proposedNewNpcs: [],
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: await createTransport(), config, captureSink: sink });
      // 场景 a：首次 + 两次重试（编排层 traceId 堆叠：`a-director`、`a-director-retry`、`a-director-retry-retry`）
      await sources.directorSource.generate({
        traceId: "a-director",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      await sources.directorSource.generate({
        traceId: "a-director-retry",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      await sources.directorSource.generate({
        traceId: "a-director-retry-retry",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      // 场景 b：首次调用 attempt 应回到 1（attempt 从 traceId 解析，非全局计数）
      await sources.directorSource.generate({
        traceId: "b-director",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(records.map((record) => record.attempt)).toEqual([1, 2, 3, 1]);
    expect(records.map((record) => record.traceId)).toEqual(["a", "a", "a", "b"]);
  });

  it("解析失败时记录 rawResponse 与 failureCategory，仍走原失败返回", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = okFetch("not json at all");
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: await createTransport(), config, captureSink: sink });
      const result = await sources.directorSource.generate({
        traceId: "t-bad",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("invalid_json");
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].rawResponse).toBe("not json at all");
    expect(records[0].parsedCandidate).toBeNull();
    expect(records[0].failureCategory).toBe("invalid_json");
  });

  it("fenced JSON 的字段引号被 provider 多转义一层时仍可恢复解析", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const malformed = "```json\n{\"narration\":\"前路已明。\",\\\"usedFactIds\\\":[\\\"fact_identity\\\"],\\\"npcInstruction\\\":null,\\\"choices\\\":[{\\\"actionKey\\\":\\\"observe:loc_a\\\",\\\"label\\\":\\\"观察\\\",\\\"strategy\\\":\\\"调查\\\"},{\\\"actionKey\\\":\\\"move:loc_b\\\",\\\"label\\\":\\\"前往\\\",\\\"strategy\\\":\\\"推进\\\"}]}\n```";
    vi.spyOn(globalThis, "fetch").mockImplementation(okFetch(malformed));
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: await createTransport(), config, captureSink: sink });
      const result = await sources.sceneScriptSource.generate({
        traceId: "t-escaped-writer",
        context: {
          plan: { suggestedActionKeys: ["observe:loc_a", "move:loc_b"] },
          actionCandidates: contextWithCandidates.actionCandidates,
          allowedFactCards: [{ id: "fact_identity", text: "身份", source: "player_input" }],
          npcProfile: null,
        } as unknown as Record<string, unknown>,
      });
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].failureCategory).toBeNull();
    expect(records[0].parsedCandidate).toMatchObject({ usedFactIds: ["fact_identity"] });
  });

  it("未传 captureSink 时行为与现状一致（不抛错、正常返回）", async () => {
    const fetchSpy = okFetch(JSON.stringify({
      sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
      relevantFactIds: [], allowedRevealFactIds: [],
      suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
      introducedEntities: [], pacing: "setup",
      proposedNewLocations: [], proposedNewNpcs: [],
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: await createTransport(), config });
      const result = await sources.directorSource.generate({
        traceId: "t-plain",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("评估 timeoutMs 会透传到 transport，并在短超时后返回 timeout", async () => {
    const complete = vi.fn(async (_config, _messages, options) => {
      expect(options?.timeoutMs).toBe(10);
      return { ok: false as const, code: "timeout" as const, retryable: true, latencyMs: 10 };
    });
    const transport = { complete } as unknown as AiTransport;
    const sources = createLiveRuntimeNarrativeSources({ transport, config, timeoutMs: 10 });
    const result = await sources.directorSource.generate({
      traceId: "t-timeout",
      context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("timeout");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("按 thinkingRoles 只为选中的角色开启 provider extended reasoning", async () => {
    const calls: unknown[] = [];
    const complete = vi.fn(async (_config, _messages, options) => {
      calls.push(options);
      return { ok: true as const, content: "{}", latencyMs: 1 };
    });
    const transport = { complete } as unknown as AiTransport;
    const sources = createLiveRuntimeNarrativeSources({
      transport,
      config,
      thinkingRoles: ["director", "writer"]
    });

    await sources.directorSource.generate({
      traceId: "thinking-director",
      context: { ...contextWithCandidates } as unknown as Record<string, unknown>
    });
    await sources.sceneScriptSource.generate({
      traceId: "thinking-script",
      context: { ...contextWithCandidates } as unknown as Record<string, unknown>
    });
    await sources.npcLineSource.generate({
      traceId: "thinking-npcLine",
      context: { ...contextWithCandidates } as unknown as Record<string, unknown>
    });

    expect(calls.map((call) => (call as { extraBody: { enable_thinking: boolean } }).extraBody.enable_thinking)).toEqual([
      true,
      true,
      false
    ]);
    expect(calls.map((call) => (call as { extraBody: { chat_template_kwargs: { enable_thinking: boolean } } }).extraBody.chat_template_kwargs.enable_thinking)).toEqual([
      true,
      true,
      false
    ]);
  });
});

async function createTransport() {
  // 与 runtimeNarrativeSourceFactory 相同的生产 transport：默认 fetch（测试中已 mock）。
  // 通过动态 import 避免顶层加载 @ai-game/ai-transport 副作用；
  // 该 package 为 ESM-only（exports 仅 "import" 条件），require() 无法加载。
  return (await import("@ai-game/ai-transport")).createOpenAiCompatibleTransport();
}
