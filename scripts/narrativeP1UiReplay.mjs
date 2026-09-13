#!/usr/bin/env node
// Browser acceptance harness: real Next UI/routes and production game entrypoints,
// with recorded provider responses and explicit command identity adaptation.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { installTsHooks, freezeCurrentCodeIdentity, projectNarrativeP1GameSetup } from "./narrativeP1Journey.mjs";
import { canonical, hashReplayValue, createNarrativeP1ReplayRuntime } from "./narrativeP1Replay.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const index = value.indexOf("=");
  return [value.slice(2, index), value.slice(index + 1)];
}));
if (!args.source || !args.output) throw new Error("UI_REPLAY_REQUIRES_SOURCE_AND_OUTPUT");
const source = resolve(root, args.source);
const output = resolve(root, args.output);
if (output === source || output.startsWith(`${source}/`) || output.startsWith(`${source}\\`)) throw new Error("UI_REPLAY_OUTPUT_MUST_BE_INDEPENDENT");
const protocol = JSON.parse(readFileSync(resolve(source, "protocol.json"), "utf8"));
if (protocol.claimScope !== "diagnostic") throw new Error("UI_REPLAY_REQUIRES_DIAGNOSTIC_PROTOCOL");
const route = protocol.routes[0];
const steps = JSON.parse(readFileSync(resolve(source, `${route.routeId}.steps.json`), "utf8")).filter(step => step.actionId);
const databasePath = resolve(output, "ui.sqlite");
if (existsSync(databasePath)) throw new Error("UI_REPLAY_DATABASE_ALREADY_EXISTS");
mkdirSync(output, { recursive: true });
installTsHooks();
freezeCurrentCodeIdentity();
const { validateNarrativeP1Protocol } = await import("../src/game/application/testing/narrativeP1LiveJourney.ts");
const protocolIssues = validateNarrativeP1Protocol(protocol, process.env.NARRATIVE_P1_CODE_FINGERPRINT);
if (protocolIssues.length > 0) throw new Error(protocolIssues.join(","));
const { createServerGameEntryPoints } = await import("../src/game/application/server/compositionRoot.ts");
const { createSqliteGameRepository } = await import("../src/game/application/server/persistence/sqliteGameRepository.ts");
const { createServerSqliteClientFactory } = await import("../src/game/application/server/persistence/sqliteClient.ts");
const env = { NODE_ENV: "test", AI_MODEL: protocol.environment.model,
  AI_API_BASE_URL: protocol.environment.apiBaseUrl, AI_API_KEY: "offline-replay-no-network",
  AI_OUTPUT_FORMAT: "prompt_only", GAME_DB_PATH: databasePath,
  AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_DIR: resolve(output, "audit"),
  GAME_API_AUDIT: "full" };
