import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { EvolutionNeed, WorldDeltaProposal, ApprovedWorldDelta } from "@/game/domain/worldDelta";
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
import { parseNarrativeBundleProposal, narrativeBundleTriggerKey } from "@/game/domain/narrativeBundle";
import type {
  NarrativeSceneState,
  NarrativeNpcLineState,
  NarrativeEventState,
} from "@/game/domain/narrative";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import { createApprovedChoice } from "@/game/domain/approvedChoice";
import type { EventCandidate } from "@/game/domain/candidateEvent";
import type { PreparedSceneSeedState } from "@/game/domain/preparedContinuation";
import type { ObjectiveTransition } from "@/game/domain/narrativeBeat";
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
  | { readonly ok: false; readonly code: NarrativeBundleRejection };

export type ApproveNarrativeBundleInput = {
  readonly proposal: NarrativeBundleProposal;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly transition: ObjectiveTransition;
  readonly evolutionNeed: EvolutionNeed;
  readonly jobId: NarrativeJobId;
  readonly basedOnRevision: number;
  readonly idOverride?: WorldDeltaIdOverride;
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

function buildSceneFromProposal(
  proposal: BundleSceneProposal,
  sceneId: string,
  turn: number,
  trigger?: NarrativeBundleTrigger,
): NarrativeSceneState {
  const narration = proposal.segments.map((s) => s.text).join("\n");
  const npcLine: NarrativeNpcLineState | null = proposal.npcLine === null
    ? null
    : {
        npcId: proposal.npcLine.npcId as never,
        text: proposal.npcLine.text,
        emotion: proposal.npcLine.emotion,
        usedFactIds: proposal.npcLine.usedFactIds.map((id: string) => id as never),
        answeredBeatIds: [...proposal.npcLine.answeredBeatIds],
      };
  const event = trigger === undefined ? undefined : eventForTrigger(trigger);
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
  };
}

function buildStepState(
  proposal: BundleStepProposal,
  descriptor: BundleStepDescriptor,
): NarrativeBundleStepState | NarrativeBundleRejection {
  // The proposal stepKey must match the descriptor stepKey (after symbol resolution)
  if (proposal.stepKey !== descriptor.stepKey) {
    return "bundle_unknown_step";
  }

  const event = eventForTrigger(descriptor.trigger);
  const npcLine = proposal.scene.npcLine === null
    ? null
    : {
        npcId: proposal.scene.npcLine.npcId as never,
        text: proposal.scene.npcLine.text,
        emotion: proposal.scene.npcLine.emotion,
        usedFactIds: proposal.scene.npcLine.usedFactIds.map((id: string) => id as never),
        answeredBeatIds: [...proposal.scene.npcLine.answeredBeatIds],
      };

  const objectiveLink = proposal.scene.objectiveLink === null
    ? null
    : {
        questId: proposal.scene.objectiveLink.questId as never,
        objectiveIndex: proposal.scene.objectiveLink.objectiveIndex,
        mode: proposal.scene.objectiveLink.mode,
      };

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
    segments: proposal.scene.segments.map((s) => ({
      beatId: s.beatId,
      text: s.text,
      ...(s.referencedEntityIds === undefined ? {} : { referencedEntityIds: s.referencedEntityIds }),
    })),
    event,
    npcLine,
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
    const worldApproval = approveWorldDelta({
      proposal: proposal.worldDelta as WorldDeltaProposal,
      need: evolutionNeed,
      ws: worldState,
      ss: storyState,
      idOverride: input.idOverride,
    });
    if (!worldApproval.ok) {
      return { ok: false, code: "world_delta_rejected" };
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

  // Step 3: Build descriptors from preview state
  const graph = buildNarrativeBundleDescriptors({
    worldState: previewWorldState,
    storyState: previewStoryState,
    transition,
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
    const stepResult = buildStepState(proposalStep, descriptor);
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

  // Step 6: Build current scene
  const sceneId = `scene-${String(jobId)}`;
  const currentScene = buildSceneFromProposal(
    proposal.currentScene,
    sceneId,
    basedOnRevision,
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
    // Build choices from terminal descriptor candidates
    const proposalChoiceMap = new Map(proposal.continuationScenes
      .find((s) => s.stepKey === targetStepKey)?.scene.choices.map((c: { candidateId: string; label: string }) => [c.candidateId, c.label]) ?? []);
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
    // Current scene has the choices
    for (const choice of proposal.currentScene.choices) {
      // For current_scene terminal, choices are just label/candidateId pairs
      // The action is derived from the descriptor's currentChoiceCandidates
      const matchingCandidate = graph.currentChoiceCandidates.find(
        (c) => c.candidateId === choice.candidateId,
      );
      if (matchingCandidate === undefined) {
        return { ok: false, code: "bundle_invalid_scene" };
      }
      const approved = createApprovedChoice({
        sceneId,
        basedOnRevision,
        label: choice.label,
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
