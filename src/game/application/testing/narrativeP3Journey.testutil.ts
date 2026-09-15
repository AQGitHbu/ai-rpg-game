import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Action } from "@/game/domain/action";
import type { EventId } from "@/game/domain/events";
import type { FactId } from "@/game/domain/worldEntity";
import { asFactId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { NarrativeBundleProposal, NarrativeBundleSource, NarrativeBundleSourceContext, NarrativeBundleSourceResult } from "@/game/application/narrativeBundleSource";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { NpcEntityRecord } from "@/game/domain/entity";
import { buildChoiceMap } from "@/game/application/buildChoiceMap";
import { createGame } from "@/game/application/createGame";
import { generatePendingNarrativeBundle } from "@/game/application/generatePendingNarrativeBundle";
import { createAiSourceFailure } from "@/game/application/aiGenerationRetry";
import { performTurn } from "@/game/application/performTurn";
import { projectGameSessionView } from "@/game/application/gameSessionView";
import { asGameId, type GameRecord, type GameRepository } from "@/game/application/server/persistence/gameRepository";
import { createSqliteClient } from "@/game/application/server/persistence/sqliteClient";
import { createSqliteGameRepository } from "@/game/application/server/persistence/sqliteGameRepository";
import { createSqliteNarrativeMemorySummaryRepository } from "@/game/application/server/persistence/sqliteNarrativeMemorySummaryRepository";
import { createNarrativeMemoryPackagePreparer } from "@/game/application/prepareNarrativeMemoryPackage";
import { DEFAULT_NARRATIVE_MEMORY_POLICY } from "@/game/application/server/ai/narrativeMemoryPolicy";
import type { NarrativeMemorySummarySource } from "@/game/application/narrativeMemorySummarySource";
import { createTempleLetterBundleSource } from "./templeLetterJourney.testutil";

export type P3StoryEvidence = Readonly<{
  completed: boolean;
  actionCount: number;
  investigationEventIds: readonly EventId[];
  goalChangeEventIds: readonly EventId[];
  availableActionsBeforeEvidence: readonly Action[];
  availableActionsAfterEvidence: readonly Action[];
  publicWitnessFactIds: readonly FactId[];
  recalledEvidenceInAuthorRequest: boolean;
  privateEvidenceLeaked: boolean;
  itemGivenEventCount: number;
  reloadEqual: boolean;
}>;

const FIXED_NOW = "2026-09-15T00:00:00.000Z";
const FIRST_INVESTIGATION_FACT_ID = asFactId("fact_dyn_2");
const FIRST_INVESTIGATION_NPC_ID = asNpcId("npc_dyn_1");
const PRIVATE_OPENING_FACT_ID = asFactId("fact_1");

type DecisionContext = Extract<NarrativeBundleSourceContext, { kind: "decision" }>;

function firstChoice(proposal: NarrativeBundleProposal, candidateId: string, label: string): NarrativeBundleProposal {
  const fallback = proposal.currentScene.choices[0] ?? { candidateId: "current_scene_choice_1", label: "继续核对" };
  return {
    ...proposal,
    currentScene: {
      ...proposal.currentScene,
      choices: [{ candidateId, label }, proposal.currentScene.choices[1] ?? fallback],
    },
  };
}

function firstDynamicDelta(delta: WorldDeltaProposal): WorldDeltaProposal {
  if (delta.newFact === null || delta.newNpc === null || delta.newLocation === null) return delta;
  const approaches = [
    { approachId: "quiet", label: "保持原样查验石桩", hint: "不惊动现场的人", evidenceQuality: "clean" as const, tensionDelta: 0 },
    { approachId: "witnessed", label: "请接应人当面见证查验", hint: "让现场的人看见你确认的结果", evidenceQuality: "clean" as const, tensionDelta: 2, witnessNpcIds: ["@new.npc"] },
  ];
  return {
    ...delta,
    newFact: {
      ...delta.newFact,
      text: "石桩内侧留着与信筒相同的旧约暗记，说明交接人确实来过这里。",
      investigationLabel: "查验石桩上的旧约暗记",
      investigationApproaches: undefined,
    },
    consequenceBindings: [
      {
        kind: "bind_investigation",
        factRef: "@new.fact",
        discoveryMode: "investigation",
        approaches: approaches.map(({ witnessNpcIds, ...approach }) => ({
          ...approach,
          ...(witnessNpcIds === undefined ? {} : { witnessNpcIds }),
        })),
      },
    ],
  };
}

function hasInvestigationResult(context: DecisionContext): boolean {
  return context.worldState.eventLedger.some((event) => event.payload.type === "fact_discovered"
    && String(event.payload.factId) === String(FIRST_INVESTIGATION_FACT_ID)
    && event.payload.evidenceQuality !== undefined);
}

function investigationEvent(context: DecisionContext) {
  return context.worldState.eventLedger.find((event) => event.payload.type === "fact_discovered"
    && String(event.payload.factId) === String(FIRST_INVESTIGATION_FACT_ID)
    && event.payload.evidenceQuality !== undefined);
}

function hasGoalResolution(context: DecisionContext): boolean {
  const npc = context.worldState.entityStore.records.find((record): record is NpcEntityRecord => record.core.kind === "npc"
    && String(record.core.id) === String(FIRST_INVESTIGATION_NPC_ID));
  return npc !== undefined
    && npc.dynamicState.goals.some((goal) => goal.resolution?.completeWhen.some((condition) => condition.kind === "investigation_observed"
      && String(condition.factId) === String(FIRST_INVESTIGATION_FACT_ID)) === true);
}

function installGoalResolution(
  result: Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }>,
  context: DecisionContext,
): Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }> {
  const npc = context.worldState.entityStore.records.find((record) => record.core.kind === "npc"
    && String(record.core.id) === String(FIRST_INVESTIGATION_NPC_ID));
  const fact = context.worldState.entityStore.records.find((record) => record.core.kind === "fact"
    && String(record.core.id) === String(FIRST_INVESTIGATION_FACT_ID));
  if (npc?.core.kind !== "npc" || fact?.core.kind !== "fact" || hasGoalResolution(context)) return result;
  return {
    ...result,
    proposal: {
      ...result.proposal,
      consequenceBindings: [
        ...(result.proposal.consequenceBindings ?? []),
        {
          kind: "bind_goal_resolution",
          npcRef: String(FIRST_INVESTIGATION_NPC_ID),
          goalOrdinal: 0,
          resolution: {
            completeWhen: [{ kind: "investigation_observed", npcId: String(FIRST_INVESTIGATION_NPC_ID), factId: String(FIRST_INVESTIGATION_FACT_ID), evidenceQuality: "clean" }],
            blockWhen: [{ kind: "investigation_observed", npcId: String(FIRST_INVESTIGATION_NPC_ID), factId: String(FIRST_INVESTIGATION_FACT_ID), evidenceQuality: "noisy" }],
          },
        },
        {
          kind: "bind_npc_cooperation",
          npcRef: String(FIRST_INVESTIGATION_NPC_ID),
          definitions: [{
            operation: "request_verification",
            requirements: [{ kind: "goal_status", npcId: String(FIRST_INVESTIGATION_NPC_ID), goalOrdinal: 0, status: "completed" }],
            allowedFactIds: [String(FIRST_INVESTIGATION_FACT_ID)],
            allowedAudienceIds: [String(PLAYER_ENTITY_ID)],
          }],
        },
      ],
    },
  };
}

