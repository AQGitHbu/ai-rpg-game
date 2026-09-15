#!/usr/bin/env node
// Thin acceptance harness: the private route uses the real Next UI while the
// existing runner still owns its budget, source tape, commands and final gate.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical, hashReplayValue } from "./narrativeP1Replay.mjs";
import { projectRoot } from "./aiEnv.mjs";
import { parseNarrativeP3Args, runNarrativeP3Journey, validateNarrativeP3Args } from "./narrativeP3Journey.mjs";

export function createUiCommandGate({ getEntry, record, signal }) {
  let pending;
  let submitting = false;
  let aborted = signal?.aborted ?? false;
  const abort = () => { aborted = true; pending?.reject(new Error("BATCH_INTERRUPTED")); pending = undefined; };
  signal?.addEventListener("abort", abort, { once: true });
  return {
    wait(command, traceId) {
      if (aborted) return Promise.reject(new Error("BATCH_INTERRUPTED"));
      if (pending) return Promise.reject(new Error("UI_COMMAND_ALREADY_PENDING"));
      record({ kind: "expected_command", command });
      return new Promise((resolveTurn, reject) => { pending = { command, traceId, resolve: resolveTurn, reject }; });
    },
    async submit(command) {
      const expected = pending;
      if (aborted || submitting || expected === undefined || command.expectedRevision !== expected.command.expectedRevision
        || canonical(command.interaction) !== canonical(expected.command.interaction)) {
        return { ok: false, code: "INVALID_REQUEST", feedback: "该操作不属于当前验收步骤。" };
      }
      submitting = true;
      try {
        const result = await getEntry().performTurn(expected.command, expected.traceId);
        record({ kind: "browser_action", browserActionId: command.actionId, command: expected.command, ok: result.ok, revision: result.revision });
        pending = undefined;
        expected.resolve(result);
        return result;
      } catch (error) { pending = undefined; expected.reject(error); throw error; }
      finally { submitting = false; }
    },
    close() { abort(); signal?.removeEventListener("abort", abort); },
  };
}

export async function openP3UiDriver({ mode, route, artifactDirectory, signal, getEntry, readState }) {
  if (mode !== "live" || route.routeId !== "private") return undefined;
  const evidence = [];
  const path = resolve(artifactDirectory, "private.ui.json");
  const releasePath = resolve(artifactDirectory, "private.ui-reviewed");
  if (existsSync(path) || existsSync(releasePath)) throw new Error("UI_EVIDENCE_ALREADY_EXISTS");
  const record = (event) => { evidence.push(event); writeFileSync(path, JSON.stringify({ executor: "next_ui", evidence }, null, 2)); };
  const gate = createUiCommandGate({ getEntry, record, signal });
  let pendingRefresh;
  let seenNavigation = false;
  let refreshVerified = false;
  const symbol = Symbol.for("ai-rpg-game.server-entry-points");
  const previousEntry = globalThis[symbol];
  const wrapper = new Proxy({}, { get(_target, key) {
    if (key === "performTurn") return gate.submit;
    if (key === "createGame" || key === "clearDevelopmentCurrentGame")
      return async () => ({ ok: false, code: "INVALID_REQUEST" });
    if (key === "ensureNarrativeScene") return (options = {}, ...args) => options.retry === true
      ? Promise.resolve({ ok: false, code: "INVALID_REQUEST" })
      : getEntry().ensureNarrativeScene(options, ...args);
    if (key === "getCurrentGame") return async (...args) => {
      const result = await getEntry().getCurrentGame(...args);
      if (pendingRefresh !== undefined) {
        const afterHash = hashReplayValue(await readState());
        if (afterHash !== pendingRefresh.hash) throw new Error("UI_REFRESH_STATE_CHANGED");
        record({ kind: "refresh_verified", ...pendingRefresh });
        refreshVerified = true;
        pendingRefresh = undefined;
      }
      return result;
    };
    const value = getEntry()?.[key];
    return typeof value === "function" ? value.bind(getEntry()) : value;
  } });
  let app;
  let server;
  try {
    const next = (await import("next")).default;
    app = next({ dev: false, dir: projectRoot, hostname: "127.0.0.1", port: 3017 });
    await app.prepare();
    const handler = app.getRequestHandler();
    globalThis[symbol] = wrapper;
    server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/" && request.headers["sec-fetch-mode"] === "navigate") {
      const state = await readState();
      if (seenNavigation && state.ok && state.status === "active" && state.record.storyState.narrative.status === "ready"
        && state.record.worldState.ending === null && evidence.some((event) => event.kind === "browser_action" && event.ok)) {
        pendingRefresh = { revision: state.record.revision, hash: hashReplayValue(state) };
        record({ kind: "refresh_before", ...pendingRefresh });
      }
      seenNavigation = true;
    }
    return handler(request, response);
    });
    await new Promise((ready, reject) => { server.once("error", reject); server.listen(3017, "127.0.0.1", ready); });
    record({ kind: "ready", url: "http://127.0.0.1:3017", initialStateHash: hashReplayValue(await readState()) });
  } catch (error) {
    gate.close();
    globalThis[symbol] = previousEntry;
    if (server?.listening) await new Promise((done) => server.close(done));
    try { await app?.close(); } catch { /* Preserve the actual startup failure. */ }
    throw error;
  }
  console.log("P3 private UI ready: http://127.0.0.1:3017");
  return {
    performTurn: gate.wait,
    async finish(state) {
      record({ kind: "terminal", stateHash: hashReplayValue(state), refreshVerified });
      // Keep the terminal page available for actual browser evidence, within the
      // route's original absolute deadline; the controller releases this file.
      while (!existsSync(releasePath) && !signal?.aborted) await new Promise((done) => setTimeout(done, 500));
      if (signal?.aborted) throw new Error("BATCH_INTERRUPTED");
      if (!refreshVerified) throw new Error("UI_REFRESH_NOT_EXERCISED");
    },
    async close() {
      gate.close();
      globalThis[symbol] = previousEntry;
      await new Promise((done) => server.close(done));
      await app.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseNarrativeP3Args(process.argv.slice(2));
  if (args.mode !== "live") throw new Error("UI_EXECUTOR_REQUIRES_LIVE");
  const issue = validateNarrativeP3Args(args);
  if (issue) throw new Error(issue);
  if (process.env.RUN_REAL_AI_JOURNEY !== "1") throw new Error("P3_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY");
  const protocol = JSON.parse(readFileSync(resolve(args.protocol), "utf8"));
  const executors = { protocolHash: protocol.protocolHash, codeFingerprint: protocol.codeFingerprint,
    private: "next_ui", public: "api", port: 3017 };
  writeFileSync(resolve(args.output, "executors.json"), JSON.stringify({ ...executors, hash: hashReplayValue(executors) }, null, 2), { flag: "wx" });
  // Chosen before initialization; public remains API-driven from the same fork.
  const result = await runNarrativeP3Journey({ mode: args.mode, runId: args.runId, protocolPath: args.protocol, outputDirectory: args.output }, {}, {
    policyOverrides: { openUiDriver: openP3UiDriver },
  });
  console.log(`[narrative-p3-ui] ${JSON.stringify(result)}`);
  process.exitCode = result.passed ? 0 : 1;
}
