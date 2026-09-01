/** @vitest-environment node */
import { afterAll, describe, expect, it } from "vitest";
import {
  authoritativeNpcs,
  commitNpcMutations,
  createSqliteNpcJourney,
  npcComponentsSnapshot,
  patchNpcForTest,
  installPreparedContinuationForTest,
} from "./npcContinuityJourney.testutil";
import { advanceScene, journeyNow, loadGameView, pendingSceneProposal, playIssuedChoice, playTurn } from "./foundationJourney.testutil";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { buildSelectableSceneCandidates } from "@/game/application/sceneChoiceCandidates";
import { compileSceneNarrativeContext } from "@/game/application/server/ai/narrativeContext";
import { asNpcId } from "@/game/domain/worldEntity";
import { PLAYER_ENTITY_ID, RETURN_REQUIRED_ITEM_TAG, asItemId } from "@/game/domain/worldEntity";
import { buildNpcSpeechAuthority, validateNpcSpeechReferences } from "@/game/application/npcSpeechAuthority";
import { projectEntityStore, type NpcEntityRecord } from "@/game/domain/entity";
import { applyEntityMutations, type EntityMutation } from "@/game/gameplay/rpg/entityWorld";
import { resolveByType } from "@/game/gameplay/rpg/ruleEngine/resolveByType";
import { createWorldStateFixtureWith } from "@/game/domain/testing/worldStateFixture.testutil";
import type { ItemEntry, WorldState } from "@/game/domain/worldState";
import type { GameRecord } from "@/game/application/server/persistence/gameRepository";
import { isAllowedRelationshipStageTransition } from "@/game/gameplay/rpg/npcMemory";
import { performBattleRound } from "@/game/application/performBattleRound";
import { asNarrativeJobId } from "@/game/domain/events";
import { createPreparedContinuationState, type PreparedContinuationState } from "@/game/domain/preparedContinuation";

const journeys: Awaited<ReturnType<typeof createSqliteNpcJourney>>[] = [];

afterAll(async () => {
  for (const journey of journeys) await journey.close();
});

async function settle(journey: Awaited<ReturnType<typeof createSqliteNpcJourney>>): Promise<void> {
  const record = await journey.record();
  if (record.storyState.narrative.status === "provider_pending") {
    const saved = await advanceScene(journey.repo, journey.evolutionSource);
    expect(saved).toBe(true);
  }
}

