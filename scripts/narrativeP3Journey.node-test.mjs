import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  NARRATIVE_P3_PROTOCOL_VERSION,
  createNarrativeP3RoutePolicy,
  selectNarrativeP3ProductionChoice,
  parseNarrativeP3Args,
  runNarrativeP3Journey,
  validateNarrativeP3Args,
  prepareNarrativeP3SharedSnapshot,
} from "./narrativeP3Journey.mjs";
import { installTsHooks, createScenarioSnapshotCache } from "./narrativeP1Journey.mjs";

installTsHooks();
const { createNarrativeP3Protocol } = await import("../src/game/application/testing/narrativeP3LiveJourney.ts");
const env = {
  AI_MODEL: "fixture-model",
  AI_API_BASE_URL: "https://fixture.invalid",
  AI_API_KEY: "fixture-secret",
  AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: "64000",
};
const deps = {
  environment: { model: env.AI_MODEL, apiBaseUrl: env.AI_API_BASE_URL, inputMaxEstimatedTokens: 64_000 },
  codeFingerprint: "fixture-code",
};
const options = { environment: env, codeFingerprint: "fixture-code" };

test("shared prefix performs real offered actions once and freezes both methods of the same fact", async () => {
  let turns = 0;
  let acks = 0;
  const snapshots = [];
  const actionMap = new Map([
    ["move", { type: "move", locationId: "scene" }],
    ["quiet", { type: "investigate", factId: "evidence", approachId: "quiet" }],
    ["public", { type: "investigate", factId: "evidence", approachId: "public" }],
  ]);
  const state = () => ({ ok: true, status: "active", record: { revision: turns, storyState: { turnNumber: turns }, worldState: {
    entityStore: { records: [] }, worldFacts: [{ factId: "evidence", investigationApproaches: [
      { approachId: "quiet", witnessNpcIds: [] }, { approachId: "public", witnessNpcIds: ["witness"] },
    ] }],
  } } });
  const entry = {
    async ackPrologue() { acks += 1; },
    async getCurrentGame() {
      const view = productionView((turns === 0 ? ["move"] : ["quiet", "public"]).map((choiceToken) => ({ choiceToken, label: choiceToken })));
      view.story.currentObjectiveChoiceToken = "move";
      return { ok: true, status: "active", revision: turns, view: { ...view, narrativeGeneration: { status: "idle" }, ending: null } };
    },
    async performTurn(command) {
      assert.equal(command.interaction.choiceToken, "move");
      assert.equal(command.expectedRevision, 0);
      turns += 1;
      return { ok: true };
    },
  };
  const initialize = createScenarioSnapshotCache(() => prepareNarrativeP3SharedSnapshot({
    entry, repository: { getCurrentGame: async () => state() }, runtime: { state: (key, value) => snapshots.push([key, value]) },
    buildChoiceMap: () => actionMap, scenarioId: "shared",
  }));
  const privateFork = await initialize("shared", {});
  const publicFork = await initialize("shared", {});
  assert.equal(privateFork, publicFork);
  assert.equal(privateFork.ok, true);
  assert.equal(privateFork.actionCount, 1);
  assert.equal(turns, 1);
  assert.equal(acks, 1);
  assert.equal(snapshots.at(-1)[0], "investigation-fork");
});

