// 分阶段剧情生成的表达契约（Spec 2026-09-09-staged-narrative-generation-design）。
//
// 本模块是四类生成职责共享的纯类型与严格解析层：不含 IO、AI 或规则审批。
// `Check` 让“解析失败”成为显式结果，调用方不能把未校验的 AI 输出当成合法输入。

import { parseExpressionTask, type ExpressionTask } from "./expressionTask";
import { NARRATIVE_EMOTIONS, type NarrativeEmotion } from "./narrative";
import type { MandatoryNarrativeBeat } from "./narrativeBeat";

// ---------------------------------------------------------------------------
// 共享结果类型
// ---------------------------------------------------------------------------

/** 逐字段重建的解析结果：`ok:false` 只携带稳定 code，不回显模型原文。 */
export type Check<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly detail?: string };

// ---------------------------------------------------------------------------
// 阶段与规模上限
// ---------------------------------------------------------------------------

/** 四类生成职责。planning 只产出骨架，不产出最终展示文本。 */
export type Stage = "planning" | "narration" | "character" | "choices";

/** 表达阶段：旁白、角色表现与选项表达。规划不属于表达单元。 */
export type ExpressionStage = Exclude<Stage, "planning">;

export const EXPRESSION_STAGES: readonly ExpressionStage[] = ["narration", "character", "choices"];

export const MAX_KEY_LENGTH = 128;
export const MAX_TEXT_PART_LENGTH = 500;
export const MAX_TEXT_PARTS = 12;
export const MAX_LABEL_LENGTH = 80;

// ---------------------------------------------------------------------------
// 引用与句段
// ---------------------------------------------------------------------------

export type ScenePoint = { readonly stepKey: string; readonly order: number };

export type FactUse = { readonly factId: string; readonly certainty: "known" | "suspected" };

/** 句段依据：已提交账本事件，或同包前序且条件可证明的观察。 */
export type EvidenceRef =
  | { readonly kind: "committed"; readonly eventId: string }
  | { readonly kind: "conditional"; readonly observationKey: string };

/** 无规则后果的表演动作：只供审批与旁白投影，其说明不是最终展示文本。 */
export type CosmeticAction = {
  readonly key: string;
  readonly actorId: string;
  readonly point: ScenePoint;
  readonly kind: "pause" | "look" | "gesture";
  readonly objectId: string | null;
  readonly audienceIds: readonly string[];
};

const COSMETIC_ACTION_KINDS: readonly CosmeticAction["kind"][] = ["pause", "look", "gesture"];

/** 服务端投影后的安全节拍：不含隐藏 instruction。 */
export type SafeBeat = {
  readonly beatId: string;
  readonly kind: MandatoryNarrativeBeat["kind"];
  readonly factIds: readonly string[];
  readonly evidence: readonly EvidenceRef[];
  readonly instruction: string;
};

/** 表达句段：正文 + 句段级事实/证据/节拍引用。 */
export type TextPart = {
  readonly text: string;
  readonly facts: readonly FactUse[];
  readonly evidence: readonly EvidenceRef[];
  readonly beatIds: readonly string[];
};

// ---------------------------------------------------------------------------
// 生成单元与输出
// ---------------------------------------------------------------------------

export type Unit = {
  readonly key: string;
  readonly stage: ExpressionStage;
  readonly point: ScenePoint;
  readonly speakerId: string | null;
  readonly dependencies: readonly string[];
  readonly taskFactIds: readonly string[];
  /** 缺省仅兼容旧内部产物；新 live 规划必须提供。 */
  readonly task?: ExpressionTask;
  readonly requiredObservationKeys: readonly string[];
  readonly requiredBeats: readonly SafeBeat[];
};

export type ChoiceLabel = { readonly candidateId: string; readonly label: string };

export type UnitOutput =
  | {
    readonly stage: "narration";
    readonly parts: readonly TextPart[];
    readonly actionKeys: readonly string[];
  }
  | {
    readonly stage: "character";
    readonly speakerId: string;
    readonly parts: readonly TextPart[];
    readonly emotion: NarrativeEmotion;
    readonly actions: readonly CosmeticAction[];
    readonly answeredBeatIds: readonly string[];
  }
  | {
    readonly stage: "choices";
    readonly labels: readonly ChoiceLabel[];
  };

// ---------------------------------------------------------------------------
// 解析工具
// ---------------------------------------------------------------------------

// 下面四个工具是 domain 内严格解析的公共前置：任何 AI 输出都必须先缩窄为
// 纯对象并核对键集合，不能直接类型断言成功。
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function fail(code: string): { readonly ok: false; readonly code: string } {
  return { ok: false, code };
}

function failWithDetail(code: string, detail: string): Check<never> {
  return { ok: false, code, detail };
}

/** key 是稳定身份：非空且受长度上限约束，避免模型用超长字符串充当身份。 */
export function parseKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || Array.from(trimmed).length > MAX_KEY_LENGTH) return null;
  return trimmed;
}

export function parseKeys(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const key = parseKey(item);
    if (key === null) return null;
    out.push(key);
  }
  return out;
}

