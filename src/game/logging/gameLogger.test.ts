import { describe, expect, it } from "vitest";
import { createGameLogger, type GameLogEntry } from "./index";

describe("createGameLogger", () => {
  it("writes structured entries and redacts sensitive fields recursively", () => {
    const entries: GameLogEntry[] = [];
    const logger = createGameLogger({ write: (entry) => entries.push(entry) });

    logger.warn("runtime_narrative_approval", {
      traceId: "trace-1",
      apiKey: "sk-secret",
      nested: { authorization: "Bearer secret", category: "invalid_json" },
      list: [{ cookie: "session-secret" }]
    });

    expect(entries).toEqual([
      {
        level: "warn",
        event: "runtime_narrative_approval",
        details: {
          traceId: "trace-1",
          apiKey: "[REDACTED]",
          nested: { authorization: "[REDACTED]", category: "invalid_json" },
          list: [{ cookie: "[REDACTED]" }]
        }
      }
    ]);
  });

  it("does not let a sink failure affect game execution", () => {
    const logger = createGameLogger({ write: () => { throw new Error("sink unavailable"); } });
    expect(() => logger.error("sqlite_repository_failure", { operation: "getCurrentGame" })).not.toThrow();
  });
});
