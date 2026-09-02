import type { Action, DialogueTopic } from "./action";
import type { NarrativeJobId } from "./events";
import type { NarrativeEventState, NarrativeNpcLineState, NpcDialogueInScene } from "./narrative";
import type {
  EnemyId,
  FactId,
  LocationId,
  QuestId,
} from "./worldEntity";
import { areUniqueNpcSpeechReferenceIds } from "./npcSpeechReferences";

export const NARRATIVE_CONTINUATION_MISSING = "NARRATIVE_CONTINUATION_MISSING" as const;
export const NARRATIVE_CONTINUATION_INVALID = "NARRATIVE_CONTINUATION_INVALID" as const;
export type PreparedContinuationErrorCode =
  | typeof NARRATIVE_CONTINUATION_MISSING
  | typeof NARRATIVE_CONTINUATION_INVALID;

export type PreparedContinuationTrigger =
  | { readonly kind: "move"; readonly locationId: LocationId }
  | { readonly kind: "investigate"; readonly factId: FactId; readonly approachId?: string }
  | { readonly kind: "battle_started"; readonly enemyId: EnemyId }
  | {
      readonly kind: "battle_resolved";
      readonly enemyId: EnemyId;
      readonly outcome: "victory" | "defeat" | "withdraw";
    };

export type PreparedChoiceSeedState = {
  readonly label: string;
  readonly action: Action;
};

export type PreparedNarrativeSegmentState = {
  readonly beatId: string;
  readonly text: string;
  readonly referencedEntityIds?: readonly string[];
};

export type PreparedObjectiveLinkState = {
  readonly questId: QuestId;
  readonly objectiveIndex: number;
  readonly mode: "hint" | "progress" | "handoff";
};

export type PreparedSceneSeedState = {
  readonly segments: readonly PreparedNarrativeSegmentState[];
  readonly event: NarrativeEventState;
  readonly npcLine: NarrativeNpcLineState | null;
  readonly npcDialogues?: readonly NpcDialogueInScene[];
  readonly objectiveLink: PreparedObjectiveLinkState | null;
  readonly choiceSeeds: readonly PreparedChoiceSeedState[];
  readonly source: "generated" | "fixture";
};

export type PreparedContinuationStepState = {
  readonly stepId: string;
  readonly objectiveKey: string;
  /** Sibling variants share this key; consuming one prunes only this group. */
  readonly consumptionGroupKey: string;
  readonly trigger: PreparedContinuationTrigger;
  readonly scene: PreparedSceneSeedState;
  /** Server-authored graph edge; AI output never supplies or changes it. */
  readonly nextStepIds: readonly string[];
};

export type PreparedContinuationState = {
  readonly originJobId: NarrativeJobId;
  readonly steps: readonly PreparedContinuationStepState[];
  readonly activeStepIds: readonly string[];
};

export type PreparedContinuationParseResult =
  | { readonly ok: true; readonly value: PreparedContinuationState }
  | { readonly ok: false; readonly code: "INVALID_PREPARED_CONTINUATION" };

const INVALID: PreparedContinuationParseResult = {
  ok: false,
  code: "INVALID_PREPARED_CONTINUATION",
};

const PREPARED_NARRATIVE_EMOTIONS: readonly string[] = [
  "neutral", "warm", "guarded", "afraid", "angry", "sad",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isDialogueTopic(value: unknown): value is DialogueTopic {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "general":
      return hasOnlyKeys(value, ["kind"]);
    case "fact":
      return hasOnlyKeys(value, ["kind", "factId"]) && isNonEmptyString(value.factId);
    case "quest":
      return hasOnlyKeys(value, ["kind", "questId"]) && isNonEmptyString(value.questId);
    case "thread":
      return hasOnlyKeys(value, ["kind", "threadId"]) && isNonEmptyString(value.threadId);
    default:
      return false;
  }
}

function isAction(value: unknown): value is Action {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "talk":
      return hasOnlyKeys(value, ["type", "npcId", "dialogueAct", "topic", "utterance"])
        && isNonEmptyString(value.npcId)
        && ["ask", "support", "challenge", "threaten", "deceive", "offer", "refuse", "reassure"]
          .includes(value.dialogueAct as string)
        && (value.topic === undefined || isDialogueTopic(value.topic))
        && (value.utterance === undefined || typeof value.utterance === "string");
    case "move":
      return hasOnlyKeys(value, ["type", "locationId"]) && isNonEmptyString(value.locationId);
    case "explore":
    case "ack_prologue":
      return hasOnlyKeys(value, ["type"]);
    case "investigate":
      return hasOnlyKeys(value, ["type", "factId", "approachId", "utterance"])
        && isNonEmptyString(value.factId)
        && (value.approachId === undefined || isNonEmptyString(value.approachId))
        && (value.utterance === undefined || typeof value.utterance === "string");
    case "take_item":
      return hasOnlyKeys(value, ["type", "itemId"]) && isNonEmptyString(value.itemId);
    case "give_item":
      return hasOnlyKeys(value, ["type", "itemId", "npcId"])
        && isNonEmptyString(value.itemId)
        && isNonEmptyString(value.npcId);
    case "attack":
      return hasOnlyKeys(value, ["type", "enemyId"]) && isNonEmptyString(value.enemyId);
    case "battle_action":
      return hasOnlyKeys(value, ["type", "action", "command"])
        && ["attack", "skill", "guard", "flee"].includes(value.action as string)
        && (value.command === undefined || isRecord(value.command));
    case "freeform":
      return hasOnlyKeys(value, ["type", "intent", "rawText"])
        && typeof value.intent === "string"
        && typeof value.rawText === "string";
    default:
      return false;
  }
}

