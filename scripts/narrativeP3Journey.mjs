#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { installTsHooks, freezeCurrentCodeIdentity, createProductionRouteRunner, waitForNarrativeP1Generation } from "./narrativeP1Journey.mjs";
import { currentStoryInteractions, findOfferedStoryDelivery, offeredProductionChoices, selectProductionChoice } from "./narrativeP1Choices.mjs";
import { projectRoot, readAiEnv } from "./aiEnv.mjs";

export const NARRATIVE_P3_PROTOCOL_VERSION = "narrative-p3/v1";

export function parseNarrativeP3Args(argv) {
  const result = { mode: "replay", runId: "", protocol: "", output: "", replaySource: "" };
  const keys = { mode: "mode", "run-id": "runId", protocol: "protocol", output: "output", "replay-source": "replaySource" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error("INVALID_ARGUMENT");
    const equal = argument.indexOf("=");
    const key = equal >= 0 ? argument.slice(2, equal) : argument.slice(2);
    if (!(key in keys)) throw new Error("UNKNOWN_ARGUMENT");
    result[keys[key]] = equal >= 0 ? argument.slice(equal + 1) : argv[++index] ?? "";
  }
  return result;
}

export function validateNarrativeP3Args(args) {
  if (!["register", "live", "replay"].includes(args?.mode)) return "INVALID_MODE";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(args?.runId ?? "")) return "INVALID_RUN_ID";
  if (!args?.protocol?.trim()) return "MISSING_PROTOCOL";
  if (!args?.output?.trim()) return "MISSING_OUTPUT";
  if (args.mode === "replay" && args.replaySource !== undefined && !args.replaySource.trim()) return "MISSING_REPLAY_SOURCE";
  return null;
}

export function freezeP3CodeIdentity() {
  for (const args of [["rev-parse", "HEAD"], ["diff", "HEAD", "--binary", "--no-ext-diff", "--", "src", "scripts"], ["ls-files", "--others", "--exclude-standard", "-z", "--", "src", "scripts"]]) {
    if (spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true }).status !== 0) throw new Error("P3_CODE_IDENTITY_UNAVAILABLE");
  }
  freezeCurrentCodeIdentity();
  if (!/^[a-f0-9]{40}$/.test(process.env.GIT_COMMIT ?? "")) throw new Error("P3_CODE_IDENTITY_UNAVAILABLE");
  const hash = createHash("sha256").update(process.env.NARRATIVE_P1_CODE_FINGERPRINT ?? "").update(process.version);
  for (const file of ["package.json", "package-lock.json", "tsconfig.json", ".ai-game-foundation.json"]) {
    hash.update(file);
    if (existsSync(resolve(projectRoot, file))) hash.update(readFileSync(resolve(projectRoot, file)));
  }
  return `${process.env.GIT_COMMIT}:${hash.digest("hex")}`;
}

function configuredEnvironment(mode, protocolPath) {
  if (mode === "replay") {
    const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
    return { ...process.env, AI_MODEL: protocol.environment.model, AI_API_BASE_URL: protocol.environment.apiBaseUrl,
      AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: String(protocol.environment.inputMaxEstimatedTokens), AI_API_KEY: "offline-replay-no-network" };
  }
  const source = resolve(projectRoot, ".env.local");
  const values = existsSync(source) ? readAiEnv(source) : new Map();
  const env = { ...process.env };
  for (const key of ["AI_MODEL", "AI_API_BASE_URL", "AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS", "AI_API_KEY"]) env[key] = process.env[key] ?? values.get(key)?.decoded;
  return env;
}

function p3RouteId(route) {
  return typeof route === "string" ? route : route?.routeId;
}

function eventLedger(input) {
  return input.state?.record?.worldState?.eventLedger ?? [];
}

function hasSuccessfulOperation(input, operation) {
  return input.performed?.has(operation) === true || eventLedger(input).some((event) => event.outcome === "success"
    && event.payload?.type === "story_interaction_resolved" && event.payload.operation === operation);
}

function actionOperation(input, choice) {
  const action = input.actionMap.get(choice.choiceToken);
  return action?.type === "talk"
    ? input.interactions.find((interaction) => interaction.id === action.interactionId)?.operation
    : undefined;
}

