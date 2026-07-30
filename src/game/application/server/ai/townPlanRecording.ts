import { createHash } from "node:crypto";
import {
  TOWN_PLAN_CONTRACT_VERSION,
  type TownPlanAttempt,
  type TownPlanCandidateSource,
  type TownPlanFailureCategory,
  type TownPlanRequest
} from "../../townPlanGeneration";

// ---------------------------------------------------------------------------
// Town 层：town plan 的录制/回放基础设施——镜像 runtimeNarrativeRecording。
// 与 runtime narrative 不同，town plan 是单端口单次调用，因此录制条目只区分
// sequence，不带 role。requestFingerprint 覆盖除 volatile（traceId）外的
// 请求语义，保证同蓝图 + 同 seed 的请求可确定性回放并做 drift 检测。
// 录制只保留已解析候选与稳定失败类别：绝不落 prompt、原始响应或密钥。
// ---------------------------------------------------------------------------

export const TOWN_PLAN_FIXTURE_VERSION = "town-plan-fixture-v1" as const;

export type TownPlanRecordedCall = Readonly<{
  fixtureVersion: typeof TOWN_PLAN_FIXTURE_VERSION;
  contractVersion: typeof TOWN_PLAN_CONTRACT_VERSION;
  sequence: number;
  requestFingerprint: string;
  result:
    | Readonly<{ ok: true; origin: "fixture" | "live"; candidate: unknown }>
    | Readonly<{ ok: false; category: TownPlanFailureCategory }>;
}>;

export type TownPlanRecordSink = {
  append(call: TownPlanRecordedCall): void | Promise<void>;
};

// traceId 是唯一 volatile 字段：回放时 seed/地点/NPC 全部确定性复现。
const VOLATILE_REQUEST_KEYS = new Set(["traceId"]);

function canonicalJson(value: unknown, parentKey?: string): string {
  if (parentKey !== undefined && VOLATILE_REQUEST_KEYS.has(parentKey)) {
    return JSON.stringify("<volatile>");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key], key)}`
  ).join(",")}}`;
}

/** 请求指纹：canonical JSON + sha256，traceId 置占位。 */
export function fingerprintTownPlanRequest(request: TownPlanRequest): string {
  return createHash("sha256").update(canonicalJson(request as unknown)).digest("hex");
}

function recordedResult(attempt: TownPlanAttempt): TownPlanRecordedCall["result"] {
  if (!attempt.ok) return { ok: false, category: attempt.category };
  // origin "unavailable" 只出现在失败分支，成功分支必为 fixture|live。
  return { ok: true, origin: attempt.origin, candidate: attempt.candidate };
}

/** 包装真实/fixture source，把每次 attempt 追加到 sink（不改变返回值）。 */
export function createRecordingTownPlanSource(
  source: TownPlanCandidateSource,
  sink: TownPlanRecordSink
): TownPlanCandidateSource {
  let sequence = 0;
  return {
    async generate(request) {
      const attempt = await source.generate(request);
      await sink.append({
        fixtureVersion: TOWN_PLAN_FIXTURE_VERSION,
        contractVersion: TOWN_PLAN_CONTRACT_VERSION,
        sequence: sequence++,
        requestFingerprint: fingerprintTownPlanRequest(request),
        result: recordedResult(attempt)
      });
      return attempt;
    }
  };
}

export class TownPlanFixtureDriftError extends Error {
  readonly code = "TOWN_PLAN_FIXTURE_DRIFT";
  constructor() {
    super("town plan fixture does not match the current request");
    this.name = "TownPlanFixtureDriftError";
  }
}

/**
 * 按录制顺序消费的零网络回放 source。sequence/契约版本/请求指纹任一不符
 * 即抛 drift；assertComplete 校验所有录制条目都被消费。
 */
export function createReplayTownPlanSource(
  calls: readonly TownPlanRecordedCall[]
): TownPlanCandidateSource & Readonly<{ assertComplete(): void }> {
  let cursor = 0;
  return {
    async generate(request): Promise<TownPlanAttempt> {
      const call = calls[cursor];
      if (
        call === undefined ||
        call.sequence !== cursor ||
        call.fixtureVersion !== TOWN_PLAN_FIXTURE_VERSION ||
        call.contractVersion !== TOWN_PLAN_CONTRACT_VERSION ||
        call.requestFingerprint !== fingerprintTownPlanRequest(request)
      ) {
        throw new TownPlanFixtureDriftError();
      }
      cursor += 1;
      if (!call.result.ok) {
        return {
          ok: false,
          contractVersion: TOWN_PLAN_CONTRACT_VERSION,
          origin: "fixture",
          category: call.result.category,
          diagnostics: []
        };
      }
      return {
        ok: true,
        contractVersion: TOWN_PLAN_CONTRACT_VERSION,
        origin: "fixture",
        candidate: call.result.candidate,
        diagnostics: []
      };
    },
    assertComplete() {
      if (cursor !== calls.length) throw new TownPlanFixtureDriftError();
    }
  };
}
