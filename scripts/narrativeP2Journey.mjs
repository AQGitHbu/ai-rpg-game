#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installTsHooks, freezeCurrentCodeIdentity } from "./narrativeP1Journey.mjs";
import { projectRoot, readAiEnv } from "./aiEnv.mjs";

// Protocol construction and validation live only in the TypeScript module.
export const NARRATIVE_P2_PROTOCOL_VERSION = "narrative-p2/v2";
export function parseNarrativeP2Args(argv) {
  const result = { mode: "replay", runId: "", protocol: "", output: "", replaySource: "", stage: "" };
  const keys = { stage: "stage", mode: "mode", "run-id": "runId", protocol: "protocol", output: "output", "replay-source": "replaySource" };
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
  if (!["register", "live", "replay"].includes(args?.mode)) return "INVALID_MODE";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(args?.runId ?? "")) return "INVALID_RUN_ID";
  if (!args?.protocol?.trim()) return "MISSING_PROTOCOL";
  if (!args?.output?.trim()) return "MISSING_OUTPUT";
  if (args.mode !== "register" && !["A", "B"].includes(args.stage)) return "P2_STAGE_REQUIRED";
  if (args.mode === "register" && args.stage) return "P2_REGISTER_HAS_NO_STAGE";
  return null;
}
export function freezeP2CodeIdentity() {
  freezeCurrentCodeIdentity();
  const configFiles = ["package.json", "package-lock.json", "tsconfig.json", ".ai-game-foundation.json"];
  const hash = createHash("sha256").update(process.env.NARRATIVE_P1_CODE_FINGERPRINT).update(process.version);
  for (const file of configFiles) {
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
  for (const key of ["AI_MODEL", "AI_API_BASE_URL", "AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS", ...(mode === "live" ? ["AI_API_KEY"] : [])]) {
    env[key] = process.env[key] ?? values.get(key)?.decoded;
  }
  return env;
}
export async function runNarrativeP2Journey(input, options = {}) {
  const issue = validateNarrativeP2Args({ mode: input.mode, runId: input.runId, protocol: input.protocolPath, output: input.outputDirectory, stage: input.stage });
  if (issue) throw new Error(issue);
  if (input.mode === "live" && process.env.RUN_REAL_AI_JOURNEY !== "1") throw new Error("P2_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY");
  if (input.mode === "replay" && resolve(input.outputDirectory) === resolve(input.replaySource || dirname(input.protocolPath))) throw new Error("P2_REPLAY_OUTPUT_MUST_BE_SEPARATE");
  installTsHooks();
  const codeFingerprint = freezeP2CodeIdentity();
  const { runNarrativeP2Journey: run } = await import("../src/game/application/testing/narrativeP2Journey.ts");
  const env = options.environment ?? configuredEnvironment(input.mode, input.protocolPath);
  const environment = { model: env.AI_MODEL?.trim() ?? "", apiBaseUrl: env.AI_API_BASE_URL?.trim() ?? "",
    inputMaxEstimatedTokens: Number(env.AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS ?? "64000") };
  const routeRunner = input.mode === "register" ? undefined : options.routeRunner
    ?? await (await import("./narrativeP2Production.mjs")).createNarrativeP2ProductionRunner(env);
  return run(input, { environment, codeFingerprint: options.codeFingerprint ?? codeFingerprint, ...(routeRunner ? { routeRunner } : {}) });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseNarrativeP2Args(process.argv.slice(2));
    const result = await runNarrativeP2Journey({ mode: args.mode, runId: args.runId, protocolPath: args.protocol, outputDirectory: args.output, replaySource: args.replaySource, stage: args.stage || undefined });
    console.log(`[narrative-p2] ${JSON.stringify(result)}`); process.exitCode = result.passed ? 0 : 1;
  } catch (error) { console.error(`[narrative-p2] ${error.message}`); process.exitCode = 1; }
}