function hasInteraction(context: DecisionContext, operation: string, factId?: FactId): boolean {
  return context.worldState.eventLedger.some((event) => event.payload.type === "story_interaction_resolved"
    && event.payload.operation === operation
    && (factId === undefined || event.payload.factIds.some((id) => String(id) === String(factId))));
}

function hasPendingInteraction(context: DecisionContext, proposalKey: string): boolean {
  const suffix = `:${proposalKey}`;
  return context.worldState.entityStore.records.some((record) => record.core.kind === "npc"
    && (record as NpcEntityRecord).interactions?.some((interaction) => interaction.id.endsWith(suffix)) === true);
}

function installEvidenceInteraction(
  context: DecisionContext,
  result: Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }>,
  route: "private" | "public",
): Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }> {
  if (context.storyState.currentAct !== 2 || context.storyState.evolution.status !== "stable") return result;
  if (!hasInvestigationResult(context)) return result;
  const evidence = investigationEvent(context);
  if (evidence === undefined) return result;
  const evidenceShared = hasInteraction(context, "share_known_fact", FIRST_INVESTIGATION_FACT_ID);
  const evidenceVerified = hasInteraction(context, "request_verification", FIRST_INVESTIGATION_FACT_ID);
  if (evidenceVerified && (route === "public" || evidenceShared)) {
    return {
      ...result,
      proposal: {
        ...result.proposal,
        interactionProposals: [],
        currentScene: {
          ...result.proposal.currentScene,
          choices: [
            { candidateId: "current_scene_choice_1", label: "表示愿意继续核对" },
            { candidateId: "current_scene_choice_2", label: "质疑这份交接是否可靠" },
          ],
        },
      },
    };
  }
  if (route === "private"
    && !hasInteraction(context, "share_known_fact", FIRST_INVESTIGATION_FACT_ID)
    && !hasPendingInteraction(context, "p3_tell_evidence")) {
    return {
      ...result,
      proposal: firstChoice({
        ...result.proposal,
        interactionProposals: [
          ...(result.proposal.interactionProposals ?? []),
          {
            proposalKey: "p3_tell_evidence",
            npcId: FIRST_INVESTIGATION_NPC_ID,
            operation: "share_known_fact",
            condition: [],
            factIds: [FIRST_INVESTIGATION_FACT_ID],
            goalIds: [],
            promiseId: null,
            audienceIds: [FIRST_INVESTIGATION_NPC_ID],
            evidenceEventIds: [evidence.eventId],
          },
        ],
      }, "interaction:p3_tell_evidence", "把查验结果告诉接应人"),
    };
  }
  if (route === "private"
    && !hasInteraction(context, "share_known_fact", FIRST_INVESTIGATION_FACT_ID)
    && hasPendingInteraction(context, "p3_tell_evidence")) return result;
  if (route === "public"
    && !hasInteraction(context, "share_known_fact", asFactId("fact_0"))
    && !hasPendingInteraction(context, "p3_public_evidence")) {
    return {
      ...result,
      proposal: firstChoice({
        ...result.proposal,
        interactionProposals: [
          ...(result.proposal.interactionProposals ?? []),
          {
            proposalKey: "p3_public_evidence",
            npcId: FIRST_INVESTIGATION_NPC_ID,
            operation: "share_known_fact",
            condition: [],
            factIds: [asFactId("fact_0")],
            goalIds: [],
            promiseId: null,
            audienceIds: [FIRST_INVESTIGATION_NPC_ID],
            evidenceEventIds: [],
          },
        ],
      }, "interaction:p3_public_evidence", "公开说明信筒来路"),
    };
  }
  if (route === "public"
    && !hasInteraction(context, "share_known_fact", asFactId("fact_0"))
    && hasPendingInteraction(context, "p3_public_evidence")) return result;
  if (!hasInteraction(context, "request_verification", FIRST_INVESTIGATION_FACT_ID)
    && !hasPendingInteraction(context, "p3_verify_evidence")) {
    return {
      ...result,
      proposal: firstChoice({
        ...result.proposal,
        interactionProposals: [
          ...(result.proposal.interactionProposals ?? []),
          {
            proposalKey: "p3_verify_evidence",
            npcId: FIRST_INVESTIGATION_NPC_ID,
            operation: "request_verification",
            condition: [],
            factIds: [FIRST_INVESTIGATION_FACT_ID],
            goalIds: [],
            promiseId: null,
            audienceIds: [PLAYER_ENTITY_ID],
            evidenceEventIds: [evidence.eventId],
          },
        ],
      }, "interaction:p3_verify_evidence", "请接应人核验这条记录"),
    };
  }
  return result;
}

