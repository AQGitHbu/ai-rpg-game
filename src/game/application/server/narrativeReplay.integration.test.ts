import { fixtureNarrativeReviewPass } from "./ai/testing/narrativeReviewFixture.testutil";
// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createServerGameEntryPoints } from "./compositionRoot";
import { createSqliteGameRepository } from "./persistence/sqliteGameRepository";
import { createSqliteClient } from "./persistence/sqliteClient";
import { createTempleLetterBundleSource } from "../testing/templeLetterJourney.testutil";
import { asNarrativeJobId } from "@/game/domain/events";
import { asNpcId } from "@/game/domain/worldEntity";
import type { RpgAiRuntime } from "./ai/rpgAiClient";
// @ts-expect-error Node acceptance harness is deliberately an executable .mjs module.
import { createNarrativeP1ReplayRuntime } from "../../../../scripts/narrativeP1Replay.mjs";

it("replays raw opening, NPC and reviewer responses through production parsing and SQLite without network", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p1-actual-replay-"));
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
  const purposes: string[] = [];
  try {
    for (const mode of ["live", "replay"] as const) {
      const databasePath = join(directory, `${mode}.sqlite`);
      const client = createSqliteClient(databasePath);
      const repo = createSqliteGameRepository({ clientFactory: () => client });
      const runtime = createNarrativeP1ReplayRuntime({ mode, directory, stream: "integration", binding: { protocolHash: "test-protocol", codeFingerprint: "test-code", inputHash: "test-input" }, auditFiles: ["audit/live/events.jsonl"] });
      const rawRuntime = runtime.options.aiRuntime as RpgAiRuntime;
      const fixture = createTempleLetterBundleSource();
      const aiRuntime: RpgAiRuntime = mode === "replay" ? rawRuntime : {
        ...rawRuntime, offline: true,
        attempt: (request) => rawRuntime.attempt!(request, async () => {
          purposes.push(request.context.purpose);
          let payload: unknown;
          if (request.context.purpose === "narrative_candidate_review") payload = fixtureNarrativeReviewPass(request.messages);
          else if (request.context.purpose === "npc_deliberation") payload = { npcId: "npc_0", goalIds: [], response: "question", evidenceEventIds: [], discloseFactIds: [], interactionProposals: [] };
          else {
            const current = await repo.getCurrentGame();
            const result = await fixture.generate(current.ok && current.status === "active" && current.record.storyState.narrative.status === "provider_pending"
              ? { kind: "decision", worldState: current.record.worldState, storyState: current.record.storyState, job: current.record.storyState.narrative.job }
              : { kind: "opening", jobId: asNarrativeJobId("fixture-opening"), input: { gameType: "wuxia", gameLength: "short", seed: "fixture" } });
            if (!result.ok) throw new Error("FIXTURE_FAILED");
            payload = "worldDelta" in result.proposal ? {
              worldDelta: result.proposal.worldDelta,
              interactionProposals: result.proposal.interactionProposals,
              sceneDrafts: [
                { slotKey: "current", scene: result.proposal.currentScene },
                ...result.proposal.continuationScenes.map(step => ({ slotKey: step.stepKey, scene: step.scene })),
              ],
            } : result.proposal;
          }
          return { ok: true, content: JSON.stringify(payload), latencyMs: 1 };
        }),
      };
      const entry = createServerGameEntryPoints({ NODE_ENV: "test", GAME_DB_PATH: databasePath, AI_API_BASE_URL: "https://offline.invalid", AI_API_KEY: "offline", AI_MODEL: "fixture", AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_DIR: join(directory, "audit"), AI_TEXT_AUDIT_RUN_ID: mode, GAME_LOG_LEVEL: "silent" }, undefined, repo, { ...runtime.options, aiRuntime });
      try {
        expect(await entry.createGame({ gameType: "wuxia", gameLength: "short" }, "create")).toMatchObject({ ok: true });
        runtime.state("opening", await repo.getCurrentGame());
        const current = await entry.getCurrentGame("current");
        expect(current.ok).toBe(true);
        expect(await entry.performTurn({ actionId: "verification", expectedRevision: current.revision!, interaction: { kind: "free_text", targetNpcId: asNpcId("npc_0"), text: "我想核实接应人的身份。" } }, "turn")).toMatchObject({ ok: true });
        const ensured = await entry.ensureNarrativeScene({}, "ensure");
        expect(ensured).toMatchObject({ ok: true, result: "queued" });
        await entry.close();
        const readClient = createSqliteClient(join(directory, `${mode}.sqlite`));
        const reopened = createSqliteGameRepository({ clientFactory: () => readClient });
        try {
          const final = await reopened.getCurrentGame();
          expect(final).toMatchObject({ ok: true, status: "active", record: { storyState: { narrative: { status: "ready" } } } });
          runtime.state("after-generation", final);
          runtime.finish();
        } finally { await reopened.close(); }
      } finally { await entry.close(); }
    }
    expect(purposes).toContain("npc_deliberation");
    expect(purposes.filter(p => p === "narrative_candidate_review").length).toBeGreaterThanOrEqual(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); try { rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Diagnostic cleanup must not hide the assertion. */ } }
});
