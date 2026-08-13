import { describe, expect, it, vi } from "vitest";
import { BackgroundEnsureCoordinator } from "./ensureCoordinator";

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
});
