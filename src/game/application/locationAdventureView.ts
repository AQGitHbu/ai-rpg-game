import type { GameState, ScenarioBlueprint } from "@/game/domain";
import {
  projectDialogueChoices,
  type AvailableAction,
  type DialogueChoice
} from "@/game/gameplay/rpg/actions";

// ---------------------------------------------------------------------------
// LocationAdventureView（Phase 7 Task 3）：由已编译蓝图 + 当前 GameState +
// 当前可用行动投影出的地图 / 地点场景 / 安全对话 read model。纯函数：不读
// 时间、随机数或 AI，槽位分配用稳定 ID 的字符码累加取模保证确定性。
//
// 可见性契约（封闭，零泄漏）：
//   - 世界地图节点 = 全部 unlockedLocationIds + active visit_location 目标中
//     尚未解锁者（作为 locked 节点）。其余蓝图地点一律不出现，locked 节点用
//     中性文案且不携带 locationId，绝不泄漏隐藏地点真实名称/描述。
//   - 场景互动只来自 projectAvailableActions 的 observe/investigate/take_item/
//     start_battle；talk 归对话、move 归世界地图。
//   - 对话只投影 state.npcs 中位于当前地点的 NPC；写状态 choices 来自 Task 2 的
//     projectDialogueChoices，另加只读本地 review_clue；reviewClues 只含已发现
//     事实文本。
//   - active battle 或结局后仍投影只读地图/地点资料，但 interactions 为空、
//     对话不投影任何可写 choice（仅保留只读 review_clue）。
// ---------------------------------------------------------------------------

/** 场景槽位：确定性分配的四个展示位。 */
const SCENE_SLOTS = ["left", "center", "right", "foreground"] as const;
export type SceneSlot = (typeof SCENE_SLOTS)[number];

export const MAP_NODE_POSITIONS = ["north_west", "north_east", "south_west", "south_east", "center"] as const;
export type MapNodePosition = (typeof MAP_NODE_POSITIONS)[number];

export type WorldMapNodeView =
  | { readonly state: "current"; readonly locationId: string; readonly name: string; readonly visual: "map_node"; readonly position: MapNodePosition }
  | { readonly state: "travelable"; readonly locationId: string; readonly name: string; readonly visual: "map_node"; readonly position: MapNodePosition }
  | {
      readonly state: "known";
      readonly locationId: string;
      readonly name: string;
      readonly hint: "需从相邻地点前往";
      readonly visual: "map_node";
      readonly position: MapNodePosition;
    }
  | {
      readonly state: "locked";
      readonly name: "探寻未知之地";
      readonly hint: "尚未解锁";
      readonly visual: "map_node_locked";
      readonly position: MapNodePosition;
    };

export type WorldMapView = {
  readonly nodes: readonly WorldMapNodeView[];
};

export type SceneInteractionView =
  | { readonly kind: "observe"; readonly locationId: string; readonly label: string; readonly slot: SceneSlot }
  | { readonly kind: "investigate"; readonly factId: string; readonly label: string; readonly slot: SceneSlot }
  | { readonly kind: "take_item"; readonly itemId: string; readonly label: string; readonly slot: SceneSlot }
  | { readonly kind: "start_battle"; readonly enemyId: string; readonly label: string; readonly slot: SceneSlot };

export type LocationSceneView = {
  readonly title: string;
  readonly description: string;
  readonly backdrop: "location_backdrop";
  readonly interactions: readonly SceneInteractionView[];
};

export type DialogueChoiceView =
  | { readonly kind: "greet" | "ask_main_quest"; readonly choiceId: string; readonly label: string; readonly mutatesState: true }
  | { readonly kind: "review_clue"; readonly label: "回顾已知线索"; readonly mutatesState: false };

export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly slot: SceneSlot;
  readonly choices: readonly DialogueChoiceView[];
  readonly reviewClues: readonly string[];
};

export type LocationAdventureView = {
  readonly worldMap: WorldMapView;
  readonly locationScene: LocationSceneView;
  readonly dialogues: readonly NpcDialogueView[];
};

