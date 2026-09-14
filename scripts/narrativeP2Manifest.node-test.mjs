import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createP2RouteManifest, openP2RouteManifest, p2ManifestGuard } from "./narrativeP2Manifest.mjs";
import { hashReplayValue } from "./narrativeP1Replay.mjs";

const hash = "a".repeat(64);
function fixture(stage = "A", budget = {}) {
  const directory = mkdtempSync(join(tmpdir(), "p2-manifest-"));
  let now = 1000;
  const input = { directory, stage, binding: { protocolVersion: "narrative-p2/v2", protocolHash: hash, codeFingerprint: hash, inputHash: hash, sourceHash: hash }, budget: { actions: 24, http: 200, wallClockMs: 1000, ...budget } };
  const store = createP2RouteManifest(input, { now: () => now });
  const mutate = (operation) => store.advance(p2ManifestGuard(store.read()), operation);
  return { directory, input, store, mutate, clock: value => { now = value; }, reopen: () => openP2RouteManifest(input, { now: () => now }) };
}
test("exclusive initialization and CAS preserve route identity and absolute deadline", () => {
  const f = fixture();
  const before = f.store.read();
  assert.throws(() => createP2RouteManifest(f.input), /P2_ROUTE_ALREADY_INITIALIZED/);
  const stale = p2ManifestGuard(before);
  f.mutate({ type: "start" });
  assert.throws(() => f.store.advance(stale, { type: "pause", status: "awaiting_review", reason: "topic", artifacts: { history: hash } }), /P2_MANIFEST_CAS/);
  assert.equal(f.reopen().read().deadline, 2000);
  assert.equal(f.reopen().read().routeAttemptId, before.routeAttemptId);
  f.clock(2000);
  assert.throws(() => f.mutate({ type: "reserve_action", interaction: { kind: "fixed_choice", choiceToken: "token" } }), /P2_DEADLINE_EXPIRED/);
});
test("action and transport reservations are durable, once only and cannot resume uncertain work", () => {
  const f = fixture(); f.mutate({ type: "start" });
  const action = f.mutate({ type: "reserve_action", interaction: { kind: "free_text", targetNpcId: "npc:1", text: "question" } });
  assert.match(action.pendingAction.actionId, /^[\da-f-]{36}$/);
  f.mutate({ type: "begin_action", actionId: action.pendingAction.actionId });
  const pending = f.mutate({ type: "reserve", kind: "transport", reservationId: "call-1:1", purpose: "scene_author", jobId: "job:1", epoch: 0 });
  assert.equal(f.reopen().read().counters.transport, 1);
  const reopened = f.reopen();
  assert.throws(() => reopened.advance(p2ManifestGuard(reopened.read()), { type: "settle", reservationId: "call-1:1", evidence: { tapeCursor: 1, artifactHash: hash } }), /P2_RESUME_REQUIRES_PAUSE/);
  assert.throws(() => f.mutate({ type: "pause", status: "awaiting_review", reason: "topic", artifacts: { history: hash } }), /P2_PENDING_OPERATION/);
  assert.throws(() => f.mutate({ type: "resume", actionId: action.pendingAction.actionId }), /P2_PENDING_OPERATION|P2_LIFECYCLE/);
  f.mutate({ type: "settle", reservationId: "call-1:1", evidence: { tapeCursor: 1, artifactHash: hash } });
  assert.throws(() => f.mutate({ type: "reserve", kind: "transport", reservationId: "call-1:1", purpose: "scene_author", jobId: "job:1", epoch: 0 }), /P2_RESERVATION_REUSED/);
  f.mutate({ type: "commit_action", actionId: action.pendingAction.actionId, gameRevision: 1, sourceHash: hash, evidence: { historyIds: ["history:1"], historyHash: hash, candidateCallIds: ["call-1"], jobIds: ["job:1"] } });
  assert.equal(f.store.read().steps[0].actionId, pending.pendingAction.actionId);
  assert.throws(() => f.mutate({ type: "commit_action", actionId: action.pendingAction.actionId, gameRevision: 2, sourceHash: hash }), /P2_ACTION_IDENTITY/);
});
test("safe review/UI resume binds revision, source, cursor and reserved UUID without renewing time", () => {
  const f = fixture("B"); f.mutate({ type: "start" });
  f.mutate({ type: "pause", status: "awaiting_review", reason: "topic", artifacts: { history: hash } });
  const guard = p2ManifestGuard(f.store.read());
  assert.throws(() => f.store.advance({ ...guard, tapeCursor: 1 }, { type: "resume" }), /P2_MANIFEST_CAS/);
  assert.throws(() => f.store.advance({ ...guard, sourceHash: "b".repeat(64) }, { type: "resume" }), /P2_MANIFEST_CAS/);
  f.mutate({ type: "resume" });
  const state = f.mutate({ type: "reserve_action", interaction: { kind: "free_text", targetNpcId: "npc:1", text: "recall" } });
  f.mutate({ type: "pause", status: "awaiting_ui", reason: "recall", artifacts: { checkpoint: hash } });
  assert.throws(() => f.mutate({ type: "resume", actionId: "wrong" }), /P2_ACTION_IDENTITY/);
  f.clock(1500);
  assert.equal(f.mutate({ type: "resume", actionId: state.pendingAction.actionId }).deadline, 2000);
});
test("manifest rollback, damaged journal and abandoned writer lock fail closed", () => {
  const f = fixture();
  const path = join(f.directory, "A.route-manifest.json");
  const old = readFileSync(path);
  f.mutate({ type: "start" });
  writeFileSync(path, old);
  assert.throws(() => f.reopen().read(), /P2_MANIFEST_CORRUPT/);
  const g = fixture();
  writeFileSync(join(g.directory, "A.route-manifest.lock"), "abandoned");
  assert.throws(() => g.mutate({ type: "start" }), /P2_MANIFEST_LOCKED/);
  const h = fixture();
  writeFileSync(join(h.directory, "A.route-manifest.audit.jsonl"), "partial");
  assert.throws(() => h.reopen().read(), /P2_MANIFEST_CORRUPT/);
});
test("per-job summary budget survives restart and counts reservation before publication", () => {
  const f = fixture(); f.mutate({ type: "start" });
  for (let n = 0; n < 2; n++) {
    f.mutate({ type: "reserve", kind: "summary_batch", reservationId: `batch:${n}`, purpose: "memory_summary", jobId: "job:1", epoch: 0, observerId: "player" });
    f.mutate({ type: "settle", reservationId: `batch:${n}`, evidence: { published: true, artifactHash: hash, sourceFingerprint: hash, observerId: "player", summaryRevision: n + 1, coveredThroughSequence: n * 10 + 9 } });
  }
  assert.equal(f.reopen().read().counters.batchUpdates, 2);
  assert.throws(() => f.mutate({ type: "reserve", kind: "summary_batch", reservationId: "batch:2", purpose: "memory_summary", jobId: "job:1", epoch: 0, observerId: "player" }), /P2_JOB_BUDGET_EXHAUSTED/);
  assert.equal(f.store.read().publications.length, 2);
});

