import { entitiesOfKind, parseEntityStore, projectEntityStore, validateEntityCompatibilityProjection, validateEntityReferences, validateEntityStoreProvenance } from "@/game/domain/entity";
import type { EntityCompatibilityProjection, EntityStore } from "@/game/domain/entity";
import { parseCommittedEventLedger, type CommittedNarrativeEvent } from "@/game/domain/events";
import type { GenerationMetadata } from "@/game/domain/worldEntity";
import { classifyWorldStateSchemaVersion, WORLD_STATE_SCHEMA_VERSION, type BattleState, type EndingState, type WorldState } from "@/game/domain/worldState";
import type { EndingEntry } from "@/game/domain/worldEntries";
import { validateWorldStateEntityReferences, validateWorldStateEventLedger } from "@/game/domain/worldStateValidation";
import { parseNarrativeHistory } from "@/game/domain/narrativeHistory";
import {
  MODERN_BATTLE_KEYS,
  hasExactKeys,
  hasRequiredAndOptionalKeys,
  isCombatResult,
  isCombatant,
  isEnemyIntent,
  isFiniteNumber,
  isNonEmptyString,
  isNonEmptyStringArray,
  isPlainRecord as isObject,
  optionalMatches,
} from "../../battleShapeValidation";

export type PersistableWorldStateValidationResult =
  | { readonly ok: true; readonly value: WorldState }
  | { readonly ok: false; readonly code: "wrong_world_version" | "invalid_world_envelope" | "invalid_entity_store" | "invalid_entity_reference" | "invalid_event_ledger" | "projection_mismatch"; readonly issueCode?: string; readonly entityId?: string };

type JsonObject = Record<string, unknown>;
const PROJECTION_KEYS = ["player", "locations", "currentLocationId", "unlockedLocationIds", "visitedLocationIds", "npcs", "items", "inventory", "worldFacts", "quests", "enemies", "defeatedEnemyIds", "factions"] as const;
const WORLD_KEYS = ["version", "generation", "entityStore", ...PROJECTION_KEYS, "battle", "endings", "ending", "eventLedger"] as const;

/** 持久化专用宽松数组判定：允许空字符串元素（战斗形状守卫用的是共享的非空版本）。 */
function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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

function isBattleSnapshot(value: unknown): boolean {
  if (!isObject(value) || !hasRequiredAndOptionalKeys(value, ["entityStore", "eventLedger"], ["history"]) || !Array.isArray(value.eventLedger)) return false;
  const store = parseEntityStore(value.entityStore);
  const ledger = parseCommittedEventLedger(value.eventLedger);
  if (!store.ok || !ledger.ok) return false;
  if (value.history !== undefined && !parseNarrativeHistory(value.history).ok) return false;
  return validateWorldStateEventLedger(ledger.value, store.store).length === 0
    && validateEntityStoreProvenance(store.store, ledger.value).length === 0;
}

function findUnknownBattleCompanionReference(
  battle: BattleState,
  entityStore: EntityStore,
): { readonly issueCode: "unknown_battle_combatant_companion_ref"; readonly entityId: string } | undefined {
  if (battle.status !== "active") return undefined;
  const npcIds = new Set(entitiesOfKind(entityStore, "npc").map((record) => String(record.core.id)));
  for (const combatant of battle.combatants ?? []) {
    if (combatant.source.kind === "companion" && !npcIds.has(String(combatant.source.npcId))) {
      return { issueCode: "unknown_battle_combatant_companion_ref", entityId: String(combatant.combatantId) };
    }
  }
  return undefined;
}

