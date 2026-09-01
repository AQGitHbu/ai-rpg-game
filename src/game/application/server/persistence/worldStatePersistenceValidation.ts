import { parseEntityStore, projectEntityStore, validateEntityCompatibilityProjection, validateEntityReferences } from "@/game/domain/entity";
import type { EntityCompatibilityProjection } from "@/game/domain/entity";
import type { GameEvent } from "@/game/domain/events";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import type { BattleState, EndingState, WorldState } from "@/game/domain/worldState";
import type { EndingEntry } from "@/game/domain/worldEntries";
import { validateWorldStateEntityReferences } from "@/game/domain/worldStateValidation";

export type PersistableWorldStateValidationResult =
  | { readonly ok: true; readonly value: WorldState }
  | { readonly ok: false; readonly code: "wrong_world_version" | "invalid_world_envelope" | "invalid_entity_store" | "invalid_entity_reference" | "projection_mismatch"; readonly issueCode?: string; readonly entityId?: string };

type JsonObject = Record<string, unknown>;
const PROJECTION_KEYS = ["player", "locations", "currentLocationId", "unlockedLocationIds", "visitedLocationIds", "npcs", "items", "inventory", "worldFacts", "quests", "enemies", "defeatedEnemyIds", "factions"] as const;
const WORLD_KEYS = ["version", "generation", "entityStore", ...PROJECTION_KEYS, "battle", "endings", "ending", "eventLedger"] as const;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function hasRequiredAndOptionalKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function optionalMatches(value: JsonObject, key: string, predicate: (entry: unknown) => boolean): boolean {
  return !(key in value) || value[key] === undefined || predicate(value[key]);
}

function isGeneration(value: unknown): value is GenerationMetadata {
  if (!isObject(value) || !hasRequiredAndOptionalKeys(
    value,
    ["generationId", "seed", "templateVersion", "inputDigest", "gameType"],
    ["setup", "openingAttempt"],
  )) return false;
  const gameTypes = ["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"];
  if (typeof value.generationId !== "string" || typeof value.seed !== "string"
    || typeof value.templateVersion !== "string" || typeof value.inputDigest !== "string"
    || typeof value.gameType !== "string" || !gameTypes.includes(value.gameType)) return false;
  if (!optionalMatches(value, "openingAttempt", (entry) => Number.isInteger(entry) && (entry as number) >= 0)) return false;
  if (!("setup" in value) || value.setup === undefined) return true;
  const setup = value.setup;
  if (!isObject(setup) || !hasRequiredAndOptionalKeys(
    setup,
    ["characterName", "characterIdentity", "personalityTags", "worldPremise", "storyOpening", "narrativeStyle", "contentIntensity"],
    ["characterProfile"],
  )) return false;
  return typeof setup.characterName === "string"
    && typeof setup.characterIdentity === "string"
    && optionalMatches(setup, "characterProfile", (entry) => typeof entry === "string")
    && isStringArray(setup.personalityTags)
    && typeof setup.worldPremise === "string"
    && typeof setup.storyOpening === "string"
    && (setup.narrativeStyle === "concise" || setup.narrativeStyle === "novel" || setup.narrativeStyle === "cinematic")
    && (setup.contentIntensity === "normal" || setup.contentIntensity === "dark");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBattleSnapshot(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(value, ["entityStore", "eventLedger"]) || !Array.isArray(value.eventLedger)) return false;
  return parseEntityStore(value.entityStore).ok && value.eventLedger.every(isGameEvent);
}

function isCombatSource(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "protagonist") return hasExactKeys(value, ["kind"]);
  if (value.kind === "companion") return hasExactKeys(value, ["kind", "npcId"]) && typeof value.npcId === "string";
  if (value.kind === "enemy") return hasExactKeys(value, ["kind", "enemyId"]) && typeof value.enemyId === "string";
  return false;
}

function isCombatStats(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, ["maxHp", "maxEnergy", "attack", "defense", "speed"])
    && [value.maxHp, value.maxEnergy, value.attack, value.defense, value.speed].every(isFiniteNumber);
}

function isCombatant(value: unknown): boolean {
  return isObject(value)
    && hasExactKeys(value, ["combatantId", "side", "controller", "source", "name", "stats", "hp", "energy", "guarding"])
    && typeof value.combatantId === "string"
    && (value.side === "allies" || value.side === "enemies")
    && (value.controller === "player" || value.controller === "rule")
    && isCombatSource(value.source)
    && typeof value.name === "string"
    && isCombatStats(value.stats)
    && isFiniteNumber(value.hp) && isFiniteNumber(value.energy) && typeof value.guarding === "boolean";
}