let runtime;
let repository;
let entry;
let created = false;
let actionCount = 0;
let finished = false;
let semanticReplayComplete = false;
let reloadVerified = false;
let pendingReload;
const evidence = [];
const save = () => writeFileSync(resolve(output, "ui-evidence.json"), JSON.stringify({
  claimScope: "ui_replay_of_live_diagnostic", source, actionCount, finished, semanticReplayComplete,
  reloadVerified, httpAttempts: 0, evidence,
}, null, 2));
function compose(stream) {
  runtime = createNarrativeP1ReplayRuntime({ mode: "replay", directory: output, sourceDirectory: source, stream,
    binding: { protocolHash: protocol.protocolHash, codeFingerprint: protocol.code.fingerprint, inputHash: protocol.inputHash } });
  repository = createSqliteGameRepository({ clientFactory: createServerSqliteClientFactory(env) });
  entry = createServerGameEntryPoints({ ...env, AI_TEXT_AUDIT_RUN_ID: stream }, undefined, repository,
    { ...runtime.options, beforeNarrativeHttpAttempt: () => true });
}
compose(`${route.scenarioId}-opening`);
const wrapper = new Proxy({}, { get(_target, key) {
  if (key === "createGame") return async input => {
    if (created || canonical(input) !== canonical({ gameType: protocol.input.gameType,
      gameLength: protocol.input.gameLength, setup: projectNarrativeP1GameSetup(protocol.input) })) {
      throw new Error("UI_REPLAY_CREATE_INPUT_MISMATCH");
    }
    const result = await entry.createGame(input, `${route.scenarioId}-create`);
    runtime.state("opening", await repository.getCurrentGame());
    runtime.finish();
    if (!result.ok) throw new Error("UI_REPLAY_OPENING_FAILED");
    await entry.close();
    compose(route.routeId);
    created = true;
    evidence.push({ kind: "create", revision: result.revision }); save();
    return result;
  };
  if (key === "performTurn") return async command => {
    const expected = steps[actionCount];
    if (!created || !expected || command.expectedRevision !== expected.before.revision
      || canonical(command.interaction) !== canonical(expected.interaction)) throw new Error("UI_REPLAY_COMMAND_MISMATCH");
    runtime.state(`before:${actionCount}`, await repository.getCurrentGame());
    const result = await entry.performTurn({ ...command, actionId: expected.actionId }, `${route.routeId}-turn-${actionCount}`);
    evidence.push({ kind: "action", browserActionId: command.actionId, recordedActionId: expected.actionId,
      interaction: command.interaction, expectedRevision: command.expectedRevision, ok: result.ok, revision: result.revision });
    if (!result.ok) { save(); return result; }
    actionCount += 1; save();
    return result;
  };
  if (key === "ensureNarrativeScene") return (options = {}) => entry.ensureNarrativeScene(options, `${route.routeId}-${actionCount}-ensure-0`);
  if (key === "getCurrentGame") return async () => {
    const result = await entry.getCurrentGame(`${route.routeId}-${actionCount}`);
    if (pendingReload !== undefined) {
      const stateHash = hashReplayValue(await repository.getCurrentGame());
      if (stateHash !== pendingReload.stateHash) throw new Error("UI_REPLAY_RELOAD_STATE_MISMATCH");
      reloadVerified = true;
      evidence.push({ kind: "reload_verified", ...pendingReload }); pendingReload = undefined; save();
    }
    if (result.ok && result.view?.ending && !semanticReplayComplete) {
      runtime.state("ending", await repository.getCurrentGame());
      const matched = runtime.finish();
      if (actionCount !== steps.length) throw new Error("UI_REPLAY_UNCONSUMED_COMMANDS");
      semanticReplayComplete = true; finished = reloadVerified;
      evidence.push({ kind: "ending", revision: result.revision, ...matched }); save();
    }
    return result;
  };
  if (key === "ackPrologue") return async () => {
    const result = await entry.ackPrologue(`${route.routeId}-ack`);
    evidence.push({ kind: "ack_prologue", ...result }); save(); return result;
  };
  const value = entry[key];
  return typeof value === "function" ? value.bind(entry) : value;
} });
globalThis[Symbol.for("ai-rpg-game.server-entry-points")] = wrapper;
const next = (await import("next")).default;
const app = next({ dev: true, dir: root, hostname: "127.0.0.1", port: Number(args.port ?? 3016), webpack: true });
await app.prepare();
const handler = app.getRequestHandler();
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/" && request.headers["sec-fetch-mode"] === "navigate"
    && created && actionCount > 0 && actionCount < steps.length) {
    const state = await repository.getCurrentGame();
    if (state.ok && state.status === "active" && state.record.storyState.narrative.status !== "provider_pending") {
      pendingReload = { actionCount, revision: state.record.revision, stateHash: hashReplayValue(state) };
      evidence.push({ kind: "document_navigation", ...pendingReload }); save();
    }
  }
  return handler(request, response);
});
server.listen(Number(args.port ?? 3016), "127.0.0.1", () => console.log(`UI replay ready http://127.0.0.1:${args.port ?? 3016}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  save(); server.close(); await entry.close(); await app.close(); process.exit(0);
});
