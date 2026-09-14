/** Explicit offline responses. This is a transport/contract fixture, not semantic evaluation. */
export function fixtureNarrativeReviewPass(messages: readonly { content: string }[]) {
  const body = JSON.parse(messages[1]!.content) as { context: {
    kind: string;
    executionChecks?: { path: string; quote: string; basisKey: string }[];
    progressRequirements?: { key: string }[];
  } };
  if (body.context.kind === "opening") return { verdict: "pass" };
  const checks = body.context.executionChecks ?? [];
  return {
    verdict: "pass",
    executionChecks: checks.map(check => ({ path: check.path, quote: check.quote, basisKey: check.basisKey,
      playerLocation: { kind: "unchanged" }, participants: [], itemTransfers: [], completedPrerequisites: [] })),
    progressChecks: (body.context.progressRequirements ?? []).map(requirement => {
      const basis = requirement.key.startsWith("progress:ending:") ? requirement.key.slice("progress:".length) : null;
      const check = checks.find(check => check.quote.trim() !== "" && (basis === null ? !check.basisKey.startsWith("ending:") : check.basisKey === basis));
      if (check === undefined) throw new Error(`Missing offline review evidence for ${requirement.key}`);
      return { key: requirement.key, status: "satisfied", path: check.path, quote: check.quote, reason: "离线 fixture 的指定语义判断；仅验证传输和审批流程。" };
    }),
  };
}
