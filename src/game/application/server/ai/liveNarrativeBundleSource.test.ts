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
  asQuestId,
} from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";

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
    npcLine: null,
    objectiveLink: null,
    choices: [],
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
  });
});
