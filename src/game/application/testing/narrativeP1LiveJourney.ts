import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NewGameInput, ValidatedNewGameInput } from "@/game/domain/newGame";
import { validateNewGameInput } from "@/game/domain/newGame";

export const NARRATIVE_P1_PROTOCOL_VERSION = "narrative-p1/v1" as const;
export const NARRATIVE_P1_PLANNED_ROUTES = 6 as const;
export const NARRATIVE_P1_HTTP_BATCH_BUDGET = 1000 as const;
export const NARRATIVE_P1_MAX_ROUTE_ACTIONS = 24 as const;
export const NARRATIVE_P1_MAX_CANDIDATE_VERSIONS = 3 as const;

export type NarrativeP1JourneyMode = "register" | "live" | "replay";
export type NarrativeP1ScenarioId = "S1" | "S2";
export type NarrativeP1RouteKind = "private" | "public" | "verify_first";

export type NarrativeP1Route = Readonly<{
  readonly routeId: `${NarrativeP1ScenarioId}-${NarrativeP1RouteKind}`;
  readonly scenarioId: NarrativeP1ScenarioId;
  readonly kind: NarrativeP1RouteKind;
}>;

export const NARRATIVE_P1_ROUTES: readonly NarrativeP1Route[] = Object.freeze([
  { routeId: "S1-private", scenarioId: "S1", kind: "private" },
  { routeId: "S1-public", scenarioId: "S1", kind: "public" },
  { routeId: "S1-verify_first", scenarioId: "S1", kind: "verify_first" },
  { routeId: "S2-private", scenarioId: "S2", kind: "private" },
  { routeId: "S2-public", scenarioId: "S2", kind: "public" },
  { routeId: "S2-verify_first", scenarioId: "S2", kind: "verify_first" },
]);

export const NARRATIVE_P1_NEW_GAME_INPUT: NewGameInput = Object.freeze({
  gameType: "wuxia",
  characterName: "沈行",
  characterIdentity: "曾受老信使帮助的过路旅人",
  characterProfile: "愿意帮助他人，但在交付重要物品前会核实身份。",
  personalityTags: ["谨慎", "守信"],
  worldPremise: "江湖渡口附近有一座破庙和一间客栈。有人追查一份证词的来历，公开调查可能暴露老信使的行踪。",
  storyOpening: "我在破庙得到老信使帮助，接受将唯一信筒交给渡口接应人的委托。我需要决定私下寻求引荐，还是通过公开渠道核验；也可以先核实接应人的身份再交付，或承担后果退出委托。",
  narrativeStyle: "novel",
  contentIntensity: "normal",
  gameLength: "short",
});

export type NarrativeP1HttpBudget = Readonly<{
  readonly max: number;
  readonly used: number;
  reserve(): boolean;
}>;

export function createNarrativeP1HttpBudget(max = NARRATIVE_P1_HTTP_BATCH_BUDGET): NarrativeP1HttpBudget {
  let used = 0;
  return {
    max,
    get used() { return used; },
    reserve() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
  };
}

export type NarrativeP1RouteRunnerInput = Readonly<{
  readonly mode: Exclude<NarrativeP1JourneyMode, "register">;
  readonly route: NarrativeP1Route;
  readonly setup: ValidatedNewGameInput;
  readonly budget: NarrativeP1HttpBudget;
  readonly artifactDirectory: string;
}>;

export type NarrativeP1RouteRunnerResult = Readonly<{
  readonly completed: boolean;
  readonly httpAttempts: number;
  readonly failureCode?: string;
  readonly actionCount?: number;
}>;

export type NarrativeP1JourneyEnvironment = Readonly<{
  readonly model: string;
  readonly apiBaseUrl: string;
}>;

export type NarrativeP1JourneyDeps = Readonly<{
  /** Test seam; production defaults to the composition/SQLite route runner. */
  readonly routeRunner?: (input: NarrativeP1RouteRunnerInput) => Promise<NarrativeP1RouteRunnerResult>;
  /** Frozen code identity. A changed identity refuses live/replay before I/O. */
  readonly codeFingerprint?: string;
  /** Non-secret provider configuration captured in the protocol. */
  readonly environment?: Partial<NarrativeP1JourneyEnvironment>;
}>;

