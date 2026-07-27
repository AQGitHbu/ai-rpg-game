import type { OpeningGameView } from "@/game/application";

// Phase 2 + Phase 3 组件测试共享 fixture：手写一份形如 read model 的开场视图。
// gameId 为 branded type，测试数据经 unknown 断言为 OpeningGameView。
export function buildOpeningViewFixture(): OpeningGameView {
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
      { type: "investigate", factId: "fact_notice", label: "调查缉凶告示" }
    ],
    knownFacts: [
      { text: "【玩家输入】沈青崖自述身份：落魄镖师" }
    ]
  } as unknown as OpeningGameView;
}
