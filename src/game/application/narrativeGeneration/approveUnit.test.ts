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
  it("任务主题及先求证条件不得仅在输入出现、在输出里丢失", () => {
    const u = unit({ key: "n1", stage: "narration", task: { intent: "describe",
      focusFactIds: ["fact_0"], prerequisiteFactIds: [] } });
    const ctx = context({ unit: u, visibleFacts: [{ id: "fact_0", text: "渡口有灯火", certainty: "known", sources: [] }] });
    const output: UnitOutput = { stage: "narration", parts: [part("夜色渐深。")], actionKeys: [] };
    expect(approveUnit({ unit: u, context: ctx, output })).toEqual({ ok: false, code: "unit_output_task_missing" });
    expect(approveUnit({ unit: u, context: ctx, output: { ...output, parts: [
      part("渡口的灯火仍亮着。", { facts: [{ factId: "fact_0", certainty: "known" }] }),
    ] } }).ok).toBe(true);
  });

  it("旁白输出通过", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const output: UnitOutput = { stage: "narration", parts: [part("风从门缝里挤进来。")], actionKeys: [] };
    expect(approveUnit({ unit: u, context: context({ unit: u }), output })).toEqual({ ok: true, value: output });
  });

  it("旁白同一段不能归属多个已知节拍，拆段后保留全部覆盖", () => {
    const beats: SafeBeat[] = ["quest_progress_0", "quest_advanced_1"].map(beatId => ({
      beatId, kind: "atmosphere", factIds: [], evidence: [], instruction: "承接现场",
    }));
    const u = unit({ key: "n1", stage: "narration", requiredBeats: beats });
    const ctx = context({ unit: u, requiredBeats: beats });
    expect(approveUnit({ unit: u, context: ctx, output: {
      stage: "narration", actionKeys: [],
      parts: [part("线索与进展。", { beatIds: beats.map(beat => beat.beatId) })],
    } })).toEqual({ ok: false, code: "unit_output_beat_ambiguous" });
    const parts = [part("风声渐起。"), ...beats.map((beat, index) =>
      part(index === 0 ? "线索已经清楚。" : "眼前有了新的方向。", { beatIds: [beat.beatId] }))];
    expect(approveUnit({ unit: u, context: ctx, output: {
      stage: "narration", actionKeys: [], parts,
    } }).ok).toBe(true);
    expect(approveUnit({ unit: u, context: ctx, output: {
      stage: "narration", actionKeys: [], parts: parts.slice(0, 2),
    } })).toEqual({ ok: false, code: "unit_output_beat_missing" });
  });

  it("NPC 单段回答多个节拍仍然有效，不套用旁白段落契约", () => {
    const beats: SafeBeat[] = ["beat_a", "beat_b"].map(beatId => ({
      beatId, kind: "atmosphere", factIds: [], evidence: [], instruction: "回应",
    }));
    const u = unit({ key: "c1", stage: "character", speakerId: "npc_0", requiredBeats: beats });
    expect(approveUnit({ unit: u, context: context({ unit: u, requiredBeats: beats }), output: {
      stage: "character", speakerId: "npc_0", emotion: "neutral", actions: [],
      answeredBeatIds: beats.map(beat => beat.beatId),
      parts: [part("这两件事我都听说了。", { beatIds: beats.map(beat => beat.beatId) })],
    } }).ok).toBe(true);
  });

  it("当前旁白每节拍只能形成一个连续段，氛围只在最后一个旁白单元末尾", () => {
    const beats: SafeBeat[] = ["a", "b"].map(beatId => ({
      beatId, kind: "quest_progress", factIds: [], evidence: [], instruction: "承接进展",
    }));
    const u = unit({ key: "n1", stage: "narration", requiredBeats: beats });
    const a = part("前事。", { beatIds: ["a"] });
    const b = part("后事。", { beatIds: ["b"] });
    const atmosphere = part("夜深了。");
    const check = (parts: TextPart[], allowAtmosphere = true) => approveUnit({
      unit: u, context: context({ unit: u, requiredBeats: beats, narrationLayout: { allowAtmosphere } }),
      output: { stage: "narration", parts, actionKeys: [] },
    });
    expect(check([a, b, a])).toMatchObject({ ok: false, code: "unit_output_beat_layout" });
    expect(check([atmosphere, a, b])).toMatchObject({ ok: false, code: "unit_output_beat_layout" });
    expect(check([a, b, atmosphere], false)).toMatchObject({ ok: false, code: "unit_output_beat_layout" });
    expect(check([a, a, b, atmosphere, atmosphere]).ok).toBe(true);
    expect(check([a, a, b], false).ok).toBe(true);
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
    expect(approveUnit({ unit: u, context: context({ unit: u, allowedActions: [action] }),
      output: { ...output, actions: [{ ...action, objectId: "secret_entity" }] },
    })).toEqual({ ok: false, code: "unit_output_action_unapproved" });
  });

  it("不能遗漏全部必需节拍却通过审批", () => {
    const u = unit({ key: "n1", stage: "narration" });
    const beat: SafeBeat = { beatId: "required", kind: "atmosphere", factIds: [], evidence: [], instruction: "描写现场" };
    expect(approveUnit({ unit: u, context: context({ unit: u, requiredBeats: [beat] }),
      output: { stage: "narration", parts: [part("风吹过。")], actionKeys: [] },
    })).toEqual({ ok: false, code: "unit_output_beat_missing" });
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

  // 回归（缺陷 14）：披露要求把同一事实标为 suspected，而 visibleFacts 因编译层
  // 硬编码为 known。模型按「不得升级、可降级」写 suspected → 旧规则要求严格相等，
  // 会把降级误杀成 unit_output_fact_unavailable（真实 smoke char_liu_2 失败码）。
  it("披露要求低于可见事实时允许降级（known→suspected）", () => {
    const u = unit({
      key: "char_liu_2", stage: "character", speakerId: "npc_0",
      requiredObservationKeys: ["obs_liu_warehouse"],
    });
    const ctx = context({
      unit: u,
      visibleFacts: [{ id: "fact_0", text: "盐仓夜里有人影。", certainty: "known", sources: [] }],
      requiredObservations: [{ key: "obs_liu_warehouse", factId: "fact_0", certainty: "suspected" }],
    });
    const suspected: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("盐仓夜里像是有人影。", { facts: [{ factId: "fact_0", certainty: "suspected" }] })],
      emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    expect(approveUnit({ unit: u, context: ctx, output: suspected }).ok).toBe(true);
    // 升级仍必须被拒：披露要求是 suspected，输出写 known 即升级。
    const upgraded: UnitOutput = {
      ...suspected,
      parts: [part("盐仓夜里有人影。", { facts: [{ factId: "fact_0", certainty: "known" }] })],
    };
    expect(approveUnit({ unit: u, context: ctx, output: upgraded }))
      .toEqual({ ok: false, code: "unit_output_fact_unavailable" });
  });

  it("两侧同标 known 时，降级为 suspected 也允许（只拒升级）", () => {
    // 与 collectDisclosures 同规则：只拒绝 certainty 升级，不拒绝保守的降级表达。
    // 「确定的事说得不确定」是自然的谨慎措辞，不是泄密或臆造。
    const u = unit({
      key: "c1", stage: "character", speakerId: "npc_0",
      requiredObservationKeys: ["obs_x"],
    });
    const ctx = context({
      unit: u,
      visibleFacts: [{ id: "fact_1", text: "货在废窑。", certainty: "known", sources: [] }],
      requiredObservations: [{ key: "obs_x", factId: "fact_1", certainty: "known" }],
    });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("货也许在废窑。", { facts: [{ factId: "fact_1", certainty: "suspected" }] })],
      emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    expect(approveUnit({ unit: u, context: ctx, output }).ok).toBe(true);
  });

  it("披露要求引用的事实即使不在 visibleFacts 也可用（按上限判定）", () => {
    // 观察的 factId 未必出现在 visibleFacts（例如秘密/受控披露路径），
    // 只要披露要求自身给出 certainty，引用该事实就不应被判不可见。
    const u = unit({
      key: "c1", stage: "character", speakerId: "npc_0",
      requiredObservationKeys: ["obs_y"],
    });
    const ctx = context({
      unit: u,
      visibleFacts: [],
      requiredObservations: [{ key: "obs_y", factId: "fact_2", certainty: "suspected" }],
    });
    const output: UnitOutput = {
      stage: "character", speakerId: "npc_0",
      parts: [part("我听说货在废窑。", { facts: [{ factId: "fact_2", certainty: "suspected" }] })],
      emotion: "neutral", actions: [], answeredBeatIds: [],
    };
    expect(approveUnit({ unit: u, context: ctx, output }).ok).toBe(true);
    expect(approveUnit({
      unit: u,
      context: ctx,
      output: {
        ...output,
        parts: [part("货在废窑。", { facts: [{ factId: "fact_2", certainty: "known" }] })],
      },
    })).toEqual({ ok: false, code: "unit_output_fact_unavailable" });
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