test("fresh process can resume a safe pause but cannot take over an unpaused route", () => {
  const f = fixture(); f.mutate({ type: "start" });
  const reopened = f.reopen();
  assert.throws(() => reopened.advance(p2ManifestGuard(reopened.read()), { type: "open_audit" }), /P2_RESUME_REQUIRES_PAUSE/);
  f.mutate({ type: "pause", status: "awaiting_review", reason: "topic", artifacts: { history: hash } });
  reopened.advance(p2ManifestGuard(reopened.read()), { type: "resume" });
  assert.throws(() => f.mutate({ type: "open_audit" }), /P2_RESUME_REQUIRES_PAUSE/);
  assert.deepEqual(reopened.advance(p2ManifestGuard(reopened.read()), { type: "open_audit" }).auditStreams, ["S-short-0"]);
});

test("audit operation tampering and backward clocks fail closed", () => {
  const f = fixture(); f.mutate({ type: "start" });
  const path = join(f.directory, "A.route-manifest.audit.jsonl");
  writeFileSync(path, readFileSync(path, "utf8").replace('"type":"start"', '"type":"resume"'));
  assert.throws(() => f.store.read(), /P2_MANIFEST_CORRUPT/);
  const g = fixture(); g.clock(1500); g.mutate({ type: "start" }); g.clock(1400);
  assert.throws(() => g.mutate({ type: "open_audit" }), /P2_MANIFEST_CLOCK/);
});