export function parseScenePoint(value: unknown): ScenePoint | null {
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, ["stepKey", "order"])) return null;
  const stepKey = parseKey(value.stepKey);
  if (stepKey === null) return null;
  const order = value.order;
  if (typeof order !== "number" || !Number.isInteger(order) || order < 0) return null;
  return { stepKey, order };
}

export function parseEvidenceRef(value: unknown): EvidenceRef | null {
  if (!isPlainRecord(value)) return null;
  if (value.kind === "committed") {
    if (!hasOnlyKeys(value, ["kind", "eventId"])) return null;
    const eventId = parseKey(value.eventId);
    return eventId === null ? null : { kind: "committed", eventId };
  }
  if (value.kind === "conditional") {
    if (!hasOnlyKeys(value, ["kind", "observationKey"])) return null;
    const observationKey = parseKey(value.observationKey);
    return observationKey === null ? null : { kind: "conditional", observationKey };
  }
  return null;
}

function parseEvidence(value: unknown): readonly EvidenceRef[] | null {
  if (!Array.isArray(value)) return null;
  const out: EvidenceRef[] = [];
  for (const item of value) {
    const ref = parseEvidenceRef(item);
    if (ref === null) return null;
    out.push(ref);
  }
  return out;
}

function parseFactUse(value: unknown): FactUse | null {
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, ["factId", "certainty"])) return null;
  const factId = parseKey(value.factId);
  if (factId === null) return null;
  if (value.certainty !== "known" && value.certainty !== "suspected") return null;
  return { factId, certainty: value.certainty };
}

function parseFacts(value: unknown): readonly FactUse[] | null {
  if (!Array.isArray(value)) return null;
  const out: FactUse[] = [];
  for (const item of value) {
    const fact = parseFactUse(item);
    if (fact === null) return null;
    out.push(fact);
  }
  return out;
}

export function parseTextPart(value: unknown): TextPart | null {
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, ["text", "facts", "evidence", "beatIds"])) return null;
  if (typeof value.text !== "string") return null;
  const text = value.text.trim();
  const length = Array.from(text).length;
  if (length < 1 || length > MAX_TEXT_PART_LENGTH) return null;
  const facts = parseFacts(value.facts);
  if (facts === null) return null;
  const evidence = parseEvidence(value.evidence);
  if (evidence === null) return null;
  const beatIds = parseKeys(value.beatIds);
  if (beatIds === null) return null;
  return { text, facts, evidence, beatIds };
}

const BEAT_KIND_EXHAUSTIVE: Readonly<Record<MandatoryNarrativeBeat["kind"], true>> = {
  player_utterance: true,
  item_obtained: true,
  fact_discovered: true,
  quest_progress: true,
  quest_advanced: true,
  battle_started: true,
  battle_round: true,
  battle_resolved: true,
  entity_introduced: true,
  atmosphere: true,
};

const BEAT_KINDS: readonly string[] = Object.keys(BEAT_KIND_EXHAUSTIVE);

export function parseSafeBeat(value: unknown): SafeBeat | null {
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, ["beatId", "kind", "factIds", "evidence", "instruction"])) return null;
  const beatId = parseKey(value.beatId);
  if (beatId === null) return null;
  if (typeof value.kind !== "string" || !BEAT_KINDS.includes(value.kind)) return null;
  const factIds = parseKeys(value.factIds);
  if (factIds === null) return null;
  const evidence = parseEvidence(value.evidence);
  if (evidence === null) return null;
  if (typeof value.instruction !== "string" || value.instruction.trim() === "") return null;
  return {
    beatId,
    kind: value.kind as MandatoryNarrativeBeat["kind"],
    factIds,
    evidence,
    instruction: value.instruction.trim(),
  };
}

export function parseCosmeticAction(value: unknown): CosmeticAction | null {
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, ["key", "actorId", "point", "kind", "objectId", "audienceIds"])) return null;
  const key = parseKey(value.key);
  if (key === null) return null;
  const actorId = parseKey(value.actorId);
  if (actorId === null) return null;
  const point = parseScenePoint(value.point);
  if (point === null) return null;
  if (typeof value.kind !== "string" || !COSMETIC_ACTION_KINDS.includes(value.kind as CosmeticAction["kind"])) return null;
  const objectId = value.objectId === null ? null : parseKey(value.objectId);
  if (value.objectId !== null && objectId === null) return null;
  const audienceIds = parseKeys(value.audienceIds);
  if (audienceIds === null) return null;
  return {
    key,
    actorId,
    point,
    kind: value.kind as CosmeticAction["kind"],
    objectId,
    audienceIds,
  };
}

function parseTextParts(value: unknown): readonly TextPart[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_TEXT_PARTS) return null;
  const out: TextPart[] = [];
  for (const item of value) {
    const part = parseTextPart(item);
    if (part === null) return null;
    out.push(part);
  }
  return out;
}