function isTrigger(value: unknown): value is PreparedContinuationTrigger {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "move":
      return hasOnlyKeys(value, ["kind", "locationId"]) && isNonEmptyString(value.locationId);
    case "investigate":
      return hasOnlyKeys(value, ["kind", "factId", "approachId"])
        && isNonEmptyString(value.factId)
        && (value.approachId === undefined || isNonEmptyString(value.approachId));
    case "battle_started":
      return hasOnlyKeys(value, ["kind", "enemyId"]) && isNonEmptyString(value.enemyId);
    case "battle_resolved":
      return hasOnlyKeys(value, ["kind", "enemyId", "outcome"])
        && isNonEmptyString(value.enemyId)
        && ["victory", "defeat", "withdraw"].includes(value.outcome as string);
    default:
      return false;
  }
}

function isNarrativeEvent(value: unknown): value is NarrativeEventState {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "dialogue":
      return hasOnlyKeys(value, ["kind", "focusNpcId"]) && isNonEmptyString(value.focusNpcId);
    case "investigate":
      return hasOnlyKeys(value, ["kind", "factId"]) && isNonEmptyString(value.factId);
    case "item":
      return hasOnlyKeys(value, ["kind", "itemId"]) && isNonEmptyString(value.itemId);
    case "battle":
      return hasOnlyKeys(value, ["kind", "enemyId"]) && isNonEmptyString(value.enemyId);
    case "travel":
    case "observe":
      return hasOnlyKeys(value, ["kind", "locationId"]) && isNonEmptyString(value.locationId);
    default:
      return false;
  }
}

function isNpcLine(value: unknown): value is NarrativeNpcLineState {
  return isRecord(value)
    && hasOnlyKeys(value, ["npcId", "text", "emotion", "usedFactIds", "usedInteractionActionIds", "answeredBeatIds"])
    && isNonEmptyString(value.npcId)
    && isNonEmptyString(value.text)
    && PREPARED_NARRATIVE_EMOTIONS.includes(value.emotion as string)
    && isStringArray(value.usedFactIds)
    && isStringArray(value.usedInteractionActionIds)
    && areUniqueNpcSpeechReferenceIds(value.usedFactIds)
    && areUniqueNpcSpeechReferenceIds(value.usedInteractionActionIds)
    && (value.answeredBeatIds === undefined || isStringArray(value.answeredBeatIds));
}

function isNpcDialogue(value: unknown): value is NpcDialogueInScene {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "npcId", "npcName", "npcRole", "speechPages", "usedFactIds", "usedInteractionActionIds",
      "speechSource", "speechPurpose", "smallTalk",
    ])
    && isNonEmptyString(value.npcId)
    && typeof value.npcName === "string"
    && typeof value.npcRole === "string"
    && isStringArray(value.speechPages)
    && isStringArray(value.usedFactIds)
    && isStringArray(value.usedInteractionActionIds)
    && areUniqueNpcSpeechReferenceIds(value.usedFactIds)
    && areUniqueNpcSpeechReferenceIds(value.usedInteractionActionIds)
    && (value.speechSource === undefined || value.speechSource === "generated" || value.speechSource === "fixture")
    && (value.speechPurpose === undefined || value.speechPurpose === "focus" || value.speechPurpose === "ambient")
    && (value.smallTalk === undefined || (
      isRecord(value.smallTalk)
      && hasOnlyKeys(value.smallTalk, ["prompt", "response"])
      && typeof value.smallTalk.prompt === "string"
      && typeof value.smallTalk.response === "string"
    ));
}

