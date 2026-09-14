import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import type { EntityId } from "@/game/domain/entity/entityCore";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { NarrativeMemoryPolicy } from "@/game/domain/narrativeMemoryContext";
import type { GameRecord } from "./server/persistence/gameRepository";
import type { NarrativeMemorySummaryRepository, PreparedNarrativeMemory } from "./narrativeMemorySummaryRepository";
import type { NarrativeMemorySummarySource } from "./narrativeMemorySummarySource";
import { prepareNarrativeMemory } from "./prepareNarrativeMemory";
import { selectNpcDeliberationTarget } from "./prepareNpcNarrativeContext";
import { preparedNarrativeMemorySourceFingerprint, narrativeMemorySourceFingerprint } from "./narrativeMemorySourceFingerprint";

export type NarrativeMemoryPreparationInput = Readonly<{
  record: GameRecord;
  job: PendingNarrativeJob;
  signal: AbortSignal;
  reserveBatchUpdate: () => Promise<boolean>;
  reserveSummaryHttpAttempt: () => Promise<boolean>;
}>;

/** Uses the same target selector as NPC judgement; private memory stays local. */
export function createNarrativeMemoryPackagePreparer(deps: Readonly<{
  repository: NarrativeMemorySummaryRepository;
  source: NarrativeMemorySummarySource;
  policy: NarrativeMemoryPolicy;
  summaries: "enabled" | "disabled";
}>) {
  return async (input: NarrativeMemoryPreparationInput): Promise<PreparedNarrativeMemory> => {
    const { record, job, signal } = input;
    const npcId = selectNpcDeliberationTarget({ kind: "decision", worldState: record.worldState, storyState: record.storyState, job });
    const prepare = async (observerId: EntityId) => {
      if (signal.aborted) throw new Error("CANCELLED");
      const source: NarrativeMemorySummarySource = { select: (request) => deps.source.select({ ...request,
        maxEstimatedTokens: deps.policy.promptMaxEstimatedTokens,
        auditLink: { gameId: String(record.gameId), jobId: String(job.jobId), turnNumber: job.turnNumber,
          memory: { observerId: String(observerId),
            sourceFingerprint: narrativeMemorySourceFingerprint({ worldState: record.worldState, storyState: record.storyState, observerId }),
            historyIds: request.history.map(entry => entry.id), eventIds: request.events.map(event => String(event.eventId)),
          },
        },
      }) };
      const result = await prepareNarrativeMemory({ ...input, ...deps, observerId, source });
      if (signal.aborted) throw new Error("CANCELLED");
      if (!result.ok) throw new Error(result.code);
      return result.context;
    };
    const player = await prepare(PLAYER_ENTITY_ID);
    const npc = npcId === undefined ? undefined : await prepare(npcId);
    return {
      formatVersion: 1, policyVersion: "memory-p2/1", policy: deps.policy, summaries: deps.summaries,
      sourceFingerprint: preparedNarrativeMemorySourceFingerprint({
        worldState: record.worldState, storyState: record.storyState,
        playerObserverId: PLAYER_ENTITY_ID, ...(npcId === undefined ? {} : { npcObserverId: npcId }),
      }),
      player, ...(npc === undefined ? {} : { npc }),
    };
  };
}
