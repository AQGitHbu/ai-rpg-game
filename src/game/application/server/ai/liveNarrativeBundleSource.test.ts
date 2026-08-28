import { describe, expect, it, vi } from "vitest";
import type { AiMessage } from "@ai-game/ai-transport";
import type { RpgAiClient } from "./rpgAiClient";
import { createNarrativeBundleSource } from "./liveNarrativeBundleSource";
import type { NarrativeBundleSourceContext } from "../../narrativeBundleSource";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import {
  asLocationId,
  asNpcId,
  asGenerationId,
} from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";
import { createFixtureOpeningCandidateSource } from "../../createGame";

function mockAiClient(complete: ReturnType<typeof vi.fn>): RpgAiClient {
  return {
    complete,
    policy: () => ({
      thinking: "off" as const,
      timeoutMs: 240_000,
      maxTokens: 5_000,
      jsonMode: "prompt_only" as const,
      maxAttempts: 1,
    }),
  };
}

function makeWorldState(): WorldState {
  return createInitialWorldState({
    generation: {
      generationId: asGenerationId("g1"),
      seed: "seed",
      templateVersion: "v1",
      inputDigest: "",
      gameType: "wuxia",
    },
    player: { name: "侠客", identity: "旅人", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"),
      name: "小镇",
      description: "山脚下的小镇。",
      kind: "main",
      connectedLocationIds: [],
      npcIds: [],
      availableItemIds: [],
      tags: [],
    },
    startingItemIds: [],
  });
}

function makeStoryState(): StoryState {
  return createInitialStoryState({
    initialNarrative: createFixtureNarrativeRuntimeState(),
    gameLength: "short",
    initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 },
  });
}

function makeJob(): PendingNarrativeJob {
  return {
    jobId: asNarrativeJobId("job_1"),
    turnId: "turn_1" as never,
    actionId: "act_1",
    expectedRevision: 0,
    turnNumber: 1,
    actionSummary: { kind: "talk", npcId: asNpcId("npc_1") },
    utterance: undefined,
    resolvedEvent: {
      actionId: "act_1",
      status: "success",
      eventKind: "dialogue",
      facts: [],
      stateChanges: [],
      costs: [],
      rewards: [],
      triggeredEvents: [],
      rejectedEffects: [],
    },
    domainEventRange: { fromLedgerIndex: 0, toLedgerIndexExclusive: 1 },
    focusNpcId: asNpcId("npc_1"),
    requestedAt: "2026-01-02",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  } as unknown as PendingNarrativeJob;
}

const validBundleResponse = {
  worldDelta: null,
  currentScene: {
    segments: [{ beatId: "atmosphere", text: "场景旁白" }],
    npcLine: {
      npcId: "npc_1",
      text: "你来了。",
      emotion: "neutral",
      answeredBeatIds: [],
      usedFactIds: [],
      usedInteractionActionIds: [],
    },
    objectiveLink: null,
    choices: [
      { candidateId: "support", label: "表示赞同" },
      { candidateId: "challenge", label: "提出质疑" },
    ],
  },
  continuationScenes: [],
  terminal: { kind: "next_decision", target: { kind: "current_scene" } },
};

