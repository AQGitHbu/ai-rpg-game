import type { TalkAction } from "@/game/domain/action";
import { semanticSummaryOf } from "@/game/domain/approvedChoice";
import type { OpeningGenerationCandidate } from "@/game/domain/openingGenerationCandidate";
import { parseOpeningSituation } from "@/game/domain/openingSituation";
import { asFactId } from "@/game/domain/worldEntity";
import { OPENING_NPC_ID } from "./compileOpeningGenerationCandidate";

export type ResolvedOpeningResponse = Readonly<{ candidateId: string; action: TalkAction }>;

export function resolveOpeningResponses(
  candidate: OpeningGenerationCandidate,
): readonly [ResolvedOpeningResponse, ResolvedOpeningResponse] | null {
  const situation = parseOpeningSituation(candidate.opening.situation);
  if (situation === null) return null;

  const factIdByKey = new Map(candidate.world.publicFacts.map((fact, index) => [fact.key, asFactId(`fact_${index}`)]));
  if (factIdByKey.size !== candidate.world.publicFacts.length) return null;
  const historyKeys = new Set<string>();
  for (const history of situation.history) {
    if (history.factKeys.some((key) => !factIdByKey.has(key))) return null;
    if (history.causeHistoryKeys.some((key) => !historyKeys.has(key))) return null;
    historyKeys.add(history.key);
  }
  const known = new Set(candidate.opening.npc.knownFactKeys);
  const privateFacts = new Set(candidate.opening.npc.privateFactKeys);
  if ([...known].some((key) => privateFacts.has(key))) return null;
  if ([...known, ...privateFacts].some((key) => !factIdByKey.has(key))) return null;
  if (situation.history.some((history) => history.factKeys.some((key) => !known.has(key)))) return null;

  const threadByKey = new Map<string, string>();
  for (const thread of situation.threads) {
    if (!known.has(thread.questionFactKey)) return null;
    if (thread.supportingFactKeys.some((key) => !factIdByKey.has(key))) return null;
    if (thread.causeHistoryKeys.some((key) => !historyKeys.has(key))) return null;
    threadByKey.set(thread.key, `thread_init_${thread.key}`);
  }

  const connection = situation.npcConnection;
  if (connection.basisHistoryKeys.some((key) => !historyKeys.has(key))) return null;
  if (connection.familiarity === "stranger") {
    if (connection.stance !== "neutral" || connection.basisHistoryKeys.length !== 0) return null;
  } else if (connection.basisHistoryKeys.length === 0) return null;

  const resolved = situation.responses.map((response): ResolvedOpeningResponse | null => {
    let topic: TalkAction["topic"];
    if (response.topic.kind === "fact") {
      if (!known.has(response.topic.key)) return null;
      const factId = factIdByKey.get(response.topic.key);
      if (factId === undefined) return null;
      topic = { kind: "fact", factId };
    } else {
      const threadId = threadByKey.get(response.topic.key);
      if (threadId === undefined) return null;
      topic = { kind: "thread", threadId };
    }
    return {
      candidateId: response.key,
      action: { type: "talk", npcId: OPENING_NPC_ID, dialogueAct: response.dialogueAct, topic, utterance: "" },
    };
  });
  if (resolved.some((response) => response === null)) return null;
  const pair = resolved as [ResolvedOpeningResponse, ResolvedOpeningResponse];
  if (semanticSummaryOf(pair[0].action) === semanticSummaryOf(pair[1].action)) return null;
  return pair;
}