/** 稳定槽位：ID 字符码累加后对 4 取模——纯确定性，无 Math.random / 时间 / AI。 */
function slotForId(stableId: string): SceneSlot {
  let sum = 0;
  for (const ch of stableId) sum += ch.charCodeAt(0);
  return SCENE_SLOTS[sum % SCENE_SLOTS.length];
}

function positionForLocation(blueprint: ScenarioBlueprint, locationId: string): MapNodePosition {
  const index = blueprint.locations.findIndex((entry) => String(entry.id) === locationId);
  return MAP_NODE_POSITIONS[Math.max(index, 0) % MAP_NODE_POSITIONS.length];
}

/** 收集 active 任务中尚未解锁的 visit_location 目标（按遍历顺序去重）。 */
function collectLockedVisitTargets(
  blueprint: ScenarioBlueprint,
  state: GameState
): readonly string[] {
  const unlocked = new Set(state.unlockedLocationIds.map((id) => String(id)));
  const activeQuestIds = new Set(
    state.quests.filter((quest) => quest.status === "active").map((quest) => String(quest.questId))
  );
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const quest of blueprint.quests) {
    if (!activeQuestIds.has(String(quest.id))) continue;
    for (const objective of quest.objectives) {
      if (objective.kind !== "visit_location") continue;
      const targetId = String(objective.locationId);
      if (unlocked.has(targetId) || seen.has(targetId)) continue;
      seen.add(targetId);
      targets.push(targetId);
    }
  }
  return targets;
}

/**
 * 世界地图：封闭可见范围。稳定输出顺序 current → travelable → known → locked。
 * locked 节点绝不携带 locationId，也不泄漏目标地点真实名称/描述。
 */
function projectWorldMap(blueprint: ScenarioBlueprint, state: GameState): WorldMapView {
  const currentId = String(state.currentLocationId);
  const currentLocation = blueprint.locations.find((entry) => String(entry.id) === currentId);
  if (currentLocation === undefined) {
    throw new Error("地图投影失败：当前地点引用在蓝图中不存在");
  }
  const nameById = new Map(blueprint.locations.map((entry) => [String(entry.id), entry.name]));
  const adjacent = new Set(currentLocation.connectedLocationIds.map((id) => String(id)));

  const nodes: WorldMapNodeView[] = [
    { state: "current", locationId: currentId, name: currentLocation.name, visual: "map_node", position: positionForLocation(blueprint, currentId) }
  ];

  // travelable：已解锁 ∩ 与当前地点直接连通（可点击直达），按解锁顺序稳定输出。
  for (const rawId of state.unlockedLocationIds) {
    const id = String(rawId);
    if (id === currentId || !adjacent.has(id)) continue;
    nodes.push({ state: "travelable", locationId: id, name: nameById.get(id) ?? "", visual: "map_node", position: positionForLocation(blueprint, id) });
  }
  // known：已解锁但不相邻——展示真实名称，提示需从相邻地点前往（不可直达）。
  for (const rawId of state.unlockedLocationIds) {
    const id = String(rawId);
    if (id === currentId || adjacent.has(id)) continue;
    nodes.push({
      state: "known",
      locationId: id,
      name: nameById.get(id) ?? "",
      hint: "需从相邻地点前往",
      visual: "map_node",
      position: positionForLocation(blueprint, id)
    });
  }
  // locked：active visit_location 目标但尚未解锁——中性文案，无 locationId，零泄漏。
  const lockedTargets = collectLockedVisitTargets(blueprint, state);
  const usedPositions = new Set(nodes.map((node) => node.position));
  for (let i = 0; i < lockedTargets.length; i++) {
    // locked 节点只按当前安全可见节点占用的位置寻找空位：既不携带、也不按
    // 被锁目标的 ID/蓝图顺序决定位置，避免视觉布局成为身份侧信道。
    const position = MAP_NODE_POSITIONS.find((candidate) => !usedPositions.has(candidate))
      ?? MAP_NODE_POSITIONS[i % MAP_NODE_POSITIONS.length];
    usedPositions.add(position);
    nodes.push({ state: "locked", name: "探寻未知之地", hint: "尚未解锁", visual: "map_node_locked", position });
  }
  return { nodes };
}

