import { repairFromCandidateReview, repairFromSourceFailure, aiRepairAuditContext } from "./aiGenerationRetry";
import type { GameRepository } from "./server/persistence/gameRepository";
import type { GameId } from "./server/persistence/gameRepository";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { NarrativeRuntimeState, NarrativeSceneState } from "@/game/domain/narrative";
import type { WorldState } from "@/game/domain/worldState";
import type { NarrativeBundleSource, NarrativeBundleRepair, OpeningNarrativeBundleProposal, NarrativeBundleSourceContext, NarrativeCandidateRevision } from "./narrativeBundleSource";
import type { GameTypeId, GameLength, GameSetup, NewGameInput } from "@/game/domain/newGame";
import { validateNewGameInput } from "@/game/domain/newGame";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { parseOpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import {
  OPENING_NPC_ID,
  compileOpeningGenerationCandidate,
  resolveOpeningResponses,
  validateOpeningGenerationCandidate,
} from "@/game/gameplay/rpg/openingGeneration";
import {
  createOpeningNoveltyRecord,
  isOpeningTooSimilar,
  type OpeningNoveltyContext,
  type OpeningNoveltyRecord,
} from "@/game/domain/openingNovelty";
import { asGenerationId } from "@/game/domain/worldEntity";
import { asNarrativeJobId } from "@/game/domain/events";
import { createApprovedChoice, type ApprovedChoice } from "@/game/domain/approvedChoice";
import { TARGET_ACTS } from "@/game/domain/storyBudget";
import { AiGenerationError, type AiFailureKind } from "./aiGenerationFailure";
import { runBoundedAttempts } from "@/game/core/retry";
import { entitiesOfKind } from "@/game/domain/entity";
import { sceneExpressionsOf, type SceneExpressionProposal } from "@/game/domain/sceneExpression";
import { appendHistory, narrativeSceneHistoryEntries } from "@/game/domain/narrativeHistory";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import {
  buildNpcSpeechAuthority,
  isValidNpcSpeechTarget,
  validateNpcSpeechReferences,
} from "./npcSpeechAuthority";
import { installStoryInteractionProposals, validateNarrativeSceneExpressions } from "./approveNarrativeBundle";
import { approveStoryConsequenceBindings } from "./approveStoryConsequenceBindings";
import {
  candidateReviewMatches,
  hashNarrativeCandidate,
  type CandidateReviewResult,
  type NarrativeCandidateReviewer,
} from "./narrativeCandidateReview";
import { MAX_NARRATIVE_HTTP_ATTEMPTS } from "@/game/domain/narrativeGenerationAttempt";

// ---------------------------------------------------------------------------
// Task 2：开局生成编排改为 source → parse → validate → compile。
// OpeningGenerationSource.generate 返回 OpeningGenerationCandidate（原始字符串
// fact key，无实体 ID——ID 一律由编译器铸造）。createGame 内：schema parse →
// gameplay validate → compile 为单一 World/Story State，任何失败返回明确错误码，
// 绝不用 `as never` 透传。
// ---------------------------------------------------------------------------

export type OpeningGenerationInput = {
    gameType: GameTypeId;
    seed: string;
    gameLength: GameLength;
    /** 玩家开局配置：生成源必须消费（角色/世界观/故事开端），不得丢弃。 */
    setup?: GameSetup;
    /** 只提供近期故事指纹，AI 仍自由生成实体名称与剧情文本。 */
    novelty?: OpeningNoveltyContext;
  /** 相似度重试次数，写入生成元数据以便同一存档可复现。 */
  attempt?: number;
  /** 仅用于关联 opening AI 审计事件，不进入游戏状态。 */
  auditLink?: AiTextAuditLink;
  signal?: AbortSignal;
  reserveHttpAttempt?: () => Promise<boolean> | boolean;
};

export type OpeningGenerationSource = {
  generate(input: OpeningGenerationInput): Promise<OpeningGenerationCandidate>;
};

export type CreateGameInput = {
  readonly gameId: GameId;
  readonly gameType: GameTypeId;
  readonly gameLength: GameLength;
  readonly seed: string;
  readonly setup?: GameSetup;
  readonly replaceCurrent?: {
    readonly expectedGameId: GameId;
    readonly expectedRevision: number;
  };
};

export type CreateGameResult =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: "ACTIVE_GAME_EXISTS" | "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "GAME_NOT_ENDED" | "AI_GENERATION_FAILED" | "INFRASTRUCTURE_FAILURE"; readonly failureKind?: AiFailureKind };

// ---------------------------------------------------------------------------
// 开局配置解析：路由层不得直连 domain，统一经 application 层调用
// validateNewGameInput；提交任一配置字段时必须整体通过校验。
// ---------------------------------------------------------------------------

export type ParseGameSetupInput = {
  readonly gameType: string;
  readonly gameLength: string;
  readonly characterName?: unknown;
  readonly characterIdentity?: unknown;
  readonly characterProfile?: unknown;
  readonly personalityTags?: unknown;
  readonly worldPremise?: unknown;
  readonly storyOpening?: unknown;
  readonly narrativeStyle?: unknown;
  readonly contentIntensity?: unknown;
};

export type ParseGameSetupResult =
  | { readonly ok: true; readonly setup: GameSetup }
  | { readonly ok: false; readonly errors: readonly { readonly field: string; readonly code: string }[] };

const SETUP_FIELD_KEYS = [
  "characterName", "characterIdentity", "characterProfile", "personalityTags",
  "worldPremise", "storyOpening", "narrativeStyle", "contentIntensity",
] as const;

/** 无任一配置字段时返回 null；有则整体校验，产出 GameSetup 或字段错误列表。 */
export function parseGameSetup(raw: ParseGameSetupInput): ParseGameSetupResult | null {
  if (!SETUP_FIELD_KEYS.some((key) => raw[key] !== undefined)) return null;
  const stringOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");
  const input: NewGameInput = {
    gameType: raw.gameType as NewGameInput["gameType"],
    characterName: stringOrEmpty(raw.characterName),
    characterIdentity: stringOrEmpty(raw.characterIdentity),
    ...(typeof raw.characterProfile === "string" ? { characterProfile: raw.characterProfile } : {}),
    personalityTags: Array.isArray(raw.personalityTags) && raw.personalityTags.every((entry) => typeof entry === "string")
      ? (raw.personalityTags as string[])
      : [],
    worldPremise: stringOrEmpty(raw.worldPremise),
    storyOpening: stringOrEmpty(raw.storyOpening),
    narrativeStyle: (typeof raw.narrativeStyle === "string" ? raw.narrativeStyle : "concise") as NewGameInput["narrativeStyle"],
    contentIntensity: (typeof raw.contentIntensity === "string" ? raw.contentIntensity : "normal") as NewGameInput["contentIntensity"],
    gameLength: raw.gameLength as GameLength,
  };
  const validation = validateNewGameInput(input);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors.map((error) => ({ field: error.field, code: error.code })) };
  }
  const value = validation.value;
  return {
    ok: true,
    setup: {
      characterName: value.characterName,
      characterIdentity: value.characterIdentity,
      ...(value.characterProfile === undefined ? {} : { characterProfile: value.characterProfile }),
      personalityTags: value.personalityTags,
      worldPremise: value.worldPremise,
      storyOpening: value.storyOpening,
      narrativeStyle: value.narrativeStyle,
      contentIntensity: value.contentIntensity,
    },
  };
}

