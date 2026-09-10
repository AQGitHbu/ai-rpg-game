// 表达装配（Plan 2026-09-09 / Task 6 Step 4）。
//
// assembleBundle 把已批准单元输出按 ScenePoint 顺序装配成整包提案，
// 不按完成顺序；规划素材（proposal.opening 的 prologue 等）不进入展示
// 字段——本函数只消费单元输出，结构上无法携带规划正文。
// 每句直接对白只归对应 NPC（npcLine / npcDialogues），旁白不复制对白；
// 句段 fact 引用与观察条件证据保持逐 speaker 来源，不做并集授权。
// 最终状态仍由现有 approveNarrativeBundle 转换，本函数不重写其规则。

import { fail, type Check, type TextPart, type UnitOutput } from "@/game/domain/narrativeUnit";
import type {
  BundleSceneProposal,
  NarrativeBundleProposal,
  ScenePerformanceNpcDialogue,
} from "@/game/domain/narrativeBundle";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { LEGACY_IMPORT_REASON_KEY } from "@/game/domain/entity";
import type { ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";

export type AssembleBundleInput = Readonly<{
  plan: ApprovedPlan;
  approved: ReadonlyMap<string, UnitOutput>;
}>;

type ConditionalEvidenceEntry = {
  readonly partIndex: number;
  readonly observationKey: string;
  readonly audienceId: string;
};

function leakFree(parts: readonly TextPart[]): boolean {
  return parts.every((part) => !part.text.includes(LEGACY_IMPORT_REASON_KEY));
}

function usedFactIds(parts: readonly TextPart[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const fact of part.facts) {
      if (!seen.has(fact.factId)) {
        seen.add(fact.factId);
        out.push(fact.factId);
      }
    }
  }
  return out;
}

function usedEventIds(parts: readonly TextPart[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const evidence of part.evidence) {
      if (evidence.kind === "committed" && !seen.has(evidence.eventId)) {
        seen.add(evidence.eventId);
        out.push(evidence.eventId);
      }
    }
  }
  return out;
}

type SceneAccumulator = {
  readonly stepKey: string;
  segments: { readonly beatId: string; readonly text: string }[];
  npcLine: BundleSceneProposal["npcLine"];
  npcDialogues: ScenePerformanceNpcDialogue[];
  choices: readonly { readonly candidateId: string; readonly label: string }[];
  conditionalEvidence: ConditionalEvidenceEntry[];
};

function emptyScene(stepKey: string): SceneAccumulator {
  return { stepKey, segments: [], npcLine: null, npcDialogues: [], choices: [], conditionalEvidence: [] };
}

/**
 * 按 ScenePoint 顺序装配：单元排序后按 stepKey 分组，第一组是 currentScene，
 * 其余组按序进入 continuationScenes。缺单元 / stage 不符 / 秘密 sentinel
 * 泄漏 / 未知节拍一律 fail-closed。
 */
