#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { installTsHooks, freezeCurrentCodeIdentity, createProductionRouteRunner } from "./narrativeP1Journey.mjs";
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

async function createP3ProductionRouteRunner(runtimeEnv, replaySource, protocol) {
  const binding = { protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, inputHash: protocol.inputHash, codeFingerprint: protocol.codeFingerprint };
  const p1Runner = await createProductionRouteRunner(runtimeEnv, undefined, replaySource, binding, undefined);
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