describe("createNarrativeBundleSource", () => {
  it("calls aiClient.complete with narrative_bundle role exactly once", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const context: NarrativeBundleSourceContext = {
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    };

    const result = await source.generate(context);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      "narrative_bundle",
      expect.any(Array),
      expect.objectContaining({ purpose: "narrative_bundle_generation" }),
    );
    expect(result.ok).toBe(true);
  });

  it("returns failure when AI client is unavailable", async () => {
    const source = createNarrativeBundleSource({});
    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("AI_CALL_FAILED");
    }
  });

  it("returns failure when AI returns invalid JSON", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: "not json",
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("AI_RESPONSE_INVALID");
    }
  });

  it("normalizes legacy decision presentation fields without inventing narrative text", async () => {
    const legacy = {
      ...validBundleResponse,
      currentScene: {
        ...validBundleResponse.currentScene,
        npcLine: "我知道一些内情。",
        objectiveLink: { questId: "旧任务名称", objectiveText: "旧格式的提示" },
        choices: [
          { candidateId: "support", text: "相信他。" },
          { candidateId: "challenge", text: "质疑他。" },
        ],
      },
    };
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(legacy) });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    expect(result.proposal.currentScene.npcLine).toMatchObject({ npcId: "npc_1", text: "我知道一些内情。" });
    expect(result.proposal.currentScene.objectiveLink).toBeNull();
    expect(result.proposal.currentScene.choices.map((choice) => choice.label)).toEqual(["相信他。", "质疑他。"]);
  });

  it("returns failure when AI returns an error", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: false,
      code: "rate_limited",
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    expect(result.ok).toBe(false);
  });

  it("prompt contains symbolic reference whitelist and step limit", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState: makeStoryState(),
      job: makeJob(),
    });

    const call = complete.mock.calls[0]!;
    const messages = call[1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    expect(systemPrompt).toContain("@new.location");
    expect(systemPrompt).toContain("@new.npc");
    expect(systemPrompt).toContain("12");
    expect(systemPrompt).toContain("current_scene");
    expect(systemPrompt).toContain("continuation_step");
    expect(systemPrompt).toContain("禁止鬼魂");
  });

  it("projects the post-expansion arrival graph for a next-act response", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify(validBundleResponse),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const storyState = {
      ...makeStoryState(),
      currentAct: 2,
      evolution: { ...makeStoryState().evolution, status: "needs_next_act" as const },
    };

    await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState,
      job: makeJob(),
    });

    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const systemPrompt = messages[0]!.content as string;
    const locationId = `loc_dyn_${storyState.evolution.nextLocationOrdinal}`;
    const npcId = `npc_dyn_${storyState.evolution.nextNpcOrdinal}`;
    expect(systemPrompt).toContain(`move:${locationId}`);
    expect(systemPrompt).toContain(`move:${locationId}_choice_1`);
    expect(systemPrompt).toContain(npcId);
    expect(systemPrompt).toContain('"kind":"continuation_step"');
    expect(systemPrompt).not.toContain('terminal: {"kind":"ending"}');
  });

  it("normalizes a flattened next-act continuation without changing its text", async () => {
    const nextLocationOrdinal = makeStoryState().evolution.nextLocationOrdinal;
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        worldDelta: {
          beatSummary: "旧案指向镇外。",
          newLocation: { name: "枯柳驿", description: "荒废驿站。", scale: "scene", placement: "world", connectFromLocationId: "loc_0" },
          newNpc: { name: "老驼子", role: "守夜人", description: "警惕的守夜人。", locationRef: { kind: "new_location" }, goals: ["守住秘密"] },
          newItem: { name: "半块令牌", description: "断裂的令牌。", locationRef: "new_location" },
          newEnemy: { name: "蒙面劫匪", tier: "normal", locationRef: "new_location" },
          newFact: null,
          nextMainQuest: { name: "枯柳驿线索", description: "前往荒废驿站。", objectiveText: "调查枯柳驿" },
          endingPair: null,
        },
        currentScene: {
          segments: [{ beatId: "closing", text: "柳三娘递来一枚铜钱。" }],
          npcLine: { npcId: "npc_1", text: "去枯柳驿看看。", emotion: "warm", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
          objectiveLink: { questId: "nextMainQuest", text: "旧格式" },
          choices: [],
        },
        continuationScenes: [{
          segments: [{ beatId: "arrival", text: "你抵达枯柳驿。" }],
          npcLine: { npcId: "npc_dyn_1", text: "来者何人？", emotion: "guarded", answeredBeatIds: [], usedFactIds: [], usedInteractionActionIds: [] },
          objectiveLink: { questId: "nextMainQuest", text: "旧格式" },
          choices: [
            { candidateId: "wrong_1", label: "表明身份" },
            { candidateId: "wrong_2", label: "先行试探" },
          ],
          terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: "wrong" } },
        }],
        terminal: { kind: "next_decision", target: { kind: "continuation_step", stepKey: `move:loc_dyn_${nextLocationOrdinal}` } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });
    const storyState = {
      ...makeStoryState(),
      currentAct: 2,
      evolution: { ...makeStoryState().evolution, status: "needs_next_act" as const },
    };

    const result = await source.generate({
      kind: "decision",
      worldState: makeWorldState(),
      storyState,
      job: makeJob(),
    });

    expect(result).toMatchObject({ ok: true, kind: "decision" });
    if (!result.ok || result.kind !== "decision") return;
    const stepKey = `move:loc_dyn_${storyState.evolution.nextLocationOrdinal}`;
    expect(result.proposal.continuationScenes[0]).toMatchObject({
      stepKey,
      scene: {
        segments: [{ text: "你抵达枯柳驿。" }],
        objectiveLink: null,
        choices: [
          { candidateId: `${stepKey}_choice_1`, label: "表明身份" },
          { candidateId: `${stepKey}_choice_2`, label: "先行试探" },
        ],
      },
    });
  });

  it("parses an opening proposal and emits the initialization audit link", async () => {
    const opening = await createFixtureOpeningCandidateSource().generate({
      gameType: "wuxia",
      gameLength: "short",
      seed: "opening-live-source",
    });
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        opening,
        currentScene: {
          segments: [{ beatId: "opening", text: "客栈里风声低沉。" }],
          npcLine: {
            npcId: "npc_0",
            text: "我等你很久了。",
            emotion: "guarded",
            answeredBeatIds: [],
            usedFactIds: ["fact_0"],
            usedInteractionActionIds: [],
          },
          objectiveLink: null,
          choices: [
            { candidateId: "support", label: "我愿意帮忙。" },
            { candidateId: "challenge", label: "先说清楚缘由。" },
          ],
        },
        continuationScenes: [],
        terminal: { kind: "next_decision", target: { kind: "current_scene" } },
      }),
    });
    const source = createNarrativeBundleSource({ aiClient: mockAiClient(complete) });

    const result = await source.generate({
      kind: "opening",
      jobId: asNarrativeJobId("job-opening"),
      input: { gameType: "wuxia", gameLength: "short", seed: "opening-live-source" },
      auditLink: { gameId: "game-opening", traceId: "trace-opening" },
    });

    expect(result).toMatchObject({ ok: true, kind: "opening" });
    expect(complete).toHaveBeenCalledWith(
      "narrative_bundle",
      expect.any(Array),
      expect.objectContaining({
        purpose: "narrative_bundle_generation",
        trigger: "initialization",
        gameId: "game-opening",
        traceId: "trace-opening",
        jobId: "job-opening",
        turnNumber: 0,
      }),
    );
    const prompt = (complete.mock.calls[0]![1] as readonly AiMessage[])[0]!.content as string;
    expect(prompt).toContain("backgroundSummary");
    expect(prompt).toContain('"targetActs": 3');
    expect(prompt).toContain('"scale": "town"');
  });
});
