import { loadScenarioProfiles, type ScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import {
  resolveAction,
  projectAvailableActions,
  parseDialogueChoiceKind,
  type PlayerIntent,
  type ResolveActionDependencies,
} from "@/game/gameplay/rpg/actions";
import { startBattle, battleAction } from "@/game/gameplay/rpg/battle";
import { ensureTownRuntime } from "@/game/gameplay/rpg/town";
import { findAvailableActionByKey, reconcileStoryMemory } from "@/game/gameplay/rpg/narrative";
import type { DirectorSource, NpcLineSource, SceneScriptSource } from "./runtimeNarrative";
import {
  reconcileQuests,
  failQuest,
  resolveEnding,
} from "@/game/gameplay/rpg/quests";
import { finalMainActOf } from "@/game/domain";
import type { GameState, QuestId, EnemyId, ScenarioBlueprint } from "@/game/domain";
import { projectGameSessionView, type GameSessionView } from "./gameSessionView";
import type { GameRepository } from "./server/persistence/gameRepository";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";

// ---------------------------------------------------------------------------
// performAction use case（Phase 3 Task 4 + Phase 4 Task 3 + Phase 6 Task 3）。
//
// 严格顺序：读取当前游戏 → 检查 revision → 路由到对应纯规则 resolver
//   （普通 actions / battle facade）→ 成功后调用 quests facade reconcileQuests
//   或 failQuest 得到最终 state → 调用 resolveEnding 检查结局条件
//   → 一次 repository.applyResolvedAction 原子写入
//   → 从已保存 state 投影最新 GameSessionView 与反馈。
//
// Phase 6 扩展：
//   - start_battle / battle_action intent 路由到 battle facade
//   - 战斗胜利后 reconcileQuests 拾取 defeat_enemy objective
//   - 战斗失败/撤退后 failQuest 标记 stage 3 为 failed
//   - 结局 resolver 在 quest reconciliation/failure 后运行
//   - 结局已抵达时所有 action 安全拒绝且零写入
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
  readonly runtimeNarrativeSources?: Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }>;
  readonly newTraceId?: () => string;
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

