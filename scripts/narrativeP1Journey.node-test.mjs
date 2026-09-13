import assert from "node:assert/strict";
import test from "node:test";
import { createNarrativeP1ReplayRuntime } from "./narrativeP1Replay.mjs";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NARRATIVE_P1_PROTOCOL_PATH,
  DEFAULT_NARRATIVE_P1_OUTPUT_ROOT,
  closeNarrativeP1Entry,
  parseNarrativeP1Args,
  projectNarrativeP1GameSetup,
  resolveNarrativeP1ArtifactDirectory,
  waitForNarrativeP1Generation,
  validateNarrativeP1Args,
  selectProductionChoice,
  createScenarioSnapshotCache,
  currentStoryInteractions,
  offeredProductionChoices,
  createProductionRouteRunner,
} from "./narrativeP1Journey.mjs";

test("scenario initialization is shared by all routes including failed openings", async () => {
  const calls = [];
  const initialize = createScenarioSnapshotCache(async (id) => {
    calls.push(id);
    return id === "S1" ? { ok: true, snapshot: "one" } : { ok: false, code: "OPENING_FAILED" };
  });
  const first = await initialize("S1");
  assert.equal(await initialize("S1"), first);
  assert.equal(await initialize("S1"), first);
  const failed = await initialize("S2");
  assert.equal(await initialize("S2"), failed);
  assert.deepEqual(calls, ["S1", "S2"]);
});

test("choice policy uses approved operations despite misleading labels", () => {
  const choices = [{ choiceToken: "wrong", label: "保密引荐" }, { choiceToken: "right", label: "普通说法" }];
  const view = { narrative: { choices }, currentLocation: { actions: [] }, story: {} };
  const actions = new Map([
    ["wrong", { type: "talk", npcId: "n", interactionId: "verify" }],
    ["right", { type: "talk", npcId: "n", interactionId: "promise" }],
  ]);
  const interactions = [{ id: "verify", operation: "request_verification" }, { id: "promise", operation: "promise_confidentiality" }];
  assert.equal(selectProductionChoice(view, "private", actions, interactions, new Set())?.choiceToken, "right");
  assert.equal(selectProductionChoice(view, "public", actions, interactions, new Set())?.choiceToken, "wrong");
  assert.equal(selectProductionChoice(view, "verify_first", actions, interactions, new Set()), undefined);
  assert.equal(selectProductionChoice(view, "verify_first", actions, interactions, new Set(["verify_freeform_submitted"]))?.choiceToken, "wrong");
  assert.equal(selectProductionChoice(view, "private", new Map(), [], new Set()), undefined);
});

test("reads production EntityRecord core discriminants and includes location delivery alongside narrative choices", () => {
  const definition = { id: "promise", operation: "promise_confidentiality" };
  assert.deepEqual(currentStoryInteractions({ entityStore: { records: [
    { core: { kind: "npc" }, interactions: [definition] }, { core: { kind: "location" } },
  ] } }), [definition]);
  assert.deepEqual(offeredProductionChoices({ narrative: { choices: [{ choiceToken: "talk" }] }, currentLocation: { actions: [{ choiceToken: "give" }] } }).map((choice) => choice.choiceToken), ["talk", "give"]);
});

