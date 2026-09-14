/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { runOfflineP2Story } from "./narrativeP2Journey.testutil";

describe("P2 complete production story with observer memory", () => {
  it("finishes five acts with two summary watermarks, old-quote retrieval and private NPC isolation", async () => {
    const result = await runOfflineP2Story({ gameLength: "medium", summaries: "enabled" });
    expect(result).toMatchObject({ completed: true, finalAct: 5, oldQuoteInActualAuthorRequest: true,
      oldQuoteLeakedToUninformedNpc: false, itemGivenEventCount: 1, reloadEqual: true, queried: true,
      oldQuoteCoveredAtQuery: true, oldQuoteOmittedFromOverview: true,
      authorReviewerShareFixedPacket: true, npcAuditHasPrivateObserver: true, summaryAuditHasSources: true });
    expect(result).toMatchObject({ questionPreservedDecision: true, stateVersions: { entity: 3, world: 7, story: 12 } });
    expect(result.unclosedQuestions).toBeGreaterThan(0);
    expect(result.eligibleHistoryCount).toBeGreaterThanOrEqual(70);
    expect(result.publishedSummaryRevisions).toBeGreaterThanOrEqual(2);
    expect(result.npcRequestCount).toBeGreaterThanOrEqual(1);
    expect(result.queryTurn - result.oldQuoteTurn).toBeGreaterThanOrEqual(8);
  }, 30_000);

  it.each(["disabled", "fail"] as const)("completes the same medium story when summaries=%s", async summaries => {
    const result = await runOfflineP2Story({ gameLength: "medium", summaries });
    expect(result).toMatchObject({ completed: true, finalAct: 5, publishedSummaryRevisions: 0,
      oldQuoteInActualAuthorRequest: true, oldQuoteLeakedToUninformedNpc: false, itemGivenEventCount: 1, reloadEqual: true });
  }, 30_000);
});