function isScene(value: unknown): value is PreparedSceneSeedState {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "segments", "event", "npcLine", "npcDialogues", "objectiveLink", "choiceSeeds", "source",
  ])) return false;
  if (!Array.isArray(value.segments) || !value.segments.every((segment) => (
    isRecord(segment)
    && hasOnlyKeys(segment, ["beatId", "text", "referencedEntityIds"])
    && isNonEmptyString(segment.beatId)
    && isNonEmptyString(segment.text)
    && (segment.referencedEntityIds === undefined || isStringArray(segment.referencedEntityIds))
  ))) return false;
  if (!isNarrativeEvent(value.event)) return false;
  if (value.npcLine !== null && !isNpcLine(value.npcLine)) return false;
  if (value.npcDialogues !== undefined
    && (!Array.isArray(value.npcDialogues) || !value.npcDialogues.every(isNpcDialogue))) return false;
  if (value.objectiveLink !== null && !(
    isRecord(value.objectiveLink)
    && hasOnlyKeys(value.objectiveLink, ["questId", "objectiveIndex", "mode"])
    && isNonEmptyString(value.objectiveLink.questId)
    && Number.isInteger(value.objectiveLink.objectiveIndex)
    && (value.objectiveLink.objectiveIndex as number) >= 0
    && ["hint", "progress", "handoff"].includes(value.objectiveLink.mode as string)
  )) return false;
  if (!Array.isArray(value.choiceSeeds) || !value.choiceSeeds.every((choice) => (
    isRecord(choice)
    && hasOnlyKeys(choice, ["label", "action"])
    && isNonEmptyString(choice.label)
    && isAction(choice.action)
  ))) return false;
  return value.source === "generated" || value.source === "fixture";
}

function isStep(value: unknown): value is PreparedContinuationStepState {
  return isRecord(value)
    && hasOnlyKeys(value, [
      "stepId", "objectiveKey", "consumptionGroupKey", "trigger", "scene", "nextStepIds",
    ])
    && isNonEmptyString(value.stepId)
    && isNonEmptyString(value.objectiveKey)
    && isNonEmptyString(value.consumptionGroupKey)
    && isTrigger(value.trigger)
    && isScene(value.scene)
    && isStringArray(value.nextStepIds)
    && hasUniqueStrings(value.nextStepIds);
}

export function preparedContinuationTriggerKey(trigger: PreparedContinuationTrigger): string {
  switch (trigger.kind) {
    case "move":
      return `move:${String(trigger.locationId)}`;
    case "investigate":
      return `investigate:${String(trigger.factId)}:${trigger.approachId ?? ""}`;
    case "battle_started":
      return `battle_started:${String(trigger.enemyId)}`;
    case "battle_resolved":
      return `battle_resolved:${String(trigger.enemyId)}:${trigger.outcome}`;
  }
}

function isAcyclic(steps: readonly PreparedContinuationStepState[]): boolean {
  const byId = new Map(steps.map((step) => [step.stepId, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stepId: string): boolean => {
    if (visiting.has(stepId)) return false;
    if (visited.has(stepId)) return true;
    visiting.add(stepId);
    const step = byId.get(stepId);
    if (step === undefined || !step.nextStepIds.every(visit)) return false;
    visiting.delete(stepId);
    visited.add(stepId);
    return true;
  };

  return steps.every((step) => visit(step.stepId));
}

/**
 * Validates a persisted continuation graph without mutating or re-authoring it.
 * Provider output never determines IDs, graph edges, or active-step membership.
 */
export function createPreparedContinuationState(
  input: PreparedContinuationState,
): PreparedContinuationParseResult {
  return parsePreparedContinuationState(input);
}

/** Runtime-safe validator used by StoryState persistence parsing. */
export function parsePreparedContinuationState(value: unknown): PreparedContinuationParseResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ["originJobId", "steps", "activeStepIds"])) {
    return INVALID;
  }
  if (!isNonEmptyString(value.originJobId) || !Array.isArray(value.steps) || !value.steps.every(isStep)) {
    return INVALID;
  }
  if (!isStringArray(value.activeStepIds) || !hasUniqueStrings(value.activeStepIds)) return INVALID;

  const steps = value.steps as readonly PreparedContinuationStepState[];
  const stepIds = steps.map((step) => step.stepId);
  if (!hasUniqueStrings(stepIds)) return INVALID;
  if (steps.length > 0 && value.activeStepIds.length === 0) return INVALID;

  const knownStepIds = new Set(stepIds);
  if (!(value.activeStepIds as readonly string[]).every((stepId) => knownStepIds.has(stepId))) return INVALID;
  if (!steps.every((step) => step.nextStepIds.every((stepId) => knownStepIds.has(stepId)))) return INVALID;
  if (!isAcyclic(steps)) return INVALID;

  const siblingTriggerKeys = new Set<string>();
  for (const step of steps) {
    const key = `${step.consumptionGroupKey}\u0000${preparedContinuationTriggerKey(step.trigger)}`;
    if (siblingTriggerKeys.has(key)) return INVALID;
    siblingTriggerKeys.add(key);
  }

  return { ok: true, value: value as PreparedContinuationState };
}