export function parseUnit(value: unknown): Unit | null {
  if (!isPlainRecord(value)) return null;
  if (!hasOnlyKeys(value, [
    "key", "stage", "point", "speakerId", "dependencies",
    "taskFactIds", "requiredObservationKeys", "requiredBeats", "task",
  ])) return null;
  const key = parseKey(value.key);
  if (key === null) return null;
  if (typeof value.stage !== "string" || !EXPRESSION_STAGES.includes(value.stage as ExpressionStage)) return null;
  const stage = value.stage as ExpressionStage;
  const point = parseScenePoint(value.point);
  if (point === null) return null;
  const speakerId = value.speakerId === null ? null : parseKey(value.speakerId);
  if (value.speakerId !== null && speakerId === null) return null;
  const dependencies = parseKeys(value.dependencies);
  if (dependencies === null) return null;
  const taskFactIds = parseKeys(value.taskFactIds);
  if (taskFactIds === null) return null;
  const requiredObservationKeys = parseKeys(value.requiredObservationKeys);
  if (requiredObservationKeys === null) return null;
  if (!Array.isArray(value.requiredBeats)) return null;
  const requiredBeats: SafeBeat[] = [];
  for (const item of value.requiredBeats) {
    const beat = parseSafeBeat(item);
    if (beat === null) return null;
    requiredBeats.push(beat);
  }
  const task = value.task === undefined ? undefined : parseExpressionTask(value.task);
  if (task === null || (task !== undefined && stage === "narration" && task.intent !== "describe")) return null;
  return { key, stage, point, speakerId, dependencies, taskFactIds, requiredObservationKeys, requiredBeats,
    ...(task === undefined ? {} : { task }) };
}

/** 逐字段重建生成单元输出；未知字段、越界长度和未知枚举一律拒绝。 */
export function parseUnitOutput(raw: unknown): Check<UnitOutput> {
  if (!isPlainRecord(raw)) return fail("unit_output_not_object");
  const stage = raw.stage;
  if (typeof stage !== "string" || !EXPRESSION_STAGES.includes(stage as ExpressionStage)) {
    return failWithDetail("unit_output_stage_invalid",
      `stage: expected one of ${EXPRESSION_STAGES.join(", ")}`);
  }

  if (stage === "narration") {
    if (!hasOnlyKeys(raw, ["stage", "parts", "actionKeys"])) return fail("unit_output_unknown_key");
    const parts = parseTextParts(raw.parts);
    if (parts === null) return fail("unit_output_parts_invalid");
    const actionKeys = parseKeys(raw.actionKeys);
    if (actionKeys === null) return fail("unit_output_action_keys_invalid");
    return { ok: true, value: { stage: "narration", parts, actionKeys } };
  }

  if (stage === "character") {
    if (!hasOnlyKeys(raw, ["stage", "speakerId", "parts", "emotion", "actions", "answeredBeatIds"])) {
      return fail("unit_output_unknown_key");
    }
    const speakerId = parseKey(raw.speakerId);
    if (speakerId === null) return fail("unit_output_speaker_invalid");
    const parts = parseTextParts(raw.parts);
    if (parts === null) return fail("unit_output_parts_invalid");
    if (typeof raw.emotion !== "string" || !NARRATIVE_EMOTIONS.includes(raw.emotion as NarrativeEmotion)) {
      return fail("unit_output_emotion_invalid");
    }
    if (!Array.isArray(raw.actions)) return fail("unit_output_actions_invalid");
    const actions: CosmeticAction[] = [];
    for (const item of raw.actions) {
      const action = parseCosmeticAction(item);
      if (action === null) return fail("unit_output_actions_invalid");
      actions.push(action);
    }
    const answeredBeatIds = parseKeys(raw.answeredBeatIds);
    if (answeredBeatIds === null) return fail("unit_output_answered_beats_invalid");
    return {
      ok: true,
      value: {
        stage: "character",
        speakerId,
        parts,
        emotion: raw.emotion as NarrativeEmotion,
        actions,
        answeredBeatIds,
      },
    };
  }

  if (!hasOnlyKeys(raw, ["stage", "labels"])) return fail("unit_output_unknown_key");
  if (!Array.isArray(raw.labels) || raw.labels.length !== 2) return fail("unit_output_labels_count_invalid");
  const labels: ChoiceLabel[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.labels.entries()) {
    if (!isPlainRecord(item) || !hasOnlyKeys(item, ["candidateId", "label"])) {
      return fail("unit_output_label_shape_invalid");
    }
    const candidateId = parseKey(item.candidateId);
    if (candidateId === null) return fail("unit_output_candidate_invalid");
    if (seen.has(candidateId)) return fail("unit_output_candidate_duplicate");
    seen.add(candidateId);
    if (typeof item.label !== "string") return failWithDetail("unit_output_label_invalid",
      `labels[${index}].label: expected string`);
    const label = item.label.trim();
    const length = Array.from(label).length;
    if (length < 1 || length > MAX_LABEL_LENGTH) return failWithDetail("unit_output_label_invalid",
      `labels[${index}]: ${length} Unicode code points; maximum ${MAX_LABEL_LENGTH}`);
    labels.push({ candidateId, label });
  }
  return { ok: true, value: { stage: "choices", labels } };
}