test("P3 strategy input is offered once and cannot pass route acceptance without confirmed consequences", () => {
  const policy = createNarrativeP3RoutePolicy();
  const view = productionView([]);
  view.narrative.npcDialogues = [{ npcId: "keeper", freeInputEnabled: true }];
  const request = { route: { routeId: "private" }, view, performed: new Set() };
  assert.deepEqual(policy.selectInteraction(request), { kind: "free_text", targetNpcId: "keeper", text: "我先按现场提供的方法查验，再决定怎么交付。" });
  request.performed.add("strategy_freeform_submitted");
  assert.equal(policy.selectInteraction(request), undefined);
  const event = (payload, sequence) => ({ eventId: `event:${sequence}`, outcome: "success", payload, sequence });
  const events = [
    event({ type: "ending_reached", endingId: "ending", outcome: "success" }, 8),
    event({ type: "fact_discovered", factId: "fact", evidenceQuality: "clean", witnessNpcIds: [] }, 2),
    event({ type: "story_interaction_resolved", operation: "request_verification", factIds: ["fact"] }, 5),
    event({ type: "item_given", itemId: "letter", npcId: "recipient" }, 7),
  ];
  const input = { route: request.route, performed: request.performed, endingState: { ok: true, status: "active", record: {
    storyState: { narrative: { status: "ready" }, delivery: { itemId: "letter", recipientNpcId: "recipient" } },
    worldState: { ending: { endingId: "ending", outcome: "success" }, eventLedger: events },
  } }, steps: [] };
  assert.equal(policy.routeSatisfied(input), false);
  events.push(event({ type: "npc_goal_status_changed", evidenceEventIds: ["event:3"] }, 4),
    event({ type: "story_interaction_resolved", operation: "share_known_fact", factIds: ["fact"], evidenceEventIds: ["event:2"] }, 3),
    event({ type: "location_visited", locationId: "old" }, 1), event({ type: "location_visited", locationId: "old" }, 6));
  assert.equal(policy.routeSatisfied(input), false);
  input.steps.push({ interaction: { kind: "free_text" } }, { ok: true, action: { type: "investigate" } });
  assert.equal(policy.routeSatisfied(input), false);
  input.steps.push({ ok: true, action: { type: "move", locationId: "old" }, resultBoundaryProof: {
    kind: "changed_revisit", locationId: "old", sourceEventIds: ["event:2"],
  } });
  assert.equal(policy.routeSatisfied(input), true);
  events[2].payload.factIds = ["unrelated"];
  assert.equal(policy.routeSatisfied(input), false);
});

function productionView(choices) {
  return {
    story: { currentObjectiveChoiceToken: null },
    narrative: { choices, npcDialogues: [] },
    currentLocation: { actions: [], npcs: [], town: { interactiveBuildings: [] } },
    worldMap: { locations: [] },
    obtainableItems: [],
  };
}

function policyInput(route, view, actions, events = [], worldFacts = []) {
  return {
    route: { routeId: route },
    view,
    actionMap: new Map(actions.map((entry) => [entry.choiceToken, entry.action])),
    interactions: [
      { id: "interaction:quiet", operation: "share_known_fact" },
      { id: "interaction:witnessed", operation: "request_verification" },
    ],
    state: { record: { worldState: { eventLedger: events, worldFacts }, storyState: { delivery: undefined, currentObjectiveChoiceToken: null } } },
    performed: new Set(["strategy_freeform_submitted"]),
    performedActions: new Set(),
    delivery: undefined,
    actionCount: 0,
  };
}

test("P3 production policy selects the approved investigation approach and follow-up cooperation", () => {
  const privateChoices = productionView([
    { choiceToken: "quiet", label: "沿纸档暗记查验" },
    { choiceToken: "witnessed", label: "请船户当面见证" },
  ]);
  assert.equal(selectNarrativeP3ProductionChoice(policyInput("private", privateChoices, [
    { choiceToken: "quiet", action: { type: "investigate", approachId: "quiet" } },
    { choiceToken: "witnessed", action: { type: "investigate", approachId: "witnessed" } },
  ])).choiceToken, "quiet");
  assert.equal(selectNarrativeP3ProductionChoice(policyInput("public", privateChoices, [
    { choiceToken: "quiet", action: { type: "investigate", approachId: "quiet" } },
    { choiceToken: "witnessed", action: { type: "investigate", approachId: "witnessed" } },
  ])).choiceToken, "witnessed");

  const evidenceEvent = { outcome: "success", payload: { type: "fact_discovered", evidenceQuality: "clean" } };
  const followUp = productionView([{ choiceToken: "share", label: "把查验结果告诉接应人" }]);
  assert.equal(selectNarrativeP3ProductionChoice(policyInput("private", followUp, [
    { choiceToken: "share", action: { type: "talk", interactionId: "interaction:quiet" } },
  ], [evidenceEvent])).choiceToken, "share");
  assert.equal(selectNarrativeP3ProductionChoice(policyInput("public", followUp, [
    { choiceToken: "share", action: { type: "talk", interactionId: "interaction:quiet" } },
  ], [evidenceEvent])).choiceToken, "share");
  assert.equal(createNarrativeP3RoutePolicy().noChoiceFailureCode, "P3_CAPABILITY_COVERAGE_FAILED");
});

