import type { NarrativeEmotion } from "./narrative";
import type { EntityId } from "./entity/entityCore";
import type { EventId } from "./events";
import type { FactId, NpcId } from "./worldEntity";

export type SceneExpressionProposal =
  | Readonly<{
      kind: "narration";
      beatId: string;
      text: string;
      referencedEntityIds: readonly string[];
    }>
  | Readonly<{
      kind: "npc_line";
      npcId: string;
      audienceIds: readonly string[];
      text: string;
      emotion: NarrativeEmotion;
      answeredBeatIds: readonly string[];
      usedFactIds: readonly string[];
      usedEventIds: readonly string[];
    }>;

export type ApprovedSceneExpression =
  | Readonly<{
      kind: "narration";
      beatId: string;
      text: string;
      referencedEntityIds: readonly EntityId[];
    }>
  | Readonly<{
      kind: "npc_line";
      npcId: NpcId;
      audienceIds: readonly EntityId[];
      text: string;
      emotion: NarrativeEmotion;
      answeredBeatIds: readonly string[];
      usedFactIds: readonly FactId[];
      usedEventIds: readonly EventId[];
    }>;

export type ParseSceneExpressionResult =
  | { readonly ok: true; readonly expressions: readonly SceneExpressionProposal[] }
  | { readonly ok: false; readonly code: "INVALID_SCENE_EXPRESSIONS"; readonly path: string };

const EMOTIONS: readonly string[] = ["neutral", "warm", "guarded", "afraid", "angry", "sad"];

/** Transitional adapter used while old offline fixtures are migrated. */
export function sceneExpressionsOf(input: {
  readonly expressions?: readonly SceneExpressionProposal[];
  readonly segments?: readonly { readonly beatId: string; readonly text: string; readonly referencedEntityIds?: readonly string[] }[];
  readonly npcLine?: {
    readonly npcId: string;
    readonly text: string;
    readonly emotion: NarrativeEmotion;
    readonly answeredBeatIds?: readonly string[];
    readonly usedFactIds: readonly string[];
    readonly usedEventIds: readonly string[];
  } | null;
}): readonly SceneExpressionProposal[] {
  if (input.expressions !== undefined) return input.expressions;
  return [
    ...(input.segments ?? []).map((segment): SceneExpressionProposal => ({
      kind: "narration",
      beatId: segment.beatId,
      text: segment.text,
      referencedEntityIds: [...(segment.referencedEntityIds ?? [])],
    })),
    ...(input.npcLine === undefined || input.npcLine === null ? [] : [{
      kind: "npc_line" as const,
      npcId: input.npcLine.npcId,
      audienceIds: ["player_0"],
      text: input.npcLine.text,
      emotion: input.npcLine.emotion,
      answeredBeatIds: [...(input.npcLine.answeredBeatIds ?? [])],
      usedFactIds: [...input.npcLine.usedFactIds],
      usedEventIds: [...input.npcLine.usedEventIds],
    }]),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isString);
}

export type SceneStructuralIssue = Readonly<{ path: string; kind: "unknown field"; allowedKeys: readonly string[] }>;
type StructuralIssueHandler = (issue: SceneStructuralIssue) => void;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, onIssue?: StructuralIssueHandler): boolean {
  const expected = new Set(keys);
  const unknown = Object.keys(value).find(key => !expected.has(key));
  if (unknown !== undefined) onIssue?.({ path: `${path}.${unknown}`, kind: "unknown field", allowedKeys: keys });
  return Object.keys(value).length === keys.length && unknown === undefined;
}

function isExpression(value: unknown, path: string, onIssue?: StructuralIssueHandler): value is SceneExpressionProposal {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "narration") {
    return hasExactKeys(value, ["kind", "beatId", "text", "referencedEntityIds"], path, onIssue)
      && isNonEmptyString(value.beatId)
      && isNonEmptyString(value.text)
      && isStringArray(value.referencedEntityIds);
  }
  if (value.kind === "npc_line") {
    if (!hasExactKeys(value, [
      "kind", "npcId", "audienceIds", "text", "emotion", "answeredBeatIds", "usedFactIds", "usedEventIds",
    ], path, onIssue)) return false;
    return isNonEmptyString(value.npcId)
      && isStringArray(value.audienceIds)
      && isNonEmptyString(value.text)
      && EMOTIONS.includes(value.emotion as string)
      && isStringArray(value.answeredBeatIds)
      && isStringArray(value.usedFactIds)
      && isStringArray(value.usedEventIds)
      && new Set(value.audienceIds).size === value.audienceIds.length
      && new Set(value.usedFactIds).size === value.usedFactIds.length
      && new Set(value.usedEventIds).size === value.usedEventIds.length;
  }
  return false;
}

/** Parse the only ordered scene body. Array position is the expression order. */
export function parseSceneExpressionProposal(value: unknown, onIssue?: StructuralIssueHandler): ParseSceneExpressionResult {
  if (!Array.isArray(value)) return { ok: false, code: "INVALID_SCENE_EXPRESSIONS", path: "expressions" };
  for (const [index, expression] of value.entries()) {
    if (!isExpression(expression, `expressions[${index}]`, onIssue)) {
      return { ok: false, code: "INVALID_SCENE_EXPRESSIONS", path: `expressions[${index}]` };
    }
  }
  return { ok: true, expressions: value };
}

export function sceneExpressionText(expression: SceneExpressionProposal): string {
  return expression.text;
}

export function sceneExpressionAudienceIds(expression: SceneExpressionProposal): readonly string[] {
  return expression.kind === "npc_line" ? expression.audienceIds : [];
}
