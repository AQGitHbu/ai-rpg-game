#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const NARRATIVE_P2_PROTOCOL_VERSION = "narrative-p2/v1";
export const NARRATIVE_P2_ROUTES = Object.freeze([
  { routeId: "S-short", gameLength: "short", acts: 3 },
  { routeId: "M-medium", gameLength: "medium", acts: 5 },
]);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function hash(value) { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function protocolWithoutHash(value) { const rest = { ...value }; delete rest.protocolHash; return rest; }

export function parseNarrativeP2Args(argv) {
  const result = { mode: "replay", runId: "", protocol: "", output: "", replaySource: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) continue;
    const equal = argument.indexOf("=");
    const key = equal >= 0 ? argument.slice(2, equal) : argument.slice(2);
    const value = equal >= 0 ? argument.slice(equal + 1) : argv[++index];
    if (key === "mode") result.mode = value ?? "";
    if (key === "run-id") result.runId = value ?? "";
    if (key === "protocol") result.protocol = value ?? "";
    if (key === "output") result.output = value ?? "";
    if (key === "replay-source") result.replaySource = value ?? "";
  }
  return result;
}

export function validateNarrativeP2Args(args) {
  if (!["register", "live", "replay"].includes(args?.mode)) return "INVALID_MODE";
  if (!args?.runId?.trim()) return "MISSING_RUN_ID";
  if (!args?.protocol?.trim()) return "MISSING_PROTOCOL";
  if (!args?.output?.trim()) return "MISSING_OUTPUT";
  return null;
}

function makeProtocol(runId) {
  const protocol = {
    protocolVersion: NARRATIVE_P2_PROTOCOL_VERSION,
    runId,
    plannedRoutes: 2,
    routes: NARRATIVE_P2_ROUTES,
    input: {
      gameType: "wuxia", gameLength: "medium", characterName: "沈行", characterIdentity: "受托递送书信的旅人",
      characterProfile: "愿意听取不同意见并记住先前约定", personalityTags: ["谨慎", "守信"],
      worldPremise: "沿途数个聚落之间往来书信，人物各有立场，委托可由实际交付完成。",
      storyOpening: "我接受一封公开书信的递送委托。请明确委托人的理由与接收约定，沿途人物的不同意见应围绕这次递送；我会在后段回想早先的话，再决定完成交付。",
      narrativeStyle: "novel", contentIntensity: "normal",
    },
    policy: { summaryThreshold: 50, summaryBatchSize: 10, summaryHttpPerEpoch: 8, summaryBatchUpdatesPerEpoch: 2, promptMaxEstimatedTokens: 64000 },
    environment: { model: process.env.AI_MODEL?.trim() || "unconfigured-model", apiBaseUrl: process.env.AI_API_BASE_URL?.trim() || "https://unconfigured-provider.invalid" },
  };
  return { ...protocol, protocolHash: hash(protocol) };
}

export async function runNarrativeP2Journey(input) {
  const issue = validateNarrativeP2Args({ mode: input.mode, runId: input.runId, protocol: input.protocolPath, output: input.outputDirectory });
  if (issue) throw new Error(issue);
  if (input.mode === "live" && process.env.RUN_REAL_AI_JOURNEY !== "1") throw new Error("P2_LIVE_REQUIRES_RUN_REAL_AI_JOURNEY");
  mkdirSync(resolve(input.outputDirectory), { recursive: true });
  if (input.mode === "register") {
    const protocol = makeProtocol(input.runId);
    mkdirSync(dirname(resolve(input.protocolPath)), { recursive: true });
    writeFileSync(resolve(input.protocolPath), `${JSON.stringify(protocol, null, 2)}\n`);
    return { plannedRoutes: 2, completedRoutes: 0, passed: true };
  }
  const protocol = JSON.parse(readFileSync(resolve(input.protocolPath), "utf8"));
  if (protocol.protocolVersion !== NARRATIVE_P2_PROTOCOL_VERSION || protocol.protocolHash !== hash(protocolWithoutHash(protocol))) throw new Error("P2_PROTOCOL_HASH_MISMATCH");
  const source = resolve(input.replaySource || input.outputDirectory);
  const completedRoutes = NARRATIVE_P2_ROUTES.filter((route) => {
    try { return JSON.parse(readFileSync(resolve(source, `${route.routeId}.json`), "utf8")).completed === true; } catch { return false; }
  }).length;
  if (input.mode === "live") throw new Error("P2_LIVE_DRIVER_NOT_CONFIGURED");
  return { plannedRoutes: 2, completedRoutes, passed: completedRoutes === 2 };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = parseNarrativeP2Args(process.argv.slice(2));
  runNarrativeP2Journey({ mode: args.mode, runId: args.runId, protocolPath: args.protocol, outputDirectory: args.output, replaySource: args.replaySource })
    .then((result) => { console.log(`[narrative-p2] ${JSON.stringify(result)}`); process.exitCode = result.passed ? 0 : 1; })
    .catch((error) => { console.error(`[narrative-p2] ${error.message}`); process.exitCode = 1; });
}