async function chooseFirstAvailable(journey: Awaited<ReturnType<typeof createSqliteNpcJourney>>): Promise<boolean> {
  const view = await loadGameView(journey.repo);
  if (view.battle !== null) {
    const result = await playIssuedChoice(journey.repo, "攻击", journey.evolutionSource);
    expect(result.ok).toBe(true);
    return result.ok;
  }
  if (view.narrative.npcDialogues.some((dialogue) => dialogue.choices.length > 0)) {
    const result = await playIssuedChoice(journey.repo, "回应", journey.evolutionSource);
    expect(result.ok).toBe(true);
    await settle(journey);
    return result.ok;
  }
  const freeInputNpc = view.narrative.npcDialogues.find((dialogue) => dialogue.freeInputEnabled);
  const hasDirectDialogueAction = view.currentLocation.actions.some((choice) => choice.presentation === "dialogue");
  if (freeInputNpc !== undefined && !hasDirectDialogueAction) {
    const result = await playTurn(
      journey.repo,
      { kind: "free_text", text: "我继续核对眼前线索", targetNpcId: asNpcId(freeInputNpc.npcId) },
      new Map(),
      journeyNow,
      journey.evolutionSource,
    );
    if (!result.ok) throw new Error(`NPC 自定义输入被拒绝：${result.code} / ${freeInputNpc.name}`);
    await settle(journey);
    return result.ok;
  }
  if (view.narrative.choices.length > 0) {
    const result = await playIssuedChoice(journey.repo, view.narrative.choices[0]!.label, journey.evolutionSource);
    if (!result.ok) throw new Error(`场景 choice 被拒绝：${result.code} / ${view.narrative.choices[0]!.label}`);
    await settle(journey);
    return result.ok;
  }
  const directAction = view.currentLocation.actions.find((choice) =>
    choice.presentation === "dialogue" || choice.presentation === "battle" || choice.presentation === "item",
  );
  if (directAction !== undefined) {
    const record = await journey.record();
    const result = await playTurn(
      journey.repo,
      { kind: "fixed_choice", choiceToken: directAction.choiceToken },
      buildChoiceMap(record.worldState, record.storyState, record.revision),
      journeyNow,
      journey.evolutionSource,
    );
    if (!result.ok) throw new Error(`地点 action 被拒绝：${result.code} / ${directAction.label}`);
    await settle(journey);
    return result.ok;
  }
  if (view.obtainableItems.length > 0) {
    const result = await playIssuedChoice(journey.repo, "拾取", journey.evolutionSource);
    expect(result.ok).toBe(true);
    await settle(journey);
    return result.ok;
  }
  const unvisited = view.worldMap.locations.find((location) => !location.current && !location.visited && location.travelChoice !== null);
  if (unvisited !== undefined) {
    const result = await playIssuedChoice(journey.repo, unvisited.name, journey.evolutionSource);
    expect(result.ok).toBe(true);
    await settle(journey);
    return result.ok;
  }
  const npc = view.currentLocation.npcs.find((entry) => entry.talkChoice !== null);
  if (npc !== undefined) {
    const result = await playIssuedChoice(journey.repo, npc.name, journey.evolutionSource);
    if (!result.ok) throw new Error(`NPC talkChoice 被拒绝：${result.code} / ${npc.name}; scene=${JSON.stringify(view.narrative)}; actions=${JSON.stringify(view.currentLocation.actions)}`);
    await settle(journey);
    return result.ok;
  }
  throw new Error(`找不到长旅程下一步：act=${view.story.currentAct} status=${view.narrativeGeneration.status}`);
}

function npcById(worldState: WorldState, npcId: string): NpcEntityRecord {
  const npc = authoritativeNpcs(worldState).find((entry) => String(entry.core.id) === npcId);
  if (npc === undefined) throw new Error(`缺少 NPC：${npcId}`);
  return npc;
}

function playerEdge(npc: NpcEntityRecord) {
  const edge = npc.relationships.outgoing.find((candidate) => candidate.targetId === PLAYER_ENTITY_ID);
  if (edge === undefined) throw new Error(`缺少 ${String(npc.core.id)} → player 关系边`);
  return edge;
}

