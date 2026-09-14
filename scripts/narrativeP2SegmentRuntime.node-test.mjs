import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createP2RouteManifest, openP2RouteManifest, p2ManifestGuard } from "./narrativeP2Manifest.mjs";
import { createNarrativeP2SegmentRuntime } from "./narrativeP2SegmentRuntime.mjs";
import { hashReplayValue } from "./narrativeP1Replay.mjs";
import { installTsHooks, projectNarrativeP1GameSetup, waitForNarrativeP1Generation } from "./narrativeP1Journey.mjs";
import { readP2MemoryState, hashP2Snapshot } from "./narrativeP2Production.mjs";
import { selectProductionChoice, currentStoryInteractions } from "./narrativeP1Choices.mjs";
installTsHooks();
const { createServerGameEntryPoints } = await import("../src/game/application/server/compositionRoot.ts");
const { createSqliteGameRepository } = await import("../src/game/application/server/persistence/sqliteGameRepository.ts");
const { createSqliteClient } = await import("../src/game/application/server/persistence/sqliteClient.ts");
const { buildChoiceMap } = await import("../src/game/application/buildChoiceMap.ts");
const { fixtureNarrativeReviewPass } = await import("../src/game/application/server/ai/testing/narrativeReviewFixture.testutil.ts");
const { buildOfflineP2Draft, buildOfflineP2Opening } = await import("../src/game/application/testing/narrativeP2Journey.testutil.ts");
const { createNarrativeP2Protocol } = await import("../src/game/application/testing/narrativeP2Journey.ts");
const env = { AI_MODEL: "offline-fixture", AI_API_BASE_URL: "https://fixture.invalid", AI_API_KEY: "offline-fixture", AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: "64000" };
const hash = "a".repeat(64);
const binding = { protocolVersion: "narrative-p2/v2", protocolHash: hash, inputHash: hash, sourceHash: hash, codeFingerprint: `fixture:${hash}` };
const budget = { actions: 48, http: 500, wallClockMs: 600000 };