function isCombatAction(value: unknown): boolean {
  return value === "attack" || value === "skill" || value === "guard" || value === "flee";
}

function isCombatResult(value: unknown): boolean {
  return isObject(value)
    && hasRequiredAndOptionalKeys(value, ["round", "sequence", "actorId", "kind", "damage", "actorEnergyAfter"], ["targetId", "targetHpAfter"])
    && Number.isInteger(value.round) && (value.round as number) >= 0
    && Number.isInteger(value.sequence) && (value.sequence as number) >= 0
    && typeof value.actorId === "string" && optionalMatches(value, "targetId", (entry) => typeof entry === "string")
    && isCombatAction(value.kind) && isFiniteNumber(value.damage) && isFiniteNumber(value.actorEnergyAfter)
    && optionalMatches(value, "targetHpAfter", isFiniteNumber);
}

function isEnemyIntent(value: unknown): boolean {
  return isObject(value)
    && hasRequiredAndOptionalKeys(value, ["actorId", "kind"], ["targetId"])
    && typeof value.actorId === "string"
    && (value.kind === "attack" || value.kind === "skill" || value.kind === "guard")
    && optionalMatches(value, "targetId", (entry) => typeof entry === "string");
}

function isBattle(value: unknown): value is BattleState {
  if (!isObject(value)) return false;
  if (value.status === "idle") return hasExactKeys(value, ["status"]);
  if (value.status === "resolved") {
    return hasRequiredAndOptionalKeys(value, ["status", "enemyId", "outcome"], ["battleKey"])
      && typeof value.enemyId === "string"
      && (value.outcome === "victory" || value.outcome === "defeat" || value.outcome === "withdraw")
      && optionalMatches(value, "battleKey", (entry) => typeof entry === "string");
  }
  if (value.status !== "active") return false;
  if (!hasRequiredAndOptionalKeys(
    value,
    ["status", "enemyId", "playerHp", "enemyHp", "round", "preBattleSnapshot"],
    ["enemyIds", "battleKey", "combatants", "turnOrder", "turnIndex", "enemyIntents", "downedEnemyIds", "lastAdvance"],
  )) return false;
  return typeof value.enemyId === "string"
    && typeof value.enemyId === "string"
    && isFiniteNumber(value.playerHp)
    && isFiniteNumber(value.enemyHp)
    && typeof value.round === "number" && Number.isInteger(value.round) && value.round >= 0
    && isBattleSnapshot(value.preBattleSnapshot)
    && optionalMatches(value, "enemyIds", isStringArray)
    && optionalMatches(value, "battleKey", (entry) => typeof entry === "string")
    && optionalMatches(value, "combatants", (entry) => Array.isArray(entry) && entry.every(isCombatant))
    && optionalMatches(value, "turnOrder", isStringArray)
    && optionalMatches(value, "turnIndex", (entry) => Number.isInteger(entry) && (entry as number) >= 0)
    && optionalMatches(value, "enemyIntents", (entry) => Array.isArray(entry) && entry.every(isEnemyIntent))
    && optionalMatches(value, "downedEnemyIds", isStringArray)
    && optionalMatches(value, "lastAdvance", (entry) => Array.isArray(entry) && entry.every(isCombatResult));
}

function isEndingState(value: unknown): value is EndingState {
  return value === null || (isObject(value) && typeof value.endingId === "string" && (value.outcome === "success" || value.outcome === "failure") && hasExactKeys(value, ["endingId", "outcome"]));
}

function isEndingEntry(value: unknown): value is EndingEntry {
  return isObject(value) && hasExactKeys(value, ["id", "name", "description", "requirements"])
    && typeof value.id === "string" && typeof value.name === "string" && typeof value.description === "string"
    && Array.isArray(value.requirements) && value.requirements.every(isEndingRequirement);
}

function isEndingRequirement(value: unknown): boolean {
  if (!isObject(value) || typeof value.kind !== "string") return false;
  if (value.kind === "quest_completed" || value.kind === "quest_failed") {
    return hasExactKeys(value, ["kind", "questId"]) && typeof value.questId === "string";
  }
  if (value.kind === "fact_discovered") {
    return hasExactKeys(value, ["kind", "factId"]) && typeof value.factId === "string";
  }
  if (value.kind === "npc_affinity_at_least" || value.kind === "npc_affinity_at_most") {
    return hasExactKeys(value, ["kind", "npcId", "value"])
      && typeof value.npcId === "string" && isFiniteNumber(value.value);
  }
  return false;
}

