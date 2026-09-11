// 批准后的披露匹配（Spec 2026-09-09 / Plan Task 4 Step 4）。
//
// collectDisclosures 是纯规则匹配：给定一个已批准单元的输出，核对计划观察
// 「确实被该单元以句段 fact 引用的方式披露」。不做文本挖掘、不创建 fact、
// 不写知识组件——披露认知的真实提交发生在 Task 9 的整包发布消费阶段。
//
// 失败一律 fail-closed：遗漏引用、certainty 升级、secret 披露、不在场受众、
// 未知说话人与幽灵事实都返回稳定 code，绝不静默丢弃。

import type { ApprovedPlan } from "./approvePlan";
import { sceneSnapshot } from "./sceneSnapshot";
import {
  fail,
  type Check,
  type Unit,
  type UnitOutput,
} from "@/game/domain/narrativeUnit";
import type { Observation } from "@/game/domain/narrativeObservation";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import {
  getEntity,
  type EnemyEntityRecord,
  type EntityRecord,
  type FactEntityRecord,
  type NpcEntityRecord,
  type PlayerEntityRecord,
} from "@/game/domain/entity";

function isNpcRecord(record: EntityRecord | undefined): record is NpcEntityRecord {
  return record !== undefined && record.core.kind === "npc";
}

function isFactRecord(record: EntityRecord | undefined): record is FactEntityRecord {
  return record !== undefined && record.core.kind === "fact";
}

/**
 * 观察与单元的归属关系：角色单元认领「自己开口说出」的 speech 观察，
 * 旁白单元认领 witness 观察。选项单元不披露认知。collectDisclosures 与
 * perspectiveContext 的观察引用授权共用这一条归属规则（单一事实来源）。
 *
 * 归属还必须是「本单元时点之前已发生」的观察：同一 NPC 在多个 step 说话时，
 * 前一个 step 的单元只认领自己 step 内、且 order 不大于自己的观察，否则会被
 * 迫披露尚未发生的后续场景观察（任何输出都无法通过）。这与 checkUnitGraph
 * 的单元-观察时点约束保持同一语义。
 */
export function observationsForUnit(
  unit: Unit,
  observations: readonly Observation[],
): readonly Observation[] {
  const atOrBefore = (observation: Observation): boolean =>
    observation.point.stepKey === unit.point.stepKey
    && (observation.point.order === unit.point.order || unit.requiredObservationKeys.includes(observation.key));
  if (unit.stage === "narration") {
    return observations.filter(
      (observation) => observation.source.kind === "witness" && atOrBefore(observation),
    );
  }
  if (unit.stage === "character" && unit.speakerId !== null) {
    return observations.filter(
      (observation) =>
        observation.source.kind === "speech"
        && observation.source.speakerId === unit.speakerId
        && atOrBefore(observation),
    );
  }
  return [];
}

/** 带 position 的实体（npc / player / enemy）；判别联合的窄化用显式谓词承担。 */
function hasPosition(
  record: EntityRecord,
): record is NpcEntityRecord | PlayerEntityRecord | EnemyEntityRecord {
  return (
    record.core.kind === "npc"
    || record.core.kind === "player_character"
    || record.core.kind === "enemy"
  );
}

function locationOf(ws: WorldState, entityId: string): string | null {
  const record = getEntity(ws.entityStore, entityId);
  if (record === undefined) return null;
  if (!hasPosition(record)) return null;
  return String(record.position.locationId);
}

function factRecordOf(ws: WorldState, factId: string): FactEntityRecord | undefined {
  const record = getEntity(ws.entityStore, factId);
  return isFactRecord(record) ? record : undefined;
}

/**
 * 披露可用性：knowledge entry 必须存在且非 secret；conditional 只对与玩家
 * 关系达到 cooperative 及以上的说话人开放（与 npcSpeechAuthority 的
 * canDisclose 同一语义；该函数未导出，这里按同表实现并保持同步注释）。
 */
function disclosureAvailable(speaker: NpcEntityRecord, observation: Observation): boolean {
  const entry = speaker.knowledge.entries.find(
    (candidate) => String(candidate.factId) === observation.fact.factId,
  );
  if (entry === undefined) return false;
  if (entry.disclosure === "secret") return false;
  if (entry.disclosure === "conditional") {
    const edge = speaker.relationships.outgoing.find(
      (candidate) => String(candidate.targetId) === String(PLAYER_ENTITY_ID),
    );
    return edge?.stage === "cooperative" || edge?.stage === "trusted" || edge?.stage === "bonded";
  }
  return true;
}

/** speech 来源不得升级 certainty：观察要求 known 时说话人自身必须已知。 */
function certaintySupported(speaker: NpcEntityRecord, observation: Observation): boolean {
  if (observation.fact.certainty !== "known") return true;
  const entry = speaker.knowledge.entries.find(
    (candidate) => String(candidate.factId) === observation.fact.factId,
  );
  return entry !== undefined && entry.certainty === "known";
}

