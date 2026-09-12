import type { NarrativeEmotion } from "./narrative";
import type { NarrativeJobId } from "./events";
import type {
  EnemyId,
  FactId,
  ItemId,
  LocationId,
  NpcId,
} from "./worldEntity";
import type { PreparedSceneSeedState } from "./preparedContinuation";
import { areUniqueNpcSpeechReferenceIds } from "./npcSpeechReferences";
import { parseSceneExpressionProposal, type SceneExpressionProposal } from "./sceneExpression";

// ---------------------------------------------------------------------------
// Pure value types moved from application/sceneSource.ts so domain code does
// not import from application. sceneSource.ts re-exports these temporarily
// until Task 10 removes it.
// ---------------------------------------------------------------------------

/** 场景表演的一段旁白：必须对应服务端提供的强制节拍 ID（atmosphere 可选且最后）。 */
export type ScenePerformanceSegment = {
  readonly beatId: string;
  readonly text: string;
  readonly referencedEntityIds?: readonly string[];
};

/** 焦点 NPC 的台词：所有引用（事实/交互）必须归属该 NPC 的允许集合。 */
export type ScenePerformanceNpcLine = {
  readonly npcId: string;
  readonly text: string;
  readonly emotion: NarrativeEmotion;
  readonly answeredBeatIds: readonly string[];
  readonly usedFactIds: readonly string[];
  readonly usedEventIds: readonly string[];
};

/** 同一场景 API 为非焦点 NPC 生成的零回合闲聊台词。 */
export type ScenePerformanceNpcDialogue = {
  readonly npcId: string;
  readonly text: string;
  readonly usedFactIds: readonly string[];
  readonly usedEventIds: readonly string[];
};

/** objectiveLink 必须与 ObjectiveTransition.after 一致（无 after 时必须为 null）。 */
export type ScenePerformanceObjectiveLink = {
  readonly questId: string;
  readonly objectiveIndex: number;
  readonly mode: "hint" | "progress" | "handoff";
};

// ---------------------------------------------------------------------------
// Bundle proposal contract
// ---------------------------------------------------------------------------

export const MAX_NARRATIVE_BUNDLE_STEPS = 12 as const;

export type NarrativeSymbolRef =
  | "@current.location"
  | "@current.focus_npc"
  | "@new.location"
  | "@new.npc"
  | "@new.item"
  | "@new.enemy"
  | "@new.fact"
  | "@new.quest"
  | "@ending.trust"
  | "@ending.doubt";

export type NarrativeBundleTerminal =
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } }
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "continuation_step"; readonly stepKey: string } }
  | { readonly kind: "ending" };

export type BundleSceneProposal = {
  /** Bundle2 ordered expression body. Legacy fields remain accepted only as an input adapter. */
  readonly expressions?: readonly SceneExpressionProposal[];
  readonly segments?: readonly ScenePerformanceSegment[];
  readonly npcLine?: ScenePerformanceNpcLine | null;
  readonly npcDialogues?: readonly ScenePerformanceNpcDialogue[];
  readonly objectiveLink: ScenePerformanceObjectiveLink | null;
  readonly choices: readonly { readonly candidateId: string; readonly label: string }[];
  readonly handoffAcknowledgement?: string;
};

export type BundleStepProposal = {
  readonly stepKey: string;
  readonly scene: BundleSceneProposal;
};

export type NarrativeBundleProposal = {
  readonly worldDelta: unknown | null;
  readonly currentScene: BundleSceneProposal;
  readonly continuationScenes: readonly BundleStepProposal[];
  readonly terminal: NarrativeBundleTerminal;
};

// ---------------------------------------------------------------------------
// Replacement one-shot trigger union (additive — Task 7 migrates consumers)
// ---------------------------------------------------------------------------

export type NarrativeBundleTrigger =
  | { readonly kind: "move"; readonly locationId: LocationId }
  | { readonly kind: "explore"; readonly locationId: LocationId }
  | { readonly kind: "investigate"; readonly factId: FactId; readonly approachId?: string }
  | { readonly kind: "take_item"; readonly itemId: ItemId }
  | { readonly kind: "give_item"; readonly itemId: ItemId; readonly npcId: NpcId }
  | { readonly kind: "battle_started"; readonly enemyId: EnemyId }
  | { readonly kind: "battle_resolved"; readonly enemyId: EnemyId; readonly outcome: "victory" };

