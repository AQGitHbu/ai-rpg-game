import type { AiMessage } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { createAiSourceFailure, aiRepairAuditContext } from "../../aiGenerationRetry";
import { classifyAiFailure, transportFailureCodeToCategory } from "../../aiGenerationFailure";
import { parseStructuredJsonObject } from "@/game/core/json";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import { parseOpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import type {
  NarrativeBundleSource,
  NarrativeBundleSourceContext,
  NarrativeBundleSourceResult,
  NarrativeBundleRepairReason,
} from "../../narrativeBundleSource";
import type { RpgAiClient } from "./rpgAiClient";
import type { NarrativeRequestClient } from "./narrativeRequestClient";
import type { ProviderJsonMode } from "./providerRequestOptions";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";
import { resolveOpeningResponses } from "@/game/gameplay/rpg/openingGeneration";
import type { OpeningNarrativeBundleProposal } from "../../narrativeBundleSource";
import { compileDecisionNarrativeContext } from "./narrativeContext";
import { parseWorldDeltaProposal } from "./liveWorldEvolutionSource";
import { hasOnlyKnownOpeningCandidateKeys } from "./openingGenerationSource";
import { buildOpeningNarrativePrompt } from "./openingNarrativePrompt";
import { compileNarrativeDraft } from "./narrativeDraftProjection";

// ---------------------------------------------------------------------------
// Task 5：统一叙事生成包 live source。
// 一次 generate 调用 = 一次 aiClient.complete("narrative_bundle", ...) 调用。
// 只做 JSON 解析和提案校验，不做审批/铸造 ID/写状态。
// ---------------------------------------------------------------------------

export type LiveNarrativeBundleSourceDeps = {
  /** Explicit historical fixture adapter; production never enables this. */
  readonly allowLegacyDecisionDto?: boolean;
  readonly aiClient?: RpgAiClient;
  readonly requestClient?: NarrativeRequestClient;
  readonly logger?: GameLogger;
  readonly jsonMode?: ProviderJsonMode;
};

function failBundle(
  category: Parameters<typeof classifyAiFailure>[0]["category"],
  repairReason?: NarrativeBundleRepairReason,
  repairDetail?: string,
): Extract<NarrativeBundleSourceResult, { readonly ok: false }> {
  return createAiSourceFailure("scene", category, repairReason, repairDetail);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: readonly unknown[]): string {
  return values.find((value): value is string => typeof value === "string") ?? "";
}

/**
 * Some compatible providers still emit prior presentation vocabulary despite
 * the current prompt. This is structural normalization only: it reuses text
 * already returned by the provider and never writes a rule-owned narrative.
 * Creation fields are passed through untouched so missing/legacy material fails
 * closed in parseOpeningGenerationCandidate instead of receiving defaults.
 */
function normalizeOpeningCandidateShape(value: unknown, targetActs: 3 | 5): unknown {
  const raw = asRecord(value);
  const opening = asRecord(raw?.opening);
  const world = asRecord(opening?.world);
  const player = asRecord(opening?.player);
  const storyContract = asRecord(opening?.storyContract);
  const openingDetail = asRecord(opening?.opening);
  if (raw === null || opening === null || world === null || player === null || storyContract === null || openingDetail === null) {
    return value;
  }

  const facts = Array.isArray(world.publicFacts)
    ? world.publicFacts.map((fact) => {
      const entry = asRecord(fact);
      return entry === null ? fact : { ...entry, key: firstString(entry.key, entry.id) };
    })
    : world.publicFacts;
  const providerNpc = asRecord(openingDetail.npc)
    ?? (Array.isArray(openingDetail.startingNpcs) ? asRecord(openingDetail.startingNpcs[0]) : null);
  const location = asRecord(openingDetail.location);
  const locationName = firstString(location?.name, openingDetail.location);
  const locationDescription = firstString(location?.description, openingDetail.locationDescription);
  const quest = asRecord(openingDetail.quest);
  const legacyQuest = firstString(openingDetail.initialQuest, openingDetail.initialTask, openingDetail.task);
  const existingDirections = Array.isArray(storyContract.endingDirections) ? storyContract.endingDirections : null;

  return {
    ...raw,
    opening: {
      ...opening,
      world: {
        ...world,
        summary: firstString(world.summary, world.worldState, world.name),
        tone: firstString(world.tone, storyContract.tone, storyContract.narrativeFocus),
        themes: Array.isArray(world.themes) ? world.themes : [],
        publicFacts: facts,
      },
      player: {
        ...player,
        backgroundSummary: firstString(player.backgroundSummary, player.background),
        baseStats: asRecord(player.baseStats) ?? { hp: 100, attack: 10, defense: 5 },
      },
      storyContract: {
        ...storyContract,
        version: 1,
        targetActs,
        centralConflict: firstString(storyContract.centralConflict, storyContract.coreConflict, storyContract.corePremise, storyContract.goal),
        endingDirections: existingDirections ?? [
          { key: "trust", theme: firstString(storyContract.playerAgency, storyContract.tone) },
          { key: "doubt", theme: firstString(storyContract.tone, storyContract.stakes, storyContract.narrativeFocus) },
        ],
      },
      opening: {
        ...openingDetail,
        location: {
          ...(location ?? {}),
          name: locationName,
          description: locationDescription,
          buildingName: firstString(location?.buildingName, locationName),
          scale: "town",
        },
        npc: {
          ...(providerNpc ?? {}),
          name: firstString(providerNpc?.name),
          role: firstString(providerNpc?.role, providerNpc?.description),
          description: firstString(providerNpc?.description, providerNpc?.role),
          knownFactKeys: Array.isArray(providerNpc?.knownFactKeys) ? providerNpc.knownFactKeys : [],
          privateFactKeys: Array.isArray(providerNpc?.privateFactKeys) ? providerNpc.privateFactKeys : [],
          ...(providerNpc?.anchors === undefined ? {} : { anchors: providerNpc.anchors }),
          ...(providerNpc?.goals === undefined ? {} : { goals: providerNpc.goals }),
        },
        quest: {
          ...(quest ?? {}),
          name: firstString(quest?.name, legacyQuest),
          description: firstString(quest?.description, legacyQuest),
          objective: { kind: "talk_to_opening_npc" },
        },
      },
    },
  };
}

type ProjectedStep = {
  readonly stepKey: string;
  readonly candidates: readonly { readonly candidateId: string }[];
};

/** The only continuation graph a decision response may fill. */
function projectedSteps(
  graph: ReturnType<typeof buildNarrativeBundleDescriptors>,
  nextActProjection: { readonly stepKey: string; readonly npcId: string } | null,
): readonly ProjectedStep[] {
  if (nextActProjection !== null) {
    return [{
      stepKey: nextActProjection.stepKey,
      candidates: [
        { candidateId: `${nextActProjection.stepKey}_choice_1` },
        { candidateId: `${nextActProjection.stepKey}_choice_2` },
      ],
    }];
  }
  return graph.steps.map((step) => ({ stepKey: step.stepKey, candidates: step.choiceCandidates }));
}

/** Normalize legacy presentation aliases without changing any AI-authored text. */
function normalizeDecisionBundleShape(
  value: unknown,
  worldState: WorldState,
  storyState: StoryState,
  job: PendingNarrativeJob,
): unknown {
  const raw = asRecord(value);
  const currentScene = asRecord(raw?.currentScene);
  if (raw === null || currentScene === null) return value;

  const graph = buildNarrativeBundleDescriptors({
    worldState,
    storyState,
    transition: job.objectiveTransition,
  });
  const nextActProjection = storyState.evolution.status === "needs_next_act"
    ? {
        stepKey: `move:loc_dyn_${storyState.evolution.nextLocationOrdinal}`,
        npcId: `npc_dyn_${storyState.evolution.nextNpcOrdinal}`,
    }
    : null;
  const isEndingBundle = (storyState.evolution.status === "needs_ending_pair"
    && worldState.endings.length < 2)
    || (storyState.endingAllowed && worldState.endings.length >= 2)
    || job.actionSummary.kind === "abandon_quest";
  const steps = projectedSteps(graph, nextActProjection);
  const fallbackNpcId = nextActProjection?.npcId ?? String(job.focusNpcId ?? "");

  const normalizeChoices = (
    sourceChoices: unknown,
    _candidates: readonly { readonly candidateId: string }[],
  ): unknown => (Array.isArray(sourceChoices) ? sourceChoices : []).map((choice) => {
    const entry = asRecord(choice);
    return entry === null ? choice : {
      candidateId: entry.candidateId,
      label: firstString(entry.label, entry.text),
    };
  });
  const normalizeNpcLine = (source: unknown, npcIdFallback: string): unknown => {
    const sourceNpcLine = asRecord(source);
    return sourceNpcLine ?? (typeof source === "string"
    ? {
        npcId: npcIdFallback,
        text: source,
        emotion: "neutral",
        answeredBeatIds: [],
        usedFactIds: [],
        usedEventIds: [],
      }
    : source);
  };

  const normalizeObjectiveLink = (source: unknown): unknown => {
    const objectiveLink = asRecord(source);
    const objectiveIsValid = objectiveLink !== null
    && worldState.quests.some((quest) => String(quest.id) === objectiveLink.questId)
    && typeof objectiveLink.objectiveIndex === "number"
    && (objectiveLink.mode === "hint" || objectiveLink.mode === "progress");
    // Invalid legacy objective prose cannot carry server authority. Dropping
    // it preserves the generated scene while keeping objective state rule-owned.
    return objectiveIsValid ? objectiveLink : null;
  };

  const normalizeWorldDelta = (source: unknown): unknown => {
    const worldDelta = asRecord(source);
    const newLocation = asRecord(worldDelta?.newLocation);
    if (worldDelta === null || newLocation === null) return source;
    const rawConnectFrom = newLocation.connectFromLocationId;
    if (typeof rawConnectFrom !== "string") return source;
    const resolvedLocationId = rawConnectFrom === "@current.location"
      ? String(worldState.currentLocationId)
      : (() => {
          const matchingLocations = worldState.locations
            .filter((location) => location.name === rawConnectFrom);
          return matchingLocations.length === 1 ? String(matchingLocations[0]!.id) : null;
        })();
    if (resolvedLocationId === null || resolvedLocationId === rawConnectFrom) return source;
    return {
      ...worldDelta,
      newLocation: { ...newLocation, connectFromLocationId: resolvedLocationId },
    };
  };

  const normalizeScene = (
    scene: Record<string, unknown>,
    candidates: readonly { readonly candidateId: string }[],
    npcIdFallback: string,
  ): Record<string, unknown> => ({
    ...(scene.expressions === undefined ? {} : { expressions: scene.expressions }),
    segments: scene.segments,
    npcLine: normalizeNpcLine(scene.npcLine, npcIdFallback),
    ...(scene.npcDialogues === undefined ? {} : { npcDialogues: scene.npcDialogues }),
    objectiveLink: normalizeObjectiveLink(scene.objectiveLink),
    choices: normalizeChoices(scene.choices, candidates),
    ...(scene.handoffAcknowledgement === undefined ? {} : { handoffAcknowledgement: scene.handoffAcknowledgement }),
  });

  // Compatible providers commonly emit a scene directly in the array instead of
  // the contract's { stepKey, scene } wrapper, and some keep planning past the
  // projected graph into the future they imagine. The server graph owns which
  // steps exist; provider entries are matched into it, never invented by it.
  const providerEntries = (Array.isArray(raw.continuationScenes) ? raw.continuationScenes : [])
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      if (entry === null) return null;
      const scene = asRecord(entry.scene) ?? entry;
      return { stepKey: typeof entry.stepKey === "string" ? entry.stepKey : "", scene };
    });
  const projectedKeySet = new Set(steps.map((step) => step.stepKey));
  const consumed = new Set<number>();
  const choiceCountAt = (index: number): number => {
    const scene = index >= 0 ? providerEntries[index]?.scene : undefined;
    return Array.isArray(scene?.choices) ? (scene.choices as unknown[]).length : 0;
  };
  const findUnused = (
    predicate: (entry: { stepKey: string; scene: Record<string, unknown> }, index: number) => boolean,
  ): number => providerEntries.findIndex((entry, index) => entry !== null
    && !consumed.has(index)
    && predicate(entry, index));

  const continuationScenes = steps.map((step, index) => {
    const positional = findUnused((entry, entryIndex) => entryIndex === index
      && (entry.stepKey === "" || entry.stepKey === step.stepKey || !projectedKeySet.has(entry.stepKey)));
    // A scene carrying the terminal options cannot belong to a linear step:
    // the contract requires every other step to have an empty choices list.
    const optionsCarrier = step.candidates.length > 0 && choiceCountAt(positional) !== step.candidates.length
      ? findUnused((entry, entryIndex) => entryIndex !== positional
        && choiceCountAt(entryIndex) === step.candidates.length)
      : -1;
    const named = findUnused((entry) => entry.stepKey === step.stepKey);
    const chosen = named >= 0 ? named : (optionsCarrier >= 0 ? optionsCarrier : positional);
    const entry = chosen >= 0 ? providerEntries[chosen] : null;
    if (entry === null) return null;
    consumed.add(chosen);
    return { stepKey: step.stepKey, scene: normalizeScene(entry.scene, step.candidates, fallbackNpcId) };
  }).filter((step): step is { stepKey: string; scene: Record<string, unknown> } => step !== null);

  const normalizedCurrentScene = normalizeScene(
    currentScene,
    nextActProjection === null ? graph.currentChoiceCandidates : [],
    fallbackNpcId,
  );
  return {
    ...raw,
    worldDelta: normalizeWorldDelta(raw.worldDelta),
    // Endings have no decision step inside the bundle: the server separately
    // projects its two rule-owned stances. Providers often add a harmless
    // target object to terminal; canonicalize that legacy shape here.
    currentScene: isEndingBundle ? { ...normalizedCurrentScene, choices: [] } : normalizedCurrentScene,
    continuationScenes: isEndingBundle ? [] : continuationScenes,
    terminal: isEndingBundle ? { kind: "ending" } : raw.terminal,
  };
}

