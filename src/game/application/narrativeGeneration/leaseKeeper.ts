import type { Lease, NarrativeJobRepository } from "../server/persistence/narrativeJobRepository";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";

export const LEASE_TTL_MS = 30_000;
export type LeaseKeeper = Readonly<{
  acquire(): Promise<Lease | null>;
  current(): Lease | null;
  /** 续租与写入共享队列，不会携带过时 expiresAt。 */
  jobs: NarrativeJobRepository;
  stop(): Promise<void>;
}>;
export function composeSignals(...signals: readonly AbortSignal[]): AbortSignal {
  return signals.length === 0 ? AbortSignal.abort() : AbortSignal.any([...signals]);
}
export type StartLeaseKeeperInput = Readonly<{
  jobs: NarrativeJobRepository; lease: Lease; now: () => string;
  controller?: AbortController; logger?: GameLogger; ttlMs?: number;
}>;
/** provider 在途时仍定时保活；续租、保存与发布串行。stop 等待在途操作后才能 release。 */
export function startLeaseKeeper(input: StartLeaseKeeperInput): LeaseKeeper {
  const logger = input.logger ?? NOOP_GAME_LOGGER;
  const ttl = input.ttlMs ?? LEASE_TTL_MS;
  const interval = Math.max(1, Math.floor(ttl / 3));
  let lease: Lease | null = input.lease;
  let stopped = false;
  let finished = false;
  let chain: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = chain.then(operation, operation);
    chain = next.catch(() => undefined);
    return next;
  }
  function lost(code: string): null {
    lease = null;
    input.controller?.abort();
    logger.warn("narrative_job_lease_lost", { jobId: input.lease.jobId, code });
    return null;
  }
  async function refresh(): Promise<Lease | null> {
    if (stopped || finished || lease === null) return null;
    const now = input.now();
    if (Date.parse(lease.expiresAt) - Date.parse(now) > ttl - interval) return lease;
    try {
      const renewed = await input.jobs.renew({ lease, now,
        expiresAt: new Date(Date.parse(now) + ttl).toISOString() });
      if (!renewed.ok) return lost(renewed.code);
      lease = renewed.value;
      return lease;
    } catch { return lost("INFRASTRUCTURE_FAILURE"); }
  }
  function schedule(): void {
    if (stopped || finished || lease === null) return;
    timer = setTimeout(() => { void serial(refresh).finally(schedule); }, interval);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }
  const matches = (request: Lease, held: Lease) => request.jobId === held.jobId
    && request.owner === held.owner && request.fence === held.fence;
  const jobs: NarrativeJobRepository = {
    ...input.jobs,
    save: (request) => serial(async () => {
      const held = await refresh();
      if (held === null || !matches(request.lease, held))
        return { ok: false as const, code: "LEASE_LOST" as const };
      return input.jobs.save({ ...request, lease: held });
    }),
    publish: (request) => serial(async () => {
      const held = await refresh();
      if (held === null || !matches(request.lease, held))
        return { ok: false as const, code: "LEASE_LOST" as const };
      const result = await input.jobs.publish({ ...request, lease: held });
      if (result.ok) { finished = true; clearTimeout(timer); }
      return result;
    }),
  };
  schedule();
  return {
    jobs, acquire: () => serial(refresh), current: () => lease,
    stop: async () => { stopped = true; clearTimeout(timer); await chain; },
  };
}