function eventWithOccurredAt(value: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean {
  return hasRequiredAndOptionalKeys(value, ["type", ...required, "occurredAt"], optional)
    && typeof value.occurredAt === "string";
}

function isGameEvent(value: unknown): value is GameEvent {
  if (!isObject(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "game_initialized":
      return hasExactKeys(value, ["type", "generation"]) && isGeneration(value.generation);
    case "location_observed":
    case "location_visited":
    case "location_explored":
    case "location_unlocked":
      return eventWithOccurredAt(value, ["locationId"]) && typeof value.locationId === "string";
    case "npc_met":
      return eventWithOccurredAt(value, ["npcId"], ["interactionKind"])
        && typeof value.npcId === "string"
        && optionalMatches(value, "interactionKind", (entry) => entry === "greet" || entry === "ask_main_quest");
    case "npc_dialogue_completed":
      return eventWithOccurredAt(value, ["npcId"]) && typeof value.npcId === "string";
    case "fact_discovered":
      return eventWithOccurredAt(value, ["factId"], ["witnessNpcIds", "approachId", "evidenceQuality", "tensionDelta"])
        && typeof value.factId === "string"
        && optionalMatches(value, "witnessNpcIds", isStringArray)
        && optionalMatches(value, "approachId", (entry) => typeof entry === "string")
        && optionalMatches(value, "evidenceQuality", (entry) => entry === "clean" || entry === "noisy")
        && optionalMatches(value, "tensionDelta", isFiniteNumber);
    case "quest_completed":
    case "quest_unlocked":
    case "quest_failed":
      return eventWithOccurredAt(value, ["questId"]) && typeof value.questId === "string";
    case "item_obtained":
      return eventWithOccurredAt(value, ["itemId", "locationId"])
        && typeof value.itemId === "string" && typeof value.locationId === "string";
    case "item_given":
      return eventWithOccurredAt(value, ["itemId", "npcId", "locationId"])
        && typeof value.itemId === "string" && typeof value.npcId === "string" && typeof value.locationId === "string";
    case "battle_started":
      return eventWithOccurredAt(value, ["enemyId"], ["enemyIds"])
        && typeof value.enemyId === "string" && optionalMatches(value, "enemyIds", isStringArray);
    case "battle_round_resolved":
      return eventWithOccurredAt(value, ["enemyId", "round", "playerHp", "enemyHp", "action"], ["results"])
        && typeof value.enemyId === "string" && Number.isInteger(value.round) && (value.round as number) >= 0
        && isFiniteNumber(value.playerHp) && isFiniteNumber(value.enemyHp)
        && (isCombatAction(value.action) || value.action === "withdraw")
        && optionalMatches(value, "results", (entry) => Array.isArray(entry) && entry.every(isCombatResult));
    case "battle_resolved":
      return eventWithOccurredAt(value, ["enemyId", "outcome"], ["enemyIds"])
        && typeof value.enemyId === "string" && (value.outcome === "victory" || value.outcome === "defeat" || value.outcome === "withdraw")
        && optionalMatches(value, "enemyIds", isStringArray);
    case "enemy_defeated":
      return eventWithOccurredAt(value, ["enemyId"]) && typeof value.enemyId === "string";
    case "ending_reached":
      return eventWithOccurredAt(value, ["endingId", "outcome"])
        && typeof value.endingId === "string" && (value.outcome === "success" || value.outcome === "failure");
    case "narrative_choice":
      return eventWithOccurredAt(value, ["choiceToken", "actionKey", "sceneId"])
        && typeof value.choiceToken === "string" && typeof value.actionKey === "string" && typeof value.sceneId === "string";
    case "narrative_dialogue_choice":
      return eventWithOccurredAt(value, ["choiceToken", "dialogueIntent", "npcId", "sceneId"])
        && typeof value.choiceToken === "string" && typeof value.dialogueIntent === "string"
        && typeof value.npcId === "string" && typeof value.sceneId === "string";
    case "narrative_scene_presented":
      return eventWithOccurredAt(value, ["sceneId", "locationId", "focusNpcId", "revealedFactIds", "pacing"])
        && typeof value.sceneId === "string" && typeof value.locationId === "string"
        && (value.focusNpcId === null || typeof value.focusNpcId === "string") && isStringArray(value.revealedFactIds)
        && ["setup", "develop", "turn", "climax", "resolution"].includes(String(value.pacing));
    case "blueprint_expanded":
      return eventWithOccurredAt(value, ["newLocationIds", "newNpcIds"], ["newFactIds", "newItemIds", "newEnemyIds", "newQuestIds", "newEndingIds"])
        && isStringArray(value.newLocationIds) && isStringArray(value.newNpcIds)
        && ["newFactIds", "newItemIds", "newEnemyIds", "newQuestIds", "newEndingIds"].every((key) => optionalMatches(value, key, isStringArray));
    case "player_intent_expressed":
      return eventWithOccurredAt(value, ["intent"]) && typeof value.intent === "string";
    case "candidate_event_proposed":
      return eventWithOccurredAt(value, ["candidateId", "kind", "proposedAtTurn", "expiresAtTurn"])
        && typeof value.candidateId === "string" && typeof value.kind === "string"
        && Number.isInteger(value.proposedAtTurn) && (value.proposedAtTurn as number) >= 0
        && Number.isInteger(value.expiresAtTurn) && (value.expiresAtTurn as number) >= 0;
    case "candidate_event_approved":
      return eventWithOccurredAt(value, ["candidateId", "kind", "approvedAtTurn"])
        && typeof value.candidateId === "string" && typeof value.kind === "string"
        && Number.isInteger(value.approvedAtTurn) && (value.approvedAtTurn as number) >= 0;
    case "candidate_event_rejected":
      return eventWithOccurredAt(value, ["candidateId", "kind", "reasonCode", "rejectedAtTurn"])
        && typeof value.candidateId === "string" && typeof value.kind === "string" && typeof value.reasonCode === "string"
        && Number.isInteger(value.rejectedAtTurn) && (value.rejectedAtTurn as number) >= 0;
    case "candidate_event_expired":
      return eventWithOccurredAt(value, ["candidateId", "kind", "expiredAtTurn"])
        && typeof value.candidateId === "string" && typeof value.kind === "string"
        && Number.isInteger(value.expiredAtTurn) && (value.expiredAtTurn as number) >= 0;
    case "candidate_event_activated":
      return eventWithOccurredAt(value, ["candidateId", "kind", "activatedAtTurn"])
        && typeof value.candidateId === "string" && typeof value.kind === "string"
        && Number.isInteger(value.activatedAtTurn) && (value.activatedAtTurn as number) >= 0;
    default:
      return false;
  }
}

/** SQLite 边界唯一接受的 WorldState v3 解析器；兼容投影始终由 store 重建。 */
export function validatePersistableWorldState(value: unknown): PersistableWorldStateValidationResult {
  if (!isObject(value)) return { ok: false, code: "invalid_world_envelope" };
  if (value.version !== 3) return { ok: false, code: "wrong_world_version" };
  if (!hasExactKeys(value, WORLD_KEYS) || !isGeneration(value.generation) || !isBattle(value.battle) || !Array.isArray(value.endings) || !value.endings.every(isEndingEntry) || !isEndingState(value.ending) || !Array.isArray(value.eventLedger) || !value.eventLedger.every(isGameEvent)) {
    return { ok: false, code: "invalid_world_envelope" };
  }
  const parsedStore = parseEntityStore(value.entityStore);
  if (!parsedStore.ok) {
    const issue = parsedStore.issues[0];
    return { ok: false, code: "invalid_entity_store", issueCode: issue?.code, entityId: issue?.entityId };
  }
  const referenceIssue = validateEntityReferences(parsedStore.store)[0];
  if (referenceIssue !== undefined) return { ok: false, code: "invalid_entity_reference", issueCode: referenceIssue.code, entityId: referenceIssue.entityId };
  const projection = Object.fromEntries(PROJECTION_KEYS.map((key) => [key, value[key]])) as EntityCompatibilityProjection;
  const projectionIssue = validateEntityCompatibilityProjection(parsedStore.store, projection)[0];
  if (projectionIssue !== undefined) return { ok: false, code: "projection_mismatch", issueCode: projectionIssue.code };
  const normalized: WorldState = {
    version: 3,
    generation: value.generation,
    entityStore: parsedStore.store,
    ...projectEntityStore(parsedStore.store),
    battle: value.battle,
    endings: value.endings,
    ending: value.ending,
    eventLedger: value.eventLedger,
  };
  const worldReferenceIssue = validateWorldStateEntityReferences(normalized)[0];
  if (worldReferenceIssue !== undefined) return { ok: false, code: "invalid_entity_reference", issueCode: worldReferenceIssue.code, entityId: worldReferenceIssue.entityId };
  return { ok: true, value: normalized };
}
