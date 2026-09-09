import { DIALOGUE_ACTS, type DialogueAct } from "./action";
import type { NpcRelationshipSeedStance } from "./entity";

export type OpeningParticipantRef = "player" | "opening_npc";
export type OpeningHistoryProposal = Readonly<{
  key: string;
  factKeys: readonly string[];
  participantRefs: readonly OpeningParticipantRef[];
  causeHistoryKeys: readonly string[];
}>;
export type OpeningThreadProposal = Readonly<{
  key: string;
  questionFactKey: string;
  supportingFactKeys: readonly string[];
  participantRefs: readonly OpeningParticipantRef[];
  causeHistoryKeys: readonly string[];
}>;
export type OpeningResponseProposal = Readonly<{
  key: string;
  dialogueAct: DialogueAct;
  topic: Readonly<{ kind: "fact" | "thread"; key: string }>;
}>;
export type OpeningSituationProposal = Readonly<{
  history: readonly OpeningHistoryProposal[];
  threads: readonly OpeningThreadProposal[];
  npcConnection: Readonly<{
    familiarity: "stranger" | "known";
    stance: "neutral" | NpcRelationshipSeedStance;
    basisHistoryKeys: readonly string[];
  }>;
  responses: readonly [OpeningResponseProposal, OpeningResponseProposal];
}>;

const LOCAL_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const PARTICIPANTS = new Set<OpeningParticipantRef>(["player", "opening_npc"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function keys(value: unknown, min: number, max: number): readonly string[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  if (!value.every((entry) => typeof entry === "string" && LOCAL_KEY.test(entry))) return null;
  return new Set(value).size === value.length ? value : null;
}

function participants(value: unknown): readonly OpeningParticipantRef[] | null {
  const parsed = keys(value, 1, 2);
  if (parsed === null || !parsed.every((entry) => PARTICIPANTS.has(entry as OpeningParticipantRef))) return null;
  return parsed as readonly OpeningParticipantRef[];
}

export function parseOpeningSituation(value: unknown): OpeningSituationProposal | null {
  const root = record(value);
  if (root === null || !exact(root, ["history", "threads", "npcConnection", "responses"])) return null;
  if (!Array.isArray(root.history) || root.history.length > 4) return null;
  if (!Array.isArray(root.threads) || root.threads.length < 1 || root.threads.length > 3) return null;
  if (!Array.isArray(root.responses) || root.responses.length !== 2) return null;

  const history: OpeningHistoryProposal[] = [];
  for (const raw of root.history) {
    const item = record(raw);
    if (item === null || !exact(item, ["key", "factKeys", "participantRefs", "causeHistoryKeys"])) return null;
    const factKeys = keys(item.factKeys, 1, 4);
    const participantRefs = participants(item.participantRefs);
    const causeHistoryKeys = keys(item.causeHistoryKeys, 0, 4);
    if (typeof item.key !== "string" || !LOCAL_KEY.test(item.key) || factKeys === null || participantRefs === null || causeHistoryKeys === null) return null;
    history.push({ key: item.key, factKeys, participantRefs, causeHistoryKeys });
  }

  const threads: OpeningThreadProposal[] = [];
  for (const raw of root.threads) {
    const item = record(raw);
    if (item === null || !exact(item, ["key", "questionFactKey", "supportingFactKeys", "participantRefs", "causeHistoryKeys"])) return null;
    const supportingFactKeys = keys(item.supportingFactKeys, 0, 4);
    const participantRefs = participants(item.participantRefs);
    const causeHistoryKeys = keys(item.causeHistoryKeys, 0, 4);
    if (typeof item.key !== "string" || !LOCAL_KEY.test(item.key)
      || typeof item.questionFactKey !== "string" || !LOCAL_KEY.test(item.questionFactKey)
      || supportingFactKeys === null || participantRefs === null || causeHistoryKeys === null) return null;
    threads.push({ key: item.key, questionFactKey: item.questionFactKey, supportingFactKeys, participantRefs, causeHistoryKeys });
  }

  const connection = record(root.npcConnection);
  if (connection === null || !exact(connection, ["familiarity", "stance", "basisHistoryKeys"])) return null;
  const basisHistoryKeys = keys(connection.basisHistoryKeys, 0, 4);
  const stances = new Set(["neutral", "ally", "protective_of", "indebted_to", "rival", "wary"]);
  if ((connection.familiarity !== "stranger" && connection.familiarity !== "known")
    || typeof connection.stance !== "string" || !stances.has(connection.stance)
    || basisHistoryKeys === null) return null;

  const responses: OpeningResponseProposal[] = [];
  for (const raw of root.responses) {
    const item = record(raw);
    const topic = record(item?.topic);
    if (item === null || !exact(item, ["key", "dialogueAct", "topic"])
      || topic === null || !exact(topic, ["kind", "key"])
      || typeof item.key !== "string" || !LOCAL_KEY.test(item.key)
      || typeof item.dialogueAct !== "string" || !(DIALOGUE_ACTS as readonly string[]).includes(item.dialogueAct)
      || (topic.kind !== "fact" && topic.kind !== "thread")
      || typeof topic.key !== "string" || !LOCAL_KEY.test(topic.key)) return null;
    responses.push({ key: item.key, dialogueAct: item.dialogueAct as DialogueAct, topic: { kind: topic.kind, key: topic.key } });
  }

  if (new Set(history.map((item) => item.key)).size !== history.length
    || new Set(threads.map((item) => item.key)).size !== threads.length
    || new Set(responses.map((item) => item.key)).size !== responses.length) return null;

  return {
    history,
    threads,
    npcConnection: {
      familiarity: connection.familiarity,
      stance: connection.stance as "neutral" | NpcRelationshipSeedStance,
      basisHistoryKeys,
    },
    responses: responses as [OpeningResponseProposal, OpeningResponseProposal],
  };
}
