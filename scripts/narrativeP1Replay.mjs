import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export const hashReplayValue = value => createHash("sha256").update(canonical(value)).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));

/** Each stream is one opening or route. Sources, retries, approval and SQLite remain production code. */
export function createNarrativeP1ReplayRuntime({ mode, directory, sourceDirectory = directory, stream, binding, auditFiles }) {
  const path = resolve(directory, `${stream}.runtime.json`);
  let tape = { version: 1, stream, ...(binding ? { binding } : {}), identities: {}, times: {}, calls: [], states: [] };
  const auditManifest = (root, files) => {
    const calls = [];
    const manifests = files.map(file => {
      if (file.includes("..") || file.startsWith("/") || file.includes(":")) throw new Error("REPLAY_AUDIT_INVALID");
      const bytes = readFileSync(resolve(root, file));
      let previous = 0;
      for (const line of bytes.toString("utf8").split(/\r?\n/).filter(Boolean)) {
        const event = JSON.parse(line);
        if (!Number.isInteger(event.sequence) || event.sequence !== previous + 1 || typeof event.timestamp !== "string" || !["ai_call", "game_api", "story_text"].includes(event.kind)) throw new Error("REPLAY_AUDIT_INVALID");
        previous = event.sequence;
        if (event.kind === "ai_call") calls.push(event);
      }
      return { file, hash: createHash("sha256").update(bytes).digest("hex") };
    });
    if (calls.length !== tape.calls.length) throw new Error("REPLAY_AUDIT_INVALID");
    const identities = new Set();
    calls.forEach((call, index) => {
      const expected = tape.calls[index];
      const key = `${call.callId}:${call.attempt}`;
      if (identities.has(key) || call.callId !== expected.request.callId || call.attempt !== expected.request.attempt || call.role !== expected.request.role || canonical(call.input.messages) !== canonical(expected.request.messages) || canonical(call.output) !== canonical(expected.output)) throw new Error("REPLAY_AUDIT_INVALID");
      identities.add(key);
    });
    return manifests;
  };
  if (mode === "replay") {
    try {
      const envelope = JSON.parse(readFileSync(resolve(sourceDirectory, `${stream}.runtime.json`), "utf8"));
      if (envelope.hash !== hashReplayValue(envelope.tape) || envelope.tape.version !== 1 || envelope.tape.stream !== stream) throw new Error();
      tape = envelope.tape;
    } catch { throw new Error("REPLAY_IDENTITY_TAPE_MISSING"); }
    if (binding && canonical(tape.binding) !== canonical(binding)) throw new Error("REPLAY_BINDING_MISMATCH");
    if (binding) {
      try {
        if (!Array.isArray(tape.audit) || tape.audit.length === 0 || canonical(auditManifest(sourceDirectory, tape.audit.map(entry => entry.file))) !== canonical(tape.audit)) throw new Error();
      } catch { throw new Error("REPLAY_AUDIT_INVALID"); }
    }
  }
  let cursor = 0;
  let stateCursor = 0;
  const comparisons = [];
  let failure;
  const usedTimes = new Set();
  const usedIdentities = new Set();
  const fail = code => { failure = code; throw new Error(code); };
  const persist = () => {
    if (mode === "replay") return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, JSON.stringify({ hash: hashReplayValue(tape), tape }, null, 2));
  };
  const keyed = (collection, used, key, produce) => {
    used.add(key);
    if (!(key in collection)) {
      if (mode === "replay") return fail("REPLAY_RUNTIME_TAPE_MISMATCH");
      collection[key] = produce(); persist();
    }
    return collection[key];
  };
  return {
    options: {
      identity: kind => keyed(tape.identities, usedIdentities, kind, randomUUID),
      domainTime: key => keyed(tape.times, usedTimes, key, () => new Date().toISOString()),
      aiRuntime: {
        offline: mode === "replay",
        nextCallId: () => mode === "replay" ? (tape.calls[cursor]?.request.callId ?? fail("REPLAY_RESPONSE_MISSING")) : randomUUID(),
        attempt: async (request, send) => {
          if (mode === "replay") {
            const recorded = tape.calls[cursor];
            if (!recorded) return fail("REPLAY_RESPONSE_MISSING");
            if (canonical(recorded.request) !== canonical(request)) return fail("REPLAY_REQUEST_MISMATCH");
            cursor += 1;
            return clone(recorded.output);
          }
          const output = await send();
          tape.calls.push({ request: clone(request), output: clone(output) });
          cursor += 1; persist();
          return output;
        },
      },
    },
    get failureCode() { return failure; },
    get attempts() { return cursor; },
    state(key, value) {
      // Unknown fields stay semantic. Only transient lease identity/expiry are projected separately.
      const runtime = [];
      const semantic = (v, at = "") => {
        if (Array.isArray(v)) return v.map((x, i) => semantic(x, `${at}/${i}`));
        if (!v || typeof v !== "object") return v;
        return Object.fromEntries(Object.entries(v).map(([k, x]) => {
          if ((k === "leaseId" || k === "leaseExpiresAt") && at.endsWith("/attempt")) { runtime.push({ path: `${at}/${k}`, value: x }); return [k, null]; }
          return [k, semantic(x, `${at}/${k}`)];
        }));
      };
      const projected = semantic(value);
      if (mode === "replay") {
        const expected = tape.states[stateCursor++];
        if (!expected || expected.key !== key || canonical(expected.semantic) !== canonical(projected)) return fail("REPLAY_SEMANTIC_MISMATCH");
        comparisons.push({ key, semanticHash: hashReplayValue(projected), recordedRuntime: expected.runtime, replayedRuntime: runtime });
      } else { tape.states.push({ key, semantic: clone(projected), runtime }); stateCursor += 1; persist(); }
    },
    finish() {
      if (failure) throw new Error(failure);
      if (mode === "replay" && (cursor !== tape.calls.length || stateCursor !== tape.states.length || usedTimes.size !== Object.keys(tape.times).length || usedIdentities.size !== Object.keys(tape.identities).length)) fail("REPLAY_RESPONSE_EXTRA");
      if (mode !== "replay" && binding) {
        try { tape.audit = auditManifest(directory, typeof auditFiles === "function" ? auditFiles() : auditFiles ?? []); }
        catch { fail("REPLAY_AUDIT_INVALID"); }
      }
      persist();
      if (mode === "replay") { mkdirSync(directory, { recursive: true }); writeFileSync(resolve(directory, `${stream}.comparison.json`), JSON.stringify({ passed: true, comparisons }, null, 2)); }
      return { replayedTransportAttempts: mode === "replay" ? cursor : 0, matchedStates: stateCursor };
    },
  };
}