function installPublicAlternative(
  result: Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }>,
  context: DecisionContext,
): Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }> {
  if (context.storyState.currentAct !== 2 || context.storyState.evolution.status !== "needs_next_act") return result;
  if (!result.proposal.interactionProposals?.some((entry) => entry.proposalKey === "route_private")) return result;
  const interactionProposals = result.proposal.interactionProposals.map((entry) => entry.proposalKey === "route_private"
    ? {
        ...entry,
        proposalKey: "route_public",
        operation: "share_known_fact" as const,
        factIds: [asFactId("fact_0")],
        audienceIds: [asNpcId("@new.npc")],
        evidenceEventIds: [],
        promiseId: null,
        ...("confidentiality" in entry ? { confidentiality: undefined } : {}),
      }
    : entry);
  const replace = (label: string) => label.includes("保密") ? "公开说明信筒来路" : label;
  return {
    ...result,
    proposal: {
      ...result.proposal,
      interactionProposals,
      currentScene: { ...result.proposal.currentScene, choices: result.proposal.currentScene.choices.map((choice) => ({ ...choice, label: replace(choice.label) })) },
      continuationScenes: result.proposal.continuationScenes.map((step) => ({
        ...step,
        scene: { ...step.scene, choices: step.scene.choices.map((choice) => ({ ...choice, label: replace(choice.label) })) },
      })),
    },
  };
}

