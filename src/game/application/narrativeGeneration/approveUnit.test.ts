// 表达单元审批（Plan 2026-09-09 / Task 6 Step 3）。
//
// approveUnit 只核对输出与投影上下文的结构一致性：stage/说话人匹配、
// actionKeys 已批准、fact 引用可用且不升级 certainty、证据引用可归属、
// 节拍引用已知、候选一一映射、label 通过纯对白检查、秘密 sentinel 不泄漏。

import { describe, expect, it } from "vitest";
import { approveUnit } from "./approveUnit";
import type { SafeContext } from "./perspectiveContext";
import {
  LEGACY_IMPORT_REASON_KEY,
} from "@/game/domain/entity";
import type { CosmeticAction, SafeBeat, TextPart, Unit, UnitOutput } from "@/game/domain/narrativeUnit";
import type { SafeOption } from "./perspectiveContext";

function part(text: string, overrides: Partial<TextPart> = {}): TextPart {
  return { text, facts: [], evidence: [], beatIds: [], ...overrides };
}

function unit(overrides: Partial<Unit> & Pick<Unit, "key" | "stage">): Unit {
  return {
    point: { stepKey: "current", order: 1 },
    speakerId: null,
    dependencies: [],
    taskFactIds: [],
    requiredObservationKeys: [],
    requiredBeats: [],
    ...overrides,
  };
}

function context(overrides: Partial<SafeContext> & Pick<SafeContext, "unit">): SafeContext {
  return {
    persona: null,
    visibleFacts: [],
    priorText: [],
    allowedActions: [],
    options: [],
    playerUtterance: null,
    style: "wuxia",
    requiredBeats: [],
    requiredObservations: [],
    choiceKind: null,
    ...overrides,
  };
}

