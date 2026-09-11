// 条件证据兑现（Plan 2026-09-09 / Task 9）。
//
// 获批 bundle 只保存 observationKey 与受众映射，认知的**权威提交**发生在
// 该步骤被真实消费的那一刻：本函数把条件引用铸成 narrative_observed 事件
// 草稿，并把对应的 NPC 知识写入绑定到同一批真实 EventId 上。
//
// 顺序固定：先按确定性 eventKey 预铸 EventId（commitEventDrafts 用同一
// eventIdFor 规则，因此这里预铸的 ID 就是最终 ID），再用它作为知识来源的
// provenance，最后与场景事件在同一批 commit 里落账。条件引用在消费前始终
// 只是条件，绝不进入已提交 ledger。

import { eventIdFor, type EventCauseKey, type NarrativeEventDraft, type TurnId } from "@/game/domain/events";
import type { LocationId } from "@/game/domain/worldEntity";
import { PLAYER_ENTITY_ID, asFactId, asNpcId } from "@/game/domain/worldEntity";
import type { FactChange } from "@/game/domain/resolvedEvent";
import type { WorldState } from "@/game/domain/worldState";
import type {
  BundleStepObservation,
} from "@/game/domain/narrativeBundle";
import {
  applyEntityMutations,
  knowledgeReferences,
  type EntityMutation,
} from "@/game/gameplay/rpg/entityWorld";
import { knowledgeWritesFromFactChange } from "@/game/gameplay/rpg/npcMemory";
import { buildNpcSpeechAuthority } from "../npcSpeechAuthority";
import type { NpcEntityRecord } from "@/game/domain/entity";

/** scene 条件证据条目（与 domain 的 conditionalEvidence 同形，避免反向依赖）。 */
export type ConditionalEvidenceEntry = Readonly<{
  readonly partIndex: number;
  readonly observationKey: string;
  readonly audienceId: string;
}>;

export type RealizeObservationsInput = Readonly<{
  readonly worldState: WorldState;
  readonly stepId: string;
  readonly observations: readonly BundleStepObservation[];
  readonly conditionalEvidence: readonly ConditionalEvidenceEntry[];
  readonly turnId: TurnId;
  readonly actionId: string;
  readonly turnNumber: number;
  readonly episodeKey: string;
  readonly locationId: LocationId | null;
  readonly causeKeys: readonly EventCauseKey[];
}>;

export type RealizeObservationsResult =
  | { readonly ok: true; readonly worldState: WorldState; readonly drafts: readonly NarrativeEventDraft[] }
  | { readonly ok: false; readonly code: string };

function draftEventKey(stepId: string, observationKey: string, audienceId: string): string {
  return `narrative_observed:${stepId}:${observationKey}:${audienceId}`;
}

/** 该受众是否已把这条事实作为 known 记在册上（用于阻止传闻降级）。 */
function audienceAlreadyKnows(worldState: WorldState, audienceId: string, factId: string): boolean {
  const record = worldState.entityStore.records.find(
    (candidate): candidate is NpcEntityRecord =>
      candidate.core.kind === "npc" && String(candidate.core.id) === audienceId,
  );
  if (record === undefined) return false;
  const entry = record.knowledge.entries.find((candidate) => String(candidate.factId) === factId);
  return entry?.certainty === "known";
}

/**
 * 兑现已消费步骤的条件证据：返回待提交的事件草稿与已写入知识的世界状态。
 * 任一条证据找不到对应观察一律 fail-closed——没有来源的披露不能落账。
 */
