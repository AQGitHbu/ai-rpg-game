import { PLAYER_DIALOGUE_RESPONSE_LABELS, type GameState, type LocationScale, type ScenarioBlueprint } from "@/game/domain";
import { locationScaleOf, paginateSpeechText } from "@/game/domain";
import {
  composeNpcSpeech,
  type AvailableAction
} from "@/game/gameplay/rpg/actions";
import { projectTownLayerView, type TownLayerView } from "./townRuntimeView";

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
//   - 对话只投影 state.npcs 中位于当前地点的 NPC；Phase 14 后 choices 与
//     speechPages 均来自 currentScene（无场景时 choices=[]、speechPages 回退
//     composeNpcSpeech）；reviewClues 恒为已发现事实文本，独立于 choices。
//   - active battle 或结局后仍投影只读地图/地点资料，但 interactions 为空、
//     对话 choices 为空、freeInputEnabled=false（reviewClues 仍可展开）。
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
  /** Town 层：地点层级（scene = 两层，town = 三层），UI 据此切换视图形态。 */
  readonly scale: LocationScale;
  readonly interactions: readonly SceneInteractionView[];
};

/**
 * Phase 14：对话情境选项——直接来自 currentScene.choices 的安全投影。
 * 不再使用规则投影（greet/ask_main_quest/review_clue）。
 */
export type DialogueChoiceView = {
  readonly choiceToken: string;
  readonly label: string;
  /** Phase 14: 选项展示提示（如"将引入新 NPC"）；可缺失。 */
  readonly hint?: string;
};

export type NpcDialogueView = {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly slot: SceneSlot;
  /** 确定性对白分页：currentScene.npcDialogues 优先；缺失时回退 composeNpcSpeech。 */
  readonly speechPages: readonly string[];
  /** 选中预生成对白分支后显示的下一原子事件提示。 */
  readonly nextEventHint?: string;
  /** Phase 14：情境选项——来自 currentScene.choices（read-only 或不在场则为空）。 */
  readonly choices: readonly DialogueChoiceView[];
  /** Phase 14：是否允许自由输入——非只读且在场时为 true。 */
  readonly freeInputEnabled: boolean;
  /** 已发现事实文本：UI 用于本地只读回顾。 */
  readonly reviewClues: readonly string[];
  /** followup 播放 + 后台生成中：选项区替换为“准备中”提示。 */
  readonly preparingNextScene: boolean;
};

/**
 * Town 层就绪状态：none = 非 town 地点或规划尚未派生（按普通场景渲染）；
 * pending = AI 规划生成中（UI 显示占位并轮询 town/ensure）；ready = 可渲染。
 */
export type TownLayerStatus = "none" | "pending" | "ready";

