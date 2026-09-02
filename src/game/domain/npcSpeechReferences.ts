/** Structural checks for references emitted in NPC speech contracts. */
export function isWellFormedNpcSpeechReferenceId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !/\s/u.test(value);
}

export function areUniqueNpcSpeechReferenceIds(values: readonly string[]): boolean {
  return values.every(isWellFormedNpcSpeechReferenceId)
    && new Set(values).size === values.length;
}
