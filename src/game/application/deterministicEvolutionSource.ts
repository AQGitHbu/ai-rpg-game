import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { NpcId } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// 确定性世界演化 source（离线/测试/兜底）：
// - next_act：当前地点补一个 NPC、可拾取信物与敌人 + 锚定该 NPC 的主线任务
//   （保证可达，同时让中篇兜底流程覆盖探索、物品、战斗三类入口）；
// - ending_pair：按故事契约的两条主题方向产出互斥结局对，并给两条结局附上
//   规则可判定的达成要求——以关键 NPC（首位 NPC，即开局主角锚点）的亲和度为
//   分歧信号：亲和度 ≥ TRUST_THRESHOLD 走 trust 结局，≤ DOUBT_THRESHOLD
//   走 doubt 结局（两阈值相邻，任何亲和度恰好命中其一，离线必有一个方向可达）。
// - pacing（回合修复）：按行动类型补齐缺失实体类别——talk→npc / move→地点
//   / investigate→fact / take_item→item / attack→enemy；无 action 时无提案。
// 输出纯提案；铸造与装配交给审批/具象化纯函数。
// ---------------------------------------------------------------------------

/** 信任结局所需的亲和度下限：关键 NPC 亲和度 ≥ 该值 → 信任方向。 */
export const TRUST_ENDING_MIN_AFFINITY = 10;
/** 质疑结局所需的亲和度上限：关键 NPC 亲和度 ≤ 该值 → 质疑方向（与信任阈值相邻）。 */
export const DOUBT_ENDING_MAX_AFFINITY = TRUST_ENDING_MIN_AFFINITY - 1;

function currentLocationId(ws: WorldState): string {
  return String(ws.currentLocationId);
}

function currentTownNeedsNewLocation(ws: WorldState): boolean {
  const location = ws.locations.find((entry) => entry.id === ws.currentLocationId);
  return location?.town !== undefined && location.town.slots.every((slot) => slot.boundNpcId !== null);
}

function planRepairByAction(ws: WorldState, action: Action): WorldDeltaProposal | null {
  const current = currentLocationId(ws);
  switch (action.type) {
    case "talk": {
      const useNewLocation = currentTownNeedsNewLocation(ws);
      return {
        beatSummary: "补充在场人物以回应交谈",
        newLocation: useNewLocation
          ? {
              name: `延伸之地·${ws.locations.length + 1}`,
              description: "从当前城镇延伸出的一处新地界，承接这次交谈。",
              scale: "scene",
              connectFromLocationId: current,
            }
          : null,
        newNpc: {
          name: "新来客",
          role: "过客",
          description: "恰好路过的旅人，愿意与你说上几句。",
          locationRef: useNewLocation
            ? { kind: "new_location" }
            : { kind: "existing", id: current },
          goals: ["随缘而行"],
        },
        newItem: null,
        newEnemy: null,
        newFact: null,
        nextMainQuest: null,
        endingPair: null,
      };
    }
    case "move":
      return {
        beatSummary: "地点延伸出一条新径",
        newLocation: {
          name: `延伸之地·${ws.locations.length + 1}`,
          description: "自当前所在之处延伸出的一小片新地界。",
          scale: "scene",
          connectFromLocationId: current,
        },
        newNpc: null,
        newItem: null,
        newEnemy: null,
        newFact: null,
        nextMainQuest: null,
        endingPair: null,
      };
    case "investigate":
      return {
        beatSummary: "现场浮出新的可探查线索",
        newLocation: null,
        newNpc: null,
        newItem: null,
        newEnemy: null,
        newFact: { text: "现场遗留的线索逐渐清晰。", visibility: "public" },
        nextMainQuest: null,
        endingPair: null,
      };
    case "take_item":
      return {
        beatSummary: "脚边发现可拾取的物件",
        newLocation: null,
        newNpc: null,
        newItem: { name: "散落之物", description: "不知何人遗落在此。", locationRef: "current" },
        newEnemy: null,
        newFact: null,
        nextMainQuest: null,
        endingPair: null,
      };
    case "attack":
      return {
        beatSummary: "阴影中现出敌人",
        newLocation: null,
        newNpc: null,
        newItem: null,
        newEnemy: { name: "来犯之敌", tier: "normal", locationRef: "current" },
        newFact: null,
        nextMainQuest: null,
        endingPair: null,
      };
    default:
      return null;
  }
}

