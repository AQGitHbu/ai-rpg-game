import type {
  GameSessionView,
  LocationSceneView,
  NpcDialogueView,
  WorldMapView
} from "@/game/application";

// Phase 4 Task 4 组件测试共享 fixture：手写一份形如 GameSessionView 的会话视图
//（openingViewFixture 的演进：追加 move 行动、presentNpcs 与 activeQuests；
// Phase 5 Task 4 再追加 take_item 行动、obtainableItems 与 inventoryItems；
// Phase 6 Task 4 追加 battle/ending 字段；Phase 7 Task 5 追加 worldMap /
// locationScene / dialogues read model——新字段独立成 typed const，保证
// 即使整体经 unknown 断言，Phase 7 形状仍被编译器检查）。
// gameId 为 branded type，测试数据经 unknown 断言为 GameSessionView。

/** Phase 7：青石镇为当前地点的世界地图——四种节点状态各一。 */
const QINGSHI_WORLD_MAP: WorldMapView = {
  nodes: [
    { state: "current", locationId: "loc_qingshi", name: "青石镇", visual: "map_node", position: "north_west" },
    { state: "travelable", locationId: "loc_guandao", name: "城外官道", visual: "map_node", position: "north_east" },
    {
      state: "known",
      locationId: "loc_milin",
      name: "密林深处",
      hint: "需从相邻地点前往",
      visual: "map_node",
      position: "south_west"
    },
    { state: "locked", name: "探寻未知之地", hint: "尚未解锁", visual: "map_node_locked", position: "south_east" }
  ]
};

/** Phase 7：青石镇地点场景——互动与 availableActions 中的场景类行动一一对应。 */
const QINGSHI_LOCATION_SCENE: LocationSceneView = {
  title: "青石镇",
  description: "镇口贴着一张字迹潦草的缉凶告示。",
  backdrop: "location_backdrop",
  scale: "scene",
  interactions: [
    { kind: "observe", locationId: "loc_qingshi", label: "观察青石镇", slot: "center" },
    { kind: "investigate", factId: "fact_notice", label: "调查缉凶告示", slot: "left" },
    { kind: "take_item", itemId: "item_key", label: "拾取锈铁钥匙", slot: "right" }
  ]
};

/** Phase 7/14：青石镇在场 NPC 对话——Phase 14 后 choices 与 speechPages 均来自
 *  currentScene；fixture 模拟"无 currentScene"状态，故 choices=[]。
 *  freeInputEnabled=true：自由输入是触发首场景生成的入口，非只读状态下恒为 true。
 *  reviewClues 恒为已发现事实文本，UI 自行决定何时展开。 */
const QINGSHI_DIALOGUES: readonly NpcDialogueView[] = [
  {
    npcId: "npc_lu",
    name: "陆掌柜",
    role: "客栈掌柜",
    slot: "left",
    speechPages: ["陆掌柜擦着酒碗抬起头。又见面了，若有新的发现，随时可以来找我。"],
    choices: [],
    freeInputEnabled: true,
    reviewClues: ["【玩家输入】沈青崖自述身份：落魄镖师"],
    preparingNextScene: false
  },
  {
    npcId: "npc_zhao",
    name: "捕头赵五",
    role: "官府捕头",
    slot: "right",
    speechPages: [
      "捕头赵五按着刀柄扫了你一眼。初次见面，我是捕头赵五，官府捕头。",
      "最近镖局灭门案闹得人心惶惶——你愿意帮官府查明真相吗？"
    ],
    choices: [],
    freeInputEnabled: true,
    reviewClues: ["【玩家输入】沈青崖自述身份：落魄镖师"],
    preparingNextScene: false
  }
];

