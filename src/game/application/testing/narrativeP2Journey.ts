import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NARRATIVE_P2_TOPICS } from "./narrativeP2Topics";
import type { NarrativeMemoryPolicy } from "@/game/domain/narrativeMemoryContext";


export const NARRATIVE_P2_PROTOCOL_VERSION = "narrative-p2/v2" as const;
export const NARRATIVE_P2_PLANNED_ROUTES = 2 as const;
export const NARRATIVE_P2_ROUTES = Object.freeze([
  { routeId: "S-short", gameLength: "short" as const, acts: 3, budget: { actions: 24, http: 200, wallClockMs: 5_400_000 } },
  { routeId: "M-medium", gameLength: "medium" as const, acts: 5, budget: { actions: 48, http: 500, wallClockMs: 10_800_000 } },
]);
export const NARRATIVE_P2_INPUT = Object.freeze({
  gameType: "wuxia" as const, characterName: "沈行", characterIdentity: "受托递送书信的旅人",
  characterProfile: "愿意听取不同意见并记住先前约定", personalityTags: ["谨慎", "守信"],
  worldPremise: "沿途数个聚落之间往来书信，人物各有立场，委托可由实际交付完成。",
  storyOpening: "我接受一封公开书信的递送委托。请明确委托人的理由与接收约定，沿途人物的不同意见应围绕这次递送；我会在后段回想早先的话，再决定完成交付。",
  narrativeStyle: "novel" as const, contentIntensity: "normal" as const,
});
export const NARRATIVE_P2_RECALL = "最初委托人对这封信说过什么？我想先回想原话，再决定是否交付。";
export type NarrativeP2JourneyInput = Readonly<{
  mode: "register" | "live" | "replay"; stage?: "A" | "B"; runId: string; protocolPath: string; outputDirectory: string; replaySource?: string;
}>;
export type NarrativeP2JourneyResult = Readonly<{ plannedRoutes: 2; completedRoutes: number; passed: boolean }>;
export type NarrativeP2RouteResult = Readonly<{
  completed: boolean; coveragePassed: boolean; strictReplayPassed: boolean; httpAttempts: number;
  logicalAttempts: number; actionCount: number; failureCode?: string;
}>;
export type NarrativeP2Environment = Readonly<{ model: string; apiBaseUrl: string; inputMaxEstimatedTokens: number }>;
export const NARRATIVE_P2_STAGE_PLAN = Object.freeze({
  order: ["A", "B"], routeByStage: { A: "S-short", B: "M-medium" },
  admission: "B requires sealed A review and recomputed strict replay",
  initialization: "once per stage; absolute deadline includes all waits and restarts",
  topicPolicy: "three ordered topics per act before first formal response; stop act on human quality failure; no replacements",
  oracle: "first opening npc_line audible to player, fixed before any later action",
  ui: "B pauses before recall; same database, UUID action identity, remaining absolute route budget; UI recall then legal delivery and ending",
  qualityThreshold: { average: 4, minimum: 3, maximum: 5, hardErrors: 0 },
  totalRouteBudget: { actions: 72, http: 700, wallClockMs: 16_200_000 },
  branchCount: 2, branchBudgetScope: "per arm, diagnostics excluded from complete-route denominator",
  qualityDimensions: ["localContinuity", "motivation", "causalityAndSuspense", "visibleChoiceConsequences", "endingClosure"],
});
export type NarrativeP2Protocol = Readonly<{
  protocolVersion: typeof NARRATIVE_P2_PROTOCOL_VERSION; runId: string; plannedRoutes: 2;
  stages: typeof NARRATIVE_P2_STAGE_PLAN; topics: typeof NARRATIVE_P2_TOPICS;
  routes: typeof NARRATIVE_P2_ROUTES; input: typeof NARRATIVE_P2_INPUT; inputHash: string;
  policy: NarrativeMemoryPolicy; transport: Readonly<Record<string, unknown>>;
  recall: string; ablationBudget: Readonly<{ jobs: 1; http: 50; wallClockMs: 2_700_000 }>;
  environment: NarrativeP2Environment; codeFingerprint: string; protocolHash: string;
}>;
export type NarrativeP2RouteInput = Readonly<{
  mode: "live" | "replay"; route: (typeof NARRATIVE_P2_ROUTES)[number]; protocol: NarrativeP2Protocol;
  outputDirectory: string; replaySource: string;
}>;
export type NarrativeP2JourneyDeps = Readonly<{
  environment: NarrativeP2Environment; codeFingerprint: string;
  routeRunner?: (input: NarrativeP2RouteInput) => Promise<NarrativeP2RouteResult>;
}>;
export function canonicalP2(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalP2).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalP2(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const hashP2 = (value: unknown): string => createHash("sha256").update(canonicalP2(value)).digest("hex");
export function createNarrativeP2Protocol(runId: string, deps: NarrativeP2JourneyDeps): NarrativeP2Protocol {
  const environment = deps.environment;
  let providerUrl: URL;
  try { providerUrl = new URL(environment.apiBaseUrl); } catch { throw new Error("P2_CONFIGURATION_REQUIRED"); }
  if (providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash) throw new Error("P2_PROVIDER_URL_MUST_NOT_CONTAIN_CREDENTIALS");
  if (!deps.codeFingerprint.trim() || !environment.model.trim() || !/^https?:\/\//.test(environment.apiBaseUrl)
    || !Number.isSafeInteger(environment.inputMaxEstimatedTokens) || environment.inputMaxEstimatedTokens <= 0) throw new Error("P2_CONFIGURATION_REQUIRED");
  const protocol = {
    protocolVersion: NARRATIVE_P2_PROTOCOL_VERSION, stages: NARRATIVE_P2_STAGE_PLAN, topics: NARRATIVE_P2_TOPICS, runId, plannedRoutes: 2 as const, routes: NARRATIVE_P2_ROUTES,
    input: NARRATIVE_P2_INPUT, inputHash: hashP2(NARRATIVE_P2_INPUT),
    policy: { threshold: 50, batchSize: 10, rawSoftEstimatedTokens: 24_000, summarySourceMaxEstimatedTokens: 24_000, overviewMaxEstimatedTokens: 6_000, promptMaxEstimatedTokens: environment.inputMaxEstimatedTokens },
    transport: { jsonMode: "prompt_only", thinking: "on", reasoningEffort: "low", temperature: null, maxTokens: null,
      timeoutMs: 240_000, transportAttempts: 2, candidatesPerEpoch: 3, narrativeHttpPerEpoch: 24, summaryHttpPerEpoch: 8, summaryBatchUpdatesPerEpoch: 2 },
    recall: NARRATIVE_P2_RECALL, ablationBudget: { jobs: 1 as const, http: 50 as const, wallClockMs: 2_700_000 as const },
    environment, codeFingerprint: deps.codeFingerprint,
  };
  return { ...protocol, protocolHash: hashP2(protocol) };
}
export function readNarrativeP2Protocol(path: string): NarrativeP2Protocol {
  const protocol = JSON.parse(readFileSync(path, "utf8")) as NarrativeP2Protocol;
  const { protocolHash, ...body } = protocol;
  if (protocol.protocolVersion !== NARRATIVE_P2_PROTOCOL_VERSION) throw new Error("P2_PROTOCOL_VERSION_UNSUPPORTED_USE_FROZEN_IMPLEMENTATION");
  if (protocolHash !== hashP2(body)) throw new Error("P2_PROTOCOL_HASH_MISMATCH");
  return protocol;
}
export async function runNarrativeP2Journey(input: NarrativeP2JourneyInput, deps: NarrativeP2JourneyDeps): Promise<NarrativeP2JourneyResult> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(input.runId)) throw new Error("INVALID_RUN_ID");
  if (input.mode === "register" && input.stage) throw new Error("P2_REGISTER_HAS_NO_STAGE");
  const expected = createNarrativeP2Protocol(input.runId, deps);
  mkdirSync(resolve(input.outputDirectory), { recursive: true });
  if (input.mode === "register") {
    mkdirSync(dirname(resolve(input.protocolPath)), { recursive: true });
    writeFileSync(resolve(input.protocolPath), `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { plannedRoutes: 2, completedRoutes: 0, passed: true };
  }
  const protocol = readNarrativeP2Protocol(resolve(input.protocolPath));
  if (canonicalP2(expected) !== canonicalP2(protocol)) throw new Error("P2_FROZEN_CONFIGURATION_MISMATCH");
  if (input.stage !== "A" && input.stage !== "B") throw new Error("P2_STAGE_REQUIRED");
  // Admission remains closed until durable runtime and review gate are connected.
  throw new Error("P2_STAGE_RUNTIME_NOT_IMPLEMENTED");
}
