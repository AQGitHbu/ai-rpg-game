import type { NarrativeMemoryPolicy } from "@/game/domain/narrativeMemoryContext";

export const DEFAULT_NARRATIVE_MEMORY_POLICY: NarrativeMemoryPolicy = {
  threshold: 50,
  batchSize: 10,
  rawSoftEstimatedTokens: 24_000,
  summarySourceMaxEstimatedTokens: 24_000,
  overviewMaxEstimatedTokens: 6_000,
  promptMaxEstimatedTokens: 64_000,
};

export function resolveNarrativeMemoryPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
  override: Partial<NarrativeMemoryPolicy> = {},
): NarrativeMemoryPolicy {
  const rawPromptLimit = env.AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS?.trim();
  const promptMaxEstimatedTokens = rawPromptLimit !== undefined && /^[1-9]\d*$/u.test(rawPromptLimit)
    ? Number(rawPromptLimit)
    : DEFAULT_NARRATIVE_MEMORY_POLICY.promptMaxEstimatedTokens;
  const result = { ...DEFAULT_NARRATIVE_MEMORY_POLICY, ...override, promptMaxEstimatedTokens };
  if (Object.values(result).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("INVALID_NARRATIVE_MEMORY_POLICY");
  if (!Number.isInteger(result.threshold) || !Number.isInteger(result.batchSize)) throw new Error("INVALID_NARRATIVE_MEMORY_POLICY");
  return result;
}
