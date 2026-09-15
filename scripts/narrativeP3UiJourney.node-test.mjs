import assert from "node:assert/strict";
import test from "node:test";
import { createUiCommandGate } from "./narrativeP3UiJourney.mjs";

test("UI submits the displayed frozen interaction once through the existing production entry", async () => {
  const evidence = [];
  const calls = [];
  let settle;
  const entry = { performTurn: (...args) => { calls.push(args); return new Promise((done) => { settle = done; }); } };
  const gate = createUiCommandGate({ getEntry: () => entry, record: (event) => evidence.push(event) });
  const command = { actionId: "private-action-6", expectedRevision: 12, interaction: { kind: "fixed_choice", choiceToken: "opaque-investigation" } };
  const waited = gate.wait(command, "private-turn-6");
  assert.equal((await gate.submit({ ...command, expectedRevision: 11 })).ok, false);
  assert.equal((await gate.submit({ ...command, interaction: { ...command.interaction, choiceToken: "another" } })).ok, false);
  assert.equal(calls.length, 0);
  const submitted = gate.submit({ ...command, actionId: "browser-uuid" });
  assert.equal((await gate.submit(command)).ok, false);
  settle({ ok: true, revision: 13 });
  assert.deepEqual(await submitted, { ok: true, revision: 13 });
  assert.deepEqual(await waited, { ok: true, revision: 13 });
  assert.deepEqual(calls, [[command, "private-turn-6"]]);
  assert.equal((await gate.submit(command)).ok, false);
  assert.equal(evidence[1].browserActionId, "browser-uuid");
  gate.close();
});

test("UI waiting uses the existing abort deadline and cannot submit after it", async () => {
  const controller = new AbortController();
  let calls = 0;
  const gate = createUiCommandGate({ getEntry: () => ({ performTurn: async () => { calls += 1; } }), record: () => {}, signal: controller.signal });
  const command = { actionId: "private-action-6", expectedRevision: 12, interaction: { kind: "free_text", targetNpcId: "npc_1", text: "先查证。" } };
  const waited = gate.wait(command, "trace");
  const rejection = assert.rejects(waited, /BATCH_INTERRUPTED/);
  controller.abort();
  await rejection;
  assert.equal((await gate.submit(command)).ok, false);
  await assert.rejects(gate.wait(command, "trace"), /BATCH_INTERRUPTED/);
  assert.equal(calls, 0);
  gate.close();
});
