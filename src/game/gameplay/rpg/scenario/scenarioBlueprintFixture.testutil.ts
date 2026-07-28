import { CONTENT_BUDGET, type ScenarioBlueprintCandidate } from "@/game/domain";
import type { GameTypeProfile } from "./gameTypeProfiles";

// ---------------------------------------------------------------------------
// 测试专用 fixture（.testutil.ts 不会被 vitest 当作测试文件收集）。
// 提供一份满足 Task 5 全部校验规则的合法候选蓝图，供 validate/compile 测试
// 共享；每次调用返回全新对象，测试可安全变异。生产代码禁止引用本文件。
//
// 任务图沿用 questGraph.test.ts 的形状：
//   m1(主线1) --成功--> m2(主线2) + s1(支线)
//   m2(主线2) --成功--> m3(主线3)
//   m3(主线3) --成功--> e1 / --失败--> e2
// ---------------------------------------------------------------------------

/** 与 data/base 配置同形的最小武侠 profile；forbiddenTags 供禁止标签测试使用。 */
export const TEST_PROFILE: GameTypeProfile = {
  id: "wuxia",
  label: "武侠",
  worldConstraints: ["低魔世界，不出现现代科技"],
  allowedTags: ["江湖", "门派"],
  forbiddenTags: ["科技", "枪械"],
  namingGuide: ["中文姓名"],
  artStyleProfileId: "ink_wash"
};

