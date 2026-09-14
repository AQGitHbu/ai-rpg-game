import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const NARRATIVE_P2_PROTOCOL_VERSION = "narrative-p2/v1" as const;
export const NARRATIVE_P2_PLANNED_ROUTES = 2 as const;

export type NarrativeP2JourneyInput = Readonly<{
  readonly mode: "register" | "live" | "replay";
  readonly runId: string;
  readonly protocolPath: string;
  readonly outputDirectory: string;
  readonly replaySource?: string;
}>;

export type NarrativeP2JourneyResult = Readonly<{
  readonly plannedRoutes: 2;
  readonly completedRoutes: number;
  readonly passed: boolean;
}>;

export const NARRATIVE_P2_ROUTES = Object.freeze([
  { routeId: "S-short", gameLength: "short" as const, acts: 3 },
  { routeId: "M-medium", gameLength: "medium" as const, acts: 5 },
]);

export const NARRATIVE_P2_INPUT = Object.freeze({
  gameType: "wuxia" as const,
  characterName: "沈行",
  characterIdentity: "受托递送书信的旅人",
  characterProfile: "愿意听取不同意见并记住先前约定",
  personalityTags: ["谨慎", "守信"],
  worldPremise: "沿途数个聚落之间往来书信，人物各有立场，委托可由实际交付完成。",
  storyOpening: "我接受一封公开书信的递送委托。请明确委托人的理由与接收约定，沿途人物的不同意见应围绕这次递送；我会在后段回想早先的话，再决定完成交付。",
  narrativeStyle: "novel" as const,
  contentIntensity: "normal" as const,
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function protocolWithoutHash(value: Record<string, unknown>): Record<string, unknown> {
  const { protocolHash: _protocolHash, ...rest } = value;
  return rest;
}

function protocolFor(input: NarrativeP2JourneyInput): Record<string, unknown> {
  const protocol = {
    protocolVersion: NARRATIVE_P2_PROTOCOL_VERSION,
    runId: input.runId,
    plannedRoutes: NARRATIVE_P2_PLANNED_ROUTES,
    routes: NARRATIVE_P2_ROUTES,
    input: NARRATIVE_P2_INPUT,
    policy: {
      summaryThreshold: 50,
      summaryBatchSize: 10,
      summaryHttpPerEpoch: 8,
      summaryBatchUpdatesPerEpoch: 2,
      rawSoftEstimatedTokens: 24_000,
      summarySourceMaxEstimatedTokens: 24_000,
      overviewMaxEstimatedTokens: 6_000,
      promptMaxEstimatedTokens: 64_000,
      transportAttempts: 2,
    },
    budget: {
      short: { actions: 24, http: 200, wallClockMs: 5_400_000 },
      medium: { actions: 48, http: 500, wallClockMs: 10_800_000 },
    },
    environment: {
      model: "unconfigured-model",
      apiBaseUrl: "https://unconfigured-provider.invalid",
    },
  };
  return { ...protocol, protocolHash: hash(protocol) };
}

function readAndValidateProtocol(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("P2_PROTOCOL_INVALID");
  const protocol = value as Record<string, unknown>;
  if (protocol.protocolVersion !== NARRATIVE_P2_PROTOCOL_VERSION || protocol.protocolHash !== hash(protocolWithoutHash(protocol))) throw new Error("P2_PROTOCOL_HASH_MISMATCH");
  return protocol;
}

export async function runNarrativeP2Journey(input: NarrativeP2JourneyInput): Promise<NarrativeP2JourneyResult> {
  if (!input.runId.trim()) throw new Error("MISSING_RUN_ID");
  mkdirSync(resolve(input.outputDirectory), { recursive: true });
  if (input.mode === "register") {
    const protocol = protocolFor(input);
    mkdirSync(dirname(resolve(input.protocolPath)), { recursive: true });
    writeFileSync(resolve(input.protocolPath), `${JSON.stringify(protocol, null, 2)}\n`, "utf8");
    return { plannedRoutes: 2, completedRoutes: 0, passed: true };
  }
  const protocol = readAndValidateProtocol(resolve(input.protocolPath));
  if (input.mode === "replay") {
    const completedRoutes = NARRATIVE_P2_ROUTES.filter((route) => {
      try {
        const artifact = JSON.parse(readFileSync(resolve(input.replaySource ?? input.outputDirectory, `${route.routeId}.json`), "utf8")) as { completed?: unknown };
        return artifact.completed === true;
      } catch { return false; }
    }).length;
    return { plannedRoutes: Number(protocol.plannedRoutes) === 2 ? 2 : 2, completedRoutes, passed: completedRoutes === 2 };
  }
  // The live route executor is intentionally not implicit: it must be frozen
  // together with its transport tape by the acceptance runner.
  throw new Error("P2_LIVE_DRIVER_NOT_CONFIGURED");
}