export function assembleBundle(input: AssembleBundleInput): Check<NarrativeBundleProposal> {
  const { plan, approved } = input;

  const units = [...plan.units].sort((left, right) =>
    left.point.stepKey === right.point.stepKey
      ? left.point.order - right.point.order
      : left.point.stepKey < right.point.stepKey ? -1 : 1);

  for (const unit of units) {
    const output = approved.get(unit.key);
    if (output === undefined) return fail("assemble_unit_missing");
    if (output.stage !== unit.stage) return fail("assemble_unit_stage_mismatch");
    if (output.stage !== "choices" && !leakFree(output.parts)) {
      return fail("assemble_secret_leak");
    }
  }

  const scenes = new Map<string, SceneAccumulator>();
  const sceneOrder: string[] = [];
  for (const unit of units) {
    let scene = scenes.get(unit.point.stepKey);
    if (scene === undefined) {
      scene = emptyScene(unit.point.stepKey);
      scenes.set(unit.point.stepKey, scene);
      sceneOrder.push(unit.point.stepKey);
    }
    const output = approved.get(unit.key);
    if (output === undefined || output.stage !== unit.stage) continue;
    if (output.stage === "narration") {
      for (const [partIndex, part] of output.parts.entries()) {
        let beatId: string;
        if (part.beatIds.length === 0) {
          // 无节拍要求的句段按 atmosphere 兜底，且必须位于末尾。
          if (partIndex !== output.parts.length - 1) return fail("assemble_segment_beat_missing");
          beatId = ATMOSPHERE_BEAT_ID;
        } else if (part.beatIds.length === 1) {
          const required = part.beatIds[0];
          if (required === undefined || !unit.requiredBeats.some((beat) => beat.beatId === required)) {
            return fail("assemble_segment_beat_unknown");
          }
          beatId = required;
        } else {
          return fail("assemble_segment_ambiguous_beat");
        }
        scene.segments.push({ beatId, text: part.text });
        for (const observationKey of unit.requiredObservationKeys) {
          scene.conditionalEvidence.push({
            partIndex: scene.segments.length - 1,
            observationKey,
            audienceId: String(PLAYER_ENTITY_ID),
          });
        }
      }
      continue;
    }

    if (output.stage === "character") {
      const line = {
        npcId: output.speakerId,
        text: output.parts.map((part) => part.text).join("\n"),
        usedFactIds: usedFactIds(output.parts),
        usedEventIds: usedEventIds(output.parts),
      };
      if (scene.npcLine === null) {
        scene.npcLine = {
          npcId: output.speakerId,
          text: line.text,
          emotion: output.emotion,
          answeredBeatIds: [...output.answeredBeatIds],
          usedFactIds: line.usedFactIds,
          usedEventIds: line.usedEventIds,
        };
      } else {
        scene.npcDialogues.push(line);
      }
      for (const observationKey of unit.requiredObservationKeys) {
        scene.conditionalEvidence.push({
          partIndex: -1,
          observationKey,
          audienceId: output.speakerId,
        });
      }
      continue;
    }

    scene.choices = output.labels.map((label) => ({ candidateId: label.candidateId, label: label.label }));
  }

  // currentScene 是决策点所在组；其余组按单元排序后的出现顺序进入
  // continuationScenes（不按完成顺序）。
  const decisionStepKey = plan.proposal.decision?.point.stepKey ?? null;
  const orderedStepKeys = decisionStepKey !== null && sceneOrder.includes(decisionStepKey)
    ? [decisionStepKey, ...sceneOrder.filter((key) => key !== decisionStepKey)]
    : sceneOrder;
  const firstStepKey = orderedStepKeys[0];
  if (firstStepKey === undefined) return fail("assemble_scene_missing");
  const current = scenes.get(firstStepKey);
  if (current === undefined) return fail("assemble_scene_missing");

  const currentScene: BundleSceneProposal = {
    segments: current.segments,
    npcLine: current.npcLine,
    ...(current.npcDialogues.length > 0 ? { npcDialogues: current.npcDialogues } : {}),
    objectiveLink: null,
    choices: current.choices,
    ...(current.conditionalEvidence.length > 0
      ? { conditionalEvidence: current.conditionalEvidence }
      : {}),
  };

  const continuationScenes: { stepKey: string; scene: BundleSceneProposal }[] = [];
  for (const stepKey of orderedStepKeys.slice(1)) {
    const scene = scenes.get(stepKey);
    if (scene === undefined) continue;
    continuationScenes.push({
      stepKey,
      scene: {
        segments: scene.segments,
        npcLine: scene.npcLine,
        ...(scene.npcDialogues.length > 0 ? { npcDialogues: scene.npcDialogues } : {}),
        objectiveLink: null,
        choices: scene.choices,
        ...(scene.conditionalEvidence.length > 0
          ? { conditionalEvidence: scene.conditionalEvidence }
          : {}),
      },
    });
  }

  // 终幕包没有普通 choices：两个立场 label 只能进 endingLabels，
  // 不能违反「ending bundle 无 choices」的契约。
  if (plan.proposal.terminal.kind === "ending") {
    const endingChoiceUnit = units.find((unit) => unit.stage === "choices");
    if (endingChoiceUnit === undefined) return fail("assemble_ending_labels_missing");
    const endingOutput = approved.get(endingChoiceUnit.key);
    if (endingOutput === undefined || endingOutput.stage !== "choices") {
      return fail("assemble_ending_labels_missing");
    }
    const trust = endingOutput.labels.find((label) => label.candidateId === "@ending.trust");
    const doubt = endingOutput.labels.find((label) => label.candidateId === "@ending.doubt");
    if (trust === undefined || doubt === undefined) return fail("assemble_ending_labels_missing");
    if (endingOutput.labels.length !== 2) return fail("assemble_ending_labels_invalid");
    if (trust.label.trim() === "" || doubt.label.trim() === "") {
      return fail("assemble_ending_labels_invalid");
    }
    return {
      ok: true,
      value: {
        worldDelta: plan.proposal.worldDelta,
        currentScene: { ...currentScene, choices: [] },
        continuationScenes: [],
        terminal: plan.proposal.terminal,
        endingLabels: { trust: trust.label, doubt: doubt.label },
      },
    };
  }

  return {
    ok: true,
    value: {
      worldDelta: plan.proposal.worldDelta,
      currentScene,
      continuationScenes,
      terminal: plan.proposal.terminal,
      endingLabels: null,
    },
  };
}