function findOperationChoice(input, operation) {
  return input.offeredChoices.find((choice) => actionOperation(input, choice) === operation
    && !input.performedActions.has(JSON.stringify(input.actionMap.get(choice.choiceToken))));
}

function investigationApproachForAction(input, action) {
  if (action?.type !== "investigate") return undefined;
  const fact = input.state?.record?.worldState?.worldFacts?.find((entry) => String(entry.factId) === String(action.factId));
  return fact?.investigationApproaches?.find((approach) => approach.approachId === action.approachId);
}

function investigationMatchesRoute(input, action, route, legacyApproachId) {
  const approach = investigationApproachForAction(input, action);
  if (approach !== undefined) {
    const hasWitness = (approach.witnessNpcIds ?? []).length > 0;
    return route === "public" ? hasWitness : !hasWitness;
  }
  return action?.approachId === legacyApproachId;
}

function fallbackP3Choice(input) {
  const selected = selectProductionChoice(input.view, "complete", input.actionMap, input.interactions,
    input.performed, input.performedActions, input.state.record.storyState.delivery, input.actionCount);
  if (selected === undefined) return undefined;
  const action = input.actionMap.get(selected.choiceToken);
  return input.performedActions.has(JSON.stringify(action)) ? undefined : selected;
}

export function selectNarrativeP3ProductionChoice(input) {
  const route = p3RouteId(input.route);
  const approachId = route === "private" ? "quiet" : "witnessed";
  const choices = input.offeredChoices ?? offeredProductionChoices(input.view);
  const context = { ...input, offeredChoices: choices };
  const hasInvestigationEvidence = eventLedger(context).some((event) => event.outcome === "success"
    && event.payload?.type === "fact_discovered" && event.payload.evidenceQuality !== undefined);
  const investigation = choices.find((choice) => {
    const action = context.actionMap.get(choice.choiceToken);
    return investigationMatchesRoute(context, action, route, approachId)
      && !context.performedActions.has(JSON.stringify(action));
  });
  if (investigation !== undefined) return investigation;
  if (!hasInvestigationEvidence) {
    if (choices.some((choice) => context.actionMap.get(choice.choiceToken)?.type === "investigate")) return undefined;
    return fallbackP3Choice(context);
  }

  if (!hasSuccessfulOperation(context, "share_known_fact")) {
    const share = findOperationChoice(context, "share_known_fact");
    if (share !== undefined) return share;
    if (route === "private") {
      const introduction = findOperationChoice(context, "request_introduction");
      if (introduction !== undefined) return introduction;
      const confidentiality = findOperationChoice(context, "promise_confidentiality");
      if (confidentiality !== undefined) return confidentiality;
    }
  }
  if (!hasSuccessfulOperation(context, "request_verification")) {
    const verification = findOperationChoice(context, "request_verification");
    if (verification !== undefined) return verification;
  }

  const delivery = findOfferedStoryDelivery(input.view, input.actionMap, input.state.record.storyState.delivery);
  if (delivery !== undefined && !context.performedActions.has(JSON.stringify(input.actionMap.get(delivery.choiceToken)))) return delivery;
  return fallbackP3Choice(context);
}

