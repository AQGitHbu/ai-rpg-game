#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, "..");
const NARRATIVE_P1_ARTIFACT_ROOT = resolve(REPOSITORY_ROOT, "artifacts", "narrative-p1");

export const DEFAULT_NARRATIVE_P1_PROTOCOL_PATH = resolve(NARRATIVE_P1_ARTIFACT_ROOT, "protocol.json");
export const DEFAULT_NARRATIVE_P1_OUTPUT_ROOT = NARRATIVE_P1_ARTIFACT_ROOT;

const VALID_MODES = new Set(["register", "live", "replay"]);

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

function selectProductionChoice(view, routeKind) {
  const choices = view.narrative.choices.length > 0 ? view.narrative.choices : view.currentLocation.actions;
  const keywords = routeKind === "private"
    ? ["保密", "私下", "引荐", "担保", "不公开"]
    : routeKind === "public"
      ? ["公开", "渠道", "核验", "调查"]
      : ["核验", "验证", "身份"];
  return choices.find((choice) => keywords.some((keyword) => choice.label.includes(keyword)))
    ?? choices.find((choice) => choice.choiceToken === view.story.currentObjectiveChoiceToken)
    ?? choices[0];
}

async function createProductionRouteRunner() {
  const { createServerGameEntryPoints } = await import("../src/game/application/server/compositionRoot.ts");
  return async ({ mode, route, setup, budget, artifactDirectory }) => {
    if (mode !== "live") return { completed: false, httpAttempts: 0, failureCode: "UNEXPECTED_ROUTE_MODE" };
    const databasePath = resolve(artifactDirectory, `${route.routeId}.sqlite`);
    const entryEnv = {
      ...process.env,
      NODE_ENV: "test",
      GAME_DB_PATH: databasePath,
      AI_TEXT_AUDIT: "full",
      AI_TEXT_AUDIT_DIR: resolve(artifactDirectory, "audit"),
      AI_TEXT_AUDIT_RUN_ID: route.routeId,
    };
    const createEntry = () => createServerGameEntryPoints(entryEnv, undefined, undefined, { beforeNarrativeHttpAttempt: budget.reserve });
    let entry = createEntry();
    const steps = [];
    let actionCount = 0;
    let verifySubmitted = false;
    try {
      const created = await entry.createGame({
        gameType: setup.gameType,
        gameLength: setup.gameLength,
        setup,
      }, `${route.routeId}-create`);
      if (!created.ok) return { completed: false, httpAttempts: budget.used, failureCode: created.code ?? "CREATE_FAILED" };

      for (; actionCount < 24; actionCount += 1) {
        const current = await entry.getCurrentGame(`${route.routeId}-${actionCount}`);
        if (!current.ok || current.status !== "active" || current.view === undefined) {
          return { completed: false, httpAttempts: budget.used, actionCount, failureCode: "CURRENT_GAME_UNAVAILABLE" };
        }
        if (current.view.ending !== null) return { completed: true, httpAttempts: budget.used, actionCount };
        const view = current.view;
        if (view.narrativeGeneration.status === "pending") {
          const ensured = await entry.ensureNarrativeScene({}, `${route.routeId}-ensure-${actionCount}`);
          if (!ensured.ok) return { completed: false, httpAttempts: budget.used, actionCount, failureCode: ensured.code };
          continue;
        }
        if (view.narrativeGeneration.status === "failed") {
          return { completed: false, httpAttempts: budget.used, actionCount, failureCode: "AI_GENERATION_FAILED" };
        }

        let interaction;
        if (route.kind === "verify_first" && !verifySubmitted
          && view.narrative.npcDialogues.some((dialogue) => dialogue.freeInputEnabled)) {
          const targetNpcId = view.narrative.npcDialogues[0]?.npcId ?? view.currentLocation.npcs[0]?.npcId;
          if (targetNpcId !== undefined) {
            interaction = {
              kind: "free_text",
              targetNpcId,
              text: "我想先核实接应人的身份，再决定是否把信筒交给他。",
            };
            verifySubmitted = true;
          }
        }
        if (interaction === undefined) {
          const selected = selectProductionChoice(view, route.kind);
          if (selected === undefined) return { completed: false, httpAttempts: budget.used, actionCount, failureCode: "LEGAL_CHOICE_MISSING" };
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
          ok: after.ok,
        });
        if (!after.ok) return { completed: false, httpAttempts: budget.used, actionCount, failureCode: after.code };
        if (actionCount === 3) {
          await entry.close();
          entry = createEntry();
          steps.push({ kind: "reload", revision: after.revision });
        }
      }
      return { completed: false, httpAttempts: budget.used, actionCount, failureCode: "ROUTE_ACTION_BUDGET_EXHAUSTED" };
    } finally {
      mkdirSync(artifactDirectory, { recursive: true });
      writeFileSync(resolve(artifactDirectory, `${route.routeId}.steps.json`), `${JSON.stringify(steps, null, 2)}\n`, "utf8");
      await entry.close();
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
  if (args.mode === "register" && (!process.env.AI_MODEL?.trim() || !process.env.AI_API_BASE_URL?.trim())) {
    console.error("[narrative-p1] register requires non-empty AI_MODEL and AI_API_BASE_URL");
    process.exitCode = 2;
    return;
  }

  installTsHooks();
  freezeCurrentCodeIdentity();
  const { runNarrativeP1Journey } = await import("../src/game/application/testing/narrativeP1LiveJourney.ts");
  const protocolPath = args.protocolPath === DEFAULT_NARRATIVE_P1_PROTOCOL_PATH
    ? resolve(REPOSITORY_ROOT, args.output, args.runId, "protocol.json")
    : resolve(REPOSITORY_ROOT, args.protocolPath);
  const routeRunner = args.mode === "live" ? await createProductionRouteRunner() : undefined;
  const result = await runNarrativeP1Journey({
    mode: args.mode,
    runId: args.runId,
    protocolPath,
    artifactDirectory: resolve(REPOSITORY_ROOT, args.output, args.runId),
  }, {
    codeFingerprint: process.env.NARRATIVE_P1_CODE_FINGERPRINT,
    environment: {
      model: process.env.AI_MODEL ?? "",
      apiBaseUrl: process.env.AI_API_BASE_URL ?? "",
    },
    ...(routeRunner === undefined ? {} : { routeRunner }),
  });
  console.log(`[narrative-p1] ${JSON.stringify(result)}`);
  process.exitCode = result.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(() => {
    console.error("[narrative-p1] runner failed");
    process.exitCode = 1;
  });
}
