import { describe, expect, it, vi } from "vitest";
import { composeSignals, startLeaseKeeper } from "./leaseKeeper";
import type { NarrativeJobRepository, Lease } from "../server/persistence/narrativeJobRepository";

describe("composeSignals", () => {
  it("任一输入已取消时立即取消，不得过滤掉取消信号", () => {
    expect(composeSignals(AbortSignal.abort(), new AbortController().signal).aborted).toBe(true);
  });
  it("后续取消也传播", () => {
    const first = new AbortController();
    const second = new AbortController();
    const result = composeSignals(first.signal, second.signal);
    second.abort();
    expect(result.aborted).toBe(true);
  });
});

it("95 秒在途请求期间租约不进入可接管状态，停止后不再续租", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let held: Lease = { jobId: "j", owner: "worker", fence: 1, expiresAt: new Date(30_000).toISOString() };
  const renew = vi.fn(async (input: { lease: Lease; expiresAt: string }) => {
    expect(input.lease).toEqual(held);
    held = { ...held, expiresAt: input.expiresAt };
    return { ok: true as const, value: held };
  });
  const keeper = startLeaseKeeper({ jobs: { renew } as unknown as NarrativeJobRepository,
    lease: held, now: () => new Date().toISOString() });
  try {
    for (let second = 0; second < 95; second++) {
      await vi.advanceTimersByTimeAsync(1000);
      expect(Date.parse(held.expiresAt)).toBeGreaterThan(Date.now());
    }
    expect(renew).toHaveBeenCalledTimes(9);
    await keeper.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(9);
  } finally { await keeper.stop(); vi.useRealTimers(); }
});

it("续租失败立即取消在途请求，不再续租", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const controller = new AbortController();
  const renew = vi.fn(async () => ({ ok: false as const, code: "LEASE_LOST" as const }));
  const keeper = startLeaseKeeper({ jobs: { renew } as unknown as NarrativeJobRepository,
    lease: { jobId: "j", owner: "worker", fence: 1, expiresAt: new Date(30_000).toISOString() },
    now: () => new Date().toISOString(), controller });
  try {
    await vi.advanceTimersByTimeAsync(95_000);
    expect(controller.signal.aborted).toBe(true);
    expect(await keeper.acquire()).toBeNull();
    expect(renew).toHaveBeenCalledTimes(1);
  } finally { await keeper.stop(); vi.useRealTimers(); }
});
