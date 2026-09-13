#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, copyFileSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectRoot, readAiEnv } from "./aiEnv.mjs";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, "..");
const NARRATIVE_P1_ARTIFACT_ROOT = resolve(REPOSITORY_ROOT, "artifacts", "narrative-p1");

export const DEFAULT_NARRATIVE_P1_PROTOCOL_PATH = resolve(NARRATIVE_P1_ARTIFACT_ROOT, "protocol.json");
export const DEFAULT_NARRATIVE_P1_OUTPUT_ROOT = NARRATIVE_P1_ARTIFACT_ROOT;

const VALID_MODES = new Set(["register", "live", "replay"]);

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
    protocolPath: DEFAULT_NARRATIVE_P1_PROTOCOL_PATH,
    output: DEFAULT_NARRATIVE_P1_OUTPUT_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string" || !argument.startsWith("--")) continue;
    const equal = argument.indexOf("=");
    const key = equal >= 0 ? argument.slice(2, equal) : argument.slice(2);
    const value = equal >= 0 ? argument.slice(equal + 1) : argv[++index];
    if (key === "mode" || key === "run-id" || key === "protocol" || key === "output") {
      if (key === "mode") parsed.mode = value ?? "";
      if (key === "run-id") parsed.runId = value ?? "";
      if (key === "protocol") parsed.protocolPath = value ?? "";
      if (key === "output") parsed.output = value ?? "";
    }
  }
  return parsed;
}

export function validateNarrativeP1Args(args) {
  if (!VALID_MODES.has(args?.mode)) return "INVALID_MODE";
  if (typeof args?.runId !== "string" || args.runId.trim() === "") return "MISSING_RUN_ID";
  if (typeof args?.protocolPath !== "string" || args.protocolPath.trim() === "") return "MISSING_PROTOCOL";
  if (typeof args?.output !== "string" || args.output.trim() === "") return "MISSING_OUTPUT";
  return null;
}