export type NarrativeP1Protocol = Readonly<{
  readonly protocolVersion: typeof NARRATIVE_P1_PROTOCOL_VERSION;
  readonly plannedRoutes: typeof NARRATIVE_P1_PLANNED_ROUTES;
  readonly routes: readonly NarrativeP1Route[];
  readonly input: ValidatedNewGameInput;
  readonly inputHash: string;
  readonly policy: Readonly<{
    readonly jsonMode: "prompt_only";
    readonly thinking: "enabled";
    readonly reasoningEffort: "low";
    readonly temperature: null;
    readonly maxTokens: null;
    readonly authorTimeoutMs: 240_000;
    readonly npcTimeoutMs: 240_000;
    readonly reviewTimeoutMs: 240_000;
    readonly transportAttempts: 2;
  }>;
  readonly budget: Readonly<{
    readonly httpPerEpoch: 24;
    readonly httpBatch: typeof NARRATIVE_P1_HTTP_BATCH_BUDGET;
    readonly maxRouteActions: typeof NARRATIVE_P1_MAX_ROUTE_ACTIONS;
    readonly maxCandidateVersions: typeof NARRATIVE_P1_MAX_CANDIDATE_VERSIONS;
  }>;
  readonly environment: NarrativeP1JourneyEnvironment;
  readonly code: Readonly<{
    readonly fingerprint: string;
    readonly commit: string;
    readonly dirtyDiffHash: string;
  }>;
  readonly protocolHash: string;
}>;

export type NarrativeP1JourneyInput = Readonly<{
  readonly mode: NarrativeP1JourneyMode;
  readonly runId: string;
  readonly protocolPath: string;
  readonly artifactDirectory: string;
}>;

export type NarrativeP1JourneyResult = Readonly<{
  readonly completedRoutes: number;
  readonly plannedRoutes: typeof NARRATIVE_P1_PLANNED_ROUTES;
  readonly passed: boolean;
}>;

type RouteArtifact = Readonly<{
  readonly routeId: string;
  readonly scenarioId: string;
  readonly kind: string;
  readonly completed: boolean;
  readonly httpAttempts: number;
  readonly actionCount?: number;
  readonly failureCode?: string;
}>;

const FIXED_POLICY = Object.freeze({
  jsonMode: "prompt_only" as const,
  thinking: "enabled" as const,
  reasoningEffort: "low" as const,
  temperature: null,
  maxTokens: null,
  authorTimeoutMs: 240_000 as const,
  npcTimeoutMs: 240_000 as const,
  reviewTimeoutMs: 240_000 as const,
  transportAttempts: 2 as const,
});

const FIXED_BUDGET = Object.freeze({
  httpPerEpoch: 24 as const,
  httpBatch: NARRATIVE_P1_HTTP_BATCH_BUDGET,
  maxRouteActions: NARRATIVE_P1_MAX_ROUTE_ACTIONS,
  maxCandidateVersions: NARRATIVE_P1_MAX_CANDIDATE_VERSIONS,
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function currentCodeFingerprint(deps: NarrativeP1JourneyDeps): string {
  return deps.codeFingerprint ?? "narrative-p1-code-unbound";
}

function currentEnvironment(deps: NarrativeP1JourneyDeps): NarrativeP1JourneyEnvironment {
  return {
    model: deps.environment?.model?.trim() || "unconfigured-model",
    apiBaseUrl: deps.environment?.apiBaseUrl?.trim() || "https://unconfigured-provider.invalid",
  };
}

function validatedFixedInput(): ValidatedNewGameInput | null {
  const result = validateNewGameInput(NARRATIVE_P1_NEW_GAME_INPUT);
  return result.ok ? result.value : null;
}

function protocolWithoutHash(protocol: NarrativeP1Protocol | Omit<NarrativeP1Protocol, "protocolHash">): Omit<NarrativeP1Protocol, "protocolHash"> {
  const { protocolHash: _protocolHash, ...withoutHash } = protocol as NarrativeP1Protocol;
  return withoutHash as Omit<NarrativeP1Protocol, "protocolHash">;
}

function createProtocol(deps: NarrativeP1JourneyDeps): NarrativeP1Protocol | null {
  const input = validatedFixedInput();
  if (input === null) return null;
  const codeFingerprint = currentCodeFingerprint(deps);
  const protocol = {
    protocolVersion: NARRATIVE_P1_PROTOCOL_VERSION,
    plannedRoutes: NARRATIVE_P1_PLANNED_ROUTES,
    routes: NARRATIVE_P1_ROUTES,
    input,
    inputHash: sha256(input),
    policy: FIXED_POLICY,
    budget: FIXED_BUDGET,
    environment: currentEnvironment(deps),
    code: {
      fingerprint: codeFingerprint,
      commit: codeFingerprint,
      dirtyDiffHash: "not-captured",
    },
  } satisfies Omit<NarrativeP1Protocol, "protocolHash">;
  return {
    ...protocol,
    protocolHash: sha256(protocolWithoutHash(protocol)),
  };
}

function readJson(path: string): unknown | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown; } catch { return null; }
}