/** 场景互动：只由当前可用行动中的四类交互投影，talk/move/battle_action 不在此列。 */
function projectSceneInteractions(
  availableActions: readonly AvailableAction[]
): readonly SceneInteractionView[] {
  const interactions: SceneInteractionView[] = [];
  for (const action of availableActions) {
    switch (action.type) {
      case "observe":
        interactions.push({
          kind: "observe",
          locationId: String(action.locationId),
          label: action.label,
          slot: slotForId(String(action.locationId))
        });
        break;
      case "investigate":
        interactions.push({
          kind: "investigate",
          factId: String(action.factId),
          label: action.label,
          slot: slotForId(String(action.factId))
        });
        break;
      case "take_item":
        interactions.push({
          kind: "take_item",
          itemId: String(action.itemId),
          label: action.label,
          slot: slotForId(String(action.itemId))
        });
        break;
      case "start_battle":
        interactions.push({
          kind: "start_battle",
          enemyId: String(action.enemyId),
          label: action.label,
          slot: slotForId(String(action.enemyId))
        });
        break;
      // talk → 对话；move → 世界地图；battle_action → 战斗面板，均不投影为场景互动。
      case "talk":
      case "move":
      case "battle_action":
        break;
    }
  }
  return interactions;
}

/** 已发现事实文本：只投影 discovered=true 的事实，绝不为未发现事实生成文本。 */
function collectDiscoveredFactTexts(blueprint: ScenarioBlueprint, state: GameState): readonly string[] {
  const textById = new Map(blueprint.world.facts.map((fact) => [String(fact.id), fact.text]));
  return state.worldFacts
    .filter((fact) => fact.discovered)
    .map((fact) => textById.get(String(fact.factId)))
    .filter((text): text is string => text !== undefined);
}

/** Task 2 的写状态 choice 映射为可写对话选项。 */
function toWritableChoiceView(choice: DialogueChoice): DialogueChoiceView {
  return { kind: choice.kind, choiceId: choice.choiceId, label: choice.label, mutatesState: true };
}

/**
 * 安全对话：只投影当前地点在场 NPC（已结识者仍作为对话对象出现）。
 * readOnly（active battle 或结局）时不投影任何可写 choice，仅保留只读 review_clue。
 */
function projectDialogues(
  blueprint: ScenarioBlueprint,
  state: GameState,
  readOnly: boolean
): readonly NpcDialogueView[] {
  const currentId = String(state.currentLocationId);
  const npcById = new Map(blueprint.npcs.map((npc) => [String(npc.id), npc]));
  const reviewClues = collectDiscoveredFactTexts(blueprint, state);
  const reviewChoice: DialogueChoiceView = {
    kind: "review_clue",
    label: "回顾已知线索",
    mutatesState: false
  };

  const dialogues: NpcDialogueView[] = [];
  for (const npcState of state.npcs) {
    if (String(npcState.locationId) !== currentId) continue;
    const npc = npcById.get(String(npcState.npcId));
    if (npc === undefined) {
      throw new Error("对话投影失败：在场 NPC 引用在蓝图中不存在");
    }
    const writableChoices = readOnly
      ? []
      : projectDialogueChoices(blueprint, state, npcState.npcId).map(toWritableChoiceView);
    dialogues.push({
      npcId: String(npcState.npcId),
      name: npc.name,
      role: npc.role,
      slot: slotForId(String(npcState.npcId)),
      choices: [...writableChoices, reviewChoice],
      reviewClues
    });
  }
  return dialogues;
}

export function projectLocationAdventureView(
  blueprint: ScenarioBlueprint,
  state: GameState,
  availableActions: readonly AvailableAction[]
): LocationAdventureView {
  const currentLocation = blueprint.locations.find(
    (entry) => String(entry.id) === String(state.currentLocationId)
  );
  if (currentLocation === undefined) {
    throw new Error("地点场景投影失败：当前地点引用在蓝图中不存在");
  }
  // 结局或 active battle：只读投影——互动为空、对话无可写 choice。
  const readOnly = state.ending !== null || state.battle.status === "active";
  return {
    worldMap: projectWorldMap(blueprint, state),
    locationScene: {
      title: currentLocation.name,
      description: currentLocation.description,
      backdrop: "location_backdrop",
      interactions: readOnly ? [] : projectSceneInteractions(availableActions)
    },
    dialogues: projectDialogues(blueprint, state, readOnly)
  };
}
