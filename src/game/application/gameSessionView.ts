import type { GameEvent, GameState, QuestObjective, ScenarioBlueprint } from "@/game/domain";
import {
  projectAvailableActions,
  type AvailableAction
} from "@/game/gameplay/rpg/actions";
import { isQuestObjectiveSatisfied } from "@/game/gameplay/rpg/quests";
import {
  projectOpeningGameView,
  type AvailableActionView,
  type OpeningGameView,
  type OpeningItemView,
  type OpeningNpcView,
  type ProjectOpeningGameViewInput
} from "./openingGameView";
import {
  projectLocationAdventureView,
  type LocationSceneView,
  type NpcDialogueView,
  type WorldMapView
} from "./locationAdventureView";

// ---------------------------------------------------------------------------
// GameSessionView（Phase 4 Task 3 + Phase 6 Task 3）：OpeningGameView 演进出的
// 语义中性场景 read model。plan 固定规则：availableActions 不再过滤 move、追加
// 运行时 presentNpcs 与 active 任务摘要；仍不泄漏锁定任务、隐藏地点、完整蓝图、
// seed / inputDigest。Phase 6 追加 battle 摘要与 ending read model：
//   - 未结局时可公开当前 battle 摘要及允许 battle action；
//   - 结局时只公开 ending 名称、描述、outcome 与终局状态，availableActions 为空。
// OpeningGameView 类型原样保留（UI 仍引用）。
// ---------------------------------------------------------------------------

/** 会话视图的可用行动：在 opening 三种之上追加 move、take_item、start_battle 与 battle_action。 */
export type SessionActionView =
  | AvailableActionView
  | { readonly type: "move"; readonly locationId: string; readonly label: string }
  | { readonly type: "take_item"; readonly itemId: string; readonly label: string }
  | { readonly type: "start_battle"; readonly enemyId: string; readonly label: string }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "withdraw"; readonly label: string };

/** 任务 objective 的展示视图：未支持类型（defeat_enemy）标记为后续阶段能力。 */
export type QuestObjectiveView = {
  readonly label: string;
  readonly completed: boolean;
  /** false = 本阶段无法推进的 objective（后续阶段能力），UI 不得显示为可完成。 */
  readonly supported: boolean;
};

export type ActiveQuestView = {
  readonly name: string;
  readonly description: string;
  readonly kind: "main" | "side";
  readonly objectives: readonly QuestObjectiveView[];
};

/** Phase 6：战斗摘要视图——仅在 active battle 时投影，不泄漏 enemyId/stats/tier。 */
export type BattleView = {
  readonly enemyName: string;
  readonly playerHp: number;
  readonly enemyHp: number;
  readonly round: number;
};

/** Phase 6：结局视图——结局抵达后投影，不泄漏 endingId。 */
export type EndingView = {
  readonly name: string;
  readonly description: string;
  readonly outcome: "success" | "failure";
};

/** 已发生事件的玩家可见叙事；不携带 ID、时间、seed 或完整领域状态。 */
export type StoryEventView = {
  readonly text: string;
};

export type GameSessionView = Omit<OpeningGameView, "availableActions"> & {
  readonly availableActions: readonly SessionActionView[];
  /** 运行时位于当前地点的 NPC：与 visibleNpcs（开场名单快照）语义区分。 */
  readonly presentNpcs: readonly OpeningNpcView[];
  /** 仅 active 任务：locked/completed/closed 一律不出现，名称与 ID 不泄漏。 */
  readonly activeQuests: readonly ActiveQuestView[];
  /** 当前地点可取得物品摘要：与 take_item 可用行动一一对应，不泄漏其他地点。 */
  readonly obtainableItems: readonly OpeningItemView[];
  /** 运行时背包摘要：与 initialItems（开场快照语义）区分，取得后即时更新。 */
  readonly inventoryItems: readonly OpeningItemView[];
  /** Phase 6：战斗摘要——仅 active battle 时非 null，不泄漏 enemyId/stats。 */
  readonly battle: BattleView | null;
  /** Phase 6：结局视图——结局抵达后非 null，不泄漏 endingId。 */
  readonly ending: EndingView | null;
  /** 最近发生的结构化事件，用于确定性试玩叙事。 */
  readonly storyEvents: readonly StoryEventView[];
  /** Phase 7：封闭可见范围的世界地图节点（无隐藏地点泄漏）。 */
  readonly worldMap: WorldMapView;
  /** Phase 7：当前地点场景与场景互动（结局/战斗时 interactions 为空）。 */
  readonly locationScene: LocationSceneView;
  /** Phase 7：当前地点在场 NPC 的安全对话（结局/战斗时无可写 choice）。 */
  readonly dialogues: readonly NpcDialogueView[];
};

/** 输入与 opening 投影完全一致：调用方无需区分两个 read model 的装配来源。 */
export type ProjectGameSessionViewInput = ProjectOpeningGameViewInput;

