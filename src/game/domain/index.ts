// Public domain facade. Runtime internals use focused modules; consumers receive
// the stable new-game input contract and the read-only entity store contract here.
export {
  validateNewGameInput,
  type ContentIntensity,
  type GameLength,
  type GameTypeId,
  type NarrativeStyle,
  type NewGameInput,
  type NewGameInputError,
  type NewGameInputErrorCode,
  type ValidatedNewGameInput,
  type ValidateNewGameInputResult,
} from "./newGame";

export {
  createEntityStore,
  entitiesOfKind,
  EntityStoreInvariantError,
  getEntity,
  parseEntityStore,
  validateEntityStoreStructure,
  type EntityStore,
  type EntityStoreValidationCode,
  type EntityStoreValidationIssue,
  type ParseEntityStoreResult,
} from "./entity";
