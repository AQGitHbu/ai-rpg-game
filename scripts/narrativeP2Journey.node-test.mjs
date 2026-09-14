import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NARRATIVE_P2_PROTOCOL_VERSION, parseNarrativeP2Args, runNarrativeP2Journey, validateNarrativeP2Args } from "./narrativeP2Journey.mjs";
import { installTsHooks } from "./narrativeP1Journey.mjs";
import { createNarrativeP1ReplayRuntime } from "./narrativeP1Replay.mjs";
import { createNarrativeP2ProductionRunner, readP2MemoryState, hashP2Snapshot } from "./narrativeP2Production.mjs";
installTsHooks();
const { createNarrativeP2Protocol } = await import("../src/game/application/testing/narrativeP2Journey.ts");
const env = { AI_MODEL: "offline-fixture", AI_API_BASE_URL: "https://fixture.invalid", AI_API_KEY: "offline-fixture-secret", AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: "64000" };
const deps = { environment: { model: env.AI_MODEL, apiBaseUrl: env.AI_API_BASE_URL, inputMaxEstimatedTokens: 64000 }, codeFingerprint: "fixture-code" };
const options = { environment: env, codeFingerprint: "fixture-code" };

test("P2 CLI uses the single full protocol, register is zero transport and immutable", async () => {
  const root = mkdtempSync(join(tmpdir(), "p2-script-"));
  try {
    const protocolPath = join(root, "protocol.json");
    assert.deepEqual(parseNarrativeP2Args(["--mode=register", "--run-id=p2", `--protocol=${protocolPath}`, `--output=${root}`]), { mode: "register", runId: "p2", protocol: protocolPath, output: root, replaySource: "" });
    assert.equal(validateNarrativeP2Args({ mode: "other", runId: "p2", protocol: protocolPath, output: root }), "INVALID_MODE");
    assert.throws(() => parseNarrativeP2Args(["--unknown=true"]), /UNKNOWN_ARGUMENT/);
    assert.deepEqual(await runNarrativeP2Journey({ mode: "register", runId: "p2", protocolPath, outputDirectory: root }, options), { plannedRoutes: 2, completedRoutes: 0, passed: true });
    const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
    assert.equal(protocol.protocolVersion, NARRATIVE_P2_PROTOCOL_VERSION);
    assert.deepEqual(protocol, createNarrativeP2Protocol("p2", deps));
    assert.ok(!JSON.stringify(protocol).includes(env.AI_API_KEY));
    await assert.rejects(runNarrativeP2Journey({ mode: "register", runId: "p2", protocolPath, outputDirectory: root }, options), /EEXIST/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("fake completed artifacts cannot pass strict zero-network production replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "p2-script-replay-"));
  try {
    const protocolPath = join(root, "protocol.json");
    await runNarrativeP2Journey({ mode: "register", runId: "p2", protocolPath, outputDirectory: root }, options);
    writeFileSync(join(root, "S-short.json"), '{"completed":true}'); writeFileSync(join(root, "M-medium.json"), '{"completed":true}');
    const result = await runNarrativeP2Journey({ mode: "replay", runId: "p2", protocolPath, outputDirectory: join(root, "replay"), replaySource: root }, options);
    assert.deepEqual(result, { plannedRoutes: 2, completedRoutes: 0, passed: false });
    assert.equal(JSON.parse(readFileSync(join(root, "replay", "S-short.json"), "utf8")).failureCode, "REPLAY_IDENTITY_TAPE_MISSING");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a real production create failure records actual transport and strictly replays without sending", async () => {
  const root = mkdtempSync(join(tmpdir(), "p2-production-tape-"));
  let fakeAttempts = 0;
  try {
    const protocol = createNarrativeP2Protocol("p2", deps);
    const runtimeFactory = input => {
      const runtime = createNarrativeP1ReplayRuntime(input);
      const attempt = runtime.options.aiRuntime.attempt;
      runtime.options.aiRuntime = { ...runtime.options.aiRuntime, offline: true, attempt: (request) => attempt(request, async () => {
        fakeAttempts += 1; return { ok: false, code: "invalid_config", retryable: false, latencyMs: 0 };
      }) };
      return runtime;
    };
    const live = await createNarrativeP2ProductionRunner(env, { runtimeFactory });
    const route = protocol.routes[0];
    const recorded = await live({ mode: "live", route, protocol, outputDirectory: join(root, "record"), replaySource: join(root, "record") });
    assert.equal(recorded.completed, false);
    assert.ok(fakeAttempts > 0, JSON.stringify(recorded));
    assert.equal(recorded.httpAttempts, fakeAttempts);
    const replay = await createNarrativeP2ProductionRunner(env);
    const replayed = await replay({ mode: "replay", route, protocol, outputDirectory: join(root, "replay"), replaySource: join(root, "record") });
    assert.equal(replayed.completed, false);
    assert.equal(replayed.strictReplayPassed, true, JSON.stringify(replayed));
    assert.equal(replayed.httpAttempts, 0);
    assert.equal(replayed.logicalAttempts, recorded.logicalAttempts);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("strict memory state keeps cache fingerprints, watermarks, attempts and prepared hashes", async () => {
  const rows = { narrative_memory_summaries: [{ game_id: "g", generation_id: "gen", observer_id: "p", policy_version: "memory-p2/1", summary_revision: 2, covered_through_sequence: 19, source_fingerprint: "source", state_json: '{"overview":{"historyIds":["h1"]}}' }],
    narrative_memory_attempts: [{ game_id: "g", generation_id: "gen", job_id: "j", epoch: 0, http_attempts: 4, prepared_hash: "prepared", expected_narrative_job_json: '{"leaseId":"lease-a","candidateVersion":1}', prepared_json: '{"sourceFingerprint":"source","player":{"recalled":[{"id":"h1","text":"original"}]}}' }] };
  const client = { execute: async sql => ({ rows: sql.includes("sqlite_master") ? Object.keys(rows).map(name => ({ name })) : sql.includes("FROM narrative_memory_summaries") ? rows.narrative_memory_summaries : rows.narrative_memory_attempts }) };
  const state = await readP2MemoryState(client);
  assert.equal(state.summaries[0].source_fingerprint, "source"); assert.equal(state.attempts[0].prepared_hash, "prepared");
  const root = mkdtempSync(join(tmpdir(), "p2-cache-tape-"));
  try {
    const record = createNarrativeP1ReplayRuntime({ mode: "live", directory: root, stream: "cache" });
    record.state("memory", state); record.finish();
    const replay = createNarrativeP1ReplayRuntime({ mode: "replay", directory: join(root, "replay"), sourceDirectory: root, stream: "cache" });
    const reacquired = { ...state, attempts: state.attempts.map(row => ({ ...row, guard: { attempt: { ...row.guard.attempt, leaseId: "lease-b" } } })) };
    assert.equal(hashP2Snapshot(state), hashP2Snapshot(reacquired));
    replay.state("memory", reacquired);
    assert.equal(replay.finish().matchedStates, 1);
    const tampered = createNarrativeP1ReplayRuntime({ mode: "replay", directory: join(root, "tampered"), sourceDirectory: root, stream: "cache" });
    assert.throws(() => tampered.state("memory", { ...state, summaries: [{ ...state.summaries[0], source_fingerprint: "changed" }] }), /REPLAY_SEMANTIC_MISMATCH/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("complete five-act production fixture records and strictly replays summary and ablation requests", { timeout: 120000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "p2-full-production-"));
  const { buildOfflineP2Draft, buildOfflineP2Opening } = await import("../src/game/application/testing/narrativeP2Journey.testutil.ts");
  const { createSqliteGameRepository } = await import("../src/game/application/server/persistence/sqliteGameRepository.ts");
  const { createSqliteClient } = await import("../src/game/application/server/persistence/sqliteClient.ts");
  let sends = 0;
  try {
    const protocol = createNarrativeP2Protocol("p2", deps);
    const route = protocol.routes[1];
    const runtimeFactory = input => {
      const runtime = createNarrativeP1ReplayRuntime(input);
      const recordedAttempt = runtime.options.aiRuntime.attempt;
      runtime.options.aiRuntime = { ...runtime.options.aiRuntime, offline: true, attempt: request => recordedAttempt(request, async () => {
        sends += 1;
        let response;
        switch (request.context.purpose) {
          case "narrative_candidate_review": response = { verdict: "pass" }; break;
          case "npc_deliberation": {
            const context = JSON.parse(request.messages[1].content.split("\n\n只返回")[0]);
            response = { npcId: context.npc.npcId, goalIds: [], response: "cooperate", evidenceEventIds: [], discloseFactIds: [], interactionProposals: [] };
            break;
          }
          case "narrative_memory_summary": {
            const sources = JSON.parse(request.messages[1].content);
            response = { historyIds: sources.history.slice(0, sources.kind === "batch" ? 4 : 8).map(entry => entry.id), eventIds: [] };
            break;
          }
          case "narrative_bundle_generation": {
            if (request.context.trigger === "initialization") {
              response = await buildOfflineP2Opening({ kind: "opening", jobId: request.context.jobId, input: { gameType: "wuxia", gameLength: route.gameLength } });
            } else {
              const repository = createSqliteGameRepository({ clientFactory: () => createSqliteClient(join(input.directory, `${input.stream}.sqlite`)) });
              try {
                const saved = await repository.getCurrentGame();
                assert.ok(saved.ok && saved.status === "active");
                const { worldState, storyState } = saved.record;
                assert.equal(storyState.narrative.status, "provider_pending");
                response = buildOfflineP2Draft({ kind: "decision", worldState, storyState, job: storyState.narrative.job });
              } finally { await repository.close(); }
            }
            break;
          }
          default: throw new Error(`unexpected fixture request ${request.context.purpose}`);
        }
        return { ok: true, content: JSON.stringify(response), latencyMs: 0 };
      }) };
      return runtime;
    };
    const record = await createNarrativeP2ProductionRunner(env, { runtimeFactory, pollIntervalMs: 1 });
    const recorded = await record({ mode: "live", route, protocol, outputDirectory: join(root, "record"), replaySource: join(root, "record") });
    assert.equal(recorded.completed, true, JSON.stringify({ recorded, root }));
    assert.equal(recorded.coveragePassed, true, JSON.stringify({ recorded, coverage: JSON.parse(readFileSync(join(root, "record", `${route.routeId}.coverage.json`), "utf8")) }));
    const envelope = JSON.parse(readFileSync(join(root, "record", `${route.routeId}.runtime.json`), "utf8"));
    const final = envelope.tape.states.at(-1).semantic;
    assert.equal(final.game.record.storyState.targetActs, 5);
    assert.equal(final.game.record.storyState.narrative.status, "ready");
    assert.ok(final.game.record.storyState.history.entries.filter(entry => entry.kind !== "shown_choice").length >= 70);
    assert.ok(final.memory.summaries.some(row => row.state.batches.length >= 2));
    assert.ok(final.memory.attempts.some(row => row.prepared_hash && row.prepared));
    assert.ok(envelope.tape.calls.some(call => call.request.context.purpose === "narrative_memory_summary"));
    assert.ok(sends > 10);
    const sentBeforeReplay = sends;
    const replay = await createNarrativeP2ProductionRunner(env, { pollIntervalMs: 1 });
    const replayed = await replay({ mode: "replay", route, protocol, outputDirectory: join(root, "replay"), replaySource: join(root, "record") });
    assert.equal(replayed.completed, true, JSON.stringify({ replayed, root }));
    assert.equal(replayed.coveragePassed, true, JSON.stringify({ replayed, root }));
    assert.equal(replayed.strictReplayPassed, true);
    assert.equal(replayed.logicalAttempts, recorded.logicalAttempts);
    assert.equal(replayed.httpAttempts, 0);
    assert.equal(sends, sentBeforeReplay);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
