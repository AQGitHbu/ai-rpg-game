import type { AiMessage } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import type { AiGenerationFailure } from "@/game/domain/narrativeGenerationFailure";
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
import type { ProviderJsonMode } from "./providerRequestOptions";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";
import type { OpeningNarrativeBundleProposal } from "../../narrativeBundleSource";
import { compileDecisionNarrativeContext } from "./narrativeContext";
import { parseWorldDeltaProposal } from "./liveWorldEvolutionSource";
import { hasOnlyKnownOpeningCandidateKeys } from "./openingGenerationSource";

// ---------------------------------------------------------------------------
// Task 5：统一叙事生成包 live source。
// 一次 generate 调用 = 一次 aiClient.complete("narrative_bundle", ...) 调用。
// 只做 JSON 解析和提案校验，不做审批/铸造 ID/写状态。
// ---------------------------------------------------------------------------

export type LiveNarrativeBundleSourceDeps = {
  readonly aiClient?: RpgAiClient;
  readonly logger?: GameLogger;
  readonly jsonMode?: ProviderJsonMode;
};

function failBundle(
  category: Parameters<typeof classifyAiFailure>[0]["category"],
  repairReason?: NarrativeBundleRepairReason,
  repairDetail?: string,
): Extract<NarrativeBundleSourceResult, { readonly ok: false }> {
  const failure: AiGenerationFailure = classifyAiFailure({ phase: "scene", category });
  return {
    ok: false,
    failure,
    ...(repairReason === undefined ? {} : { repairReason }),
    ...(repairDetail === undefined ? {} : { repairDetail }),
  };
}

