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

function isJson(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) && value.every(isJson)) || (isObject(value) && Object.values(value).every(isJson));
}

function isGeneration(value: unknown): value is GenerationMetadata {
  return isObject(value)
    && typeof value.generationId === "string" && typeof value.seed === "string"
    && typeof value.templateVersion === "string" && typeof value.inputDigest === "string"
    && typeof value.gameType === "string" && isJson(value);
}

function isBattle(value: unknown): value is BattleState {
  return isObject(value) && (value.status === "idle" || (typeof value.status === "string" && typeof value.enemyId === "string")) && isJson(value);
}

function isEndingState(value: unknown): value is EndingState {
  return value === null || (isObject(value) && typeof value.endingId === "string" && (value.outcome === "success" || value.outcome === "failure") && hasExactKeys(value, ["endingId", "outcome"]));
}

function isEndingEntry(value: unknown): value is EndingEntry {
  return isObject(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.description === "string" && Array.isArray(value.requirements) && value.requirements.every(isObject) && isJson(value);
}

function isGameEvent(value: unknown): value is GameEvent {
  return isObject(value) && typeof value.type === "string" && isJson(value);
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
