import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const NARRATIVE_P3_PROTOCOL_VERSION = "narrative-p3/v1" as const;
export const NARRATIVE_P3_PLANNED_ROUTES = 2 as const;

export const NARRATIVE_P3_INPUT = Object.freeze({
  gameType: "wuxia" as const,
  gameLength: "short" as const,
  characterName: "沈砚",
  characterIdentity: "受托保管旧契、需要在渡口辨认见证人的旅人",
  characterProfile: "谨慎、守信，先核对证据再决定是否公开",
  personalityTags: ["谨慎", "守信"] as readonly string[],
  worldPremise: "渡口保存一份旧契，证人和接应人对交付条件各有记忆；查验方式会改变谁愿意继续合作。",
  storyOpening: "我接下旧契与证人的委托。请先让我从现场提供的合法方法中选择查验方式，再根据实际证据决定是否告知、核验并完成交付。本协议要求在第一幕推进时（初始化开局保持普通 town 开场，调查必须落在随后独立 scene）实际创建一个未发现、可主动调查的事实，并用 consequenceBindings.bind_investigation（discoveryMode=investigation）激活恰好 2–3 个合法方法；其中至少一条不需要额外见证，至少一条由该 scene 的新 NPC 在场见证；仅写 investigationApproaches 或使用 automatic 事实不满足。",
  narrativeStyle: "novel" as const,
  contentIntensity: "normal" as const,
});

export const NARRATIVE_P3_ROUTES = Object.freeze([
  Object.freeze({
    routeId: "private" as const,
    scenarioId: "shared-three-act-opening" as const,
    strategy: "先用无额外见证的方法查阅原始记录，再决定告知范围。" as const,
    gameLength: "short" as const,
    acts: 3 as const,
    budget: Object.freeze({ actions: 32, http: 300, wallClockMs: 7_200_000 }),
  }),
  Object.freeze({
    routeId: "public" as const,
    scenarioId: "shared-three-act-opening" as const,
    strategy: "优先使用明确现场见证的方法，让后续合作建立在公开证据上。" as const,
    gameLength: "short" as const,
    acts: 3 as const,
    budget: Object.freeze({ actions: 32, http: 300, wallClockMs: 7_200_000 }),
  }),
] as const);

export const NARRATIVE_P3_BATCH_BUDGET = Object.freeze({ http: 600, wallClockMs: 10_800_000 });

export type NarrativeP3Route = (typeof NARRATIVE_P3_ROUTES)[number];
export type NarrativeP3RouteId = NarrativeP3Route["routeId"];
export type NarrativeP3RouteStatus = "completed" | "blocked" | "not_run";
export type NarrativeP3Environment = Readonly<{
  model: string;
  apiBaseUrl: string;
  inputMaxEstimatedTokens: number;
}>;
export type NarrativeP3RouteResult = Readonly<{
  status: NarrativeP3RouteStatus;
  completed: boolean;
  httpAttempts: number;
  actionCount: number;
  replayedTransportAttempts?: number;
  failureCode?: string;
}>;
export type NarrativeP3Protocol = Readonly<{
  protocolVersion: typeof NARRATIVE_P3_PROTOCOL_VERSION;
  runId: string;
  plannedRoutes: 2;
  input: typeof NARRATIVE_P3_INPUT;
  inputHash: string;
  routes: typeof NARRATIVE_P3_ROUTES;
  batchBudget: typeof NARRATIVE_P3_BATCH_BUDGET;
  transport: Readonly<Record<string, unknown>>;
  environment: NarrativeP3Environment;
  codeFingerprint: string;
  protocolHash: string;
}>;
export type NarrativeP3JourneyInput = Readonly<{
  mode: "register" | "live" | "replay";
  runId: string;
  protocolPath: string;
  outputDirectory: string;
  replaySource?: string;
}>;
export type NarrativeP3RouteRunnerInput = Readonly<{
  mode: "live" | "replay";
  route: NarrativeP3Route;
  protocol: NarrativeP3Protocol;
  outputDirectory: string;
  replaySource: string;
  signal?: AbortSignal;
}>;
export type NarrativeP3JourneyDeps = Readonly<{
  environment: NarrativeP3Environment;
  codeFingerprint: string;
}>;
export type NarrativeP3JourneyOptions = Readonly<{
  routeRunner?: (input: NarrativeP3RouteRunnerInput) => Promise<NarrativeP3RouteResult>;
}>;
export type NarrativeP3RouteSummary = Readonly<{
  routeId: NarrativeP3RouteId;
  status: NarrativeP3RouteStatus;
  completed?: boolean;
  httpAttempts?: number;
  actionCount?: number;
  failureCode?: string;
}>;
export type NarrativeP3JourneyResult = Readonly<{
  plannedRoutes: 2;
  routes: readonly NarrativeP3RouteSummary[];
  completedRoutes: number;
  httpAttempts: number;
  strictReplayPassed?: boolean;
  passed: boolean;
}>;

