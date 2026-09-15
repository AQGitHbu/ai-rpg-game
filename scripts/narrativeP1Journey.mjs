#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNarrativeP1ReplayRuntime } from "./narrativeP1Replay.mjs";
import { loadNarrativeP1Seed, validateNarrativeP1SeedState } from "./narrativeP1Seed.mjs";
import { projectRoot, readAiEnv } from "./aiEnv.mjs";

import { currentStoryInteractions, offeredProductionChoices, selectProductionChoice, findOfferedStoryDelivery } from './narrativeP1Choices.mjs';
export { currentStoryInteractions, offeredProductionChoices, selectProductionChoice } from './narrativeP1Choices.mjs';

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, "..");
const NARRATIVE_P1_ARTIFACT_ROOT = resolve(REPOSITORY_ROOT, "artifacts", "narrative-p1");

export const DEFAULT_NARRATIVE_P1_PROTOCOL_PATH = resolve(NARRATIVE_P1_ARTIFACT_ROOT, "protocol.json");
export const DEFAULT_NARRATIVE_P1_OUTPUT_ROOT = NARRATIVE_P1_ARTIFACT_ROOT;

const VALID_MODES = new Set(["register", "live", "replay"]);

export function hasCompletedCoreStory(state, isDeliveryComplete) {
  if (!state.ok || state.status !== "active") return false;
  const { worldState, storyState } = state.record;
  return storyState.narrative?.status === "ready"
    && worldState.ending?.outcome === "success"
    && worldState.eventLedger.some(event => event.payload.type === "ending_reached"
      && event.payload.endingId === worldState.ending.endingId && event.payload.outcome === "success")
    && (storyState.delivery === undefined || isDeliveryComplete(worldState, storyState));
}

export function resolveNarrativeP1ArtifactDirectory(args, outputWasProvided) {
  return resolve(REPOSITORY_ROOT, args.output, outputWasProvided ? "" : args.runId);
}

export async function closeNarrativeP1Entry(entry) {
  try {
    await entry?.close();
  } catch {
    // Preserve the route result when audit/logger cleanup fails.
  }
}