export type CreateGameDeps = {
  readonly signal?: AbortSignal;
  readonly repository: GameRepository;
  /** 开局只能通过一次 NarrativeBundleSource opening 调用生成。 */
  readonly source: NarrativeBundleSource;
  readonly now: () => string;
  /** Whether AI config is available (determines narrative.mode) */
  readonly aiEnabled?: boolean;
  /** 仅用于关联 opening AI 审计事件，不进入游戏状态。 */
  readonly auditLink?: AiTextAuditLink;
  /** Production composition injects the single semantic reviewer for openings. */
  readonly reviewer?: NarrativeCandidateReviewer;
};

const OPENING_HISTORY_LOOKBACK = 12;
const MAX_OPENING_GENERATION_ATTEMPTS = 3;

function compileOpeningNarrative(
  proposal: OpeningNarrativeBundleProposal,
  candidate: OpeningGenerationCandidate,
  jobId: ReturnType<typeof asNarrativeJobId>,
  mode: "ai" | "offline",
  candidateVersion?: number,
  candidateHash?: string,
): NarrativeRuntimeState | null {
  if (
    proposal.continuationScenes.length !== 0
    || proposal.terminal.kind !== "next_decision"
    || proposal.terminal.target.kind !== "current_scene"
  ) return null;

  const { currentScene: scene } = proposal;
  const expressions = sceneExpressionsOf(scene);
  // Keep the legacy object intact for the authority pass. Some callers use
  // array-like proxies here to prove that validation observes the original
  // reference instead of a normalized copy.
  const npcLine = scene.expressions === undefined
    ? scene.npcLine
    : expressions.find((expression): expression is Extract<SceneExpressionProposal, { readonly kind: "npc_line" }> => expression.kind === "npc_line");
  if (npcLine === undefined || npcLine === null || npcLine.npcId !== String(OPENING_NPC_ID)) return null;

  const responses = resolveOpeningResponses(candidate);
  if (responses === null) return null;
  const responseById = new Map(responses.map((response) => [response.candidateId, response.action]));
  for (const interactionProposal of proposal.interactionProposals ?? []) {
    responseById.set(`interaction:${interactionProposal.proposalKey}`, {
      type: "talk",
      npcId: OPENING_NPC_ID,
      dialogueAct: "ask",
      interactionId: `interaction:${String(jobId)}:${interactionProposal.proposalKey}`,
    });
  }
  const choiceIds = scene.choices.map((choice) => choice.candidateId);
  if (choiceIds.length !== 2 || new Set(choiceIds).size !== 2
    || choiceIds.some((candidateId) => !responseById.has(candidateId))) return null;

  if (!Array.isArray(npcLine.usedFactIds) || !Array.isArray(npcLine.usedEventIds)) return null;

  const sceneId = `scene-${String(jobId)}`;
  const choiceRegistry: ApprovedChoice[] = [];
  for (const choice of scene.choices) {
    const approved = createApprovedChoice({
      sceneId,
      basedOnRevision: 0,
      label: choice.label,
      action: responseById.get(choice.candidateId)!,
    });
    if (!approved.ok) return null;
    choiceRegistry.push(approved.choice);
  }

  const currentScene: NarrativeSceneState = {
    sceneId,
    turn: 0,
    narration: expressions
      .filter((expression) => expression.kind === "narration")
      .map((expression) => expression.text)
      .join("\n"),
    usedFactIds: npcLine.usedFactIds as never[],
    npcLine: {
      npcId: OPENING_NPC_ID,
      text: npcLine.text,
      emotion: npcLine.emotion,
      usedFactIds: npcLine.usedFactIds as never[],
      usedEventIds: [...npcLine.usedEventIds],
      answeredBeatIds: [...npcLine.answeredBeatIds],
    },
    choices: choiceRegistry.map((choice) => ({
      choiceToken: choice.choiceToken,
      label: choice.label,
    })),
    source: "generated",
    event: { kind: "dialogue", focusNpcId: OPENING_NPC_ID },
    ...(scene.expressions === undefined ? {} : {
      expressions: expressions.map((expression) => expression.kind === "narration"
        ? {
            kind: "narration" as const,
            beatId: expression.beatId,
            text: expression.text,
            referencedEntityIds: expression.referencedEntityIds.map((id) => id as never),
          }
        : {
            kind: "npc_line" as const,
            npcId: expression.npcId as never,
            audienceIds: expression.audienceIds.map((id) => id as never),
            text: expression.text,
            emotion: expression.emotion,
            answeredBeatIds: [...expression.answeredBeatIds],
            usedFactIds: expression.usedFactIds.map((id) => id as never),
            usedEventIds: expression.usedEventIds.map((id) => id as never),
          }),
    }),
  };

  return {
    status: "ready",
    mode,
    currentScene,
    choiceRegistry,
    narrativeBundle: {
      contractVersion: 2,
      originJobId: jobId,
      ...(candidateVersion === undefined || candidateHash === undefined
        ? {}
        : { candidateVersion, candidateHash }),
      steps: [],
      activeStepIds: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    },
  };
}