function toSessionActionView(action: AvailableAction): SessionActionView {
  switch (action.type) {
    case "observe":
      return { type: "observe", locationId: action.locationId, label: action.label };
    case "talk":
      return { type: "talk", npcId: action.npcId, label: action.label };
    case "investigate":
      return { type: "investigate", factId: action.factId, label: action.label };
    case "move":
      return { type: "move", locationId: action.locationId, label: action.label };
    case "take_item":
      return { type: "take_item", itemId: action.itemId, label: action.label };
    case "start_battle":
      return { type: "start_battle", enemyId: action.enemyId, label: action.label };
    case "battle_action":
      return { type: "battle_action", action: action.action, label: action.label };
  }
}

/**
 * objective 展示标签：只描述目标，不泄漏未解锁的世界内容。
 * 未解锁地点 / 未发现事实 / 物品与敌人一律用中性文案。
 */
function projectObjectiveView(
  blueprint: ScenarioBlueprint,
  state: GameState,
  objective: QuestObjective
): QuestObjectiveView {
  const completed = isQuestObjectiveSatisfied(state, objective);
  switch (objective.kind) {
    case "visit_location": {
      const unlocked = state.unlockedLocationIds.includes(objective.locationId);
      const location = blueprint.locations.find((entry) => entry.id === objective.locationId);
      return {
        label: unlocked && location !== undefined ? `到访${location.name}` : "探寻未知之地",
        completed,
        supported: true
      };
    }
    case "talk_to_npc": {
      const npc = blueprint.npcs.find((entry) => entry.id === objective.npcId);
      return {
        label: npc !== undefined ? `与${npc.name}交谈` : "寻访关键人物",
        completed,
        supported: true
      };
    }
    case "discover_fact":
      return { label: "查明相关线索", completed, supported: true };
    case "obtain_item":
      // Phase 5 已支持：完成态跟随背包；文案保持中性，不泄漏未取得的物品名。
      return { label: "取得关键物品", completed, supported: true };
    case "defeat_enemy":
      // Phase 6：已支持——完成态跟随 defeatedEnemyIds。
      return { label: "战胜强敌", completed, supported: true };
  }
}

/** Phase 6：投影战斗摘要——仅 active battle 时返回非 null。 */
function projectBattleView(
  blueprint: ScenarioBlueprint,
  state: GameState
): BattleView | null {
  const battle = state.battle;
  if (battle.status !== "active") return null;
  const enemy = blueprint.enemies.find((e) => e.id === battle.enemyId);
  if (enemy === undefined) {
    throw new Error("会话视图投影失败：战斗敌人引用在蓝图中不存在");
  }
  return {
    enemyName: enemy.name,
    playerHp: battle.playerHp,
    enemyHp: battle.enemyHp,
    round: battle.round,
  };
}

/** Phase 6：投影结局视图——结局抵达后返回非 null，不泄漏 endingId。 */
function projectEndingView(
  blueprint: ScenarioBlueprint,
  state: GameState
): EndingView | null {
  const endingState = state.ending;
  if (endingState === null) return null;
  const ending = blueprint.endings.find((e) => e.id === endingState.endingId);
  if (ending === undefined) {
    throw new Error("会话视图投影失败：结局引用在蓝图中不存在");
  }
  return {
    name: ending.name,
    description: ending.description,
    outcome: endingState.outcome,
  };
}

function projectStoryEvent(
  event: GameEvent,
  locations: ReadonlyMap<unknown, { readonly name: string }>,
  npcs: ReadonlyMap<unknown, { readonly name: string; readonly role: string }>,
  items: ReadonlyMap<unknown, { readonly name: string }>,
  facts: ReadonlyMap<unknown, { readonly text: string }>,
  quests: ReadonlyMap<unknown, { readonly name: string }>,
  enemies: ReadonlyMap<unknown, { readonly name: string }>,
  endings: ReadonlyMap<unknown, { readonly name: string }>
): StoryEventView | null {
  const location = (id: string) => locations.get(id)?.name ?? "未知地点";
  const npc = (id: string) => npcs.get(id)?.name ?? "一位旅人";
  const item = (id: string) => items.get(id)?.name ?? "一件物品";
  const fact = (id: string) => facts.get(id)?.text ?? "一条线索";
  const quest = (id: string) => quests.get(id)?.name ?? "一项任务";
  const enemy = (id: string) => enemies.get(id)?.name ?? "强敌";
  switch (event.type) {
    case "game_initialized": return null;
    case "location_observed": return { text: `你仔细观察了${location(event.locationId)}，周遭细节逐渐清晰。` };
    case "npc_met": return { text: `你与${npc(event.npcId)}交谈。对方以自己的身份和立场回应了你。` };
    case "fact_discovered": return { text: `你查明了一条线索：${fact(event.factId)}` };
    case "location_visited": return { text: `你抵达${location(event.locationId)}，故事继续向前。` };
    case "quest_completed": return { text: `任务「${quest(event.questId)}」已完成。` };
    case "quest_unlocked": return { text: `新的线索将你引向任务「${quest(event.questId)}」。` };
    case "item_obtained": return { text: `你在${location(event.locationId)}取得了${item(event.itemId)}。` };
    case "battle_started": return { text: `${enemy(event.enemyId)}挡住了去路，战斗开始。` };
    case "battle_round_resolved": return { text: event.action === "withdraw" ? "你选择撤离战场。" : `第 ${event.round} 回合结束，双方仍在交锋。` };
    case "battle_resolved": return { text: event.outcome === "victory" ? `你战胜了${enemy(event.enemyId)}。` : `与${enemy(event.enemyId)}的战斗以${event.outcome === "withdraw" ? "撤退" : "失利"}告终。` };
    case "enemy_defeated": return { text: `${enemy(event.enemyId)}已被击败。` };
    case "quest_failed": return { text: `任务「${quest(event.questId)}」失败，后果已被记录。` };
    case "ending_reached": return { text: `你抵达结局「${endings.get(event.endingId)?.name ?? "终章"}」。` };
    case "narrative_choice": return { text: "你做出了抉择，故事在你脚边展开。" };
  }
}