export function narrativeBundleTriggerKey(trigger: NarrativeBundleTrigger): string {
  switch (trigger.kind) {
    case "move":
      return `move:${String(trigger.locationId)}`;
    case "explore":
      return `explore:${String(trigger.locationId)}`;
    case "investigate":
      return `investigate:${String(trigger.factId)}:${trigger.approachId ?? ""}`;
    case "take_item":
      return `take_item:${String(trigger.itemId)}`;
    case "give_item":
      return `give_item:${String(trigger.itemId)}:${String(trigger.npcId)}`;
    case "battle_started":
      return `battle_started:${String(trigger.enemyId)}`;
    case "battle_resolved":
      return `battle_resolved:${trigger.outcome}:${String(trigger.enemyId)}`;
  }
}

// ---------------------------------------------------------------------------
// Approved bundle state (persisted)
// ---------------------------------------------------------------------------

export type NarrativeBundleTerminalState =
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "current_scene" } }
  | { readonly kind: "next_decision"; readonly target: { readonly kind: "continuation_step"; readonly stepId: string } }
  | { readonly kind: "ending" };

export type NarrativeBundleStepState = {
  readonly stepId: string;
  readonly objectiveKey: string;
  readonly consumptionGroupKey: string;
  readonly trigger: NarrativeBundleTrigger;
  readonly scene: PreparedSceneSeedState;
  readonly nextStepIds: readonly string[];
};

export type NarrativeBundleState = {
  readonly contractVersion: 2;
  readonly originJobId: NarrativeJobId;
  readonly steps: readonly NarrativeBundleStepState[];
  readonly activeStepIds: readonly string[];
  readonly terminal: NarrativeBundleTerminalState;
};

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * 提案契约的细分拒绝原因。整包仍然只按同一套规则严格校验，
 * 这里只是把"哪一条规则没满足"带出来，供修复重试回传给 provider。
 * 运行时清单供类型派生与持久化细分码白名单共用，新增码自动进入白名单。
 */
export const NARRATIVE_BUNDLE_PROPOSAL_REJECTION_REASONS = [
  "not_object",
  "unknown_keys",
  "current_scene_invalid",
  "continuation_scenes_invalid",
  "terminal_invalid",
  "current_scene_terminal_requires_empty_continuation",
  "current_scene_terminal_requires_two_choices",
  "continuation_terminal_requires_continuation_scenes",
  "current_scene_must_have_no_choices",
  "continuation_terminal_step_not_found",
  "terminal_step_requires_two_choices",
  "non_terminal_step_must_have_no_choices",
  "ending_terminal_requires_empty_bundle",
  "too_many_steps",
  "duplicate_step_keys",
] as const;

export type NarrativeBundleProposalRejectionReason = typeof NARRATIVE_BUNDLE_PROPOSAL_REJECTION_REASONS[number];

export type ParseNarrativeBundleProposalResult =
  | { readonly ok: true; readonly proposal: NarrativeBundleProposal }
  | {
    readonly ok: false;
    readonly code: "INVALID_NARRATIVE_BUNDLE_PROPOSAL";
    readonly reason: NarrativeBundleProposalRejectionReason;
    readonly stepKey?: string;
  };

export type ParseNarrativeBundleStateResult =
  | { readonly ok: true; readonly value: NarrativeBundleState }
  | { readonly ok: false; readonly code: "INVALID_NARRATIVE_BUNDLE_STATE" };

function invalidProposal(
  reason: NarrativeBundleProposalRejectionReason,
  stepKey?: string,
): ParseNarrativeBundleProposalResult {
  return {
    ok: false,
    code: "INVALID_NARRATIVE_BUNDLE_PROPOSAL",
    reason,
    ...(stepKey === undefined ? {} : { stepKey }),
  };
}

