import { loadScenarioProfiles, type ScenarioProfiles } from "@/game/gameplay/rpg/scenario";
import { classifyFreeDialogue, classifyDialogueTone, composeNpcCasualReply } from "@/game/gameplay/rpg/actions";
import { RELATIONSHIP_CHANGE, clampAffinity, type GameState, type NpcId, type PlayerNpcChatState } from "@/game/domain";
import { NOOP_GAME_LOGGER, type GameLogger } from "@/game/logging";
import type { DirectorSource, NpcLineSource, SceneScriptSource } from "./runtimeNarrative";
import { projectGameSessionView, type GameSessionView } from "./gameSessionView";
import type { ActionFeedbackView } from "./performAction";
import type { GameRepository } from "./server/persistence/gameRepository";
import { canQueueRuntimeNarrativeScene } from "./runtimeNarrativeEligibility";

// ---------------------------------------------------------------------------
// Phase 13：不可变更新辅助函数（与 resolveAction.ts 同构）。
// ---------------------------------------------------------------------------

/** 不可变更新：替换数组中匹配元素。 */
function replaceInArray<T>(array: readonly T[], predicate: (item: T) => boolean, replacement: (item: T) => T): T[] {
  return array.map((item) => (predicate(item) ? replacement(item) : item));
}

// ---------------------------------------------------------------------------
// handleNpcDialogue use case（NPC 自由输入，spec §5.2/5.3）。
//
// 编排流程：读取存档 → revision 检查 → pending 守卫 → classifyFreeDialogue
//   纯规则分类 → chat 路径零 CAS 写入直接返回确定性闲聊回应；
//   narrative 路径构造 pending + playerNpcChat 快照做唯一一次 CAS 写入，
//   场景本体由 /api/game/narrative/ensure 轮询链路异步生成。
//
// 纪律：本 use case 自身零 AI 调用（sources 只作为「AI 可用」的资格信号）；
// offline 模式与 canQueueRuntimeNarrativeScene=false 时叙事路径降级为闲聊；
// 自由输入不触发 resolveAction、不产生 npc_met 等规则事件。
// ---------------------------------------------------------------------------

export type HandleNpcDialogueCommand = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly expectedRevision: number;
};

export type HandleNpcDialogueDependencies = {
  readonly repository: GameRepository;
  /** 注入时钟：返回 ISO 8601 字符串，用于 pending requestedAt。 */
  readonly now: () => string;
  /** 场景 profile 配置：缺省加载内置 data/base 配置，测试可注入变体。 */
  readonly profiles?: ScenarioProfiles;
  readonly runtimeNarrativeSources?: Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }>;
  /** server-only structured telemetry; text itself is never logged. */
  readonly logger?: GameLogger;
  readonly traceId?: string;
};

