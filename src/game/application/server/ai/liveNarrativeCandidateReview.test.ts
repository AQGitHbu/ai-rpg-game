import { createEntityStore, projectEntityStore } from "@/game/domain/entity";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import { asItemId, asQuestId } from "@/game/domain/worldEntity";
import { projectNarrativeDraft } from "./narrativeDraftProjection";
import { describe, expect, it, vi } from "vitest";
import type { AiMessage } from "@ai-game/ai-transport";
import type { NarrativeBundleSourceContext } from "../../narrativeBundleSource";
import { hashNarrativeCandidate } from "../../narrativeCandidateReview";
import { createLiveNarrativeCandidateReview } from "./liveNarrativeCandidateReview";
import type { RpgAiClient } from "./rpgAiClient";
import { createNarrativeBundleSource } from "./liveNarrativeBundleSource";
import observedArrival from "./testing/p1-focused-02-arrival-candidate.json";
import { buildNarrativeReviewRules } from "./narrativeReviewRules";
import type { NarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import observedOpening from "./testing/p1-07-opening-candidate.json";
import { compileOpeningGenerationCandidate } from "@/game/gameplay/rpg/openingGeneration";
import { createFixtureNarrativeRuntimeState } from "@/game/domain/narrativeTestFixture.testutil";
import { createInitialWorldState } from "@/game/domain/worldState";
import { createInitialStoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { asNarrativeJobId, asEventId } from "@/game/domain/events";
import { buildDecisionNarrativeContextBlocks } from "./narrativeContext/narrativeBundleContext";
import { compileDecisionNarrativeContext } from "./narrativeContext";
import { asLocationId, asNpcId, asGenerationId, asFactId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";

const candidate = {
  worldDelta: null,
  currentScene: {
    segments: [{ beatId: "atmosphere", text: "场景" }],
    npcLine: null,
    objectiveLink: null,
    choices: [],
  },
  continuationScenes: [],
  terminal: { kind: "ending" },
} as never;

const reviewContext = {
  kind: "opening",
  jobId: "job-review",
  input: { gameType: "wuxia", gameLength: "short", seed: "review" },
} as unknown as NarrativeBundleSourceContext;

function client(complete: ReturnType<typeof vi.fn>): RpgAiClient {
  return {
    complete,
    policy: () => ({
      thinking: "off",
      timeoutMs: 45_000,
      maxTokens: 2_000,
      jsonMode: "prompt_only",
      maxAttempts: 1,
    }),
  };
}

function makeWorldState() {
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


function makeStoryState() {
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
    domainEventIds: [asEventId("turn-1:event-1")],
    focusNpcId: asNpcId("npc_1"),
    requestedAt: "2026-01-02",
    objectiveTransition: { before: null, completed: [], after: null, mode: "unchanged" },
    mandatoryBeats: [],
    generationKind: "npc_fixed_choice",
    sceneRequestKind: "npc_response",
  } as unknown as PendingNarrativeJob;
}


describe("live narrative candidate reviewer", () => {
  it.each([false, true])("projects conditional ending action authority before/after pair materialization: %s", async (hasPair) => {
    const initial = makeWorldState();
    const npcId = asNpcId("npc_final");
    const remoteId = asNpcId("npc_remote");
    const remoteLocationId = asLocationId("loc_remote");
    const worldState = createWorldStateFixtureWith({ generation: initial.generation, base: projectEntityStore(initial.entityStore) }, {
      npcs: [remoteId, asNpcId("npc_unseen"), npcId].map(id => ({ id, name: String(id), role: "掌柜", description: "商人", locationId: id === npcId ? initial.currentLocationId : remoteLocationId, isCompanion: false, met: id !== "npc_unseen", tags: [],
        memory: { npcId: id, knownFactIds: [], hiddenFactIds: [], interactionHistory: [], relationship: { affinity: 0 }, emotion: "neutral", goals: [] } })),
      locations: [...initial.locations.map(location => ({ ...location, npcIds: [npcId] })), { ...initial.locations[0]!, id: remoteLocationId, name: "远处", npcIds: [remoteId, asNpcId("npc_unseen")] }],
      ...(hasPair ? { endings: [
        { id: "ending_trust" as never, name: "合作", description: "合作", requirements: [{ kind: "npc_affinity_at_least" as const, npcId, value: 10 }] },
        { id: "ending_doubt" as never, name: "分歧", description: "分歧", requirements: [{ kind: "npc_affinity_at_most" as const, npcId, value: 9 }] },
      ] } : {}),
    });
    const baseStory = makeStoryState();
    const context = { kind: "decision" as const, worldState, storyState: { ...baseStory, endingAllowed: true,
      evolution: { ...baseStory.evolution, status: "needs_ending_pair" as const } }, job: { ...makeJob(), focusNpcId: npcId } };
    const original = JSON.stringify(context);
    const projection = projectNarrativeDraft(context);
    expect(projection.endingResolutions).toHaveLength(2);
    for (const [index, themeKey] of ["trust", "doubt"].entries()) {
      expect(projection.endingResolutions[index]).toMatchObject({
        themeKey, basisKey: `ending:${themeKey}`, generationLocationId: initial.currentLocationId,
        choiceAction: { type: "talk", npcId, dialogueAct: index === 0 ? "support" : "challenge" },
        displayCondition: { kind: "matching_rule_ending", themeKey },
        actionPreviews: expect.arrayContaining([expect.objectContaining({
          action: { type: "talk", npcId, dialogueAct: "support" },
          resultingLocationId: initial.currentLocationId, itemOwnershipChanges: [], newlyDiscoveredFactIds: [],
          npcLocations: [
            { npcId: remoteId, beforeLocationId: remoteLocationId, afterLocationId: remoteLocationId },
            { npcId, beforeLocationId: initial.currentLocationId, afterLocationId: initial.currentLocationId },
          ],
          events: expect.arrayContaining([expect.objectContaining({ kind: "npc_interaction_recorded" })]),
        })]),
      });
      for (const preview of projection.endingResolutions[index]!.actionPreviews) {
        expect("npcLocations" in preview && preview.npcLocations).toEqual([
          { npcId: remoteId, beforeLocationId: remoteLocationId, afterLocationId: remoteLocationId },
          { npcId, beforeLocationId: initial.currentLocationId, afterLocationId: initial.currentLocationId },
        ]);
      }
    }
    expect(JSON.stringify(context)).toBe(original);
    const proposal: NarrativeBundleProposal = { ...(candidate as NarrativeBundleProposal), worldDelta: {
      beatSummary: "双方已经到场共同核验。", newLocation: null, newNpc: null, newItem: null, newEnemy: null, newFact: null, nextMainQuest: null,
      endingPair: [{ themeKey: "doubt", name: "分歧", description: "远处商人已经到场核验。" }, { themeKey: "trust", name: "合作", description: "远处商人已经到场核验。" }],
    }, endingOutcomes: [
      { themeKey: "doubt", choiceLabel: "核清账目后表示异议", scene: { segments: [{ beatId: "atmosphere", text: "你回到远处核清账目，所有欠款都已偿还。" }], npcLine: null, objectiveLink: null, choices: [] } },
      { themeKey: "trust", choiceLabel: "核清账目后表示支持", scene: { segments: [{ beatId: "atmosphere", text: "你回到远处核清账目，所有欠款都已偿还。" }], npcLine: null, objectiveLink: null, choices: [] } },
    ] };
    const rules = buildNarrativeReviewRules({ context, proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(proposal) });
    for (const entry of projection.endingResolutions) expect(rules.find(rule => rule.key === entry.basisKey)?.value).toEqual(entry);
    for (const consumer of ["author", "reviewer"] as const) {
      const prompt = buildDecisionNarrativeContextBlocks({ ...context, consumer }).map(block => block.content).join("\n");
      expect(prompt).toContain(JSON.stringify(projection.endingResolutions));
    }
    const defects = [0, 1].flatMap(index => ["choiceLabel", "scene.segments[0].text"].map(field => ({
      scope: "scene", code: "BROKEN_CAUSALITY", path: `endingOutcomes[${index}].${field}`,
      reason: "支持或质疑没有执行返回与账目核验。",
      evidence: { basisKey: `ending:${index === 0 ? "doubt" : "trust"}`, impact: "action_binding", detail: "真实交谈目标在当前地点；预览没有移动、核验或财物交付，不能将这些行动写成已发生的收束依据。" },
    }))).concat([0, 1].map(index => ({
      scope: "proposal", code: "BROKEN_CAUSALITY", path: `worldDelta.endingPair[${index}].description`, reason: "远处人物未到场。",
      evidence: { basisKey: `ending:${index === 0 ? "doubt" : "trust"}`, impact: "step_order", detail: "已见 NPC 的前后地点相同，不能以自行到场代替未执行的共同核验。" },
    })), [{
      scope: "proposal", code: "BROKEN_CAUSALITY", path: "worldDelta.beatSummary", reason: "选择前摘要提前写入条件结果。",
      evidence: { basisKey: `action:${context.job.actionId}`, impact: "interaction_effect", detail: "本次已提交回应没有双方到场与核验事件。" },
    }]);
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ verdict: "revise", defects }) });
    const reviewed = await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context, proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(proposal),
    });
    expect(reviewed).toMatchObject({ ok: false, defects });
    complete.mockResolvedValueOnce({ ok: true, content: JSON.stringify({ verdict: "revise", defects: [{
      ...defects[0], evidence: { ...defects[0]!.evidence, basisKey: "ending:trust" },
    }] }) });
    expect(await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context, proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(proposal),
    })).toMatchObject({ ok: false, failure: "UNCERTAIN" });
    for (const path of ["worldDelta.endingPair[0].description", "worldDelta.beatSummary"]) {
      complete.mockResolvedValueOnce({ ok: true, content: JSON.stringify({ verdict: "revise", defects: [{
        ...defects[0], path, evidence: { ...defects[0]!.evidence, basisKey: "ending:trust" },
      }] }) });
      expect(await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
        context, proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(proposal),
      })).toMatchObject({ ok: false, failure: "UNCERTAIN" });
    }
    const ordinary = { ...context, storyState: baseStory };
    expect(projectNarrativeDraft(ordinary).endingResolutions).toEqual([]);
    expect(buildNarrativeReviewRules({ context: ordinary, proposal: candidate, candidateVersion: 1, candidateHash: "ordinary" }).some(rule => rule.key.startsWith("ending:"))).toBe(false);
  });
  it("grounds a take-item continuation in the post-pickup rule result for both author and reviewer", async () => {
    const initial = makeWorldState();
    const itemId = asItemId("item_letter");
    const questId = asQuestId("quest_letter");
    const worldState = createWorldStateFixtureWith({ generation: initial.generation, base: projectEntityStore(initial.entityStore) }, {
      locations: initial.locations.map(location => ({ ...location, availableItemIds: [itemId] })),
      items: [{ id: itemId, name: "传帖", description: "桌上的传帖。", kind: "quest", tags: [] }],
      quests: [{ id: questId, name: "取帖", description: "取得传帖", kind: "main", stage: 1, status: "active", tags: [],
        objectives: [{ kind: "obtain_item", itemId }], onSuccess: { kind: "advance_story" }, onFailure: { kind: "closed" } }],
    });
    const job = { ...makeJob(), objectiveTransition: { before: null, completed: [],
      after: { questId, objectiveIndex: 0, label: "取得传帖" }, mode: "progressed" as const } };
    const context = { kind: "decision" as const, worldState, storyState: makeStoryState(), job };
    const slot = projectNarrativeDraft(context).slots.find(entry => entry.slotKey === "take_item:item_letter");
    expect(slot?.resolution).toMatchObject({ displayTiming: "after_successful_trigger", trigger: { kind: "take_item", itemId } });
    expect(worldState.inventory).not.toContain(itemId);
    for (const consumer of ["author", "reviewer"] as const) {
      const prompt = buildDecisionNarrativeContextBlocks({ ...context, consumer }).map(block => block.content).join("\n");
      expect(prompt).toContain("物品 item_letter 已由规则交给玩家持有");
      expect(prompt).toContain("生成时的背包快照不能覆盖展示时该触发器已结算的结果");
    }
    const proposal: NarrativeBundleProposal = { ...(candidate as NarrativeBundleProposal), continuationScenes: [{ stepKey: "take_item:item_letter", scene: {
      segments: [{ beatId: "atmosphere", text: "传帖仍在桌上，别急着伸手。" }], npcLine: null, objectiveLink: null, choices: [],
    } }] };
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ verdict: "revise", defects: [{
      scope: "scene", code: "BROKEN_CAUSALITY", path: "continuationScenes[0].scene.segments[0].text",
      reason: "拾取后的场景仍把物品放在原处。", evidence: { basisKey: "step:take_item:item_letter", impact: "item_state", detail: "此场景展示时玩家已持有传帖。" },
    }] }) });
    const result = await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context, proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(proposal),
    });
    expect(result).toMatchObject({ ok: false, defects: [{ evidence: { impact: "item_state" } }] });
  });
  it.each(["stable", "needs_next_act"] as const)("reviews the compiled %s DTO without the author's draft transport contract", async (evolution) => {
    const storyState = makeStoryState();
    const context = {
      kind: "decision", worldState: makeWorldState(),
      storyState: evolution === "stable" ? storyState : { ...storyState, evolution: { ...storyState.evolution, status: evolution } },
      job: makeJob(),
      contentRepair: { attempt: 2, reason: "invalid_schema", detail: "author-only-repair" },
      candidateRevision: { candidateVersion: 1, candidateHash: "prior", proposal: candidate, findings: [] },
      npcOutward: [{ npcId: asNpcId("npc_1"), response: "offer_condition", evidenceEventIds: [], discloseFactIds: [], interactionProposals: [] }],
    } as const;
    const sharedFactIds = ["bundle:player", "bundle:visible-facts", "bundle:focus-npc", "bundle:player-action", "bundle:story-contract", "bundle:resolution"];
    const facts = (consumer: "author" | "reviewer") => buildDecisionNarrativeContextBlocks({ ...context, consumer })
      .filter(block => sharedFactIds.includes(block.id));
    expect(facts("reviewer")).toEqual(facts("author"));
    const author = compileDecisionNarrativeContext(context).prompt;
    expect(author).toContain("不得输出 currentScene、continuationScenes 或 terminal");
    const complete = vi.fn().mockResolvedValue({ ok: true, content: '{"verdict":"pass"}' });
    const candidateHash = hashNarrativeCandidate(candidate);
    await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context, proposal: candidate, candidateVersion: 1, candidateHash,
    });
    const body = JSON.parse((complete.mock.calls[0]![1] as readonly AiMessage[])[1]!.content);
    expect(body.proposal).toEqual(candidate);
    expect(body.candidateHash).toBe(candidateHash);
    expect(body.context.prompt).toContain("服务端已编译的 NarrativeBundleProposal");
    expect(body.context.prompt).not.toContain("sceneDrafts");
    expect(body.context.prompt).not.toContain("只读，不输出");
    expect(body.context.prompt).not.toContain("一次响应生成完整叙事包");
    expect(body.context.prompt).not.toContain("抵达场景骨架");
    expect(body.context.prompt).not.toContain("author-only-repair");
    expect(body.context.prompt).not.toContain("同一候选的联合修订");
    expect(body.context.prompt).toContain("npcOutwardProposals");
    expect(body.context.prompt).toContain("未获选择的条件不算成立");
    if (evolution === "needs_next_act") {
      expect(body.context.prompt).toContain("move:loc_dyn_");
      expect(body.context.prompt).toContain("到达 NPC");
    }
    expect(body.context.prompt).toContain("选项 label 必须忠于其服务端 Action");
    expect(body.context.prompt).toContain("未经状态批准的身份");
    expect(body.context.prompt).toContain("其他 NPC 的私密事实正文未提供");
    expect(body.context.prompt).toContain("仅写 talk 文案不产生这些规则后果");
    expect(body.context.prompt).toContain("许诺本身不会引荐");
  });
  it("projects actual compiler IDs and secret-directory visibility for an opening candidate", async () => {
    // Provider output only, copied from p1-07/S2-public version 1. The observed
    // reviewer incorrectly rejected private facts merely for being in this
    // directory. Replay its real structure through the production adapter.
    const generated = await createNarrativeBundleSource({ aiClient: client(vi.fn().mockResolvedValue({
      ok: true, content: JSON.stringify(observedOpening),
    })) }).generate(reviewContext);
    if (!generated.ok || generated.kind !== "opening") throw new Error("opening fixture failed");
    const compiled = compileOpeningGenerationCandidate({
      candidate: generated.proposal.opening, gameLength: "short",
      generation: { generationId: asGenerationId("review-map"), seed: "review-map", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
      initialNarrative: createFixtureNarrativeRuntimeState(),
    });
    const complete = vi.fn().mockResolvedValue({ ok: true, content: '{"verdict":"pass"}' });
    await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context: reviewContext, proposal: generated.proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(generated.proposal),
    });
    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const bindings = JSON.parse(messages[1]!.content).context.factBindings as { key: string; factId: string; disclosure: string }[];
    expect(bindings.map((entry) => entry.factId)).toEqual(compiled.worldState.worldFacts.map((fact) => String(fact.factId)));
    const privateKeys = generated.proposal.opening.opening.npc.privateFactKeys;
    expect(privateKeys.length).toBeGreaterThan(0);
    expect(bindings.filter((entry) => entry.disclosure === "secret").map((entry) => entry.key)).toEqual(privateKeys);
    for (const binding of bindings.filter((entry) => entry.disclosure === "secret")) {
      expect(compiled.worldState.worldFacts.find((fact) => fact.factId === binding.factId)?.discovered).toBe(false);
    }
  });
  it("gives the reviewer the same opening compiler contract that constrained the author", async () => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: '{"verdict":"pass"}' });
    await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context: reviewContext, proposal: candidate, candidateVersion: 1, candidateHash: hashNarrativeCandidate(candidate),
    });
    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    const body = JSON.parse(messages[1]!.content);
    // Regression: p1-07 reviewer demanded removing private keys from their
    // required directory, replacing fact_N IDs, and four choices in a pair.
    expect(body.context.authorPrompt).toContain(body.context.contract);
    expect(body.context.contract).toContain("privateFactKeys 必须引用该目录");
    expect(body.context.contract).toContain("fact_0、fact_1");
    expect(body.context.contract).toContain("不能要求首屏两个选项同时枚举四条路线");
    expect(body.context.contract).toContain("允许在事实目录/history 中建立");
  });
  it("keeps the observed arrival's cosmetic hat as a quality observation without inventing inventory", async () => {
    const qualityObservations = [{ path: "continuationScenes[0].scene.segments[0].text", reason: "斗笠是无规则效果的服饰细节。" }];
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ verdict: "pass", qualityObservations }) });
    const proposal = observedArrival as NarrativeBundleProposal;
    expect(proposal.continuationScenes[0]?.scene.segments?.[0]?.text).toContain("把斗笠上的水抖在门槛外");
    const input = { context: { kind: "decision", worldState: makeWorldState(), storyState: makeStoryState(), job: makeJob() } as const,
      proposal, candidateVersion: 3, candidateHash: hashNarrativeCandidate(proposal) };
    const review = createLiveNarrativeCandidateReview({ aiClient: client(complete) });
    expect(await review.reviewNarrativeCandidate(input)).toMatchObject({ ok: true, qualityObservations });
    complete.mockResolvedValue({ ok: true, content: JSON.stringify({ verdict: "revise", defects: [{
      scope: "scene", code: "UNSUPPORTED_FACT", path: qualityObservations[0]!.path,
      reason: "斗笠未在背包中", evidence: { basisKey: "item:hat", impact: "item_state", detail: "新增持有物" },
    }], qualityObservations }) });
    expect(await review.reviewNarrativeCandidate(input)).toMatchObject({ ok: false, failure: "UNCERTAIN" });
  });

  it.each(["missing_evidence", "wrong_impact", "missing_path", "pass_with_defects"])("does not launder %s into a pass or a grounded defect", async fault => {
    const defect = { scope: "scene", code: "UNSUPPORTED_FACT", path: fault === "missing_path" ? "currentScene.missing" : "currentScene.segments[0].text",
      reason: "规则冲突", ...(fault === "missing_evidence" ? {} : { evidence: {
        basisKey: "opening:contract", impact: fault === "wrong_impact" ? "item_state" : "fact_claim", detail: "具体后果",
      } }) };
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ verdict: fault === "pass_with_defects" ? "pass" : "revise", defects: [defect] }) });
    expect(await createLiveNarrativeCandidateReview({ aiClient: client(complete) }).reviewNarrativeCandidate({
      context: reviewContext, proposal: candidate, candidateVersion: 1, candidateHash: hashNarrativeCandidate(candidate),
    })).toMatchObject({ ok: false, failure: "UNCERTAIN" });
  });

  it("projects an authorized secret proposal ID separately from disclosable text", async () => {
    const generated = await createNarrativeBundleSource({ aiClient: client(vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify(observedOpening) })) }).generate(reviewContext);
    if (!generated.ok || generated.kind !== "opening") throw new Error("opening fixture failed");
    const compiled = compileOpeningGenerationCandidate({ candidate: generated.proposal.opening, gameLength: "short",
      generation: { generationId: asGenerationId("fact-permission"), seed: "fact-permission", templateVersion: "v1", inputDigest: "", gameType: "wuxia" },
      initialNarrative: createFixtureNarrativeRuntimeState() });
    const npcId = asNpcId("npc_0");
    const entityStore = createEntityStore(compiled.worldState.entityStore.records.map(record => {
      if (record.core.kind === "fact" && "fact" in record && record.core.id === "fact_4") return { ...record, fact: { ...record.fact, discovered: false } };
      if ("identity" in record && "relationships" in record) return { ...record, knowledge: { entries: record.knowledge.entries.map(entry => entry.factId === "fact_4" ? { ...entry, disclosure: "secret" as const } : entry) } };
      if ("knowledge" in record && "knownFactIds" in record.knowledge) return { ...record, knowledge: { ...record.knowledge, knownFactIds: record.knowledge.knownFactIds.filter(id => id !== "fact_4") } };
      return record;
    }));
    const reviewWorldState = { ...compiled.worldState, entityStore };
    const context = { kind: "decision", worldState: reviewWorldState, reviewWorldState, storyState: compiled.storyState,
      reviewScenes: [{ expressions: [{ kind: "npc_line", npcId, audienceIds: [PLAYER_ENTITY_ID], text: "渡口确已停航。", emotion: "neutral", answeredBeatIds: [], usedFactIds: [asFactId("fact_0")], usedEventIds: [] }], npcLine: null, npcDialogues: [] }] as never,
      job: { ...makeJob(), focusNpcId: asNpcId("npc_missing") }, npcOutward: [{ npcId, response: "offer_condition", discloseFactIds: [], evidenceEventIds: [],
        interactionProposals: [{ proposalKey: "protect_fact4", npcId, operation: "promise_confidentiality", condition: [], factIds: [], goalIds: [], promiseId: null,
          audienceIds: [PLAYER_ENTITY_ID], evidenceEventIds: [], confidentiality: { protectedFactIds: [asFactId("fact_4")],
            allowedAudienceIds: [PLAYER_ENTITY_ID, npcId], fulfillment: { kind: "story_delivery" } } }],
      }] } as const;
    const rules = buildNarrativeReviewRules({ context, proposal: candidate, candidateVersion: 1, candidateHash: hashNarrativeCandidate(candidate) });
    const fact = rules.find(entry => entry.key === "fact:fact_4");
    expect(fact).toMatchObject({ value: { exists: true, playerVisible: false, focusSpeakerMayDisclose: false, authorizedProposalKeys: ["protect_fact4"] } });
    expect(fact?.value).not.toHaveProperty("discloseableText");
    const secret = compiled.worldState.worldFacts.find(fact => fact.factId === "fact_4");
    expect(secret).toBeDefined();
    expect(JSON.stringify(rules)).not.toContain(secret!.text);
    expect(rules.find(entry => entry.key === `permission:scene:0:line:0:${npcId}`)).toMatchObject({
      value: { speakerNpcId: npcId, allowedByAudience: [{ targetId: PLAYER_ENTITY_ID, allowedFactIds: expect.arrayContaining(["fact_0"]) }] },
    });
  });

  it.each(["proposal.", "$.proposal.", "", "$."])("canonicalizes the explicit %s review root and retains both revise defects", async prefix => {
    const proposal: NarrativeBundleProposal = { ...(candidate as NarrativeBundleProposal), currentScene: {
      ...(candidate as NarrativeBundleProposal).currentScene,
      npcLine: { npcId: "npc_0", text: "两项有争议的断言。", emotion: "neutral", answeredBeatIds: [], usedFactIds: [], usedEventIds: [] },
    } };
    const defects = ["UNSUPPORTED_FACT", "DISCLOSURE"].map((code, index) => ({
      scope: "scene", code, path: `${prefix}currentScene.npcLine.text`, reason: `第${index + 1}项须修订`,
      evidence: { basisKey: "opening:contract", impact: index === 0 ? "fact_claim" : "disclosure", detail: "具体事实后果与正式契约冲突。" },
    }));
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ verdict: "revise", defects }) });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });
    const result = await reviewer.reviewNarrativeCandidate({ context: reviewContext, proposal, candidateVersion: 1, candidateHash: hashNarrativeCandidate(proposal) });
    expect(result).toMatchObject({ ok: false, defects: defects.map(defect => ({ ...defect, path: "currentScene.npcLine.text" })) });
    expect(result).not.toHaveProperty("failure");
  });

  it.each(["proposal.proposal.currentScene.segments[0].text", "context.proposal.currentScene.segments[0].text",
    "$.proposal.currentScene.unknown", "proposal.currentScene.segments[99].text", "proposal.currentScene[0]",
    "proposal.currentScene.segments.length", "$proposal.currentScene.segments[0].text"])("retains UNCERTAIN for invalid review root/path %s", async path => {
    const complete = vi.fn().mockResolvedValue({ ok: true, content: JSON.stringify({ verdict: "revise", defects: [{
      scope: "scene", code: "UNSUPPORTED_FACT", path, reason: "需修订", evidence: { basisKey: "opening:contract", impact: "fact_claim", detail: "具体断言冲突" },
    }] }) });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });
    expect(await reviewer.reviewNarrativeCandidate({ context: reviewContext, proposal: candidate, candidateVersion: 1, candidateHash: hashNarrativeCandidate(candidate) })).toMatchObject({ ok: false, failure: "UNCERTAIN" });
  });

  it("uses the existing narrative_bundle role and returns server-bound defects", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        defects: [{
          scope: "proposal",
          code: "UNSUPPORTED_FACT",
          path: "currentScene.segments[0].text",
          reason: "引用未建立的验真器。",
          evidence: { basisKey: "opening:contract", impact: "fact_claim", detail: "核验依据与已建立的事实冲突" },
        }],
      }),
    });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });
    const candidateHash = hashNarrativeCandidate(candidate);

    const result = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 2,
      candidateHash,
    });

    expect(result).toMatchObject({
      ok: false,
      candidateVersion: 2,
      candidateHash,
      defects: [{ code: "UNSUPPORTED_FACT" }],
    });
    expect(complete).toHaveBeenCalledWith(
      "narrative_bundle",
      expect.any(Array),
      expect.objectContaining({
        purpose: "narrative_candidate_review",
        trigger: "narrative_candidate_review",
        revision: 2,
      }),
    );
    const messages = complete.mock.calls[0]![1] as readonly AiMessage[];
    expect(JSON.stringify(messages)).not.toContain("privateContext");
    expect(messages[0]?.content).toContain("scope 只能是 scene、proposal、npc_behavior");
    expect(messages[0]?.content).toContain("code 只能是 MISSED_INPUT、UNSUPPORTED_FACT、DISCLOSURE、ACTION_MISMATCH、BROKEN_CAUSALITY");
  });

  it("does not turn provider failure or an empty verdict into pass", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: false,
      code: "network_error",
      retryable: false,
      latencyMs: 1,
    });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });
    const result = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 1,
      candidateHash: hashNarrativeCandidate(candidate),
    });
    expect(result).toMatchObject({ ok: false, failure: "PROVIDER_FAILURE" });

    complete.mockResolvedValue({ ok: true, content: JSON.stringify({ defects: [] }) });
    const uncertain = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 1,
      candidateHash: hashNarrativeCandidate(candidate),
    });
    expect(uncertain).toMatchObject({ ok: false, failure: "UNCERTAIN" });
  });

  it("normalizes known reviewer aliases into the stable defect vocabulary", async () => {
    const complete = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({
        verdict: "revise",
        defects: [{
          scope: "world",
          code: "private_fact_publicized",
          path: "currentScene.segments[0].text",
          reason: "受保护事实被向玩家直接披露。",
          evidence: { basisKey: "opening:contract", impact: "disclosure", detail: "玩家尚未知情，当前旁白却直接揭露秘密" },
        }],
      }),
    });
    const reviewer = createLiveNarrativeCandidateReview({ aiClient: client(complete) });

    const result = await reviewer.reviewNarrativeCandidate({
      context: reviewContext,
      proposal: candidate,
      candidateVersion: 1,
      candidateHash: hashNarrativeCandidate(candidate),
    });

    expect(result).toMatchObject({ ok: false, defects: [{ code: "DISCLOSURE" }] });
  });
});