export function buildSessionViewFixture(): GameSessionView {
  return {
    gameId: "game-test-0001",
    world: { name: "武侠", summary: "镖局一夜覆灭，江湖各派暗流涌动。", gameType: "wuxia" },
    player: { name: "沈青崖", identity: "落魄镖师", stats: { hp: 30, attack: 6, defense: 4 } },
    currentLocation: { name: "青石镇", description: "镇口贴着一张字迹潦草的缉凶告示。" },
    visibleNpcs: [
      { name: "陆掌柜", role: "客栈掌柜" },
      { name: "捕头赵五", role: "官府捕头" }
    ],
    initialItems: [{ name: "旧刀", description: "父亲留下的佩刀，刀鞘磨损严重。" }],
    openingNarration: "暮色四合，你背着旧刀走进青石镇。",
    suggestedActions: ["去客栈打听消息", "查看缉凶告示"],
    generation: { generationId: "gen-test-0001", templateVersion: "fallback-1" },
    revision: 0,
    availableActions: [
      { type: "observe", locationId: "loc_qingshi", label: "观察青石镇" },
      { type: "talk", npcId: "npc_lu", label: "与陆掌柜交谈" },
      { type: "investigate", factId: "fact_notice", label: "调查缉凶告示" },
      { type: "move", locationId: "loc_guandao", label: "前往城外官道" },
      { type: "take_item", itemId: "item_key", label: "拾取锈铁钥匙" }
    ],
    obtainableItems: [
      { name: "锈铁钥匙", description: "钥匙柄上刻着镖局的徽记。" }
    ],
    inventoryItems: [
      {
        name: "旧刀",
        description: "父亲留下的佩刀，刀鞘磨损严重。",
        category: "equipment",
        rarity: "fine",
        level: 2,
        statLines: [
          { label: "攻击力", value: "+6" },
          { label: "身法", value: "+3%" }
        ],
        icon: "sword"
      }
    ],
    knownFacts: [
      { text: "【玩家输入】沈青崖自述身份：落魄镖师" }
    ],
    presentNpcs: [
      { name: "陆掌柜", role: "客栈掌柜" },
      { name: "捕头赵五", role: "官府捕头" }
    ],
    activeQuests: [
      {
        name: "查明灭门真相",
        description: "追查镖局灭门案背后的真凶。",
        kind: "main",
        objectives: [
          { label: "与陆掌柜交谈", completed: true, supported: true },
          { label: "到访城外官道", completed: false, supported: true },
          { label: "取得关键物品", completed: false, supported: false }
        ]
      }
    ],
    // Phase 6 Task 4：默认无战斗、无结局。
    battle: null,
    ending: null,
    storyEvents: [{ text: "你与陆掌柜交谈。对方以自己的身份和立场回应了你。" }],
    // Phase 11 Task 7：本章进展里程碑（具名、安全文本）。
    storyContinuity: [{ text: "到访青石镇" }, { text: "初会陆掌柜" }],
    // Phase 7 Task 5：地图 / 地点场景 / 安全对话 read model。
    worldMap: QINGSHI_WORLD_MAP,
    locationScene: QINGSHI_LOCATION_SCENE,
    dialogues: QINGSHI_DIALOGUES,
    // Town 层：默认非 town 地点。
    townStatus: "none",
    // Phase 10：叙事场景视图——默认无 AI 导演场景。
    narrative: null,
  } as unknown as GameSessionView;
}

/** 拾取成功后的会话视图：物品从可取得列表消失、进入背包，对应任务目标完成。 */
export function buildItemTakenSessionViewFixture(): GameSessionView {
  const base = buildSessionViewFixture();
  return {
    ...base,
    revision: 1,
    availableActions: base.availableActions.filter((action) => action.type !== "take_item"),
    obtainableItems: [],
    inventoryItems: [
      {
        name: "旧刀",
        description: "父亲留下的佩刀，刀鞘磨损严重。",
        category: "equipment",
        rarity: "fine",
        level: 2,
        statLines: [
          { label: "攻击力", value: "+6" },
          { label: "身法", value: "+3%" }
        ],
        icon: "sword"
      },
      {
        name: "锈铁钥匙",
        description: "钥匙柄上刻着镖局的徽记。",
        category: "quest",
        rarity: "rare",
        level: null,
        statLines: [],
        icon: "key"
      }
    ],
    activeQuests: [
      {
        name: "查明灭门真相",
        description: "追查镖局灭门案背后的真凶。",
        kind: "main",
        objectives: [
          { label: "与陆掌柜交谈", completed: true, supported: true },
          { label: "到访城外官道", completed: false, supported: true },
          { label: "取得关键物品", completed: true, supported: true }
        ]
      }
    ]
  } as unknown as GameSessionView;
}