export function makeValidCandidate(): ScenarioBlueprintCandidate {
  return {
    schemaVersion: 1,
    generationId: "gen_0001",
    seed: "seed-1",
    templateVersion: "tpl-1",
    gameType: "wuxia",
    inputDigest: "digest-1",
    world: {
      summary: "镖局覆灭之后，江湖各派暗流涌动。",
      tone: "苍凉",
      themes: ["复仇", "侠义"],
      facts: [
        { id: "fact_a", text: "主角出身青崖镖局。", source: "player_input" },
        { id: "fact_b", text: "山门深处藏有一条密道。", source: "generated" }
      ],
      tags: ["江湖"]
    },
    player: {
      name: "沈青崖",
      identity: "落魄镖师",
      backgroundSummary: "镖局覆灭后独自追查真凶。",
      startingLocationId: "loc_a",
      startingItemIds: ["item_a"],
      baseStats: { hp: 30, attack: 6, defense: 4 }
    },
    locations: [
      {
        id: "loc_a",
        name: "青崖镇",
        description: "镖局旧址所在的小镇。",
        kind: "main",
        connectedLocationIds: ["loc_b"],
        npcIds: ["npc_a"],
        availableItemIds: [],
        tags: ["江湖"]
      },
      {
        id: "loc_b",
        name: "渡口集市",
        description: "南来北往的消息集散地。",
        kind: "main",
        connectedLocationIds: ["loc_a", "loc_c"],
        npcIds: ["npc_b"],
        availableItemIds: [],
        tags: []
      },
      {
        id: "loc_c",
        name: "铁剑山庄",
        description: "武林世家的山庄。",
        kind: "main",
        connectedLocationIds: ["loc_b", "loc_d"],
        npcIds: ["npc_c"],
        // m2（主线二阶段）的 obtain_item 目标：信物放在铁剑山庄（npc_c 所在地）。
        availableItemIds: ["item_b"],
        tags: []
      },
      {
        id: "loc_d",
        name: "断魂崖",
        description: "决战之地。",
        kind: "main",
        connectedLocationIds: ["loc_c"],
        npcIds: ["npc_d"],
        availableItemIds: [],
        tags: []
      },
      {
        id: "loc_h",
        name: "山门密道",
        description: "隐藏在山门深处的密道。",
        kind: "hidden",
        connectedLocationIds: ["loc_d"],
        npcIds: [],
        availableItemIds: [],
        tags: []
      }
    ],
    npcs: [
      {
        id: "npc_a",
        name: "老掌柜",
        role: "线人",
        description: "镖局旧识。",
        locationId: "loc_a",
        isCompanion: false,
        knownFactIds: ["fact_a"],
        tags: []
      },
      {
        id: "npc_b",
        name: "渡口船娘",
        role: "商贩",
        description: "消息灵通。",
        locationId: "loc_b",
        isCompanion: false,
        knownFactIds: [],
        tags: []
      },
      {
        id: "npc_c",
        name: "铁剑庄主",
        role: "盟友",
        description: "武林世家之主。",
        locationId: "loc_c",
        isCompanion: false,
        knownFactIds: ["fact_b"],
        tags: []
      },
      {
        id: "npc_d",
        name: "小捕快",
        role: "同伴",
        description: "愿意随行的年轻捕快。",
        locationId: "loc_d",
        isCompanion: true,
        knownFactIds: [],
        tags: []
      }
    ],
    quests: [
      {
        kind: "main",
        stage: 1,
        id: "m1",
        name: "旧案重启",
        description: "前往渡口集市打探灭门案线索。",
        objectives: [{ kind: "visit_location", locationId: "loc_b" }],
        onSuccess: { kind: "unlock_quests", questIds: ["m2", "s1"] },
        onFailure: { kind: "closed" },
        tags: []
      },
      {
        kind: "main",
        stage: 2,
        id: "m2",
        name: "山庄求证",
        description: "向铁剑庄主求证并取回镖局信物。",
        objectives: [
          { kind: "talk_to_npc", npcId: "npc_c" },
          { kind: "obtain_item", itemId: "item_b" }
        ],
        onSuccess: { kind: "unlock_quests", questIds: ["m3"] },
        onFailure: { kind: "closed" },
        tags: []
      },
      {
        kind: "main",
        stage: 3,
        id: "m3",
        name: "断魂决战",
        description: "在断魂崖与幕后黑手决战。",
        objectives: [{ kind: "defeat_enemy", enemyId: "enemy_b" }],
        onSuccess: { kind: "reach_ending", endingId: "e1" },
        onFailure: { kind: "reach_ending", endingId: "e2" },
        tags: []
      },
      {
        kind: "side",
        id: "s1",
        name: "密道传闻",
        description: "查明山门密道的传闻。",
        objectives: [{ kind: "discover_fact", factId: "fact_b" }],
        onSuccess: { kind: "closed" },
        onFailure: { kind: "closed" },
        tags: []
      }
    ],
    enemies: [
      {
        id: "enemy_a",
        name: "黑衣刺客",
        tier: "normal",
        stats: { hp: 20, attack: 5, defense: 2 },
        locationId: "loc_b",
        tags: []
      },
      {
        id: "enemy_b",
        name: "幕后黑手",
        tier: "boss",
        stats: { hp: 20, attack: 5, defense: 2 },
        locationId: "loc_d",
        tags: []
      }
    ],
    items: [
      {
        id: "item_a",
        name: "护身短刀",
        description: "镖局旧物。",
        kind: "weapon",
        tags: []
      },
      {
        id: "item_b",
        name: "镖局信物",
        description: "证明身份的信物。",
        kind: "key",
        tags: []
      }
    ],
    endings: [
      {
        id: "e1",
        name: "沉冤得雪",
        description: "真相大白，镖局冤案昭雪。",
        requirements: [{ kind: "quest_completed", questId: "m3" }]
      },
      {
        id: "e2",
        name: "遁入山门",
        description: "复仇失败，借密道远走。",
        requirements: [{ kind: "quest_failed", questId: "m3" }]
      }
    ],
    openingScene: {
      id: "scene_opening",
      locationId: "loc_a",
      narration: "暮色里的青崖镇一片死寂，老掌柜提着灯笼迎面走来。",
      presentNpcIds: ["npc_a"],
      suggestedActions: ["向老掌柜打听旧案", "查看镖局废墟"],
      investigableFactIds: ["fact_b"]
    },
    contentBudget: { ...CONTENT_BUDGET }
  };
}
