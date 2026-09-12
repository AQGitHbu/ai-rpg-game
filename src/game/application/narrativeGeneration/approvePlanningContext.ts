import { repeatedDialogueCandidates, plannedReplyRejection, repeatedNpcResponseUnits } from "./dialogueContinuity";
import { previousDialogue } from "./dialogueContext";
import { ATMOSPHERE_BEAT_ID } from "@/game/domain/narrativeBeat";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { EvolutionNeed } from "@/game/domain/worldDelta";
import type { StoryState } from "@/game/domain/storyState";
import type { Unit } from "@/game/domain/narrativeUnit";
import type { PlanningContext } from "./stageSource";
import { approvePlan, approvePlanDecision, observationsForUnit, type ApprovedPlan } from "@/game/gameplay/rpg/narrativePlanning";
import { approveWorldDelta, materializeWorldDelta } from "@/game/gameplay/rpg/worldEvolution";
import { buildNarrativeBundleDescriptors } from "@/game/gameplay/rpg/narrativeBundle";
import { buildEntityContextProjection, buildWorldDeltaEntityContextClosure } from "../entityContextProjection";
import { committedBeatEvidenceIds, projectUnitContext } from "./perspectiveContext";
import { planningSceneContract } from "./planningSceneContract";

export function stagedEvolutionNeed(story: StoryState): EvolutionNeed {
  if (story.evolution.status === "needs_next_act") return { kind: "next_act", act: story.currentAct };
  if (story.evolution.status === "needs_ending_pair") return { kind: "ending_pair", finalAct: story.targetActs };
  return { kind: "none" };
}

/**
 * 只检查不依赖上游表达结果的 observation 归属。不能直接用空的 approved
 * map 跑完整 projectUnitContext：那会把尚未真实披露的条件观察当成已发生，
 * 但 observation 的来源类型、speaker、step/order 与所属 unit 在 planning
 * 阶段已经完全确定，应在任何表达请求前拒绝错误分配。
 */
function preflightObservationBindings(
  proposal: PlanProposal,
  approvedUnits: readonly Unit[],
): { readonly ok: false; readonly code: "beat_authority_conflict"; readonly detail: string } | null {
  for (const unit of approvedUnits) {
    const ownedObservationKeys = new Set(
      observationsForUnit(unit, proposal.observations).map((observation) => observation.key),
    );
    const requiredObservationKeys = unit.requiredObservationKeys.filter((key) => !ownedObservationKeys.has(key));
    const conditionalEvidence = unit.requiredBeats.flatMap((beat) => beat.evidence
      .filter((evidence): evidence is Extract<typeof evidence, { kind: "conditional" }> => evidence.kind === "conditional")
      .filter((evidence) => {
        if (ownedObservationKeys.has(evidence.observationKey)) return false;
        const observation = proposal.observations.find(candidate => candidate.key === evidence.observationKey);
        if (observation === undefined) return true;
        // conditional 既可以由本单元直接认领，也可以来自更早、且已声明
        // requiredObservationKeys 的依赖单元；后者必须等待真实上游输出，不能
        // 在 planning 阶段伪造“已披露”，但不应被静态预检误判为非法。
        return !approvedUnits.some(owner => owner.key !== unit.key
          && unit.dependencies.includes(owner.key)
          && owner.requiredObservationKeys.includes(observation.key)
          && observationsForUnit(owner, [observation]).some(candidate => candidate.key === observation.key));
      }));
    if (requiredObservationKeys.length === 0 && conditionalEvidence.length === 0) continue;

    const unavailableEvidence = [
      ...requiredObservationKeys.map((observationKey) => ({ kind: "required_observation", observationKey })),
      ...conditionalEvidence,
    ];
    return {
      ok: false,
      code: "beat_authority_conflict",
      detail: JSON.stringify({
        unitKey: unit.key,
        stage: unit.stage,
        stepKey: unit.point.stepKey,
        speakerId: unit.speakerId,
        unavailableEvidence,
        repairInstruction: "由规划器修正 observation 归属：requiredObservationKeys 必须由当前 unit 的合法来源认领；conditional evidence 必须由当前 unit 或更早依赖 unit 提供已披露观察。narration 只能认领 witness 观察，character 只能认领自己 speakerId 的 speech 观察；同时保持 observation 与 unit 位于同一 step 且顺序合法。",
      }),
    };
  }
  return null;
}

