import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { describe, it, expect, vi } from "vitest";
import { evolveWorld } from "./evolveWorld";
import type { EvolveWorldInput } from "./evolveWorld";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { StoryState } from "@/game/domain/storyState";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createInitialWorldState } from "@/game/domain/worldState";
import type { WorldState } from "@/game/domain/worldState";
import { asLocationId, asGenerationId } from "@/game/domain/worldEntity";

function makeWorld(): WorldState {
  return createInitialWorldState({
    generation: { generationId: asGenerationId("g1"), seed: "seed-a", templateVersion: "v2", inputDigest: "", gameType: "wuxia" },
    player: { name: "林惊羽", identity: "外门弟子", stats: { hp: 100, attack: 10, defense: 5 } },
    startingLocation: {
      id: asLocationId("loc_0"), name: "客栈", description: "山脚小镇的客栈。", kind: "main",
      connectedLocationIds: [], npcIds: [], availableItemIds: [], tags: [],
    },
    startingItemIds: [],
  });
}

function makeStory(overrides?: Partial<StoryState>): StoryState {
  const base = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short", initialEntityCounts: { locations: 1, npcs: 0, quests: 1, events: 0 } });
  return {
    ...base,
    evolution: {
      nextLocationOrdinal: 1,
      nextNpcOrdinal: 1,
      nextItemOrdinal: 0,
      nextEnemyOrdinal: 0,
      nextFactOrdinal: 0,
      nextQuestOrdinal: 1,
      nextEndingOrdinal: 0,
      status: "stable",
    } as StoryState["evolution"],
    ...overrides,
  };
}

function proposalWith(defaults: Partial<WorldDeltaProposal>): WorldDeltaProposal {
  return {
    beatSummary: "新的地点与人物浮现",
    newLocation: null,
    newNpc: null,
    newItem: null,
    newEnemy: null,
    newFact: null,
    nextMainQuest: null,
    endingPair: null,
    ...defaults,
  };
}

function baseInput(overrides: Partial<EvolveWorldInput>): EvolveWorldInput {
  return {
    need: { kind: "pacing", pacingNeed: "complicate" },
    worldState: makeWorld(),
    storyState: makeStory(),
    reason: "scene_evolution",
    now: () => "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("evolveWorld content repair 重试", () => {
  it("审批拒绝（NPC 引用越权）后做一次内容修复：source 调用 2 次，二次收到 approval_rejected 与稳定 code", async () => {
    const world = makeWorld();
    const bad: WorldDeltaProposal = proposalWith({
      newLocation: { name: "青山别院", description: "独立的别院。", scale: "scene", placement: "world", connectFromLocationId: "loc_0" },
      newNpc: {
        name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "existing", id: "loc_missing" },
        anchors: { selfConcept: "替人传话的信使", values: ["守信"], speechStyle: "谨慎而直接", capabilityBoundaries: ["只知道亲身见闻"], taboos: [] },
        goals: [{ horizon: "short", description: "送达密信", priority: 3, reason: "必须完成传递" }],
      },
    });
    const good: WorldDeltaProposal = proposalWith({
      newLocation: bad.newLocation!,
      newNpc: {
        name: "新出现的信使", role: "传话人", description: "风尘仆仆的赶路人。",
        locationRef: { kind: "new_location" },
        anchors: { selfConcept: "替人传话的信使", values: ["守信"], speechStyle: "谨慎而直接", capabilityBoundaries: ["只知道亲身见闻"], taboos: [] },
        goals: [{ horizon: "short", description: "送达密信", priority: 3, reason: "必须完成传递" }],
      },
    });
    const source: WorldEvolutionSource = {
      propose: vi.fn()
        .mockResolvedValueOnce({ ok: true, proposal: bad })
        .mockResolvedValueOnce({ ok: true, proposal: good }),
    };

    const result = await evolveWorld(baseInput({ worldState: world, source }));

    expect(source.propose).toHaveBeenCalledTimes(2);
    const secondCtx = (source.propose as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { readonly contentRepair?: unknown };
    expect(secondCtx.contentRepair).toEqual({
      attempt: 1, reason: "approval_rejected", approvalCode: "invalid_location_ref",
    });
    expect(result.ok).toBe(true);
  });

  it("审批拒绝（重复地点名）后做一次内容修复并成功", async () => {
    const world = makeWorld();
    const bad: WorldDeltaProposal = proposalWith({
      newLocation: { name: "客栈", description: "与现有地点重名。", scale: "scene", placement: "world", connectFromLocationId: "loc_0" },
    });
    const good: WorldDeltaProposal = proposalWith({
      newLocation: { name: "青山别院", description: "独立的别院。", scale: "scene", placement: "world", connectFromLocationId: "loc_0" },
    });
    const source: WorldEvolutionSource = {
      propose: vi.fn()
        .mockResolvedValueOnce({ ok: true, proposal: bad })
        .mockResolvedValueOnce({ ok: true, proposal: good }),
    };

    const result = await evolveWorld(baseInput({ worldState: world, source }));

    expect(source.propose).toHaveBeenCalledTimes(2);
    const secondCtx = (source.propose as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { readonly contentRepair?: unknown };
    expect(secondCtx.contentRepair).toEqual({
      attempt: 1, reason: "approval_rejected", approvalCode: "duplicate_name",
    });
    expect(result.ok).toBe(true);
  });

  it("解析失败后做一次内容修复（invalid_reference）并在修复仍失败时返回 AI_RESPONSE_INVALID", async () => {
    const source: WorldEvolutionSource = {
      propose: vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          failure: { kind: "AI_RESPONSE_INVALID", phase: "world" },
          repairReason: "invalid_reference",
        })
        .mockResolvedValueOnce({
          ok: false,
          failure: { kind: "AI_RESPONSE_INVALID", phase: "world" },
          repairReason: "invalid_reference",
        }),
    };

    const result = await evolveWorld(baseInput({ source }));

    expect(source.propose).toHaveBeenCalledTimes(2);
    const secondCtx = (source.propose as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { readonly contentRepair?: unknown };
    expect(secondCtx.contentRepair).toEqual({ attempt: 1, reason: "invalid_reference" });
    expect(result).toMatchObject({ ok: false, code: "source_error", failure: { kind: "AI_RESPONSE_INVALID" } });
  });

  it("proposal===null 时做一次 invalid_schema 修复，二次仍 null 返回 no_proposal", async () => {
    const source: WorldEvolutionSource = {
      propose: vi.fn()
        .mockResolvedValueOnce({ ok: true, proposal: null })
        .mockResolvedValueOnce({ ok: true, proposal: null }),
    };

    const result = await evolveWorld(baseInput({ source }));

    expect(source.propose).toHaveBeenCalledTimes(2);
    const secondCtx = (source.propose as ReturnType<typeof vi.fn>).mock.calls[1]![0] as { readonly contentRepair?: unknown };
    expect(secondCtx.contentRepair).toEqual({ attempt: 1, reason: "invalid_schema" });
    expect(result).toMatchObject({ ok: false, code: "no_proposal", failure: { kind: "AI_RESPONSE_INVALID" } });
  });

  it("传输失败不带 repairReason，不进内容修复循环", async () => {
    const source: WorldEvolutionSource = {
      propose: vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          failure: { kind: "AI_CALL_FAILED", phase: "world" },
        }),
    };

    const result = await evolveWorld(baseInput({ source }));

    expect(source.propose).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, code: "source_error", failure: { kind: "AI_CALL_FAILED" } });
  });
});