const INVALID_STATE: ParseNarrativeBundleStateResult = {
  ok: false,
  code: "INVALID_NARRATIVE_BUNDLE_STATE",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
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

function hasExactlyTwoDistinctChoices(scene: BundleSceneProposal): boolean {
  return scene.choices.length === 2
    && hasUniqueStrings(scene.choices.map((choice) => choice.candidateId));
}

const NARRATIVE_EMOTIONS: readonly string[] = [
  "neutral", "warm", "guarded", "afraid", "angry", "sad",
];

function isScenePerformanceSegment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["beatId", "text", "referencedEntityIds"])) return false;
  if (!isNonEmptyString(value.beatId) || !isNonEmptyString(value.text)) return false;
  return value.referencedEntityIds === undefined || isStringArray(value.referencedEntityIds);
}

function isScenePerformanceNpcLine(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["npcId", "text", "emotion", "answeredBeatIds", "usedFactIds", "usedEventIds"])) return false;
  return isNonEmptyString(value.npcId)
    && isNonEmptyString(value.text)
    && NARRATIVE_EMOTIONS.includes(value.emotion as string)
    && isStringArray(value.answeredBeatIds)
    && isStringArray(value.usedFactIds)
    && isStringArray(value.usedEventIds)
    && areUniqueNpcSpeechReferenceIds(value.usedFactIds)
    && areUniqueNpcSpeechReferenceIds(value.usedEventIds);
}

function isScenePerformanceNpcDialogue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["npcId", "text", "usedFactIds", "usedEventIds"])) return false;
  return isNonEmptyString(value.npcId)
    && isNonEmptyString(value.text)
    && isStringArray(value.usedFactIds)
    && isStringArray(value.usedEventIds)
    && areUniqueNpcSpeechReferenceIds(value.usedFactIds)
    && areUniqueNpcSpeechReferenceIds(value.usedEventIds);
}

function isScenePerformanceObjectiveLink(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["questId", "objectiveIndex", "mode"])) return false;
  return isNonEmptyString(value.questId)
    && Number.isInteger(value.objectiveIndex)
    && (value.objectiveIndex as number) >= 0
    && ["hint", "progress", "handoff"].includes(value.mode as string);
}

function isChoiceCandidate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["candidateId", "label"])) return false;
  return isNonEmptyString(value.candidateId) && isNonEmptyString(value.label);
}

function isBundleSceneProposal(value: unknown): value is BundleSceneProposal {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["expressions", "segments", "npcLine", "npcDialogues", "objectiveLink", "choices", "handoffAcknowledgement"])) return false;
  if (value.expressions !== undefined && !parseSceneExpressionProposal(value.expressions).ok) return false;
  if (value.segments !== undefined && (!Array.isArray(value.segments) || !value.segments.every(isScenePerformanceSegment))) return false;
  if (value.expressions === undefined && value.segments === undefined) return false;
  if (value.npcLine !== undefined && value.npcLine !== null && !isScenePerformanceNpcLine(value.npcLine)) return false;
  if (value.npcDialogues !== undefined && (!Array.isArray(value.npcDialogues) || !value.npcDialogues.every(isScenePerformanceNpcDialogue))) return false;
  if (value.objectiveLink !== null && !isScenePerformanceObjectiveLink(value.objectiveLink)) return false;
  if (!Array.isArray(value.choices) || !value.choices.every(isChoiceCandidate)) return false;
  return value.handoffAcknowledgement === undefined || isNonEmptyString(value.handoffAcknowledgement);
}