function uniqueName(base: string, existingNames: readonly string[], suffix: string): string {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;

  let attempt = 1;
  let candidate = `${base}·${suffix}`;
  while (taken.has(candidate)) {
    attempt += 1;
    candidate = `${base}·${suffix}-${attempt}`;
  }
  return candidate;
}

function planNextAct(ws: WorldState, act: number): WorldDeltaProposal {
  const useNewLocation = currentTownNeedsNewLocation(ws);
  const npcName = uniqueName("传讯人", ws.npcs.map((npc) => npc.name), String(act));
  const questName = uniqueName("循迹而行", ws.quests.map((quest) => quest.name), `第${act}幕`);
  const itemName = uniqueName("幕间信物", ws.items.map((item) => item.name), String(act));
  const enemyName = uniqueName("迷雾守卫", ws.enemies.map((enemy) => enemy.name), String(act));
  const mountedLocation = useNewLocation ? "new_location" : "current";
  return {
    beatSummary: "下一幕的推进人物与先声",
    newLocation: useNewLocation
      ? {
          name: `延伸之地·${ws.locations.length + 1}`,
          description: "从当前城镇延伸出的一处新地界，承接下一幕的线索。",
          scale: "scene",
          connectFromLocationId: currentLocationId(ws),
        }
      : null,
        newNpc: {
      name: npcName,
      role: "信使",
      description: "风尘仆仆赶来的信使，手里攥着关乎下文的线索。",
      locationRef: useNewLocation
        ? { kind: "new_location" }
        : { kind: "existing", id: currentLocationId(ws) },
      goals: ["传递密信"],
    },
    newItem: {
      name: itemName,
      description: "在新线索旁发现的信物，表面留着尚未褪去的微光。",
      locationRef: mountedLocation,
    },
    newEnemy: {
      name: enemyName,
      tier: "normal",
      locationRef: mountedLocation,
    },
    newFact: {
      text: "信使带来的地图边角藏着一行尚未解读的暗号。",
      visibility: "npc_private",
    },
    nextMainQuest: {
      name: questName,
      description: "跟随信使的线索推进故事。",
      objectiveText: `与${npcName}交谈`,
    },
    endingPair: null,
  };
}

function planEndingPair(ws: WorldState, ss: StoryState): WorldDeltaProposal {
  const byKey = new Map(ss.contract.endingDirections.map((d) => [d.key, d.theme]));
  const themeName = (key: "trust" | "doubt", fallback: string): string => {
    const raw = (byKey.get(key) ?? "").trim();
    return raw.length >= 2 && raw.length <= 40 ? raw : fallback;
  };
  // 分歧信号：关键 NPC（首位 NPC）对玩家的亲和度。亲暖互动推高，敌意/质疑拉低。
  const keyNpcId: NpcId | undefined = ws.npcs[0]?.id;
  return {
    beatSummary: "终幕的两种走向浮现",
    newLocation: null,
    newNpc: null,
    newItem: null,
    newEnemy: null,
    newFact: null,
    nextMainQuest: null,
    endingPair: [
      {
        name: themeName("trust", "共赴真相"),
        description: "在众人面前摊开一切，共同承担结果。",
        themeKey: "trust",
        requirements: keyNpcId
          ? [{ kind: "npc_affinity_at_least", npcId: keyNpcId, value: TRUST_ENDING_MIN_AFFINITY }]
          : [],
      },
      {
        name: themeName("doubt", "孤身揭晓"),
        description: "独自揭开真相，把后果揽在自己肩上。",
        themeKey: "doubt",
        requirements: keyNpcId
          ? [{ kind: "npc_affinity_at_most", npcId: keyNpcId, value: DOUBT_ENDING_MAX_AFFINITY }]
          : [],
      },
    ],
  };
}

export function createDeterministicEvolutionSource(): WorldEvolutionSource {
  return {
    async propose(ctx) {
      switch (ctx.need.kind) {
        case "none":
          return { proposal: null };
        case "next_act":
          return { proposal: planNextAct(ctx.worldState, ctx.need.act) };
        case "ending_pair":
          return { proposal: planEndingPair(ctx.worldState, ctx.storyState) };
        case "pacing":
          return { proposal: ctx.action ? planRepairByAction(ctx.worldState, ctx.action) : null };
      }
    },
  };
}
