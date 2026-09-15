import { describe, expect, it } from "vitest";
import { createWorldStateFixture, emptyProjection } from "@/game/domain/testing/worldStateFixture.testutil";
import { asFactId, asGenerationId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { asNarrativeJobId, asTurnId } from "@/game/domain/events";
import { createInitialStoryState } from "@/game/domain/storyState";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { entitiesOfKind } from "@/game/domain/entity";
import type { Action } from "@/game/domain/action";
import { approveStoryConsequenceBindings } from "../approveStoryConsequenceBindings";
import { installStoryInteractionProposals } from "../approveNarrativeBundle";
import { resolveTurn } from "@/game/gameplay/rpg/ruleEngine";
import { availableInvestigations } from "@/game/gameplay/rpg/investigation";

describe("P3 craft evidence without delivery dependencies", () => {
  it("opens a supervised material test only after the artisan is actually told the sample result", () => {
    const locationId = asLocationId("loc_workshop");
    const artisanId = asNpcId("npc_kiln_artisan");
    const apprenticeId = asNpcId("npc_kiln_apprentice");
    const sampleId = asFactId("fact_clay_sample");
    const firingId = asFactId("fact_firing_record");
    let worldState = createWorldStateFixture({
      generation: { generationId: asGenerationId("craft_generation"), seed: "clay", templateVersion: "test", inputDigest: "", gameType: "wuxia" },
      projection: {
        ...emptyProjection({ player: { name: "学徒", identity: "陶工", stats: { hp: 30, attack: 2, defense: 2 } },
          locations: [{ id: locationId, name: "试泥作坊", description: "试片与窑温记录放在案边。", kind: "main", scale: "scene",
            connectedLocationIds: [], npcIds: [artisanId, apprenticeId], availableItemIds: [], tags: [] }], currentLocationId: locationId }),
        npcs: [artisanId, apprenticeId].map((id) => ({ id, name: id === artisanId ? "窑师" : "助手", role: "陶工", description: "负责试烧", locationId,
          isCompanion: false, met: true, tags: [], memory: { npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [],
            relationship: { affinity: 0 }, emotion: "neutral", goals: ["确认泥料样本的性质"] } })),
        worldFacts: [{ factId: sampleId, text: "样本含较多细砂，适合缓慢升温。", source: "generated", discovered: false,
          discoveryMode: "automatic", locationId, investigationLabel: "泥料样本" }, { factId: firingId, text: "慢升温试片没有开裂。", source: "generated", discovered: false,
          discoveryMode: "automatic", locationId, investigationLabel: "试烧记录" }],
      },
    });
    let storyState = createInitialStoryState({ initialNarrative: createFixtureNarrativeRuntimeState(), gameLength: "short",
      initialEntityCounts: { locations: 1, npcs: 2, quests: 0, events: 0 } });
    const bound = approveStoryConsequenceBindings({ worldState, storyState, symbols: new Map(), proposal: [
      { kind: "bind_goal_resolution", npcRef: artisanId, goalOrdinal: 0, resolution: {
        completeWhen: [{ kind: "investigation_observed", npcId: artisanId, factId: sampleId, evidenceQuality: "clean" }], blockWhen: [],
      } },
      { kind: "bind_investigation", factRef: sampleId, discoveryMode: "investigation", approaches: [
        { approachId: "sieve", label: "筛检留存泥样", evidenceQuality: "clean", tensionDelta: 0, requirements: [] },
        { approachId: "scrape", label: "刮取粗略样本", evidenceQuality: "noisy", tensionDelta: 1 },
      ] },
      { kind: "bind_investigation", factRef: firingId, discoveryMode: "investigation", approaches: [
        { approachId: "read_record", label: "自行查阅窑温记录", evidenceQuality: "noisy", tensionDelta: 1 },
        { approachId: "supervised", label: "请窑师指导试烧", evidenceQuality: "clean", tensionDelta: 0,
          requirements: [{ kind: "goal_status", npcId: artisanId, goalOrdinal: 0, status: "completed" }], witnessNpcIds: [artisanId] },
      ] },
    ] });
    expect(bound, JSON.stringify(bound)).toMatchObject({ ok: true });
    if (!bound.ok) throw new Error(bound.code);
    worldState = bound.worldState;
    let actionCount = 0;
    const act = (action: Action) => {
      const turnId = asTurnId(`craft_turn_${++actionCount}`);
      return resolveTurn(worldState, storyState, action, `craft_action_${actionCount}`, actionCount - 1, turnId, "fixed_choice",
        { now: () => "2026-09-16T00:00:00.000Z", turnId });
    };
    const accept = (action: Action) => {
      const result = act(action);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.code);
      worldState = result.resolution.nextWorldState;
      storyState = result.resolution.nextStoryState;
    };
    const available = () => availableInvestigations({ worldState, storyState }).map((entry) => entry.approachId);
    const supervised: Action = { type: "investigate", factId: firingId, approachId: "supervised" };
    expect(available()).not.toContain("supervised");
    expect(act(supervised).ok).toBe(false);
    accept({ type: "investigate", factId: sampleId, approachId: "sieve" });
    const discovery = worldState.eventLedger.find((event) => event.payload.type === "fact_discovered" && event.payload.factId === sampleId);
    expect(discovery).toBeDefined();
    expect(available()).not.toContain("supervised");
    expect(entitiesOfKind(worldState.entityStore, "npc").find((npc) => npc.core.id === artisanId)?.knowledge.entries
      .some((entry) => entry.factId === sampleId)).toBe(false);
    const installShare = (npcId: typeof artisanId) => {
      const result = installStoryInteractionProposals({ worldState, jobId: asNarrativeJobId(`craft_share_${npcId}`), proposals: [{
        proposalKey: "report_sample", npcId, operation: "share_known_fact", condition: [], factIds: [sampleId], goalIds: [],
        promiseId: null, audienceIds: [npcId], evidenceEventIds: [discovery!.eventId],
      }] });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.detail);
      worldState = result.worldState;
      return entitiesOfKind(worldState.entityStore, "npc").find((npc) => npc.core.id === npcId)!.interactions![0]!.id;
    };
    const assistantShare = installShare(apprenticeId);
    accept({ type: "talk", npcId: apprenticeId, dialogueAct: "ask", interactionId: assistantShare });
    expect(available()).not.toContain("supervised");
    expect(act(supervised).ok).toBe(false);
    const artisanShare = installShare(artisanId);
    const told: Action = { type: "talk", npcId: artisanId, dialogueAct: "ask", interactionId: artisanShare };
    accept(told);
    expect(available()).toContain("supervised");
    const goalEvents = () => worldState.eventLedger.filter((event) => event.payload.type === "npc_goal_status_changed");
    expect(goalEvents()).toHaveLength(1);
    expect(goalEvents()[0]!.causeEventIds).toContain(worldState.eventLedger.find((event) => event.payload.type === "story_interaction_resolved"
      && event.payload.npcId === artisanId)!.eventId);
    const repeat = act(told);
    if (repeat.ok) { worldState = repeat.resolution.nextWorldState; storyState = repeat.resolution.nextStoryState; }
    expect(goalEvents()).toHaveLength(1);
    accept(supervised);
    expect(worldState.eventLedger.filter((event) => event.payload.type === "fact_discovered" && event.payload.factId === firingId)).toHaveLength(1);
    expect(act(supervised).ok).toBe(false);
    expect(worldState.inventory).toEqual([]);
    expect(worldState.eventLedger.some((event) => event.payload.type === "item_given")).toBe(false);
  });
});