function isCompleteModernBattle(value: JsonObject): boolean {
  if (!MODERN_BATTLE_KEYS.every((key) => key in value && value[key] !== undefined)) return false;
  if (!Array.isArray(value.combatants) || value.combatants.length === 0 || !value.combatants.every(isCombatant)) return false;
  const combatants = value.combatants as readonly JsonObject[];
  const combatantIds = combatants.map((combatant) => String(combatant.combatantId));
  if (new Set(combatantIds).size !== combatantIds.length) return false;
  const combatantById = new Map(combatants.map((combatant) => [String(combatant.combatantId), combatant]));
  const enemyIds = new Set<string>();
  const enemySourceIds: string[] = [];
  let protagonistCount = 0;
  for (const combatant of combatants) {
    const source = combatant.source as JsonObject;
    if (source.kind === "protagonist") protagonistCount += 1;
    if (source.kind === "enemy") {
      enemySourceIds.push(String(source.enemyId));
      enemyIds.add(String(source.enemyId));
    }
  }
  if (protagonistCount !== 1 || !enemyIds.has(String(value.enemyId)) || new Set(enemySourceIds).size !== enemySourceIds.length) return false;
  if (value.enemyIds !== undefined
    && (!isNonEmptyStringArray(value.enemyIds)
      || new Set(value.enemyIds).size !== value.enemyIds.length
      || value.enemyIds.length !== enemyIds.size
      || !value.enemyIds.every((enemyId) => enemyIds.has(enemyId)))) return false;

  if (!isNonEmptyStringArray(value.turnOrder)
    || new Set(value.turnOrder).size !== value.turnOrder.length
    || !value.turnOrder.every((id) => combatantById.get(id)?.hp !== undefined && (combatantById.get(id)?.hp as number) > 0)
    || value.turnOrder.length !== combatants.filter((combatant) => (combatant.hp as number) > 0).length
    || !Number.isInteger(value.turnIndex)
    || (value.turnIndex as number) < 0
    || (value.turnIndex as number) >= value.turnOrder.length) return false;

  if (!Array.isArray(value.enemyIntents) || !value.enemyIntents.every(isEnemyIntent)) return false;
  const intentActors = new Set<string>();
  if (!value.enemyIntents.every((intent) => {
    const actorId = String(intent.actorId);
    const targetId = intent.targetId;
    const actor = combatantById.get(actorId);
    const target = targetId === undefined ? undefined : combatantById.get(String(targetId));
    if (intentActors.has(actorId)) return false;
    intentActors.add(actorId);
    return actor?.side === "enemies"
      && actor.hp !== undefined && (actor.hp as number) > 0
      && (targetId === undefined || (target !== undefined && target.side === "allies" && (target.hp as number) > 0));
  })) return false;

  if (!isStringArray(value.downedEnemyIds) || new Set(value.downedEnemyIds).size !== value.downedEnemyIds.length) return false;
  const downedEnemySourceIds = combatants
    .filter((combatant) => (combatant.source as JsonObject).kind === "enemy" && (combatant.hp as number) <= 0)
    .map((combatant) => String((combatant.source as JsonObject).enemyId));
  const downedEnemySet = new Set(downedEnemySourceIds);
  if (downedEnemySet.size !== downedEnemySourceIds.length
    || value.downedEnemyIds.length !== downedEnemySet.size
    || !value.downedEnemyIds.every((enemyId) => downedEnemySet.has(enemyId))) return false;

  return Array.isArray(value.lastAdvance)
    && value.lastAdvance.every(isCombatResult)
    && new Set(value.lastAdvance.map((result) => String(result.sequence))).size === value.lastAdvance.length
    && value.lastAdvance.every((result) => {
      const actorId = String(result.actorId);
      const targetId = result.targetId;
      const actor = combatantById.get(actorId);
      const target = targetId === undefined ? undefined : combatantById.get(String(targetId));
      const actorMaxEnergy = actor !== undefined && isObject(actor.stats) && isFiniteNumber(actor.stats.maxEnergy)
        ? actor.stats.maxEnergy
        : undefined;
      const targetMaxHp = target !== undefined && isObject(target.stats) && isFiniteNumber(target.stats.maxHp)
        ? target.stats.maxHp
        : undefined;
      return actor !== undefined
        && actorMaxEnergy !== undefined
        && result.actorEnergyAfter <= actorMaxEnergy
        && (targetId === undefined || target !== undefined)
        && (result.targetHpAfter === undefined
          || (targetMaxHp !== undefined && result.targetHpAfter <= targetMaxHp));
    });
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
  const baseValid = isNonEmptyString(value.enemyId)
    && isFiniteNumber(value.playerHp)
    && value.playerHp >= 0
    && isFiniteNumber(value.enemyHp)
    && value.enemyHp >= 0
    && typeof value.round === "number" && Number.isInteger(value.round) && value.round >= 0
    && isBattleSnapshot(value.preBattleSnapshot)
    && optionalMatches(value, "enemyIds", isStringArray)
    && optionalMatches(value, "battleKey", (entry) => typeof entry === "string");
  if (!baseValid) return false;
  if (!MODERN_BATTLE_KEYS.some((key) => key in value)) return true;
  return isCompleteModernBattle(value);
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

function eventWithOccurredAt(_value: JsonObject, _required: readonly string[], _optional: readonly string[] = []): boolean {
  return false; // committed events use parseCommittedEventLedger, not occurredAt
}

function isGameEvent(value: unknown): value is CommittedNarrativeEvent {
  return parseCommittedEventLedger([value]).ok;
}

/** SQLite 边界唯一接受的 WorldState 解析器（版本与 WORLD_STATE_SCHEMA_VERSION 同源）；兼容投影始终由 store 重建。 */
export function validatePersistableWorldState(value: unknown): PersistableWorldStateValidationResult {
  if (!isObject(value)) return { ok: false, code: "invalid_world_envelope" };
  if (!classifyWorldStateSchemaVersion(value.version).ok) return { ok: false, code: "wrong_world_version" };
  if (!hasExactKeys(value, WORLD_KEYS) || !isGeneration(value.generation) || !isBattle(value.battle) || !Array.isArray(value.endings) || !value.endings.every(isEndingEntry) || !isEndingState(value.ending) || !Array.isArray(value.eventLedger)) {
    return { ok: false, code: "invalid_world_envelope" };
  }
  const parsedStore = parseEntityStore(value.entityStore);
  if (!parsedStore.ok) {
    const issue = parsedStore.issues[0];
    return { ok: false, code: "invalid_entity_store", issueCode: issue?.code, entityId: issue?.entityId };
  }
  const parsedLedger = parseCommittedEventLedger(value.eventLedger);
  if (!parsedLedger.ok) {
    return { ok: false, code: "invalid_world_envelope" };
  }
  const ledgerIssue = validateWorldStateEventLedger(parsedLedger.value, parsedStore.store)[0];
  if (ledgerIssue !== undefined) {
    return { ok: false, code: "invalid_event_ledger", issueCode: ledgerIssue.code, entityId: ledgerIssue.eventId };
  }
  const provenanceIssue = validateEntityStoreProvenance(parsedStore.store, parsedLedger.value)[0];
  if (provenanceIssue !== undefined) {
    return { ok: false, code: "invalid_entity_store", issueCode: provenanceIssue.code, entityId: provenanceIssue.entityId };
  }
  const referenceIssue = validateEntityReferences(parsedStore.store)[0];
  if (referenceIssue !== undefined) return { ok: false, code: "invalid_entity_reference", issueCode: referenceIssue.code, entityId: referenceIssue.entityId };
  const battleCompanionIssue = findUnknownBattleCompanionReference(value.battle, parsedStore.store);
  if (battleCompanionIssue !== undefined) return { ok: false, code: "invalid_entity_reference", issueCode: battleCompanionIssue.issueCode, entityId: battleCompanionIssue.entityId };
  const projection = Object.fromEntries(PROJECTION_KEYS.map((key) => [key, value[key]])) as EntityCompatibilityProjection;
  const projectionIssue = validateEntityCompatibilityProjection(parsedStore.store, projection)[0];
  if (projectionIssue !== undefined) return { ok: false, code: "projection_mismatch", issueCode: projectionIssue.code };
  const normalized: WorldState = {
    version: WORLD_STATE_SCHEMA_VERSION,
    generation: value.generation,
    entityStore: parsedStore.store,
    ...projectEntityStore(parsedStore.store),
    battle: value.battle,
    endings: value.endings,
    ending: value.ending,
    eventLedger: parsedLedger.value,
  };
  const worldReferenceIssue = validateWorldStateEntityReferences(normalized)[0];
  if (worldReferenceIssue !== undefined) return { ok: false, code: "invalid_entity_reference", issueCode: worldReferenceIssue.code, entityId: worldReferenceIssue.entityId };
  return { ok: true, value: normalized };
}
