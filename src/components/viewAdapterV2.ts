import type { GameSessionViewV2 } from "@/game/application/gameSessionViewV2";
import type { GameSessionView } from "@/game/application";

// ---------------------------------------------------------------------------
// V2→V1 view 适配器：将 V2 的 GameSessionViewV2 转换为 V1 的 GameSessionView
// 兼容结构，让 V1 视觉组件（WorldMapScreen、LocationSceneScreen 等）原样复用。
//
// V2 不支持的字段用安全默认值填充：
// - worldMap: 只包含当前地点和可移动地点的极简地图
// - locationScene: 从 currentLocation + narrative 派生
// - dialogues: 从 availableNpcs + narrative.npcLine 派生
// - townStatus: "none"（V2 暂不支持小镇层）
// - availableActions: 从 narrative.choices 派生
// - storyEvents: 空数组
// ---------------------------------------------------------------------------

export function adaptV2ToV1View(v2: GameSessionViewV2): GameSessionView {
  // 派生 worldMap（极简：当前地点 + 可移动地点，分散位置避免重叠）
  const MAP_POSITIONS = ["center", "north_west", "north_east", "south_west", "south_east"] as const;
  const mapNodes = [
    {
      state: "current" as const,
      locationId: String(v2.currentLocation.id),
      name: v2.currentLocation.name,
      position: MAP_POSITIONS[0],
      visual: "location_main" as const,
    },
    ...v2.availableMoves.map((m, i) => ({
      state: "travelable" as const,
      locationId: String(m.locationId),
      name: m.name,
      position: MAP_POSITIONS[(i + 1) % MAP_POSITIONS.length],
      visual: "map_node" as const,
    })),
  ];

  // 派生 availableActions（从 narrative.choices）
  const availableActions = v2.narrative.choices?.map((c) => {
    if (c.actionKey.startsWith("talk:")) {
      return { type: "talk" as const, npcId: c.actionKey.slice(5), label: c.label };
    }
    if (c.actionKey.startsWith("move:")) {
      return { type: "move" as const, locationId: c.actionKey.slice(5), label: c.label };
    }
    if (c.actionKey.startsWith("take_item:")) {
      return { type: "take_item" as const, itemId: c.actionKey.slice(10), label: c.label };
    }
    if (c.actionKey.startsWith("start_battle:")) {
      return { type: "start_battle" as const, enemyId: c.actionKey.slice(13), label: c.label };
    }
    return { type: "observe" as const, locationId: String(v2.currentLocation.id), label: c.label };
  }) ?? [];

  // 派生 dialogues（从 availableNpcs）
  const dialogueChoices = v2.narrative.choices?.map((c) => ({
    label: c.label,
    choiceToken: c.choiceToken,
  })) ?? [];
  const SLOT_POSITIONS = ["left", "right", "center", "foreground"] as const;
  const dialogues = v2.availableNpcs.map((npc, idx) => {
    // 每 NPC 对白：narrative.npcDialogues 非空分页优先；空页/缺失回退 npcLine，
    // 避免空数组 `??` 短路成无声对话。
    const npcDialogue = v2.narrative.npcDialogues?.find(
      (d) => String(d.npcId) === String(npc.id)
    );
    const npcLineMatches = v2.narrative.npcLine?.npcId === String(npc.id);
    const speechPages = npcDialogue !== undefined && npcDialogue.speechPages.length > 0
      ? npcDialogue.speechPages
      : npcLineMatches
        ? [v2.narrative.npcLine!.text]
        : [];
    return {
      npcId: String(npc.id),
      name: npc.name,
      role: npc.role,
      slot: SLOT_POSITIONS[idx % SLOT_POSITIONS.length],
      speechPages,
      choices: dialogueChoices,
      freeInputEnabled: true,
      reviewClues: [] as readonly string[],
      preparingNextScene: false,
    };
  });

  // 派生 presentNpcs
  const presentNpcs = v2.availableNpcs.map((n) => ({
    id: String(n.id),
    name: n.name,
    role: n.role,
    met: n.met,
  }));

  // 派生 inventoryItems
  const inventoryItems = v2.inventory.map((item) => ({
    name: item.name,
    description: "",
    category: "misc" as const,
    rarity: "common" as const,
    level: null,
    statLines: [],
    icon: "item_misc" as const,
  }));

  // 派生 activeQuests（从 V2 quests 的 objectives）
  const activeQuests = v2.quests
    .filter((q) => q.status === "active")
    .map((q) => ({
      name: q.name,
      description: q.description,
      kind: q.kind as "main" | "side",
      objectives: q.objectives.map((o) => ({
        label: o.label,
        completed: o.completed,
      })),
    }));

  // 派生 narrative (V1 NarrativeSceneView)
  const narrative = v2.narrative.hasScene && v2.narrative.narration
    ? {
        narration: v2.narrative.narration,
        eventKind: v2.narrative.eventKind as unknown as undefined,
        npcLine: v2.narrative.npcLine
          ? { text: v2.narrative.npcLine.text, emotion: v2.narrative.npcLine.emotion }
          : null,
        choices: v2.narrative.choices?.map((c) => ({
          label: c.label,
          choiceToken: c.choiceToken,
        })) ?? null,
        npcDialogues: [],
      }
    : null;

  // 派生 locationScene
  // interactions 只包含 observe/investigate/take_item/start_battle，不包含 talk
  //（NPC 对话由 view.dialogues 单独渲染，走 onOpenDialogue 回调）
  const locationScene = {
    title: v2.currentLocation.name,
    description: v2.currentLocation.description,
    backdrop: "location_backdrop" as const,
    scale: "scene" as const,
    interactions: [] as readonly unknown[],
  };

  // 组装 V1 view
  return {
    revision: v2.revision,
    gameType: v2.gameType,
    player: {
      name: v2.player.name,
      identity: v2.player.identity,
      stats: {
        hp: v2.player.hp,
        attack: v2.player.attack,
        defense: v2.player.defense,
      },
    },
    world: {
      gameType: v2.gameType,
    },
    currentLocationId: v2.currentLocation.id,
    locationScene,
    worldMap: { nodes: mapNodes },
    presentNpcs,
    availableActions,
    activeQuests,
    obtainableItems: [],
    inventoryItems,
    battle: v2.battle
      ? {
          enemyName: v2.battle.enemyName,
          playerHp: v2.battle.playerHp,
          enemyHp: v2.battle.enemyHp,
          round: v2.battle.round,
        }
      : null,
    ending: v2.ending
      ? {
          name: v2.ending.endingId,
          description: "",
          outcome: v2.ending.outcome as "success" | "failure",
        }
      : null,
    storyEvents: [],
    storyContinuity: [],
    dialogues,
    townStatus: "none" as const,
    narrative,
    narrativeGeneration: v2.narrativeGeneration
      ? { status: v2.narrativeGeneration.status as "ready" | "pending" }
      : { status: "ready" as const },
    prologueShown: v2.prologueShown,
    openingScene: {},
    // 开场字段（OpeningGameView 部分）
    visibleNpcs: presentNpcs,
    initialItems: inventoryItems,
  } as unknown as GameSessionView;
}
