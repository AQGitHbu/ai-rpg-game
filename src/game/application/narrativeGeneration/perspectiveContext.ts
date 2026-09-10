// 单角色 / 玩家视角的安全上下文投影（Spec 2026-09-09 / Plan Task 4）。
//
// projectUnitContext 把已审批计划投影成某一类表达单元（旁白/角色/选项）可以
// 看到的 SafeContext：人格只保留结构化公开面，可说事实 = 说话人可知 ∩ 对受众
// 可披露（复用 buildNpcSpeechAuthority 这把唯一的披露门尺），前文只含依赖单元
// 的已批准表达。无法证明安全的自由文本（legacy 导入的锚点正文、目标 reason、
// 描述、任务名、隐藏事实）一律不进入 DTO——不是删敏感词，而是按来源放行。
// 秘密用唯一 sentinel 断言（见测试），fail-closed：未知单元/未知说话人直接拒绝。

import {
  fail,
  type Check,
  type CosmeticAction,
  type EvidenceRef,
  type SafeBeat,
  type TextPart,
  type Unit,
  type UnitOutput,
} from "@/game/domain/narrativeUnit";
import type { DialogueAct } from "@/game/domain/action";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import { PLAYER_ENTITY_ID, asFactId } from "@/game/domain/worldEntity";
import {
  getEntity,
  LEGACY_IMPORT_REASON_KEY,
  type EntityRecord,
  type FactEntityRecord,
  type NpcEntityRecord,
} from "@/game/domain/entity";
import type { WorldState } from "@/game/domain/worldState";
import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { observationsForUnit } from "@/game/gameplay/rpg/narrativePlanning";
import {
  buildNpcSpeechAuthority,
  type NpcSpeechAuthority,
} from "@/game/application/npcSpeechAuthority";

function isFactRecord(record: EntityRecord | undefined): record is FactEntityRecord {
  return record !== undefined && record.core.kind === "fact";
}

function isNpcRecord(record: EntityRecord | undefined): record is NpcEntityRecord {
  return record !== undefined && record.core.kind === "npc";
}

// ---------------------------------------------------------------------------
// 安全 DTO 类型
// ---------------------------------------------------------------------------

/**
 * 人格的公开投影：只含结构化身份（name/role/emotion/关系档位）与受控行为。
 * anchors/goals 只收非 legacy 导入的条目；长期禁区（taboos）整组不回传——
 * 「不能谈什么」转为受控 behavior，不携带原文。
 */
export type SafePersona = Readonly<{
  publicName: string;
  publicRole: TextPart;
  anchors: readonly TextPart[];
  goals: readonly TextPart[];
  emotion: NarrativeEmotion;
  relationshipTier: string;
  behavior: readonly ("answer_directly" | "withhold_source" | "express_uncertainty")[];
}>;

export type SafeFact = Readonly<{
  id: string;
  text: string;
  certainty: "known" | "suspected";
  sources: readonly EvidenceRef[];
}>;

export type SafeOption = Readonly<{
  candidateId: string;
  dialogueAct: DialogueAct;
  publicIntent: TextPart;
}>;

/**
 * 本单元必须披露的观察的安全投影：只给观察键与它引用的事实键/certainty，
 * 不含受众、来源细节或任何隐藏事实。角色 prompt 靠它声明披露义务，
 * 与 collectDisclosures 的判定同源。
 */
export type SafeObservation = Readonly<{
  key: string;
  factId: string;
  certainty: "known" | "suspected";
}>;

export type SafeContext = Readonly<{
  unit: Unit;
  persona: SafePersona | null;
  visibleFacts: readonly SafeFact[];
  priorText: readonly TextPart[];
  allowedActions: readonly CosmeticAction[];
  options: readonly SafeOption[];
  playerUtterance: string | null;
  style: string;
  requiredBeats: readonly SafeBeat[];
  requiredObservations: readonly SafeObservation[];
  choiceKind: "ordinary" | "ending" | null;
}>;

// ---------------------------------------------------------------------------
// 投影原语
// ---------------------------------------------------------------------------

