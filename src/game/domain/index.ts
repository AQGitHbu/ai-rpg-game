// Public domain facade. Runtime internals use focused modules; consumers receive
// only the stable new-game input contract through this boundary.
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