function p3RouteSatisfied({ route, endingState, performed = new Set(), steps = [] }) {
  if (!endingState?.ok || endingState.status !== "active") return false;
  const { worldState, storyState } = endingState.record;
  const ending = worldState.ending;
  if (storyState.narrative?.status !== "ready" || ending?.outcome !== "success") return false;
  const events = worldState.eventLedger;
  const endingReached = events.some((event) => event.outcome === "success" && event.payload?.type === "ending_reached"
    && event.payload.endingId === ending.endingId && event.payload.outcome === "success");
  const evidence = events.find((event) => event.outcome === "success" && event.payload?.type === "fact_discovered"
    && event.payload.evidenceQuality !== undefined);
  const witnessed = (evidence?.payload?.witnessNpcIds ?? []).length > 0;
  const approachMatchesRoute = p3RouteId(route) === "public" ? witnessed : !witnessed;
  const verified = events.some((event) => event.outcome === "success" && event.payload?.type === "story_interaction_resolved"
    && event.payload.operation === "request_verification");
  const delivered = storyState.delivery !== undefined && events.filter((event) => event.outcome === "success"
    && event.payload?.type === "item_given" && event.payload.itemId === storyState.delivery.itemId
    && event.payload.npcId === storyState.delivery.recipientNpcId).length === 1;
  const goalChanged = events.some((event) => event.outcome === "success" && event.payload?.type === "npc_goal_status_changed");
  const revisited = p3RouteId(route) !== "private" || events.some((event) => event.payload?.type === "location_visited"
    && events.some((previous) => previous.sequence < event.sequence && previous.payload?.type === "location_visited"
      && previous.payload.locationId === event.payload.locationId));
  const strategyConfirmed = p3RouteId(route) !== "private" || (performed.has("strategy_freeform_submitted")
    && steps.some((step, index) => step.interaction?.kind === "free_text"
      && steps.slice(index + 1).some((next) => next.ok && next.action?.type === "investigate")));
  return endingReached && evidence !== undefined && approachMatchesRoute && verified && delivered
    && goalChanged && revisited && strategyConfirmed;
}

/** Advance once to the first actual decision, then let the shared SQLite cache fork. */
export async function prepareNarrativeP3SharedSnapshot({ entry, repository, runtime, buildChoiceMap, signal, scenarioId }) {
  const performed = new Set();
  const performedActions = new Set();
  await entry.ackPrologue(`${scenarioId}-shared-ack`);
  for (let actionCount = 0; actionCount < 32; actionCount += 1) {
    const current = await waitForNarrativeP1Generation(entry, `${scenarioId}-shared-${actionCount}`, { signal });
    if (!current.ok || current.status !== "active" || current.view?.narrativeGeneration.status !== "idle")
      return { ok: false, code: current.code ?? "P3_SHARED_PREFIX_FAILED", actionCount };
    const state = await repository.getCurrentGame();
    if (!state.ok || state.status !== "active" || state.record.revision !== current.revision)
      return { ok: false, code: "ROUTE_STATE_MISMATCH", actionCount };
    const actionMap = buildChoiceMap(state.record.worldState, state.record.storyState, state.record.revision);
    const offeredChoices = offeredProductionChoices(current.view);
    const context = { state, view: current.view, actionMap, offeredChoices, performed, performedActions, actionCount,
      interactions: currentStoryInteractions(state.record.worldState) };
    const investigations = offeredChoices.map((choice) => actionMap.get(choice.choiceToken)).filter((action) => action?.type === "investigate");
    if (investigations.length > 0) {
      const validFork = investigations.some((action) => investigations.some((other) => other.factId === action.factId
        && investigationMatchesRoute(context, action, "private") && investigationMatchesRoute(context, other, "public")));
      runtime.state("investigation-fork", state);
      return { ok: validFork, code: validFork ? undefined : "P3_CAPABILITY_COVERAGE_FAILED", actionCount };
    }
    const choice = fallbackP3Choice(context);
    if (choice === undefined || current.view.ending !== null) return { ok: false, code: "P3_CAPABILITY_COVERAGE_FAILED", actionCount };
    runtime.state(`shared-before:${actionCount}`, state);
    const action = actionMap.get(choice.choiceToken);
    const result = await entry.performTurn({ actionId: `${scenarioId}-shared-${actionCount}`, expectedRevision: current.revision,
      interaction: { kind: "fixed_choice", choiceToken: choice.choiceToken } }, `${scenarioId}-shared-turn-${actionCount}`);
    if (!result.ok) return { ok: false, code: result.code, actionCount };
    const after = await repository.getCurrentGame();
    if (!after.ok || after.status !== "active" || after.record.storyState.turnNumber <= state.record.storyState.turnNumber)
      return { ok: false, code: "ROUTE_ACTION_NOT_SETTLED", actionCount };
    runtime.state(`shared-after:${actionCount}`, after);
    performedActions.add(JSON.stringify(action));
  }
  return { ok: false, code: "ROUTE_ACTION_BUDGET_EXHAUSTED", actionCount: 32 };
}