let hooksInstalled = false;
function installTsHooks() {
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
        && !/\.[a-z]+$/i.test(specifier)) {
        const found = tryFile(resolve(dirname(fileURLToPath(context.parentURL)), specifier));
        if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

function freezeCurrentCodeIdentity() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  const diff = spawnSync("git", ["diff", "--binary", "--no-ext-diff", "--", "src", "scripts"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  const commitValue = commit.status === 0 ? commit.stdout.trim() : "unknown-commit";
  const diffValue = diff.status === 0 ? diff.stdout : "unavailable-diff";
  const dirtyDiffHash = createHash("sha256").update(diffValue).digest("hex");
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

export function currentStoryInteractions(worldState) {
  return worldState.entityStore.records.flatMap((entity) => entity.core.kind === "npc" ? entity.interactions ?? [] : []);
}

export function offeredProductionChoices(view) {
  return [...new Map([...view.narrative.choices, ...view.currentLocation.actions].map((choice) => [choice.choiceToken, choice])).values()];
}

export function selectProductionChoice(view, routeKind, actionMap, interactions, performed, performedActions = new Set()) {
  const choices = offeredProductionChoices(view);
  const operation = (choice) => {
    const action = actionMap.get(choice.choiceToken);
    return action?.type === "talk" ? interactions.find((entry) => entry.id === action.interactionId)?.operation : undefined;
  };
  const wanted = routeKind === "private"
    ? (!performed.has("promise_confidentiality") ? "promise_confidentiality" : !performed.has("request_introduction") ? "request_introduction" : null)
    : routeKind === "verify_first" && !performed.has("verify_freeform_submitted")
      ? "await_delivery_opportunity"
      : (!performed.has("request_verification") ? "request_verification" : null);
  const specific = choices.find((choice) => wanted !== null && operation(choice) === wanted && !performedActions.has(JSON.stringify(actionMap.get(choice.choiceToken))));
  if (specific !== undefined) return specific;
  // Only the current objective may bridge locations. Never pick arbitrary prose.
  return choices.find((choice) => {
    if (choice.choiceToken !== view.story.currentObjectiveChoiceToken) return false;
    const action = actionMap.get(choice.choiceToken);
    if (action === undefined || action.type === "abandon_quest") return false;
    if (performedActions.has(JSON.stringify(action))) return false;
    if (action.type === "give_item" && wanted !== null) return false;
    const op = operation(choice);
    return op === undefined || (wanted === null && !performed.has(op) && (routeKind === "private" || !["promise_confidentiality", "request_introduction"].includes(op)));
  });
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

export async function createProductionRouteRunner(runtimeEnv, adapters) {
  const { createServerGameEntryPoints } = adapters ?? await import("../src/game/application/server/compositionRoot.ts");
  const { createSqliteGameRepository } = adapters ?? await import("../src/game/application/server/persistence/sqliteGameRepository.ts");
  const { createServerSqliteClientFactory, createSqliteClient } = adapters ?? await import("../src/game/application/server/persistence/sqliteClient.ts");
  const { buildChoiceMap } = adapters ?? await import("../src/game/application/buildChoiceMap.ts");
  const initialize = createScenarioSnapshotCache(async (scenarioId, { setup, budget, artifactDirectory, signal }) => {
    const databasePath = resolve(artifactDirectory, `${scenarioId}-opening.sqlite`);
    if (existsSync(databasePath)) return { ok: false, code: "OPENING_ARTIFACT_ALREADY_EXISTS" };
    const env = { ...runtimeEnv, NODE_ENV: "test", GAME_DB_PATH: databasePath, AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_DIR: resolve(artifactDirectory, "audit"), AI_TEXT_AUDIT_RUN_ID: `${scenarioId}-opening` };
    let entry;
    const before = budget.used;
    let result;
    try {
      entry = createServerGameEntryPoints(env, undefined, undefined, { beforeNarrativeHttpAttempt: budget.reserve, narrativeAbortSignal: signal });
      const created = await entry.createGame({ gameType: setup.gameType, gameLength: setup.gameLength, setup: projectNarrativeP1GameSetup(setup) }, `${scenarioId}-create`);
      result = created.ok ? { ok: true, databasePath } : { ok: false, code: created.code ?? "CREATE_FAILED" };
    } catch { result = { ok: false, code: "OPENING_RUNNER_CRASHED" }; }
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
    if (mode !== "live") return { completed: false, httpAttempts: 0, failureCode: "UNEXPECTED_ROUTE_MODE" };
    const httpBefore = budget.used;
    const routeResult = (value) => ({ ...value, httpAttempts: budget.used - httpBefore });
    const opening = await initialize(route.scenarioId, { setup, budget, artifactDirectory, signal });
    if (!opening.ok) return routeResult({ completed: false, failureCode: opening.code });
    if (signal?.aborted) return routeResult({ completed: false, failureCode: "BATCH_INTERRUPTED" });
    const databasePath = resolve(artifactDirectory, `${route.routeId}.sqlite`);
    copyFileSync(opening.databasePath, databasePath, constants.COPYFILE_EXCL);
    const entryEnv = {
      ...runtimeEnv,
      NODE_ENV: "test",
      GAME_DB_PATH: databasePath,
      AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_DIR: resolve(artifactDirectory, "audit"),
      AI_TEXT_AUDIT_RUN_ID: route.routeId,
    };
    let repository;
    const createEntry = () => {
      repository = createSqliteGameRepository({ clientFactory: createServerSqliteClientFactory(entryEnv) });
      return createServerGameEntryPoints(entryEnv, undefined, repository, { beforeNarrativeHttpAttempt: budget.reserve, narrativeAbortSignal: signal });
    };
    let entry = null;
    const steps = [];
    let actionCount = 0;
    let verifySubmitted = false;
    const performed = new Set();
    const performedActions = new Set();
    try {
      entry = createEntry();

      while (actionCount <= 24) {
        if (signal?.aborted) return routeResult({ completed: false, actionCount, failureCode: "BATCH_INTERRUPTED" });
        const current = await waitForNarrativeP1Generation(entry, `${route.routeId}-${actionCount}`, { signal });
        if (!current.ok || current.status !== "active" || current.view === undefined) {
          return {
            completed: false,
            httpAttempts: budget.used - httpBefore,
            actionCount,
            failureCode: current.code ?? "CURRENT_GAME_UNAVAILABLE",
          };
        }
        if (current.view.ending !== null) {
          const routeSatisfied = route.kind === "private" ? performed.has("promise_confidentiality") && performed.has("request_introduction") : performed.has("request_verification") && (route.kind !== "verify_first" || verifySubmitted);
          return routeResult({ completed: routeSatisfied, actionCount, ...(!routeSatisfied ? { failureCode: "ROUTE_POLICY_NOT_EXERCISED" } : {}) });
        }
        if (actionCount === 24) return routeResult({ completed: false, actionCount, failureCode: "ROUTE_ACTION_BUDGET_EXHAUSTED" });
        const view = current.view;
        if (view.narrativeGeneration.status === "failed") {
          return { completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: "AI_GENERATION_FAILED" };
        }

        const state = await repository.getCurrentGame();
        if (!state.ok || state.status !== "active" || state.record.revision !== current.revision) return routeResult({ completed: false, actionCount, failureCode: "ROUTE_STATE_MISMATCH" });
        const actionMap = buildChoiceMap(state.record.worldState, state.record.storyState, state.record.revision);
        const interactions = currentStoryInteractions(state.record.worldState);
        let interaction;
        let selectedAction;
        const offeredChoices = offeredProductionChoices(view);
        const delivery = offeredChoices.map((choice) => actionMap.get(choice.choiceToken)).find((action) => action?.type === "give_item");
        if (route.kind === "verify_first" && !verifySubmitted
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
          const selected = selectProductionChoice(view, route.kind, actionMap, interactions, performed, performedActions);
          if (selected === undefined) return { completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: "ROUTE_POLICY_UNSUPPORTED" };
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
            choices: view.narrative.choices.map((choice) => ({ label: choice.label, presentation: choice.presentation })),
          },
          after: after.ok && after.view !== undefined
            ? { revision: after.revision, location: after.view.currentLocation.name, ending: after.view.ending?.name ?? null }
            : { revision: null },
          actionId: command.actionId,
          interaction: command.interaction,
          action: selectedAction ?? null,
          ok: after.ok,
        });
        if (!after.ok) return { completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: after.code };
        const settled = await repository.getCurrentGame();
        if (!settled.ok || settled.status !== "active" || settled.record.storyState.turnNumber <= state.record.storyState.turnNumber) {
          return routeResult({ completed: false, actionCount, failureCode: "ROUTE_ACTION_NOT_SETTLED" });
        }
        actionCount += 1;
        if (interaction.kind === "free_text" && route.kind === "verify_first") performed.add("verify_freeform_submitted");
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
      return { completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: "ROUTE_ACTION_BUDGET_EXHAUSTED" };
    } catch {
      return { completed: false, httpAttempts: budget.used - httpBefore, actionCount, failureCode: "PRODUCTION_ROUTE_CRASHED" };
    } finally {
      try {
        mkdirSync(artifactDirectory, { recursive: true });
        writeFileSync(resolve(artifactDirectory, `${route.routeId}.steps.json`), `${JSON.stringify(steps, null, 2)}\n`, "utf8");
      } catch {
        // The route result is still more useful than an artifact write exception.
      }
      await closeNarrativeP1Entry(entry);
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
  const runtimeEnv = readConfiguredAiEnvironment();
  if (runtimeEnv === null || !runtimeEnv.AI_MODEL?.trim() || !runtimeEnv.AI_API_BASE_URL?.trim()) {
    console.error("[narrative-p1] missing non-empty AI_MODEL or AI_API_BASE_URL in .env.local");
    process.exitCode = 2;
    return;
  }
  const { runNarrativeP1Journey } = await import("../src/game/application/testing/narrativeP1LiveJourney.ts");
  const protocolPath = args.protocolPath === DEFAULT_NARRATIVE_P1_PROTOCOL_PATH
    ? resolve(REPOSITORY_ROOT, args.output, args.runId, "protocol.json")
    : resolve(REPOSITORY_ROOT, args.protocolPath);
  const routeRunner = args.mode === "live" ? await createProductionRouteRunner(runtimeEnv) : undefined;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const result = await runNarrativeP1Journey({
    mode: args.mode,
    runId: args.runId,
    protocolPath,
    artifactDirectory: resolveNarrativeP1ArtifactDirectory(
      args,
      process.argv.slice(2).some((argument) => /^--output(?:=|$)/.test(argument)),
    ),
  }, {
    signal: controller.signal,
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
