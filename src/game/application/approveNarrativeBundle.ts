import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type {
  EvolutionNeed,
  WorldDeltaEntityContextClosure,
  WorldDeltaProposal,
  ApprovedWorldDelta,
} from "@/game/domain/worldDelta";
import type { NarrativeJobId } from "@/game/domain/events";
import type {
  NarrativeBundleProposal,
  NarrativeBundleState,
  NarrativeBundleStepState,
  NarrativeBundleTerminalState,
  NarrativeBundleTrigger,
  BundleSceneProposal,
  BundleStepProposal,
} from "@/game/domain/narrativeBundle";
import { parseNarrativeBundleProposal } from "@/game/domain/narrativeBundle";
import type {
  NarrativeSceneState,
  NarrativeNpcLineState,
  NarrativeEventState,
} from "@/game/domain/narrative";
import { NPC_SCENE_PAGE_CHAR_BUDGET } from "@/game/domain/narrative";
import { normalizeNpcSpeech } from "@/game/domain/npcSpeech";
import { paginateSpeechText } from "@/game/domain/speechPagination";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { PreparedSceneSeedState } from "@/game/domain/preparedContinuation";
import type { ObjectiveTransition, MandatoryNarrativeBeat } from "@/game/domain/narrativeBeat";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import {
  approveWorldDelta,
  materializeWorldDelta,
  type WorldDeltaIdOverride,
} from "@/game/gameplay/rpg/worldEvolution";
import {
  buildNarrativeBundleDescriptors,
  validateNarrativeBundleCoverage,
  type BundleDescriptorGraph,
  type BundleStepDescriptor,
} from "@/game/gameplay/rpg/narrativeBundle";
import type { NarrativeBundleRejection } from "./narrativeBundleSource";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import { entitiesOfKind } from "@/game/domain/entity";
import { asFactId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import {
  buildNpcSpeechAuthority,
  isValidNpcSpeechTarget,
  validateNpcSpeechReferences,
} from "./npcSpeechAuthority";

// ---------------------------------------------------------------------------
// Task 4：原子审批叙事生成包。
// 纯函数：approveWorldDelta → materializeWorldDelta → buildDescriptors →
// resolve symbols → approve scenes → validate coverage → return one
// immutable ApprovedNarrativeBundle.
// 不调用 source/aiClient/repository——那些由上层编排。
// ---------------------------------------------------------------------------

export type ApprovedNarrativeBundle = {
  readonly nextWorldState: WorldState;
  readonly nextStoryStatePreview: StoryState;
  readonly currentScene: NarrativeSceneState;
  readonly choiceRegistry: readonly ApprovedChoice[];
  readonly bundle: NarrativeBundleState;
  readonly candidateEventPool: readonly EventCandidate[];
};

export type ApproveNarrativeBundleResult =
  | { readonly ok: true; readonly approved: ApprovedNarrativeBundle }
  | {
    readonly ok: false;
    readonly code: NarrativeBundleRejection;
    /** 规则引擎给出的细分拒绝理由（如 duplicate_name:enemy）；供修复重试提示使用。 */
    readonly detail?: string;
  };

export type ApproveNarrativeBundleInput = {
  readonly proposal: NarrativeBundleProposal;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly transition: ObjectiveTransition;
  readonly evolutionNeed: EvolutionNeed;
  readonly jobId: NarrativeJobId;
  readonly basedOnRevision: number;
  /** 本回合规则派生的强制节拍；currentScene 必须逐一覆盖。 */
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  readonly idOverride?: WorldDeltaIdOverride;
  readonly entityContextClosure?: WorldDeltaEntityContextClosure;
  readonly now: () => string;
  readonly auditLink?: AiTextAuditLink;
};

function eventForTrigger(trigger: NarrativeBundleTrigger): NarrativeEventState {
  switch (trigger.kind) {
    case "move":
    case "explore":
      return { kind: "travel", locationId: trigger.locationId };
    case "investigate":
      return { kind: "investigate", factId: trigger.factId };
    case "take_item":
      return { kind: "item", itemId: trigger.itemId };
    case "give_item":
      return { kind: "dialogue", focusNpcId: trigger.npcId };
    case "battle_started":
    case "battle_resolved":
      return { kind: "battle", enemyId: trigger.enemyId };
  }
}

function reclassifiedStageDirection(text: string): string {
  return text.trim()
    .replace(/^[…。，！？!?\s]+/u, "")
    .replace(/^（(.+)）$/u, "$1")
    .trim();
}

/** Surface every existing-world naming collision in one repair hint. */
function duplicateNameDetail(proposal: WorldDeltaProposal, worldState: WorldState): string | undefined {
  const npcName = proposal.newNpc?.name;
  const locationName = proposal.newLocation?.name;
  const itemName = proposal.newItem?.name;
  const enemyName = proposal.newEnemy?.name;
  const questName = proposal.nextMainQuest?.name;
  const duplicates = [
    npcName !== undefined && worldState.npcs.some((entry) => entry.name === npcName)
      ? `npc:${npcName}` : null,
    locationName !== undefined && worldState.locations.some((entry) => entry.name === locationName)
      ? `location:${locationName}` : null,
    itemName !== undefined && worldState.items.some((entry) => entry.name === itemName)
      ? `item:${itemName}` : null,
    enemyName !== undefined && worldState.enemies.some((entry) => entry.name === enemyName)
      ? `enemy:${enemyName}` : null,
    questName !== undefined && worldState.quests.some((entry) => entry.name === questName)
      ? `quest:${questName}` : null,
  ].filter((entry): entry is string => entry !== null);
  return duplicates.length === 0 ? undefined : `duplicate_name:${duplicates.join("|")}`;
}

function buildSceneFromProposal(
  proposal: BundleSceneProposal,
  sceneId: string,
  turn: number,
  trigger?: NarrativeBundleTrigger,
  dialogueFocusNpcId?: NarrativeNpcLineState["npcId"],
  worldState?: WorldState,
): NarrativeSceneState {
  const normalizedNpcText = proposal.npcLine === null
    ? null
    : normalizeNpcSpeech(proposal.npcLine.text);
  const stageDirection = proposal.npcLine !== null && normalizedNpcText === ""
    ? reclassifiedStageDirection(proposal.npcLine.text)
    : "";
  const narration = [
    ...proposal.segments.map((s) => s.text),
    ...(stageDirection === "" ? [] : [stageDirection]),
  ].join("\n");
  const npcLine: NarrativeNpcLineState | null = proposal.npcLine === null
    || normalizedNpcText === ""
    ? null
    : {
        npcId: proposal.npcLine.npcId as never,
        text: normalizedNpcText!,
        emotion: proposal.npcLine.emotion,
        usedFactIds: proposal.npcLine.usedFactIds.map((id: string) => id as never),
        usedInteractionActionIds: [...proposal.npcLine.usedInteractionActionIds],
        answeredBeatIds: [...proposal.npcLine.answeredBeatIds],
      };
  // The current-scene terminal is itself a formal NPC decision boundary.
  // Unlike continuation steps it has no trigger, so derive its dialogue
  // marker from the approved focused line and pair of server candidates.
  const event = trigger === undefined
    ? dialogueFocusNpcId !== undefined
      ? { kind: "dialogue" as const, focusNpcId: dialogueFocusNpcId }
      : npcLine !== null && proposal.choices.length === 2
        ? { kind: "dialogue" as const, focusNpcId: npcLine.npcId }
      : undefined
    : eventForTrigger(trigger);
  const npcDialogues = proposal.npcDialogues?.map((dialogue) => {
    const npc = worldState?.npcs.find((candidate) => String(candidate.id) === dialogue.npcId);
    const text = normalizeNpcSpeech(dialogue.text, npc?.name);
    return {
      npcId: dialogue.npcId as never,
      npcName: npc?.name ?? dialogue.npcId,
      npcRole: npc?.role ?? "",
      speechPages: paginateSpeechText(text, NPC_SCENE_PAGE_CHAR_BUDGET),
      speechSource: "generated" as const,
      speechPurpose: dialogue.npcId === String(npcLine?.npcId) ? "focus" as const : "ambient" as const,
      usedFactIds: dialogue.usedFactIds.map(asFactId),
      usedInteractionActionIds: [...dialogue.usedInteractionActionIds],
    };
  });
  return {
    sceneId,
    turn,
    narration,
    usedFactIds: npcLine?.usedFactIds ?? [],
    npcLine,
    choices: [],
    source: "generated",
    ...(event === undefined ? {} : { event }),
    ...(proposal.handoffAcknowledgement === undefined
      ? {}
      : { handoffAcknowledgement: proposal.handoffAcknowledgement }),
    ...(npcDialogues === undefined ? {} : { npcDialogues }),
  };
}

function buildStepState(
  proposal: BundleStepProposal,
  descriptor: BundleStepDescriptor,
  worldState: WorldState,
): NarrativeBundleStepState | NarrativeBundleRejection {
  // The proposal stepKey must match the descriptor stepKey (after symbol resolution)
  if (proposal.stepKey !== descriptor.stepKey) {
    return "bundle_unknown_step";
  }
  const sceneLocationId = bundleSceneLocationId(descriptor.trigger, worldState);
  if (validateBundleSceneNpcSpeech(
    proposal.scene,
    worldState,
    descriptor.arrivalNpc?.id,
    presentNpcIdsAtLocation(worldState, sceneLocationId),
  ) !== null) {
    return "bundle_invalid_scene";
  }

  const event = eventForTrigger(descriptor.trigger);
  const normalizedNpcText = proposal.scene.npcLine === null
    ? null
    : normalizeNpcSpeech(proposal.scene.npcLine.text);
  const stageDirection = proposal.scene.npcLine !== null && normalizedNpcText === ""
    ? reclassifiedStageDirection(proposal.scene.npcLine.text)
    : "";
  const npcLine = proposal.scene.npcLine === null
    || normalizedNpcText === ""
    ? null
    : {
        npcId: proposal.scene.npcLine.npcId as never,
        text: normalizedNpcText!,
        emotion: proposal.scene.npcLine.emotion,
        usedFactIds: proposal.scene.npcLine.usedFactIds.map((id: string) => id as never),
        usedInteractionActionIds: [...proposal.scene.npcLine.usedInteractionActionIds],
        answeredBeatIds: [...proposal.scene.npcLine.answeredBeatIds],
      };

  const objectiveLink = proposal.scene.objectiveLink === null
    ? null
    : {
        questId: proposal.scene.objectiveLink.questId as never,
        objectiveIndex: proposal.scene.objectiveLink.objectiveIndex,
        mode: proposal.scene.objectiveLink.mode,
      };
  const npcDialogues = proposal.scene.npcDialogues?.map((dialogue) => {
    const npc = worldState.npcs.find((candidate) => String(candidate.id) === dialogue.npcId);
    const text = normalizeNpcSpeech(dialogue.text, npc?.name);
    return {
      npcId: dialogue.npcId as never,
      npcName: npc?.name ?? dialogue.npcId,
      npcRole: npc?.role ?? "",
      speechPages: paginateSpeechText(text, NPC_SCENE_PAGE_CHAR_BUDGET),
      speechSource: "generated" as const,
      speechPurpose: dialogue.npcId === String(npcLine?.npcId) ? "focus" as const : "ambient" as const,
      usedFactIds: dialogue.usedFactIds.map(asFactId),
      usedInteractionActionIds: [...dialogue.usedInteractionActionIds],
    };
  });

  // Build choice seeds from descriptor choice candidates and proposal choices
  const proposalChoiceMap = new Map(proposal.scene.choices.map((c: { candidateId: string; label: string }) => [c.candidateId, c.label]));
  const choiceSeeds = descriptor.choiceCandidates.map((candidate) => {
    const label = proposalChoiceMap.get(candidate.candidateId);
    if (label === undefined) return null;
    return { label, action: candidate.action };
  });
  if (choiceSeeds.some((seed) => seed === null)) {
    return "bundle_invalid_scene";
  }

  const scene: PreparedSceneSeedState = {
    segments: proposal.scene.segments.map((s, index) => ({
      beatId: s.beatId,
      text: stageDirection !== "" && index === proposal.scene.segments.length - 1
        ? `${s.text}\n${stageDirection}`
        : s.text,
      ...(s.referencedEntityIds === undefined ? {} : { referencedEntityIds: s.referencedEntityIds }),
    })),
    event,
    npcLine,
    ...(npcDialogues === undefined ? {} : { npcDialogues }),
    objectiveLink,
    choiceSeeds: choiceSeeds as NonNullable<typeof choiceSeeds[number]>[],
    source: "generated",
  };

  return {
    stepId: descriptor.stepKey,
    objectiveKey: descriptor.objectiveKey,
    consumptionGroupKey: descriptor.consumptionGroupKey,
    trigger: descriptor.trigger,
    scene,
    nextStepIds: [...descriptor.nextStepKeys],
  };
}

function resolveTerminalState(
  graph: BundleDescriptorGraph,
): NarrativeBundleTerminalState {
  const terminal = graph.terminal;
  if (terminal.kind === "ending") return { kind: "ending" };
  if (terminal.target.kind === "current_scene") {
    return { kind: "next_decision", target: { kind: "current_scene" } };
  }
  return {
    kind: "next_decision",
    target: { kind: "continuation_step", stepId: terminal.target.stepKey },
  };
}

function terminalsMatch(
  proposal: NarrativeBundleProposal["terminal"],
  graph: BundleDescriptorGraph["terminal"],
): boolean {
  if (proposal.kind !== graph.kind) return false;
  if (proposal.kind === "ending") return true;
  if (graph.kind === "ending") return false;
  if (proposal.target.kind !== graph.target.kind) return false;
  if (proposal.target.kind === "current_scene") return true;
  if (graph.target.kind !== "continuation_step") return false;
  return proposal.target.stepKey === graph.target.stepKey;
}

function hasExactChoiceCandidates(
  choices: BundleSceneProposal["choices"],
  candidates: readonly BundleStepDescriptor["choiceCandidates"][number][],
): boolean {
  if (choices.length !== 2 || candidates.length !== 2) return false;
  const choiceIds = choices.map((choice) => choice.candidateId);
  if (new Set(choiceIds).size !== 2) return false;
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  return candidateIds.every((candidateId) => choiceIds.includes(candidateId));
}

type SceneContentRejection = { readonly code: NarrativeBundleRejection; readonly detail?: string };

function validateBundleNpcSpeech(
  line: { readonly npcId: string; readonly usedFactIds: readonly string[]; readonly usedInteractionActionIds: readonly string[] },
  worldState: WorldState,
): SceneContentRejection | null {
  const visibleFactIds = entitiesOfKind(worldState.entityStore, "fact")
    .filter((fact) => fact.fact.discovered)
    .map((fact) => fact.core.id);
  const targetIsValid = isValidNpcSpeechTarget(worldState.entityStore, PLAYER_ENTITY_ID);
  if (!targetIsValid) return { code: "bundle_invalid_scene", detail: "invalid_target" };
  try {
    const authority = buildNpcSpeechAuthority({
      store: worldState.entityStore,
      speakerNpcId: line.npcId as never,
      sceneVisibleFactIds: visibleFactIds,
      targetContext: { targetId: PLAYER_ENTITY_ID },
    });
    const result = validateNpcSpeechReferences({
      authority,
      usedFactIds: line.usedFactIds,
      usedInteractionActionIds: line.usedInteractionActionIds,
    });
    if (result.ok) return null;
    return { code: "bundle_invalid_scene", detail: result.code };
  } catch {
    return { code: "bundle_invalid_scene", detail: "missing_speaker" };
  }
}

function validateBundleSceneNpcSpeech(
  scene: BundleSceneProposal,
  worldState: WorldState,
  expectedNpcId?: string,
  presentNpcIds?: ReadonlySet<string>,
): SceneContentRejection | null {
  const dialogues = scene.npcDialogues ?? [];
  const speakers = [
    ...(scene.npcLine === null ? [] : [scene.npcLine.npcId]),
    ...dialogues.map((dialogue) => dialogue.npcId),
  ];
  if (new Set(speakers).size !== speakers.length) {
    return { code: "bundle_invalid_scene", detail: "duplicate_speaker" };
  }
  if (presentNpcIds !== undefined && speakers.some((npcId) => !presentNpcIds.has(npcId))) {
    return { code: "bundle_invalid_scene", detail: "missing_speaker" };
  }
  if (scene.npcLine !== null) {
    if (expectedNpcId !== undefined && scene.npcLine.npcId !== expectedNpcId) {
      return { code: "bundle_invalid_scene", detail: "missing_speaker" };
    }
    const rejection = validateBundleNpcSpeech(scene.npcLine, worldState);
    if (rejection !== null) return rejection;
  }
  for (const dialogue of dialogues) {
    const rejection = validateBundleNpcSpeech({
      npcId: dialogue.npcId,
      usedFactIds: dialogue.usedFactIds,
      usedInteractionActionIds: dialogue.usedInteractionActionIds,
    }, worldState);
    if (rejection !== null) return rejection;
  }
  return null;
}

function presentNpcIdsAtLocation(worldState: WorldState, locationId: string): ReadonlySet<string> {
  return new Set(
    worldState.npcs
      .filter((npc) => String(npc.locationId) === locationId)
      .map((npc) => String(npc.id)),
  );
}

function bundleSceneLocationId(
  trigger: NarrativeBundleTrigger,
  worldState: WorldState,
): string {
  switch (trigger.kind) {
    case "move":
    case "explore":
      return String(trigger.locationId);
    default:
      return String(worldState.currentLocationId);
  }
}

/**
 * 当前场景内容闸门：提案的 currentScene 必须直接承接本回合的规则结果。
 * 缺失时拒绝整包并回传细分拒因，由修复重试要求 provider 纠正，
 * 绝不让脱离当前情境的场景冒充成功写回。
 */
function validateCurrentSceneContent(input: {
  readonly scene: BundleSceneProposal;
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  readonly dialogueFocusNpcId: string | undefined;
  readonly transition: ObjectiveTransition;
  readonly worldState: WorldState;
}): SceneContentRejection | null {
  const { scene, mandatoryBeats, dialogueFocusNpcId, transition, worldState } = input;

  // 节拍契约：强制节拍逐一覆盖（各恰好一次，顺序不限），
  // 不得自创节拍；最多追加一个 atmosphere 段且必须置于最后。
  const requiredBeats = mandatoryBeats.filter((beat) => beat.beatId !== ATMOSPHERE_BEAT_ID);
  const segmentBeatIds = scene.segments.map((segment) => segment.beatId);
  const allowedBeatIds = new Set([
    ...requiredBeats.map((beat) => beat.beatId),
    ATMOSPHERE_BEAT_ID,
  ]);
  for (const beatId of segmentBeatIds) {
    if (!allowedBeatIds.has(beatId)) {
      return { code: "invented_beat_id", detail: beatId };
    }
  }
  for (const beat of requiredBeats) {
    if (segmentBeatIds.filter((id) => id === beat.beatId).length !== 1) {
      return { code: "missing_mandatory_beat", detail: `${beat.beatId}（${beat.kind}）` };
    }
  }
  if (segmentBeatIds.filter((id) => id === ATMOSPHERE_BEAT_ID).length > 1) {
    return { code: "out_of_order_beats", detail: "至多一个 atmosphere 段" };
  }
  const atmosphereIndex = segmentBeatIds.indexOf(ATMOSPHERE_BEAT_ID);
  if (atmosphereIndex !== -1 && atmosphereIndex !== segmentBeatIds.length - 1) {
    return { code: "out_of_order_beats", detail: "atmosphere 段必须置于最后" };
  }

  // player_utterance 节拍必须由焦点 NPC 的台词显式应答。
  const utteranceBeat = mandatoryBeats.find((beat) => beat.kind === "player_utterance");
  if (utteranceBeat !== undefined) {
    const focusNpcId = utteranceBeat.subjectIds[0];
    if (
      scene.npcLine === null
      || scene.npcLine.npcId !== focusNpcId
      || !scene.npcLine.answeredBeatIds.includes(utteranceBeat.beatId)
    ) {
      return { code: "player_utterance_unanswered", detail: focusNpcId };
    }
  }

  // 正式对话决策点：两个选项都指向同一焦点 NPC 时，场景必须带该 NPC 的直接台词，
  // 玩家不能面对一组没有任何回应支撑的选项。
  if (dialogueFocusNpcId !== undefined && scene.npcLine === null) {
    return { code: "dialogue_focus_line_missing", detail: dialogueFocusNpcId };
  }

  // 台词说话人必须是世界内已存在的 NPC。
  if (
    scene.npcLine !== null
    && !worldState.npcs.some((npc) => String(npc.id) === scene.npcLine!.npcId)
  ) {
    return { code: "bundle_invalid_scene", detail: `npcLine 说话人 ${scene.npcLine.npcId} 不存在` };
  }
  if (dialogueFocusNpcId !== undefined
    && scene.npcLine !== null
    && scene.npcLine.npcId !== dialogueFocusNpcId) {
    return { code: "bundle_invalid_scene", detail: "missing_speaker" };
  }

  const speechRejection = validateBundleSceneNpcSpeech(
    scene,
    worldState,
    undefined,
    presentNpcIdsAtLocation(worldState, String(worldState.currentLocationId)),
  );
  if (speechRejection !== null) return speechRejection;

  // objectiveLink 必须与权威 ObjectiveTransition 一致（无 after 时为 null）。
  const after = transition.after;
  if (after === null) {
    if (scene.objectiveLink !== null) {
      return { code: "objective_link_mismatch", detail: "after 为空时 objectiveLink 必须为 null" };
    }
  } else if (
    scene.objectiveLink === null
    || scene.objectiveLink.questId !== String(after.questId)
    || scene.objectiveLink.objectiveIndex !== after.objectiveIndex
  ) {
    return { code: "objective_link_mismatch", detail: `期望 ${String(after.questId)}:${after.objectiveIndex}` };
  }

  return null;
}

export function approveNarrativeBundle(
  input: ApproveNarrativeBundleInput,
): ApproveNarrativeBundleResult {
  const { proposal, worldState, storyState, transition, evolutionNeed, jobId, basedOnRevision, now } = input;

  // Step 1: Parse the proposal
  const parsed = parseNarrativeBundleProposal(proposal);
  if (!parsed.ok) return { ok: false, code: "bundle_invalid_scene" };

  // Step 2: Approve worldDelta (if present)
  let previewWorldState = worldState;
  let previewStoryState = storyState;
  let approvedDelta: ApprovedWorldDelta | undefined;

  if (proposal.worldDelta !== null) {
    const parsedDelta = proposal.worldDelta as WorldDeltaProposal;
    const duplicateDetail = duplicateNameDetail(parsedDelta, worldState);
    if (duplicateDetail !== undefined) {
      return { ok: false, code: "world_delta_rejected", detail: duplicateDetail };
    }
    const worldApproval = approveWorldDelta({
      proposal: parsedDelta,
      need: evolutionNeed,
      ws: worldState,
      ss: storyState,
      idOverride: input.idOverride,
      entityContextClosure: input.entityContextClosure,
    });
    if (!worldApproval.ok) {
      const duplicateName = worldApproval.code === "duplicate_name"
        ? (() => {
            const delta = parsedDelta;
            switch (worldApproval.reason) {
              case "npc": return delta.newNpc?.name;
              case "location": return delta.newLocation?.name;
              case "item": return delta.newItem?.name;
              case "enemy": return delta.newEnemy?.name;
              case "quest": return delta.nextMainQuest?.name;
              default: return undefined;
            }
          })()
        : undefined;
      return {
        ok: false,
        code: "world_delta_rejected",
        detail: `${worldApproval.code}:${worldApproval.reason}${duplicateName === undefined ? "" : `:${duplicateName}`}`,
      };
    }

    approvedDelta = materializeWorldDelta({
      approved: worldApproval.approved,
      need: evolutionNeed,
      ws: worldState,
      ss: storyState,
      now,
    });
    previewWorldState = approvedDelta.previewWorldState;
    previewStoryState = approvedDelta.previewStoryState;
  }

  // Step 3: Build descriptors from preview state.  At a natural act boundary
  // the rule turn has no `after` objective yet; materializing the approved
  // next-act delta is what supplies that first objective.  Re-root the
  // descriptor projection at the server-owned reveal cursor so the newly
  // created arrival step is validated rather than being mistaken for an end.
  const nextActReveal = previewStoryState.reveal;
  const descriptorTransition: ObjectiveTransition = transition.after === null
    && evolutionNeed.kind === "next_act"
    && nextActReveal !== null
    && nextActReveal !== undefined
    ? {
        ...transition,
        after: {
          questId: nextActReveal.questId,
          objectiveIndex: nextActReveal.visibleObjectiveIndex,
          label: "next_act_arrival",
        },
        mode: "advanced_act",
      }
    : transition;
  const graph = buildNarrativeBundleDescriptors({
    worldState: previewWorldState,
    storyState: previewStoryState,
    transition: descriptorTransition,
  });

  // Step 4: Validate coverage
  const coverage = validateNarrativeBundleCoverage(graph);
  if (!coverage.ok) {
    return { ok: false, code: coverage.code };
  }

  // Step 5: Resolve continuation scenes against descriptors
  const descriptorByKey = new Map(graph.steps.map((d) => [d.stepKey, d]));
  const stepStates: NarrativeBundleStepState[] = [];

  // Check for duplicate step keys in proposal
  const proposalStepKeys = proposal.continuationScenes.map((s) => s.stepKey);
  if (new Set(proposalStepKeys).size !== proposalStepKeys.length) {
    return { ok: false, code: "bundle_duplicate_step" };
  }

  // Check every proposal step has a matching descriptor
  for (const proposalStep of proposal.continuationScenes) {
    const descriptor = descriptorByKey.get(proposalStep.stepKey);
    if (descriptor === undefined) {
      return { ok: false, code: "bundle_unknown_step" };
    }
    const stepResult = buildStepState(proposalStep, descriptor, previewWorldState);
    if (typeof stepResult === "string") {
      return { ok: false, code: stepResult };
    }
    stepStates.push(stepResult);
  }

  // Check every descriptor has a matching proposal step
  for (const descriptor of graph.steps) {
    if (!proposalStepKeys.includes(descriptor.stepKey)) {
      return { ok: false, code: "bundle_missing_step" };
    }
  }

  // The terminal step is the next formal dialogue boundary: it must carry the
  // arrival NPC's direct line, otherwise players face choices without speech.
  if (graph.terminal.kind === "next_decision" && graph.terminal.target.kind === "continuation_step") {
    const targetStepKey = graph.terminal.target.stepKey;
    const terminalDescriptor = descriptorByKey.get(targetStepKey);
    const terminalProposal = proposal.continuationScenes.find((step) => step.stepKey === targetStepKey);
    // A written stage direction still counts as authored content (it is
    // reclassified into narration); only a fully omitted line is rejected.
    if (
      terminalDescriptor?.arrivalNpc !== undefined
      && (terminalProposal === undefined
        || terminalProposal.scene.npcLine === null
        || terminalProposal.scene.npcLine.npcId !== terminalDescriptor.arrivalNpc.id)
    ) {
      return { ok: false, code: "dialogue_focus_line_missing", detail: String(terminalDescriptor.arrivalNpc.id) };
    }
  }

  if (!terminalsMatch(proposal.terminal, graph.terminal)) {
    return { ok: false, code: "bundle_invalid_terminal" };
  }

  // Step 6: Build current scene
  const sceneId = `scene-${String(jobId)}`;
  const firstCurrentChoice = graph.currentChoiceCandidates[0];
  const currentDialogueFocusNpcId = graph.terminal.kind === "next_decision"
    && graph.terminal.target.kind === "current_scene"
    && graph.currentChoiceCandidates.length === 2
    && graph.currentChoiceCandidates.every((candidate) => candidate.action.type === "talk")
    && firstCurrentChoice?.action.type === "talk"
    ? firstCurrentChoice.action.npcId
    : undefined;
  const contentRejection = validateCurrentSceneContent({
    scene: proposal.currentScene,
    mandatoryBeats: input.mandatoryBeats,
    dialogueFocusNpcId: currentDialogueFocusNpcId === undefined
      ? undefined
      : String(currentDialogueFocusNpcId),
    transition,
    worldState: previewWorldState,
  });
  if (contentRejection !== null) {
    return { ok: false, code: contentRejection.code, ...(contentRejection.detail === undefined ? {} : { detail: contentRejection.detail }) };
  }
  const currentScene = buildSceneFromProposal(
    proposal.currentScene,
    sceneId,
    basedOnRevision,
    undefined,
    currentDialogueFocusNpcId,
    previewWorldState,
  );

  // Step 7: Build choice registry from terminal
  const choiceRegistry: ApprovedChoice[] = [];
  const terminal = graph.terminal;

  if (terminal.kind === "next_decision" && terminal.target.kind === "continuation_step") {
    const targetStepKey = terminal.target.stepKey;
    const terminalDescriptor = descriptorByKey.get(targetStepKey);
    if (terminalDescriptor === undefined) {
      return { ok: false, code: "bundle_invalid_terminal" };
    }
    const terminalProposal = proposal.continuationScenes
      .find((step) => step.stepKey === targetStepKey);
    if (terminalProposal === undefined
      || !hasExactChoiceCandidates(terminalProposal.scene.choices, terminalDescriptor.choiceCandidates)) {
      return { ok: false, code: "bundle_invalid_scene" };
    }
    const proposalChoiceMap = new Map(terminalProposal.scene.choices
      .map((choice) => [choice.candidateId, choice.label]));
    for (const candidate of terminalDescriptor.choiceCandidates) {
      const label = proposalChoiceMap.get(candidate.candidateId);
      if (label === undefined) {
        return { ok: false, code: "bundle_invalid_scene" };
      }
      const approved = createApprovedChoice({
        sceneId: `${sceneId}-${targetStepKey}`,
        basedOnRevision,
        label,
        action: candidate.action,
      });
      if (!approved.ok) {
        return { ok: false, code: "bundle_invalid_scene" };
      }
      choiceRegistry.push(approved.choice);
    }
  } else if (terminal.kind === "next_decision" && terminal.target.kind === "current_scene") {
    if (!hasExactChoiceCandidates(proposal.currentScene.choices, graph.currentChoiceCandidates)) {
      return { ok: false, code: "bundle_invalid_scene" };
    }
    const proposalChoiceMap = new Map(proposal.currentScene.choices
      .map((choice) => [choice.candidateId, choice.label]));
    for (const matchingCandidate of graph.currentChoiceCandidates) {
      const label = proposalChoiceMap.get(matchingCandidate.candidateId);
      if (label === undefined) return { ok: false, code: "bundle_invalid_scene" };
      const approved = createApprovedChoice({
        sceneId,
        basedOnRevision,
        label,
        action: matchingCandidate.action,
      });
      if (!approved.ok) {
        return { ok: false, code: "bundle_invalid_scene" };
      }
      choiceRegistry.push(approved.choice);
    }
  }

  // Build the final bundle state
  const terminalState = resolveTerminalState(graph);
  const bundle: NarrativeBundleState = {
    contractVersion: 1,
    originJobId: jobId,
    steps: stepStates,
    activeStepIds: [...graph.activeStepKeys],
    terminal: terminalState,
  };

  // Build the current scene with choices if terminal is current_scene
  const finalScene: NarrativeSceneState = terminal.kind === "next_decision" && terminal.target.kind === "current_scene"
    ? {
        ...currentScene,
        choices: choiceRegistry.map((c) => ({
          choiceToken: c.choiceToken,
          label: c.label,
        })),
      }
    : currentScene;

  return {
    ok: true,
    approved: {
      nextWorldState: previewWorldState,
      nextStoryStatePreview: previewStoryState,
      currentScene: finalScene,
      choiceRegistry,
      bundle,
      candidateEventPool: [],
    },
  };
}