export type LocationAdventureView = {
  readonly worldMap: WorldMapView;
  readonly locationScene: LocationSceneView;
  readonly dialogues: readonly NpcDialogueView[];
  /** Town 层：当前地点的小镇层就绪状态。 */
  readonly townStatus: TownLayerStatus;
  /** Town 层：小镇层视图——仅 townStatus === "ready" 时存在。 */
  readonly town?: TownLayerView;
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

/** 对白每页字符预算：纯展示策略常量，UI 不得自行重新分页。 */
export const SPEECH_PAGE_CHAR_BUDGET = 48;

/**
 * Phase 14：安全对话投影——choices 与 speechPages 都从 currentScene 读取。
 * - currentScene 为 null（pending / idle / fallback）→ choices 为空、speechPages 回退 composeNpcSpeech。
 * - 在场但不在 scene.npcDialogues 中的 NPC → choices 为空。
 * - readOnly（active battle 或结局）→ choices 为空、freeInputEnabled=false。
 * - freeInputEnabled 在非只读状态下恒为 true：自由输入是触发首场景生成的入口，
 *   不能依赖 currentScene 存在（否则无场景时玩家无法触发场景生成，形成死锁）。
 * - reviewClues 恒为已发现事实文本，UI 自行决定何时展开。
 */
function projectDialogues(
  blueprint: ScenarioBlueprint,
  state: GameState,
  readOnly: boolean
): readonly NpcDialogueView[] {
  const currentId = String(state.currentLocationId);
  const npcById = new Map(blueprint.npcs.map((npc) => [String(npc.id), npc]));
  const scene = state.narrative.currentScene;
  const focusNpcId = scene?.event?.kind === "dialogue" ? String(scene.event.focusNpcId) : undefined;
  // NarrativeSceneState 无 presentNpcIds 字段；从 npcDialogues 派生在场 IDs。
  const inSceneNpcIds: ReadonlySet<string> = new Set(
    (scene?.npcDialogues ?? []).map((d) => String(d.npcId))
  );
  const reviewClues = collectDiscoveredFactTexts(blueprint, state);

  const dialogues: NpcDialogueView[] = [];
  for (const npcState of state.npcs) {
    if (String(npcState.locationId) !== currentId) continue;
    if (focusNpcId !== undefined && String(npcState.npcId) !== focusNpcId) continue;
    const npc = npcById.get(String(npcState.npcId));
    if (npc === undefined) {
      throw new Error("对话投影失败：在场 NPC 引用在蓝图中不存在");
    }
    // 兼容旧 fallback/旧存档：dialogue event 已明确锁定焦点 NPC 时，
    // 即使 npcDialogues 尚未写入，也必须保留场景 choices，不能让对话面板变成空壳。
    const sceneHasThisNpc = inSceneNpcIds.has(String(npcState.npcId)) || (
      focusNpcId !== undefined &&
      String(npcState.npcId) === focusNpcId &&
      scene?.event?.kind === "dialogue"
    );

    // 从 currentScene.npcDialogues 读取该 NPC 的对白分页；缺失则回退 composeNpcSpeech。
    const sceneDialogue = scene?.npcDialogues?.find((d) => String(d.npcId) === String(npcState.npcId));
    const speechPages = sceneDialogue !== undefined
      ? sceneDialogue.speechPages
      : paginateSpeechText(
        composeNpcSpeech(blueprint, state, npcState.npcId),
        SPEECH_PAGE_CHAR_BUDGET
      );

    // 从 currentScene.choices 读取情境选项；read-only 或不在场则为空。
    const choices: readonly DialogueChoiceView[] = (readOnly || !sceneHasThisNpc || (scene?.event !== undefined && scene.event.kind !== "dialogue"))
      ? []
      : (scene?.choices ?? []).map((c, index) => ({
        choiceToken: c.choiceToken,
        label: scene?.event?.kind === "dialogue"
          ? PLAYER_DIALOGUE_RESPONSE_LABELS[index]
          : c.label,
        ...(c.hint !== undefined ? { hint: c.hint } : {})
      }));

    dialogues.push({
      npcId: String(npcState.npcId),
      name: npc.name,
      role: npc.role,
      slot: slotForId(String(npcState.npcId)),
      speechPages,
      ...(scene?.nextEventHint !== undefined && scene?.event?.kind === "dialogue"
        ? { nextEventHint: scene.nextEventHint }
        : {}),
      choices,
      // 自由输入是触发首场景的入口，不能依赖 currentScene 存在。
      freeInputEnabled: !readOnly && (scene === null || scene.event?.kind === "dialogue"),
      reviewClues,
      // followup 播放 + 后台生成中：选项区替换为“准备中”提示
      preparingNextScene: !readOnly
        && scene !== null
        && scene.event?.kind === "dialogue"
        && state.narrative.generation.status === "pending",
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
  const atomicEventActive = state.narrative.currentScene !== null || state.narrative.generation.status === "pending";

  // Town 层三态：ready（towns 已有条目 → 重建快照投影）/ pending（AI 生成中）
  // / none（非 town 地点，或 town 地点尚未进入过 → 按普通场景渲染）。
  const scale = locationScaleOf(currentLocation);
  const currentId = String(state.currentLocationId);
  let townStatus: TownLayerStatus = "none";
  let town: TownLayerView | undefined;
  if (scale === "town") {
    const entry = state.towns.find((item) => String(item.locationId) === currentId);
    if (entry !== undefined) {
      townStatus = "ready";
      // Phase 14：传 state 以应用小镇入口过滤（已结识 / talk 目标）。
      town = projectTownLayerView(blueprint, entry, state);
    } else if (
      state.townGeneration.status === "pending" &&
      String(state.townGeneration.locationId) === currentId
    ) {
      townStatus = "pending";
    }
  }

  return {
    worldMap: projectWorldMap(blueprint, state),
    locationScene: {
      title: currentLocation.name,
      description: currentLocation.description,
      backdrop: "location_backdrop",
      scale,
      interactions: readOnly || atomicEventActive ? [] : projectSceneInteractions(availableActions)
    },
    dialogues: projectDialogues(blueprint, state, readOnly),
    townStatus,
    ...(town !== undefined ? { town } : {})
  };
}
