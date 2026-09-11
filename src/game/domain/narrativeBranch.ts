// 有界分支契约（Spec §5）。
//
// branch contract 只声明受支持的条件与效果类型：选择一个已批准的后续目标，
// 而不是任意效果 DSL。AI 只提议，服务端解析、批准并铸造正式 token。

import { parseExpressionTask, type ExpressionTask } from "./expressionTask";
import { DIALOGUE_ACTS, type DialogueAct, type StructuredDialogueTopic } from "./action";
import type { WorldDeltaProposal } from "./worldDelta";
import { asFactId, asQuestId } from "./worldEntity";
import {
  hasOnlyKeys,
  isPlainRecord,
  fail,
  parseKey,
  parseScenePoint,
  parseTextPart,
  type Check,
  type ScenePoint,
  type TextPart,
} from "./narrativeUnit";

export type RouteTarget =
  | { readonly kind: "talk_to_npc"; readonly npcId: string }
  | { readonly kind: "visit_location"; readonly locationId: string }
  | { readonly kind: "obtain_item"; readonly itemId: string }
  | { readonly kind: "discover_fact"; readonly factId: string }
  | { readonly kind: "defeat_enemy"; readonly enemyId: string };

export type BranchOption = {
  readonly candidateId: string;
  readonly dialogueAct: DialogueAct;
  readonly topic: StructuredDialogueTopic;
  readonly target: RouteTarget | null;
  readonly publicIntent: TextPart;
  readonly task?: ExpressionTask;
  /** 开局延迟地点定义：默认 null；非 null 时只允许 visit_location。 */
  readonly deferredLocation: WorldDeltaProposal["newLocation"];
};

export type Decision = {
  readonly kind: "ordinary";
  readonly point: ScenePoint;
  readonly npcId: string;
  readonly options: readonly [BranchOption, BranchOption];
};

export type EndingStance = "trust" | "doubt";

export type EndingOption = {
  readonly candidateId: EndingStance;
  readonly dialogueAct: "support" | "challenge";
  readonly publicIntent: TextPart;
};

/** 终幕候选完全由规则派生，不能由 PlanProposal.decision 输入。 */
export type EndingExpression = {
  readonly kind: "ending";
  readonly point: ScenePoint;
  readonly npcId: string;
  readonly options: readonly [EndingOption, EndingOption];
};

export type ChoiceExpression = Decision | EndingExpression;

/**
 * provider 在延迟地点分支里使用的局部符号：它只是「指向本候选自带定义」的占位，
 * 不是实体 ID。approveDecision 逐候选重建为服务端保留的真实品牌 ID 后才比较
 * target；本符号不得进入 registry / token / 事件。
 */
export const DEFERRED_LOCATION_ID_SYMBOL = "$deferred" as const;

const ROUTE_TARGET_KINDS: readonly RouteTarget["kind"][] = [
  "talk_to_npc",
  "visit_location",
  "obtain_item",
  "discover_fact",
  "defeat_enemy",
];

function parseRouteTarget(value: unknown): RouteTarget | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.kind !== "string" || !ROUTE_TARGET_KINDS.includes(value.kind as RouteTarget["kind"])) {
    return null;
  }
  switch (value.kind) {
    case "talk_to_npc": {
      if (!hasOnlyKeys(value, ["kind", "npcId"])) return null;
      const npcId = parseKey(value.npcId);
      return npcId === null ? null : { kind: "talk_to_npc", npcId };
    }
    case "visit_location": {
      if (!hasOnlyKeys(value, ["kind", "locationId"])) return null;
      const locationId = parseKey(value.locationId);
      return locationId === null ? null : { kind: "visit_location", locationId };
    }
    case "obtain_item": {
      if (!hasOnlyKeys(value, ["kind", "itemId"])) return null;
      const itemId = parseKey(value.itemId);
      return itemId === null ? null : { kind: "obtain_item", itemId };
    }
    case "discover_fact": {
      if (!hasOnlyKeys(value, ["kind", "factId"])) return null;
      const factId = parseKey(value.factId);
      return factId === null ? null : { kind: "discover_fact", factId };
    }
    case "defeat_enemy": {
      if (!hasOnlyKeys(value, ["kind", "enemyId"])) return null;
      const enemyId = parseKey(value.enemyId);
      return enemyId === null ? null : { kind: "defeat_enemy", enemyId };
    }
    default:
      return null;
  }
}

function parseTopic(value: unknown): StructuredDialogueTopic | null {
  if (!isPlainRecord(value)) return null;
  switch (value.kind) {
    case "general":
      return hasOnlyKeys(value, ["kind"]) ? { kind: "general" } : null;
    case "fact": {
      if (!hasOnlyKeys(value, ["kind", "factId"])) return null;
      const factId = parseKey(value.factId);
      return factId === null ? null : { kind: "fact", factId: asFactId(factId) };
    }
    case "quest": {
      if (!hasOnlyKeys(value, ["kind", "questId"])) return null;
      const questId = parseKey(value.questId);
      return questId === null ? null : { kind: "quest", questId: asQuestId(questId) };
    }
    case "thread": {
      if (!hasOnlyKeys(value, ["kind", "threadId"])) return null;
      const threadId = parseKey(value.threadId);
      return threadId === null ? null : { kind: "thread", threadId };
    }
    default:
      return null;
  }
}

