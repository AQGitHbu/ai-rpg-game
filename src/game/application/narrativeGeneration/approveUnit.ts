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
import { LEGACY_IMPORT_REASON_KEY } from "@/game/domain/entity";
import type { SafeContext } from "./perspectiveContext";
import { checkDialogueLabel } from "./dialogueLabel";

export type ApproveUnitInput = Readonly<{
  unit: Unit;
  context: SafeContext;
  output: UnitOutput;
}>;

function visibleFactIndex(context: SafeContext): ReadonlyMap<string, "known" | "suspected"> {
  const map = new Map<string, "known" | "suspected">();
  for (const fact of context.visibleFacts) {
    map.set(fact.id, fact.certainty);
  }
  return map;
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
  const facts = visibleFactIndex(context);
  const eventIds = visibleEventIds(context);
  const knownBeats = new Set(context.requiredBeats.map((beat) => beat.beatId));
  for (const part of output.parts) {
    if (part.text.includes(LEGACY_IMPORT_REASON_KEY)) return "unit_output_secret_leak";
    for (const fact of part.facts) {
      const visible = facts.get(fact.factId);
      if (visible === undefined || visible !== fact.certainty) {
        return "unit_output_fact_unavailable";
      }
    }
    for (const evidence of part.evidence) {
      if (evidence.kind === "committed") {
        if (!eventIds.has(evidence.eventId)) return "unit_output_evidence_unavailable";
      } else if (!context.unit.requiredObservationKeys.includes(evidence.observationKey)) {
        return "unit_output_evidence_unavailable";
      }
    }
    for (const beatId of part.beatIds) {
      if (!knownBeats.has(beatId)) return "unit_output_beat_unknown";
    }
  }
  return null;
}

/**
 * 审批一个已生成的表达单元输出：只对照投影上下文逐项验证结构与引用，
 * 不接触世界状态；世界级披露核对在 collectDisclosures（gameplay）承担。
 */
export function approveUnit(input: ApproveUnitInput): Check<UnitOutput> {
  const { unit, context, output } = input;
  if (context.unit.key !== unit.key) return fail("unit_output_key_mismatch");
  if (context.unit.stage !== unit.stage) return fail("unit_output_stage_mismatch");
  if (output.stage !== unit.stage) return fail("unit_output_stage_mismatch");

  if (unit.stage === "character") {
    if (output.stage !== "character") return fail("unit_output_stage_mismatch");
    if (unit.speakerId === null) return fail("unit_output_speaker_mismatch");
    if (output.speakerId !== unit.speakerId) return fail("unit_output_speaker_mismatch");
    const approvedActionKeys = new Set(context.allowedActions.map((action) => action.key));
    for (const action of output.actions) {
      if (action.actorId !== output.speakerId || !approvedActionKeys.has(action.key)) {
        return fail("unit_output_action_unapproved");
      }
    }
    const partsRejection = checkParts(context, output);
    if (partsRejection !== null) return fail(partsRejection);
    const knownBeats = new Set(context.requiredBeats.map((beat) => beat.beatId));
    for (const beatId of output.answeredBeatIds) {
      if (!knownBeats.has(beatId)) return fail("unit_output_beat_unknown");
    }
    return { ok: true, value: output };
  }

  if (unit.stage === "narration") {
    if (output.stage !== "narration") return fail("unit_output_stage_mismatch");
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
  for (const label of output.labels) {
    if (!expectedCandidates.has(label.candidateId)) return fail("unit_output_candidate_unknown");
    const labelCheck = checkDialogueLabel(label.label);
    if (!labelCheck.ok) return labelCheck;
  }
  if (output.labels.length !== context.options.length) {
    return fail("unit_output_candidate_missing");
  }
  return { ok: true, value: output };
}