function assertBoundedRelationshipChange(
  before: ReturnType<typeof playerEdge>,
  after: ReturnType<typeof playerEdge>,
): void {
  const keys = ["affinity", "trust", "fear", "hostility"] as const;
  const deltas = keys.map((key) => Math.abs(after.dimensions[key] - before.dimensions[key]));
  expect(Math.max(...deltas)).toBeLessThanOrEqual(12);
  expect(deltas.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(20);
}

function assertOpeningContinuity(
  record: GameRecord,
  opening: { anchors: NpcEntityRecord["identity"]["anchors"]; goals: NpcEntityRecord["dynamicState"]["goals"]; knowledgeSources: NpcEntityRecord["knowledge"]["entries"][number]["source"][] },
): void {
  const npc = npcById(record.worldState, "npc_0");
  expect(npc.identity.anchors).toEqual(opening.anchors);
  expect(npc.dynamicState.goals).toEqual(opening.goals);
  expect(npc.knowledge.entries.map((entry) => entry.source)).toEqual(opening.knowledgeSources);
  expect(npc.dynamicState.goals.every((goal) => goal.goalId.startsWith("npc_0_goal_"))).toBe(true);
  expect(npc.core.lifecycle).toBe("active");
  expect(record.storyState.currentAct).toBeLessThanOrEqual(5);
  expect(playerEdge(npc).dimensions.affinity).toBe(
    record.worldState.npcs.find((entry) => String(entry.id) === "npc_0")?.memory.relationship.affinity,
  );
}

describe("NPC continuity long-form journey", () => {
  it("completes the offline five-act journey across eighteen successful rounds", async () => {
    const journey = await createSqliteNpcJourney();
    journeys.push(journey);
    await settle(journey);

    const openingRecord = await journey.record();
    const openingNpc = npcById(openingRecord.worldState, "npc_0");
    const opening = {
      anchors: openingNpc.identity.anchors,
      goals: openingNpc.dynamicState.goals,
      knowledgeSources: openingNpc.knowledge.entries.map((entry) => entry.source),
    };

    const relationshipBase = playerEdge(openingNpc);
    const supportMutation: EntityMutation = {
      kind: "apply_relationship_signal",
      fromNpcId: openingNpc.core.id,
      targetId: PLAYER_ENTITY_ID,
      signal: "supported",
      source: { kind: "action", actionId: "act_task9_support", turnNumber: 1 },
    };
    const afterSupportRecord = await commitNpcMutations(journey, [supportMutation]);
    const afterSupport = playerEdge(npcById(afterSupportRecord.worldState, "npc_0"));
    assertBoundedRelationshipChange(relationshipBase, afterSupport);
    expect(afterSupport.evidence.at(-1)).toMatchObject({
      actionId: "act_task9_support",
      turnNumber: 1,
      signal: "supported",
    });

    const replayedSupport = applyEntityMutations(afterSupportRecord.worldState, [supportMutation]);
    expect(replayedSupport.ok).toBe(true);
    if (replayedSupport.ok) expect(replayedSupport.worldState).toEqual(afterSupportRecord.worldState);

    const threatMutation: EntityMutation = {
      kind: "apply_relationship_signal",
      fromNpcId: openingNpc.core.id,
      targetId: PLAYER_ENTITY_ID,
      signal: "threatened",
      source: { kind: "action", actionId: "act_task9_threat", turnNumber: 2 },
    };
    const afterThreatRecord = await commitNpcMutations(journey, [threatMutation]);
    const afterThreat = playerEdge(npcById(afterThreatRecord.worldState, "npc_0"));
    assertBoundedRelationshipChange(afterSupport, afterThreat);
    expect(afterSupport.stage === relationshipBase.stage || isAllowedRelationshipStageTransition(relationshipBase.stage, afterSupport.stage)).toBe(true);
    expect(afterThreat.stage === afterSupport.stage || isAllowedRelationshipStageTransition(afterSupport.stage, afterThreat.stage)).toBe(true);
    expect(afterThreat.stage === "acquainted" || afterThreat.stage === "wary").toBe(true);
    expect(afterThreat.trend).toBe("worsening");
    expect(afterThreat.evidence.every((evidence) => evidence.actionId.trim() !== "")).toBe(true);

    const replayableActionId = "act_task9_gift_history";
    const replayableAction: readonly EntityMutation[] = [
      {
        kind: "apply_relationship_signal",
        fromNpcId: openingNpc.core.id,
        targetId: PLAYER_ENTITY_ID,
        signal: "gave_item",
        source: { kind: "action", actionId: replayableActionId, turnNumber: 3 },
      },
      {
        kind: "record_npc_interaction",
        npcId: openingNpc.core.id,
        turnNumber: 3,
        actionId: replayableActionId,
        locationId: afterThreatRecord.worldState.currentLocationId,
        dialogueAct: "ask",
        topicSummary: "交付信物",
        outcome: "positive",
        learnedFactIds: [],
      },
    ];
    const actionApplied = applyEntityMutations(afterThreatRecord.worldState, replayableAction);
    expect(actionApplied.ok).toBe(true);
    if (!actionApplied.ok) throw new Error(`action replay fixture failed: ${actionApplied.code}`);
    const actionNpc = npcById(actionApplied.worldState, "npc_0");
    const actionEdge = playerEdge(actionNpc);
    expect(actionNpc.history.interactions.filter((entry) => entry.actionId === replayableActionId)).toHaveLength(1);
    expect(actionEdge.evidence.filter((entry) => entry.actionId === replayableActionId)).toHaveLength(1);
    expect(actionEdge.commitments.filter((entry) => entry.source.kind === "action" && entry.source.actionId === replayableActionId)).toHaveLength(1);
    const replayedSignal = applyEntityMutations(actionApplied.worldState, [replayableAction[0]!]);
    expect(replayedSignal.ok).toBe(true);
    if (replayedSignal.ok) expect(replayedSignal.worldState).toEqual(actionApplied.worldState);
    const replayedInteraction = applyEntityMutations(actionApplied.worldState, [replayableAction[1]!]);
    expect(replayedInteraction).toEqual({ ok: false, code: "duplicate_npc_interaction", entityId: "npc_0" });

    const previousEdges = new Map<string, ReturnType<typeof playerEdge>>();
    for (const npc of authoritativeNpcs(afterThreatRecord.worldState)) previousEdges.set(String(npc.core.id), playerEdge(npc));

    let dynamicNpcId: string | undefined;
    let directedSeedProved = false;
    let knowledgeAudienceProved = false;
    let privatePromptProved = false;
    let privateFactForPrompt: { readonly id: string; readonly text: string } | undefined;
    let giftSemanticsProved = false;
    let battleStarted = false;
    let withdrew = false;
    let withdrawalRollbackProved = false;
    let companionVictoryProved = false;
    let preparedContinuationConsumed = false;
    let preBattleNpcComponents: readonly unknown[] | undefined;
    let preparedStepsBeforeBattle: readonly string[] = [];
    let preparedStepsAfterBattleStart: readonly string[] = [];
    let companionId: string | undefined;

    let successfulRounds = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      let record = await journey.record();
      if (record.worldState.ending !== null) break;
      if (privateFactForPrompt !== undefined && record.storyState.narrative.status === "provider_pending") {
        const pending = await pendingSceneProposal(journey.repo);
        if (pending !== null && String(pending.context.focusNpcContext?.id) === dynamicNpcId) {
          expect(pending.context.focusNpcContext?.speechAuthority?.allowedFactIds).not.toContain(privateFactForPrompt.id);
          const compilation = compileSceneNarrativeContext(
            pending.context,
            buildSelectableSceneCandidates(pending.context),
          );
          expect(compilation.prompt).not.toContain(privateFactForPrompt.text);
          expect(JSON.stringify(compilation.manifest)).not.toContain(privateFactForPrompt.text);
          privatePromptProved = true;
        }
        await settle(journey);
        continue;
      }
      if (privateFactForPrompt !== undefined && !privatePromptProved) {
        const privacyView = await loadGameView(journey.repo);
        const dynamicTalk = privacyView.currentLocation.npcs.find((entry) =>
          String(entry.npcId) === dynamicNpcId && entry.talkChoice !== null,
        );
        const dynamicDialogue = privacyView.narrative.npcDialogues.find((entry) => String(entry.npcId) === dynamicNpcId);
        const dynamicLabel = dynamicTalk?.name ?? dynamicDialogue?.name;
        const hasDynamicChoice = dynamicTalk?.talkChoice !== null && dynamicTalk !== undefined
          || (dynamicDialogue?.choices.length ?? 0) > 0;
        if (dynamicLabel !== undefined && hasDynamicChoice) {
          const pendingStarted = await playIssuedChoice(journey.repo, dynamicLabel, journey.evolutionSource);
          expect(pendingStarted.ok).toBe(true);
          const pending = await pendingSceneProposal(journey.repo);
          expect(pending).not.toBeNull();
          if (pending !== null) {
            const compilation = compileSceneNarrativeContext(
              pending.context,
              buildSelectableSceneCandidates(pending.context),
            );
            expect(String(pending.context.focusNpcContext?.id)).toBe(dynamicNpcId);
            expect(pending.context.focusNpcContext?.speechAuthority?.allowedFactIds).not.toContain(privateFactForPrompt.id);
            expect(compilation.prompt).not.toContain(privateFactForPrompt.text);
            expect(JSON.stringify(compilation.manifest)).not.toContain(privateFactForPrompt.text);
          }
          await settle(journey);
          privatePromptProved = true;
          successfulRounds += 1;
          continue;
        }
      }
      if (record.storyState.narrative.status === "provider_pending") {
        await settle(journey);
        continue;
      }

      const view = await loadGameView(journey.repo);
      const battleEntry = view.currentLocation.actions.find((choice) => choice.presentation === "battle");
      if (battleEntry !== undefined && !battleStarted) {
        const currentDynamic = authoritativeNpcs(record.worldState).find((npc) => String(npc.core.id) !== "npc_0");
        if (currentDynamic !== undefined) {
          dynamicNpcId = String(currentDynamic.core.id);
          if (!currentDynamic.dynamicState.isCompanion) {
            await patchNpcForTest(journey, currentDynamic.core.id, {
              dynamicState: { ...currentDynamic.dynamicState, isCompanion: true },
            });
            companionId = String(currentDynamic.core.id);
            record = await journey.record();
          }
        }
        const enemy = record.worldState.enemies.find((entry) =>
          entry.locationId === record.worldState.currentLocationId
          && !record.worldState.defeatedEnemyIds.includes(entry.id),
        );
        if (enemy === undefined) throw new Error("战斗入口缺少当前敌人");
        const preparedForBattle: PreparedContinuationState = {
          originJobId: asNarrativeJobId("job_task9_prepared_battle"),
          steps: [
            {
              stepId: "task9-battle-start",
              objectiveKey: "task9:battle",
              consumptionGroupKey: "task9:battle-start",
              trigger: { kind: "battle_started", enemyId: enemy.id },
              scene: {
                segments: [{ beatId: "atmosphere", text: "战斗前的风声压低了。" }],
                event: { kind: "battle", enemyId: enemy.id },
                npcLine: null,
                objectiveLink: null,
                choiceSeeds: [],
                source: "fixture",
              },
              nextStepIds: ["task9-battle-victory"],
            },
            {
              stepId: "task9-battle-victory",
              objectiveKey: "task9:battle",
              consumptionGroupKey: "task9:battle-victory",
              trigger: { kind: "battle_resolved", enemyId: enemy.id, outcome: "victory" },
              scene: {
                segments: [{ beatId: "atmosphere", text: "胜利后的余声渐渐散去。" }],
                event: { kind: "battle", enemyId: enemy.id },
                npcLine: null,
                objectiveLink: null,
                choiceSeeds: [],
                source: "fixture",
              },
              nextStepIds: [],
            },
          ],
          activeStepIds: ["task9-battle-start"],
        };
        expect(createPreparedContinuationState(preparedForBattle).ok).toBe(true);
        await installPreparedContinuationForTest(journey, preparedForBattle);
        record = await journey.record();
        preBattleNpcComponents = npcComponentsSnapshot(record.worldState);
        preparedStepsBeforeBattle = record.storyState.narrative.status === "ready"
          ? record.storyState.narrative.preparedContinuation?.steps.map((step) => step.stepId) ?? []
          : [];
        const started = await playIssuedChoice(journey.repo, "挑战", journey.evolutionSource);
        expect(started.ok).toBe(true);
        const afterBattleStart = await journey.record();
        expect(afterBattleStart.worldState.battle.status).toBe("active");
        preparedStepsAfterBattleStart = afterBattleStart.storyState.narrative.status === "ready"
          ? afterBattleStart.storyState.narrative.preparedContinuation?.steps.map((step) => step.stepId) ?? []
          : [];
        expect(preparedStepsAfterBattleStart).toContain("task9-battle-victory");
        expect(preparedStepsAfterBattleStart.length).toBeLessThan(preparedStepsBeforeBattle.length);
        successfulRounds += 1;
        battleStarted = true;
        continue;
      }

      if (view.battle !== null && !withdrew) {
        const withdrawalRecord = await journey.record();
        const withdrawal = await performBattleRound({
          gameId: journey.gameId,
          actionId: "act_task9_withdrawal",
          interactionKind: "fixed_choice",
          action: { type: "battle_action", action: "flee" },
          expectedRevision: withdrawalRecord.revision,
        }, { repository: journey.repo, now: journeyNow });
        expect(withdrawal).toMatchObject({ ok: true, outcome: "withdraw" });
        successfulRounds += 1;
        const afterWithdrawal = await journey.record();
        expect(afterWithdrawal.worldState.battle.status).toBe("idle");
        expect(npcComponentsSnapshot(afterWithdrawal.worldState)).toEqual(preBattleNpcComponents);
        expect(afterWithdrawal.storyState.narrative.status).toBe("ready");
        if (afterWithdrawal.storyState.narrative.status === "ready") {
          expect(afterWithdrawal.storyState.narrative.preparedContinuation?.steps.map((step) => step.stepId) ?? [])
            .toEqual(preparedStepsBeforeBattle);
        }
        withdrawalRollbackProved = true;
        withdrew = true;
        continue;
      }

      if (await chooseFirstAvailable(journey)) successfulRounds += 1;

      record = await journey.record();
      const currentNpcs = authoritativeNpcs(record.worldState);
      if (dynamicNpcId === undefined) {
        const createdDynamic = currentNpcs.find((npc) => String(npc.core.id) !== "npc_0");
        if (createdDynamic !== undefined) dynamicNpcId = String(createdDynamic.core.id);
      }

      if (dynamicNpcId !== undefined && !directedSeedProved) {
        const seeded = npcById(record.worldState, dynamicNpcId);
        const directedToOpening = seeded.relationships.outgoing.filter((edge) => String(edge.targetId) === "npc_0");
        expect(directedToOpening).toHaveLength(1);
        expect(directedToOpening[0]?.origin).toEqual({ kind: "initial_world", createdAtTurn: expect.any(Number), reasonKey: expect.any(String) });
        expect(npcById(record.worldState, "npc_0").relationships.outgoing.some((edge) => String(edge.targetId) === dynamicNpcId)).toBe(false);
        directedSeedProved = true;
      }

      if (dynamicNpcId !== undefined && !giftSemanticsProved) {
        const dynamic = npcById(record.worldState, dynamicNpcId);
        const base = projectEntityStore(record.worldState.entityStore);
        const returnGift: ItemEntry = {
          id: asItemId("task9_return_gift"),
          name: "归还信物",
          description: "需要物归原主的旧信物。",
          kind: "key",
          category: "quest",
          tags: [RETURN_REQUIRED_ITEM_TAG],
        };
        const ordinaryGift: ItemEntry = {
          id: asItemId("task9_ordinary_gift"),
          name: "普通干粮",
          description: "一份普通的干粮。",
          kind: "food",
          category: "consumable",
          tags: [],
        };
        const giftWorld = createWorldStateFixtureWith({ generation: record.worldState.generation, base }, {
          items: [...base.items, returnGift, ordinaryGift],
          inventory: [...base.inventory, returnGift.id, ordinaryGift.id],
        });
        const giftDeps = {
          now: journeyNow,
          actionId: "act_task9_return_gift",
          turnNumber: record.storyState.turnNumber + 1,
        };
        const returned = resolveByType(giftWorld, { type: "give_item", itemId: returnGift.id, npcId: dynamic.core.id }, giftDeps);
        expect(returned.ok).toBe(true);
        if (returned.ok) {
          const returnedNpc = npcById(returned.nextWorldState, dynamicNpcId);
          const returnedEdge = playerEdge(returnedNpc);
          expect(returned.events).toContainEqual(expect.objectContaining({ type: "item_given", itemId: returnGift.id }));
          expect(returnedEdge.evidence.at(-1)).toMatchObject({ signal: "gave_item", actionId: giftDeps.actionId });
          expect(returnedEdge.commitments).toEqual([expect.objectContaining({
            kind: "debt",
            direction: "source_owes_target",
            status: "open",
          })]);
        }
        const ordinary = resolveByType(giftWorld, { type: "give_item", itemId: ordinaryGift.id, npcId: dynamic.core.id }, {
          ...giftDeps,
          actionId: "act_task9_ordinary_gift",
        });
        expect(ordinary.ok).toBe(true);
        if (ordinary.ok) {
          const ordinaryNpc = npcById(ordinary.nextWorldState, dynamicNpcId);
          const ordinaryEdge = playerEdge(ordinaryNpc);
          expect(ordinaryEdge.evidence.at(-1)).toMatchObject({ signal: "offered_help", actionId: "act_task9_ordinary_gift" });
          expect(ordinaryEdge.commitments).toEqual([]);
        }
        giftSemanticsProved = true;
      }

      for (const npc of currentNpcs) {
        const previous = previousEdges.get(String(npc.core.id));
        const currentEdge = playerEdge(npc);
        if (previous !== undefined) {
          assertBoundedRelationshipChange(previous, currentEdge);
          expect(currentEdge.stage === previous.stage || isAllowedRelationshipStageTransition(previous.stage, currentEdge.stage)).toBe(true);
        }
        expect(new Set(currentEdge.evidence.map((evidence) => evidence.evidenceId)).size).toBe(currentEdge.evidence.length);
        for (const evidence of currentEdge.evidence) {
          expect(evidence.actionId.trim()).not.toBe("");
          expect(evidence.turnNumber).toBeGreaterThanOrEqual(0);
        }
        previousEdges.set(String(npc.core.id), currentEdge);
      }

      if (dynamicNpcId !== undefined && !knowledgeAudienceProved) {
        const dynamic = npcById(record.worldState, dynamicNpcId);
        const privateFact = record.worldState.worldFacts[0];
        const publicFact = record.worldState.worldFacts.find((fact) => String(fact.factId) !== String(privateFact?.factId));
        if (privateFact !== undefined && publicFact !== undefined) {
          const privateEntry = npcById(record.worldState, "npc_0").knowledge.entries.find((entry) => entry.factId === privateFact.factId);
          const privateMutation: EntityMutation = privateEntry === undefined
            ? {
                kind: "record_npc_knowledge",
                npcId: asNpcId("npc_0"),
                factId: privateFact.factId,
                certainty: "known",
                disclosure: "secret",
                source: { kind: "action", mode: "player_told", actionId: "act_task9_private_fact", turnNumber: record.storyState.turnNumber + 1 },
              }
            : {
                kind: "set_npc_knowledge_disclosure",
                npcId: asNpcId("npc_0"),
                factId: privateFact.factId,
                disclosure: "secret",
                actionId: "act_task9_private_fact",
                turnNumber: record.storyState.turnNumber + 1,
              };
          await commitNpcMutations(journey, [privateMutation]);
          record = await journey.record();
          const publicMutation: EntityMutation = {
            kind: "record_npc_knowledge",
            npcId: dynamic.core.id,
            factId: publicFact.factId,
            certainty: "known",
            disclosure: "public",
            source: { kind: "action", mode: "npc_revealed", actionId: "act_task9_public_fact", turnNumber: record.storyState.turnNumber + 1, sourceNpcId: asNpcId("npc_0") },
          };
          await commitNpcMutations(journey, [publicMutation]);
          const afterKnowledge = await journey.record();
          const openingAuthority = buildNpcSpeechAuthority({
            store: afterKnowledge.worldState.entityStore,
            speakerNpcId: asNpcId("npc_0"),
            sceneVisibleFactIds: [privateFact.factId, publicFact.factId],
            targetContext: { targetId: PLAYER_ENTITY_ID },
          });
          const dynamicAuthority = buildNpcSpeechAuthority({
            store: afterKnowledge.worldState.entityStore,
            speakerNpcId: dynamic.core.id,
            sceneVisibleFactIds: [privateFact.factId, publicFact.factId],
            targetContext: { targetId: PLAYER_ENTITY_ID },
          });
          expect(openingAuthority.allowedFactIds).not.toContain(privateFact.factId);
          expect(JSON.stringify(dynamicAuthority)).not.toContain(privateFact.text);
          expect(openingAuthority.allowedFactCards.some((card) => card.factId === privateFact.factId)).toBe(false);
          expect(dynamicAuthority.allowedFactCards.some((card) => card.factId === privateFact.factId)).toBe(false);
          expect(validateNpcSpeechReferences({
            authority: dynamicAuthority,
            usedFactIds: [String(privateFact.factId)],
            usedInteractionActionIds: [],
          })).toEqual({ ok: false, code: "invalid_fact_reference" });
          expect(dynamicAuthority.allowedFactIds).toContain(publicFact.factId);
          expect(dynamicAuthority.allowedFactCards.some((card) => card.factId === publicFact.factId)).toBe(true);

          privateFactForPrompt = { id: String(privateFact.factId), text: privateFact.text };

          const repeated = applyEntityMutations(afterKnowledge.worldState, [publicMutation]);
          expect(repeated.ok).toBe(true);
          if (repeated.ok) {
            const repeatedDynamic = npcById(repeated.worldState, dynamicNpcId);
            expect(repeatedDynamic.knowledge.entries.filter((entry) => entry.factId === publicFact.factId)).toHaveLength(1);
          }
          knowledgeAudienceProved = true;
        }
      }

      if (view.battle !== null && withdrew) {
        const afterBattle = await journey.record();
        if (afterBattle.worldState.battle.status === "idle" && companionId !== undefined) {
          const companion = npcById(afterBattle.worldState, companionId);
          const fought = playerEdge(companion).evidence.filter((evidence) => evidence.signal === "fought_together");
          if (fought.length > 0) {
            expect(fought).toHaveLength(1);
            expect(preparedStepsAfterBattleStart).toContain("task9-battle-victory");
            expect(preparedStepsBeforeBattle).toContain("task9-battle-start");
            const preparedAfterVictory = afterBattle.storyState.narrative.status === "ready"
              ? afterBattle.storyState.narrative.preparedContinuation?.steps.map((step) => step.stepId) ?? []
              : [];
            expect(preparedAfterVictory).toEqual([]);
            const victoryReplay: EntityMutation = {
              kind: "apply_relationship_signal",
              fromNpcId: companion.core.id,
              targetId: PLAYER_ENTITY_ID,
              signal: "fought_together",
              source: { kind: "action", actionId: fought[0]!.actionId, turnNumber: fought[0]!.turnNumber },
            };
            const replay = applyEntityMutations(afterBattle.worldState, [victoryReplay]);
            expect(replay.ok).toBe(true);
            if (replay.ok) expect(replay.worldState).toEqual(afterBattle.worldState);
            preparedContinuationConsumed = true;
            companionVictoryProved = true;
            battleStarted = false;
            companionId = undefined;
          }
        }
      }

      if (successfulRounds > 0 && successfulRounds % 6 === 0 && journey.reloadCount() < successfulRounds / 6) {
        await journey.reload();
        assertOpeningContinuity(await journey.record(), opening);
      }
    }

    const completed = await journey.record();
    expect(successfulRounds).toBeGreaterThanOrEqual(18);
    expect(journey.reloadCount()).toBeGreaterThanOrEqual(3);
    expect(dynamicNpcId).toBeDefined();
    expect(directedSeedProved).toBe(true);
    expect(knowledgeAudienceProved).toBe(true);
    expect(privatePromptProved).toBe(true);
    expect(withdrawalRollbackProved).toBe(true);
    expect(companionVictoryProved).toBe(true);
    expect(preparedContinuationConsumed).toBe(true);
    expect(preparedStepsAfterBattleStart).toContain("task9-battle-victory");
    expect(preparedStepsBeforeBattle).toContain("task9-battle-start");
    expect(giftSemanticsProved).toBe(true);
    expect(completed.storyState.currentAct).toBe(5);
    expect(completed.storyState.targetActs).toBe(5);
    expect(completed.worldState.endings).toHaveLength(2);
    expect(completed.worldState.ending).not.toBeNull();
    assertOpeningContinuity(completed, opening);

    const seededNpc = npcById(completed.worldState, dynamicNpcId!);
    expect(playerEdge(seededNpc).targetId).toBe(PLAYER_ENTITY_ID);
    expect(seededNpc.relationships.outgoing.some((edge) => String(edge.targetId) === "npc_0")).toBe(true);
    expect(npcById(completed.worldState, "npc_0").relationships.outgoing.some((edge) => String(edge.targetId) === dynamicNpcId)).toBe(false);
    expect(seededNpc.relationships.outgoing.find((edge) => String(edge.targetId) === "npc_0")?.origin.kind).toBe("initial_world");
  });
});