test("summary HTTP and narrative HTTP caps are independent and failed reservations retain denominator", () => {
  const f = fixture(); f.mutate({ type: "start" });
  for (let n = 0; n < 8; n++) {
    f.mutate({ type: "reserve", kind: "summary_http", reservationId: `summary:${n}`, purpose: "memory_summary", jobId: "job:1", epoch: 0, observerId: "player" });
    f.mutate({ type: "settle", reservationId: `summary:${n}`, evidence: { artifactHash: hash, outcome: "failed" } });
  }
  assert.throws(() => f.mutate({ type: "reserve", kind: "summary_http", reservationId: "summary:8", purpose: "memory_summary", jobId: "job:1", epoch: 0, observerId: "player" }), /P2_JOB_BUDGET_EXHAUSTED/);
  for (let n = 0; n < 24; n++) {
    f.mutate({ type: "reserve", kind: "transport", reservationId: `author:${n}`, purpose: "scene_author", jobId: "job:1", epoch: 0 });
    f.mutate({ type: "settle", reservationId: `author:${n}`, evidence: { artifactHash: hash, tapeCursor: n + 1 } });
  }
  assert.throws(() => f.mutate({ type: "reserve", kind: "transport", reservationId: "author:24", purpose: "scene_author", jobId: "job:1", epoch: 0 }), /P2_JOB_BUDGET_EXHAUSTED/);
  assert.equal(f.store.read().counters.summaryHttp, 8);
  assert.equal(f.store.read().counters.transport, 24);
  assert.equal(f.store.read().publications.length, 0);
});

test("failed sealing after deadline preserves pending action and permanently prevents another attempt", () => {
  const f = fixture(); f.mutate({ type: "start" });
  const reserved = f.mutate({ type: "reserve_action", interaction: { kind: "fixed_choice", choiceToken: "choice" } });
  f.mutate({ type: "begin_action", actionId: reserved.pendingAction.actionId });
  assert.throws(() => f.mutate({ type: "pause", status: "awaiting_ui", reason: "recall", artifacts: { checkpoint: hash } }), /P2_PENDING_OPERATION/);
  f.clock(2100);
  const failed = f.mutate({ type: "seal_fail", reason: "deadline" });
  assert.equal(failed.pendingAction.actionId, reserved.pendingAction.actionId);
  assert.equal(failed.counters.actions, 1);
  assert.throws(() => f.mutate({ type: "start" }), /P2_DEADLINE_EXPIRED|P2_LIFECYCLE/);
  assert.throws(() => createP2RouteManifest(f.input), /P2_ROUTE_ALREADY_INITIALIZED/);
});

test("missing binding/checkpoint fields fail closed even with a recomputed envelope hash", () => {
  const f = fixture();
  const path = join(f.directory, "A.route-manifest.json");
  const envelope = JSON.parse(readFileSync(path, "utf8"));
  delete envelope.state.sourceHash;
  envelope.hash = hashReplayValue(envelope.state);
  writeFileSync(path, JSON.stringify(envelope));
  assert.throws(() => f.store.read(), /P2_MANIFEST_CORRUPT/);
  assert.throws(() => f.store.advance({}, { type: "start" }), /P2_MANIFEST_CORRUPT/);
});

test("route action, logical and transport ceilings are checked before execution", () => {
  const f = fixture("A", { actions: 1, http: 2 }); f.mutate({ type: "start" });
  const action = f.mutate({ type: "reserve_action", interaction: { kind: "fixed_choice", choiceToken: "choice" } }).pendingAction;
  f.mutate({ type: "begin_action", actionId: action.actionId });
  for (const kind of ["logical", "transport"]) {
    for (let n = 0; n < 2; n++) {
      f.mutate({ type: "reserve", kind, reservationId: `${kind}:${n}`, purpose: "scene_author", jobId: `job:${n}`, epoch: 0 });
      f.mutate({ type: "settle", reservationId: `${kind}:${n}`, evidence: { artifactHash: hash, ...(kind === "transport" ? { tapeCursor: n + 1 } : {}) } });
    }
    assert.throws(() => f.mutate({ type: "reserve", kind, reservationId: `${kind}:2`, purpose: "scene_author", jobId: "job:2", epoch: 0 }), /P2_HTTP_BUDGET_EXHAUSTED/);
  }
  f.mutate({ type: "commit_action", actionId: action.actionId, gameRevision: 1, sourceHash: hash, evidence: { historyHash: hash, historyIds: [], candidateCallIds: [], jobIds: [] } });
  assert.throws(() => f.mutate({ type: "reserve_action", interaction: { kind: "fixed_choice", choiceToken: "choice" } }), /P2_ACTION_BUDGET_EXHAUSTED/);
  assert.equal(f.store.read().counters.actions, 1);
});

test("actual frozen commit:digest code identity is preserved verbatim", () => {
  const f = fixture();
  const input = { ...f.input, directory: mkdtempSync(join(tmpdir(), "p2-code-binding-")), binding: { ...f.input.binding, codeFingerprint: `${"b".repeat(40)}:${hash}` } };
  const store = createP2RouteManifest(input);
  assert.equal(store.read().binding.codeFingerprint, input.binding.codeFingerprint);
  const changed = openP2RouteManifest({ ...input, binding: { ...input.binding, codeFingerprint: `different:${hash}` } });
  assert.throws(() => changed.read(), /P2_MANIFEST_CORRUPT/);
});