/** 统一的纯规则解析结果：battle facade 和 actions facade 产出统一为同一形态。 */
type ResolvedAction = {
  readonly state: GameState;
  readonly feedbackMessage: string;
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

  // Step 2.5: 结局已抵达时所有 action 安全拒绝且零写入。
  if (record.state.ending !== null) {
    const view = projectCurrentView();
    if (view === null) {
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
    return {
      ok: false,
      code: "ACTION_REJECTED",
      view,
      feedback: { ok: false, message: "游戏已结局，无法继续行动。" }
    };
  }

  // Step 2.6: active battle 期间只允许 battle_action。UI 虽然只投影战斗按钮，
  // 但 HTTP 客户端可以直接构造旧 intent；必须在 application 唯一门面阻断，
  // 才能保证移动/拾取/交谈等不能绕过回合与战斗状态。
  if (record.state.battle.status === "active" && command.intent.type !== "battle_action") {
    const view = projectCurrentView();
    if (view === null) {
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
    return {
      ok: false,
      code: "ACTION_REJECTED",
      view,
      feedback: { ok: false, message: "战斗进行中，只能选择战斗行动。" }
    };
  }

  // Step 3: 路由到对应的纯规则 resolver。
  const resolverDeps: ResolveActionDependencies = { now: deps.now };
  const battleDeps = { now: deps.now };
  const questDeps = { now: deps.now };
  let resolved: ResolvedAction;

  try {
    if (command.intent.type === "narrative_choice") {
      const choiceToken = command.intent.choiceToken;
      const scene = record.state.narrative.currentScene;
      const choice = scene?.choices.find((entry) => entry.choiceToken === choiceToken);
      if (scene === null || scene === undefined || choice === undefined) {
        const view = projectCurrentView();
        if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        return { ok: false, code: "ACTION_REJECTED", view, feedback: { ok: false, message: "该剧情选项已失效。" } };
      }
      const available = projectAvailableActions(record.blueprint, record.state);
      const resolvedIntent = findAvailableActionByKey(available, choice.actionKey);
      if (resolvedIntent === null) {
        const view = projectCurrentView();
        if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        return { ok: false, code: "ACTION_REJECTED", view, feedback: { ok: false, message: "该剧情选项已不再合法。" } };
      }
      // A narrative choice is only an opaque selection mechanism. Once its
      // approved action key is resolved, route it through the same
      // authoritative rule facade as the equivalent direct intent.
      let choiceState: GameState;
      let choiceFeedback: string;
      if (resolvedIntent.type === "start_battle") {
        const result = startBattle(
          record.blueprint,
          record.state,
          resolvedIntent.enemyId,
          battleDeps,
        );
        if (!result.ok) {
          const view = projectCurrentView();
          if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          return { ok: false, code: "ACTION_REJECTED", view, feedback: { ok: false, message: result.feedback.message } };
        }
        choiceState = result.state;
        choiceFeedback = result.feedback.message;
      } else if (resolvedIntent.type === "battle_action") {
        // Active battles do not expose narrative scenes. Reject a stale or
        // forged scene mapping instead of introducing a second battle route.
        const view = projectCurrentView();
        if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
        return { ok: false, code: "ACTION_REJECTED", view, feedback: { ok: false, message: "战斗行动必须在战斗界面中选择。" } };
      } else {
        const result = resolveAction(record.blueprint, record.state, resolvedIntent, resolverDeps);
        if (!result.ok) {
          const view = projectCurrentView();
          if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          return { ok: false, code: "ACTION_REJECTED", view, feedback: { ok: false, message: result.feedback.message } };
        }
        choiceState = reconcileQuests(record.blueprint, result.state, questDeps).state;
        choiceFeedback = result.feedback.message;
      }
      resolved = {
        state: {
          ...choiceState,
          narrative: { ...choiceState.narrative, currentScene: null, generation: { status: "idle" } },
          eventLedger: [...choiceState.eventLedger, { type: "narrative_choice", choiceToken: choice.choiceToken, actionKey: choice.actionKey, sceneId: scene.sceneId, occurredAt: deps.now() }],
        },
        feedbackMessage: choiceFeedback,
      };
    } else switch (command.intent.type) {
      case "start_battle": {
        const result = startBattle(
          record.blueprint, record.state, command.intent.enemyId, battleDeps
        );
        if (!result.ok) {
          const view = projectCurrentView();
          if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          return {
            ok: false, code: "ACTION_REJECTED", view,
            feedback: { ok: false, message: result.feedback.message }
          };
        }
        // start_battle 不触发 quest reconciliation（无任务状态变化）。
        resolved = { state: result.state, feedbackMessage: result.feedback.message };
        break;
      }

      case "battle_action": {
        const result = battleAction(
          record.blueprint, record.state, command.intent.action, battleDeps
        );
        if (!result.ok) {
          const view = projectCurrentView();
          if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          return {
            ok: false, code: "ACTION_REJECTED", view,
            feedback: { ok: false, message: result.feedback.message }
          };
        }

        let state = result.state;
        const feedbackMessage = result.feedback.message;

        // 战斗已 resolved 时按 outcome 走 quest success/failure 路径。
        if (state.battle.status === "resolved") {
          const battle = state.battle;
          if (battle.outcome === "victory") {
            // 胜利 → reconcileQuests 拾取 defeat_enemy objective → stage 3 completed
            const reconciled = reconcileQuests(record.blueprint, state, questDeps);
            state = reconciled.state;
          } else {
            // 失败/撤退 → failQuest 标记 stage 3 为 failed
            const stage3QuestId = findStage3QuestForEnemy(
              record.blueprint, battle.enemyId
            );
            if (stage3QuestId !== undefined) {
              const failResult = failQuest(
                record.blueprint, state, stage3QuestId, questDeps
              );
              if (failResult.ok) {
                state = failResult.state;
              }
            }
          }
        }

        resolved = { state, feedbackMessage };
        break;
      }

      default: {
        // 普通行动（observe / talk / investigate / move / take_item）
        const result = resolveAction(
          record.blueprint, record.state, command.intent, resolverDeps
        );
        if (!result.ok) {
          const view = projectCurrentView();
          if (view === null) return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
          return {
            ok: false, code: "ACTION_REJECTED", view,
            feedback: { ok: false, message: result.feedback.message }
          };
        }
        // 普通行动后纯任务 reconciliation
        const reconciled = reconcileQuests(
          record.blueprint, result.state, questDeps
        );
        resolved = {
          state: reconciled.state,
          feedbackMessage: result.feedback.message
        };
        break;
      }
    }
  } catch {
    // resolver 契约外抛错：映射为基础设施失败。
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }

  // Step 4: 结局解析——在 quest reconciliation/failure 后检查结局条件。
  let nextState: GameState;
  try {
    const endingResult = resolveEnding(
      record.blueprint, resolved.state, questDeps
    );
    nextState = endingResult.state;
  } catch {
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }

  // Step 4.5: Town 层懒生成——抵达 scale="town" 地点时确保小镇规划就绪。
  // 离线存档同步派生（towns 追加 + 事件）；AI 存档只置 pending 标记，真正
  // 生成由 town/ensure 轮询消费。非 town 地点 / 已生成 / 已 pending 均 no-op，
  // 因此无需区分 intent 类型（move 与 narrative_choice 解析出的 move 同样覆盖）。
  try {
    const townEntry = ensureTownRuntime(
      record.blueprint,
      nextState,
      String(nextState.currentLocationId),
      record.state.narrative.mode === "offline" ? "offline" : "ai",
      deps.now()
    );
    if (townEntry.kind === "generated") {
      nextState = {
        ...nextState,
        towns: [...nextState.towns, townEntry.town],
        eventLedger: [...nextState.eventLedger, townEntry.event]
      };
    } else if (townEntry.kind === "pending") {
      nextState = { ...nextState, townGeneration: townEntry.townGeneration };
    }
  } catch {
    // 规划派生契约外抛错（地点/NPC 引用被改坏）：映射为基础设施失败且零写入。
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }

  // A pending scene is a durable job boundary. Do not allow a client to
  // advance the deterministic world a second time while the next narrative
  // projection is still being produced (including after a process restart).
  if (record.state.narrative.generation.status === "pending") {
    const view = projectCurrentView();
    if (view === null) {
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
    return {
      ok: false,
      code: "ACTION_REJECTED",
      view,
      feedback: { ok: false, message: "正在编排下一幕，请稍候。" }
    };
  }

  // A deterministic action commits its rule result immediately. Scene
  // generation is a recoverable server-side job and must not make the player
  // request wait for the provider. Narrative choices, dialogue choices, and
  // direct rule intents all share the same queue boundary: after a successful
  // action, an AI-mode game with at least two legal actions must expose the
  // next narrative scene. This also keeps server-side continuation bridges
  // from leaving a playable state with an empty narrative view.
  if (
    record.state.narrative.mode !== "offline" &&
    deps.runtimeNarrativeSources !== undefined &&
    canQueueRuntimeNarrativeScene(record.blueprint, nextState)
  ) {
    const intent = command.intent;
    // 防御性守卫：greet 只应在首次结识时触发场景。正常路径下已结识 NPC 不会
    // 投影 greet 选项且 validateIntent 会拒绝伪造 choiceId，此处防止上游契约
    // 变化时误触发。必须用 record.state（resolveAction 前）判断——resolveAction
    // 对所有 dialogue_choice 都会设置 met: true，nextState 中恒为 true。
    const isRepeatGreet =
      intent.type === "dialogue_choice" &&
      parseDialogueChoiceKind(intent.npcId, intent.choiceId) === "greet" &&
      (record.state.npcs.find((npc) => npc.npcId === intent.npcId)?.met ?? true);
    if (!isRepeatGreet) {
      nextState = {
        ...nextState,
        narrative: { currentScene: null, generation: { status: "pending", requestedAt: deps.now() }, mode: "ai" },
      };
    }
  }

  // Phase 11：每次规则 CAS 写入前同步归约结构化剧情记忆。reducer 为纯函数，
  // 只读 eventLedger cursor 与 npcs，不读 IO/Date/随机；拒绝/pending 分支已提前
  // return，故此处覆盖所有将写入的成功状态。AI 文案/token 绝不入记忆。
  nextState = {
    ...nextState,
    storyMemory: reconcileStoryMemory({ state: nextState })
  };

  // Step 5: 最终 state → 原子 compare-and-swap 写入（唯一一次写入）。
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

  // Step 6: 从已保存 state 投影最新 view。
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
      feedback: { ok: true, message: resolved.feedbackMessage }
    };
  } catch {
    // 投影抛错意味着记录内部引用被改坏：映射为基础设施失败。
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }
}

// ---------------------------------------------------------------------------
// 辅助：查找与指定敌人关联的 active stage 3 quest ID（用于战斗失败后 failQuest）。
// ---------------------------------------------------------------------------

function findStage3QuestForEnemy(
  blueprint: ScenarioBlueprint,
  enemyId: EnemyId
): QuestId | undefined {
  const quest = blueprint.quests.find((q) =>
    q.kind === "main" && q.stage === finalMainActOf(blueprint) &&
    q.objectives.some((obj) => obj.kind === "defeat_enemy" && obj.enemyId === enemyId)
  );
  return quest?.id;
}