test("private investigation waits for strategy only when a free-input affordance exists", () => {
  const input = policyInput("private", productionView([{ choiceToken: "quiet", label: "查验" }]), [
    { choiceToken: "quiet", action: { type: "investigate", approachId: "quiet" } },
  ]);
  input.performed.clear();
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "quiet");
  input.view.narrative.npcDialogues = [{ npcId: "keeper", freeInputEnabled: true }];
  assert.equal(selectNarrativeP3ProductionChoice(input), undefined);
  const policy = createNarrativeP3RoutePolicy();
  assert.equal(policy.shouldReload({ action: { type: "talk" }, actionCount: 4, steps: [] }), false);
  assert.equal(policy.shouldReload({ action: { type: "investigate" }, actionCount: 7, steps: [] }), true);
  assert.equal(policy.shouldReload({ action: { type: "investigate" }, actionCount: 9, steps: [{ kind: "reload" }] }), false);
});

test("P3 fallback skips a repeated dialogue action when another offered action remains", () => {
  const input = policyInput("private", productionView([
    { choiceToken: "support", label: "先按老规矩办" },
    { choiceToken: "challenge", label: "再问清凭据" },
  ]), [
    { choiceToken: "travel", action: { type: "move", locationId: "town" } },
    { choiceToken: "support", action: { type: "talk", npcId: "keeper", dialogueAct: "support" } },
    { choiceToken: "challenge", action: { type: "talk", npcId: "keeper", dialogueAct: "challenge" } },
  ]);
  input.view.worldMap.locations = [{ travelChoice: { choiceToken: "travel", label: "返回镇上" } }];
  input.performedActions.add(JSON.stringify(input.actionMap.get("support")));
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "challenge");
});

test("P3 fallback prefers a location dialogue entry over global travel", () => {
  const view = productionView([]);
  view.worldMap.locations = [{ travelChoice: { choiceToken: "travel", label: "返回镇上" } }];
  view.currentLocation.npcs = [{ talkChoice: { choiceToken: "talk", label: "与证人交谈" } }];
  const input = policyInput("private", view, [
    { choiceToken: "travel", action: { type: "move", locationId: "town" } },
    { choiceToken: "talk", action: { type: "talk", npcId: "witness", dialogueAct: "ask" } },
  ]);
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "talk");
});

test("P3 fallback can consume a fresh-token dialogue when semantics repeat", () => {
  const input = policyInput("private", productionView([
    { choiceToken: "support", label: "再次确认" },
    { choiceToken: "challenge", label: "继续追问" },
  ]), [
    { choiceToken: "support", action: { type: "talk", npcId: "keeper", dialogueAct: "support" } },
    { choiceToken: "challenge", action: { type: "talk", npcId: "keeper", dialogueAct: "challenge" } },
  ]);
  input.performedActions.add(JSON.stringify(input.actionMap.get("support")));
  input.performedActions.add(JSON.stringify(input.actionMap.get("challenge")));
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "support");
});

test("P3 returns to the story town before repeating witness dialogue after investigation", () => {
  const view = productionView([
    { choiceToken: "talk", label: "继续追问" },
    { choiceToken: "town", label: "返回青渡口" },
  ]);
  view.worldMap.locations = [{ travelChoice: { choiceToken: "town", label: "返回青渡口" } }];
  const input = policyInput("public", view, [
    { choiceToken: "talk", action: { type: "talk", npcId: "witness", dialogueAct: "challenge" } },
    { choiceToken: "town", action: { type: "move", locationId: "town" } },
  ], [{ outcome: "success", payload: { type: "fact_discovered", evidenceQuality: "noisy" } }]);
  input.state.record.worldState.entityStore = { records: [{
    core: { kind: "location", id: "town" },
    location: { scale: "town" },
  }] };
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "town");
});