function approveOpeningSpeech(
  narrative: NarrativeRuntimeState,
  worldState: WorldState,
): boolean {
  if (narrative.status !== "ready" || narrative.currentScene.npcLine === null) return false;
  if (narrative.currentScene.expressions !== undefined
    && validateNarrativeSceneExpressions(narrative.currentScene.expressions, worldState) !== null) {
    return false;
  }
  if (!isValidNpcSpeechTarget(worldState.entityStore, PLAYER_ENTITY_ID)) return false;
  const visibleFactIds = entitiesOfKind(worldState.entityStore, "fact")
    .filter((fact) => fact.fact.discovered)
    .map((fact) => fact.core.id);
  const authority = buildNpcSpeechAuthority({
    store: worldState.entityStore,
    speakerNpcId: narrative.currentScene.npcLine.npcId,
    sceneVisibleFactIds: visibleFactIds,
    eventLedger: worldState.eventLedger,
    targetContext: { targetId: PLAYER_ENTITY_ID },
  });
  if (authority === null) return false;
  return validateNpcSpeechReferences({
    authority,
    usedFactIds: narrative.currentScene.npcLine.usedFactIds,
    usedEventIds: narrative.currentScene.npcLine.usedEventIds,
    eventLedger: worldState.eventLedger,
    speakerNpcId: narrative.currentScene.npcLine.npcId,
  }).ok;
}

