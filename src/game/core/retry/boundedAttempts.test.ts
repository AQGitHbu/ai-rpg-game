import { describe, expect, it, vi } from "vitest";
import { runBoundedAttempts, type BoundedAttemptResult } from "@/game/core/retry";

describe("runBoundedAttempts", () => {
  it("runs a successful first attempt once", async () => {
    const runAttempt = vi.fn(async (): Promise<BoundedAttemptResult<string, string>> => ({
      ok: true,
      value: "done",
    }));

    await expect(runBoundedAttempts({ maxAttempts: 2, runAttempt })).resolves.toEqual({
      ok: true,
      value: "done",
    });
    expect(runAttempt).toHaveBeenCalledOnce();
    expect(runAttempt).toHaveBeenCalledWith(1, undefined);
  });

  it("does not retry a non-retryable failure", async () => {
    const runAttempt = vi.fn(async (): Promise<BoundedAttemptResult<string, string>> => ({
      ok: false,
      retryable: false,
      reason: "invalid_schema",
    }));

    await expect(runBoundedAttempts({ maxAttempts: 2, runAttempt })).resolves.toEqual({
      ok: false,
      retryable: false,
      reason: "invalid_schema",
    });
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it("passes the stable prior reason to one bounded retry", async () => {
    const runAttempt = vi.fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, reason: "invalid_json" })
      .mockResolvedValueOnce({ ok: true, value: "repaired" });

    await expect(runBoundedAttempts({ maxAttempts: 2, runAttempt })).resolves.toEqual({
      ok: true,
      value: "repaired",
    });
    expect(runAttempt).toHaveBeenNthCalledWith(1, 1, undefined);
    expect(runAttempt).toHaveBeenNthCalledWith(2, 2, "invalid_json");
  });

  it("returns a second failure without a third call", async () => {
    const runAttempt = vi.fn()
      .mockResolvedValueOnce({ ok: false, retryable: true, reason: "invalid_json" })
      .mockResolvedValueOnce({ ok: false, retryable: true, reason: "invalid_schema" });

    await expect(runBoundedAttempts({ maxAttempts: 2, runAttempt })).resolves.toEqual({
      ok: false,
      retryable: true,
      reason: "invalid_schema",
    });
    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not swallow thrown errors", async () => {
    const error = new Error("boom");
    const runAttempt = vi.fn(async () => {
      throw error;
    });

    await expect(runBoundedAttempts({ maxAttempts: 2, runAttempt })).rejects.toBe(error);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid maxAttempts=%s",
    async (maxAttempts) => {
      await expect(runBoundedAttempts({ maxAttempts, runAttempt: vi.fn() })).rejects.toThrow(
        "maxAttempts must be a positive integer",
      );
    },
  );
});
