import { loadScenarioProfiles, type ScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import {
  resolveAction,
  type PlayerIntent,
  type ResolveActionDependencies,
} from "@/game/gameplay/rpg/actions";
import { reconcileQuests } from "@/game/gameplay/rpg/quests";
import type { GameState } from "@/game/domain";
import { projectGameSessionView, type GameSessionView } from "./gameSessionView";
import type { GameRepository } from "./server/persistence/gameRepository";

// ---------------------------------------------------------------------------
// performAction use case（Phase 3 Task 4 + Phase 4 Task 3）。
//
// 严格顺序：读取当前游戏 → 检查 revision → 调用 actions facade resolveAction
//   → 成功后调用 quests facade reconcileQuests 得到最终 state（行动事件 +
//   任务事件按序入账）→ 一次 repository.applyResolvedAction 原子写入
//   → 从已保存 state 投影最新 GameSessionView 与反馈。
//
// 无存档/损坏/基础设施失败均映射稳定结果；reconciliation 契约外抛错同样
// 映射基础设施失败且零写入；application 注入时钟以保证测试可重复；
// 不读取 process.env、路径、libsql 或 AI 环境。
// ---------------------------------------------------------------------------

export type PerformActionCommand = {
  readonly intent: PlayerIntent;
  readonly expectedRevision: number;
};

export type PerformActionDependencies = {
  readonly repository: GameRepository;
  /** 注入时钟：返回 ISO 8601 字符串，用于事件时间戳。 */
  readonly now: () => string;
  /** 场景 profile 配置：缺省加载内置 data/base 配置，测试可注入变体。 */
  readonly profiles?: ScenarioProfiles;
};

/** 行动反馈视图：成功或拒绝的玩家可读消息。 */
export type ActionFeedbackView = {
  readonly ok: boolean;
  readonly message: string;
};

export type PerformActionResult =
  | {
      readonly ok: true;
      readonly view: GameSessionView;
      readonly feedback: ActionFeedbackView;
    }
  | {
      readonly ok: false;
      readonly code: "ACTION_REJECTED";
      readonly view: GameSessionView;
      readonly feedback: ActionFeedbackView;
    }
  | {
      readonly ok: false;
      readonly code: "STALE_GAME_REVISION";
      readonly view: GameSessionView;
    }
  | {
      readonly ok: false;
      readonly code: "NO_ACTIVE_GAME" | "CORRUPT_GAME" | "INFRASTRUCTURE_FAILURE";
    };

export async function performAction(
  command: PerformActionCommand,
  deps: PerformActionDependencies
): Promise<PerformActionResult> {
  // Step 1: 读取当前游戏。
  const loaded = await deps.repository.getCurrentGame();
  if (!loaded.ok) {
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }
  if (loaded.status === "none") {
    return { ok: false, code: "NO_ACTIVE_GAME" };
  }
  if (loaded.status === "corrupt") {
    return { ok: false, code: "CORRUPT_GAME" };
  }

  const { record } = loaded;
  const profiles = deps.profiles ?? loadScenarioProfiles();
  const worldName = profiles.gameTypeProfiles[record.blueprint.gameType].label;

  // 投影当前 view（用于拒绝/陈旧时返回给客户端）；投影抛错意味着记录
  // 内部引用被改坏，返回 null 由调用处映射稳定基础设施失败（零写入）。
  function projectCurrentView(): GameSessionView | null {
    try {
      return projectGameSessionView({
        gameId: record.gameId,
        blueprint: record.blueprint,
        state: record.state,
        revision: record.revision,
        worldName
      });
    } catch {
      return null;
    }
  }

  // Step 2: 检查 expectedRevision。
  if (command.expectedRevision !== record.revision) {
    const view = projectCurrentView();
    if (view === null) {
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
    return { ok: false, code: "STALE_GAME_REVISION", view };
  }

  // Step 3: 调用纯规则 resolver。
  const resolverDeps: ResolveActionDependencies = { now: deps.now };
  let resolved;
  try {
    resolved = resolveAction(record.blueprint, record.state, command.intent, resolverDeps);
  } catch {
    // resolver 契约外抛错：映射为基础设施失败。
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }

  // Step 4: 拒绝 → 返回当前 view + 拒绝反馈，不写入。
  if (!resolved.ok) {
    const view = projectCurrentView();
    if (view === null) {
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
    return {
      ok: false,
      code: "ACTION_REJECTED",
      view,
      feedback: { ok: false, message: resolved.feedback.message }
    };
  }

  // Step 5: 成功行动后纯任务 reconciliation：任务事件与状态迁移并入同一份
  // 最终 state（事件账本按序追加），保证下方恰好一次写入。
  let nextState: GameState;
  try {
    nextState = reconcileQuests(record.blueprint, resolved.state, { now: deps.now }).state;
  } catch {
    // reconciliation 契约外抛错：零写入，映射为基础设施失败。
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }

  // Step 6: 最终 state → 原子 compare-and-swap 写入（唯一一次写入）。
  let saved;
  try {
    saved = await deps.repository.applyResolvedAction({
      gameId: record.gameId,
      expectedRevision: command.expectedRevision,
      nextState
    });
  } catch {
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }

  if (!saved.ok) {
    if (saved.code === "STALE_GAME_REVISION") {
      // 并发写入：返回当前 view 让客户端更新后重试。
      const view = projectCurrentView();
      if (view === null) {
        return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
      }
      return { ok: false, code: "STALE_GAME_REVISION", view };
    }
    return { ok: false, code: saved.code };
  }

  // Step 7: 从已保存 state 投影最新 view。
  const { record: savedRecord } = saved;
  try {
    return {
      ok: true,
      view: projectGameSessionView({
        gameId: savedRecord.gameId,
        blueprint: savedRecord.blueprint,
        state: savedRecord.state,
        revision: savedRecord.revision,
        worldName
      }),
      feedback: { ok: true, message: resolved.feedback.message }
    };
  } catch {
    // 投影抛错意味着记录内部引用被改坏：映射为基础设施失败。
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }
}