export type HandleNpcDialogueResult =
  | {
      readonly ok: true;
      readonly kind: "chat";
      readonly npcSpeech: string;
      readonly view: GameSessionView;
    }
  | {
      readonly ok: true;
      readonly kind: "narrative_trigger";
      readonly view: GameSessionView;
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

export async function handleNpcDialogue(
  command: HandleNpcDialogueCommand,
  deps: HandleNpcDialogueDependencies
): Promise<HandleNpcDialogueResult> {
  // Step 1: 读取当前游戏（与 performAction 相同的稳定失败映射）。
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

  // 投影当前 view；投影抛错意味着记录内部引用被改坏，映射基础设施失败。
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

  // Step 3: 已有 pending 场景时拒绝（与 performAction 同一守卫语义）：
  // pending 是持久任务边界，不允许在下一幕生成完成前再次推进世界。
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

  // Step 4: 蓝图 NPC 查表（playerNpcChat 快照需要 name/role）。引用不存在的
  // NPC 说明客户端伪造了 npcId：安全拒绝且零写入。
  const npc = record.blueprint.npcs.find((entry) => entry.id === command.npcId);
  if (npc === undefined) {
    const view = projectCurrentView();
    if (view === null) {
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
    return {
      ok: false,
      code: "ACTION_REJECTED",
      view,
      feedback: { ok: false, message: "无法与该角色交谈。" }
    };
  }

  // Step 5: 纯规则分类。叙事路径要求 AI 可用（非 offline + sources 注入）
  // 且通过排队资格检查；任一不满足则降级为闲聊（spec §4.4，永不报错阻塞）。
  const classification = classifyFreeDialogue(record.blueprint, record.state, command.npcId, command.text);
  const tone = classifyDialogueTone(command.text);
  const logger = deps.logger ?? NOOP_GAME_LOGGER;
  const canTriggerNarrative =
    classification === "narrative" &&
    record.state.narrative.mode !== "offline" &&
    deps.runtimeNarrativeSources !== undefined &&
    canQueueRuntimeNarrativeScene(record.blueprint, record.state);

  if (!canTriggerNarrative) {
    // chat 路径：确定性模板回应，零 CAS 写入、零事件。
    // composeNpcCasualReply 在 NPC 不在当前地点时返回空串（如伪造请求），
    // 兜底为通用提示避免 UI 显示空白。
    const raw = composeNpcCasualReply(record.blueprint, record.state, command.npcId, command.text);
    const npcSpeech = raw === "" ? "（对方似乎没听清。）" : raw;
    const view = projectCurrentView();
    if (view === null) {
      return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
    }
    logger.info("npc_dialogue_decision", {
      traceId: deps.traceId,
      scope: "request",
      source: "rpg.application.handle_npc_dialogue",
      npcId: String(command.npcId),
      classification,
      tone,
      relationshipDelta: 0,
      resultKind: "chat"
    });
    return { ok: true, kind: "chat", npcSpeech, view };
  }

  // Step 6: narrative 路径：pending + playerNpcChat 快照一次 CAS 写入。
  // 快照随 pending 变体单次消费，场景 ready 时随类型收窄自动丢弃。
  // Phase 13：在构造 nextState 前计算关系变化。
  const delta =
    tone === "positive" ? RELATIONSHIP_CHANGE.FREE_INPUT_POSITIVE :
    tone === "negative" ? RELATIONSHIP_CHANGE.FREE_INPUT_NEGATIVE :
    0;

  const currentRelationship = record.state.npcs.find(
    (n) => n.npcId === command.npcId,
  )?.relationship ?? { affinity: 0 };
  const newAffinity = clampAffinity(currentRelationship.affinity + delta);

  const playerNpcChat: PlayerNpcChatState = {
    npcId: command.npcId,
    playerText: command.text,
    npcName: npc.name,
    npcRole: npc.role
  };
  logger.info("npc_dialogue_decision", {
    traceId: deps.traceId,
    scope: "request",
    source: "rpg.application.handle_npc_dialogue",
    npcId: String(command.npcId),
    classification,
    tone,
    relationshipDelta: delta,
    resultKind: "narrative_trigger"
  });
  const nextState: GameState = {
    ...record.state,
    npcs: replaceInArray(
      record.state.npcs,
      (n) => n.npcId === command.npcId,
      (n) => ({
        ...n,
        relationship: delta !== 0 ? { affinity: newAffinity } : n.relationship,
      }),
    ),
    narrative: {
      currentScene: null,
      generation: {
        status: "pending",
        requestedAt: deps.now(),
        // Phase 14：携带触发上下文，让导演知道场景是为何触发的。
        triggerContext: { kind: "free_input", npcId: command.npcId, playerText: command.text },
        playerNpcChat,
      },
      mode: "ai"
    }
  };

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
      kind: "narrative_trigger",
      view: projectGameSessionView({
        gameId: savedRecord.gameId,
        blueprint: savedRecord.blueprint,
        state: savedRecord.state,
        revision: savedRecord.revision,
        worldName
      })
    };
  } catch {
    return { ok: false, code: "INFRASTRUCTURE_FAILURE" };
  }
}
