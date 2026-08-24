// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

// 钉死 generatePendingScene（coordinator 的执行体）：在不依赖真实 AI/source 与
// 复杂合法 state 的前提下，直接观测 coordinator 是否被调用、以什么 origin 调用。
const { mockedGeneratePendingScene } = vi.hoisted(() => ({
  mockedGeneratePendingScene: vi.fn().mockResolvedValue("saved"),
}));

vi.mock("../generatePendingScene", () => ({
  generatePendingScene: mockedGeneratePendingScene,
}));

import { createServerGameEntryPoints, getServerGameEntryPoints } from "./compositionRoot";
import { asGameId, type ApplyStateInput, type GameRecord, type GameRepository } from "./persistence/gameRepository";
import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";

describe("getServerGameEntryPoints", () => {
  it("returns one process-wide entry point so route bundles share the narrative ensure lock", () => {
    const first = getServerGameEntryPoints();
    const second = getServerGameEntryPoints();

    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------
// 发现#1（brief Step1）：retry body → failed→pending CAS → 恰好一次 coordinator 调用
// ---------------------------------------------------------------------------

/**
 * 内存桩 repository：首个 pending job 处于 failed，applyState 带
 * expectedNarrativeGeneration={status:"failed"} 时模拟 CAS 成功并恢复到 pending。
 * 其余端口为 no-op，让 coordinator 只触发被测路径。
 */
function createFailedStateFakeRepository(): {
  repo: GameRepository & { close(): Promise<void> };
  appliedStateCalls: ApplyStateInput[];
  repoStatus: () => "failed" | "pending";
} {
  const jobId = "job-retry-combined";
  let generationStatus: "failed" | "pending" = "failed";
  const appliedStateCalls: ApplyStateInput[] = [];

  const buildRecord = (): GameRecord => {
    const generation =
      generationStatus === "failed"
        ? {
            status: "provider_failed" as const,
            job: { jobId, generationKind: "npc_fixed_choice" as const },
            failure: { kind: "AI_CALL_FAILED" as const, phase: "scene" as const, failedAt: "2026-01-01T00:00:00.000Z" },
          }
        : { status: "provider_pending" as const, job: { jobId, generationKind: "npc_fixed_choice" as const }, lastPresentedScene: null };
    return {
      gameId: asGameId("game-retry-combined"),
      worldState: {
        eventLedger: [],
        currentLocationId: "loc_retry",
        battle: { status: "idle" },
      } as unknown as WorldState,
      storyState: {
        recentBeats: [],
        npcContacts: [],
        reducedThroughEventCount: 0,
        narrative: generation,
        evolution: { status: "idle" },
      } as unknown as StoryState,
      revision: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as unknown as GameRecord;
  };

  const repo = {
    getCurrentGame: vi.fn(async () => ({ ok: true as const, status: "active" as const, record: buildRecord() })),
    applyState: vi.fn(async (input: ApplyStateInput) => {
      appliedStateCalls.push(input);
      // CAS 命中：把同一 failed job 恢复到 pending（expectedNarrativeJob 判定）。
      if (input.expectedNarrativeJob?.status === "provider_failed") {
        generationStatus = "pending";
      }
      return { ok: true as const, record: buildRecord() };
    }),
    createInitialGame: vi.fn(async () => ({ ok: true as const })),
    replaceCurrentGame: vi.fn(async () => ({ ok: true as const })),
    applySceneWriteBack: vi.fn(async () => ({ ok: true as const, record: buildRecord() })),
    clearCurrentGame: vi.fn(async () => ({ ok: true as const })),
    close: vi.fn(async () => {}),
  };

  return { repo, appliedStateCalls, repoStatus: () => generationStatus } as unknown as {
    repo: GameRepository & { close(): Promise<void> };
    appliedStateCalls: ApplyStateInput[];
    repoStatus: () => "failed" | "pending";
  };
}

describe("ensureNarrativeScene retry 组合断言（发现#1）", () => {
  it("从 failed 状态以 {retry:true} 调用，恰好触发一次 coordinator 且 origin=manual_failed_job，CAS failed→pending 被触发", async () => {
    const { repo, appliedStateCalls, repoStatus } = createFailedStateFakeRepository();
    const entryPoints = createServerGameEntryPoints({ NODE_ENV: "test" }, undefined, repo);

    const result = await entryPoints.ensureNarrativeScene({ retry: true });
    expect(result).toEqual({ ok: true, result: "queued" });

    // failed→pending 的 CAS 路径被触发：applyState 恰好一次、以 failed 期望、不递增 revision。
    expect(appliedStateCalls).toHaveLength(1);
    expect(appliedStateCalls[0].expectedNarrativeJob).toEqual({
      status: "provider_failed",
      jobId: "job-retry-combined",
    });
    expect(appliedStateCalls[0].incrementRevision).toBe(false);
    // CAS 提交后存档恢复到 pending，coordinator 才能识别到待生成 job。
    expect(repoStatus()).toBe("pending");

    // coordinator 恰被调用一次，且 origin=manual_failed_job（mechanism=initial, attempt=0）。
    expect(mockedGeneratePendingScene).toHaveBeenCalledTimes(1);
    const runDeps = mockedGeneratePendingScene.mock.calls[0][0] as {
      auditLink?: { retry?: { origin?: string; mechanism?: string; attempt?: number } };
    };
    expect(runDeps?.auditLink?.retry).toEqual({ origin: "manual_failed_job", mechanism: "initial", attempt: 0 });

    await entryPoints.close();
  });
});