export function projectGameSessionView(input: ProjectGameSessionViewInput): GameSessionView {
  const { blueprint, state } = input;
  const base = projectOpeningGameView(input);
  const npcById = new Map(blueprint.npcs.map((npc) => [npc.id, npc]));
  const questById = new Map(blueprint.quests.map((quest) => [quest.id, quest]));
  const itemById = new Map(blueprint.items.map((item) => [item.id, item]));
  const locationById = new Map(blueprint.locations.map((location) => [location.id, location]));
  const factById = new Map(blueprint.world.facts.map((fact) => [fact.id, fact]));
  const enemyById = new Map(blueprint.enemies.map((enemy) => [enemy.id, enemy]));
  const endingById = new Map(blueprint.endings.map((ending) => [ending.id, ending]));
  const availableActions = projectAvailableActions(blueprint, state);

  // Phase 6：结局抵达后不投影任何可用行动；战斗中只投影 battle_action。
  const projectedActions = state.ending !== null
    ? []
    : state.battle.status === "active"
      ? availableActions
          .filter((a): a is Extract<AvailableAction, { type: "battle_action" }> =>
            a.type === "battle_action"
          )
          .map(toSessionActionView)
      : availableActions.map(toSessionActionView);

  // Phase 6：结局抵达后不投影可取得物品与在场 NPC（终局状态不需要）。
  const obtainableItems = state.ending !== null
    ? []
    : availableActions
        .filter((action): action is Extract<AvailableAction, { type: "take_item" }> =>
          action.type === "take_item"
        )
        .map((action) => {
          const item = itemById.get(action.itemId);
          if (item === undefined) {
            throw new Error("会话视图投影失败：可取得物品引用在蓝图中不存在");
          }
          return { name: item.name, description: item.description };
        });

  return {
    ...base,
    // 完整的可用行动投影（观察/交谈/调查/前往/拾取），结局后为空。
    availableActions: projectedActions,
    // 可取得物品摘要：结局后为空。
    obtainableItems,
    // 运行时背包摘要：按 GameState.inventory 投影（initialItems 保留开场快照语义）。
    inventoryItems: state.inventory.map((itemId) => {
      const item = itemById.get(itemId);
      if (item === undefined) {
        throw new Error("会话视图投影失败：背包物品引用在蓝图中不存在");
      }
      return { name: item.name, description: item.description };
    }),
    // 运行时在场 NPC：按 GameState 中的 NPC 位置投影，不读开场名单。
    presentNpcs: state.npcs
      .filter((npcState) => npcState.locationId === state.currentLocationId)
      .map((npcState) => {
        const npc = npcById.get(npcState.npcId);
        if (npc === undefined) {
          throw new Error("会话视图投影失败：在场 NPC 引用在蓝图中不存在");
        }
        return { name: npc.name, role: npc.role };
      }),
    activeQuests: state.quests
      .filter((questState) => questState.status === "active")
      .map((questState) => {
        const quest = questById.get(questState.questId);
        if (quest === undefined) {
          throw new Error("会话视图投影失败：active 任务引用在蓝图中不存在");
        }
        return {
          name: quest.name,
          description: quest.description,
          kind: quest.kind,
          objectives: quest.objectives.map((objective) =>
            projectObjectiveView(blueprint, state, objective)
          )
        };
      }),
    // Phase 6：战斗摘要与结局视图。
    battle: projectBattleView(blueprint, state),
    ending: projectEndingView(blueprint, state),
    storyEvents: state.eventLedger
      .slice(-12)
      .map((event) => projectStoryEvent(event, locationById, npcById, itemById, factById, questById, enemyById, endingById))
      .filter((event): event is StoryEventView => event !== null),
    // Phase 7：地图 / 地点场景 / 安全对话 read model。传入未过滤的可用行动，由
    // 投影内部按结局 / active battle 语义把 interactions 置空、对话降级为只读。
    ...projectLocationAdventureView(blueprint, state, availableActions)
  };
}
