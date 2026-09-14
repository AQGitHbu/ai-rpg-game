import type { MemorySummaryState } from "@/game/domain/narrativeMemorySummary";
import type { ObserverEvidence } from "./projectObserverEvidence";

export type MemorySummaryPlan =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "batch"; sourceHistoryIds: readonly string[]; throughSequence: number }>;

export function planMemorySummary(input: Readonly<{
  readonly evidence: ObserverEvidence;
  readonly previous: MemorySummaryState | null;
  readonly forceForLength: boolean;
}>): MemorySummaryPlan {
  const coveredThroughSequence = input.previous?.coveredThroughSequence ?? -1;
  const byId = new Map<string, ObserverEvidence["history"][number]>();
  for (const entry of input.evidence.history) {
    if (entry.kind === "shown_choice") continue;
    const existing = byId.get(entry.id);
    if (existing !== undefined && (existing.text !== entry.text || existing.sequence !== entry.sequence)) return { kind: "none" };
    byId.set(entry.id, entry);
  }
  const uncovered = [...byId.values()]
    .filter((entry) => entry.sequence > coveredThroughSequence)
    .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  if (uncovered.length < 50 && !(input.forceForLength && uncovered.length >= 10)) return { kind: "none" };
  const batch = uncovered.slice(0, 10);
  return { kind: "batch", sourceHistoryIds: batch.map((entry) => entry.id), throughSequence: batch[batch.length - 1]!.sequence };
}