function createP3Source(route: "private" | "public", onAuthorRequest: (context: DecisionContext) => void): NarrativeBundleSource {
  const base = createTempleLetterBundleSource("private");
  return {
    async generate(context): Promise<NarrativeBundleSourceResult> {
      if (context.kind === "opening") return base.generate(context);
      if (context.job.utterance?.includes("查验")) onAuthorRequest(context);
      const generated = await base.generate(context);
      if (!generated.ok || generated.kind !== "decision") return generated;
      const generatedDecision = generated as Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }>;
      const withInvestigationSpeaker: Extract<NarrativeBundleSourceResult, { ok: true; kind: "decision" }> = context.job.actionSummary.kind !== "investigate"
        ? generatedDecision
        : (() => {
            const speaker = context.worldState.npcs.find((npc) => String(npc.locationId) === String(context.worldState.currentLocationId));
            return speaker === undefined
              ? generatedDecision
              : {
                  ...generated,
                  proposal: {
                    ...generated.proposal,
                    currentScene: {
                      ...generated.proposal.currentScene,
                      npcLine: {
                        npcId: String(speaker.id),
                        text: "你已经完成查验，接应人把这条记录留在灯下。",
                        emotion: "guarded" as const,
                        answeredBeatIds: [],
                        usedFactIds: [],
                        usedEventIds: [],
                      },
                    },
                  },
                };
          })();
      const worldDelta = withInvestigationSpeaker.proposal.worldDelta;
      const withDelta = worldDelta === null
        || context.storyState.evolution.nextLocationOrdinal !== 1
        || context.storyState.evolution.nextNpcOrdinal !== 1
        ? withInvestigationSpeaker
        : { ...withInvestigationSpeaker, proposal: { ...withInvestigationSpeaker.proposal, worldDelta: firstDynamicDelta(worldDelta as WorldDeltaProposal) } };
      const withoutInitialRouteInteraction = withDelta.proposal.worldDelta === null
        ? withDelta
        : {
            ...withDelta,
            proposal: {
              ...withDelta.proposal,
              interactionProposals: [],
              continuationScenes: withDelta.proposal.continuationScenes.map((step) => ({
                ...step,
                scene: {
                  ...step.scene,
                  choices: step.scene.choices.length === 2
                    ? [
                        { candidateId: `${step.stepKey}_choice_1`, label: "表示愿意继续核对" },
                        { candidateId: `${step.stepKey}_choice_2`, label: "质疑这份交接是否可靠" },
                      ]
                    : step.scene.choices,
                },
              })),
            },
          };
      const withGoalResolution = installGoalResolution(withoutInitialRouteInteraction, context);
      const withEvidenceInteraction = installEvidenceInteraction(context, withGoalResolution, route);
      return route === "public" ? installPublicAlternative(withEvidenceInteraction, context) : withEvidenceInteraction;
    },
  };
}

