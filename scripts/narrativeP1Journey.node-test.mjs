import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
        close: async () => { closed.add(env.GAME_DB_PATH); },
      }),
      createSqliteClient: (path) => ({ execute: async () => { assert.equal(closed.has(path), true); checkpoints.push(path); return { rows: [{ busy: 0 }] }; }, close() {} }),
      createSqliteGameRepository: () => ({ getCurrentGame: async () => ({ ok: true, status: "active", record: { revision: 0, worldState: { entityStore: { records: [] } }, storyState: {} } }) }),
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
    runId: "sample-1",
    protocolPath: "protocol.json",
    output: "artifacts",
  });
  assert.equal(validateNarrativeP1Args({ mode: "other", runId: "x", protocolPath: "p", output: "o" }), "INVALID_MODE");
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