/** 逐单元检查静态权限；上游真实披露可能改变的视角留到运行时重新投影。 */
function preflightStaticAuthority(plan: ApprovedPlan, detail?: string): { ok: false; code: string; detail?: string } | null {
  for (const unit of plan.units) {
    const waitsForObservation = plan.units.some(owner => unit.dependencies.includes(owner.key)
      && (owner.point.stepKey !== unit.point.stepKey || owner.point.order < unit.point.order)
      && observationsForUnit(owner, plan.proposal.observations).some(observation =>
        owner.requiredObservationKeys.includes(observation.key)
        && observation.audienceIds.includes(unit.speakerId ?? "player_0")
        && observation.audienceIds.includes("player_0")));
    if (waitsForObservation) continue;
    const context = projectUnitContext({ plan, unit, approved: new Map(), purpose: "planning" });
    if (!context.ok && (context.code === "beat_authority_conflict" || context.code === "choice_intent_authority_conflict")) {
      return { ...context, detail: JSON.stringify({ ...JSON.parse(detail ?? "{}"), ...JSON.parse(context.detail ?? "{}") }) };
    }
  }
  return null;
}

/** 所有结构审批发生在表达请求之前；世界增量只预览，发布时仍在单次 CAS 中提交。 */
export function approvePlanningContext(input: PlanningContext, proposal: PlanProposal): ReturnType<typeof approvePlan> & { readonly detail?: string } {
  const repeatedResponseUnits = repeatedNpcResponseUnits(proposal);
  if (repeatedResponseUnits.length > 0) return { ok: false, code: "plan_character_response_split",
    detail: JSON.stringify({ repeatedResponseUnits,
      repairInstruction: "同一 stepKey 的同一 NPC 只能有一个 character 单元；把回答、未知范围、态度和协助内容合并进该单元的完整 brief/task，不自动拆分或依赖表达器补全。" }) };
  if (input.kind === "opening") {
    const approved = approvePlan({ kind: "opening", proposal, generation: input.generation,
      gameLength: input.input.gameLength, seed: input.input.seed });
    if (!approved.ok) return approved;
    const result = approvePlanDecision(approved.value);
    if (!result.ok) return result;
    return preflightObservationBindings(proposal, result.value.units) ?? preflightStaticAuthority(result.value) ?? result;
  }
  let world = input.world;
  let story = input.story;
  const need = stagedEvolutionNeed(story);
  if ((need.kind === "next_act" || need.kind === "ending_pair") && proposal.worldDelta === null) {
    return { ok: false, code: "planning_world_delta_required", detail: "本次规则要求 " + need.kind + "，worldDelta 不得为 null；next_act 必须包含 nextMainQuest 和能支撑目标的实体，ending_pair 必须提供两个 endingPair。" };
  }
  if (proposal.worldDelta !== null) {
    const delta = approveWorldDelta({ proposal: proposal.worldDelta, need, ws: world, ss: story,
      entityContextClosure: buildWorldDeltaEntityContextClosure({ worldState: world, storyState: story, job: input.job }) });
    if (!delta.ok) return { ok: false, code: `world_delta_rejected:${delta.code}:${delta.reason}`, detail: JSON.stringify({
      currentLocationId: world.currentLocationId,
      occupiedNames: buildEntityContextProjection({ worldState: world, storyState: story, job: input.job }).occupiedNames,
      repairInstruction: "已存在实体不是新建模板；沿用已有 ID，不重新创建同名 NPC/地点。新实体名称必须未占用。新地图地点从 currentLocationId 接入；npc_gift 必须同批有 nextMainQuest/newNpc 且物品与赠予 NPC 共址，否则不能声明该取得方式。",
    }) };
    const preview = materializeWorldDelta({ approved: delta.approved, need, ws: world, ss: story,
      eventContext: { turnId: input.job.turnId, turnNumber: input.job.turnNumber,
        actionId: input.job.actionId, domainEventIds: input.job.domainEventIds,
        episodeKey: String(input.job.turnId), eventKey: `blueprint_expanded:${input.job.jobId}:bundle` } });
    world = preview.previewWorldState; story = preview.previewStoryState;
  }
  const reveal = story.reveal;
  const transition = input.job.objectiveTransition.after === null && need.kind === "next_act" && reveal != null
    ? { ...input.job.objectiveTransition, after: { questId: reveal.questId, objectiveIndex: reveal.visibleObjectiveIndex, label: "next_act_arrival" }, mode: "advanced_act" as const }
    : input.job.objectiveTransition;
  const graph = buildNarrativeBundleDescriptors({ worldState: world, storyState: story, transition });
  const steps = graph.steps.map(step => ({ key: step.stepKey, trigger: step.trigger, next: step.nextStepKeys }));
  const requiredNarrationBeats = input.job.mandatoryBeats
    .filter(beat => beat.beatId !== ATMOSPHERE_BEAT_ID)
    .map(beat => ({ beatId: beat.beatId, kind: beat.kind, stepKey: "current", stage: "narration" }));
  const narrations = proposal.units.filter(unit => unit.stage === "narration" && unit.point.stepKey === "current");
  const narrationBeats = narrations.flatMap(unit => unit.requiredBeats);
  const unexpectedNarrationBeatIds = [...new Set(narrationBeats.filter(beat => beat.beatId !== ATMOSPHERE_BEAT_ID
    && !requiredNarrationBeats.some(required => required.beatId === beat.beatId)).map(beat => beat.beatId))];
  const detail = JSON.stringify({ steps, terminal: graph.terminal, approvedWorldDelta: proposal.worldDelta,
    sceneContract: planningSceneContract(graph, input.job.focusNpcId ?? null), requiredNarrationBeats,
    ...(unexpectedNarrationBeatIds.length === 0 ? {} : {
      unexpectedNarrationBeatIds,
      repairInstruction: "从 current narration.requiredBeats 移除这些未允许的节拍 ID；它们的普通可见叙述可并入 atmosphere，不新增事实或删除 NPC 对玩家的正常回应。",
    }),
  });
  const currentBeatEvidence = Object.fromEntries(input.job.mandatoryBeats
    .filter(beat => beat.kind === "quest_progress" || beat.kind === "quest_advanced")
    .map(beat => [beat.beatId, world.eventLedger.filter(event =>
      input.job.domainEventIds.includes(event.eventId) && event.payload.type === "quest_completed"
      && (input.job.objectiveTransition.completed.some(objective => event.payload.type === "quest_completed" && objective.questId === event.payload.questId)
        // ready_for_ending 的既有契约刻意返回 completed=[]；本回合完成事件仍能证明 before 目标收束。
        || (input.job.objectiveTransition.mode === "ready_for_ending"
          && input.job.objectiveTransition.before?.questId === event.payload.questId)))
      .map(event => String(event.eventId))]));
  const eventIds = new Set(world.eventLedger.map(event => String(event.eventId)));
  if (proposal.units.some(unit => unit.requiredBeats.some(beat =>
    beat.evidence.some(ref => ref.kind === "committed" && !eventIds.has(ref.eventId))))) {
    return { ok: false, code: "plan_evidence_unknown", detail: JSON.stringify({ ...JSON.parse(detail), repairInstruction: "committed.eventId 必须是实际提交的事件 ID，不能写事件 kind；无可核验的事实来源时 evidence 写 []。" }) };
  }
  for (const unit of proposal.units) {
    const sources = committedBeatEvidenceIds(world, unit);
    const invalidBeats = unit.requiredBeats.flatMap(beat => {
      const allowed = new Set([...sources, ...(unit.stage === "narration" && unit.point.stepKey === "current"
        ? currentBeatEvidence[beat.beatId] ?? [] : [])]);
      const invalidEventIds = beat.evidence.flatMap(ref => ref.kind === "committed" && !allowed.has(ref.eventId) ? [ref.eventId] : []);
      return invalidEventIds.length === 0 ? [] : [{ beatId: beat.beatId, invalidEventIds, allowedEventIds: [...allowed] }];
    });
    if (invalidBeats.length > 0) {
      return { ok: false, code: "plan_evidence_not_fact_source", detail: JSON.stringify({ ...JSON.parse(detail),
        unitKey: unit.key, invalidBeats,
        repairInstruction: "只修复列出的节拍证据：committed 引用只能选该节拍 allowedEventIds 内且确实支持它的事件；不需要证据时用 []。不要换成另一个未允许的关系/交谈事件。当前旁白的任务推进节拍可引用本回合对应的任务完成事件，但这不授予任何事实知识；其他单元仍只能用自身知识来源。保留已批准的 worldDelta 与 sceneContract。",
      }) };
    }
  }
  // 比较结构值而非 JSON 属性顺序；数组顺序是执行路径的一部分。
  if (proposal.steps.length !== steps.length || steps.some(step => {
    const proposed = proposal.steps.find(candidate => candidate.key === step.key);
    return proposed === undefined || Object.entries(step.trigger).some(([key, value]) => (proposed.trigger as unknown as Record<string, unknown>)[key] !== value)
      || JSON.stringify(proposed.next) !== JSON.stringify(step.next);
  })) return { ok: false, code: "plan_scene_graph_mismatch", detail };
  const terminal = graph.terminal;
  if (proposal.terminal.kind !== terminal.kind || (terminal.kind === "next_decision" && (proposal.terminal.kind !== "next_decision"
    || proposal.terminal.target.kind !== terminal.target.kind || (terminal.target.kind === "continuation_step"
      && (proposal.terminal.target.kind !== "continuation_step" || proposal.terminal.target.stepKey !== terminal.target.stepKey))))) {
    return { ok: false, code: "plan_terminal_graph_mismatch", detail };
  }
  // 当前规则结果须在旁白 segments 中各覆盖一次；NPC 的回答不能替代旁白。
  // 只校验职责分配，不搬移或补写模型节拍，不扩大任何表达视角的知识权限。
  const lastNarrationOrder = Math.max(...narrations.map(unit => unit.point.order));
  if (narrations.some(unit => unit.point.order < lastNarrationOrder
    && (unit.requiredBeats.length === 0 || unit.requiredBeats.some(beat => beat.beatId === ATMOSPHERE_BEAT_ID)))
    || narrationBeats.some(beat => beat.beatId === ATMOSPHERE_BEAT_ID && beat.kind !== "atmosphere")
    || unexpectedNarrationBeatIds.length > 0 || requiredNarrationBeats.some(required => {
    const matches = narrationBeats.filter(beat => beat.beatId === required.beatId);
    return matches.length !== 1 || matches[0]?.kind !== required.kind;
  })) return { ok: false, code: "plan_mandatory_beat_mismatch", detail };
  const approved = approvePlan({ kind: "decision", proposal, world, story });
  const utterance = input.job.selectedDialogue?.label ?? input.job.utterance;
  const previous = previousDialogue(input);
  const result = approved.ok ? approvePlanDecision({ ...approved.value, ruleSceneGraph: graph, currentBeatEvidence,
    ...(utterance === undefined ? {} : { currentUtterance: { npcId: input.job.focusNpcId ?? null, text: utterance,
      inquiries: input.job.selectedDialogue?.task?.inquiries,
      selectedTask: input.job.selectedDialogue?.task,
      ...(previous === null ? {} : { previousReply: previous.reply, previousChoices: previous.choices }),
    } }),
  }) : approved;
  if (!result.ok) return { ...result, detail };
  const replyRejection = plannedReplyRejection(input.job, proposal);
  if (replyRejection !== null) return { ok: false, code: replyRejection, detail: JSON.stringify({
    ...JSON.parse(detail), selectedDialogue: input.job.selectedDialogue,
    repairInstruction: "当前焦点 NPC 的 task.answers 必须逐项决定已问维度的 answer/unknown/refuse；答案引用限本任务可说事实。先确定回答结果，再规划后续选项，不把回答内容留给润色器决定。",
  }) };
  const repeatedCandidates = repeatedDialogueCandidates(input.job, proposal);
  if (repeatedCandidates.length > 0) return { ok: false, code: "plan_dialogue_repeated", detail: JSON.stringify({
    ...JSON.parse(detail), repeatedCandidates, selectedDialogue: input.job.selectedDialogue,
    repairInstruction: "这些候选重复了玩家刚向同一 NPC 问过的具体维度。先回应已问内容；不知道时明确不知道，再围绕尚未问过的维度、其他已知事实或不同回应意图重做候选。不能只换措辞、删掉 inquiries 或重复询问；不编造答案，不扩大知识权限。保留已批准的 worldDelta 与 sceneContract。",
  }) };
  const observationBindingFailure = preflightObservationBindings(proposal, result.value.units);
  if (observationBindingFailure !== null) return observationBindingFailure;
  return preflightStaticAuthority(result.value, detail) ?? result;
}