function isTerminal(value: unknown): value is NarrativeBundleTerminal {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "ending":
      return hasOnlyKeys(value, ["kind"]);
    case "next_decision": {
      if (!hasOnlyKeys(value, ["kind", "target"])) return false;
      const target = value.target as unknown;
      if (!isRecord(target) || typeof target.kind !== "string") return false;
      switch (target.kind) {
        case "current_scene":
          return hasOnlyKeys(target, ["kind"]);
        case "continuation_step":
          return hasOnlyKeys(target, ["kind", "stepKey"]) && isNonEmptyString(target.stepKey);
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

function isBundleStepProposal(value: unknown): value is BundleStepProposal {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["stepKey", "scene"])) return false;
  return isNonEmptyString(value.stepKey) && isBundleSceneProposal(value.scene);
}

export function parseNarrativeBundleProposal(value: unknown): ParseNarrativeBundleProposalResult {
  if (!isRecord(value)) return invalidProposal("not_object");
  if (!hasOnlyKeys(value, ["worldDelta", "currentScene", "continuationScenes", "terminal"])) return invalidProposal("unknown_keys");
  // worldDelta can be null or any object (approval validates it separately)
  if (!isBundleSceneProposal(value.currentScene)) return invalidProposal("current_scene_invalid");
  if (!Array.isArray(value.continuationScenes) || !value.continuationScenes.every(isBundleStepProposal)) return invalidProposal("continuation_scenes_invalid");
  if (!isTerminal(value.terminal)) return invalidProposal("terminal_invalid");

  const continuationScenes = value.continuationScenes as readonly BundleStepProposal[];
  const terminal = value.terminal as NarrativeBundleTerminal;

  // current_scene terminal must have empty continuation
  if (terminal.kind === "next_decision" && terminal.target.kind === "current_scene") {
    if (continuationScenes.length > 0) return invalidProposal("current_scene_terminal_requires_empty_continuation");
    if (!hasExactlyTwoDistinctChoices(value.currentScene)) return invalidProposal("current_scene_terminal_requires_two_choices");
  }

  // continuation_step terminal must have at least one continuation scene
  if (terminal.kind === "next_decision" && terminal.target.kind === "continuation_step") {
    if (continuationScenes.length === 0) return invalidProposal("continuation_terminal_requires_continuation_scenes");
    if (value.currentScene.choices.length !== 0) return invalidProposal("current_scene_must_have_no_choices");
    const stepKeys = continuationScenes.map((s) => s.stepKey);
    if (!stepKeys.includes(terminal.target.stepKey)) {
      return invalidProposal("continuation_terminal_step_not_found", terminal.target.stepKey);
    }
    for (const step of continuationScenes) {
      if (step.stepKey === terminal.target.stepKey) {
        if (!hasExactlyTwoDistinctChoices(step.scene)) return invalidProposal("terminal_step_requires_two_choices", step.stepKey);
      } else if (step.scene.choices.length !== 0) {
        return invalidProposal("non_terminal_step_must_have_no_choices", step.stepKey);
      }
    }
  }

  // ending terminal must have empty continuation
  if (terminal.kind === "ending") {
    if (continuationScenes.length > 0 || value.currentScene.choices.length !== 0) {
      return invalidProposal("ending_terminal_requires_empty_bundle");
    }
  }

  // step limit
  if (continuationScenes.length > MAX_NARRATIVE_BUNDLE_STEPS) return invalidProposal("too_many_steps");

  // duplicate step keys
  const stepKeys = continuationScenes.map((s) => s.stepKey);
  if (!hasUniqueStrings(stepKeys)) return invalidProposal("duplicate_step_keys");

  return { ok: true, proposal: value as NarrativeBundleProposal };
}

// ---------------------------------------------------------------------------
// NarrativeBundleState parser
// ---------------------------------------------------------------------------

const BUNDLE_TRIGGER_KINDS = new Set([
  "move", "explore", "investigate", "take_item", "give_item",
  "battle_started", "battle_resolved",
]);

function isBundleTrigger(value: unknown): value is NarrativeBundleTrigger {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (!BUNDLE_TRIGGER_KINDS.has(value.kind)) return false;
  switch (value.kind) {
    case "move":
      return hasOnlyKeys(value, ["kind", "locationId"]) && isNonEmptyString(value.locationId);
    case "explore":
      return hasOnlyKeys(value, ["kind", "locationId"]) && isNonEmptyString(value.locationId);
    case "investigate":
      return hasOnlyKeys(value, ["kind", "factId", "approachId"])
        && isNonEmptyString(value.factId)
        && (value.approachId === undefined || isNonEmptyString(value.approachId));
    case "take_item":
      return hasOnlyKeys(value, ["kind", "itemId"]) && isNonEmptyString(value.itemId);
    case "give_item":
      return hasOnlyKeys(value, ["kind", "itemId", "npcId"])
        && isNonEmptyString(value.itemId)
        && isNonEmptyString(value.npcId);
    case "battle_started":
      return hasOnlyKeys(value, ["kind", "enemyId"]) && isNonEmptyString(value.enemyId);
    case "battle_resolved":
      return hasOnlyKeys(value, ["kind", "enemyId", "outcome"])
        && isNonEmptyString(value.enemyId)
        && value.outcome === "victory";
    default:
      return false;
  }
}

function isTerminalState(value: unknown): value is NarrativeBundleTerminalState {
  if (!isRecord(value)) return false;
  if (typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "ending":
      return hasOnlyKeys(value, ["kind"]);
    case "next_decision": {
      if (!hasOnlyKeys(value, ["kind", "target"])) return false;
      const target = value.target as unknown;
      if (!isRecord(target) || typeof target.kind !== "string") return false;
      switch (target.kind) {
        case "current_scene":
          return hasOnlyKeys(target, ["kind"]);
        case "continuation_step":
          return hasOnlyKeys(target, ["kind", "stepId"]) && isNonEmptyString(target.stepId);
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

// PreparedSceneSeedState validation is delegated to parsePreparedContinuationState's
// internal isScene validator. For the bundle state parser we do a structural
// check using the same rules.  Since we can't import application code, we
// validate the scene shape inline.
function isPreparedSceneSeedState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["expressions", "segments", "event", "npcLine", "npcDialogues", "objectiveLink", "choiceSeeds", "source"])) return false;
  if (value.expressions !== undefined && !parseSceneExpressionProposal(value.expressions).ok) return false;
  if (value.expressions === undefined && value.segments === undefined) return false;
  if (value.segments !== undefined && (!Array.isArray(value.segments) || !value.segments.every((seg) => (
    isRecord(seg)
    && hasOnlyKeys(seg, ["beatId", "text", "referencedEntityIds"])
    && isNonEmptyString(seg.beatId)
    && isNonEmptyString(seg.text)
    && (seg.referencedEntityIds === undefined || isStringArray(seg.referencedEntityIds))
  )))) return false;
  // event validation
  const event = value.event as unknown;
  if (!isRecord(event) || typeof event.kind !== "string") return false;
  switch (event.kind) {
    case "dialogue":
      if (!hasOnlyKeys(event, ["kind", "focusNpcId"]) || !isNonEmptyString(event.focusNpcId)) return false;
      break;
    case "investigate":
      if (!hasOnlyKeys(event, ["kind", "factId"]) || !isNonEmptyString(event.factId)) return false;
      break;
    case "item":
      if (!hasOnlyKeys(event, ["kind", "itemId"]) || !isNonEmptyString(event.itemId)) return false;
      break;
    case "battle":
      if (!hasOnlyKeys(event, ["kind", "enemyId"]) || !isNonEmptyString(event.enemyId)) return false;
      break;
    case "travel":
    case "observe":
      if (!hasOnlyKeys(event, ["kind", "locationId"]) || !isNonEmptyString(event.locationId)) return false;
      break;
    default:
      return false;
  }
  // npcLine
  if (value.npcLine !== null) {
    const line = value.npcLine as unknown;
    if (!isRecord(line)
      || !hasOnlyKeys(line, ["npcId", "text", "emotion", "usedFactIds", "usedEventIds", "answeredBeatIds"])
      || !isNonEmptyString(line.npcId)
      || !isNonEmptyString(line.text)
      || !NARRATIVE_EMOTIONS.includes(line.emotion as string)
      || !isStringArray(line.usedFactIds)
      || !isStringArray(line.usedEventIds)
      || !areUniqueNpcSpeechReferenceIds(line.usedFactIds)
      || !areUniqueNpcSpeechReferenceIds(line.usedEventIds)
      || (line.answeredBeatIds !== undefined && !isStringArray(line.answeredBeatIds))) return false;
  }
  if (value.npcDialogues !== undefined) {
    if (!Array.isArray(value.npcDialogues)) return false;
    for (const dialogue of value.npcDialogues) {
      if (!isRecord(dialogue)
        || !hasOnlyKeys(dialogue, [
          "npcId", "npcName", "npcRole", "speechPages", "usedFactIds", "usedEventIds",
          "speechSource", "speechPurpose", "smallTalk",
        ])
        || !isNonEmptyString(dialogue.npcId)
        || typeof dialogue.npcName !== "string"
        || typeof dialogue.npcRole !== "string"
        || !isStringArray(dialogue.speechPages)
        || !isStringArray(dialogue.usedFactIds)
        || !isStringArray(dialogue.usedEventIds)
        || !areUniqueNpcSpeechReferenceIds(dialogue.usedFactIds)
        || !areUniqueNpcSpeechReferenceIds(dialogue.usedEventIds)) return false;
    }
  }
  // objectiveLink
  if (value.objectiveLink !== null) {
    if (!isScenePerformanceObjectiveLink(value.objectiveLink)) return false;
  }
  // choiceSeeds
  if (!Array.isArray(value.choiceSeeds)) return false;
  // source
  return value.source === "generated" || value.source === "fixture";
}

function isBundleStepState(value: unknown): value is NarrativeBundleStepState {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["stepId", "objectiveKey", "consumptionGroupKey", "trigger", "scene", "nextStepIds"])) return false;
  return isNonEmptyString(value.stepId)
    && isNonEmptyString(value.objectiveKey)
    && isNonEmptyString(value.consumptionGroupKey)
    && isBundleTrigger(value.trigger)
    && isPreparedSceneSeedState(value.scene)
    && isStringArray(value.nextStepIds);
}