/** 延迟地点只支持世界地图的场景级地点：不把 town_building 当 LocationEntry。 */
function parseDeferredLocation(value: unknown): WorldDeltaProposal["newLocation"] | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, ["name", "description", "scale", "placement", "connectFromLocationId"])) return null;
  if (value.placement !== "world" || value.scale !== "scene") return null;
  if (typeof value.name !== "string" || value.name.trim().length < 2) return null;
  if (typeof value.description !== "string" || value.description.trim() === "") return null;
  const connectFromLocationId = parseKey(value.connectFromLocationId);
  if (connectFromLocationId === null) return null;
  return {
    name: value.name.trim(),
    description: value.description.trim(),
    scale: "scene",
    placement: "world",
    connectFromLocationId,
  };
}

/** 逐字段重建分支候选；未知键、未知枚举与空意图一律拒绝。 */
export function parseBranchOption(raw: unknown): Check<BranchOption> {
  if (!isPlainRecord(raw)) return fail("branch_option_not_object");
  if (!hasOnlyKeys(raw, [
    "candidateId", "dialogueAct", "topic", "target", "publicIntent", "deferredLocation", "task",
  ])) return fail("branch_option_unknown_key");

  const candidateId = parseKey(raw.candidateId);
  if (candidateId === null) return fail("branch_option_candidate_invalid");
  if (typeof raw.dialogueAct !== "string" || !DIALOGUE_ACTS.includes(raw.dialogueAct as DialogueAct)) {
    return fail("branch_option_dialogue_act_invalid");
  }
  if (raw.topic === undefined) return fail("branch_option_topic_missing");
  const topic = parseTopic(raw.topic);
  if (topic === null) return fail("branch_option_topic_invalid");
  const target = parseRouteTarget(raw.target);
  if (raw.target !== null && target === null) return fail("branch_option_target_invalid");
  if (raw.publicIntent === undefined) return fail("branch_option_intent_missing");
  const publicIntent = parseTextPart(raw.publicIntent);
  if (publicIntent === null) return fail("branch_option_intent_invalid");
  const task = raw.task === undefined ? undefined : parseExpressionTask(raw.task);
  if (task === null || (task !== undefined && task.intent !== raw.dialogueAct)) return fail("branch_option_task_invalid");
  const deferredLocation = parseDeferredLocation(raw.deferredLocation ?? null);
  if (raw.deferredLocation !== null && raw.deferredLocation !== undefined && deferredLocation === null) {
    return fail("branch_option_deferred_location_invalid");
  }
  if (deferredLocation !== null && target?.kind !== "visit_location") {
    return fail("branch_option_deferred_target_mismatch");
  }
  return {
    ok: true,
    value: {
      candidateId,
      dialogueAct: raw.dialogueAct as DialogueAct,
      topic,
      target,
      publicIntent,
      ...(task === undefined ? {} : { task }),
      deferredLocation,
    },
  };
}

function parseOptionPair(
  value: unknown,
): Check<readonly [BranchOption, BranchOption]> {
  if (!Array.isArray(value) || value.length !== 2) return fail("decision_options_count_invalid");
  const first = parseBranchOption(value[0]);
  if (!first.ok) return first;
  const second = parseBranchOption(value[1]);
  if (!second.ok) return second;
  if (first.value.candidateId === second.value.candidateId) return fail("decision_options_duplicate");
  return { ok: true, value: [first.value, second.value] };
}

export function parseDecision(raw: unknown): Check<Decision> {
  if (!isPlainRecord(raw)) return fail("decision_not_object");
  if (!hasOnlyKeys(raw, ["kind", "point", "npcId", "options"])) return fail("decision_unknown_key");
  if (raw.kind !== "ordinary") return fail("decision_kind_invalid");
  const point = parseScenePoint(raw.point);
  if (point === null) return fail("decision_point_invalid");
  const npcId = parseKey(raw.npcId);
  if (npcId === null) return fail("decision_npc_invalid");
  const options = parseOptionPair(raw.options);
  if (!options.ok) return options;
  return { ok: true, value: { kind: "ordinary", point, npcId, options: options.value } };
}

function parseEndingOption(raw: unknown, expected: EndingStance): EndingOption | null {
  if (!isPlainRecord(raw)) return null;
  if (!hasOnlyKeys(raw, ["candidateId", "dialogueAct", "publicIntent"])) return null;
  if (raw.candidateId !== expected) return null;
  if (raw.dialogueAct !== (expected === "trust" ? "support" : "challenge")) return null;
  const publicIntent = parseTextPart(raw.publicIntent);
  if (publicIntent === null) return null;
  return { candidateId: expected, dialogueAct: expected === "trust" ? "support" : "challenge", publicIntent };
}

export function parseEndingExpression(raw: unknown): Check<EndingExpression> {
  if (!isPlainRecord(raw)) return fail("ending_expression_not_object");
  if (!hasOnlyKeys(raw, ["kind", "point", "npcId", "options"])) return fail("ending_expression_unknown_key");
  if (raw.kind !== "ending") return fail("ending_expression_kind_invalid");
  const point = parseScenePoint(raw.point);
  if (point === null) return fail("ending_expression_point_invalid");
  const npcId = parseKey(raw.npcId);
  if (npcId === null) return fail("ending_expression_npc_invalid");
  if (!Array.isArray(raw.options) || raw.options.length !== 2) return fail("ending_expression_options_count_invalid");
  const trust = parseEndingOption(raw.options[0], "trust");
  const doubt = parseEndingOption(raw.options[1], "doubt");
  if (trust === null || doubt === null) return fail("ending_expression_options_invalid");
  return { ok: true, value: { kind: "ending", point, npcId, options: [trust, doubt] } };
}
