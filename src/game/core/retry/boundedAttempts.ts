export type BoundedAttemptResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly retryable: boolean; readonly reason: E };

export async function runBoundedAttempts<T, E>(input: {
  readonly maxAttempts: number;
  readonly runAttempt: (attempt: number, priorReason?: E) => Promise<BoundedAttemptResult<T, E>>;
}): Promise<BoundedAttemptResult<T, E>> {
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }

  let priorReason: E | undefined;
  for (let attempt = 1; attempt <= input.maxAttempts; attempt += 1) {
    const result = await input.runAttempt(attempt, priorReason);
    if (result.ok || !result.retryable || attempt === input.maxAttempts) return result;
    priorReason = result.reason;
  }

  throw new Error("unreachable bounded-attempt state");
}
