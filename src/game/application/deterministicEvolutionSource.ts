import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { NpcId } from "@/game/domain/worldEntity";

// ---------------------------------------------------------------------------
// 确定性世界演化 source（离线/测试/兜底）：
// - next_act：把有明确身份和前因的剧情角色落到当前地点，并配套信物、线索、
//   敌人和主线任务（保证可达，同时让中篇兜底流程覆盖探索、物品、战斗三类入口）；
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

/** 场景候选不足时的确定性续接：优先只补探索钩子；完全无入口时再补 NPC/地点。 */
function planSceneCandidateRecovery(ws: WorldState): WorldDeltaProposal {
  const currentLocation = ws.locations.find((location) => location.id === ws.currentLocationId);
  const hasExistingEntry = ws.npcs.some((npc) => npc.locationId === ws.currentLocationId)
    || (currentLocation?.connectedLocationIds.some((id) => ws.unlockedLocationIds.includes(id)) ?? false);
  const needsNpc = !hasExistingEntry;
  const useNewLocation = needsNpc && currentTownNeedsNewLocation(ws);
  const npcName = uniqueName("引路人", ws.npcs.map((npc) => npc.name), String(ws.npcs.length + 1));
  const itemName = uniqueName("路标残片", ws.items.map((item) => item.name), String(ws.items.length + 1));
  return {
    beatSummary: "一名引路人出现，为停滞的场景带来新的行动方向",
    newLocation: useNewLocation
      ? {
          name: uniqueName("新岔路", ws.locations.map((location) => location.name), String(ws.locations.length + 1)),
          description: "一条刚刚显露的岔路，与当前所在地相连。",
          scale: "scene",
          connectFromLocationId: currentLocationId(ws),
        }
      : null,
    newNpc: needsNpc
      ? {
          name: npcName,
          role: "引路人",
          description: "在故事停滞时现身的旅人，带来可以继续追寻的方向。",
          locationRef: useNewLocation
            ? { kind: "new_location" }
            : { kind: "existing", id: currentLocationId(ws) },
          goals: ["指出前路"],
        }
      : null,
    // 已有交谈/移动入口时只补一个探索钩子，避免候选恢复无谓占用 NPC/地点预算，
    // 也避免改变后续正式幕推进的确定性实体编号。
    newItem: {
      name: itemName,
      description: "一块刻着方向记号的残片，似乎能指向新的线索。",
      locationRef: "current",
    },
    newEnemy: null,
    newFact: null,
    nextMainQuest: null,
    endingPair: null,
  };
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

type ActBeat = {
  readonly npcName: string;
  readonly npcRole: string;
  readonly npcDescription: string;
  readonly npcGoal: string;
  readonly itemName: string;
  readonly itemDescription: string;
  readonly enemyName: string;
  readonly questName: string;
  readonly questDescription: string;
  readonly factText: string;
  readonly newLocation?: {
    readonly name: string;
    readonly description: string;
  };
};

/**
 * 离线 fallback 也要有“上一幕线索 → 下一幕人物 → 可验证威胁”的因果链。
 * 这些不是随机招募的人物：他们都是被上一条线索牵引到现场的剧情角色。
 */
function actBeatFor(act: number): ActBeat {
  switch (act) {
    case 2:
      return {
        npcName: "顾砚",
        npcRole: "旧案传讯人",
        npcDescription: "韩七托他把镇外脚印的密信交给沈青崖，他一路避开追兵才赶到酒楼。",
        npcGoal: "把韩七交代的密信送达",
        itemName: "染血腰牌",
        itemDescription: "顾砚交出的旧腰牌，血迹旁刻着与缉凶告示相同的暗纹。",
        enemyName: "黑衣追兵",
        questName: "追查镇外脚印",
        questDescription: "沿着韩七看见的脚印，核对顾砚带来的密信与腰牌。",
        factText: "腰牌上的暗纹与镇口缉凶告示来自同一桩旧案。",
        newLocation: {
          name: "北巷旧道",
          description: "酒楼后巷通往旧镖局的石道潮湿狭窄，车轮印在泥水里断续延伸。",
        },
      };
    case 3:
      return {
        npcName: "苏绾",
        npcRole: "失踪镖队幸存者",
        npcDescription: "她认出了染血腰牌，昨夜从断碑谷逃出后又折返回谷口，知道黑衣追兵为何盯上这桩旧案。",
        npcGoal: "说出断碑谷里被掩埋的真相",
        itemName: "断裂镖旗",
        itemDescription: "从苏绾手里接过的半面镖旗，旗角还沾着断碑谷的黑泥。",
        enemyName: "夺旗客",
        questName: "追问断碑谷",
        questDescription: "前往断碑谷找到苏绾，核对她带出的失踪镖队证词。",
        factText: "失踪镖队并非遇袭失散，押运的卷宗曾被人带进断碑谷。",
        newLocation: {
          name: "断碑谷",
          description: "荒碑夹着一线山谷，黑泥里留有被拖拽过的车辙。",
        },
      };
    case 4:
      return {
        npcName: "程砚秋",
        npcRole: "旧案卷宗保管人",
        npcDescription: "他沿着断碑谷留下的车辙追到谷口，手里藏着能证明幕后主使的残卷。",
        npcGoal: "交出能指向幕后主使的残卷",
        itemName: "残缺卷宗",
        itemDescription: "被撕去关键页的卷宗，剩下的印记仍能与缉凶告示互相印证。",
        enemyName: "灭口刺客",
        questName: "拼回旧案卷宗",
        questDescription: "保护程砚秋并拼回残卷，确认这场追杀真正要掩盖的名字。",
        factText: "卷宗缺失的最后一页，记录着旧案主使曾在青石镇落脚。",
      };
    case 5:
      return {
        npcName: "陆归鸿",
        npcRole: "旧案知情人",
        npcDescription: "他带着最后一页卷宗在黑水古道现身，承认自己曾替幕后主使传递命令，如今决定说出真相。",
        npcGoal: "在沈青崖面前说出幕后主使的身份",
        itemName: "盟誓铁印",
        itemDescription: "卷宗最后一页上的铁印，能让旧案的责任在终幕前落到实处。",
        enemyName: "迷雾首领",
        questName: "揭开青石旧案",
        questDescription: "前往黑水古道找到陆归鸿，确认幕后主使并面对最后的阻拦。",
        factText: "最后一页卷宗确认：青石镇的缉凶告示是为了掩盖一场灭口。",
        newLocation: {
          name: "黑水古道",
          description: "通往旧案主使藏身处的古道，雾气从碎石缝里不断涌出。",
        },
      };
    default:
      return {
        npcName: `传讯人·${act}`,
        npcRole: "线索传递人",
        npcDescription: "顺着上一幕留下的线索赶来的传讯人，手里攥着尚未解开的证据。",
        npcGoal: "交出下一段线索",
        itemName: `幕间信物·${act}`,
        itemDescription: "与上一幕线索相互印证的信物。",
        enemyName: `迷雾守卫·${act}`,
        questName: `循迹而行·第${act}幕`,
        questDescription: "沿着已经确认的线索继续追查。",
        factText: "新的证据与前几幕的线索指向同一桩旧案。",
      };
  }
}

function planNextAct(ws: WorldState, act: number): WorldDeltaProposal {
  const beat = actBeatFor(act);
  const npcName = uniqueName(beat.npcName, ws.npcs.map((npc) => npc.name), String(act));
  const questName = uniqueName(beat.questName, ws.quests.map((quest) => quest.name), `第${act}幕`);
  const itemName = uniqueName(beat.itemName, ws.items.map((item) => item.name), String(act));
  const enemyName = uniqueName(beat.enemyName, ws.enemies.map((enemy) => enemy.name), String(act));
  const mountedLocation = beat.newLocation === undefined ? "current" : "new_location";
  return {
    beatSummary: `第${act}幕：${npcName}承接上一幕留下的线索`,
    newLocation: beat.newLocation
      ? {
          name: uniqueName(beat.newLocation.name, ws.locations.map((location) => location.name), String(act)),
          description: beat.newLocation.description,
          scale: "scene",
          connectFromLocationId: currentLocationId(ws),
        }
      : null,
    // 有新地点时，NPC、物品和敌人一起落在新地点，主线目标会先要求玩家前往
    // 该地点再交谈；没有新地点时才沿用当前地点。这样“前往断碑谷/黑水古道”
    // 不会只出现在任务描述里，而会成为真实可执行的主线步骤。
    newNpc: {
      name: npcName,
      role: beat.npcRole,
      description: beat.npcDescription,
      locationRef: beat.newLocation
        ? { kind: "new_location" }
        : { kind: "existing", id: currentLocationId(ws) },
      goals: [beat.npcGoal],
    },
    newItem: {
      name: itemName,
      description: beat.itemDescription,
      locationRef: mountedLocation,
    },
    newEnemy: {
      name: enemyName,
      tier: act === 5 ? "boss" : "normal",
      locationRef: mountedLocation,
    },
    newFact: {
      text: beat.factText,
      visibility: "public",
      investigationLabel: act === 2 ? "酒楼后巷的车轮印" : "现场留下的线索",
    },
    nextMainQuest: {
      name: questName,
      description: beat.questDescription,
      objectiveText: `与${npcName}交谈`,
    },
    endingPair: null,
  };
}

function planEndingPair(ws: WorldState, ss: StoryState): WorldDeltaProposal {
  const conflict = ss.contract.centralConflict.trim().replace(/[。！？]+$/gu, "") || "这桩旧案";
  // 分歧信号：关键 NPC（首位 NPC）对玩家的亲和度；终幕 support/challenge
  // 的直接裁决由 resolveEnding 读取最后一次结构化互动，不与此门槛混用。
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
        name: "共同揭露真相",
      description: `你与愿意作证的人一同公开已核对的证据，让“${conflict}”不再只是传闻；该承担责任的人无处可逃。`,
        themeKey: "trust",
        requirements: keyNpcId
          ? [{ kind: "npc_affinity_at_least", npcId: keyNpcId, value: TRUST_ENDING_MIN_AFFINITY }]
          : [],
      },
      {
        name: "独自追查到底",
      description: `你保留最后的判断，独自追查“${conflict}”背后的责任归属，并承担揭露真相后的代价。`,
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
          return {
            proposal: ctx.action
              ? planRepairByAction(ctx.worldState, ctx.action)
              : ctx.reason === "scene_candidate_shortage"
                ? planSceneCandidateRecovery(ctx.worldState)
                : null,
          };
      }
    },
  };
}