export function createNarrativeP3RoutePolicy() {
  return {
    actionLimit: 32,
    noChoiceFailureCode: "P3_CAPABILITY_COVERAGE_FAILED",
    prepareSharedSnapshot: prepareNarrativeP3SharedSnapshot,
    selectInteraction: ({ route, view, performed }) => {
      if (p3RouteId(route) !== "private" || performed.has("strategy_freeform_submitted")) return undefined;
      const npc = view.narrative.npcDialogues.find((dialogue) => dialogue.freeInputEnabled);
      if (npc === undefined) return undefined;
      return { kind: "free_text", targetNpcId: npc.npcId, text: "先查看原始记录，再决定怎么交付。" };
    },
    selectChoice: selectNarrativeP3ProductionChoice,
    routeSatisfied: p3RouteSatisfied,
  };
}

async function createP3ProductionRouteRunner(runtimeEnv, replaySource, protocol) {
  const binding = { protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, inputHash: protocol.inputHash, codeFingerprint: protocol.codeFingerprint };
  const p1Runner = await createProductionRouteRunner(runtimeEnv, undefined, replaySource, binding, undefined, createNarrativeP3RoutePolicy());
  return async ({ mode, route, outputDirectory, signal }) => {
    const budget = {
      used: 0,
      reserve: () => {
        if (budget.used >= route.budget.http) return false;
        budget.used += 1;
        return true;
      },
    };
    const controller = new AbortController();
    const stop = () => controller.abort();
    const timer = setTimeout(stop, route.budget.wallClockMs);
    timer.unref?.();
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    try {
      const result = await p1Runner({
        mode,
        route: { ...route, kind: route.routeId, scenarioId: route.scenarioId },
        setup: protocol.input,
        budget,
        artifactDirectory: outputDirectory,
        signal: controller.signal,
      });
      return {
        status: result.completed ? "completed" : "blocked",
        completed: result.completed === true,
        httpAttempts: Math.max(result.httpAttempts ?? 0, budget.used),
        actionCount: result.actionCount ?? 0,
        ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    }
  };
}

export async function runNarrativeP3Journey(input, options = {}, journeyOptions = {}) {
  const issue = validateNarrativeP3Args({ mode: input.mode, runId: input.runId, protocol: input.protocolPath, output: input.outputDirectory, replaySource: input.replaySource ?? "" });
  if (issue) throw new Error(issue);
  if (input.mode === "live" && process.env.RUN_REAL_AI_JOURNEY !== "1") throw new Error("P3_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY");
  installTsHooks();
  const codeFingerprint = options.codeFingerprint ?? freezeP3CodeIdentity();
  const { runNarrativeP3Journey: run, createNarrativeP3Protocol, readNarrativeP3Protocol, canonicalP3 } = await import("../src/game/application/testing/narrativeP3LiveJourney.ts");
  const env = options.environment ?? configuredEnvironment(input.mode, input.protocolPath);
  const environment = { model: env.AI_MODEL?.trim() ?? "", apiBaseUrl: env.AI_API_BASE_URL?.trim() ?? "", inputMaxEstimatedTokens: Number(env.AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS ?? "64000") };
  const deps = { environment, codeFingerprint };
  if (input.mode === "register") return run({ mode: input.mode, runId: input.runId, protocolPath: input.protocolPath, outputDirectory: input.outputDirectory }, deps);
  const protocol = readNarrativeP3Protocol(resolve(input.protocolPath));
  if (canonicalP3(protocol) !== canonicalP3(createNarrativeP3Protocol(input.runId, deps))) throw new Error("P3_FROZEN_CONFIGURATION_MISMATCH");
  const routeRunner = journeyOptions.routeRunner ?? await createP3ProductionRouteRunner(env, resolve(input.replaySource ?? dirname(input.protocolPath)), protocol);
  return run({ mode: input.mode, runId: input.runId, protocolPath: input.protocolPath, outputDirectory: input.outputDirectory, replaySource: input.replaySource }, deps, { routeRunner });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseNarrativeP3Args(process.argv.slice(2));
    const result = await runNarrativeP3Journey({ mode: args.mode, runId: args.runId, protocolPath: args.protocol, outputDirectory: args.output, replaySource: args.replaySource || undefined });
    console.log(`[narrative-p3] ${JSON.stringify(result)}`);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(`[narrative-p3] ${error.message}`);
    process.exitCode = 1;
  }
}
