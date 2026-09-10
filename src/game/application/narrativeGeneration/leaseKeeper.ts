// 协调器租约作用域内的续租保活（Plan 2026-09-09 缺陷 16）。
//
// 背景：claim 写入的租约 TTL 只有 30s，但一次 staged 生成可能远超它——
// 真实观测：10 单元 / 36.3s（约 2s/单元）；单元重试与修复循环会进一步拉长。
// 写入路径（save/renew/publish）都只做 owner/fence/expiresAt 三元组等值匹配、
// 不查过期，但 TTL 一到租约就可被外部 claim 接管（fence 递增）：持有者的后续
// 写入撞新 fence 返回 LEASE_LOST。结果是「全部单元 approved、job 仍 pending、
// lease 已被 finally 清空」，外部只看到永久 pending，而失败原因被 summary
// 掩盖（requestCount 恰为 1）。续租让租约保持活跃、无人能接管。
//
// 保活采用**惰性续租**（lazy renew）而非后台定时器：每次写入前询问
// 「当前租约是否已过半程」，是则同步续租到 now + ttl 再继续。相比 setInterval
// 有三个好处：
//   1. 时钟由调用方注入（生产用墙钟、测试用可推进时钟），惰性判定对两者都成立；
//      后台定时器按墙钟触发，在注入时钟下无法驱动，会造成「测试绿灯、生产仍挂」。
//   2. 续租与写入在同一调用栈内串行，不存在「publish 与续租竞态」。
//   3. provider 请求自身有 45s/90s 硬超时，单个慢请求也远小于「过半即续租」
//      的安全余量，不会出现「一次请求横跨整个 TTL」。即使出现，renew 也不
//      否决「已过期但未被接管」的租约（fence 才是并发权威），续租仍能成功。
//
// 语义要点：
//   - 续租失败（LEASE_LOST / INFRASTRUCTURE_FAILURE）→ abort 传入的 controller，
//     让 runJob 的 `deps.signal.aborted` 检查尽快中止，不再空跑 provider；
//   - 续租后 lease.expiresAt 前移：仓储的 save/publish 要求三元组**精确匹配**
//     当前行，持有者视图必须同步前移（owner+fence 不变，仍能防住被接管后的写入）；
//   - 保活层不代为宣告失败：丢失后由调用方在写入路径上得到 LEASE_LOST 并如实上报。

import type { Lease, NarrativeJobRepository } from "../server/persistence/narrativeJobRepository";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";

/** 与 claim 处的 TTL 保持同源：租约 30s。 */
export const LEASE_TTL_MS = 30_000;
/** 已用掉 TTL 的这个比例就续租（1/3）：留出 20s 安全余量吸收慢请求与调度抖动。 */
const RENEW_AT_USED_RATIO = 1 / 3;

export type LeaseKeeper = Readonly<{
  /** 续租（如需）后返回当前有效租约；丢失后为常量 null。 */
  acquire(): Promise<Lease | null>;
  /** 同步读当前租约视图（已丢失时为 null），不做续租。 */
  current(): Lease | null;
  /** 停止保活；幂等。 */
  stop(): void;
}>;

/**
 * 合并两个 AbortSignal：任一 abort 即传播。用于把「调用方取消」与「租约丢失」
 * 两条中止来源统一交给 runJob 的 signal 检查，避免为续租单独开一条退出路径。
 */
export function composeSignals(...signals: readonly AbortSignal[]): AbortSignal {
  const active = signals.filter((signal) => !signal.aborted);
  if (active.length === 0) return AbortSignal.abort();
  if (active.length === 1) return active[0] as AbortSignal;
  const controller = new AbortController();
  for (const signal of active) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export type StartLeaseKeeperInput = Readonly<{
  jobs: NarrativeJobRepository;
  lease: Lease;
  now: () => string;
  /** 租约丢失时中止推导：runJob 会在下一次 signal 检查处退出。 */
  controller?: AbortController;
  logger?: GameLogger;
  ttlMs?: number;
}>;

/**
 * 建立作用域内保活。返回的 keeper 由调用方在每条写入路径前 `acquire()`，
 * 并在 finally 中 stop()。
 */
export function startLeaseKeeper(input: StartLeaseKeeperInput): LeaseKeeper {
  const logger = input.logger ?? NOOP_GAME_LOGGER;
  const ttlMs = input.ttlMs ?? LEASE_TTL_MS;
  const renewAfterMs = ttlMs * RENEW_AT_USED_RATIO;

  let lease: Lease | null = input.lease;
  let stopped = false;

  async function acquire(): Promise<Lease | null> {
    const held = lease;
    if (stopped || held === null) return null;
    const nowMs = Date.parse(input.now());
    // 尚未过半：沿用当前租约，避免每个单元都打一次写事务。
    if (nowMs - (Date.parse(held.expiresAt) - ttlMs) < renewAfterMs) return held;

    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const renewed = await input.jobs.renew({ lease: held, now: input.now(), expiresAt });
    if (!renewed.ok) {
      // 丢失即置空 + abort：后续 acquire() 直接返回 null，也不再有写入成功。
      lease = null;
      logger.warn("narrative_job_lease_lost", { jobId: held.jobId, code: renewed.code });
      input.controller?.abort();
      return null;
    }
    lease = renewed.value;
    return lease;
  }

  return {
    acquire,
    current: () => lease,
    stop: () => {
      stopped = true;
    },
  };
}