test("production runner creates two openings and copies each closed checkpoint into three isolated files", async () => {
  const root = mkdtempSync(join(tmpdir(), "narrative-snapshot-"));
  const created = [];
  const closed = new Set();
  const checkpoints = [];
  try {
    const runner = await createProductionRouteRunner({}, {
      createServerGameEntryPoints: (env) => ({
        createGame: async () => { created.push(env.GAME_DB_PATH); writeFileSync(env.GAME_DB_PATH, env.AI_TEXT_AUDIT_RUN_ID); return { ok: true }; },
        getCurrentGame: async () => ({ ok: true, status: "active", revision: 0, view: { ending: null, narrativeGeneration: { status: "ready" }, narrative: { choices: [], npcDialogues: [{ npcId: "receiver", freeInputEnabled: true }] }, currentLocation: { actions: [{ choiceToken: "deliver" }] }, story: {} } }),
        performTurn: async (command) => {
          assert.deepEqual(command.interaction, { kind: "free_text", targetNpcId: "receiver", text: "我想先核实接应人的身份，再决定是否把信筒交给他。" });
          assert.equal(command.expectedRevision, 0);
          return { ok: false, code: "TEST_AFTER_COMMAND" };
        },
        ackPrologue: async () => ({ ok: true }),
        close: async () => { closed.add(env.GAME_DB_PATH); },
      }),
      createSqliteClient: (path) => ({ execute: async () => { assert.equal(closed.has(path), true); checkpoints.push(path); return { rows: [{ busy: 0 }] }; }, close() {} }),
      createSqliteGameRepository: () => ({ getCurrentGame: async () => ({ ok: true, status: "active", record: { revision: 0, worldState: { entityStore: { records: [] } }, storyState: { delivery: { itemId: "letter", giverNpcId: "giver", recipientNpcId: "receiver" } } } }) }),
      createServerSqliteClientFactory: () => {}, buildChoiceMap: () => new Map([["deliver", { type: "give_item", itemId: "letter", npcId: "receiver" }]]),
    });
    for (const scenarioId of ["S1", "S2"]) for (const kind of ["private", "public", "verify_first"]) {
      const routeId = `${scenarioId}-${kind}`;
      const result = await runner({ mode: "live", route: { routeId, scenarioId, kind }, setup: { personalityTags: [] }, budget: { used: 0, reserve: () => true }, artifactDirectory: root });
      assert.equal(result.failureCode, kind === "verify_first" ? "TEST_AFTER_COMMAND" : "ROUTE_POLICY_UNSUPPORTED");
      assert.equal(readFileSync(join(root, `${routeId}.sqlite`), "utf8"), `${scenarioId}-opening`);
    }
    assert.equal(created.length, 2);
    assert.deepEqual(checkpoints, created);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parses register/live/replay arguments without accepting unknown modes", () => {
  assert.deepEqual(parseNarrativeP1Args([
    "--mode=register",
    "--run-id=sample-1",
    "--protocol=protocol.json",
    "--output=artifacts",
  ]), {
    mode: "register",
    profile: "matrix",
    replaySource: "",
    runId: "sample-1",
    protocolPath: "protocol.json",
    output: "artifacts",
  });
  assert.equal(validateNarrativeP1Args({ mode: "other", runId: "x", protocolPath: "p", output: "o" }), "INVALID_MODE");
});

test("actual response tape strictly matches requests and state, preserves failures and original artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "p1-tape-"));
  try {
    const recording = createNarrativeP1ReplayRuntime({ mode: "live", directory: root, stream: "S1-private" });
    const gameId = recording.options.identity("gameId");
    const time = recording.options.domainTime("action:1");
    const request = { role: "narrative_bundle", callId: recording.options.aiRuntime.nextCallId(), attempt: 1, context: { purpose: "npc_deliberation" }, model: "test", messages: [{ role: "user", content: "秘密" }], options: { timeoutMs: 200 } };
    const failure = { ok: false, code: "timeout", retryable: true, latencyMs: 10 };
    await recording.options.aiRuntime.attempt(request, async () => failure);
    recording.state("commit", { gameId, createdAt: time, revision: 2, storyState: { narrative: { job: { attempt: { leaseId: "live", leaseExpiresAt: "live-expiry" } } } } });
    recording.finish();
    const original = readFileSync(join(root, "S1-private.runtime.json"), "utf8");
    const fresh = () => createNarrativeP1ReplayRuntime({ mode: "replay", directory: join(root, "replay"), sourceDirectory: root, stream: "S1-private" });
    const replay = fresh();
    assert.equal(replay.options.identity("gameId"), gameId);
    assert.equal(replay.options.domainTime("action:1"), time);
    assert.deepEqual(await replay.options.aiRuntime.attempt(request, () => { throw new Error("NETWORK_FORBIDDEN"); }), failure);
    replay.state("commit", { gameId, createdAt: time, revision: 2, storyState: { narrative: { job: { attempt: { leaseId: "replay", leaseExpiresAt: "replay-expiry" } } } } });
    assert.equal(replay.finish().replayedTransportAttempts, 1);
    assert.equal(readFileSync(join(root, "S1-private.runtime.json"), "utf8"), original);
    await assert.rejects(fresh().options.aiRuntime.attempt({ ...request, attempt: 2 }, async () => failure), /REPLAY_REQUEST_MISMATCH/);
    await assert.rejects(fresh().options.aiRuntime.attempt({ ...request, messages: [] }, async () => failure), /REPLAY_REQUEST_MISMATCH/);
    assert.throws(() => fresh().finish(), /REPLAY_RESPONSE_EXTRA/);
    assert.throws(() => fresh().state("commit", { revision: 3 }), /REPLAY_SEMANTIC_MISMATCH/);
    assert.throws(() => createNarrativeP1ReplayRuntime({ mode: "replay", directory: root, stream: "missing" }), /REPLAY_IDENTITY_TAPE_MISSING/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("normal failed routes seal drained audit and replay the exact failure state", async () => {
  const root = mkdtempSync(join(tmpdir(), "p1-failed-route-"));
  const replayDirectory = join(root, "replay");
  mkdirSync(replayDirectory);
  const binding = { protocolHash: "protocol", codeFingerprint: "code", inputHash: "input" };
  const failureState = { ok: true, status: "active", record: { revision: 1, storyState: { narrative: { status: "provider_failed", failedAt: "recorded-time" } } } };
  const drained = new Set();
  const adapters = {
    createServerGameEntryPoints: (env, _unused, _repository, options) => {
      const audits = [];
      return {
        createGame: async () => { writeFileSync(env.GAME_DB_PATH, "opening"); return { ok: true }; },
        ackPrologue: async () => {
          const request = { role: "narrative_bundle", callId: options.aiRuntime.nextCallId(), attempt: 1, context: { purpose: "npc_deliberation" }, messages: [{ role: "user", content: "request" }], model: "fixture", options: {} };
          const output = await options.aiRuntime.attempt(request, async () => {
            assert.equal(options.aiRuntime.offline, false);
            return { ok: false, code: "timeout", latencyMs: 1 };
          });
          audits.push({ kind: "ai_call", sequence: 1, timestamp: "2026-09-13", role: request.role, callId: request.callId, attempt: 1, input: { messages: request.messages }, output });
          return { ok: true };
        },
        getCurrentGame: async () => ({ ok: true, status: "active", revision: 1, view: { ending: null, narrativeGeneration: { status: "failed" } } }),
        close: async () => {
          drained.add(env.GAME_DB_PATH);
          const directory = join(env.AI_TEXT_AUDIT_DIR, env.AI_TEXT_AUDIT_RUN_ID);
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "events.jsonl"), audits.map(row => JSON.stringify(row)).join("\n"));
        },
      };
    },
    createSqliteGameRepository: ({ clientFactory: env }) => ({ getCurrentGame: async () => ({ ...structuredClone(failureState), drained: drained.has(env.GAME_DB_PATH) }) }),
    createServerSqliteClientFactory: env => env,
    createSqliteClient: () => ({ execute: async () => ({ rows: [{ busy: 0 }] }), close() {} }),
    buildChoiceMap: () => new Map(),
  };
  try {
    const input = { route: { routeId: "S1-diagnostic", scenarioId: "S1", kind: "diagnostic" }, setup: { personalityTags: [] }, budget: { used: 0, reserve: () => true } };
    const live = await createProductionRouteRunner({}, adapters, root, binding);
    assert.equal((await live({ ...input, mode: "live", artifactDirectory: root })).failureCode, "AI_GENERATION_FAILED");
    const original = readFileSync(join(root, "S1-diagnostic.runtime.json"), "utf8");
    const tape = JSON.parse(original).tape;
    assert.equal(tape.audit.length, 1);
    assert.equal(tape.states.find(state => state.key === "failure").semantic.state.drained, true);
    const replay = await createProductionRouteRunner({}, adapters, root, binding);
    const result = await replay({ ...input, mode: "replay", artifactDirectory: replayDirectory });
    assert.equal(result.completed, false);
    assert.equal(result.failureCode, "AI_GENERATION_FAILED");
    assert.equal(result.replayedTransportAttempts, 1);
    assert.equal(readFileSync(join(root, "S1-diagnostic.runtime.json"), "utf8"), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bound replay refuses cross-protocol tapes and missing or modified raw audit", async () => {
  const root = mkdtempSync(join(tmpdir(), "p1-bound-tape-"));
  const binding = { protocolHash: "registered", codeFingerprint: "code", inputHash: "input" };
  try {
    const runtime = createNarrativeP1ReplayRuntime({ mode: "live", directory: root, stream: "S1-opening", binding, auditFiles: ["audit/events.jsonl"] });
    const request = { role: "narrative_bundle", callId: "call", attempt: 1, context: { purpose: "opening" }, messages: [{ role: "user", content: "story" }], options: {}, model: "test" };
    const output = { ok: true, content: "{}", latencyMs: 1 };
    await runtime.options.aiRuntime.attempt(request, async () => output);
    mkdirSync(join(root, "audit"));
    const auditPath = join(root, "audit/events.jsonl");
    const audit = JSON.stringify({ sequence: 1, timestamp: "2026-09-13", kind: "ai_call", callId: "call", attempt: 1, role: request.role, input: { messages: request.messages }, output }) + "\n";
    writeFileSync(auditPath, audit);
    runtime.finish();
    const replay = () => createNarrativeP1ReplayRuntime({ mode: "replay", directory: join(root, "replay"), sourceDirectory: root, stream: "S1-opening", binding });
    assert.doesNotThrow(replay);
    assert.throws(() => createNarrativeP1ReplayRuntime({ mode: "replay", directory: root, stream: "S1-opening", binding: { ...binding, protocolHash: "unrelated" } }), /REPLAY_BINDING_MISMATCH/);
    writeFileSync(auditPath, audit.replace('"content":"{}"', '"content":"changed"'));
    assert.throws(replay, /REPLAY_AUDIT_INVALID/);
    rmSync(auditPath);
    assert.throws(replay, /REPLAY_AUDIT_INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("defaults keep protocol and artifacts in the narrative P1 namespace", () => {
  assert.match(DEFAULT_NARRATIVE_P1_PROTOCOL_PATH, /artifacts[\\/]narrative-p1/);
  assert.match(DEFAULT_NARRATIVE_P1_OUTPUT_ROOT, /artifacts[\\/]narrative-p1/);
});

test("missing required run id is a parameter error", () => {
  assert.equal(validateNarrativeP1Args({ mode: "replay", runId: "", protocolPath: "p", output: "o" }), "MISSING_RUN_ID");
});

test("does not append the run id twice when output already names the run directory", () => {
  assert.match(
    resolveNarrativeP1ArtifactDirectory({ runId: "p1-01", output: "artifacts/narrative-p1/p1-01" }, true),
    /artifacts[\\/]narrative-p1[\\/]p1-01$/,
  );
  assert.match(
    resolveNarrativeP1ArtifactDirectory({ runId: "p1-01", output: "artifacts/narrative-p1" }, false),
    /artifacts[\\/]narrative-p1[\\/]p1-01$/,
  );
});

test("cleanup does not replace a route failure when an entry close rejects", async () => {
  await assert.doesNotReject(() => closeNarrativeP1Entry({ close: async () => { throw new Error("close failed"); } }));
});

test("projects validated NewGameInput to the exact GameSetup contract", () => {
  assert.deepEqual(projectNarrativeP1GameSetup({
    gameType: "wuxia",
    gameLength: "short",
    characterName: "沈行",
    characterIdentity: "过路旅人",
    characterProfile: "先核实身份",
    personalityTags: ["谨慎"],
    worldPremise: "渡口附近有破庙和客栈。",
    storyOpening: "我来到渡口寻找接应人。",
    narrativeStyle: "novel",
    contentIntensity: "normal",
  }), {
    characterName: "沈行",
    characterIdentity: "过路旅人",
    characterProfile: "先核实身份",
    personalityTags: ["谨慎"],
    worldPremise: "渡口附近有破庙和客栈。",
    storyOpening: "我来到渡口寻找接应人。",
    narrativeStyle: "novel",
    contentIntensity: "normal",
  });
});

test("waits for background narrative generation without consuming an action", async () => {
  let reads = 0;
  let ensures = 0;
  const entry = {
    async getCurrentGame() {
      reads += 1;
      return {
        ok: true,
        status: "active",
        view: {
          ending: null,
          narrativeGeneration: { status: reads === 1 ? "pending" : "ready" },
        },
      };
    },
    async ensureNarrativeScene() {
      ensures += 1;
      return { ok: true, result: "queued" };
    },
  };

  const result = await waitForNarrativeP1Generation(entry, "route-1", {
    pollIntervalMs: 0,
    maxPolls: 2,
  });

  assert.equal(result.ok, true);
  assert.equal(reads, 2);
  assert.equal(ensures, 1);
});
