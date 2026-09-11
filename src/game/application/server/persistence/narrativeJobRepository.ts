// NarrativeJobRepository 端口（Plan 2026-09-09 / Task 7）。
//
// 同一 SQLite 实例同时实现 GameRepository 与 NarrativeJobRepository：
// 发布（publish）必须在与游戏状态写入相同的 write transaction 内完成，
// 不允许第二个连接独立 commit 游戏发布。lease 带 fence，接管递增 fence；
// control 是不需要 worker lease 的独立控制事务，仍强制 expectedVersion /
// expectedCycle CAS。错误码沿用 infrastructure/stale 语义，新增
// JOB_NOT_FOUND / JOB_CONFLICT / LEASE_LOST / UNSUPPORTED_JOB。

import type { Unit, UnitOutput } from "@/game/domain/narrativeUnit";
import type { PlanProposal } from "@/game/domain/narrativePlan";
import type { PlanningContext } from "@/game/application/narrativeGeneration/stageSource";
import type {
  ApplyStateInput,
  CreateInitialGameInput,
  ReplaceCurrentGameInput,
} from "./gameRepository";

// ---------------------------------------------------------------------------
// 载荷类型
// ---------------------------------------------------------------------------

export type StoredUnitStatus = "pending" | "running" | "approved" | "failed" | "unknown";

export type StoredUnit = {
  readonly unit: Unit | null;
  readonly key: string;
  readonly inputDigest: string;
  readonly attempts: number;
  readonly status: StoredUnitStatus;
  readonly value: PlanProposal | UnitOutput | null;
  readonly disclosureReviewDigest?: string;
};

export type StoredJobStatus = "pending" | "failed" | "published" | "cancelled";

export type InitializationEnvelope = {
  readonly requestId: string;
  readonly newGameId: string;
  readonly seed: string;
  readonly generation: import("@/game/domain/worldEntity").GenerationMetadata;
  readonly target:
    | { readonly kind: "create" }
    | { readonly kind: "replace"; readonly expectedGameId: string; readonly expectedRevision: number; readonly endingIdentity: string };
};

export type StoredJob = {
  readonly dialogueConsistencyReview?: Readonly<{
    version: 1; cycle: number; inputDigest: string; attempts: number;
    status: StoredUnitStatus; passDigest?: string;
    violations?: readonly import("../../narrativeGeneration/dialogueConsistencyReview").DialogueViolation[];
  }>;
  readonly schemaVersion: 1;
  readonly id: string;
  readonly scope: "initialization" | "decision";
  readonly version: number;
  readonly cycle: number;
  readonly status: StoredJobStatus;
  readonly input: PlanningContext;
  readonly inputDigest: string;
  readonly baseRevision: number | null;
  readonly gameId: string | null;
  readonly units: readonly StoredUnit[];
  readonly usedRequests: number;
  readonly baselineRequests: number;
  readonly deadline: string;
  readonly failureCode: string | null;
  readonly initialization: InitializationEnvelope | null;
};

export type Lease = {
  readonly jobId: string;
  readonly owner: string;
  readonly fence: number;
  readonly expiresAt: string;
};

export type Publication =
  | { readonly kind: "opening"; readonly input: CreateInitialGameInput; readonly replace?: ReplaceCurrentGameInput }
  | { readonly kind: "decision"; readonly input: ApplyStateInput };

export type NarrativeJobErrorCode =
  | "JOB_NOT_FOUND"
  | "JOB_CONFLICT"
  | "LEASE_LOST"
  | "UNSUPPORTED_JOB"
  | "STALE_GAME_REVISION"
  | "ACTIVE_GAME_EXISTS"
  | "INFRASTRUCTURE_FAILURE";

export type JobCheck<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: NarrativeJobErrorCode };

export type StartJobInput = Readonly<{
  requestId: string;
  digest: string;
  job: StoredJob;
}>;

export type ClaimJobInput = Readonly<{
  id: string;
  owner: string;
  now: string;
  expiresAt: string;
}>;

export type RenewJobInput = Readonly<{
  lease: Lease;
  now: string;
  expiresAt: string;
}>;

export type ControlJobInput = Readonly<{
  id: string;
  expectedVersion: number;
  expectedCycle: number;
  operation: "cancel" | "retry";
  now: string;
}>;

export type SaveJobInput = Readonly<{
  lease: Lease;
  expectedVersion: number;
  job: StoredJob;
}>;

export type PublishJobInput = Readonly<{
  lease: Lease;
  expectedVersion: number;
  publication: Publication;
}>;

export type RecentDialogueJobsInput = Readonly<{
  readonly gameId: string;
  readonly npcId: string;
  readonly beforeRevision: number;
}>;

/**
 * 任务仓储端口。get 不暴露给 UI（安全 status 由上层另行投影）；
 * claim/renew/save/publish 的调用方必须持续持有有效 lease。
 * getInitialization 只读当前 initialization_slot 指向的任务——它是
 * 「有浏览器 marker 之外」的恢复入口，因此不返回任务内容，只有 id。
 */
export interface NarrativeJobRepository {
  start(input: StartJobInput): Promise<JobCheck<StoredJob>>;
  get(id: string): Promise<JobCheck<StoredJob>>;
  /** 可选只读历史能力；旧 fixture/适配器缺省时规划继续使用当前轮上下文。 */
  getRecentDialogueJobs?(input: RecentDialogueJobsInput): Promise<JobCheck<readonly StoredJob[]>>;
  /** 读当前 initialization slot 的任务；无 slot 时返回 null。 */
  getInitialization(): Promise<JobCheck<StoredJob | null>>;
  claim(input: ClaimJobInput): Promise<JobCheck<Lease>>;
  renew(input: RenewJobInput): Promise<JobCheck<Lease>>;
  release(input: { readonly lease: Lease }): Promise<JobCheck<true>>;
  control(input: ControlJobInput): Promise<JobCheck<StoredJob>>;
  save(input: SaveJobInput): Promise<JobCheck<StoredJob>>;
  publish(input: PublishJobInput): Promise<JobCheck<StoredJob>>;
}
