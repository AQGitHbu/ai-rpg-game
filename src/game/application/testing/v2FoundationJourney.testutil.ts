import type { GameRepositoryV2, GameRecordV2, ApplyStateV2Input } from "@/game/application/server/persistence/gameRepositoryV2";
import type { GameId } from "@/game/application/server/persistence/gameRepository";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import type { Interaction } from "@/game/domain/action";
import type { ActionChoiceMap } from "@/game/application/actionConverter";
import { performTurn } from "@/game/application/performTurn";
import { createGameV2, createFixtureWorldSource } from "@/game/application/createGameV2";
import { generatePendingSceneV2 } from "@/game/application/generatePendingSceneV2";
import { createDeterministicSceneSource } from "@/game/application/deterministicSceneSource";
import { asGameId } from "@/game/application/server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// Task 30：v2.1 完整离线旅程 harness。
//
// - 内存 GameRepositoryV2（CAS 语义与 SQLite 一致）。
// - 经 createGameV2 + fixture world source 创建经验证世界。
// - playTurn 包一层 performTurn；advanceScene 用确定性 SceneSource 清空 pending。
// - 记录每次规则提交，供"单次 CAS / reload / 确定性 replay"断言。
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-08-09T00:00:00.000Z";
let _now = FIXED_NOW;
export const setJourneyNow = (v: string) => { _now = v; };
export const journeyNow = () => _now;

export type InMemoryRepo = {
  readonly repo: GameRepositoryV2;
  readonly record: () => GameRecordV2 | null;
  readonly applyCalls: () => readonly ApplyStateV2Input[];
  /** 用传入的双状态覆盖当前记录（模拟一次进程重启后从持久化恢复）。 */
  readonly restore: (record: GameRecordV2) => void;
};

export function createInMemoryRepo(_gameId: GameId): InMemoryRepo {
  let record: GameRecordV2 | null = null;
  const applyCallsHistory: ApplyStateV2Input[] = [];
  const repo: GameRepositoryV2 = {
    async createInitialGame(input) {
      if (record !== null) return { ok: false as const, code: "ACTIVE_GAME_EXISTS" as const };
      record = { gameId: input.gameId, worldState: input.worldState, storyState: input.storyState, revision: 0, createdAt: input.createdAt };
      return { ok: true as const };
    },
    async getCurrentGame() {
      if (record === null) return { ok: true, status: "none" };
      return { ok: true, status: "active", record };
    },
    async applyState(input) {
      if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      applyCallsHistory.push(input);
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, worldState: input.nextWorldState, storyState: input.nextStoryState, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async applySceneWriteBack(input) {
      if (record === null) return { ok: false as const, code: "NO_ACTIVE_GAME" as const };
      if (input.expectedRevision !== record.revision) return { ok: false as const, code: "STALE_GAME_REVISION" as const };
      record = { ...record, storyState: { ...record.storyState, narrative: input.nextNarrative, candidateEventPool: input.nextCandidateEventPool }, revision: record.revision + 1 };
      return { ok: true, record };
    },
    async clearCurrentGame() { record = null; return { ok: true as const }; },
  };
  return {
    repo,
    record: () => record,
    applyCalls: () => applyCallsHistory,
    restore: (next) => { record = next; },
  };
}

export type JourneyTurnResult = {
  readonly ok: boolean;
  readonly code: string;
  readonly revisionAfter: number;
  readonly turnNumberAfter: number;
};

/** 执行一个回合：先清空 pending（如无 pending 则跳过），再走 performTurn。 */
export async function playTurn(
  repo: GameRepositoryV2,
  interaction: Interaction,
  choiceMap: ActionChoiceMap = new Map(),
  now: () => string = journeyNow,
): Promise<JourneyTurnResult> {
  const current = await repo.getCurrentGame();
  if (!current.ok || current.status !== "active") return { ok: false, code: "NO_ACTIVE_GAME", revisionAfter: -1, turnNumberAfter: -1 };
  const revision = current.record.revision;
  const turnNumber = current.record.storyState.turnNumber;
  const result = await performTurn(
    { gameId: current.record.gameId, actionId: `act_j_${turnNumber}`, interaction, expectedRevision: revision, choiceMap },
    { repository: repo, now, expansionSource: undefined },
  );
  if (result.ok) {
    const after = await repo.getCurrentGame();
    const turnNumberAfter = after.ok && after.status === "active" ? after.record.storyState.turnNumber : turnNumber;
    return { ok: true, code: "ok", revisionAfter: result.revision, turnNumberAfter };
  }
  return { ok: false, code: result.code, revisionAfter: revision, turnNumberAfter: turnNumber };
}

/** 用确定性 SceneSource 清空当前 pending job（无 pending 返回 true）。 */
export async function advanceScene(repo: GameRepositoryV2): Promise<boolean> {
  const result = await generatePendingSceneV2({
    repository: repo,
    sceneSource: createDeterministicSceneSource(),
    now: journeyNow,
  });
  return result === "saved" || result === "not_pending";
}

/** 创建经验证世界（fixture source 经 schema parse → validate → compile）。 */
export async function createJourneyGame(
  gameId: GameId = asGameId("journey_g1"),
  repo?: InMemoryRepo,
): Promise<{ repo: InMemoryRepo; gameId: GameId }> {
  const store = repo ?? createInMemoryRepo(gameId);
  const created = await createGameV2(
    { gameId, gameType: "wuxia", gameLength: "short", seed: "journey_seed" },
    { repository: store.repo, source: createFixtureWorldSource(), now: journeyNow, aiEnabled: false },
  );
  if (!created.ok) throw new Error(`创建世界失败：${created.code}`);
  return { repo: store, gameId };
}

/** 从当前记录返回故事状态（reload 断言用）。 */
export async function loadStoryState(repo: GameRepositoryV2): Promise<StoryState | null> {
  const current = await repo.getCurrentGame();
  if (!current.ok || current.status !== "active") return null;
  return current.record.storyState;
}

export async function loadWorldState(repo: GameRepositoryV2): Promise<WorldState | null> {
  const current = await repo.getCurrentGame();
  if (!current.ok || current.status !== "active") return null;
  return current.record.worldState;
}