function isAcyclic(steps: readonly NarrativeBundleStepState[]): boolean {
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

export function parseNarrativeBundleState(value: unknown): ParseNarrativeBundleStateResult {
  if (!isRecord(value)) return INVALID_STATE;
  if (!hasOnlyKeys(value, ["contractVersion", "originJobId", "steps", "activeStepIds", "terminal"])) return INVALID_STATE;
  if (value.contractVersion !== 2) return INVALID_STATE;
  if (!isNonEmptyString(value.originJobId)) return INVALID_STATE;
  if (!Array.isArray(value.steps) || !value.steps.every(isBundleStepState)) return INVALID_STATE;
  if (!isStringArray(value.activeStepIds) || !hasUniqueStrings(value.activeStepIds)) return INVALID_STATE;
  if (!isTerminalState(value.terminal)) return INVALID_STATE;

  const steps = value.steps as readonly NarrativeBundleStepState[];
  const stepIds = steps.map((s) => s.stepId);
  if (!hasUniqueStrings(stepIds)) return INVALID_STATE;

  // steps exist → activeStepIds must be non-empty
  if (steps.length > 0 && value.activeStepIds.length === 0) return INVALID_STATE;

  // active step IDs must reference known steps
  const knownStepIds = new Set(stepIds);
  if (!(value.activeStepIds as readonly string[]).every((id) => knownStepIds.has(id))) return INVALID_STATE;

  // nextStepIds must reference known steps
  if (!steps.every((s) => s.nextStepIds.every((id) => knownStepIds.has(id)))) return INVALID_STATE;

  // no cycles
  if (!isAcyclic(steps)) return INVALID_STATE;

  // step limit
  if (steps.length > MAX_NARRATIVE_BUNDLE_STEPS) return INVALID_STATE;

  // duplicate trigger siblings
  const siblingTriggerKeys = new Set<string>();
  for (const step of steps) {
    const key = `${step.consumptionGroupKey}\u0000${narrativeBundleTriggerKey(step.trigger)}`;
    if (siblingTriggerKeys.has(key)) return INVALID_STATE;
    siblingTriggerKeys.add(key);
  }

  const terminal = value.terminal as NarrativeBundleTerminalState;

  // continuation_step terminal: stepId must exist
  if (terminal.kind === "next_decision" && terminal.target.kind === "continuation_step") {
    if (!knownStepIds.has(terminal.target.stepId)) return INVALID_STATE;
  }

  // current_scene terminal: no continuation steps
  if (terminal.kind === "next_decision" && terminal.target.kind === "current_scene") {
    if (steps.length > 0) return INVALID_STATE;
  }

  // ending terminal: no continuation steps
  if (terminal.kind === "ending") {
    if (steps.length > 0) return INVALID_STATE;
  }

  return { ok: true, value: value as NarrativeBundleState };
}
