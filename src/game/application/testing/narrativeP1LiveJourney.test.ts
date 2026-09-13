import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  NARRATIVE_P1_PLANNED_ROUTES,
  createNarrativeP1HttpBudget,
  runNarrativeP1Journey,
  type NarrativeP1JourneyDeps,
  NARRATIVE_P1_BATCH_WALL_CLOCK_MS,
} from "./narrativeP1LiveJourney";

function tempPaths() {
  const root = mkdtempSync(join(tmpdir(), "narrative-p1-runner-"));
  return {
    root,
    protocolPath: join(root, "protocol.json"),
    artifactDirectory: join(root, "artifacts"),
  };
}

function fakeDeps(overrides: Partial<NarrativeP1JourneyDeps> = {}): NarrativeP1JourneyDeps {
  return {
    codeFingerprint: "test-code-1",
    environment: {
      model: "test-model",
      apiBaseUrl: "https://provider.test/v1",
    },
    routeRunner: async ({ budget }) => ({
      completed: budget.used === 0,
      httpAttempts: 0,
    }),
    ...overrides,
  };
}

describe("narrative P1 live journey protocol", () => {
  it("registers diagnostic as an isolated one-route claim with 200 HTTP and 30 minutes", async () => {
    const paths = tempPaths();
    try {
      const input = { profile: "diagnostic" as const, runId: "diagnostic", ...paths };
      expect(await runNarrativeP1Journey({ ...input, mode: "register" }, fakeDeps())).toEqual({ completedRoutes: 0, plannedRoutes: 1, passed: true });
      const protocol = JSON.parse(readFileSync(paths.protocolPath, "utf8"));
      expect(protocol).toMatchObject({ claimScope: "diagnostic", plannedRoutes: 1, budget: { httpBatch: 200, wallClockMs: 1_800_000, maxRouteActions: 24 } });
      const called: string[] = [];
      expect(await runNarrativeP1Journey({ ...input, mode: "live" }, fakeDeps({ routeRunner: async ({ route }) => { called.push(route.routeId); return { completed: true, httpAttempts: 0 }; } }))).toEqual({ completedRoutes: 1, plannedRoutes: 1, passed: true });
      expect(called).toEqual(["S1-diagnostic"]);
      expect(NARRATIVE_P1_PLANNED_ROUTES).toBe(6);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it("cannot promote a fabricated replay summary to acceptance or overwrite live evidence", async () => {
    const paths = tempPaths();
    try {
      await runNarrativeP1Journey({ mode: "register", runId: "replay", ...paths }, fakeDeps());
      const summaryPath = join(paths.artifactDirectory, "summary.json");
      const replayPath = join(paths.artifactDirectory, "replay-routes.json");
      writeFileSync(summaryPath, '{"original":true}');
      writeFileSync(replayPath, '{"S1-private":{"completed":true}}');
      expect(await runNarrativeP1Journey({ mode: "replay", runId: "replay", ...paths }, fakeDeps({ routeRunner: undefined }))).toEqual({ completedRoutes: 0, plannedRoutes: 6, passed: false });
      expect(readFileSync(summaryPath, "utf8")).toBe('{"original":true}');
      expect(readFileSync(replayPath, "utf8")).toBe('{"S1-private":{"completed":true}}');
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it("stops an in-flight route at the batch deadline and rejects late HTTP reservations", async () => {
    const paths = tempPaths();
    vi.useFakeTimers();
    try {
      await runNarrativeP1Journey({ mode: "register", runId: "deadline", ...paths }, fakeDeps());
      let lateReservation: (() => boolean) | undefined;
      const running = runNarrativeP1Journey({ mode: "live", runId: "deadline", ...paths }, fakeDeps({
        routeRunner: async ({ budget }) => { lateReservation = budget.reserve; return new Promise(() => {}); },
      }));
      await vi.advanceTimersByTimeAsync(NARRATIVE_P1_BATCH_WALL_CLOCK_MS);
      expect((await running).passed).toBe(false);
      expect(lateReservation?.()).toBe(false);
      const summary = JSON.parse(readFileSync(join(paths.artifactDirectory, "summary.json"), "utf8"));
      expect(summary.routes).toHaveLength(6);
      expect(summary.routes.every((route: { failureCode: string }) => route.failureCode === "BATCH_WALL_CLOCK_EXHAUSTED")).toBe(true);
    } finally { vi.useRealTimers(); rmSync(paths.root, { recursive: true, force: true }); }
  });

  it("reports per-route HTTP deltas instead of summing cumulative counters", async () => {
    const paths = tempPaths();
    try {
      await runNarrativeP1Journey({ mode: "register", runId: "http", ...paths }, fakeDeps());
      await runNarrativeP1Journey({ mode: "live", runId: "http", ...paths }, fakeDeps({
        routeRunner: async ({ budget }) => { budget.reserve(); return { completed: true, httpAttempts: budget.used }; },
      }));
      const summary = JSON.parse(readFileSync(join(paths.artifactDirectory, "summary.json"), "utf8"));
      expect(summary.httpAttempts).toBe(6);
      expect(summary.routes.map((route: { httpAttempts: number }) => route.httpAttempts)).toEqual([1, 1, 1, 1, 1, 1]);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it("persists all six partial outcomes when a running route is interrupted", async () => {
    const paths = tempPaths();
    const controller = new AbortController();
    try {
      await runNarrativeP1Journey({ mode: "register", runId: "stop", ...paths }, fakeDeps());
      const outcome = await runNarrativeP1Journey({ mode: "live", runId: "stop", ...paths }, fakeDeps({
        signal: controller.signal,
        routeRunner: async ({ budget }) => {
          budget.reserve();
          controller.abort();
          return new Promise(() => {});
        },
      }));
      expect(outcome).toEqual({ completedRoutes: 0, plannedRoutes: 6, passed: false });
      const summary = JSON.parse(readFileSync(join(paths.artifactDirectory, "summary.json"), "utf8"));
      expect(summary.routes).toHaveLength(6);
      expect(summary.httpAttempts).toBe(1);
      expect(summary.routes[0].failureCode).toBe("BATCH_INTERRUPTED");
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
  it("registers the fixed input without making a provider request", async () => {
    const paths = tempPaths();
    let requests = 0;
    try {
      const result = await runNarrativeP1Journey({
        mode: "register",
        runId: "register-test",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps({
        routeRunner: async () => {
          requests += 1;
          return { completed: true, httpAttempts: 0 };
        },
      }));

      expect(result).toEqual({ completedRoutes: 0, plannedRoutes: 6, passed: true });
      expect(requests).toBe(0);
      const protocol = JSON.parse(readFileSync(paths.protocolPath, "utf8")) as Record<string, unknown>;
      expect(protocol.plannedRoutes).toBe(NARRATIVE_P1_PLANNED_ROUTES);
      expect((protocol.input as Record<string, unknown>).characterName).toBe("沈行");
      expect(protocol.policy).toEqual(expect.objectContaining({
        authorTimeoutMs: 240_000,
        reviewTimeoutMs: 240_000,
        reasoningEffort: "low",
      }));
      expect(protocol.protocolHash).toEqual(expect.any(String));
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("keeps all six routes in the denominator when one opening fails", async () => {
    const paths = tempPaths();
    try {
      await runNarrativeP1Journey({
        mode: "register",
        runId: "denominator-test",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps());
      const result = await runNarrativeP1Journey({
        mode: "live",
        runId: "denominator-test-live",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps({
        routeRunner: async ({ route }) => {
          return { completed: route.scenarioId !== "S1", httpAttempts: 1 };
        },
      }));

      expect(result).toEqual({ completedRoutes: 3, plannedRoutes: 6, passed: false });
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });

  it("blocks the 1001st HTTP reservation for the full batch", () => {
    const budget = createNarrativeP1HttpBudget();
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      expect(budget.reserve()).toBe(true);
    }
    expect(budget.reserve()).toBe(false);
    expect(budget.used).toBe(1000);
  });

  it("rejects a tampered protocol hash and a different code fingerprint", async () => {
    const paths = tempPaths();
    try {
      await runNarrativeP1Journey({
        mode: "register",
        runId: "integrity-test",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps());
      const protocol = JSON.parse(readFileSync(paths.protocolPath, "utf8")) as Record<string, unknown>;
      writeFileSync(paths.protocolPath, JSON.stringify({ ...protocol, protocolHash: "tampered" }));
      const hashResult = await runNarrativeP1Journey({
        mode: "live",
        runId: "integrity-hash",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps());
      expect(hashResult).toEqual({ completedRoutes: 0, plannedRoutes: 6, passed: false });

      await runNarrativeP1Journey({
        mode: "register",
        runId: "integrity-code-test",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps());
      const fresh = JSON.parse(readFileSync(paths.protocolPath, "utf8")) as Record<string, unknown>;
      const codeResult = await runNarrativeP1Journey({
        mode: "live",
        runId: "integrity-code",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps({ codeFingerprint: "test-code-2" }));
      expect(codeResult).toEqual({ completedRoutes: 0, plannedRoutes: 6, passed: false });
      expect(fresh.protocolHash).toEqual(expect.any(String));
    } finally {
      rmSync(paths.root, { recursive: true, force: true });
    }
  });
});

it("focused freezes source and skips withdraw after failed deliver", async () => {
 const paths=tempPaths();
 try {
 const input={profile:"focused" as const,runId:"focused",...paths};
 const openingSource={sourceDirectory:"approved",databaseHash:"frozen"};
 await runNarrativeP1Journey({...input,mode:"register"},fakeDeps({openingSource}));
 const protocol=JSON.parse(readFileSync(paths.protocolPath,"utf8"));
 expect(protocol).toMatchObject({claimScope:"fixed_opening_story",plannedRoutes:2,openingSource,budget:{httpBatch:200,wallClockMs:5_400_000}});
 expect(protocol.routes.map((r:{kind:string})=>r.kind)).toEqual(["deliver","withdraw"]);
 const runner=vi.fn(async()=>({completed:false,httpAttempts:0}));
 expect(await runNarrativeP1Journey({...input,mode:"live"},fakeDeps({openingSource:{...openingSource,databaseHash:"changed"},routeRunner:runner}))).toMatchObject({passed:false,plannedRoutes:2});
 expect(runner).not.toHaveBeenCalled();
 expect(await runNarrativeP1Journey({...input,mode:"live"},fakeDeps({openingSource,routeRunner:runner}))).toEqual({passed:false,plannedRoutes:2,completedRoutes:0});
 expect(runner).toHaveBeenCalledTimes(1);
 const summary=JSON.parse(readFileSync(join(paths.artifactDirectory,"summary.json"),"utf8"));
 expect(summary.routes[1].failureCode).toBe("DELIVER_FAILED_WITHDRAW_NOT_RUN");
 }finally{rmSync(paths.root,{recursive:true,force:true});}
});
