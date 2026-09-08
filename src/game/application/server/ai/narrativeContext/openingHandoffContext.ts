import type { EventId } from "@/game/domain/events";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { WorldState } from "@/game/domain/worldState";
import { rebuildEpisodicMemory } from "@/game/domain/episodicMemory";
import { renderNarrativeMemory, retrieveNarrativeMemory } from "@/game/gameplay/rpg/narrativeMemory";

export type OpeningHandoffContext = Readonly<{
  requiredEventIds: readonly EventId[];
  publicText: string;
}>;

function openingEvent(event: WorldState["eventLedger"][number]): boolean {
  return event.kind === "opening_history_established" || event.kind === "opening_thread_established";
}

/**
 * Project the approved opening causality into the first decision request.
 * Event references may include private facts, while rendering stays delegated
 * to narrative memory's existing public-fact policy.
 */
export function buildOpeningHandoffContext(input: Readonly<{
  worldState: WorldState;
  job: PendingNarrativeJob;
}>): OpeningHandoffContext | null {
  const { worldState, job } = input;
  if (job.turnNumber !== 1 || !worldState.eventLedger.some((event) => event.kind === "game_initialized")) return null;

  const byId = new Map(worldState.eventLedger.map((event) => [String(event.eventId), event]));
  const selected = new Set<string>();
  const addWithCauses = (event: WorldState["eventLedger"][number]): void => {
    if (!openingEvent(event) || selected.has(String(event.eventId))) return;
    selected.add(String(event.eventId));
    for (const causeId of event.causeEventIds) {
      const cause = byId.get(String(causeId));
      if (cause !== undefined) addWithCauses(cause);
    }
  };

  const topic = job.selectedDialogue?.topic;
  if (topic?.kind === "thread") {
    const event = worldState.eventLedger.find((candidate) =>
      candidate.payload.type === "opening_thread_established"
      && candidate.payload.threadId === String(topic.threadId));
    if (event !== undefined) addWithCauses(event);
  } else if (topic?.kind === "fact") {
    for (const event of worldState.eventLedger) {
      if (openingEvent(event) && event.factIds.some((factId) => String(factId) === String(topic.factId))) addWithCauses(event);
    }
  } else if (topic === undefined || topic.kind === "general") {
    const focusNpcId = job.focusNpcId === undefined ? undefined : String(job.focusNpcId);
    for (const event of worldState.eventLedger) {
      if (!openingEvent(event)) continue;
      if (focusNpcId === undefined
        || event.actorIds.some((id) => String(id) === focusNpcId)
        || event.targetIds.some((id) => String(id) === focusNpcId)) addWithCauses(event);
    }
  }

  const requiredEventIds = worldState.eventLedger
    .filter((event) => selected.has(String(event.eventId)))
    .map((event) => event.eventId);
  if (requiredEventIds.length === 0) return null;

  const rendered = renderNarrativeMemory({
    retrieved: retrieveNarrativeMemory({
      memory: rebuildEpisodicMemory(worldState.eventLedger),
      ledger: worldState.eventLedger,
      requiredEventIds,
      maxEpisodes: 0,
      maxRecentScenes: 0,
    }),
    entityStore: worldState.entityStore,
  });
  const selectedIntent = job.utterance !== undefined
    ? `玩家本次原话：${job.utterance}`
    : job.selectedDialogue === undefined
      ? "玩家本次回应：按当前已结算行动理解。"
      : `玩家本次回应意图：dialogueAct=${job.selectedDialogue.dialogueAct}；topic=${topic?.kind ?? "general"}${job.selectedDialogue.label === undefined ? "" : `；选项原文=${job.selectedDialogue.label}`}。`;

  return {
    requiredEventIds,
    publicText: [
      "以下材料在开局时已经成立；只用于承接背景与理解本次回应。",
      rendered.requiredEventsText,
      selectedIntent,
      "本次选择只表达玩家意图；直接后果必须服从“当前已结算结果”的 mandatory beats，不得把意图写成已经成功。",
    ].filter((line) => line !== "").join("\n"),
  };
}