describe("approveUnit", () => {
  it("旁白输出通过", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const output: UnitOutput = { stage: "narration", parts: [part("风从门缝里挤进来。")], actionKeys: [] };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output })).toEqual({ ok: true, value: output });
  });

  it("stage 不匹配拒绝", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("你好。")], emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_stage_mismatch" });
  });

  it("上下文单元身份不一致拒绝", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const other = unit({ key: "n2", stage: "narration" });
    const output: UnitOutput = { stage: "narration", parts: [part("旁白。")], actionKeys: [] };
    expect(approveUnit({ unit: u, context: context({ unit: other }), output }))
      .toEqual({ ok: false, code: "unit_output_key_mismatch" });
  });

  it("角色输出说话人与单元不一致拒绝", () => {
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0" });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_1",
      parts: [part("你好。")], emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_speaker_mismatch" });
  });

  it("旁白 actionKeys 必须已批准且玩家可见", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const output: UnitOutput = {
      stage: "narration", parts: [part("他顿了顿。")], actionKeys: ["act_ghost"],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_action_unapproved" });
  });

  it("角色动作必须归属说话人且已批准", () => {
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0" });
    const action: CosmeticAction = {
      key: "act_1", actorId: "npc_0", point: { stepKey: "current", order: 1 },
      kind: "look", objectId: null, audienceIds: [],
    };
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0", parts: [part("嗯。")],
      emotion: "neutral", actions: [action], answeredBeatIds: [],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_action_unapproved" });
    const okResult = approveUnit({
      unit: u,
      context: context({ unit: u, allowedActions: [action] }),
      output,
    });
    expect(okResult.ok).toBe(true);
  });

  it("fact 引用不在可见事实中拒绝", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const output: UnitOutput = {
      stage: "narration",
      parts: [part("渡口有灯火。", { facts: [{ factId: "fact_ghost", certainty: "known" }] })],
      actionKeys: [],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_fact_unavailable" });
  });

  it("certainty 不得升级", () => {
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0" });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("货确实在那。", { facts: [{ factId: "fact_1", certainty: "known" }] })],
      emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    const ctx = context({
      unit: u,
      visibleFacts: [{ id: "fact_1", text: "货可能在废窑", certainty: "suspected", sources: [] }],
    });
    expect(approveUnit({ unit: u, context: ctx, output }))
      .toEqual({ ok: false, code: "unit_output_fact_unavailable" });
  });

  it("committed 事件引用必须来自可见事实来源", () => {
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0" });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("我看见你拿了货。", { evidence: [{ kind: "committed", eventId: "evt_ghost" }] })],
      emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    const ctx = context({
      unit: u,
      visibleFacts: [{
        id: "fact_1", text: "货在废窑", certainty: "known",
        sources: [{ kind: "committed", eventId: "evt_real" }],
      }],
    });
    expect(approveUnit({ unit: u, context: ctx, output }))
      .toEqual({ ok: false, code: "unit_output_evidence_unavailable" });
  });

  it("conditional 观察引用必须属于单元的观察要求", () => {
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0" });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("你说过的。", { evidence: [{ kind: "conditional", observationKey: "obs_ghost" }] })],
      emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_evidence_unavailable" });
  });

  it("节拍引用必须已知", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const output: UnitOutput = {
      stage: "narration",
      parts: [part("灯灭了。", { beatIds: ["beat_ghost"] })],
      actionKeys: [],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_beat_unknown" });
  });

  it("answeredBeatIds 必须已知", () => {
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0" });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0", parts: [part("嗯。")],
      emotion: "neutral", actions: [], answeredBeatIds: ["beat_ghost"],
    };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output }))
      .toEqual({ ok: false, code: "unit_output_beat_unknown" });
  });

  it("候选必须与上下文一一映射", () => {
    const u = unit({ key: "k1", stage: "choices" });
    const option: SafeOption = {
      candidateId: "left", dialogueAct: "offer",
      publicIntent: part("去废窑看看"),
    };
    const base = context({ unit: u, options: [option, { ...option, candidateId: "right" }] });
    expect(approveUnit({
      unit: u, context: base,
      output: { stage: "choices", labels: [{ candidateId: "ghost", label: "行。" }] },
    })).toEqual({ ok: false, code: "unit_output_candidate_unknown" });
    expect(approveUnit({
      unit: u, context: base,
      output: { stage: "choices", labels: [{ candidateId: "left", label: "行。" }] },
    })).toEqual({ ok: false, code: "unit_output_candidate_missing" });
    const okResult = approveUnit({
      unit: u, context: base,
      output: {
        stage: "choices",
        labels: [
          { candidateId: "left", label: "去废窑看看。" },
          { candidateId: "right", label: "先放人，再谈条件。" },
        ],
      },
    });
    expect(okResult.ok).toBe(true);
  });

  it("label 必须通过纯对白检查", () => {
    const u = unit({ key: "k1", stage: "choices" });
    const option: SafeOption = {
      candidateId: "left", dialogueAct: "offer", publicIntent: part("去废窑"),
    };
    expect(approveUnit({
      unit: u,
      context: context({ unit: u, options: [option, { ...option, candidateId: "right" }] }),
      output: {
        stage: "choices",
        labels: [
          { candidateId: "left", label: "盯着他问：你是谁？" },
          { candidateId: "right", label: "先放人。" },
        ],
      },
    })).toEqual({ ok: false, code: "label_speaker_tag" });
  });

  it("秘密 sentinel 泄漏精确拒绝且不回显", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const output: UnitOutput = {
      stage: "narration",
      parts: [part(`他说了${LEGACY_IMPORT_REASON_KEY}这件事。`)],
      actionKeys: [],
    };
    const result = approveUnit({ unit: u, context: context({ unit: u }), output });
    expect(result).toEqual({ ok: false, code: "unit_output_secret_leak" });
  });

  it("节拍结构完整时角色输出通过", () => {
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0" });
    const beat: SafeBeat = {
      beatId: "beat_1", kind: "atmosphere", factIds: [], evidence: [], instruction: "氛围",
    };
    const action: CosmeticAction = {
      key: "act_1", actorId: "npc_0", point: { stepKey: "current", order: 1 },
      kind: "look", objectId: null, audienceIds: [],
    };
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("先坐吧，路上不好走。", { beatIds: ["beat_1"] })],
      emotion: "neutral", actions: [action], answeredBeatIds: ["beat_1"],
    };
    const ctx = context({
      unit: u,
      requiredBeats: [beat],
      allowedActions: [action],
    });
    expect(approveUnit({ unit: u, context: ctx, output }).ok).toBe(true);
  });
});
