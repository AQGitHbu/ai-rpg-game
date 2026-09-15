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
    expect(result).toMatchObject({ questionPreservedDecision: true, stateVersions: { entity: 4, world: 8, story: 12 } });
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


describe("P2 compact history coverage", () => {
  it("recovers an omitted old source before delivery after two distinct publications", async () => {
    const result = await runOfflineP2Story({ gameLength: "medium", summaries: "enabled", compact: true });
    expect(result).toMatchObject({ completed: true, finalAct: 5, topicsPreservedProgress: true,
      memoryCoveragePassed: true, oldQuoteOmittedFromOverview: true, oldQuoteLeakedToUninformedNpc: false,
      itemGivenEventCount: 1, reloadEqual: true, questionPreservedDecision: true });
    expect(result.recallSource).toMatchObject({ inRecalledSourcesAndRequest: true });
    expect(result.recallSource.recallCount).toBeGreaterThan(0);
    expect(result.queryTurn - result.oldQuoteTurn).toBeGreaterThanOrEqual(8);
    expect(new Set(result.topicIds).size).toBe(result.topicIds.length);
    expect(result.topicIds.length).toBeLessThanOrEqual(15);
    expect(new Set(result.publications.filter(item => item.beforeDelivery).map(item => item.jobId)).size).toBeGreaterThanOrEqual(2);
    expect(result.publications.every(item => item.sourceFingerprint.length > 0)).toBe(true);
  }, 30_000);

  it("preserves coverage failure when two acts have no applicable topics, without topping up", async () => {
    const result = await runOfflineP2Story({ gameLength: "medium", summaries: "enabled", compact: true, skipTopicActs: [2, 3] });
    expect(result).toMatchObject({ completed: true, memoryCoveragePassed: false, queried: false, itemGivenEventCount: 1 });
    expect(result.topicIds.some(id => id.startsWith("2-") || id.startsWith("3-"))).toBe(false);
    expect(result.topicIds.length).toBeLessThanOrEqual(9);
  }, 30_000);
});