export function canonicalP3(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalP3).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalP3(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const hashP3 = (value: unknown): string => createHash("sha256").update(canonicalP3(value)).digest("hex");

function assertEnvironment(environment: NarrativeP3Environment, codeFingerprint: string): void {
  let providerUrl: URL;
  try { providerUrl = new URL(environment.apiBaseUrl); } catch { throw new Error("P3_CONFIGURATION_REQUIRED"); }
  if (providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash) throw new Error("P3_PROVIDER_URL_MUST_NOT_CONTAIN_CREDENTIALS");
  if (!codeFingerprint.trim() || !environment.model.trim() || !/^https?:\/\//.test(environment.apiBaseUrl)
    || !Number.isSafeInteger(environment.inputMaxEstimatedTokens) || environment.inputMaxEstimatedTokens <= 0) throw new Error("P3_CONFIGURATION_REQUIRED");
}

export function createNarrativeP3Protocol(runId: string, deps: NarrativeP3JourneyDeps): NarrativeP3Protocol {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(runId)) throw new Error("INVALID_RUN_ID");
  assertEnvironment(deps.environment, deps.codeFingerprint);
  const body = {
    protocolVersion: NARRATIVE_P3_PROTOCOL_VERSION,
    runId,
    plannedRoutes: NARRATIVE_P3_PLANNED_ROUTES,
    input: NARRATIVE_P3_INPUT,
    inputHash: hashP3(NARRATIVE_P3_INPUT),
    routes: NARRATIVE_P3_ROUTES,
    batchBudget: NARRATIVE_P3_BATCH_BUDGET,
    transport: {
      jsonMode: "prompt_only",
      thinking: "on",
      reasoningEffort: "low",
      temperature: null,
      maxTokens: null,
      timeoutMs: 240_000,
      transportAttempts: 2,
      candidatesPerEpoch: 3,
      narrativeHttpPerEpoch: 32,
    },
    environment: deps.environment,
    codeFingerprint: deps.codeFingerprint,
  };
  return { ...body, protocolHash: hashP3(body) };
}

export function readNarrativeP3Protocol(path: string): NarrativeP3Protocol {
  const protocol = JSON.parse(readFileSync(path, "utf8")) as NarrativeP3Protocol;
  const { protocolHash, ...body } = protocol;
  if (protocol.protocolVersion !== NARRATIVE_P3_PROTOCOL_VERSION || protocol.plannedRoutes !== NARRATIVE_P3_PLANNED_ROUTES) throw new Error("P3_PROTOCOL_VERSION_UNSUPPORTED");
  if (protocolHash !== hashP3(body)) throw new Error("P3_PROTOCOL_HASH_MISMATCH");
  if (canonicalP3(protocol.routes) !== canonicalP3(NARRATIVE_P3_ROUTES)) throw new Error("P3_ROUTE_PLAN_MISMATCH");
  return protocol;
}

type P3ActionCandidate = Readonly<{
  choiceToken: string;
  label: string;
  action: Readonly<{ type: string; approachId?: string }>;
}>;