type ParseOpeningBundleResult =
  | { readonly ok: true; readonly proposal: OpeningNarrativeBundleProposal }
  | { readonly ok: false; readonly reason: string };

function parseOpeningBundleProposal(value: unknown, targetActs: 3 | 5): ParseOpeningBundleResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "root_not_object" };
  const response = value as Record<string, unknown>;
  const allowedResponseKeys = new Set(["opening", "interactionProposals", "npcOutwardProposals", "currentScene", "continuationScenes", "terminal"]);
  if (Object.keys(response).some((key) => !allowedResponseKeys.has(key))) return { ok: false, reason: "unknown_keys" };
  if (!hasOnlyKnownOpeningCandidateKeys(response.opening)) return { ok: false, reason: "opening_unknown_keys" };
  const raw = normalizeOpeningCandidateShape(value, targetActs) as Record<string, unknown>;
  const opening = parseOpeningGenerationCandidate(raw.opening);
  if (!opening.ok) return { ok: false, reason: `opening_${opening.code}` };
  const narrative = parseNarrativeBundleProposal({
    worldDelta: null,
    interactionProposals: response.interactionProposals,
    npcOutwardProposals: response.npcOutwardProposals,
    currentScene: raw.currentScene,
    continuationScenes: raw.continuationScenes,
    terminal: raw.terminal,
  });
  if (!narrative.ok) return { ok: false, reason: `narrative_${narrative.code}` };
  if (
    narrative.proposal.terminal.kind !== "next_decision"
    || narrative.proposal.terminal.target.kind !== "current_scene"
    || narrative.proposal.continuationScenes.length !== 0
  ) return { ok: false, reason: "invalid_terminal" };
  const responses = resolveOpeningResponses(opening.value);
  if (responses === null) return { ok: false, reason: "invalid_response_reference" };
  const declaredKeys = new Set([
    ...responses.map((response) => response.candidateId),
    ...(narrative.proposal.interactionProposals ?? []).map((proposal) => `interaction:${proposal.proposalKey}`),
  ]);
  const choiceKeys = narrative.proposal.currentScene.choices.map((choice) => choice.candidateId);
  if (choiceKeys.length !== 2 || new Set(choiceKeys).size !== 2
    || choiceKeys.some((key) => !declaredKeys.has(key))) {
    return { ok: false, reason: "response_choice_mismatch" };
  }
  return {
    ok: true,
    proposal: {
      opening: opening.value,
      ...(narrative.proposal.interactionProposals === undefined
        ? {}
        : { interactionProposals: narrative.proposal.interactionProposals }),
      ...(narrative.proposal.npcOutwardProposals === undefined
        ? {}
        : { npcOutwardProposals: narrative.proposal.npcOutwardProposals }),
      currentScene: narrative.proposal.currentScene,
      continuationScenes: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    },
  };
}