export function validateNarrativeP1Protocol(
  value: unknown,
  expectedCodeFingerprint: string,
): readonly string[] {
  if (value === null || typeof value !== "object") return ["PROTOCOL_MISSING"];
  const protocol = value as Partial<NarrativeP1Protocol>;
  const issues: string[] = [];
  if (protocol.protocolVersion !== NARRATIVE_P1_PROTOCOL_VERSION) issues.push("PROTOCOL_VERSION_MISMATCH");
  if (protocol.plannedRoutes !== NARRATIVE_P1_PLANNED_ROUTES) issues.push("PLANNED_ROUTES_MISMATCH");
  if (!Array.isArray(protocol.routes) || canonicalJson(protocol.routes) !== canonicalJson(NARRATIVE_P1_ROUTES)) issues.push("ROUTES_MISMATCH");
  if (protocol.inputHash !== sha256(protocol.input)) issues.push("INPUT_HASH_MISMATCH");
  if (protocol.code?.fingerprint !== expectedCodeFingerprint) issues.push("CODE_FINGERPRINT_MISMATCH");
  if (canonicalJson(protocol.policy) !== canonicalJson(FIXED_POLICY)) issues.push("POLICY_MISMATCH");
  if (canonicalJson(protocol.budget) !== canonicalJson(FIXED_BUDGET)) issues.push("BUDGET_MISMATCH");
  const fixedInput = validatedFixedInput();
  if (fixedInput === null || canonicalJson(protocol.input) !== canonicalJson(fixedInput)) issues.push("FIXED_INPUT_MISMATCH");
  if (protocol.environment?.model === undefined || protocol.environment.model.trim() === "" || protocol.environment.model === "unconfigured-model") issues.push("MODEL_MISSING");
  if (protocol.environment?.apiBaseUrl === undefined || protocol.environment.apiBaseUrl.trim() === "" || protocol.environment.apiBaseUrl === "https://unconfigured-provider.invalid") issues.push("API_BASE_MISSING");
  const expectedHash = protocolWithoutHash(protocol as Omit<NarrativeP1Protocol, "protocolHash">);
  if (typeof protocol.protocolHash !== "string" || protocol.protocolHash !== sha256(expectedHash)) issues.push("PROTOCOL_HASH_MISMATCH");
  const inputResult = protocol.input === undefined ? null : validateNewGameInput(protocol.input as NewGameInput);
  if (inputResult === null || !inputResult.ok) issues.push("INPUT_INVALID");
  else if (canonicalJson(inputResult.value) !== canonicalJson(protocol.input)) issues.push("INPUT_NOT_NORMALIZED");
  return issues;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function result(completedRoutes: number, passed: boolean): NarrativeP1JourneyResult {
  return {
    completedRoutes,
    plannedRoutes: NARRATIVE_P1_PLANNED_ROUTES,
    passed,
  };
}

async function defaultRouteRunner(input: NarrativeP1RouteRunnerInput): Promise<NarrativeP1RouteRunnerResult> {
  if (input.mode === "replay") {
    const replay = readJson(join(input.artifactDirectory, "replay-routes.json"));
    if (replay !== null && typeof replay === "object") {
      const record = (replay as Record<string, unknown>)[input.route.routeId];
      if (record !== null && typeof record === "object") {
        const candidate = record as Record<string, unknown>;
        return {
          completed: candidate.completed === true,
          httpAttempts: typeof candidate.httpAttempts === "number" ? candidate.httpAttempts : 0,
          ...(typeof candidate.failureCode === "string" ? { failureCode: candidate.failureCode } : {}),
        };
      }
    }
    return { completed: false, httpAttempts: 0, failureCode: "REPLAY_RESPONSES_MISSING" };
  }

  return { completed: false, httpAttempts: 0, failureCode: "LIVE_ROUTE_RUNNER_NOT_INJECTED" };
}

export async function runNarrativeP1Journey(
  input: NarrativeP1JourneyInput,
  deps: NarrativeP1JourneyDeps = {},
): Promise<NarrativeP1JourneyResult> {
  if (input.runId.trim() === "") return result(0, false);
  if (input.mode === "register") {
    const protocol = createProtocol(deps);
    if (protocol === null) return result(0, false);
    writeJson(input.protocolPath, protocol);
    writeJson(join(input.artifactDirectory, "registration.json"), {
      protocolVersion: protocol.protocolVersion,
      protocolHash: protocol.protocolHash,
      plannedRoutes: protocol.plannedRoutes,
      runId: input.runId,
    });
    return result(0, true);
  }

  const protocolValue = readJson(input.protocolPath);
  const issues = validateNarrativeP1Protocol(protocolValue, currentCodeFingerprint(deps));
  if (issues.length > 0 || protocolValue === null || typeof protocolValue !== "object") return result(0, false);
  const protocol = protocolValue as NarrativeP1Protocol;
  const validatedInput = validateNewGameInput(protocol.input);
  if (!validatedInput.ok) return result(0, false);
  const budget = createNarrativeP1HttpBudget();
  const routeRunner = deps.routeRunner ?? defaultRouteRunner;
  const routeArtifacts: RouteArtifact[] = [];
  let completedRoutes = 0;
  let reportedHttpAttempts = 0;
  for (const route of NARRATIVE_P1_ROUTES) {
    let routeResult: NarrativeP1RouteRunnerResult;
    try {
      routeResult = await routeRunner({ mode: input.mode, route, setup: validatedInput.value, budget, artifactDirectory: input.artifactDirectory });
    } catch {
      routeResult = { completed: false, httpAttempts: 0, failureCode: "ROUTE_RUNNER_CRASHED" };
    }
    if (routeResult.completed) completedRoutes += 1;
    reportedHttpAttempts += Math.max(0, routeResult.httpAttempts);
    routeArtifacts.push({
      routeId: route.routeId,
      scenarioId: route.scenarioId,
      kind: route.kind,
      completed: routeResult.completed,
      httpAttempts: routeResult.httpAttempts,
      ...(routeResult.actionCount === undefined ? {} : { actionCount: routeResult.actionCount }),
      ...(routeResult.failureCode === undefined ? {} : { failureCode: routeResult.failureCode }),
    });
  }
  const passed = completedRoutes === NARRATIVE_P1_PLANNED_ROUTES
    && budget.used <= NARRATIVE_P1_HTTP_BATCH_BUDGET
    && reportedHttpAttempts <= NARRATIVE_P1_HTTP_BATCH_BUDGET;
  const replayRoutes = Object.fromEntries(routeArtifacts.map((route) => [route.routeId, {
    completed: route.completed,
    httpAttempts: route.httpAttempts,
    ...(route.failureCode === undefined ? {} : { failureCode: route.failureCode }),
  }]));
  writeJson(join(input.artifactDirectory, "replay-routes.json"), replayRoutes);
  writeJson(join(input.artifactDirectory, "summary.json"), {
    protocolHash: protocol.protocolHash,
    runId: input.runId,
    mode: input.mode,
    input: protocol.input,
    environment: protocol.environment,
    code: protocol.code,
    plannedRoutes: NARRATIVE_P1_PLANNED_ROUTES,
    completedRoutes,
    passed,
    httpAttempts: budget.used,
    routes: routeArtifacts,
  });
  return result(completedRoutes, passed);
}
