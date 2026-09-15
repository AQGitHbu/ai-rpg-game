import { getEntity, type NpcEntityRecord } from "@/game/domain/entity";
import { commitEventDrafts } from "@/game/domain/eventLedger";
import { eventIdFor, type NarrativeEventDraft, type TurnId } from "@/game/domain/events";
import type { SceneExpressionProposal } from "@/game/domain/sceneExpression";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { asFactId, asNpcId, PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { applyEntityMutations } from "@/game/gameplay/rpg/entityWorld";
import { reconcileStoryConsequences } from "./reconcileStoryConsequences";

/** Read-only authority projection after one approved line; never persisted. */
export function projectSceneSpeechKnowledge(worldState: WorldState, line: Extract<SceneExpressionProposal, { kind: "npc_line" }>): WorldState {
  const speaker = getEntity(worldState.entityStore, line.npcId);
  if (speaker?.core.kind !== "npc") return worldState;
  const incoming = (speaker as NpcEntityRecord).knowledge.entries.filter(entry => line.usedFactIds.includes(String(entry.factId)));
  return { ...worldState, entityStore: { ...worldState.entityStore, records: worldState.entityStore.records.map(record => {
    if (record.core.kind !== "npc" || !line.audienceIds.includes(String(record.core.id)) || record.core.id === speaker.core.id) return record;
    const npc = record as NpcEntityRecord;
    const entries = [...npc.knowledge.entries];
    for (const heard of incoming) {
      const index = entries.findIndex(entry => entry.factId === heard.factId);
      // Actual writes use the same policy: certainty can improve, but an
      // existing listener's source/disclosure are never overwritten.
      if (index >= 0) entries[index] = { ...entries[index]!, certainty: "known" };
      else entries.push({ ...heard, certainty: "known" });
    }
    return { ...npc, knowledge: { ...npc.knowledge, entries } };
  }) } };
}

/** Apply only permission-approved, resolved current-scene lines. No Action is replayed. */
export function previewSceneDisclosure(input: {
  worldState: WorldState; storyState: StoryState; expressions: readonly SceneExpressionProposal[];
  source: { actionId: string; turnId: TurnId; turnNumber: number };
}) {
  const { worldState, storyState, source } = input;
  const fail = (code: string) => ({ ok: false as const, code });
  const presentNpc = (id: string): NpcEntityRecord | undefined => {
    const npc = getEntity(worldState.entityStore, id);
    return npc?.core.kind === "npc" && npc.core.lifecycle === "active"
      && (npc as NpcEntityRecord).position.locationId === worldState.currentLocationId ? npc as NpcEntityRecord : undefined;
  };
  let nextWorld = worldState;
  const drafts: NarrativeEventDraft[] = [];
  for (const [index, line] of input.expressions.entries()) {
    if (line.kind !== "npc_line") continue;
    if (presentNpc(line.npcId) === undefined) return fail("missing_speaker");
    for (const audienceId of line.audienceIds) {
      if (audienceId === String(PLAYER_ENTITY_ID) || audienceId === line.npcId) continue;
      if (presentNpc(audienceId) === undefined) return fail("invalid_audience");
      for (const rawFactId of line.usedFactIds) {
        const npc = getEntity(nextWorld.entityStore, audienceId) as NpcEntityRecord;
        const prior = npc.knowledge.entries.find(entry => String(entry.factId) === rawFactId);
        if (prior?.certainty === "known") continue;
        const speaker = getEntity(nextWorld.entityStore, line.npcId) as NpcEntityRecord;
        const sourceEntry = speaker.knowledge.entries.find(entry => String(entry.factId) === rawFactId);
        // Hearing a fact is not permission to rebroadcast it. Preserve the
        // listener's policy, or inherit the actual speaker's policy for a new
        // entry (including knowledge received earlier in this same scene).
        const disclosure = prior?.disclosure ?? sourceEntry?.disclosure ?? "public";
        const npcId = asNpcId(audienceId);
        const factId = asFactId(rawFactId);
        // Array position and actor preserve the actual source line; no future
        // scene or inferred audience can acquire this event's provenance.
        const eventKey = `scene_disclosure:${index}:${npcId}:${factId}`;
        const applied = applyEntityMutations(nextWorld, [{ kind: "record_npc_knowledge", npcId, factId,
          certainty: "known", disclosure, source: { kind: "action", mode: "npc_revealed",
            actionId: source.actionId, turnNumber: source.turnNumber, eventId: eventIdFor(source.turnId, eventKey), sourceNpcId: asNpcId(line.npcId) } }]);
        if (!applied.ok) return fail(applied.code);
        nextWorld = applied.worldState;
        drafts.push({ eventKey, episodeKey: "turn", actorIds: [asNpcId(line.npcId)], targetIds: [npcId],
          locationId: worldState.currentLocationId, causeKeys: [], factIds: [factId], questIds: [], outcome: "success", salience: 65,
          payload: { type: "npc_knowledge_changed", npcId, factId, change: prior === undefined ? "learned" : "certainty_upgraded" } });
      }
    }
  }
  if (drafts.length === 0) return { ok: true as const, worldState, storyState, drafts };
  // Preview timestamps never escape into the committed world. IDs and cause
  // order are minted by the same helper as the final, single B append.
  const committed = commitEventDrafts({ ledger: worldState.eventLedger, drafts,
    source: { ...source, committedAt: "2000-01-01T00:00:00.000Z" }, entityStore: nextWorld.entityStore });
  if (!committed.ok) return fail(committed.code);
  const consequences = reconcileStoryConsequences({ worldState: nextWorld, storyState, triggerEvents: committed.appended, source });
  return { ok: true as const, worldState: consequences.worldState, storyState: consequences.storyState,
    drafts: [...drafts, ...consequences.drafts] };
}