export function createNarrativeBundleSource(
  deps: LiveNarrativeBundleSourceDeps = {},
): NarrativeBundleSource {
  const { logger, aiClient, requestClient } = deps;

  return {
    async generate(context: NarrativeBundleSourceContext): Promise<NarrativeBundleSourceResult> {
      if (aiClient === undefined) {
        logger?.warn("narrative_bundle_source_unavailable");
        return failBundle("unavailable");
      }

      try {
        const decisionCompilation = context.kind === "decision"
          ? compileDecisionNarrativeContext({
              worldState: context.worldState,
              storyState: context.storyState,
              job: context.job,
              ...(context.contentRepair === undefined ? {} : { contentRepair: context.contentRepair }),
    ...(context.candidateRevision === undefined ? {} : { candidateRevision: context.candidateRevision }),
    ...(context.authorDraftRevision === undefined ? {} : { authorDraftRevision: context.authorDraftRevision }),
    ...(context.npcOutward === undefined ? {} : { npcOutward: context.npcOutward }),
    ...(context.memoryContext === undefined ? {} : { memoryContext: context.memoryContext }),
            })
          : undefined;
        const prompt = decisionCompilation?.prompt ?? buildOpeningNarrativePrompt(
          context as Extract<NarrativeBundleSourceContext, { readonly kind: "opening" }>,
        );

        const messages: readonly AiMessage[] = [
          { role: "system", content: prompt },
          { role: "user", content: context.kind === "decision" ? "生成决策叙事包" : "生成初始化叙事包" },
        ];

        const auditContext = {
          ...(context.auditLink ?? {}),
          ...(context.contentRepair === undefined ? {} : { retry: aiRepairAuditContext(context.contentRepair, context.auditLink?.retry) }),
          purpose: "narrative_bundle_generation" as const,
          trigger: context.kind === "decision"
            ? context.job.utterance === undefined ? "narrative_choice" : "npc_free_text"
            : "initialization",
          jobId: context.kind === "decision" ? String(context.job.jobId) : String(context.jobId),
          turnNumber: context.kind === "decision" ? context.job.turnNumber : 0,
          ...(context.candidateVersion === undefined ? {} : { revision: context.candidateVersion }),
          action: context.kind === "decision" ? context.job.actionSummary : undefined,
          ...(decisionCompilation === undefined
            ? {}
            : { narrativeContext: decisionCompilation.manifest }),
        };
        const result = requestClient === undefined
          ? await aiClient.complete("narrative_bundle", messages, auditContext)
          : await requestClient.completeNarrativeRequest({
              purpose: "author",
              messages,
              auditContext,
              signal: context.signal ?? new AbortController().signal,
              ...(context.reserveHttpAttempt === undefined ? {} : { reserveHttpAttempt: context.reserveHttpAttempt }),
            });

        if (!result.ok) {
          logger?.warn("narrative_bundle_ai_failed", { code: result.code });
          const category = transportFailureCodeToCategory(result.code);
          return result.code === "empty_response"
            ? failBundle(category, "empty_response")
            : failBundle(category, undefined, result.code);
        }

        const parsed = parseStructuredJsonObject(result.content);
        if (parsed.ok && parsed.normalization === "json_fence") {
          logger?.warn("narrative_bundle_json_fence_normalized");
        }
        if (!parsed.ok) {
          logger?.warn("narrative_bundle_parse_failed", { reason: parsed.reason });
          return failBundle(
            parsed.reason === "root_not_object" ? "invalid_schema" : "invalid_json",
            parsed.reason === "root_not_object" ? "invalid_schema" : "invalid_json",
          );
        }

        if (context.kind === "decision") {
          const isDraft = !deps.allowLegacyDecisionDto || asRecord(parsed.value)?.sceneDrafts !== undefined;
          const compiled = isDraft ? compileNarrativeDraft(parsed.value, context) : null;
          if (compiled !== null && !compiled.ok) return { ...failBundle("invalid_schema", "invalid_schema", `${compiled.code} at ${compiled.path}`), rejectedDraft: parsed.value };
          const normalizedBundle = compiled?.ok ? compiled.value : normalizeDecisionBundleShape(
            parsed.value,
            context.worldState,
            context.storyState,
            context.job,
          );
          const normalizedRecord = asRecord(normalizedBundle);
          // 终幕包仍需携带 provider 生成的 endingPair；normalizeDecisionBundleShape
          // 只负责把终幕的 currentScene/continuationScenes/terminal 归一化，不能
          // 在 needs_ending_pair 时静默丢弃 worldDelta，否则结局永远无法物化，
          // endingAllowed 会与 worldState.endings 脱节并把界面卡在上一目标。
          const rawWorldDelta = normalizedRecord?.worldDelta;
          const parsedWorldDelta = rawWorldDelta === null || rawWorldDelta === undefined
            ? null
            : (() => {
                const parsed = parseWorldDeltaProposal(rawWorldDelta, context.worldState.generation.gameType);
                if (parsed !== null) return parsed;

                // newFact.investigationApproaches is an optional enrichment of a
                // next-act bundle. Compatible providers occasionally emit a
                // single approach even though the standalone fact contract
                // requires exactly 2–3. Do not let that optional malformed
                // enrichment block the required location/NPC/item/enemy/quest
                // package; retry the same raw proposal with only newFact
                // removed. All required fields still pass the strict parser.
                const rawRecord = asRecord(rawWorldDelta);
                if (rawRecord === null || rawRecord.newFact === null || rawRecord.newFact === undefined) return null;
                const withoutFact = parseWorldDeltaProposal(
                  { ...rawRecord, newFact: null },
                  context.worldState.generation.gameType,
                );
                if (withoutFact !== null) {
                  logger?.warn("narrative_bundle_invalid_optional_world_fact_dropped");
                  return withoutFact;
                }
                return null;
              })();
          if (rawWorldDelta !== null && rawWorldDelta !== undefined && parsedWorldDelta === null) {
            logger?.warn("narrative_bundle_invalid_world_delta");
            const deltaRecord = asRecord(rawWorldDelta);
            const invalidSummary = deltaRecord !== null
              && (typeof deltaRecord.beatSummary !== "string" || deltaRecord.beatSummary.trim().length === 0);
            let structuralDetail: string | undefined;
            parseWorldDeltaProposal(rawWorldDelta, context.worldState.generation.gameType, (issue) => {
              structuralDetail ??= `world_delta_invalid at $.worldDelta${issue.path}: ${issue.kind}`;
            });
            return { ...failBundle("invalid_schema", "invalid_schema", invalidSummary
              ? "world_delta_invalid at $.worldDelta.beatSummary: expected non-empty string"
              : structuralDetail ?? "world_delta_invalid"), rejectedDraft: parsed.value };
          }
          const proposalResult = parseNarrativeBundleProposal(normalizedRecord === null
            ? normalizedBundle
            : { ...normalizedRecord, worldDelta: parsedWorldDelta?.proposal ?? null });
          if (!proposalResult.ok) {
            const detail = proposalResult.stepKey === undefined
              ? proposalResult.reason
              : `${proposalResult.reason}（步骤 ${proposalResult.stepKey}）`;
            logger?.warn("narrative_bundle_invalid_schema", {
              code: proposalResult.code,
              reason: proposalResult.reason,
              ...(proposalResult.stepKey === undefined ? {} : { stepKey: proposalResult.stepKey }),
            });
            return { ...failBundle("invalid_schema", "invalid_schema", detail), rejectedDraft: parsed.value };
          }
          return { ok: true, kind: "decision", proposal: proposalResult.proposal };
        }
        const openingResult = parseOpeningBundleProposal(parsed.value, context.input.gameLength === "medium" ? 5 : 3);
        if (!openingResult.ok) {
          logger?.warn(`narrative_bundle_invalid_opening_schema_${openingResult.reason}`);
          return failBundle("invalid_schema", "invalid_schema", openingResult.reason);
        }
        return { ok: true, kind: "opening", proposal: openingResult.proposal };
      } catch (error) {
        logger?.error("narrative_bundle_source_error", {
          error: error instanceof Error ? error.message : "unknown",
        });
        return failBundle("unknown");
      }
    },
  };
}
