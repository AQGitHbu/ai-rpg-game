import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { canonical, hashReplayValue } from "./narrativeP1Replay.mjs";
import { p2ManifestGuard } from "./narrativeP2Manifest.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw new Error(`P2_TAPE_${code}`); };
const purpose = context => context.purpose === "narrative_memory_summary" ? "memory_summary" : context.purpose;
const project = (value, at = "") => Array.isArray(value) ? value.map((x, i) => project(x, `${at}/${i}`))
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, x]) => [key,
    at.endsWith("/attempt") && ["leaseId", "leaseExpiresAt"].includes(key) ? null : project(x, `${at}/${key}`)])) : value;

/** P2-only immutable segments. A ready checkpoint ends one segment; reopening never
 * replays an uncertain send. The stage caller independently reads SQLite for checkpoint
 * and resolveAttempt; this runtime does not infer epoch or source from prompt text. */
export function createNarrativeP2SegmentRuntime({ mode, directory, sourceDirectory = directory, stage, segment,
  binding, manifest, checkpoint, routeAttemptId, resolveAttempt, auditFiles = () => [] }) {
  if (!["live", "replay"].includes(mode) || !["A", "B"].includes(stage) || !Number.isSafeInteger(segment) || segment < 0
    || binding?.protocolVersion !== "narrative-p2/v2" || (mode === "replay" && !routeAttemptId)) fail("CONFIGURATION");
  routeAttemptId ??= manifest.read().routeAttemptId;
  const filename = index => `${stage}.segment-${index}.json`;
  const root = mode === "replay" ? sourceDirectory : directory;
  const read = index => {
    let envelope;
    try { envelope = JSON.parse(readFileSync(resolve(root, filename(index)), "utf8")); } catch { fail("MISSING"); }
    if (envelope.hash !== hashReplayValue(envelope.tape) || envelope.tape.version !== "narrative-p2/v2"
      || envelope.tape.routeAttemptId !== routeAttemptId || envelope.tape.segment !== index || envelope.tape.stage !== stage || !envelope.tape.closed
      || canonical(envelope.tape.binding) !== canonical(binding)) fail("BINDING");
    return envelope;
  };
  let previous = null;
  for (let index = 0; index < segment; index++) {
    const current = read(index);
    if (current.tape.previousHash !== (previous?.hash ?? null)
      || current.tape.startCursor !== (previous?.tape.endCursor ?? 0)) fail("CHAIN");
    previous = current;
  }
  let tape = { version: "narrative-p2/v2", stage, segment, binding, routeAttemptId, previousHash: previous?.hash ?? null,
    startCursor: previous?.tape.endCursor ?? 0, endCursor: previous?.tape.endCursor ?? 0,
    identities: previous?.tape.identities ?? {}, times: previous?.tape.times ?? {}, usedIdentities: [], usedTimes: [],
    events: [], calls: [], states: [], closed: false };
  const advance = operation => checked(() => manifest.advance(p2ManifestGuard(manifest.read()), operation));
  if (mode === "replay") {
    tape = read(segment).tape;
    if (tape.previousHash !== (previous?.hash ?? null) || tape.startCursor !== (previous?.tape.endCursor ?? 0)) fail("CHAIN");
  } else {
    const state = manifest.read();
    if (state.status !== "running" || state.pendingAction || state.reservations.some(r => r.status === "reserved")
      || canonical(p2ManifestGuard(state)) !== canonical(checkpoint) || state.tapeCursor !== tape.startCursor
      || (previous && state.artifacts[`tape-segment-${segment - 1}`] !== previous.hash)) fail("CHECKPOINT");
  }
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, filename(segment));
  const persist = initial => {
    if (mode === "replay") return;
    const pending = `${path}.pending`;
    const fd = openSync(initial ? path : pending, "wx");
    try { writeFileSync(fd, JSON.stringify({ hash: hashReplayValue(tape), tape }, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    if (!initial) renameSync(pending, path);
  };
  if (mode === "live") persist(true);
  let cursor = 0, stateCursor = 0, eventCursor = 0, failure, finished = false;
  const checked = fn => { try { return fn(); } catch (error) { failure = error.message; throw error; } };
  const event = (kind, value) => checked(() => {
    const next = { kind, value: clone(value) };
    if (mode === "replay") {
      if (canonical(tape.events[eventCursor++]) !== canonical(next)) fail("EVENT_MISMATCH");
    } else { tape.events.push(next); persist(); }
    return hashReplayValue(next);
  });
  const reserve = (kind, metadata) => {
    const reservationId = randomUUID();
    advance({ type: "reserve", kind, reservationId, ...metadata });
    return (value, evidence = {}) => {
      const artifactHash = event("settlement", { kind, metadata, value });
      advance({ type: "settle", reservationId, evidence: { ...evidence, artifactHash } });
    };
  };
  const metadataFor = async context => {
    try {
      const identity = await resolveAttempt(context);
      if (!identity || identity.jobId !== context.jobId || !Number.isSafeInteger(identity.epoch) || identity.epoch < 0) fail("JOB_IDENTITY");
      return { jobId: identity.jobId, epoch: identity.epoch, purpose: purpose(context) };
    } catch (error) { failure = error.message; throw error; }
  };
  const keyed = (collection, used, key, produce) => checked(() => {
    if (!used.includes(key)) used.push(key);
    if (!(key in collection)) { if (mode === "replay") fail("IDENTITY_MISSING"); collection[key] = produce(); persist(); }
    return collection[key];
  });
  const usedIdentities = [], usedTimes = [];
  const audit = (auditRoot, files) => {
    const calls = [];
    const hashes = files.map(file => {
      if (file.includes("..") || file.startsWith("/") || file.includes(":")) fail("AUDIT_PATH");
      const bytes = readFileSync(resolve(auditRoot, file));
      let sequence = 0;
      for (const line of bytes.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        const item = JSON.parse(line);
        if (item.sequence !== ++sequence || typeof item.timestamp !== "string") fail("AUDIT_SEQUENCE");
        if (item.kind === "ai_call") calls.push(item);
      }
      return { file, hash: createHash("sha256").update(bytes).digest("hex") };
    });
    if (calls.length !== tape.calls.length) fail("AUDIT_CALLS");
    calls.forEach((call, i) => {
      const expected = tape.calls[i];
      if (call.callId !== expected.request.callId || call.attempt !== expected.request.attempt || call.role !== expected.request.role
        || canonical(call.input.messages) !== canonical(expected.request.messages) || canonical(call.output) !== canonical(expected.output)) fail("AUDIT_CALLS");
    });
    return hashes;
  };
  if (mode === "replay") {
    if (!Array.isArray(tape.auditStreamIds) || tape.auditStreamCount !== (previous?.tape.auditStreamCount ?? 0) + tape.auditStreamIds.length
      || canonical(tape.audit.map(item => item.file)) !== canonical(tape.auditStreamIds.map(id => `audit/${id}/events.jsonl`))
      || canonical(audit(root, tape.audit.map(item => item.file))) !== canonical(tape.audit)) fail("AUDIT_HASH");
  }
  const runtime = {
    options: {
      identity: key => keyed(tape.identities, usedIdentities, key, randomUUID),
      domainTime: key => keyed(tape.times, usedTimes, key, () => new Date().toISOString()),
      beforeNarrativeRequest: async input => {
        const metadata = await metadataFor(input.auditContext);
        const settle = mode === "live" ? reserve("logical", metadata) : value => event("settlement", { kind: "logical", metadata, value });
        return async result => settle(result);
      },
      memoryPreparationHooks: { reserve: async input => {
        const { kind, sourceFingerprint, ...identity } = input;
        const metadata = { ...identity, purpose: "memory_summary" };
        const settle = mode === "live" ? reserve(kind, metadata) : value => event("settlement", { kind, metadata, value });
        return async result => settle({ sourceFingerprint, ...result }, result.published ? {
          published: true, observerId: input.observerId, sourceFingerprint: result.state.coveredSourceFingerprint,
          summaryRevision: result.state.summaryRevision, coveredThroughSequence: result.state.coveredThroughSequence,
        } : { published: false });
      } },
      aiRuntime: {
        offline: mode === "replay",
        nextCallId: () => mode === "replay" ? tape.calls[cursor]?.request.callId ?? fail("RESPONSE_MISSING") : randomUUID(),
        attempt: async (request, send) => {
          try {
            if (finished || failure) fail("CLOSED");
            const metadata = await metadataFor(request.context);
            if (mode === "replay") {
              event("transport-request", request);
              const expected = tape.calls[cursor++];
              if (!expected || canonical(expected.request) !== canonical(request)) fail("REQUEST_MISMATCH");
              event("settlement", { kind: "transport", metadata, value: expected });
              return clone(expected.output);
            }
            const settle = reserve("transport", metadata);
            event("transport-request", request);
            // The reservation and complete request are durable before send; an exception leaves it pending.
            const output = await send();
            const call = { request: clone(request), output: clone(output) };
            tape.calls.push(call); tape.endCursor++; cursor++; persist();
            settle(call, { tapeCursor: tape.endCursor });
            return output;
          } catch (error) { failure = error.message; throw error; }
        },
      },
    },
    get attempts() { return cursor; },
    get failureCode() { return failure; },
    state(key, value) { checked(() => {
      const next = { key, semantic: project(value) };
      if (mode === "replay") { if (canonical(tape.states[stateCursor++]) !== canonical(next)) fail("SEMANTIC_MISMATCH"); }
      else { tape.states.push(clone(next)); stateCursor++; persist(); }
    }); },
    finish(readyCheckpoint) { return checked(() => {
      if (failure || finished) fail("CLOSED");
      if (mode === "replay") {
        if (cursor !== tape.calls.length || stateCursor !== tape.states.length || eventCursor !== tape.events.length
          || canonical(usedIdentities) !== canonical(tape.usedIdentities) || canonical(usedTimes) !== canonical(tape.usedTimes)) fail("EXTRA");
      } else {
        const allStreams = manifest.read().auditStreams;
        tape.auditStreamCount = allStreams.length;
        tape.auditStreamIds = allStreams.slice(previous?.tape.auditStreamCount ?? 0);
        const files = auditFiles();
        if (canonical(files) !== canonical(tape.auditStreamIds.map(id => `audit/${id}/events.jsonl`))) fail("AUDIT_STREAMS");
        tape.audit = audit(directory, files); tape.usedIdentities = usedIdentities; tape.usedTimes = usedTimes;
        tape.closed = true; persist();
        // Closing does not pause or authorize review. The caller does so after this checkpoint.
        manifest.advance(readyCheckpoint, { type: "checkpoint", gameRevision: readyCheckpoint.gameRevision,
          sourceHash: readyCheckpoint.sourceHash, artifacts: { [`tape-segment-${segment}`]: hashReplayValue(tape) } });
      }
      finished = true;
      return { hash: hashReplayValue(tape), tapeCursor: tape.endCursor, matchedStates: stateCursor,
        replayedTransportAttempts: mode === "replay" ? cursor : 0 };
    }); },
  };
  return runtime;
}