export function selectNarrativeP3Action(input: Readonly<{
  route: NarrativeP3RouteId;
  actions: readonly P3ActionCandidate[];
}>): P3ActionCandidate {
  const approachId = input.route === "private" ? "quiet" : "witnessed";
  const selected = input.actions.find((candidate) => candidate.action.type === "investigate" && candidate.action.approachId === approachId);
  if (selected === undefined) throw new Error("P3_CAPABILITY_COVERAGE_FAILED");
  return selected;
}

function routeStatus(result: NarrativeP3RouteResult): NarrativeP3RouteStatus {
  if (!Number.isSafeInteger(result.httpAttempts) || result.httpAttempts < 0) throw new Error("P3_ROUTE_RESULT_INVALID");
  if (!Number.isSafeInteger(result.actionCount) || result.actionCount < 0) throw new Error("P3_ROUTE_RESULT_INVALID");
  if (!["completed", "blocked", "not_run"].includes(result.status)) throw new Error("P3_ROUTE_RESULT_INVALID");
  if (result.status === "completed" && !result.completed) throw new Error("P3_ROUTE_RESULT_INVALID");
  if (result.status === "not_run" && result.completed) throw new Error("P3_ROUTE_RESULT_INVALID");
  return result.status;
}

function summarizeRoutes(results: readonly NarrativeP3RouteResult[], routes: typeof NARRATIVE_P3_ROUTES): NarrativeP3JourneyResult["routes"] {
  return routes.map((route, index) => {
    const result = results[index];
    if (result === undefined || routeStatus(result) === "not_run") return { routeId: route.routeId, status: "not_run" as const, completed: false, httpAttempts: 0, actionCount: 0 };
    return { routeId: route.routeId, status: routeStatus(result), completed: result.completed, httpAttempts: result.httpAttempts, actionCount: result.actionCount, ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }) };
  });
}