// Real production create/performTurn/ensure, two reopenable tape segments, one SQLite.
// The fixture supplies only provider bytes; all summaries and History are committed by production.
test("P2 segments resume same SQLite and strictly replay production memory publication", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "p2-segments-"));
  const protocol = createNarrativeP2Protocol("fixture", { environment: { model: env.AI_MODEL, apiBaseUrl: env.AI_API_BASE_URL, inputMaxEstimatedTokens: 64000 }, codeFingerprint: binding.codeFingerprint });
  let sends = 0, routeAttemptId;
  const recordedSnapshots = [];
  const recordedCommands = [];
  async function journey(mode) {
    const directory = join(root, mode);
    mkdirSync(directory, { recursive: true });
    const config = { directory, stage: "B", binding, budget };
    let manifest = mode === "live" ? createP2RouteManifest(config) : undefined;
    const mutate = operation => manifest.advance(p2ManifestGuard(manifest.read()), operation);
    if (manifest) { mutate({ type: "start" }); routeAttemptId = manifest.read().routeAttemptId; }
    const database = join(directory, "game.sqlite");
    let actionCount = 0;
    const commands = [];
    for (let segment = 0; segment < 2; segment++) {
      if (mode === "live" && segment > 0) {
        manifest = openP2RouteManifest(config);
        mutate({ type: "resume" });
      }
      const reader = createSqliteGameRepository({ clientFactory: () => createSqliteClient(database) });
      const client = createSqliteClient(database);
      let latest;
      let openingJobId;
      const resolveAttempt = async context => {
        if (context.trigger === "initialization") openingJobId = context.jobId;
        if (openingJobId && context.jobId === openingJobId) return { jobId: context.jobId, epoch: 0 };
        const saved = await reader.getCurrentGame();
        assert.ok(saved.ok && saved.status === "active");
        const job = saved.record.storyState.narrative.job;
        assert.equal(job.jobId, context.jobId);
        return { jobId: job.jobId, epoch: job.attempt.epoch };
      };
      const auditId = manifest ? mutate({ type: "open_audit" }).auditStreams.at(-1) : `M-medium-${segment}`;
      const runtime = createNarrativeP2SegmentRuntime({ mode, directory, sourceDirectory: join(root, "live"), stage: "B", segment,
        binding, manifest, routeAttemptId, checkpoint: manifest ? p2ManifestGuard(manifest.read()) : undefined, resolveAttempt,
        auditFiles: () => [`audit/${auditId}/events.jsonl`] });
      const attempt = runtime.options.aiRuntime.attempt;
      runtime.options.aiRuntime = { ...runtime.options.aiRuntime, offline: true, attempt: request => attempt(request, async () => {
        sends++;
        const state = manifest.read();
        assert.ok(state.reservations.some(r => r.kind === "transport" && r.status === "reserved"));
        assert.ok(state.reservations.some(r => r.kind === "logical" && r.status === "reserved"));
        if (state.counters.transport === 1) return { ok: false, code: "network_error", retryable: true, latencyMs: 0 };
        let response;
        switch (request.context.purpose) {
          case "narrative_candidate_review": response = fixtureNarrativeReviewPass(request.messages); break;
          case "npc_deliberation": {
            const context = JSON.parse(request.messages[1].content.split("\n\n只返回")[0]);
            response = { npcId: context.npc.npcId, goalIds: [], response: "cooperate", evidenceEventIds: [], discloseFactIds: [], interactionProposals: [] }; break;
          }
          case "narrative_memory_summary": {
            assert.ok(state.reservations.some(r => r.kind === "summary_http" && r.status === "reserved"));
            const memory = await readP2MemoryState(client);
            assert.ok(memory.attempts.some(row => row.job_id === request.context.jobId && row.http_attempts > 0));
            if (state.counters.summaryHttp === 1) return { ok: false, code: "invalid_config", retryable: false, latencyMs: 0 };
            const sources = JSON.parse(request.messages[1].content);
            response = { historyIds: sources.history.slice(0, sources.kind === "batch" ? 4 : 8).map(entry => entry.id), eventIds: [] }; break;
          }
          case "narrative_bundle_generation": {
            if (request.context.trigger === "initialization") response = await buildOfflineP2Opening({ kind: "opening", jobId: request.context.jobId, input: { gameType: "wuxia", gameLength: "medium" } });
            else {
              const saved = await reader.getCurrentGame(); const { worldState, storyState } = saved.record;
              response = buildOfflineP2Draft({ kind: "decision", worldState, storyState, job: storyState.narrative.job });
            }
            break;
          }
          default: assert.fail(request.context.purpose);
        }
        return { ok: true, content: JSON.stringify(response), latencyMs: 0 };
      }) };
      const entry = createServerGameEntryPoints({ ...env, NODE_ENV: "test", GAME_DB_PATH: database, AI_TEXT_AUDIT: "full",
        AI_TEXT_AUDIT_DIR: join(directory, "audit"), AI_TEXT_AUDIT_RUN_ID: auditId }, undefined, undefined, { ...runtime.options, memoryPolicy: protocol.policy });
      if (segment === 0) {
        const created = await entry.createGame({ gameType: "wuxia", gameLength: "medium", setup: projectNarrativeP1GameSetup(protocol.input) }, "create");
        assert.equal(created.ok, true, JSON.stringify({ created, failure: runtime.failureCode, root, manifest: manifest?.read() }));
        await entry.ackPrologue("ack");
      }
      const endAt = segment === 0 ? 4 : 40;
      while (actionCount <= endAt) {
        const current = await waitForNarrativeP1Generation(entry, `wait-${actionCount}`, { pollIntervalMs: 1 });
        assert.ok(current.ok && current.status === "active", JSON.stringify(current));
        assert.notEqual(current.view.narrativeGeneration.status, "failed", runtime.failureCode);
        latest = { game: await reader.getCurrentGame(), memory: await readP2MemoryState(client) };
        runtime.state(`ready-${actionCount}`, latest);
        const record = latest.game.record;
        if (manifest?.read().pendingAction) {
          const history = record.storyState.history.entries;
          mutate({ type: "commit_action", actionId: manifest.read().pendingAction.actionId, gameRevision: record.revision,
            sourceHash: hashP2Snapshot(latest), evidence: { historyHash: hashReplayValue(history), historyIds: history.map(h => h.id),
              jobIds: [...new Set(history.map(h => h.jobId).filter(Boolean))], candidateCallIds: [] } });
        }
        if (manifest) mutate({ type: "checkpoint", gameRevision: record.revision, sourceHash: hashP2Snapshot(latest), artifacts: { [`checkpoint-${segment}-${actionCount}`]: hashP2Snapshot(latest) } });
        if (current.view.ending !== null || actionCount === endAt) break;
        const map = buildChoiceMap(record.worldState, record.storyState, record.revision);
        const selected = selectProductionChoice(current.view, "complete", map, currentStoryInteractions(record.worldState), new Set(), new Set(), record.storyState.delivery, actionCount);
        assert.ok(selected);
        const interaction = { kind: "fixed_choice", choiceToken: selected.choiceToken };
        if (manifest) mutate({ type: "reserve_action", interaction });
        const command = { actionId: manifest ? manifest.read().pendingAction.actionId : recordedCommands[actionCount].actionId,
          interaction, expectedRevision: current.revision };
        if (manifest) { recordedCommands.push(command); mutate({ type: "begin_action", actionId: command.actionId }); }
        commands.push(command);
        assert.equal((await entry.performTurn(command, `turn-${actionCount}`)).ok, true);
        actionCount++;
      }
      await entry.close();
      const end = runtime.finish(manifest ? p2ManifestGuard(manifest.read()) : undefined);
      if (manifest) {
        recordedSnapshots.push(latest);
        mutate({ type: "pause", status: "awaiting_review", reason: "test checkpoint", artifacts: { [`ready-${segment}`]: hashP2Snapshot(latest) } });
        assert.equal(end.tapeCursor, manifest.read().counters.transport);
      }
      await reader.close(); client.close();
    }
    return { state: manifest?.read(), commands };
  }
  const live = await journey("live");
  assert.ok(live.state.publications.length >= 2);
  const player = live.state.publications.filter(p => p.observerId === "player_0");
  assert.ok(new Set(player.map(p => p.jobId)).size >= 2, JSON.stringify(live.state.publications));
  assert.ok(live.state.counters.summaryHttp > 0);
  assert.equal(live.state.counters.transport, live.state.counters.logical + 1);
  assert.ok(live.state.counters.batchUpdates > live.state.publications.length, "failed first summary batch cannot be called published");
  assert.equal(live.state.counters.actions, live.commands.length);
  assert.equal(live.state.steps.length, live.commands.length);
  assert.ok(live.state.publications.every(p => live.state.steps.some(step => step.actionId === p.actionId)));
  assert.ok(live.state.reservations.every(r => r.status === "settled"));
  assert.ok(recordedSnapshots[1].memory.summaries.some(s => s.state.batches.length >= 2));
  const beforeReplay = sends;
  const replay = await journey("replay");
  assert.equal(sends, beforeReplay);
  assert.deepEqual(replay.commands, live.commands);
  const file = join(root, "live", "B.segment-0.json");
  const corrupted = JSON.parse(readFileSync(file, "utf8")); corrupted.tape.times.bad = "tampered"; writeFileSync(file, JSON.stringify(corrupted));
  assert.throws(() => createNarrativeP2SegmentRuntime({ mode: "replay", directory: join(root, "bad"), sourceDirectory: join(root, "live"), stage: "B", segment: 1, binding, routeAttemptId }), /P2_TAPE_BINDING/);
});