test("P3 returns through the first offered hop when the story town is multiple moves away", () => {
  const view = productionView([
    { choiceToken: "talk", label: "继续追问" },
    { choiceToken: "middle", label: "沿旧路回镇" },
  ]);
  const input = policyInput("public", view, [
    { choiceToken: "talk", action: { type: "talk", npcId: "witness", dialogueAct: "challenge" } },
    { choiceToken: "middle", action: { type: "move", locationId: "middle" } },
  ], [{ outcome: "success", payload: { type: "fact_discovered", evidenceQuality: "noisy" } }]);
  input.state.record.worldState.currentLocationId = "deep";
  input.state.record.worldState.entityStore = { records: [
    { core: { kind: "location", id: "town" }, location: { scale: "town", connectedLocationIds: ["middle"] } },
    { core: { kind: "location", id: "middle" }, location: { scale: "scene", connectedLocationIds: ["town", "deep"] } },
    { core: { kind: "location", id: "deep" }, location: { scale: "scene", connectedLocationIds: ["middle"] } },
  ] };
  input.proveRevisit = (_context, action) => ({ kind: "changed_revisit", locationId: action.locationId, sourceEventIds: ["discovery"] });
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "middle");
});

test("P3 does not deliver the item before evidence verification", () => {
  const view = productionView([
    { choiceToken: "give", label: "交付旧契" },
    { choiceToken: "town", label: "返回青渡口" },
  ]);
  view.worldMap.locations = [{ travelChoice: { choiceToken: "town", label: "返回青渡口" } }];
  const input = policyInput("public", view, [
    { choiceToken: "give", action: { type: "give_item", itemId: "item", npcId: "receiver" } },
    { choiceToken: "town", action: { type: "move", locationId: "town" } },
  ], [
    { outcome: "success", payload: { type: "fact_discovered", evidenceQuality: "noisy" } },
  ]);
  input.state.record.worldState.entityStore = { records: [{
    core: { kind: "location", id: "town" },
    location: { scale: "town" },
  }] };
  input.state.record.storyState.delivery = { itemId: "item", recipientNpcId: "receiver" };
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "town");
  input.state.record.worldState.eventLedger.push({ outcome: "success", payload: {
    type: "story_interaction_resolved", operation: "request_verification", factIds: ["evidence"],
  } });
  input.offeredChoices = [{ choiceToken: "give", label: "交付旧契" }];
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "give");
});

test("P3 does not submit an unprepared travel after evidence", () => {
  const view = productionView([
    { choiceToken: "talk", label: "继续询问" },
    { choiceToken: "town", label: "返回青渡口" },
  ]);
  const input = policyInput("public", view, [
    { choiceToken: "talk", action: { type: "talk", npcId: "witness", dialogueAct: "ask" } },
    { choiceToken: "town", action: { type: "move", locationId: "town" } },
  ], [{ outcome: "success", payload: { type: "fact_discovered", evidenceQuality: "clean" } }]);
  input.proveRevisit = () => null;
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "talk");
});

for (const operation of ["share_known_fact", "request_verification"]) test(`resolved ${operation} with the old NPC does not skip a different NPC`, () => {
  const input = policyInput("private", productionView([{ choiceToken: "tell", label: "告知接应人" }]), [
    { choiceToken: "tell", action: { type: "talk", npcId: "receiver", interactionId: "tell_receiver" } },
  ], [
    { outcome: "success", payload: { type: "fact_discovered", evidenceQuality: "clean" } },
    { outcome: "success", payload: { type: "story_interaction_resolved", operation, npcId: "giver", factIds: ["evidence"] } },
  ]);
  input.interactions = [{ id: "tell_receiver", operation, factIds: ["evidence"] }];
  input.performed.add(operation);
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "tell");
  input.state.record.worldState.eventLedger.push({ outcome: "success", payload: {
    type: "story_interaction_resolved", operation, npcId: "receiver", factIds: ["evidence"],
  } });
  assert.equal(selectNarrativeP3ProductionChoice(input), undefined);
});

