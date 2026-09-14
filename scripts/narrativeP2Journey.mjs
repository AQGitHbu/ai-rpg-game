#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { installTsHooks, freezeCurrentCodeIdentity } from "./narrativeP1Journey.mjs";
import { projectRoot, readAiEnv } from "./aiEnv.mjs";

// Protocol construction and validation live only in the TypeScript module.
export const NARRATIVE_P2_PROTOCOL_VERSION = "narrative-p2/v2";
export function parseNarrativeP2Args(argv) {
  const result = { mode: "replay", runId: "", protocol: "", output: "", replaySource: "", stage: "" };
  const keys = { review: "review", stage: "stage", mode: "mode", "run-id": "runId", protocol: "protocol", output: "output", "replay-source": "replaySource" };
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
export function validateNarrativeP2Args(args) {
  if (!["register", "live", "replay", "review", "resume"].includes(args?.mode)) return "INVALID_MODE";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(args?.runId ?? "")) return "INVALID_RUN_ID";
  if (!args?.protocol?.trim()) return "MISSING_PROTOCOL";
  if (!args?.output?.trim()) return "MISSING_OUTPUT";
  if (args.mode !== "register" && !["A", "B"].includes(args.stage)) return "P2_STAGE_REQUIRED";
  if (args.mode === "register" && args.stage) return "P2_REGISTER_HAS_NO_STAGE";
  if (["review", "resume"].includes(args.mode) && !args.review?.trim()) return "P2_REVIEW_FILE_REQUIRED";
  return null;
}
export function freezeP2CodeIdentity() {
  // P1 intentionally retains historical sentinel behavior. V2 must prove every
  // Git input is available before invoking that unchanged fingerprint function.
  for (const args of [["rev-parse", "HEAD"], ["diff", "HEAD", "--binary", "--no-ext-diff", "--", "src", "scripts"], ["ls-files", "--others", "--exclude-standard", "-z", "--", "src", "scripts"]]) {
    if (spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).status !== 0) throw Error('P2_CODE_IDENTITY_UNAVAILABLE');
  }
  freezeCurrentCodeIdentity();
  if (!/^[a-f0-9]{40}$/.test(process.env.GIT_COMMIT ?? '')) throw Error('P2_CODE_IDENTITY_UNAVAILABLE');
  const configFiles = ["package.json", "package-lock.json", "tsconfig.json", ".ai-game-foundation.json"];
  const hash = createHash("sha256").update(process.env.NARRATIVE_P1_CODE_FINGERPRINT).update(process.version);
  for (const file of configFiles) {
    hash.update(file);
    if (existsSync(resolve(projectRoot, file))) hash.update(readFileSync(resolve(projectRoot, file)));
  }
  return `${process.env.GIT_COMMIT}:${hash.digest("hex")}`;
}
function configuredEnvironment(mode, protocolPath) {
  if (["replay", "review"].includes(mode)) {
    const protocol = JSON.parse(readFileSync(protocolPath, "utf8"));
    return { ...process.env, AI_MODEL: protocol.environment.model, AI_API_BASE_URL: protocol.environment.apiBaseUrl,
      AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS: String(protocol.environment.inputMaxEstimatedTokens), AI_API_KEY: "offline-replay-no-network" };
  }
  const source = resolve(projectRoot, ".env.local");
  const values = existsSync(source) ? readAiEnv(source) : new Map();
  const env = { ...process.env };
  for (const key of ["AI_MODEL", "AI_API_BASE_URL", "AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS", ...(["live", "resume"].includes(mode) ? ["AI_API_KEY"] : [])]) {
    env[key] = process.env[key] ?? values.get(key)?.decoded;
  }
  return env;
}
export async function runNarrativeP2Journey(input, options = {}) {
  const issue = validateNarrativeP2Args({ mode: input.mode, runId: input.runId, protocol: input.protocolPath, output: input.outputDirectory, stage: input.stage, review: input.reviewPath });
  if (issue) throw new Error(issue);
  if (["live", "resume"].includes(input.mode) && process.env.RUN_REAL_AI_JOURNEY !== "1") throw new Error("P2_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY");
  if (input.mode === "replay" && resolve(input.outputDirectory) === resolve(input.replaySource || dirname(input.protocolPath))) throw new Error("P2_REPLAY_OUTPUT_MUST_BE_SEPARATE");
  installTsHooks();
  const codeFingerprint = freezeP2CodeIdentity();
  const { runNarrativeP2Journey: run, createNarrativeP2Protocol, readNarrativeP2Protocol, canonicalP2 } = await import("../src/game/application/testing/narrativeP2Journey.ts");
  const env = options.environment ?? configuredEnvironment(input.mode, input.protocolPath);
  const environment = { model: env.AI_MODEL?.trim() ?? "", apiBaseUrl: env.AI_API_BASE_URL?.trim() ?? "",
    inputMaxEstimatedTokens: Number(env.AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS ?? "64000") };
  const deps = { environment, codeFingerprint: options.codeFingerprint ?? codeFingerprint };
  if (!options.environment && (environment.model !== 'ai-slg-game-model' || environment.inputMaxEstimatedTokens !== 64000)) throw Error('P2_FROZEN_MODEL_REQUIRED');
  if (input.mode === 'register') {
    await run(input, deps);
    return { registered: true, plannedRoutes: 2, completedRoutes: 0, passed: false };
  }
  const protocol = readNarrativeP2Protocol(resolve(input.protocolPath));
  if (canonicalP2(protocol) !== canonicalP2(createNarrativeP2Protocol(input.runId, deps))) throw Error('P2_FROZEN_CONFIGURATION_MISMATCH');
  const { replayP2Stage, reviewP2Stage, p2BatchStatus, inspectP2Quality } = await import('./narrativeP2Quality.mjs');
  const directory = resolve(input.outputDirectory);
  if (input.mode === 'replay') {
    const source = resolve(input.replaySource || dirname(input.protocolPath));
    const result = await replayP2Stage(protocol, input.stage, source, directory);
    return { ...await p2BatchStatus(protocol, source), machineCompleted: result.inspection.completed, strictReplayPassed: result.strictReplayPassed, replaySegments: result.segments };
  }
  if (input.mode === 'review') {
    const result = await reviewP2Stage(protocol, input.stage, directory, JSON.parse(readFileSync(input.reviewPath, 'utf8')));
    return { ...await p2BatchStatus(protocol, directory), stageResult: result };
  }
  const stageRunner = await (await import('./narrativeP2Stage.mjs')).createNarrativeP2StageRunner(env);
  try {
    const result = await stageRunner({ protocol, stage: input.stage, directory, resume: input.mode === 'resume',
      ...(input.reviewPath ? { review: JSON.parse(readFileSync(input.reviewPath, 'utf8')) } : {}) });
    const inspection = await inspectP2Quality(protocol, input.stage, directory);
    return { ...await p2BatchStatus(protocol, directory), machineCompleted: result.completed, pauseReason: result.pauseReason,
      identity: result.pauseReason === 'terminal_quality' ? inspection.identity : result.identity,
      history: inspection.history, candidates: inspection.candidates, steps: result.steps, counters: result.counters };
  } catch (error) {
    return { ...await p2BatchStatus(protocol, directory), passed: false, failureCode: error.message };
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseNarrativeP2Args(process.argv.slice(2));
    const result = await runNarrativeP2Journey({ mode: args.mode, runId: args.runId, protocolPath: args.protocol, outputDirectory: args.output, replaySource: args.replaySource, reviewPath: args.review, stage: args.stage || undefined });
    console.log(`[narrative-p2] ${JSON.stringify(result)}`); process.exitCode = result.failureCode || result.stageResult?.passed === false ? 1 : 0;
  } catch (error) { console.error(`[narrative-p2] ${error.message}`); process.exitCode = 1; }
}