/** 玩家视角的可见事实：discovered 全集（旁白与选项单元的可见面）。 */
function discoveredFacts(ws: WorldState): readonly SafeFact[] {
  return ws.entityStore.records
    .filter((record): record is FactEntityRecord => isFactRecord(record) && record.fact.discovered)
    .map((record) => ({
      id: String(record.core.id),
      text: record.fact.text,
      certainty: "known" as const,
      sources: [] as readonly EvidenceRef[],
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** 角色视角的可见事实：authority.allowedFactIds（可知 ∩ 对受众可披露）。 */
function speakerVisibleFacts(
  ws: WorldState,
  speaker: NpcEntityRecord,
  authority: NpcSpeechAuthority,
): readonly SafeFact[] {
  const allowed = new Set(authority.allowedFactIds.map(String));
  return speaker.knowledge.entries
    .filter((entry) => allowed.has(String(entry.factId)))
    .map((entry) => {
      const record = getEntity(ws.entityStore, String(entry.factId));
      const sources: readonly EvidenceRef[] = entry.source.kind === "action"
        ? [{ kind: "committed", eventId: String(entry.source.eventId) }]
        : [];
      return {
        id: String(entry.factId),
        text: isFactRecord(record) ? record.fact.text : "",
        certainty: entry.certainty,
        sources,
      };
    });
}

/**
 * 人格投影：公开身份 + 受控行为。legacy 导入来源（正文 ===
 * LEGACY_IMPORT_REASON_KEY）的锚点不携带正文；taboos 整组转 behavior。
 *
 * goals 的 description/reason 都是自由文本且没有可核验的公开依据（reason 本身
 * 可被篡改成任意值，不能作为放行凭据），因此 fail-closed：不回传目标正文，
 * 敏感动机由受控 behavior（withhold_source 等）表达。
 */
function personaOf(speaker: NpcEntityRecord, authority: NpcSpeechAuthority): SafePersona {
  const { selfConcept, values, speechStyle, capabilityBoundaries } = speaker.identity.anchors;
  const anchorTexts = [selfConcept, ...values, speechStyle, ...capabilityBoundaries]
    .filter((text) => text !== LEGACY_IMPORT_REASON_KEY);
  const behavior: ("answer_directly" | "withhold_source" | "express_uncertainty")[] = ["answer_directly"];
  if (speaker.knowledge.entries.some((entry) => entry.disclosure === "secret")) {
    behavior.push("withhold_source");
  }
  if (speaker.knowledge.entries.some((entry) => entry.certainty === "suspected")) {
    behavior.push("express_uncertainty");
  }
  return {
    publicName: speaker.core.name,
    publicRole: { text: speaker.identity.role, facts: [], evidence: [], beatIds: [] },
    anchors: anchorTexts.map((text): TextPart => ({ text, facts: [], evidence: [], beatIds: [] })),
    goals: [],
    emotion: speaker.dynamicState.emotion,
    relationshipTier: authority.responseTier,
    behavior,
  };
}

/** 前文 = 依赖单元的已批准可见表达，按 ScenePoint 顺序拼接。 */
function priorTextOf(
  plan: ApprovedPlan,
  unit: Unit,
  approved: ReadonlyMap<string, UnitOutput>,
): Check<readonly TextPart[]> {
  const parts: TextPart[] = [];
  const dependencies = unit.dependencies
    .map((key) => plan.units.find((candidate) => candidate.key === key))
    .filter((candidate): candidate is Unit => candidate !== undefined)
    .sort((left, right) =>
      left.point.stepKey === right.point.stepKey
        ? left.point.order - right.point.order
        : left.point.stepKey < right.point.stepKey ? -1 : 1);
  for (const dependency of dependencies) {
    const output = approved.get(dependency.key);
    if (output === undefined) return fail("dependency_output_missing");
    if (output.stage === "choices") continue;
    parts.push(...output.parts);
  }
  return { ok: true, value: parts };
}

function optionsOf(plan: ApprovedPlan): readonly SafeOption[] {
  const expression = plan.choiceExpression;
  if (expression === null) return [];
  return expression.options.map((option) => ({
    candidateId: option.candidateId,
    dialogueAct: option.dialogueAct,
    publicIntent: option.publicIntent,
  }));
}

/** 候选意图只投影给选项单元；旁白/角色单元的上下文不携带决策。 */
function choiceKindOf(plan: ApprovedPlan, unit: Unit): "ordinary" | "ending" | null {
  if (unit.stage !== "choices") return null;
  return plan.choiceExpression?.kind ?? null;
}

function allowedActionsOf(plan: ApprovedPlan, unit: Unit): readonly CosmeticAction[] {
  if (unit.stage === "character" && unit.speakerId !== null) {
    return plan.proposal.actions.filter((action) => action.actorId === unit.speakerId);
  }
  if (unit.stage === "narration") {
    return plan.proposal.actions.filter((action) =>
      action.audienceIds.includes(String(PLAYER_ENTITY_ID)));
  }
  return [];
}

/**
 * 重建 Unit：taskFactIds 只保留该视角可见的事实，requiredObservationKeys 只保留
 * 归属于本单元且确实存在的观察引用（与 collectDisclosures 同一归属规则）。
 */
function rebuildUnit(
  unit: Unit,
  visibleFactIds: ReadonlySet<string>,
  plan: ApprovedPlan,
): Unit {
  const authorizedObservationKeys = new Set(
    observationsForUnit(unit, plan.proposal.observations).map((observation) => observation.key),
  );
  return {
    ...unit,
    taskFactIds: unit.taskFactIds.filter((factId) => visibleFactIds.has(factId)),
    requiredObservationKeys: unit.requiredObservationKeys.filter((key) =>
      authorizedObservationKeys.has(key)),
  };
}

/**
 * 本单元必须披露的观察投影：按 rebuildUnit 保留下来的键，取回观察的 fact/certainty。
 * 只输出键与事实键，不含受众与来源细节。missing 时 fail-closed（理论不可达：
 * rebuildUnit 已按同一归属规则过滤）。
 */
function requiredObservationsOf(
  unit: Unit,
  plan: ApprovedPlan,
): Check<readonly SafeObservation[]> {
  const authorized = new Map(
    observationsForUnit(unit, plan.proposal.observations).map((observation) => [
      observation.key,
      observation,
    ]),
  );
  const out: SafeObservation[] = [];
  for (const key of unit.requiredObservationKeys) {
    const observation = authorized.get(key);
    if (observation === undefined) return fail("observation_without_source");
    out.push({
      key: observation.key,
      factId: observation.fact.factId,
      certainty: observation.fact.certainty,
    });
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export type ProjectUnitContextInput = Readonly<{
  plan: ApprovedPlan;
  unit: Unit;
  approved: ReadonlyMap<string, UnitOutput>;
}>;

/**
 * 投影某一表达单元的安全上下文。角色单元带 persona（未知说话人 fail-closed）；
 * 旁白与选项单元是玩家视角（persona 为 null）。选项候选从已审批
 * choiceExpression 投影（ending 臂不需要 RouteTarget）。
 */
export function projectUnitContext(input: ProjectUnitContextInput): Check<SafeContext> {
  const { plan } = input;
  const unit = plan.units.find((candidate) => candidate.key === input.unit.key);
  if (unit === undefined) return fail("unknown_unit");
  const ws = plan.world;

  let persona: SafePersona | null = null;
  let visibleFacts: readonly SafeFact[] = [];
  if (unit.stage === "character") {
    if (unit.speakerId === null) return fail("unknown_speaker");
    const speaker = getEntity(ws.entityStore, unit.speakerId);
    if (!isNpcRecord(speaker)) return fail("unknown_speaker");
    // 场景可见事实 = 玩家已发现全集；说话人可见 = 说话人知识 ∩ 场景可见 ∩ 可披露。
    const authority = buildNpcSpeechAuthority({
      store: ws.entityStore,
      speakerNpcId: speaker.core.id,
      sceneVisibleFactIds: discoveredFacts(ws).map((fact) => asFactId(fact.id)),
    });
    if (authority === null) return fail("unknown_speaker");
    persona = personaOf(speaker, authority);
    visibleFacts = speakerVisibleFacts(ws, speaker, authority);
  } else {
    // 玩家视角（旁白/选项）：可见事实来自现场观察与玩家已知（discovered）。
    visibleFacts = discoveredFacts(ws);
  }

  const priorText = priorTextOf(plan, unit, input.approved);
  if (!priorText.ok) return priorText;

  const rebuilt = rebuildUnit(unit, new Set(visibleFacts.map((fact) => fact.id)), plan);
  const requiredObservations = requiredObservationsOf(rebuilt, plan);
  if (!requiredObservations.ok) return requiredObservations;

  return {
    ok: true,
    value: {
      unit: rebuilt,
      persona,
      visibleFacts,
      priorText: priorText.value,
      allowedActions: allowedActionsOf(plan, unit),
      options: unit.stage === "choices" ? optionsOf(plan) : [],
      playerUtterance: null,
      style: ws.generation.gameType,
      requiredBeats: unit.requiredBeats,
      requiredObservations: requiredObservations.value,
      choiceKind: choiceKindOf(plan, unit),
    },
  };
}
