// 表达单元审批（Plan 2026-09-09 / Task 6 Step 3）。
//
// approveUnit 是纯函数：只核对输出与投影上下文（SafeContext）的结构一致性。
// 严格 stage/output 匹配；旁白 actionKeys 必须已批准且玩家可见（上下文的
// allowedActions 已按视角过滤）；fact 引用必须可见且不升级 certainty；
// committed 事件引用必须来自可见事实来源、conditional 观察引用必须属于
// 单元的观察要求；节拍引用必须已知；候选与上下文一一映射；label 走
// checkDialogueLabel；秘密 sentinel 泄漏精确拒绝且不回显原文。

import {
  fail,
  type Check,
  type Unit,
  type UnitOutput,
} from "@/game/domain/narrativeUnit";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { LEGACY_IMPORT_REASON_KEY } from "@/game/domain/entity";
import type { SafeContext } from "./perspectiveContext";
import { checkDialogueLabel } from "./dialogueLabel";
import { requiredExpressionFactIds } from "@/game/domain/expressionTask";

export type ApproveUnitInput = Readonly<{
  unit: Unit;
  context: SafeContext;
  output: UnitOutput;
}>;

/**
 * 可引用事实的 certainty 上限：visibleFacts 与 requiredObservations 都构成权威参考，
 * 取**更严**的一个（suspected 优先）。这样当某事实既在可见事实里标 known、又被观察
 * 要求以 suspected 披露时，模型写 suspected（降级）不被误杀，写 known（升级）仍被拒。
 * 与 collectDisclosures 的「不得升级」同一语义（单一规则，两处共用）。
 */
export function factCertaintyCeiling(context: SafeContext): ReadonlyMap<string, "known" | "suspected"> {
  const ceiling = new Map<string, "known" | "suspected">();
  for (const fact of context.visibleFacts) {
    ceiling.set(fact.id, fact.certainty);
  }
  for (const observation of context.requiredObservations) {
    const current = ceiling.get(observation.factId);
    if (current === undefined || observation.certainty === "suspected") {
      ceiling.set(observation.factId, observation.certainty);
    }
  }
  return ceiling;
}

function visibleEventIds(context: SafeContext): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const fact of context.visibleFacts) {
    for (const source of fact.sources) {
      if (source.kind === "committed") ids.add(source.eventId);
    }
  }
  return ids;
}

function checkParts(context: SafeContext, output: Extract<UnitOutput, { stage: "narration" | "character" }>): string | null {
  const facts = factCertaintyCeiling(context);
  const eventIds = visibleEventIds(context);
  const knownBeats = new Set(context.requiredBeats.map((beat) => beat.beatId));
  for (const part of output.parts) {
    if (part.text.includes(LEGACY_IMPORT_REASON_KEY)) return "unit_output_secret_leak";
    for (const fact of part.facts) {
      const ceiling = facts.get(fact.factId);
      // 不可见 → 拒绝；可见但输出升级（suspected→known）→ 拒绝。降级（known→suspected）允许。
      if (ceiling === undefined) return "unit_output_fact_unavailable";
      if (ceiling === "suspected" && fact.certainty === "known") {
        return "unit_output_fact_unavailable";
      }
    }
    for (const evidence of part.evidence) {
      if (evidence.kind === "committed") {
        const beatEvent = context.unit.stage === "narration" && context.unit.point.stepKey === "current"
          && context.requiredBeats.some(beat => part.beatIds.includes(beat.beatId)
            && beat.evidence.some(ref => ref.kind === "committed" && ref.eventId === evidence.eventId));
        if (!eventIds.has(evidence.eventId) && !beatEvent) return "unit_output_evidence_unavailable";
      } else if (!context.unit.requiredObservationKeys.includes(evidence.observationKey)
        && !context.visibleFacts.some(fact => fact.sources.some(source => source.kind === "conditional"
          && source.observationKey === evidence.observationKey))) {
        return "unit_output_evidence_unavailable";
      }
    }
    for (const beatId of part.beatIds) {
      if (!knownBeats.has(beatId)) return "unit_output_beat_unknown";
    }
  }
  const expressedFacts = new Set(output.parts.flatMap(part => part.facts.map(fact => fact.factId)));
  if (context.unit.task !== undefined && requiredExpressionFactIds(context.unit.task)
    .some(id => !expressedFacts.has(id))) return "unit_output_task_missing";
  const covered = new Set(output.parts.flatMap(part => part.beatIds));
  if (context.requiredBeats.some(beat => !covered.has(beat.beatId))) return "unit_output_beat_missing";
  return null;
}

/**
 * 审批一个已生成的表达单元输出：只对照投影上下文逐项验证结构与引用，
 * 不接触世界状态；世界级披露核对在 collectDisclosures（gameplay）承担。
 */