function buildOpeningPrompt(context: Extract<NarrativeBundleSourceContext, { readonly kind: "opening" }>): string {
  const { input } = context;
  const setup = input.setup;
  const targetActs = input.gameLength === "medium" ? 5 : 3;
  return `你是 RPG 的叙事 AI。一次调用必须生成开局世界切片与第一处正式剧情二选一，不能要求后续生成调用。

# 开局输入
- 题材：${input.gameType}
- 长度：${input.gameLength}
- 玩家名：${setup?.characterName ?? "由你生成"}
- 玩家身份：${setup?.characterIdentity ?? "由你生成"}
- 世界前提：${setup?.worldPremise ?? "由你生成"}
- 故事开端：${setup?.storyOpening ?? "由你生成"}

# 输出要求
返回一个 JSON 对象，顶层必须只有 opening、currentScene、continuationScenes、terminal。
- opening 必须是下方字段名完全一致的 OpeningGenerationCandidate；不得使用 world.name、fact.id、player.background、storyContract.goal、opening.task 等替代字段。任何未列出的字段均不会被读取。
- currentScene 是第一处正式决策：npcLine.npcId 必须为 "npc_0"，npcLine.usedFactIds 只能引用 opening.world.publicFacts 的顺序 ID（fact_0、fact_1……）；含恰好两个 choices，candidateId 必须与 opening.opening.situation.responses 的两个 key 一一对应。
- continuationScenes 必须为 []。
- terminal 必须为 {"kind":"next_decision","target":{"kind":"current_scene"}}。
- 所有玩家可见文本必须为中文。

# opening 的严格结构
- world.summary、world.tone 是字符串，world.themes 是字符串数组；world.publicFacts 每项必须是 {"key":"fact_xxx","text":"..."}。
- player 必须是 {"name":"...","identity":"...","backgroundSummary":"...","baseStats":{"hp":100,"attack":10,"defense":5}}。姓名与身份必须保留开局输入。
- storyContract 必须是 {"version":1,"targetActs":${targetActs},"centralConflict":"...","endingDirections":[{"key":"trust","theme":"..."},{"key":"doubt","theme":"..."}]}。
- opening.location 必须有 name、description、buildingName 和固定 scale:"town"。
- opening.npc 必须有 name、role、description、knownFactKeys、privateFactKeys、anchors、goals；两个 factKeys 数组只能引用 world.publicFacts 的 key。anchors 必须包含 selfConcept、values、speechStyle、capabilityBoundaries、taboos 五个字段；goals 必须是至少一条的 typed creation proposals，每项只能包含 horizon、description、priority、reason。goalId/status 由服务端生成，禁止输出。
- opening.quest 必须有 name、description 和固定 objective:{"kind":"talk_to_opening_npc"}。
- opening.situation 必须给出 history、threads、npcConnection 和恰好两个 responses；response 只提交 key、八种 dialogueAct 之一以及 fact/thread 局部 key topic，不能提交 Action 或服务端 ID。

# JSON 轮廓
\`\`\`json
{
  "opening": {
    "world": { "summary": "...", "tone": "...", "themes": ["..."], "publicFacts": [{ "key": "fact_0", "text": "..." }] },
    "player": { "name": "${setup?.characterName ?? "..."}", "identity": "${setup?.characterIdentity ?? "..."}", "backgroundSummary": "...", "baseStats": { "hp": 100, "attack": 10, "defense": 5 } },
    "prologue": "...",
    "storyContract": { "version": 1, "targetActs": ${targetActs}, "centralConflict": "...", "endingDirections": [{ "key": "trust", "theme": "..." }, { "key": "doubt", "theme": "..." }] },
    "opening": {
      "location": { "name": "...", "description": "...", "buildingName": "...", "scale": "town" },
      "npc": {
        "name": "...", "role": "...", "description": "...", "knownFactKeys": ["fact_0"], "privateFactKeys": [],
        "anchors": { "selfConcept": "...", "values": ["..."], "speechStyle": "...", "capabilityBoundaries": ["..."], "taboos": [] },
        "goals": [{ "horizon": "short", "description": "...", "priority": 3, "reason": "..." }]
      },
      "quest": { "name": "...", "description": "...", "objective": { "kind": "talk_to_opening_npc" } },
      "situation": { "history": [], "threads": [{ "key": "current_question", "questionFactKey": "fact_0", "supportingFactKeys": [], "participantRefs": ["player", "opening_npc"], "causeHistoryKeys": [] }], "npcConnection": { "familiarity": "stranger", "stance": "neutral", "basisHistoryKeys": [] }, "responses": [{ "key": "ask_question", "dialogueAct": "ask", "topic": { "kind": "fact", "key": "fact_0" } }, { "key": "refuse_question", "dialogueAct": "refuse", "topic": { "kind": "thread", "key": "current_question" } }] }
    }
  },
  "currentScene": {
    "segments": [{ "beatId": "opening", "text": "..." }],
    "npcLine": { "npcId": "npc_0", "text": "...", "emotion": "guarded", "answeredBeatIds": [], "usedFactIds": [], "usedEventIds": [] },
    "objectiveLink": null,
    "choices": [{ "candidateId": "ask_question", "label": "..." }, { "candidateId": "refuse_question", "label": "..." }]
  },
  "continuationScenes": [],
  "terminal": { "kind": "next_decision", "target": { "kind": "current_scene" } }
}
\`\`\``;
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
  const isEndingBundle = storyState.evolution.status === "needs_ending_pair";
  const steps = projectedSteps(graph, nextActProjection);
  const fallbackNpcId = nextActProjection?.npcId ?? String(job.focusNpcId ?? "");

  const normalizeChoices = (
    sourceChoices: unknown,
    candidates: readonly { readonly candidateId: string }[],
  ): unknown => (Array.isArray(sourceChoices) ? sourceChoices : []).map((choice, index) => {
    const entry = asRecord(choice);
    const candidate = candidates[index];
    return entry === null ? choice : {
      candidateId: candidate?.candidateId ?? entry.candidateId,
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
  const allowedResponseKeys = new Set(["opening", "currentScene", "continuationScenes", "terminal"]);
  if (Object.keys(response).some((key) => !allowedResponseKeys.has(key))) return { ok: false, reason: "unknown_keys" };
  if (!hasOnlyKnownOpeningCandidateKeys(response.opening)) return { ok: false, reason: "opening_unknown_keys" };
  const raw = normalizeOpeningCandidateShape(value, targetActs) as Record<string, unknown>;
  const opening = parseOpeningGenerationCandidate(raw.opening);
  if (!opening.ok) return { ok: false, reason: `opening_${opening.code}` };
  const narrative = parseNarrativeBundleProposal({
    worldDelta: null,
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
  return {
    ok: true,
    proposal: {
      opening: opening.value,
      currentScene: narrative.proposal.currentScene,
      continuationScenes: [],
      terminal: { kind: "next_decision", target: { kind: "current_scene" } },
    },
  };
}

export function createNarrativeBundleSource(
  deps: LiveNarrativeBundleSourceDeps = {},
): NarrativeBundleSource {
  const { logger, aiClient } = deps;

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
            })
          : undefined;
        const prompt = decisionCompilation?.prompt ?? buildOpeningPrompt(
          context as Extract<NarrativeBundleSourceContext, { readonly kind: "opening" }>,
        );

        const messages: readonly AiMessage[] = [
          { role: "system", content: prompt },
          { role: "user", content: context.kind === "decision" ? "生成决策叙事包" : "生成初始化叙事包" },
        ];

        const result = await aiClient.complete(
          "narrative_bundle",
          messages,
          {
            ...(context.auditLink ?? {}),
            purpose: "narrative_bundle_generation",
            trigger: context.kind === "decision"
              ? context.job.utterance === undefined ? "narrative_choice" : "npc_free_text"
              : "initialization",
            jobId: context.kind === "decision" ? String(context.job.jobId) : String(context.jobId),
            turnNumber: context.kind === "decision" ? context.job.turnNumber : 0,
            action: context.kind === "decision" ? context.job.actionSummary : undefined,
            ...(decisionCompilation === undefined
              ? {}
              : { narrativeContext: decisionCompilation.manifest }),
          },
        );

        if (!result.ok) {
          logger?.warn("narrative_bundle_ai_failed", { code: result.code });
          const category = transportFailureCodeToCategory(result.code);
          return result.code === "empty_response"
            ? failBundle(category, "invalid_json")
            : failBundle(category);
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
          const normalizedBundle = normalizeDecisionBundleShape(
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
            return failBundle("invalid_schema", "invalid_schema", "world_delta_invalid");
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
            return failBundle("invalid_schema", "invalid_schema", detail);
          }
          return { ok: true, kind: "decision", proposal: proposalResult.proposal };
        }
        const openingResult = parseOpeningBundleProposal(parsed.value, context.input.gameLength === "medium" ? 5 : 3);
        if (!openingResult.ok) {
          logger?.warn(`narrative_bundle_invalid_opening_schema_${openingResult.reason}`);
          return failBundle("invalid_schema", "invalid_schema");
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
