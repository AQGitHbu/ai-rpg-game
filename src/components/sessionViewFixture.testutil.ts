import type { GameSessionView } from "@/game/application";

// Phase 4 Task 4 组件测试共享 fixture：手写一份形如 GameSessionView 的会话视图
//（openingViewFixture 的演进：追加 move 行动、presentNpcs 与 activeQuests；
// Phase 5 Task 4 再追加 take_item 行动、obtainableItems 与 inventoryItems；
// Phase 6 Task 4 追加 battle/ending 字段）。
// gameId 为 branded type，测试数据经 unknown 断言为 GameSessionView。
export function buildSessionViewFixture(): GameSessionView {
  return {
    gameId: "game-test-0001",
    world: { name: "武侠", summary: "镖局一夜覆灭，江湖各派暗流涌动。", gameType: "wuxia" },
    player: { name: "沈青崖", identity: "落魄镖师" },
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
      { name: "旧刀", description: "父亲留下的佩刀，刀鞘磨损严重。" }
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
    ending: null
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
      { name: "旧刀", description: "父亲留下的佩刀，刀鞘磨损严重。" },
      { name: "锈铁钥匙", description: "钥匙柄上刻着镖局的徽记。" }
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
    ending: null
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
    ending: null
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
    }
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
    }
  } as unknown as GameSessionView;
}