export function narrationLayoutRejection(
  output: Extract<UnitOutput, { stage: "narration" }>, layout: SafeContext["narrationLayout"],
): string | null {
  if (layout === undefined) return null;
  const seen = new Set<string>();
  let previous: string | null = null;
  for (const part of output.parts) {
    const beatId = part.beatIds[0] ?? ATMOSPHERE_BEAT_ID;
    if (beatId === ATMOSPHERE_BEAT_ID && !layout.allowAtmosphere) return "unit_output_beat_layout";
    if (beatId !== previous) {
      if (seen.has(beatId) || seen.has(ATMOSPHERE_BEAT_ID)) return "unit_output_beat_layout";
      seen.add(beatId);
      previous = beatId;
    }
  }
  return null;
}

export function approveUnit(input: ApproveUnitInput): Check<UnitOutput> {
  const { unit, context, output } = input;
  if (context.unit.key !== unit.key) return fail("unit_output_key_mismatch");
  if (context.unit.stage !== unit.stage) return fail("unit_output_stage_mismatch");
  if (output.stage !== unit.stage) return fail("unit_output_stage_mismatch");

  if (unit.stage === "character") {
    if (output.stage !== "character") return fail("unit_output_stage_mismatch");
    if (unit.speakerId === null) return fail("unit_output_speaker_mismatch");
    if (output.speakerId !== unit.speakerId) return fail("unit_output_speaker_mismatch");
    for (const action of output.actions) {
      const expected = context.allowedActions.find(candidate => candidate.key === action.key);
      if (action.actorId !== output.speakerId || expected === undefined
        || expected.actorId !== action.actorId || expected.kind !== action.kind
        || expected.objectId !== action.objectId || expected.point.stepKey !== action.point.stepKey
        || expected.point.order !== action.point.order
        || expected.audienceIds.length !== action.audienceIds.length
        || !expected.audienceIds.every(id => action.audienceIds.includes(id))) {
        return fail("unit_output_action_unapproved");
      }
    }
    const partsRejection = checkParts(context, output);
    if (partsRejection !== null) return fail(partsRejection);
    const knownBeats = new Set(context.requiredBeats.map((beat) => beat.beatId));
    for (const beatId of output.answeredBeatIds) {
      if (!knownBeats.has(beatId)) return fail("unit_output_beat_unknown");
    }
    if (context.requiredBeats.some(beat => !output.answeredBeatIds.includes(beat.beatId))) {
      return fail("unit_output_beat_missing");
    }
    return { ok: true, value: output };
  }

  if (unit.stage === "narration") {
    if (output.stage !== "narration") return fail("unit_output_stage_mismatch");
    // 装配后的旁白 segment 只归属一个节拍；多节拍必须在表达阶段拆段重试。
    if (output.parts.some(part => part.beatIds.length > 1)) return fail("unit_output_beat_ambiguous");
    const layoutRejection = narrationLayoutRejection(output, context.narrationLayout);
    if (layoutRejection !== null) return fail(layoutRejection);
    // 上下文的 allowedActions 已限定「已批准 ∩ 玩家可见」。
    const approvedActionKeys = new Set(context.allowedActions.map((action) => action.key));
    for (const actionKey of output.actionKeys) {
      if (!approvedActionKeys.has(actionKey)) return fail("unit_output_action_unapproved");
    }
    const partsRejection = checkParts(context, output);
    if (partsRejection !== null) return fail(partsRejection);
    return { ok: true, value: output };
  }

  if (output.stage !== "choices") return fail("unit_output_stage_mismatch");
  const expectedCandidates = new Set(context.options.map((option) => option.candidateId));
  if (new Set(output.labels.map(label => label.candidateId)).size !== output.labels.length) {
    return fail("unit_output_candidate_missing");
  }
  for (const label of output.labels) {
    if (!expectedCandidates.has(label.candidateId)) return fail("unit_output_candidate_unknown");
    const dialogue = context.dialogue;
    if (dialogue !== undefined && dialogue.speakerName !== dialogue.addresseeName) {
      // 仅识别明确的开头呼语，不把自我介绍、引用自己的名字一律当串台。
      const opening = label.label.trim().replace(/^[“「"]/, "").replace(/^(?:你好|喂|嗨)[，,\s]*/, "");
      if (opening.startsWith(dialogue.speakerName)
        && /^[，,！!：:、]/.test(opening.slice(dialogue.speakerName.length))) return fail("unit_output_self_address");
    }
    const labelCheck = checkDialogueLabel(label.label);
    if (!labelCheck.ok) return labelCheck;
  }
  if (output.labels.length !== context.options.length) {
    return fail("unit_output_candidate_missing");
  }
  return { ok: true, value: output };
}