/** 移动成功后的会话视图：新地点、新在场 NPC、新行动与更新后的任务。 */
export function buildMovedSessionViewFixture(): GameSessionView {
  const base = buildSessionViewFixture();
  return {
    ...base,
    revision: 1,
    currentLocation: { name: "城外官道", description: "黄土道上车辙纵横，隐约可见几处暗色血迹。" },
    presentNpcs: [{ name: "巡道老兵", role: "老兵" }],
    obtainableItems: [],
    availableActions: [
      { type: "observe", locationId: "loc_guandao", label: "观察城外官道" },
      { type: "move", locationId: "loc_qingshi", label: "返回青石镇" }
    ],
    activeQuests: [
      {
        name: "追查马帮下落",
        description: "顺着官道血迹追查马帮的踪迹。",
        kind: "main",
        objectives: [{ label: "查明相关线索", completed: false, supported: true }]
      }
    ],
    battle: null,
    ending: null,
    // Phase 7：移动成功后地图以城外官道为当前节点，场景与对话同步切换。
    worldMap: {
      nodes: [
        { state: "current", locationId: "loc_guandao", name: "城外官道", visual: "map_node", position: "north_east" },
        { state: "travelable", locationId: "loc_qingshi", name: "青石镇", visual: "map_node", position: "north_west" },
        {
          state: "known",
          locationId: "loc_milin",
          name: "密林深处",
          hint: "需从相邻地点前往",
          visual: "map_node",
          position: "south_west"
        },
        { state: "locked", name: "探寻未知之地", hint: "尚未解锁", visual: "map_node_locked", position: "south_east" }
      ]
    } satisfies WorldMapView,
    locationScene: {
      title: "城外官道",
      description: "黄土道上车辙纵横，隐约可见几处暗色血迹。",
      backdrop: "location_backdrop",
      scale: "scene",
      interactions: [
        { kind: "observe", locationId: "loc_guandao", label: "观察城外官道", slot: "center" }
      ]
    } satisfies LocationSceneView,
    dialogues: [
      {
        npcId: "npc_laobing",
        name: "巡道老兵",
        role: "老兵",
        slot: "center",
        speechPages: ["巡道老兵拄着长枪打量你。初次见面，我是巡道老兵，老兵。"],
        choices: [],
        freeInputEnabled: true,
        reviewClues: ["【玩家输入】沈青崖自述身份：落魄镖师"],
        preparingNextScene: false
      }
    ] satisfies readonly NpcDialogueView[]
  } as unknown as GameSessionView;
}

/** Phase 6 Task 4：战斗中的会话视图——active battle + battle_action 行动。 */
export function buildBattleSessionViewFixture(): GameSessionView {
  const base = buildSessionViewFixture();
  return {
    ...base,
    revision: 3,
    currentLocation: { name: "密林深处", description: "树影摇曳，杀气森森。" },
    availableActions: [
      { type: "battle_action", action: "attack", label: "攻击" },
      { type: "battle_action", action: "guard", label: "防御" },
      { type: "battle_action", action: "withdraw", label: "撤退" }
    ],
    battle: {
      enemyName: "暗影刺客",
      playerHp: 28,
      enemyHp: 15,
      round: 2
    },
    ending: null,
    // Phase 7：active battle 为只读投影——互动为空、无可写对话 choice。
    worldMap: {
      nodes: [
        { state: "current", locationId: "loc_milin", name: "密林深处", visual: "map_node", position: "south_west" },
        {
          state: "known",
          locationId: "loc_qingshi",
          name: "青石镇",
          hint: "需从相邻地点前往",
          visual: "map_node",
          position: "north_west"
        }
      ]
    } satisfies WorldMapView,
    locationScene: {
      title: "密林深处",
      description: "树影摇曳，杀气森森。",
      backdrop: "location_backdrop",
      scale: "scene",
      interactions: []
    } satisfies LocationSceneView,
    dialogues: [] satisfies readonly NpcDialogueView[]
  } as unknown as GameSessionView;
}

/** Phase 6 Task 4：成功结局的会话视图——ending outcome = success。 */
export function buildSuccessEndingSessionViewFixture(): GameSessionView {
  const base = buildSessionViewFixture();
  return {
    ...base,
    revision: 5,
    availableActions: [],
    obtainableItems: [],
    battle: null,
    ending: {
      name: "真相大白",
      description: "刺客伏诛，灭门真相终于大白于天下。",
      outcome: "success"
    },
    // Phase 7：结局后仍投影只读地图/场景，互动为空、对话 choices 已为空。
    locationScene: {
      ...QINGSHI_LOCATION_SCENE,
      interactions: []
    } satisfies LocationSceneView,
    dialogues: QINGSHI_DIALOGUES
  } as unknown as GameSessionView;
}

/** Phase 6 Task 4：失败结局的会话视图——ending outcome = failure。 */
export function buildFailureEndingSessionViewFixture(): GameSessionView {
  const base = buildSessionViewFixture();
  return {
    ...base,
    revision: 5,
    availableActions: [],
    obtainableItems: [],
    battle: null,
    ending: {
      name: "功亏一篑",
      description: "撤退后线索断裂，真相终被掩埋。",
      outcome: "failure"
    },
    // Phase 7：同成功结局——只读地图/场景，无可写互动与对话。
    locationScene: {
      ...QINGSHI_LOCATION_SCENE,
      interactions: []
    } satisfies LocationSceneView,
    dialogues: QINGSHI_DIALOGUES
  } as unknown as GameSessionView;
}
