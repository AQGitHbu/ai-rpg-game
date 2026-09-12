import { DIALOGUE_ACTS } from "./action";
import { RELATIONSHIP_SIGNALS } from "./entity/npcComponents";
import type { NarrativeEventPayload } from "./events";

type Check = (value: unknown) => boolean;
const text: Check = (value) => typeof value === "string";
const id: Check = (value) => typeof value === "string" && value.trim().length > 0;
const integer: Check = (value) => typeof value === "number" && Number.isInteger(value) && value >= 0;
const finite: Check = (value) => typeof value === "number" && Number.isFinite(value);
const oneOf = (values: readonly string[]): Check => (value) => typeof value === "string" && values.includes(value);
const arrayOf = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
const ids = arrayOf(id);

function shape(required: Readonly<Record<string, Check>>, optional: Readonly<Record<string, Check>> = {}): Check {
  return (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return Object.entries(required).every(([key, check]) => Object.hasOwn(object, key) && check(object[key]))
      && Object.keys(object).every((key) => Object.hasOwn(required, key)
        || (Object.hasOwn(optional, key) && (object[key] === undefined || optional[key]!(object[key]))));
  };
}

const generation = shape({
  generationId: id, seed: text, templateVersion: text, inputDigest: text,
  gameType: oneOf(["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"]),
}, {
  openingAttempt: integer,
  setup: shape({
    characterName: text, characterIdentity: text, personalityTags: arrayOf(text), worldPremise: text,
    storyOpening: text, narrativeStyle: oneOf(["concise", "novel", "cinematic"]),
    contentIntensity: oneOf(["normal", "dark"]),
  }, { characterProfile: text }),
});
const combatResult = shape({
  round: integer, sequence: integer, actorId: id,
  kind: oneOf(["attack", "skill", "guard", "flee"]), damage: integer, actorEnergyAfter: integer,
}, { targetId: id, targetHpAfter: integer });

/** Closed payload schemas shared by draft commit and persisted ledger parsing. */
const PAYLOAD_CHECKS = {
  game_initialized: shape({ type: text, generation }),
  opening_history_established: shape({ type: text, factIds: ids }),
  opening_thread_established: shape({ type: text, threadId: id, questionFactId: id, supportingFactIds: ids }),
  location_observed: shape({ type: text, locationId: id }),
  location_visited: shape({ type: text, locationId: id }),
  location_explored: shape({ type: text, locationId: id }),
  location_unlocked: shape({ type: text, locationId: id }),
  npc_met: shape({ type: text, npcId: id }, { interactionKind: oneOf(["greet", "ask_main_quest"]) }),
  npc_dialogue_completed: shape({ type: text, npcId: id }),
  fact_discovered: shape({ type: text, factId: id }, {
    witnessNpcIds: ids, approachId: id, evidenceQuality: oneOf(["clean", "noisy"]), tensionDelta: finite,
  }),
  quest_completed: shape({ type: text, questId: id }),
  quest_unlocked: shape({ type: text, questId: id }),
  quest_failed: shape({ type: text, questId: id }),
  item_obtained: shape({ type: text, itemId: id, locationId: id }),
  item_given: shape({ type: text, itemId: id, npcId: id, locationId: id }),
  battle_started: shape({ type: text, enemyId: id }, { enemyIds: ids }),
  battle_round_resolved: shape({
    type: text, enemyId: id, round: integer, playerHp: integer, enemyHp: integer,
    action: oneOf(["attack", "skill", "guard", "flee", "withdraw"]),
  }, { results: arrayOf(combatResult) }),
  battle_resolved: shape({ type: text, enemyId: id, outcome: oneOf(["victory", "defeat", "withdraw"]) }, { enemyIds: ids }),
  enemy_defeated: shape({ type: text, enemyId: id }),
  ending_reached: shape({ type: text, endingId: id, outcome: oneOf(["success", "failure"]) }),
  blueprint_expanded: shape({ type: text, newLocationIds: ids, newNpcIds: ids }, {
    newFactIds: ids, newItemIds: ids, newEnemyIds: ids, newQuestIds: ids, newEndingIds: ids,
  }),
  narrative_scene_presented: shape({
    type: text, sceneId: id, focusNpcId: (value) => value === null || id(value),
    pacing: oneOf(["setup", "develop", "turn", "climax", "resolution"]), beatIds: ids, revealedFactIds: ids,
  }),
  player_intent_expressed: shape({ type: text, intentCode: oneOf(["unmapped_freeform", "thread_complicates", "thread_resolves"]) }),
  candidate_event_approved: shape({ type: text, candidateId: id, kind: id, approvedAtTurn: integer }),
  candidate_event_rejected: shape({ type: text, candidateId: id, kind: id, reasonCode: id, rejectedAtTurn: integer }),
  candidate_event_expired: shape({ type: text, candidateId: id, kind: id, expiredAtTurn: integer }),
  candidate_event_activated: shape({ type: text, candidateId: id, kind: id, activatedAtTurn: integer }),
  npc_interaction_recorded: shape({ type: text, npcId: id, dialogueAct: (value) => oneOf([...DIALOGUE_ACTS, "freeform"])(value) }),
  npc_knowledge_changed: shape({ type: text, npcId: id, factId: id, change: oneOf(["learned", "certainty_upgraded", "disclosure_changed"]) }),
  npc_relationship_changed: shape({ type: text, fromNpcId: id, targetId: id, signal: (value) => oneOf(RELATIONSHIP_SIGNALS)(value) }),
  story_interaction_resolved: shape({
    type: text, interactionId: id, npcId: id,
    operation: oneOf(["promise_confidentiality", "request_introduction", "request_verification", "share_known_fact"]),
    factIds: ids, audienceIds: ids, evidenceEventIds: ids,
  }),
} satisfies Record<NarrativeEventPayload["type"], Check>;

export function isNarrativeEventPayload(value: unknown): value is NarrativeEventPayload {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return false;
  return Object.hasOwn(PAYLOAD_CHECKS, value.type)
    && PAYLOAD_CHECKS[value.type as NarrativeEventPayload["type"]](value);
}