test("private route returns with related evidence before sharing and never selects an unoffered or unrelated move", () => {
  const input = policyInput("private", productionView([
    { choiceToken: "unrelated", label: "旁路" }, { choiceToken: "return", label: "回访" },
    { choiceToken: "share", label: "告知" },
  ]), [
    { choiceToken: "unrelated", action: { type: "move", locationId: "other" } },
    { choiceToken: "return", action: { type: "move", locationId: "old" } },
    { choiceToken: "share", action: { type: "talk", interactionId: "interaction:quiet" } },
    { choiceToken: "hidden", action: { type: "move", locationId: "hidden" } },
  ], [{ eventId: "discovery", outcome: "success", payload: { type: "fact_discovered", evidenceQuality: "clean" } }]);
  input.steps = [];
  input.proveRevisit = (_context, action) => ({ kind: "changed_revisit", locationId: action.locationId,
    sourceEventIds: [action.locationId === "other" ? "unrelated-source" : "discovery"] });
  input.performedActions.add(JSON.stringify({ type: "move", locationId: "old" }));
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "return");
  input.steps.push({ ok: true, action: { type: "move", locationId: "other" }, resultBoundaryProof: {
    kind: "changed_revisit", locationId: "other", sourceEventIds: ["unrelated-source"],
  } });
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "return");
  input.steps.push({ ok: true, action: { type: "move", locationId: "old" }, resultBoundaryProof: {
    kind: "changed_revisit", locationId: "old", sourceEventIds: ["discovery"],
  } });
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "share");
  input.steps = [];
  input.proveRevisit = () => null;
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "share");
  input.route.routeId = "public";
  input.proveRevisit = () => { throw new Error("public route must not force a private revisit"); };
  assert.equal(selectNarrativeP3ProductionChoice(input).choiceToken, "share");
});

test("P3 production policy reports capability coverage instead of falling back to P1 policy", () => {
  const view = productionView([{ choiceToken: "witnessed", label: "请船户当面见证" }]);
  const selected = selectNarrativeP3ProductionChoice(policyInput("private", view, [
    { choiceToken: "witnessed", action: { type: "investigate", approachId: "witnessed" } },
  ]));
  assert.equal(selected, undefined);
  assert.equal(createNarrativeP3RoutePolicy().actionLimit, 32);
});

test("P3 production policy matches arbitrary investigation ids by witness semantics", () => {
  const view = productionView([
    { choiceToken: "stealth", label: "沿纸档暗记查验" },
    { choiceToken: "public", label: "请船户当面见证" },
  ]);
  const worldFacts = [{
    factId: "fact_dynamic",
    investigationApproaches: [
      { approachId: "stealth_scan", label: "沿纸档暗记查验", evidenceQuality: "clean", witnessNpcIds: [] },
      { approachId: "public_check", label: "请船户当面见证", evidenceQuality: "clean", witnessNpcIds: ["npc_witness"] },
    ],
  }];
  const actions = [
    { choiceToken: "stealth", action: { type: "investigate", factId: "fact_dynamic", approachId: "stealth_scan" } },
    { choiceToken: "public", action: { type: "investigate", factId: "fact_dynamic", approachId: "public_check" } },
  ];
  assert.equal(selectNarrativeP3ProductionChoice(policyInput("private", view, actions, [], worldFacts)).choiceToken, "stealth");
  assert.equal(selectNarrativeP3ProductionChoice(policyInput("public", view, actions, [], worldFacts)).choiceToken, "public");
});