function visibleActions(record: GameRecord): readonly { token: string; action: Action }[] {
  const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
  const view = projectGameSessionView(record.worldState, record.storyState, record.revision, "p3-offline");
  const tokens = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "choiceToken" && typeof child === "string") tokens.add(child);
      else collect(child);
    }
  };
  collect(view);
  return [...tokens].flatMap((token) => {
    const action = map.get(token);
    return action === undefined ? [] : [{ token, action }];
  });
}

function narrativeChoiceActions(record: GameRecord): readonly { token: string; label: string; action: Action }[] {
  const view = projectGameSessionView(record.worldState, record.storyState, record.revision, "p3-offline");
  const choices = [
    ...view.narrative.choices,
    ...view.narrative.npcDialogues.flatMap((dialogue) => [
      ...dialogue.choices,
      ...dialogue.giveChoices.map((entry) => entry.choice),
    ]),
  ];
  const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
  return choices.flatMap((choice) => {
    const action = map.get(choice.choiceToken);
    return action === undefined ? [] : [{ token: choice.choiceToken, label: choice.label, action }];
  });
}

function activeMoveIds(record: GameRecord): readonly string[] {
  if (record.storyState.narrative.status !== "ready" || record.storyState.narrative.narrativeBundle === undefined) return [];
  const bundle = record.storyState.narrative.narrativeBundle;
  return bundle.steps
    .filter((step) => record.storyState.narrative.status === "ready"
      && bundle.activeStepIds.includes(step.stepId)
      && step.trigger.kind === "move")
    .map((step) => step.trigger.kind === "move" ? String(step.trigger.locationId) : "");
}