test("an uncertain send remains reserved and cannot reopen as a new segment", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p2-uncertain-"));
  const config = { directory, stage: "A", binding, budget };
  const manifest = createP2RouteManifest(config); manifest.advance(p2ManifestGuard(manifest.read()), { type: "start" });
  const runtime = createNarrativeP2SegmentRuntime({ mode: "live", directory, stage: "A", segment: 0, binding, manifest,
    checkpoint: p2ManifestGuard(manifest.read()), resolveAttempt: async () => ({ jobId: "job", epoch: 0 }) });
  await assert.rejects(runtime.options.aiRuntime.attempt({ context: { jobId: "job", purpose: "author" } }, async () => { throw Error("lost"); }), /lost/);
  assert.equal(manifest.read().counters.transport, 1);
  assert.equal(manifest.read().reservations[0].status, "reserved");
  assert.throws(() => runtime.finish(p2ManifestGuard(manifest.read())), /P2_TAPE_CLOSED/);
  assert.throws(() => createNarrativeP2SegmentRuntime({ mode: "live", directory, stage: "A", segment: 0, binding, manifest,
    checkpoint: p2ManifestGuard(manifest.read()) }), /P2_TAPE_CHECKPOINT/);
});
test("logical budget rejection is sticky and blocks completion before another send", async () => {
  const directory = mkdtempSync(join(tmpdir(), "p2-logical-budget-"));
  const manifest = createP2RouteManifest({ directory, stage: "A", binding, budget: { ...budget, http: 1 } });
  manifest.advance(p2ManifestGuard(manifest.read()), { type: "start" });
  const runtime = createNarrativeP2SegmentRuntime({ mode: "live", directory, stage: "A", segment: 0, binding, manifest,
    checkpoint: p2ManifestGuard(manifest.read()), resolveAttempt: async () => ({ jobId: "job", epoch: 0 }) });
  const input = { auditContext: { jobId: "job", purpose: "author" } };
  const settle = await runtime.options.beforeNarrativeRequest(input);
  await settle({ ok: false, code: "invalid_config", retryable: false, latencyMs: 0 });
  await assert.rejects(runtime.options.beforeNarrativeRequest(input), /P2_HTTP_BUDGET_EXHAUSTED/);
  assert.equal(runtime.failureCode, "P2_HTTP_BUDGET_EXHAUSTED");
  assert.equal(manifest.read().counters.logical, 1);
  assert.equal(manifest.read().counters.transport, 0);
  assert.throws(() => runtime.finish(p2ManifestGuard(manifest.read())), /P2_TAPE_CLOSED/);
});