export function realizeObservations(input: RealizeObservationsInput): RealizeObservationsResult {
  const { worldState, stepId, observations, conditionalEvidence } = input;
  if (conditionalEvidence.length === 0) {
    return { ok: true, worldState, drafts: [] };
  }

  const byKey = new Map(observations.map((observation) => [observation.key, observation]));
  const drafts: NarrativeEventDraft[] = [];
  const mutations: EntityMutation[] = [];

  const learned = new Map<string, "known" | "suspected">();
  const seen = new Set<string>();
  for (const entry of conditionalEvidence) {
    const observation = byKey.get(entry.observationKey);
    if (observation === undefined) return { ok: false, code: "observation_source_missing" };
    const eventKey = draftEventKey(stepId, entry.observationKey, entry.audienceId);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    if (!worldState.worldFacts.some(fact => String(fact.factId) === observation.factId)) return { ok: false, code: "observation_fact_unknown" };
    const audienceLocation = entry.audienceId === String(PLAYER_ENTITY_ID) ? worldState.currentLocationId
      : worldState.npcs.find(npc => String(npc.id) === entry.audienceId)?.locationId;
    if (audienceLocation === undefined || audienceLocation !== input.locationId) return { ok: false, code: "observation_audience_absent" };
    if (observation.source.kind === "speech" && !worldState.npcs.some(npc =>
      String(npc.id) === (observation.source.kind === "speech" ? observation.source.speakerId : "") && npc.locationId === input.locationId)) return { ok: false, code: "observation_speaker_absent" };
    if (observation.source.kind === "speech") {
      const speakerId = observation.source.speakerId;
      const speaker = worldState.entityStore.records.find((record): record is NpcEntityRecord =>
        record.core.kind === "npc" && String(record.core.id) === speakerId);
      const knowledge = speaker?.knowledge.entries.find(entry => String(entry.factId) === observation.factId);
      const earlier = learned.get(`${speakerId}:${observation.factId}`);
      if (knowledge !== undefined) {
        const authority = buildNpcSpeechAuthority({ store: worldState.entityStore,
          targetContext: { targetId: PLAYER_ENTITY_ID },
          speakerNpcId: asNpcId(speakerId), sceneVisibleFactIds: [asFactId(observation.factId)],
          eventLedger: worldState.eventLedger });
        if (!authority?.allowedFactIds.some(id => String(id) === observation.factId)
          || (observation.certainty === "known" && knowledge.certainty !== "known")) {
          return { ok: false, code: "observation_speech_authority_changed" };
        }
      } else if (earlier === undefined || (observation.certainty === "known" && earlier !== "known")) {
        return { ok: false, code: "observation_speech_authority_changed" };
      }
    }
    const learnedKey = `${entry.audienceId}:${observation.factId}`;
    if (learned.get(learnedKey) !== "known") learned.set(learnedKey, observation.certainty);
    const eventId = eventIdFor(input.turnId, eventKey);
    const isPlayerAudience = entry.audienceId === String(PLAYER_ENTITY_ID);

    drafts.push({
      eventKey,
      episodeKey: input.episodeKey,
      actorIds: observation.source.kind === "speech"
        ? [asNpcId(observation.source.speakerId)]
        : [PLAYER_ENTITY_ID],
      targetIds: isPlayerAudience ? [PLAYER_ENTITY_ID] : [asNpcId(entry.audienceId)],
      locationId: input.locationId,
      causeKeys: input.causeKeys,
      factIds: [asFactId(observation.factId)],
      questIds: [],
      outcome: "neutral",
      salience: 50,
      payload: {
        type: "narrative_observed",
        observationKey: entry.observationKey,
        audienceId: entry.audienceId,
        factId: asFactId(observation.factId),
        certainty: observation.certainty,
        source: observation.source.kind === "speech"
          ? { kind: "speech", speakerId: asNpcId(observation.source.speakerId) }
          : { kind: "witness" },
      },
    });

    // 玩家认知由 ledger 重建，不写知识组件；NPC 受众才落权威知识。
    if (isPlayerAudience) continue;
    // 已知的世界事实不得因「听到别人怀疑」而降级：suspected 观察对已在册且
    // 已是 known 的条目只追加事件，不重写 component（写入口也会拒绝降级）。
    if (observation.certainty === "suspected" && audienceAlreadyKnows(worldState, entry.audienceId, observation.factId)) {
      continue;
    }
    const change: FactChange = {
      factId: asFactId(observation.factId),
      change: "discovered",
      source: observation.source.kind === "speech" ? "npc_revealed" : "scene_witness",
      audience: [asNpcId(entry.audienceId)],
    };
    const mapped = knowledgeWritesFromFactChange(
      change,
      {
        actionId: input.actionId,
        turnNumber: input.turnNumber,
        eventId,
        certainty: observation.certainty,
        ...(observation.source.kind === "speech"
          ? { speakerNpcId: asNpcId(observation.source.speakerId) }
          : {}),
      },
      knowledgeReferences(worldState.entityStore.records),
    );
    // 未知 fact / 未知受众 / 非新增类变化都零写入；只有真 invariant 违背才拒绝。
    if (!mapped.ok) return { ok: false, code: mapped.code };
    for (const write of mapped.writes) {
      mutations.push({
        kind: "record_npc_knowledge",
        npcId: write.npcId,
        factId: write.factId,
        certainty: write.certainty,
        disclosure: write.disclosure,
        source: write.source,
      });
    }
  }

  if (mutations.length === 0) return { ok: true, worldState, drafts };
  const applied = applyEntityMutations(worldState, mutations);
  if (!applied.ok) return { ok: false, code: "entity_mutation_rejected" };
  return { ok: true, worldState: applied.worldState, drafts };
}
