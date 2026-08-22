import { describe, expect, it, vi } from "vitest";
import { BackgroundEnsureCoordinator } from "./ensureCoordinator";
import type { GameLogger } from "@/game/logging";

describe("BackgroundEnsureCoordinator", () => {
  it("deduplicates concurrent work for the same persisted job key", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const coordinator = new BackgroundEnsureCoordinator({
      loadPending: vi.fn(async () => ({ ok: true as const, key: "game-1:job-1" })),
      run,
      logKey: "runtime_narrative_task",
    });

    expect(await coordinator.ensure("trace-1")).toBe("queued");
    await Promise.resolve();
    expect(await coordinator.ensure("trace-2")).toBe("already_running");
    expect(run).toHaveBeenCalledOnce();

    release();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  });

  it("passes the retry origin through to run and logs it as retryOrigin", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const logger: GameLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const coordinator = new BackgroundEnsureCoordinator({
      loadPending: vi.fn(async () => ({ ok: true as const, key: "game-1:job-1" })),
      run,
      logKey: "runtime_narrative_task",
      logger,
    });

    expect(await coordinator.ensure("trace-retry", { origin: "manual_failed_job" })).toBe("queued");
    await Promise.resolve();
    // run 收到同一 origin（queued 分支触发）
    expect(run).toHaveBeenCalledWith("trace-retry", "manual_failed_job");

    // task 日志携带结构化 retryOrigin（仅日志，不进存档）
    expect(logger.info).toHaveBeenCalledWith("runtime_narrative_task", expect.objectContaining({
      traceId: "trace-retry",
      gameId: "game-1:job-1",
      result: "queued",
      retryOrigin: "manual_failed_job",
    }));

    release();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  });

  it("defaults a normal poll to origin=normal on run", async () => {
    const run = vi.fn(async () => "completed");
    const coordinator = new BackgroundEnsureCoordinator({
      loadPending: vi.fn(async () => ({ ok: true as const, key: "game-1:job-1" })),
      run,
      logKey: "runtime_narrative_task",
    });

    expect(await coordinator.ensure("trace-poll")).toBe("queued");
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith("trace-poll", "normal"));
  });
});
