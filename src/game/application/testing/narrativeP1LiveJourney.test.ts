import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  NARRATIVE_P1_PLANNED_ROUTES,
  createNarrativeP1HttpBudget,
  runNarrativeP1Journey,
  type NarrativeP1JourneyDeps,
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
      let routeIndex = 0;
      const result = await runNarrativeP1Journey({
        mode: "live",
        runId: "denominator-test-live",
        protocolPath: paths.protocolPath,
        artifactDirectory: paths.artifactDirectory,
      }, fakeDeps({
        routeRunner: async () => {
          routeIndex += 1;
          return { completed: routeIndex !== 1, httpAttempts: 1 };
        },
      }));

      expect(result).toEqual({ completedRoutes: 5, plannedRoutes: 6, passed: false });
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