export async function runOfflineP3Story(input: { route: "private" | "public"; reloadAtRevisit: boolean }): Promise<P3StoryEvidence> {
  const directory = mkdtempSync(join(tmpdir(), "rpg-p3-offline-"));
  const dbPath = join(directory, "journey.sqlite");
  const clientFactory = () => createSqliteClient(dbPath);
  const openRepository = (): GameRepository & { initializeSchema(): Promise<void>; close(): Promise<void> } => createSqliteGameRepository({ clientFactory, logError: (_context, error) => { throw error; } });
  let repository = openRepository();
  let memoryRepository = createSqliteNarrativeMemorySummaryRepository({ clientFactory, gameRepository: repository });
  let actionCount = 0;
  let reloadEqual = true;
  let recalledEvidenceInAuthorRequest = false;
  const investigationEventIds: EventId[] = [];
  const goalChangeEventIds: EventId[] = [];
  let beforeEvidence: readonly Action[] = [];
  let afterEvidence: readonly Action[] = [];
  const source = createP3Source(input.route, (context) => {
    const evidence = investigationEvent(context);
    if (evidence === undefined || context.memoryContext === undefined) return;
    const refs = [...context.memoryContext.recalled, ...context.memoryContext.uncovered, ...context.memoryContext.requiredEvents,
      ...(context.memoryContext.overviewEvents ?? [])];
    recalledEvidenceInAuthorRequest ||= refs.some((entry) => "eventId" in entry
      ? String(entry.eventId) === String(evidence.eventId)
      : entry.eventIds.some((eventId) => String(eventId) === String(evidence.eventId)));
  });

  const read = async (): Promise<GameRecord> => {
    const current = await repository.getCurrentGame();
    if (!current.ok || current.status !== "active") throw new Error("P3 story is not active");
    return current.record;
  };
  const summarySource: NarrativeMemorySummarySource = {
    async select(selection) {
      const historyIds = selection.history.filter((entry) => entry.kind !== "shown_choice").slice(0, 8).map((entry) => entry.id);
      const eventIds = selection.events.slice(0, 8).map((entry) => entry.eventId);
      if (historyIds.length === 0 && eventIds.length === 0) return createAiSourceFailure("scene", "transport");
      return { ok: true, selection: { historyIds, eventIds } };
    },
  };
  const ensure = async (): Promise<void> => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await read();
      if (current.storyState.narrative.status === "ready") return;
      if (current.storyState.narrative.status !== "provider_pending") throw new Error("P3 story entered a failed narrative state");
      const generated = await generatePendingNarrativeBundle({
        repository,
        source,
        now: () => FIXED_NOW,
        memorySummaryRepository: memoryRepository,
        prepareMemoryPackage: createNarrativeMemoryPackagePreparer({
          repository: memoryRepository,
          source: summarySource,
          policy: { ...DEFAULT_NARRATIVE_MEMORY_POLICY, threshold: 1, batchSize: 8, rawSoftEstimatedTokens: 1 },
          summaries: "enabled",
        }),
      });
      if (!generated.ok) {
        const failed = await read();
        throw new Error(`P3 narrative ensure failed: ${JSON.stringify(generated)}; narrative=${JSON.stringify(failed.storyState.narrative)}`);
      }
    }
    throw new Error("P3 narrative ensure exceeded retry budget");
  };
  const submit = async (entry: { token: string; action: Action }): Promise<void> => {
    const current = await read();
    const result = await performTurn({
      gameId: current.gameId,
      actionId: `p3_${input.route}_${actionCount + 1}`,
      interaction: { kind: "fixed_choice", choiceToken: entry.token },
      expectedRevision: current.revision,
      choiceMap: buildChoiceMap(current.worldState, current.storyState, current.revision),
    }, { repository, now: () => FIXED_NOW });
    if (!result.ok) throw new Error(`P3 action failed: ${JSON.stringify(result)}; action=${JSON.stringify(entry.action)}`);
    actionCount += 1;
    await ensure();
  };
  const submitFreeform = async (): Promise<void> => {
    const current = await read();
    const view = projectGameSessionView(current.worldState, current.storyState, current.revision, "p3-offline");
    const dialogue = view.narrative.npcDialogues.find((entry) => entry.freeInputEnabled);
    if (dialogue === undefined) throw new Error("P3 recall has no legal NPC target");
    const result = await performTurn({
      gameId: current.gameId,
      actionId: `p3_${input.route}_recall`,
      interaction: { kind: "free_text", targetNpcId: asNpcId(dialogue.npcId), text: "回想刚才的静默查验记录，再决定是否告知接应人。" },
      expectedRevision: current.revision,
      choiceMap: buildChoiceMap(current.worldState, current.storyState, current.revision),
    }, { repository, now: () => FIXED_NOW });
    if (!result.ok) throw new Error(`P3 recall failed: ${JSON.stringify(result)}`);
    actionCount += 1;
    await ensure();
  };
  const reopenAndCompare = async (): Promise<void> => {
    const before = await read();
    await memoryRepository.close();
    await repository.close();
    repository = openRepository();
    memoryRepository = createSqliteNarrativeMemorySummaryRepository({ clientFactory, gameRepository: repository });
    await repository.initializeSchema();
    reloadEqual &&= JSON.stringify(before) === JSON.stringify(await read());
  };
  const choose = async (predicate: (action: Action) => boolean, message: string): Promise<void> => {
    const current = await read();
    const candidates = visibleActions(current);
    const selected = candidates.find((entry) => predicate(entry.action));
    if (selected === undefined) throw new Error(`P3 missing legal action: ${message}; candidates=${JSON.stringify(candidates)}; state=${JSON.stringify({ act: current.storyState.currentAct, evolution: current.storyState.evolution, quest: current.worldState.quests, narrative: current.storyState.narrative.status })}`);
    await submit(selected);
  };
  const chooseScene = async (predicate: (label: string) => boolean, message: string): Promise<void> => {
    const current = await read();
    const selected = narrativeChoiceActions(current).find((entry) => predicate(entry.label));
    if (selected === undefined) throw new Error(`P3 missing scene choice: ${message}`);
    await submit(selected);
  };

  try {
    await repository.initializeSchema();
    const created = await createGame({ gameId: asGameId(`p3_${input.route}`), gameType: "wuxia", gameLength: "short", seed: "p3-shared-initial-state" }, { repository, source, now: () => FIXED_NOW, aiEnabled: false });
    if (!created.ok) throw new Error(`P3 create failed: ${JSON.stringify(created)}`);
    await chooseScene((label) => label.includes("先问清楚"), "opening ask");
    await chooseScene((label) => label.includes("质疑"), "opening challenge");
    const afterOpening = await read();
    const firstMoveIds = activeMoveIds(afterOpening);
    await choose((action) => action.type === "move" && firstMoveIds.includes(String(action.locationId)), "first act move");

    beforeEvidence = visibleActions(await read()).map((entry) => entry.action);
    await choose((action) => action.type === "investigate" && action.approachId === (input.route === "private" ? "quiet" : "witnessed"), "route investigation");
    afterEvidence = visibleActions(await read()).map((entry) => entry.action);
    if (input.reloadAtRevisit) await reopenAndCompare();

    if (input.route === "private") {
      await submitFreeform();
      await choose((action) => action.type === "talk" && action.interactionId?.includes("p3_tell_evidence") === true, "tell evidence");
    } else {
      await choose((action) => action.type === "talk" && action.interactionId?.includes("p3_public_evidence") === true, "public evidence");
    }
    await choose((action) => action.type === "talk" && action.interactionId?.includes("p3_verify_evidence") === true, "verify evidence");

    for (let turn = 0; turn < 40; turn += 1) {
      const current = await read();
      if (current.worldState.ending !== null) break;
      const candidates = visibleActions(current);
      const give = candidates.find((entry) => entry.action.type === "give_item");
      const moveIds = activeMoveIds(current);
      const move = candidates.find((entry) => entry.action.type === "move" && moveIds.includes(String(entry.action.locationId)));
      const interaction = candidates.find((entry) => entry.action.type === "talk" && entry.action.interactionId !== undefined);
      const talk = candidates.find((entry) => entry.action.type === "talk" && entry.action.dialogueAct === (turn % 2 === 0 ? "support" : "challenge"))
        ?? candidates.find((entry) => entry.action.type === "talk");
      const regularTalk = candidates.find((entry) => entry.action.type === "talk" && entry.action.interactionId === undefined
        && entry.action.dialogueAct === (turn % 2 === 0 ? "support" : "challenge"))
        ?? candidates.find((entry) => entry.action.type === "talk" && entry.action.interactionId === undefined);
      const next = give ?? move ?? regularTalk ?? interaction ?? talk;
      if (next === undefined) throw new Error(`P3 journey stalled: ${JSON.stringify(candidates)}`);
      await submit(next);
    }

    const final = await read();
    const investigationEvents = final.worldState.eventLedger.filter((event) => event.payload.type === "fact_discovered" && event.payload.evidenceQuality !== undefined);
    investigationEventIds.push(...investigationEvents.map((event) => event.eventId));
    goalChangeEventIds.push(...final.worldState.eventLedger.filter((event) => event.payload.type === "npc_goal_status_changed").map((event) => event.eventId));
    const publicWitnessFactIds = investigationEvents.flatMap((event) => event.payload.type === "fact_discovered" && (event.payload.witnessNpcIds ?? []).length > 0 ? [event.payload.factId] : []);
    const privateEvidenceLeaked = final.worldState.eventLedger.some((event) => event.payload.type === "story_interaction_resolved"
      && event.payload.operation === "share_known_fact"
      && event.payload.factIds.some((factId) => String(factId) === String(PRIVATE_OPENING_FACT_ID)));
    return {
      completed: final.worldState.ending !== null && final.storyState.narrative.status === "ready",
      actionCount,
      investigationEventIds,
      goalChangeEventIds,
      availableActionsBeforeEvidence: beforeEvidence,
      availableActionsAfterEvidence: afterEvidence,
      publicWitnessFactIds,
      recalledEvidenceInAuthorRequest,
      privateEvidenceLeaked,
      itemGivenEventCount: final.worldState.eventLedger.filter((event) => event.kind === "item_given").length,
      reloadEqual,
    };
  } finally {
    await memoryRepository.close();
    await repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