function writeRouteManifest(path: string, protocol: NarrativeP3Protocol, routes: NarrativeP3JourneyResult["routes"]): void {
  const body = { protocolVersion: protocol.protocolVersion, protocolHash: protocol.protocolHash, plannedRoutes: protocol.plannedRoutes, routes };
  writeFileSync(path, `${JSON.stringify({ ...body, hash: hashP3(body) }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function readRouteManifest(path: string, protocol: NarrativeP3Protocol): NarrativeP3JourneyResult["routes"] {
  let envelope: { protocolVersion: string; protocolHash: string; plannedRoutes: number; routes: NarrativeP3JourneyResult["routes"]; hash: string };
  try { envelope = JSON.parse(readFileSync(path, "utf8")) as typeof envelope; } catch { throw new Error("P3_ROUTE_MANIFEST_INVALID"); }
  const { hash, ...body } = envelope;
  if (hash !== hashP3(body) || envelope.protocolVersion !== protocol.protocolVersion || envelope.protocolHash !== protocol.protocolHash
    || envelope.plannedRoutes !== protocol.plannedRoutes || !Array.isArray(envelope.routes) || envelope.routes.length !== protocol.plannedRoutes) throw new Error("P3_ROUTE_MANIFEST_INVALID");
  for (const [index, route] of envelope.routes.entries()) {
    const expected = protocol.routes[index];
    if (route?.routeId !== expected?.routeId || !["completed", "blocked", "not_run"].includes(route.status)
      || (route.status === "completed" && route.completed !== true) || (route.status !== "completed" && route.completed === true)) throw new Error("P3_ROUTE_MANIFEST_INVALID");
  }
  return envelope.routes;
}

export async function runNarrativeP3Journey(
  input: NarrativeP3JourneyInput,
  deps: NarrativeP3JourneyDeps,
  options: NarrativeP3JourneyOptions = {},
): Promise<NarrativeP3JourneyResult> {
  const expected = createNarrativeP3Protocol(input.runId, deps);
  const outputDirectory = resolve(input.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  if (input.mode === "register") {
    mkdirSync(dirname(resolve(input.protocolPath)), { recursive: true });
    writeFileSync(resolve(input.protocolPath), `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { plannedRoutes: 2, routes: expected.routes.map((route) => ({ routeId: route.routeId, status: "not_run" as const })), completedRoutes: 0, httpAttempts: 0, passed: false };
  }
  const protocol = readNarrativeP3Protocol(resolve(input.protocolPath));
  if (canonicalP3(expected) !== canonicalP3(protocol)) throw new Error("P3_FROZEN_CONFIGURATION_MISMATCH");
  if (input.mode === "replay") {
    if (resolve(outputDirectory) === resolve(input.replaySource ?? dirname(input.protocolPath))) throw new Error("P3_REPLAY_OUTPUT_MUST_BE_SEPARATE");
    const recordedRoutes = readRouteManifest(resolve(input.replaySource ?? dirname(input.protocolPath), "routes.json"), protocol);
    if (options.routeRunner === undefined) throw new Error("P3_REPLAY_RUNNER_UNAVAILABLE");
    const replayedRoutes: NarrativeP3RouteSummary[] = [];
    for (const [index, route] of protocol.routes.entries()) {
      const recorded = recordedRoutes[index];
      const replayed = await options.routeRunner({ mode: "replay", route, protocol, outputDirectory, replaySource: input.replaySource ?? dirname(input.protocolPath) });
      const status = routeStatus(replayed);
      if (status !== recorded.status || replayed.completed !== recorded.completed || replayed.actionCount !== recorded.actionCount
        || replayed.failureCode !== recorded.failureCode || replayed.httpAttempts !== 0) throw new Error("P3_REPLAY_SEMANTIC_MISMATCH");
      replayedRoutes.push({ routeId: route.routeId, status, completed: replayed.completed, httpAttempts: 0, actionCount: replayed.actionCount, ...(replayed.failureCode === undefined ? {} : { failureCode: replayed.failureCode }) });
    }
    return { plannedRoutes: 2, routes: replayedRoutes, completedRoutes: replayedRoutes.filter((route) => route.status === "completed").length, httpAttempts: 0, strictReplayPassed: true, passed: replayedRoutes.every((route) => route.status === "completed") };
  }
  const routeRunner = options.routeRunner;
  const results: NarrativeP3RouteResult[] = [];
  let totalHttp = 0;
  const batchController = new AbortController();
  const batchTimer = setTimeout(() => batchController.abort(), protocol.batchBudget.wallClockMs);
  batchTimer.unref?.();
  for (const route of protocol.routes) {
    let result: NarrativeP3RouteResult;
    if (batchController.signal.aborted) {
      result = { status: "not_run", completed: false, httpAttempts: 0, actionCount: 0, failureCode: "P3_BATCH_WALL_CLOCK_EXHAUSTED" };
    } else if (routeRunner === undefined) {
      result = { status: "blocked", completed: false, httpAttempts: 0, actionCount: 0, failureCode: "P3_ROUTE_RUNNER_UNAVAILABLE" };
    } else {
      try {
        result = await routeRunner({ mode: "live", route, protocol, outputDirectory, replaySource: input.replaySource ?? outputDirectory, signal: batchController.signal });
      } catch {
        result = { status: "blocked", completed: false, httpAttempts: 0, actionCount: 0, failureCode: "P3_ROUTE_RUNNER_FAILED" };
      }
    }
    if (result.httpAttempts > route.budget.http || result.actionCount > route.budget.actions) result = { status: "blocked", completed: false, httpAttempts: result.httpAttempts, actionCount: result.actionCount, failureCode: "P3_ROUTE_BUDGET_EXHAUSTED" };
    results.push(result);
    totalHttp += result.httpAttempts;
    if (totalHttp > protocol.batchBudget.http) throw new Error("P3_BATCH_HTTP_BUDGET_EXHAUSTED");
  }
  clearTimeout(batchTimer);
  const routes = summarizeRoutes(results, protocol.routes);
  writeRouteManifest(resolve(outputDirectory, "routes.json"), protocol, routes);
  return { plannedRoutes: 2, routes, completedRoutes: routes.filter((route) => route.status === "completed").length, httpAttempts: totalHttp, passed: routes.every((route) => route.status === "completed") };
}