export async function createGame(
  input: CreateGameInput,
  deps: CreateGameDeps,
): Promise<CreateGameResult> {
  if (input.replaceCurrent !== undefined) {
    const current = await deps.repository.getCurrentGame();
    if (!current.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    if (current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME" };
    if (
      current.record.gameId !== input.replaceCurrent.expectedGameId
      || current.record.revision !== input.replaceCurrent.expectedRevision
    ) {
      return { ok: false, code: "STALE_GAME_REVISION" };
    }
    if (current.record.worldState.ending === null) {
      return { ok: false, code: "GAME_NOT_ENDED" };
    }
  }

  const historyResult = deps.repository.listOpeningHistory === undefined
    ? { ok: true as const, records: [] as readonly OpeningNoveltyRecord[] }
    : await deps.repository.listOpeningHistory({ gameType: input.gameType, limit: OPENING_HISTORY_LOOKBACK });
  if (!historyResult.ok) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };

  const recentHistory = [...historyResult.records];
  const rejectedCandidates: OpeningNoveltyRecord[] = [];
  let lastFailureKind: AiFailureKind | undefined;
  let openingHttpAttempts = 0;
  let candidateRevision: NarrativeCandidateRevision | undefined;
  const revisionFindings: NarrativeBundleRepair[] = [];
  const openingRequestController = new AbortController();
  const openingSignal = deps.signal === undefined ? openingRequestController.signal : AbortSignal.any([openingRequestController.signal, deps.signal]);
  // The logical initialization job exists before the first provider attempt so
  // novelty/content/transport retries share the same audit identity.
  const jobId = asNarrativeJobId(`job_${input.seed}_0`);
  const bounded = await runBoundedAttempts<
    {
      readonly candidate: OpeningGenerationCandidate;
      readonly narrative: NarrativeRuntimeState;
      readonly novelty: OpeningNoveltyRecord;
      readonly attempt: number;
      readonly worldState: ReturnType<typeof compileOpeningGenerationCandidate>["worldState"];
      readonly storyState: ReturnType<typeof compileOpeningGenerationCandidate>["storyState"];
    },
    NarrativeBundleRepair
  >({
    maxAttempts: MAX_OPENING_GENERATION_ATTEMPTS,
    runAttempt: async (attempt, priorRepair) => {
      if (priorRepair !== undefined) revisionFindings.push(priorRepair);
      const openingAttempt = attempt - 1;
      const contentRepair = priorRepair === undefined ? undefined : { ...priorRepair, attempt: openingAttempt };
      const candidateVersion = attempt;
      const openingContext: Extract<NarrativeBundleSourceContext, { readonly kind: "opening" }> = {
        kind: "opening" as const,
        jobId,
        signal: openingSignal,
        candidateVersion,
        ...(candidateRevision === undefined ? {} : { candidateRevision: { ...candidateRevision, findings: [...revisionFindings] } }),
        ...(contentRepair === undefined ? {} : { contentRepair }),
        input: {
          gameType: input.gameType,
          seed: input.seed,
          gameLength: input.gameLength,
          ...(input.setup === undefined ? {} : { setup: input.setup }),
          novelty: {
            recent: [...recentHistory, ...rejectedCandidates],
            attempt: openingAttempt,
          },
          attempt: openingAttempt,
          ...(deps.auditLink === undefined ? {} : {
            auditLink: {
              ...deps.auditLink,
              gameId: String(input.gameId),
              jobId: String(jobId),
            },
          }),
        },
        auditLink: {
          ...(deps.auditLink ?? {}),
          gameId: String(input.gameId),
          jobId: String(jobId),
          turnNumber: 0,
          retry: contentRepair === undefined ? { origin: "normal", mechanism: "initial", attempt: 0 } : aiRepairAuditContext(contentRepair, deps.auditLink?.retry),
        },
        reserveHttpAttempt: () => {
          if (openingHttpAttempts >= MAX_NARRATIVE_HTTP_ATTEMPTS) return false;
          openingHttpAttempts += 1;
          return true;
        },
      };
      let generated: OpeningGenerationCandidate;
      let generatedProposal: OpeningNarrativeBundleProposal;
      try {
        const result = await deps.source.generate(openingContext);
        if (result == null) {
          lastFailureKind = "AI_RESPONSE_INVALID";
          return { ok: false, retryable: true, reason: { attempt, reason: "invalid_schema", detail: "invalid_source_result" } };
        }
        if (!result.ok || result.kind !== "opening") {
          lastFailureKind = result.ok ? "AI_RESPONSE_INVALID" : result.failure.kind;
          return { ok: false, retryable: true, reason: result.ok
            ? { attempt, reason: "invalid_schema", detail: "unexpected_source_kind" }
            : repairFromSourceFailure(result, attempt) };
        }
        generated = result.proposal.opening;
        generatedProposal = result.proposal;
        candidateRevision = { candidateVersion, candidateHash: hashNarrativeCandidate(result.proposal), proposal: result.proposal, findings: [...revisionFindings] };
      } catch (error) {
        lastFailureKind = error instanceof AiGenerationError ? error.kind : "AI_CALL_FAILED";
        return { ok: false, retryable: true, reason: repairFromSourceFailure({
          ok: false, failure: { kind: lastFailureKind, phase: "opening" }, repairDetail: "source_exception",
        }, attempt) };
      }
      if (!generated) return { ok: false, retryable: true, reason: { attempt, reason: "invalid_schema", detail: "empty_candidate" } };

      lastFailureKind = "AI_RESPONSE_INVALID";
      const parsed = parseOpeningGenerationCandidate(generated);
      if (!parsed.ok) return { ok: false, retryable: true, reason: { attempt, reason: "invalid_schema", detail: parsed.code } };
      const validated = validateOpeningGenerationCandidate(parsed.value, { gameLength: input.gameLength, targetActs: TARGET_ACTS[input.gameLength] });
      if (!validated.ok) return { ok: false, retryable: true, reason: { attempt, reason: "approval_rejected", detail: validated.issues.map((issue) => issue.code).join("|") } };
      const candidate = validated.validated;

      // Compile this exact candidate into an in-memory preview before any
      // novelty decision. The preview is the state that will be persisted.
      const narrative = compileOpeningNarrative(
        generatedProposal,
        candidate,
        jobId,
        deps.aiEnabled === false ? "offline" : "ai",
        candidateVersion,
        hashNarrativeCandidate(generatedProposal),
      );
      if (narrative === null) return { ok: false, retryable: true, reason: { attempt, reason: "invalid_schema", detail: "opening_scene_invalid" } };
      const generation = {
        generationId: asGenerationId(`gen_${input.seed}`),
        seed: input.seed,
        templateVersion: "v2" as const,
        inputDigest: "",
        gameType: input.gameType,
        ...(input.setup === undefined ? {} : { setup: input.setup }),
        ...(openingAttempt === 0 ? {} : { openingAttempt }),
      };
      const preview = compileOpeningGenerationCandidate({
        candidate,
        generation,
        gameLength: input.gameLength,
        initialNarrative: narrative,
      });
      const openingSymbols = new Map<string, string>([
        ["@new.location", "loc_0"],
        ["@new.npc", String(OPENING_NPC_ID)],
        ["@new.quest", "quest_0"],
        ...(preview.worldState.items[0] === undefined ? [] : [["@new.item", String(preview.worldState.items[0].id)] as const]),
      ]);
      for (const [index, fact] of candidate.world.publicFacts.entries()) {
        openingSymbols.set(fact.key, `fact_${index}`);
      }
      const consequenceBindings = approveStoryConsequenceBindings({
        proposal: candidate.opening.consequenceBindings ?? [],
        worldState: preview.worldState,
        storyState: preview.storyState,
        symbols: openingSymbols,
      });
      if (!consequenceBindings.ok) {
        return { ok: false, retryable: true, reason: { attempt, reason: "approval_rejected", detail: `${consequenceBindings.code}:${consequenceBindings.path}` } };
      }
      const installed = installStoryInteractionProposals({
        worldState: consequenceBindings.worldState,
        proposals: generatedProposal.interactionProposals ?? [],
        jobId,
        focusNpcId: String(OPENING_NPC_ID),
      });
      if (!installed.ok) {
        return { ok: false, retryable: true, reason: { attempt, reason: "approval_rejected", detail: installed.detail } };
      }
      if (!approveOpeningSpeech(narrative, installed.worldState)) {
        return { ok: false, retryable: true, reason: { attempt, reason: "approval_rejected", detail: "opening_speech_rejected" } };
      }

      if (deps.reviewer !== undefined) {
        const candidateHash = hashNarrativeCandidate(generatedProposal);
        let review: CandidateReviewResult;
        try {
          review = await deps.reviewer.reviewNarrativeCandidate({
            context: openingContext,
            proposal: generatedProposal,
            candidateVersion,
            candidateHash,
          });
        } catch {
          review = { ok: false, candidateVersion, candidateHash, failure: "PROVIDER_FAILURE" };
        }
        if (!review.ok) {
          if ("defects" in review) {
            if (review.defects.length === 0
              || review.defects.some((defect) => !candidateReviewMatches(defect, candidateVersion, candidateHash))) {
              lastFailureKind = "AI_RESPONSE_INVALID";
              return { ok: false, retryable: false, reason: { attempt, reason: "invalid_schema", detail: "candidate_review_invalid" } };
            }
            lastFailureKind = "AI_RESPONSE_INVALID";
            return { ok: false, retryable: true, reason: repairFromCandidateReview(review.defects, attempt) };
          }
          lastFailureKind = review.failure === "PROVIDER_FAILURE" ? "AI_CALL_FAILED" : "AI_RESPONSE_INVALID";
          return {
            ok: false,
            retryable: false,
            reason: {
              attempt,
              reason: review.failure === "PROVIDER_FAILURE" ? "provider_failure" : "invalid_schema",
              detail: review.failure === "PROVIDER_FAILURE" ? "candidate_review_provider_failure" : "candidate_review_uncertain",
            },
          };
        }
        if (!candidateReviewMatches(review, candidateVersion, candidateHash)) {
          lastFailureKind = "AI_RESPONSE_INVALID";
          return { ok: false, retryable: false, reason: { attempt, reason: "invalid_schema", detail: "candidate_review_invalid" } };
        }
      }

      const comparableHistory = [...recentHistory, ...rejectedCandidates];
      const novelty = createOpeningNoveltyRecord({
        candidate,
        gameType: input.gameType,
        createdAt: deps.now(),
      });
      if (isOpeningTooSimilar(novelty, comparableHistory)) {
        rejectedCandidates.push(novelty);
        return { ok: false, retryable: true, reason: { attempt, reason: "approval_rejected", detail: "novelty_conflict" } };
      }
      return {
        ok: true,
        value: {
          candidate,
          narrative,
          novelty,
          attempt: openingAttempt,
          worldState: installed.worldState,
          storyState: consequenceBindings.storyState,
        },
      };
    },
  });

  // API 可能在三次请求中仍返回同一结构。不能把最后一个重复候选
  // 当作成功；全部候选失败后直接返回 AI_GENERATION_FAILED。
  if (!bounded.ok) return {
    ok: false,
    code: "AI_GENERATION_FAILED",
    failureKind: lastFailureKind ?? "AI_RESPONSE_INVALID",
  };
  const accepted = bounded.value;

  // Opening text and its visible choices are already published at revision 0.
  // Seed History from that exact scene; no player action is manufactured for
  // initialization and no future bundle content is included.
  const openingStoryState = accepted.storyState.narrative.status !== "ready"
    ? accepted.storyState
    : {
        ...accepted.storyState,
        history: appendHistory(
          accepted.storyState.history ?? { entries: [] },
          narrativeSceneHistoryEntries({
            history: accepted.storyState.history ?? { entries: [] },
            scene: accepted.storyState.narrative.currentScene,
            actionId: null,
            jobId,
            revision: 0,
            turnNumber: accepted.storyState.turnNumber,
            eventIds: accepted.worldState.eventLedger.map((event) => event.eventId),
          }),
        ),
      };

  const persistedInput = {
    gameId: input.gameId,
    worldState: accepted.worldState,
    storyState: openingStoryState,
    createdAt: deps.now(),
    openingHistory: accepted.novelty,
  };
  if (openingSignal.aborted) return { ok: false, code: "AI_GENERATION_FAILED", failureKind: "AI_CALL_FAILED" };
  const createResult = input.replaceCurrent === undefined
    ? await deps.repository.createInitialGame(persistedInput)
    : await deps.repository.replaceCurrentGame({
        ...persistedInput,
        expectedCurrentGameId: input.replaceCurrent.expectedGameId,
        expectedRevision: input.replaceCurrent.expectedRevision,
      });

  if (!createResult.ok) return createResult;
  return { ok: true, revision: 0 };
}

// ---------------------------------------------------------------------------
// 确定性开局切片 fixture：只返回故事契约 + 开场切片（一个地点/NPC/任务），
// 不生成任何未来命名实体。同 seed+gameType+attempt 完全可重放；玩家配置为权威输入。
// ---------------------------------------------------------------------------

export function createFixtureOpeningCandidateSource(): OpeningGenerationSource {
  return {
    async generate(input) {
      const profiles = {
        wuxia: {
          genre: "武侠", tone: "江湖沧桑", identity: "流浪剑客",
          towns: ["青石镇", "临江镇", "雁回镇", "白沙镇"],
          venues: ["听雨客栈", "归舟茶肆", "长亭酒坊", "照影驿馆"],
          contacts: ["沈掌柜", "顾账房", "陆驿丞", "叶药师"],
          routes: ["青石古道", "芦苇渡口", "断桥驿道", "药王山径"],
          lairs: ["黑风寨", "沉钟水寨", "赤焰山庄", "寒鸦别院"],
          clues: ["残月密函", "潮痕账册", "焦边路引", "药香手札"],
          relics: ["盟誓印谱", "私盐航图", "劫镖名录", "禁药方笺"],
          bosses: ["黑风寨主", "沉钟舵主", "赤焰庄主", "寒鸦院主"],
        },
        xianxia: {
          genre: "仙侠", tone: "缥缈玄奇", identity: "寻道散修",
          towns: ["云岫镇", "栖霞集", "落星渡", "玄砂城"],
          venues: ["问月驿", "栖霞丹坊", "听潮道舍", "归鹤观"],
          contacts: ["闻鹤道人", "素月丹师", "青檀执事", "玄砂客"],
          routes: ["流云栈道", "星落古径", "悬灯天桥", "归墟石阶"],
          lairs: ["噬月魔窟", "烬仙遗宫", "无相天牢", "血莲洞天"],
          clues: ["裂纹玉简", "逆火丹书", "青帝残碑", "归墟星盘"],
          relics: ["镇魔真诀", "九转炉谱", "万木灵契", "星河阵图"],
          bosses: ["噬月魔君", "烬仙尊者", "无相妖王", "血莲圣使"],
        },
        fantasy: {
          genre: "奇幻", tone: "史诗幽邃", identity: "边境佣兵",
          towns: ["灰杉镇", "铜铃谷", "晨星集", "河湾城"],
          venues: ["星火旅店", "鹿角酒馆", "旧王冠驿站", "银叶工坊"],
          contacts: ["艾琳店主", "矮人账官", "白塔信使", "鹿角药师"],
          routes: ["银松大道", "雾沼木桥", "狮鹫山径", "荆棘古路"],
          lairs: ["黑龙巢穴", "深潮王庭", "灰烬要塞", "猩红高塔"],
          clues: ["断翼纹章", "潮汐契据", "烧焦谕令", "荆棘王冠"],
          relics: ["龙语盟约", "海王航志", "王室族谱", "精灵誓书"],
          bosses: ["黑翼领主", "深潮公爵", "灰烬骑士", "猩红女巫"],
        },
        science_fiction: {
          genre: "科幻", tone: "冷峻未知", identity: "自由领航员",
          towns: ["远港环城", "曙光栖地", "赫利俄斯站", "蓝湾殖民地"],
          venues: ["远港中继站", "零重力酒吧", "轨道修造坞", "蓝湾联络舱"],
          contacts: ["林站长", "奎因技师", "赫兹领航员", "伊芙研究员"],
          routes: ["蓝移航道", "碎星走廊", "静默轨道", "日冕捷径"],
          lairs: ["熵增母舰", "深空采掘城", "奇点实验站", "红矮星堡垒"],
          clues: ["损坏黑匣", "加密矿权证", "折叠坐标", "日冕观测谱"],
          relics: ["跃迁密钥", "自治协议", "先驱者星图", "聚变控制核"],
          bosses: ["熵核指挥官", "采掘城总督", "奇点主脑", "红星执政官"],
        },
        urban: {
          genre: "都市", tone: "现实悬疑", identity: "独立调查员",
          towns: ["临江城区", "南栅街区", "栖霞新城", "白榆片区"],
          venues: ["夜班便利店", "旧报社接待室", "南站咖啡馆", "临江修车铺"],
          contacts: ["周店长", "许记者", "陈调度", "苏医生"],
          routes: ["临江旧街", "地铁末班线", "高架辅路", "城南医院道"],
          lairs: ["湾区烂尾楼", "地下控制室", "城郊物流园", "私立研究院"],
          clues: ["匿名录音", "删改采访稿", "异常调度单", "缺页病历"],
          relics: ["产权转移清单", "加密采访带", "车辆轨迹盘", "临床试验名册"],
          bosses: ["幕后董事", "黑网管理员", "物流园主", "研究院院长"],
        },
        alternate_history: {
          genre: "历史架空", tone: "庙堂暗涌", identity: "边郡游侠",
          towns: ["雁门镇", "河西城", "临漕县", "北岭关城"],
          venues: ["长安驿馆", "河西茶楼", "漕渠脚店", "北岭马行"],
          contacts: ["裴驿丞", "崔司书", "霍校尉", "谢医官"],
          routes: ["河西官道", "漕渠古渡", "北岭驿路", "盐铁栈道"],
          lairs: ["朔方王帐", "东厂水牢", "玄甲行宫", "盐铁私府"],
          clues: ["伪造节钺", "漕银底账", "调兵虎符", "御药密录"],
          relics: ["盟国国书", "河运密图", "边军花名册", "宫禁药案"],
          bosses: ["朔方摄政王", "缇骑提督", "玄甲大将军", "盐铁使"],
        },
        post_apocalypse: {
          genre: "末日", tone: "荒凉坚韧", identity: "废土行者",
          towns: ["灰烬营地", "北风聚落", "旧铁路站", "盐碱避难区"],
          venues: ["灰烬营地指挥棚", "北风修理站", "铁轨补给点", "盐碱诊疗所"],
          contacts: ["罗塔守望者", "米娅修理师", "老秦向导", "岚医生"],
          routes: ["辐尘公路", "干涸河床", "倾覆铁路线", "菌林边界"],
          lairs: ["熔炉要塞", "沉没避难所", "钢铁列车城", "菌群母巢"],
          clues: ["褪色通行证", "气象记录芯片", "军列货单", "污染样本盒"],
          relics: ["净水核心图", "避难所日志", "聚变机车钥匙", "免疫种子谱"],
          bosses: ["熔炉霸主", "避难所监理", "铁轨军阀", "菌巢意识"],
        },
      } as const;

      const attempt = input.attempt ?? 0;
      const historySalt = input.novelty?.recent.map((record) => record.fingerprint).join("|") ?? "";
      const fixtureSeed = attempt === 0 && historySalt === ""
        ? input.seed
        : `${input.seed}#opening-attempt-${attempt}#history-${historySalt}`;
      let hash = 2166136261;
      for (const char of `${input.gameType}:${fixtureSeed}`) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      const genreProfile = profiles[input.gameType];
      const pick = <T,>(values: readonly T[], shift: number): T => values[(hash >>> shift) % values.length]!;
      const variant = {
        town: pick(genreProfile.towns, 0),
        venue: pick(genreProfile.venues, 3),
        npc: pick(genreProfile.contacts, 6),
        route: pick(genreProfile.routes, 9),
        lair: pick(genreProfile.lairs, 12),
        clue: pick(genreProfile.clues, 15),
        relic: pick(genreProfile.relics, 18),
        boss: pick(genreProfile.bosses, 21),
      };
      const variationProfile = {
        sceneFrame: pick(["street", "market", "inn", "outskirts", "station", "workshop", "shrine", "other"] as const, 24),
        npcArchetype: pick(["witness", "keeper", "courier", "merchant", "official", "craftsperson", "guide", "other"] as const, 26),
        leadType: pick(["trace", "document", "testimony", "token", "message", "object", "other"] as const, 28),
        conflictMode: pick(["concealment", "misdirection", "dispute", "pursuit", "betrayal", "other"] as const, 30),
      } as const;

      const setup = input.setup;
      return {
        world: {
          summary: `一场从${variant.town}的${variant.venue}延伸到${variant.lair}的${genreProfile.genre}追索。`,
          tone: genreProfile.tone,
          themes: ["探索", "抉择"],
          publicFacts: [
            { key: "fact_inn", text: `${variant.npc}守着${variant.route}的消息。` },
            { key: "fact_pact", text: `${variant.clue}与${variant.relic}共同指向${variant.boss}的隐秘计划。` },
          ],
        },
        player: {
          name: setup?.characterName ?? "无名旅者",
          identity: setup?.characterIdentity ?? genreProfile.identity,
          backgroundSummary: setup?.characterProfile ?? `为追寻一段被掩埋的${genreProfile.genre}真相独自上路。`,
          baseStats: { hp: 100, attack: 10, defense: 5 },
        },
        prologue: `你在${variant.town}的${variant.venue}醒来，${variant.route}方向传来异动。`,
        storyContract: {
          version: 1,
          targetActs: input.gameLength === "short" ? 3 : 5,
          centralConflict: `旧案背后的${variant.boss}正在瓦解${genreProfile.genre}世界的秩序。`,
          endingDirections: [
            { key: "trust", theme: `与${variant.npc}共同承担真相` },
            { key: "doubt", theme: "独自揭露真相" },
          ],
        },
        opening: {
          location: {
            name: variant.town,
            description: `一座临近${variant.route}、以${variant.venue}为落脚点的城镇。`,
            buildingName: variant.venue,
            scale: "town",
          },
          npc: {
            name: variant.npc,
            role: "关键线人",
            description: `掌握${variant.route}沿途消息的知情人。`,
            knownFactKeys: ["fact_inn"], privateFactKeys: ["fact_pact"],
            anchors: {
              selfConcept: `守护${variant.town}线索的知情人`,
              values: ["守诺"],
              speechStyle: "谨慎简短",
              capabilityBoundaries: [`只提供${variant.route}的亲见消息`],
              taboos: ["不出卖无辜者"],
            },
            goals: [{ horizon: "short", description: `查明${variant.boss}的动向`, priority: 4, reason: `${variant.venue}的${variant.clue}线索正在消失` }],
          },
          quest: {
            name: `取得${variant.npc}的信任`,
            description: "从关键线人口中确认追索方向。",
            objective: { kind: "talk_to_opening_npc" },
          },
          situation: {
            history: [],
            threads: [{ key: "lead", questionFactKey: "fact_inn", supportingFactKeys: ["fact_pact"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] }],
            npcConnection: { familiarity: "stranger", stance: "neutral", basisHistoryKeys: [] },
            responses: [
              { key: "ask_lead", dialogueAct: "ask", topic: { kind: "fact", key: "fact_inn" } },
              { key: "challenge_lead", dialogueAct: "challenge", topic: { kind: "thread", key: "lead" } },
            ],
          },
          variationProfile,
          firstScene: {
            narration: `${variant.venue}内光线昏暗，${variant.npc}见你走进来，放下手中的活计。`,
            npcLine: {
              text: `${variant.town}近来不太平。你要是来得巧，正好帮我看看这${variant.clue}的来路。`,
              emotion: "guarded" as const,
              usedFactKeys: ["fact_inn"],
            },
            choices: [
              { candidateId: "ask_lead", label: "把你知道的线索先告诉我。" },
              { candidateId: "challenge_lead", label: "你先说清楚你自己跟这事有什么关系。" },
            ],
          },
        },
      };
    },
  };
}

/**
 * Explicit offline adapter for complete initialization bundles. It is the
 * fixture counterpart of the production NarrativeBundleSource: one opening
 * request returns both the opening world slice and the first formal decision.
 */
export function createFixtureOpeningSource(): NarrativeBundleSource {
  const candidateSource = createFixtureOpeningCandidateSource();
  return {
    async generate(context) {
      if (context.kind !== "opening") {
        return {
          ok: false,
          failure: { kind: "AI_CALL_FAILED", phase: "scene" },
        };
      }

      const opening = await candidateSource.generate(context.input);
      const firstScene = opening.opening.firstScene;
      if (firstScene === undefined) {
        return {
          ok: false,
          failure: { kind: "AI_RESPONSE_INVALID", phase: "scene" },
        };
      }

      const factIdForKey = new Map(opening.world.publicFacts.map((fact, index) => [fact.key, `fact_${index}`]));
      const usedFactIds = firstScene.npcLine.usedFactKeys
        .map((key) => factIdForKey.get(key))
        .filter((factId): factId is string => factId !== undefined);

      return {
        ok: true,
        kind: "opening",
        proposal: {
          opening,
          currentScene: {
            segments: [{ beatId: "opening", text: firstScene.narration }],
            npcLine: {
              npcId: String(OPENING_NPC_ID),
              text: firstScene.npcLine.text,
              emotion: firstScene.npcLine.emotion,
              usedFactIds,
              answeredBeatIds: [],
              usedEventIds: [],
            },
            objectiveLink: null,
            choices: firstScene.choices,
          },
          continuationScenes: [],
          terminal: { kind: "next_decision", target: { kind: "current_scene" } },
        },
      };
    },
  };
}