export async function waitForNarrativeP1Generation(entry, traceId, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const maxPolls = options.maxPolls ?? 3_600;
  for (let poll = 0; poll <= maxPolls; poll += 1) {
    if (options.signal?.aborted) return { ok: false, status: "error", code: "BATCH_INTERRUPTED" };
    const current = await entry.getCurrentGame(traceId);
    if (!current.ok || current.status !== "active" || current.view === undefined) return current;
    if (current.view.narrativeGeneration.status !== "pending") return current;

    const ensured = await entry.ensureNarrativeScene({}, `${traceId}-ensure-${poll}`);
    if (!ensured.ok) return { ok: false, status: "error", code: ensured.code };
    if (poll === maxPolls) break;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { ok: false, status: "error", code: "NARRATIVE_GENERATION_TIMEOUT" };
}

export function projectNarrativeP1GameSetup(setup) {
  return {
    characterName: setup.characterName,
    characterIdentity: setup.characterIdentity,
    ...(setup.characterProfile === undefined ? {} : { characterProfile: setup.characterProfile }),
    personalityTags: [...setup.personalityTags],
    worldPremise: setup.worldPremise,
    storyOpening: setup.storyOpening,
    narrativeStyle: setup.narrativeStyle,
    contentIntensity: setup.contentIntensity,
  };
}

export function parseNarrativeP1Args(argv) {
  const parsed = {
    mode: "replay",
    runId: "",
    profile: "matrix",
    replaySource: "",
    openingSource: "",
    protocolPath: DEFAULT_NARRATIVE_P1_PROTOCOL_PATH,
    output: DEFAULT_NARRATIVE_P1_OUTPUT_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string" || !argument.startsWith("--")) continue;
    const equal = argument.indexOf("=");
    const key = equal >= 0 ? argument.slice(2, equal) : argument.slice(2);
    const value = equal >= 0 ? argument.slice(equal + 1) : argv[++index];
    if (key === "opening-source" || key === "profile" || key === "replay-source" || key === "mode" || key === "run-id" || key === "protocol" || key === "output") {
      if (key === "opening-source") parsed.openingSource = value ?? "";
      if (key === "profile") parsed.profile = value ?? "";
      if (key === "replay-source") parsed.replaySource = value ?? "";
      if (key === "mode") parsed.mode = value ?? "";
      if (key === "run-id") parsed.runId = value ?? "";
      if (key === "protocol") parsed.protocolPath = value ?? "";
      if (key === "output") parsed.output = value ?? "";
    }
  }
  return parsed;
}

export function validateNarrativeP1Args(args) {
  if (args.profile !== undefined && !["matrix", "diagnostic", "focused", "core"].includes(args.profile)) return "INVALID_PROFILE";
  if (!VALID_MODES.has(args?.mode)) return "INVALID_MODE";
  if (typeof args?.runId !== "string" || args.runId.trim() === "") return "MISSING_RUN_ID";
  if (typeof args?.protocolPath !== "string" || args.protocolPath.trim() === "") return "MISSING_PROTOCOL";
  if (typeof args?.output !== "string" || args.output.trim() === "") return "MISSING_OUTPUT";
  return null;
}

let hooksInstalled = false;
export function installTsHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const sourceRoot = resolve(REPOSITORY_ROOT, "src");
  const tryFile = (base) => {
    for (const suffix of ["", ".ts", ".tsx", "/index.ts"]) {
      const candidate = base + suffix;
      if (existsSync(candidate) && /\.(ts|tsx|js|mjs)$/.test(candidate)) return candidate;
    }
    return null;
  };
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { url: pathToFileURL(resolve(sourceRoot, "test-server-only.ts")).href, shortCircuit: true };
      }
      if (specifier.startsWith("@/")) {
        const found = tryFile(resolve(sourceRoot, specifier.slice(2)));
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      if ((specifier.startsWith("./") || specifier.startsWith("../"))
        && context.parentURL?.startsWith("file:")
        && !/\.(?:ts|tsx|js|mjs|cjs|json|node)$/i.test(specifier)) {
        const found = tryFile(resolve(dirname(fileURLToPath(context.parentURL)), specifier));
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

export function freezeCurrentCodeIdentity() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  const diff = spawnSync("git", ["diff", "HEAD", "--binary", "--no-ext-diff", "--", "src", "scripts"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  const commitValue = commit.status === 0 ? commit.stdout.trim() : "unknown-commit";
  const diffValue = diff.status === 0 ? diff.stdout : "unavailable-diff";
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "src", "scripts"], { cwd: REPOSITORY_ROOT, encoding: "utf8", windowsHide: true });
  const untrackedIdentity = untracked.status === 0 ? untracked.stdout.split("\0").filter(Boolean).sort().map(path => `${path}:${createHash("sha256").update(readFileSync(resolve(REPOSITORY_ROOT, path))).digest("hex")}`).join("\n") : "unavailable-untracked";
  const dirtyDiffHash = createHash("sha256").update(diffValue).update(untrackedIdentity).digest("hex");
  process.env.GIT_COMMIT = commitValue;
  process.env.NARRATIVE_P1_DIRTY_DIFF_HASH = dirtyDiffHash;
  process.env.NARRATIVE_P1_CODE_FINGERPRINT = `${commitValue}:${dirtyDiffHash}`;
}

export function createScenarioSnapshotCache(initialize) {
  const snapshots = new Map();
  return (scenarioId, input) => {
    if (!snapshots.has(scenarioId)) snapshots.set(scenarioId, Promise.resolve().then(() => initialize(scenarioId, input)));
    return snapshots.get(scenarioId);
  };
}

function readConfiguredAiEnvironment() {
  const source = resolve(projectRoot, ".env.local");
  if (!existsSync(source)) return null;
  const values = readAiEnv(source);
  const configured = { ...process.env };
  for (const key of ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY", "AI_OUTPUT_FORMAT"]) {
    const value = values.get(key)?.decoded;
    if (value !== undefined) configured[key] = value;
  }
  return configured;
}

export async function createProductionRouteRunner(runtimeEnv, adapters, replaySource, binding, seed, policy = {}) {
  const { createServerGameEntryPoints } = adapters ?? await import("../src/game/application/server/compositionRoot.ts");
  const { createSqliteGameRepository } = adapters ?? await import("../src/game/application/server/persistence/sqliteGameRepository.ts");
  const { createServerSqliteClientFactory, createSqliteClient } = adapters ?? await import("../src/game/application/server/persistence/sqliteClient.ts");
  const { buildChoiceMap } = adapters ?? await import("../src/game/application/buildChoiceMap.ts");
  const { isStoryDeliveryComplete } = adapters ?? await import("../src/game/gameplay/rpg/storyDelivery/index.ts");
  let replayedAttempts = 0;
  const makeRuntime = (input) => {
    const runtime = createNarrativeP1ReplayRuntime(input);
    const attempt = runtime.options.aiRuntime.attempt;
    runtime.options.aiRuntime.attempt = async (...args) => {
      const output = await attempt(...args);
      if (input.mode === "replay") replayedAttempts += 1;
      return output;
    };
    return runtime;
  };
  const initialize = createScenarioSnapshotCache(async (scenarioId, { setup, budget, artifactDirectory, signal, mode }) => {
    const databasePath = resolve(artifactDirectory, `${scenarioId}-opening.sqlite`);
    if (existsSync(databasePath)) return { ok: false, code: "OPENING_ARTIFACT_ALREADY_EXISTS" };
    if (seed) {
      loadNarrativeP1Seed(seed.directory, seed.manifest);
      copyFileSync(seed.databasePath, databasePath, constants.COPYFILE_EXCL);
      writeFileSync(resolve(artifactDirectory, `${scenarioId}-seed.json`), JSON.stringify({ reusedApprovedOpening:true, httpAttempts:0, manifest:seed.manifest }, null, 2));
      return {ok:true, databasePath};
    }
    const env = { ...runtimeEnv, NODE_ENV: "test", GAME_DB_PATH: databasePath, AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_DIR: resolve(artifactDirectory, "audit"), AI_TEXT_AUDIT_RUN_ID: `${scenarioId}-opening` };
    const runtime = makeRuntime({ mode, directory: artifactDirectory, sourceDirectory: replaySource, stream: `${scenarioId}-opening`, binding, auditFiles: [`audit/${scenarioId}-opening/events.jsonl`] });
    let repository;
    let entry;
    const before = budget.used;
    let result;
    try {
      repository = createSqliteGameRepository({ clientFactory: createServerSqliteClientFactory(env) });
      entry = createServerGameEntryPoints(env, undefined, repository, { ...runtime.options, beforeNarrativeHttpAttempt: mode === "replay" ? () => true : budget.reserve, narrativeAbortSignal: signal });
      const created = await entry.createGame({ gameType: setup.gameType, gameLength: setup.gameLength, setup: projectNarrativeP1GameSetup(setup) }, `${scenarioId}-create`);
      runtime.state("opening", await repository.getCurrentGame());
      await closeNarrativeP1Entry(entry);
      entry = null;
      runtime.finish();
      result = created.ok ? { ok: true, databasePath } : { ok: false, code: created.code ?? "CREATE_FAILED" };
    } catch (error) { result = { ok: false, code: runtime.failureCode ?? ((error.message?.startsWith("REPLAY_") || error.message?.startsWith("SEED_")) ? error.message : "OPENING_RUNNER_CRASHED") }; }
    finally { await closeNarrativeP1Entry(entry); }
    if (result.ok) {
      const client = createSqliteClient(databasePath);
      try {
        const checkpoint = await client.execute("PRAGMA wal_checkpoint(TRUNCATE)");
        if (Number(checkpoint.rows[0]?.busy ?? checkpoint.rows[0]?.[0] ?? 0) !== 0) result = { ok: false, code: "OPENING_CHECKPOINT_BUSY" };
      } finally { client.close(); }
    }
    writeFileSync(resolve(artifactDirectory, `${scenarioId}-opening.json`), JSON.stringify({ ...result, httpAttempts: budget.used - before }, null, 2));
    return result;
  });
  return async ({ mode, route, setup, budget, artifactDirectory, signal }) => {
    if (!["live", "replay"].includes(mode)) return { completed: false, httpAttempts: 0, failureCode: "UNEXPECTED_ROUTE_MODE" };
    const httpBefore = budget.used;
    const replayBefore = replayedAttempts;
    let outcome;
    const routeResult = (value) => (outcome = { ...value, httpAttempts: budget.used - httpBefore, replayedTransportAttempts: replayedAttempts - replayBefore });
    let opening;
    try { opening = await initialize(route.scenarioId, { setup, budget, artifactDirectory, signal, mode }); }
    catch (error) { return routeResult({ completed: false, failureCode: (error.message?.startsWith("REPLAY_") || error.message?.startsWith("SEED_")) ? error.message : "OPENING_RUNNER_CRASHED" }); }
    if (!opening.ok) return routeResult({ completed: false, failureCode: opening.code });
    if (signal?.aborted) return routeResult({ completed: false, failureCode: "BATCH_INTERRUPTED" });
    const databasePath = resolve(artifactDirectory, `${route.routeId}.sqlite`);
    try { copyFileSync(opening.databasePath, databasePath, constants.COPYFILE_EXCL); }
    catch { return routeResult({ completed: false, failureCode: "ROUTE_SNAPSHOT_COPY_FAILED" }); }
    const entryEnv = {
      ...runtimeEnv,
      NODE_ENV: "test",
      GAME_DB_PATH: databasePath,
      AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_DIR: resolve(artifactDirectory, "audit"),
      AI_TEXT_AUDIT_RUN_ID: route.routeId,
    };
    const auditFiles = [];
    let runtime;
    try { runtime = makeRuntime({ mode, directory: artifactDirectory, sourceDirectory: replaySource, stream: route.routeId, binding, auditFiles: () => auditFiles.filter(file => existsSync(resolve(artifactDirectory, file))) }); }
    catch (error) { return routeResult({ completed: false, failureCode: (error.message?.startsWith("REPLAY_") || error.message?.startsWith("SEED_")) ? error.message : "PRODUCTION_ROUTE_CRASHED" }); }
    let repository;
    const createEntry = () => {
      const auditStream = auditFiles.length === 0 ? route.routeId : `${route.routeId}-reload-${auditFiles.length}`;
      entryEnv.AI_TEXT_AUDIT_RUN_ID = auditStream;
      auditFiles.push(`audit/${auditStream}/events.jsonl`);
      repository = createSqliteGameRepository({ clientFactory: createServerSqliteClientFactory(entryEnv) });
      return createServerGameEntryPoints(entryEnv, undefined, repository, { ...runtime.options, beforeNarrativeHttpAttempt: mode === "replay" ? () => true : budget.reserve, narrativeAbortSignal: signal });
    };
    let entry = null;
    const steps = [];
    let actionCount = 0;
    let finalized = false;
    let verifySubmitted = false;
    const performed = new Set();
    const performedActions = new Set();
    try {
      entry = createEntry();
      if (seed) {
        const initial = await repository.getCurrentGame();
        validateNarrativeP1SeedState(seed, initial);
        runtime.state("seed", initial);
      }
      await entry.ackPrologue(`${route.routeId}-ack`);

      const actionLimit = policy.actionLimit ?? 24;
      while (actionCount <= actionLimit) {
        if (signal?.aborted) return routeResult({ completed: false, actionCount, failureCode: "BATCH_INTERRUPTED" });
        const current = await waitForNarrativeP1Generation(entry, `${route.routeId}-${actionCount}`, { signal });
        if (runtime.failureCode) throw new Error(runtime.failureCode);
        if (!current.ok || current.status !== "active" || current.view === undefined) {
          return routeResult({
            completed: false,
            httpAttempts: budget.used - httpBefore,
            actionCount,
            failureCode: current.code ?? "CURRENT_GAME_UNAVAILABLE",
          });
        }
        if (current.view.ending !== null) {
          const endingState = await repository.getCurrentGame();
          runtime.state("ending", endingState);
          const coreCompleted = route.kind === "complete" && hasCompletedCoreStory(endingState, isStoryDeliveryComplete);
          await closeNarrativeP1Entry(entry);
          entry = null;
          runtime.finish();
          finalized = true;
          const routeSatisfied = policy.routeSatisfied?.({ route, endingState, performed, performedActions, actionCount })
            ?? (route.kind === "complete" ? coreCompleted : route.kind === "deliver" ? performed.has("give_item") : route.kind === "withdraw" ? performed.has("abandon_quest") : route.kind === "diagnostic" ? performed.has("promise_confidentiality") && performed.has("request_introduction") && performed.has("request_verification") && verifySubmitted : route.kind === "private" ? performed.has("promise_confidentiality") && performed.has("request_introduction") : performed.has("request_verification") && (route.kind !== "verify_first" || verifySubmitted));
          return routeResult({ completed: routeSatisfied, actionCount, ...(!routeSatisfied ? { failureCode: "ROUTE_POLICY_NOT_EXERCISED" } : {}) });
        }
        if (actionCount === actionLimit) return routeResult({ completed: false, actionCount, failureCode: "ROUTE_ACTION_BUDGET_EXHAUSTED" });
        const view = current.view;
        if (view.narrativeGeneration.status === "failed") {
          return routeResult({ completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: "AI_GENERATION_FAILED" });
        }

        const state = await repository.getCurrentGame();
        if (!state.ok || state.status !== "active" || state.record.revision !== current.revision) return routeResult({ completed: false, actionCount, failureCode: "ROUTE_STATE_MISMATCH" });
        runtime.state(`before:${actionCount}`, state);
        const actionMap = buildChoiceMap(state.record.worldState, state.record.storyState, state.record.revision);
        const interactions = currentStoryInteractions(state.record.worldState);
        let interaction;
        let selectedAction;
        const offeredChoices = offeredProductionChoices(view);
        const deliveryChoice = findOfferedStoryDelivery(view, actionMap, state.record.storyState.delivery);
        const delivery = deliveryChoice === undefined ? undefined : actionMap.get(deliveryChoice.choiceToken);
        if ((route.kind === "verify_first" || route.kind === "diagnostic") && !verifySubmitted
          && delivery !== undefined) {
          const targetNpcId = view.narrative.npcDialogues.find((dialogue) => dialogue.freeInputEnabled && dialogue.npcId === delivery.npcId)?.npcId;
          if (targetNpcId !== undefined) {
            interaction = {
              kind: "free_text",
              targetNpcId,
              text: "我想先核实接应人的身份，再决定是否把信筒交给他。",
            };
            verifySubmitted = true;
          } else return routeResult({ completed: false, actionCount, failureCode: "ROUTE_POLICY_UNSUPPORTED" });
        }
        if (interaction === undefined) {
          const choiceContext = {
            route,
            view,
            current,
            state,
            actionMap,
            interactions,
            performed,
            performedActions,
            offeredChoices,
            delivery,
            actionCount,
          };
          const selected = policy.selectChoice === undefined
            ? selectProductionChoice(view, route.kind, actionMap, interactions, performed, performedActions, state.record.storyState.delivery, actionCount)
            : policy.selectChoice(choiceContext);
          if (selected === undefined) return routeResult({ completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: policy.noChoiceFailureCode ?? "ROUTE_POLICY_UNSUPPORTED" });
          selectedAction = actionMap.get(selected.choiceToken);
          interaction = { kind: "fixed_choice", choiceToken: selected.choiceToken };
        }
        const command = {
          actionId: `${route.routeId}-action-${actionCount}`,
          interaction,
          expectedRevision: current.revision,
        };
        const after = await entry.performTurn(command, `${route.routeId}-turn-${actionCount}`);
        steps.push({
          before: {
            revision: current.revision,
            location: view.currentLocation.name,
            narration: view.narrative.narration ?? null,
            npcDialogues: view.narrative.npcDialogues,
            stateReference: `before:${actionCount}`,
            choices: offeredChoices.map((choice) => ({ choiceToken: choice.choiceToken, label: choice.label, presentation: choice.presentation })),
          },
          after: after.ok && after.view !== undefined
            ? { revision: after.revision, location: after.view.currentLocation.name, ending: after.view.ending?.name ?? null }
            : { revision: null },
          actionId: command.actionId,
          interaction: command.interaction,
          action: selectedAction ?? null,
          ok: after.ok,
        });
        if (!after.ok) return routeResult({ completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: after.code });
        const settled = await repository.getCurrentGame();
        if (!settled.ok || settled.status !== "active" || (selectedAction?.type === "battle_action" ? settled.record.revision <= state.record.revision || JSON.stringify(settled.record.worldState.battle) === JSON.stringify(state.record.worldState.battle) : settled.record.storyState.turnNumber <= state.record.storyState.turnNumber)) {
          return routeResult({ completed: false, actionCount, failureCode: "ROUTE_ACTION_NOT_SETTLED" });
        }
        actionCount += 1;
        if (selectedAction && ["give_item", "abandon_quest"].includes(selectedAction.type)) {
          const success = settled.record.worldState.eventLedger.some(event => event.actionId === command.actionId && (selectedAction.type === "give_item" ? event.outcome === "success" && event.payload.type === "item_given" && event.payload.itemId === selectedAction.itemId && event.payload.npcId === selectedAction.npcId : event.outcome === "failure" && event.payload.type === "quest_abandoned" && event.payload.questId === selectedAction.questId));
          if (success) performed.add(selectedAction.type);
        }
        if (interaction.kind === "free_text" && (route.kind === "verify_first" || route.kind === "diagnostic")) performed.add("verify_freeform_submitted");
        if (selectedAction !== undefined) performedActions.add(JSON.stringify(selectedAction));
        if (selectedAction?.type === "talk") {
          const event = settled.record.worldState.eventLedger.find((event) => event.actionId === command.actionId
            && event.outcome === "success" && event.payload.type === "story_interaction_resolved"
            && event.payload.interactionId === selectedAction.interactionId && event.payload.npcId === selectedAction.npcId);
          const operation = event?.payload.operation;
          if (operation !== undefined) performed.add(operation);
          else if (selectedAction.interactionId !== undefined) return routeResult({ completed: false, actionCount, failureCode: "ROUTE_INTERACTION_NOT_SETTLED" });
        }
        writeFileSync(resolve(artifactDirectory, `${route.routeId}.steps.json`), `${JSON.stringify(steps, null, 2)}\n`, "utf8");
        if (actionCount === 4) {
          await closeNarrativeP1Entry(entry);
          entry = createEntry();
          steps.push({ kind: "reload", revision: after.revision });
        }
      }
      return routeResult({ completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: "ROUTE_ACTION_BUDGET_EXHAUSTED" });
    } catch (error) {
      return routeResult({ completed: false, actionCount, failureCode: runtime.failureCode ?? ((error.message?.startsWith("REPLAY_") || error.message?.startsWith("SEED_")) ? error.message : "PRODUCTION_ROUTE_CRASHED") });
    } finally {
      try {
        mkdirSync(artifactDirectory, { recursive: true });
        writeFileSync(resolve(artifactDirectory, `${route.routeId}.steps.json`), `${JSON.stringify(steps, null, 2)}\n`, "utf8");
      } catch {
        // The route result is still more useful than an artifact write exception.
      }
      if (!finalized && outcome !== undefined) {
        try {
          // A failed story is still replayable. Drain workers and audit before
          // reading its actual terminal state and sealing the tape.
          await closeNarrativeP1Entry(entry);
          entry = null;
          try {
            runtime.state("failure", { outcome: { completed: outcome.completed, actionCount: outcome.actionCount ?? 0, failureCode: outcome.failureCode }, state: repository === undefined ? null : await repository.getCurrentGame() });
          } finally { await repository?.close?.(); }
          runtime.finish();
        } catch (error) {
          outcome.completed = false;
          outcome.failureCode = runtime.failureCode ?? ((error.message?.startsWith("REPLAY_") || error.message?.startsWith("SEED_")) ? error.message : "REPLAY_FINALIZATION_FAILED");
        }
      }
      await closeNarrativeP1Entry(entry);
      if (outcome !== undefined) {
        outcome.httpAttempts = budget.used - httpBefore;
        outcome.replayedTransportAttempts = replayedAttempts - replayBefore;
      }
    }
  };
}

async function main() {
  const args = parseNarrativeP1Args(process.argv.slice(2));
  const issue = validateNarrativeP1Args(args);
  if (issue !== null) {
    console.error(`[narrative-p1] parameter error: ${issue}`);
    process.exitCode = 2;
    return;
  }
  if (args.mode === "live" && process.env.RUN_REAL_AI_JOURNEY !== "1") {
    console.error("[narrative-p1] live mode requires explicit RUN_REAL_AI_JOURNEY=1");
    process.exitCode = 2;
    return;
  }
  installTsHooks();
  freezeCurrentCodeIdentity();
  const protocolPath = args.protocolPath === DEFAULT_NARRATIVE_P1_PROTOCOL_PATH
    ? resolve(REPOSITORY_ROOT, args.output, args.runId, "protocol.json")
    : resolve(REPOSITORY_ROOT, args.protocolPath);
  const frozenProtocol = args.mode === "replay" ? JSON.parse(readFileSync(protocolPath, "utf8")) : null;
  const runtimeEnv = frozenProtocol ? { ...process.env, AI_MODEL: frozenProtocol.environment.model, AI_API_BASE_URL: frozenProtocol.environment.apiBaseUrl, AI_API_KEY: "offline-replay-no-network", AI_OUTPUT_FORMAT: "prompt_only" } : readConfiguredAiEnvironment();
  if (runtimeEnv === null || !runtimeEnv.AI_MODEL?.trim() || !runtimeEnv.AI_API_BASE_URL?.trim()) {
    console.error("[narrative-p1] missing non-empty AI_MODEL or AI_API_BASE_URL in .env.local");
    process.exitCode = 2;
    return;
  }
  const { runNarrativeP1Journey } = await import("../src/game/application/testing/narrativeP1LiveJourney.ts");
  const registered = args.mode === "register" ? null : JSON.parse(readFileSync(protocolPath, "utf8"));
  const sourceDirectory = args.openingSource || registered?.openingSource?.sourceDirectory;
  if (sourceDirectory && (registered ? registered.claimScope !== "fixed_opening_story" : args.profile !== "focused")) throw new Error("SEED_SCOPE_MISMATCH");
  const seed = sourceDirectory ? loadNarrativeP1Seed(sourceDirectory, registered?.openingSource) : undefined;
  if ((args.profile === "focused" || registered?.claimScope === "fixed_opening_story") && !seed) throw new Error("SEED_REQUIRED");
  const binding = registered ? { protocolHash: registered.protocolHash, codeFingerprint: registered.code.fingerprint, inputHash: registered.inputHash } : undefined;
  const routeRunner = args.mode !== "register" ? await createProductionRouteRunner(runtimeEnv, undefined, args.replaySource || dirname(protocolPath), binding, seed) : undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const result = await runNarrativeP1Journey({
    mode: args.mode,
    profile: args.profile,
    runId: args.runId,
    protocolPath,
    artifactDirectory: resolveNarrativeP1ArtifactDirectory(
      args,
      process.argv.slice(2).some((argument) => /^--output(?:=|$)/.test(argument)),
    ),
  }, {
    signal: controller.signal,
    ...(seed ? { openingSource: seed.manifest } : {}),
    ...(args.mode === "replay" ? { replaySourceDirectory: resolve(args.replaySource || dirname(protocolPath)) } : {}),
    codeFingerprint: process.env.NARRATIVE_P1_CODE_FINGERPRINT,
    environment: {
      model: runtimeEnv.AI_MODEL,
      apiBaseUrl: runtimeEnv.AI_API_BASE_URL,
    },
    ...(routeRunner === undefined ? {} : { routeRunner }),
  });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  console.log(`[narrative-p1] ${JSON.stringify(result)}`);
  process.exitCode = result.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    console.error("[narrative-p1] runner failed");
    process.exitCode = 1;
  });
}