test("P3 CLI registers a fixed denominator without transport and keeps route statuses", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-register-"));
  try {
    const protocolPath = join(root, "protocol.json");
    assert.deepEqual(parseNarrativeP3Args(["--mode=register", "--run-id=p3", `--protocol=${protocolPath}`, `--output=${root}`]), {
      mode: "register", runId: "p3", protocol: protocolPath, output: root, replaySource: "",
    });
    assert.equal(validateNarrativeP3Args({ mode: "other", runId: "p3", protocol: protocolPath, output: root }), "INVALID_MODE");
    assert.equal(validateNarrativeP3Args({ mode: "register", runId: "", protocol: protocolPath, output: root }), "INVALID_RUN_ID");
    const registered = await runNarrativeP3Journey({ mode: "register", runId: "p3", protocolPath, outputDirectory: root }, options);
    assert.deepEqual(registered, {
      plannedRoutes: 2,
      routes: [
        { routeId: "private", status: "not_run" },
        { routeId: "public", status: "not_run" },
      ],
      completedRoutes: 0,
      httpAttempts: 0,
      passed: false,
    });
    const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
    assert.equal(protocol.protocolVersion, NARRATIVE_P3_PROTOCOL_VERSION);
    assert.deepEqual(protocol, createNarrativeP3Protocol("p3", deps));
    assert.ok(!JSON.stringify(protocol).includes(env.AI_API_KEY));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3 live records completed and blocked routes while replay invokes only the zero-HTTP route runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-replay-"));
  const previousGate = process.env.RUN_REAL_AI_JOURNEY;
  process.env.RUN_REAL_AI_JOURNEY = "1";
  try {
    const protocolPath = join(root, "protocol.json");
    const record = join(root, "record");
    const replay = join(root, "replay");
    await runNarrativeP3Journey({ mode: "register", runId: "p3", protocolPath, outputDirectory: record }, options);
    const live = await runNarrativeP3Journey({ mode: "live", runId: "p3", protocolPath, outputDirectory: record }, options, {
      routeRunner: async ({ route }) => route.routeId === "private"
        ? { status: "completed", completed: true, httpAttempts: 3, actionCount: 7 }
        : { status: "blocked", completed: false, failureCode: "P3_CAPABILITY_COVERAGE_FAILED", httpAttempts: 2, actionCount: 4 },
    });
    assert.deepEqual(live.routes.map((route) => route.status), ["completed", "blocked"]);
    let replayCalls = 0;
    const replayed = await runNarrativeP3Journey({ mode: "replay", runId: "p3", protocolPath, outputDirectory: replay, replaySource: record }, options, {
      routeRunner: async ({ mode, route }) => {
        replayCalls += 1;
        assert.equal(mode, "replay");
        return route.routeId === "private"
          ? { status: "completed", completed: true, httpAttempts: 0, actionCount: 7 }
          : { status: "blocked", completed: false, failureCode: "P3_CAPABILITY_COVERAGE_FAILED", httpAttempts: 0, actionCount: 4 };
      },
    });
    assert.deepEqual(replayed.routes.map((route) => route.status), ["completed", "blocked"]);
    assert.equal(replayed.httpAttempts, 0);
    assert.equal(replayed.strictReplayPassed, true);
    assert.equal(replayCalls, 2);
  } finally {
    if (previousGate === undefined) delete process.env.RUN_REAL_AI_JOURNEY;
    else process.env.RUN_REAL_AI_JOURNEY = previousGate;
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3 replay rejects fabricated completed status without a recorded route manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-fake-"));
  try {
    const protocolPath = join(root, "protocol.json");
    await runNarrativeP3Journey({ mode: "register", runId: "p3", protocolPath, outputDirectory: root }, options);
    writeFileSync(join(root, "routes.json"), JSON.stringify({ routes: [{ routeId: "private", status: "completed" }, { routeId: "public", status: "completed" }] }));
    await assert.rejects(
      runNarrativeP3Journey({ mode: "replay", runId: "p3", protocolPath, outputDirectory: join(root, "replay"), replaySource: root }, options),
      /P3_ROUTE_MANIFEST_INVALID/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3 live requires the explicit real-journey gate before creating a runner", async () => {
  const root = mkdtempSync(join(tmpdir(), "p3-script-gate-"));
  const previousGate = process.env.RUN_REAL_AI_JOURNEY;
  delete process.env.RUN_REAL_AI_JOURNEY;
  try {
    await assert.rejects(
      runNarrativeP3Journey({ mode: "live", runId: "p3", protocolPath: join(root, "protocol.json"), outputDirectory: root }, options, {
        routeRunner: async () => { throw new Error("RUNNER_MUST_NOT_BE_CREATED"); },
      }),
      /P3_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY/,
    );
  } finally {
    if (previousGate === undefined) delete process.env.RUN_REAL_AI_JOURNEY;
    else process.env.RUN_REAL_AI_JOURNEY = previousGate;
    rmSync(root, { recursive: true, force: true });
  }
});
