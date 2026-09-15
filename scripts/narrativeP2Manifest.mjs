import { randomUUID } from "node:crypto";
import { openSync, closeSync, writeFileSync, readFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { canonical, hashReplayValue } from "./narrativeP1Replay.mjs";

const fail = code => { throw new Error(`P2_${code}`); };
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const counter = { logical: "logical", transport: "transport", summary_http: "summaryHttp", summary_batch: "batchUpdates" };
const emptyCounters = () => ({ actions: 0, logical: 0, transport: 0, summaryHttp: 0, batchUpdates: 0 });

/** Caller supplies every durable checkpoint field, never just a manifest revision. */
export function p2ManifestGuard(state) {
  return Object.fromEntries(["routeAttemptId", "manifestRevision", "gameRevision", "tapeCursor", "sourceHash"].map(key => [key, state[key]]));
}

function configuration(input) {
  if (!["A", "B"].includes(input.stage) || !["narrative-p2/v2", "narrative-p2/v3"].includes(input.binding?.protocolVersion)
    || !nonempty(input.binding.codeFingerprint) || ["protocolHash", "inputHash", "sourceHash"].some(key => !digest(input.binding[key]))
    || !["actions", "http", "wallClockMs"].every(key => integer(input.budget?.[key]) && input.budget[key] > 0)) fail("MANIFEST_CONFIGURATION");
  if (input.diagnostic && (input.stage !== 'B' || input.budget.actions !== 1 || input.budget.http !== 50 || input.budget.wallClockMs !== 2700000
    || !digest(input.diagnostic.parentCheckpointHash) || !digest(input.diagnostic.pairHash)
    || !['enabled', 'disabled'].includes(input.diagnostic.summaryMode)
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.diagnostic.actionId)
    || input.binding.sourceHash !== input.diagnostic.parentCheckpointHash)) fail('DIAGNOSTIC_CONFIGURATION');
  return { stage: input.stage, routeId: input.stage === "A" ? "S-short" : "M-medium", binding: clone(input.binding), budget: clone(input.budget),
    ...(input.diagnostic ? { diagnostic: clone(input.diagnostic) } : {}) };
}
function paths(input) {
  const base = resolve(input.directory, `${input.stage}.route-manifest`);
  return { manifest: `${base}.json`, audit: `${base}.audit.jsonl`, init: `${base}.init.json`, lock: `${base}.lock`, temporary: `${base}.pending.json` };
}
function durableWrite(path, value, flag) {
  const fd = openSync(path, flag);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
function artifacts(state, additions) {
  if (!additions || typeof additions !== "object" || Array.isArray(additions) || Object.keys(additions).length === 0) fail("ARTIFACT_REQUIRED");
  for (const [key, value] of Object.entries(additions)) {
    if (!nonempty(key) || !digest(value)) fail("ARTIFACT_REQUIRED");
    if (Object.hasOwn(state.artifacts, key) && state.artifacts[key] !== value) fail("ARTIFACT_REPLACEMENT");
    state.artifacts[key] = value;
  }
}
const pendingReservations = state => state.reservations.some(item => item.status === "reserved");
const idle = state => { if (pendingReservations(state) || state.pendingAction) fail("PENDING_OPERATION"); };
const running = state => { if (state.status !== "running") fail("LIFECYCLE"); };

/** P2-only state transitions. No I/O or provider execution happens in this reducer. */
function transition(state, operation, now, owner) {
  if (now >= state.deadline && operation.type !== "seal_fail") fail("DEADLINE_EXPIRED");
  if (state.status.startsWith("sealed_")) fail("LIFECYCLE");
  if (state.status === "running" && state.owner !== owner && operation.type !== "seal_fail") fail("RESUME_REQUIRES_PAUSE");
  switch (operation.type) {
    case "start":
      if (state.status !== "registered") fail("LIFECYCLE");
      state.status = "running";
      state.owner = owner;
      break;
    case "reserve_action":
      running(state); idle(state);
      if (state.counters.actions >= state.budget.actions) fail("ACTION_BUDGET_EXHAUSTED");
      if (!operation.interaction || !["fixed_choice", "free_text"].includes(operation.interaction.kind)) fail("ACTION_INVALID");
      if (operation.interaction.kind === "fixed_choice" ? !nonempty(operation.interaction.choiceToken)
        : !nonempty(operation.interaction.targetNpcId) || !nonempty(operation.interaction.text)) fail("ACTION_INVALID");
      // Only this function mints action identity. Reloads must use the existing UUID.
      state.pendingAction = { actionId: state.diagnostic?.actionId ?? randomUUID(), status: "reserved", interaction: clone(operation.interaction), expectedRevision: state.gameRevision, sourceHash: state.sourceHash, reservedAt: now };
      state.counters.actions++;
      break;
    case "begin_action":
      running(state);
      if (!state.pendingAction || state.pendingAction.actionId !== operation.actionId || state.pendingAction.status !== "reserved") fail("ACTION_IDENTITY");
      if (pendingReservations(state)) fail("PENDING_OPERATION");
      state.pendingAction.status = "executing";
      break;
    case "reserve": {
      running(state);
      const field = counter[operation.kind];
      if (!field || !nonempty(operation.reservationId) || !nonempty(operation.purpose) || !nonempty(operation.jobId) || !integer(operation.epoch)) fail("RESERVATION_INVALID");
      if (state.reservations.some(item => item.reservationId === operation.reservationId)) fail("RESERVATION_REUSED");
      if (operation.kind.startsWith("summary_") && (operation.purpose !== "memory_summary" || !nonempty(operation.observerId))) fail("RESERVATION_INVALID");
      const key = canonical([operation.jobId, operation.epoch]);
      if (state.diagnostic && Object.keys(state.jobs).some(existing => existing !== key)) fail('DIAGNOSTIC_JOB_BUDGET');
      const job = state.jobs[key] ?? { ...emptyCounters(), narrativeTransport: 0 };
      if ((field === "transport" && state.counters.transport >= state.budget.http) || (field === "logical" && state.counters.logical >= state.budget.http)) fail("HTTP_BUDGET_EXHAUSTED");
      if ((field === "summaryHttp" && job.summaryHttp >= 8) || (field === "batchUpdates" && job.batchUpdates >= 2)
        || (field === "transport" && operation.purpose !== "memory_summary" && job.narrativeTransport >= 24)) fail("JOB_BUDGET_EXHAUSTED");
      job[field]++; state.counters[field]++;
      if (field === "transport" && operation.purpose !== "memory_summary") job.narrativeTransport++;
      state.jobs[key] = job;
      state.reservations.push({ reservationId: operation.reservationId, kind: operation.kind, purpose: operation.purpose,
        jobId: operation.jobId, epoch: operation.epoch, ...(operation.observerId ? { observerId: operation.observerId } : {}),
        actionId: state.pendingAction?.actionId ?? null, status: "reserved", reservedAt: now });
      break;
    }
    case "settle": {
      running(state);
      const reservation = state.reservations.find(item => item.reservationId === operation.reservationId);
      if (!reservation || reservation.status !== "reserved") fail("RESERVATION_IDENTITY");
      if (!digest(operation.evidence?.artifactHash)) fail("RESERVATION_EVIDENCE");
      if (reservation.kind === "transport") {
        if (operation.evidence.tapeCursor !== state.tapeCursor + 1) fail("TAPE_CURSOR");
        state.tapeCursor = operation.evidence.tapeCursor;
      }
      if (reservation.kind === "summary_batch" && operation.evidence.published === true) {
        if (operation.evidence.observerId !== reservation.observerId || !digest(operation.evidence.sourceFingerprint)
          || !integer(operation.evidence.summaryRevision) || !integer(operation.evidence.coveredThroughSequence)) fail("PUBLICATION_EVIDENCE");
        // Settlement data may describe a publication, never replace its reserved identity.
        const { artifactHash, sourceFingerprint, summaryRevision, coveredThroughSequence } = operation.evidence;
        state.publications.push({ ...clone(reservation), artifactHash, sourceFingerprint, summaryRevision,
          coveredThroughSequence, published: true, status: "published" });
      }
      reservation.status = "settled"; reservation.evidence = clone(operation.evidence); reservation.settledAt = now;
      break;
    }
    case "commit_action": {
      running(state);
      if (!state.pendingAction || state.pendingAction.actionId !== operation.actionId || state.pendingAction.status !== "executing") fail("ACTION_IDENTITY");
      if (pendingReservations(state)) fail("PENDING_OPERATION");
      if (!integer(operation.gameRevision) || operation.gameRevision <= state.gameRevision || !digest(operation.sourceHash)) fail("ACTION_REVISION");
      const evidence = operation.evidence;
      if (!digest(evidence?.historyHash) || !["historyIds", "candidateCallIds", "jobIds"].every(key => Array.isArray(evidence[key]) && evidence[key].every(nonempty))) fail("ACTION_EVIDENCE");
      state.steps.push({ ...state.pendingAction, status: "committed", gameRevision: operation.gameRevision, sourceHash: operation.sourceHash, evidence: clone(evidence), committedAt: now });
      state.pendingAction = null; state.gameRevision = operation.gameRevision; state.sourceHash = operation.sourceHash;
      break;
    }
    case "checkpoint":
      running(state); idle(state);
      if (!integer(operation.gameRevision) || operation.gameRevision < state.gameRevision || !digest(operation.sourceHash)) fail("CHECKPOINT_INVALID");
      artifacts(state, operation.artifacts);
      state.gameRevision = operation.gameRevision; state.sourceHash = operation.sourceHash;
      break;
    case "open_audit":
      running(state);
      state.auditStreams.push(`${state.routeId}-${state.auditStreams.length}`);
      break;
    case "pause":
      running(state);
      if (!["awaiting_review", "awaiting_ui"].includes(operation.status) || !nonempty(operation.reason)) fail("LIFECYCLE");
      if (pendingReservations(state) || (state.pendingAction && (operation.status !== "awaiting_ui" || state.pendingAction.status !== "reserved" || state.reservations.some(item => item.actionId === state.pendingAction.actionId)))) fail("PENDING_OPERATION");
      if (operation.status === "awaiting_ui" && !state.pendingAction) fail("ACTION_IDENTITY");
      artifacts(state, operation.artifacts);
      state.status = operation.status; state.pause = { reason: operation.reason, at: now, artifacts: clone(operation.artifacts) };
      break;
    case "resume":
      if (!["awaiting_review", "awaiting_ui"].includes(state.status)) fail("LIFECYCLE");
      if (pendingReservations(state)) fail("PENDING_OPERATION");
      if (state.status === "awaiting_ui" ? operation.actionId !== state.pendingAction?.actionId : state.pendingAction !== null) fail("ACTION_IDENTITY");
      state.status = "running"; state.pause = null;
      state.owner = owner;
      break;
    case "seal_pass":
      // Admission/quality truth is a later task; this low-level mutation never admits B.
      if (state.status !== "awaiting_review") fail("LIFECYCLE");
      idle(state); artifacts(state, operation.artifacts); state.status = "sealed_pass";
      break;
    case "seal_fail":
      if (!nonempty(operation.reason)) fail("FAILURE_REASON_REQUIRED");
      if (operation.artifacts) artifacts(state, operation.artifacts);
      state.failure = operation.reason; state.status = "sealed_fail";
      break;
    default: fail("MANIFEST_OPERATION_INVALID");
  }
}

/** An exclusive init marker prevents a partial init or a deleted head from becoming a new attempt.
 * The append-only audit is written/fsynced BEFORE replacing the head. A crash between writes
 * leaves a mismatch (or a writer lock) and is intentionally not auto-recoverable. This is a
 * same-machine crash/CAS guard, not protection against an attacker replacing the whole directory. */
export function createP2RouteManifest(input, options = {}) {
  const config = configuration(input), p = paths(input), now = (options.now ?? Date.now)();
  if (!integer(now)) fail("MANIFEST_CLOCK");
  mkdirSync(resolve(input.directory), { recursive: true });
  const state = { formatVersion: 1, ...config, routeAttemptId: randomUUID(), status: "registered", initializedAt: now,
    deadline: now + config.budget.wallClockMs, lastMutationAt: now, owner: null, manifestRevision: 0, gameRevision: 0, tapeCursor: 0,
    sourceHash: config.binding.sourceHash, counters: emptyCounters(), pendingAction: null, reservations: [], jobs: {},
    steps: [], publications: [], auditStreams: [], artifacts: {}, pause: null };
  if (!Number.isSafeInteger(state.deadline)) fail("MANIFEST_CLOCK");
  try { durableWrite(p.init, JSON.stringify({ routeAttemptId: state.routeAttemptId, config }), "wx"); }
  catch (error) { if (error.code === "EEXIST") fail("ROUTE_ALREADY_INITIALIZED"); throw error; }
  const hash = hashReplayValue(state);
  const event = { revision: 0, previous: null, previousEventHash: null, hash, operation: { type: "initialize" }, at: now };
  const auditHash = hashReplayValue(event);
  durableWrite(p.audit, `${JSON.stringify({ ...event, eventHash: auditHash })}\n`, "wx");
  durableWrite(p.manifest, JSON.stringify({ hash, auditHash, state }), "wx");
  return openP2RouteManifest(input, options);
}

export function openP2RouteManifest(input, options = {}) {
  const config = configuration(input), p = paths(input), now = options.now ?? Date.now, owner = randomUUID();
  const read = () => {
    try {
      const marker = JSON.parse(readFileSync(p.init, "utf8"));
      const { hash, auditHash, state } = JSON.parse(readFileSync(p.manifest, "utf8"));
      const audit = readFileSync(p.audit, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      if (hash !== hashReplayValue(state) || state.formatVersion !== 1 || state.routeAttemptId !== marker.routeAttemptId
        || canonical(config) !== canonical(marker.config) || ["stage", "routeId", "binding", "budget", "diagnostic"].some(key => canonical(state[key]) !== canonical(config[key]))
        || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(state.routeAttemptId)
        || !["registered", "running", "awaiting_review", "awaiting_ui", "sealed_pass", "sealed_fail"].includes(state.status)
        || !["manifestRevision", "gameRevision", "tapeCursor", "initializedAt", "lastMutationAt", "deadline"].every(key => integer(state[key]))
        || !digest(state.sourceHash) || !Object.keys(emptyCounters()).every(key => integer(state.counters?.[key]))
        || !["steps", "reservations", "publications", "auditStreams"].every(key => Array.isArray(state[key]))
        || !state.jobs || !state.artifacts || !(state.pendingAction === null || nonempty(state.pendingAction?.actionId))
        || state.deadline !== state.initializedAt + config.budget.wallClockMs || state.lastMutationAt !== audit.at(-1).at
        || audit.length !== state.manifestRevision + 1 || audit.at(-1).hash !== hash || audit.at(-1).eventHash !== auditHash
        || audit.some(({ eventHash, ...event }, index) => eventHash !== hashReplayValue(event) || event.revision !== index
          || event.previous !== (index === 0 ? null : audit[index - 1].hash)
          || event.previousEventHash !== (index === 0 ? null : audit[index - 1].eventHash))) fail("MANIFEST_CORRUPT");
      return clone(state);
    } catch { fail("MANIFEST_CORRUPT"); }
  };
  return {
    read,
    advance(expected, operation) {
      let lock;
      try { lock = openSync(p.lock, "wx"); } catch (error) { if (error.code === "EEXIST") fail("MANIFEST_LOCKED"); throw error; }
      let writing = false;
      try {
        const state = read();
        if (canonical(expected) !== canonical(p2ManifestGuard(state))) fail("MANIFEST_CAS");
        const previous = hashReplayValue(state), time = now();
        if (!integer(time) || time < state.lastMutationAt) fail("MANIFEST_CLOCK");
        transition(state, operation, time, owner);
        state.lastMutationAt = time;
        state.manifestRevision++;
        const hash = hashReplayValue(state);
        const event = { revision: state.manifestRevision, previous, previousEventHash: JSON.parse(readFileSync(p.manifest, "utf8")).auditHash, hash, operation, at: time };
        const auditHash = hashReplayValue(event);
        writing = true;
        durableWrite(p.temporary, JSON.stringify({ hash, auditHash, state }), "wx");
        durableWrite(p.audit, `${JSON.stringify({ ...event, eventHash: auditHash })}\n`, "a");
        renameSync(p.temporary, p.manifest);
        writing = false;
        return clone(state);
      } finally {
        closeSync(lock);
        // Preserve lock after uncertain writes. Never discard or retry such a route silently.
        if (!writing) unlinkSync(p.lock);
      }
    },
    get interrupted() { return existsSync(p.lock) || existsSync(p.temporary); },
  };
}