function factRefsOf(output: UnitOutput): ReadonlyMap<string, "known" | "suspected"> {
  const refs = new Map<string, "known" | "suspected">();
  if (output.stage === "choices") return refs;
  for (const part of output.parts) {
    for (const fact of part.facts) {
      refs.set(fact.factId, fact.certainty);
    }
  }
  return refs;
}

function checkObservation(input: Readonly<{
  ws: WorldState;
  observation: Observation;
  refs: ReadonlyMap<string, "known" | "suspected">;
  sceneLocation: string | null;
  learned?: readonly Observation[];
}>): string | null {
  const { ws, observation, refs, sceneLocation } = input;
  // 见证观察锚定玩家所在场景；speech 观察锚定说话人所在地点。
  let anchorLocation = sceneLocation;
  if (observation.source.kind === "speech") {
    const speaker = getEntity(ws.entityStore, observation.source.speakerId);
    if (!isNpcRecord(speaker)) return "observation_speaker_unknown";
    anchorLocation = String(speaker.position.locationId);
  }
  // 在场性先于披露可用性：不在场的受众根本不构成一次披露尝试。
  for (const audienceId of observation.audienceIds) {
    const audienceLocation = locationOf(ws, audienceId);
    if (audienceLocation === null || audienceLocation !== anchorLocation) {
      return "observation_audience_absent";
    }
  }
  if (observation.source.kind === "speech") {
    const speaker = getEntity(ws.entityStore, observation.source.speakerId);
    if (!isNpcRecord(speaker)) return "observation_speaker_unknown";
    const entry = speaker.knowledge.entries.find(entry => String(entry.factId) === observation.fact.factId);
    const learned = input.learned?.find(prior => prior.fact.factId === observation.fact.factId
      && prior.audienceIds.includes(observation.source.kind === "speech" ? observation.source.speakerId : "")
      && observation.audienceIds.every(id => prior.audienceIds.includes(id)));
    if (entry !== undefined || learned === undefined) {
      if (!disclosureAvailable(speaker, observation)) return "observation_disclosure_unavailable";
      if (!certaintySupported(speaker, observation)) return "observation_certainty_invalid";
    } else if (learned.fact.certainty === "suspected" && observation.fact.certainty === "known") return "observation_certainty_invalid";
  }
  if (factRecordOf(ws, observation.fact.factId) === undefined) {
    return "observation_fact_unknown";
  }
  const reference = refs.get(observation.fact.factId);
  if (reference === undefined) return "observation_not_disclosed";
  // 输出 certainty 不得高于观察声明的 certainty：允许「确定→存疑」的降级表达，
  // 禁止把存疑观察说成确定（升级）。与 prompt 的「不得升级」和 spec「疑似事实
  // 只能用不确定表达」同一语义。
  if (reference === "known" && observation.fact.certainty === "suspected") {
    return "observation_certainty_invalid";
  }
  return null;
}

export type CollectDisclosuresInput = Readonly<{
  plan: ApprovedPlan;
  unit: Unit;
  output: UnitOutput;
  approved?: ReadonlyMap<string, UnitOutput>;
}>;

/**
 * 核对一个已批准单元输出对计划观察的披露：每个归属观察都必须有同 certainty
 * 的句段 fact 引用，受众实际在场且披露可用。全部通过时按计划顺序返回观察，
 * 供发布阶段（Task 9）铸造 narrative_observed 事件草稿。
 */
export function collectDisclosures(input: CollectDisclosuresInput): Check<readonly Observation[]> {
  const unit = input.plan.units.find((candidate) => candidate.key === input.unit.key);
  if (unit === undefined) return fail("unknown_unit");
  if (input.output.stage !== unit.stage) return fail("unit_output_stage_mismatch");
  if (unit.stage === "character") {
    if (input.output.stage === "character" && input.output.speakerId !== unit.speakerId) {
      return fail("unit_output_stage_mismatch");
    }
  }

  const snapshot = sceneSnapshot({ plan: input.plan, point: unit.point, approved: input.approved });
  if (!snapshot.ok) return snapshot;
  const ws = snapshot.value.world;
  const observations = observationsForUnit(unit, input.plan.proposal.observations);
  const refs = factRefsOf(input.output);
  const sceneLocation = locationOf(ws, String(PLAYER_ENTITY_ID));

  for (const observation of observations) {
    const rejection = checkObservation({ ws, observation, refs, sceneLocation, learned: snapshot.value.learned });
    if (rejection !== null) return fail(rejection);
  }
  return { ok: true, value: observations.map(observation => ({ ...observation,
    fact: { ...observation.fact, certainty: refs.get(observation.fact.factId) ?? observation.fact.certainty },
  })) };
}
