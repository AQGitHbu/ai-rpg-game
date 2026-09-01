import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { Action } from "@/game/domain/action";
import type { WorldDeltaProposal } from "@/game/domain/worldDelta";
import type { WorldEvolutionSource } from "./worldEvolutionSource";
import type { NpcId } from "@/game/domain/worldEntity";
import { deriveKeyEndingNpcId } from "@/game/gameplay/rpg/worldEvolution";
import { actBeatFor, defaultInvestigationApproachesFor, type EvolutionActBeat } from "./deterministicEvolutionBeats";

// ---------------------------------------------------------------------------
// 确定性世界演化 source（离线/测试/兜底）：
// - next_act：把有明确身份和前因的剧情角色落到当前地点，并配套信物、线索、
//   敌人和主线任务（保证可达，同时让中篇兜底流程覆盖探索、物品、战斗三类入口）；
// - ending_pair：按故事契约的两条主题方向产出互斥结局对，并给两条结局附上
//   规则可判定的达成要求——以关键 NPC（stage 最大主线的交谈目标，回退首位 NPC）
//   的亲和度为分歧信号：亲和度 ≥ TRUST_THRESHOLD 走 trust 结局，≤ DOUBT_THRESHOLD
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
              placement: "world",
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
          anchors: {
            selfConcept: "愿意替陌生人指路的过客",
            values: ["守信"],
            speechStyle: "爽快直白",
            capabilityBoundaries: ["不了解未亲眼见过的远方"],
            taboos: ["不卷入无关争斗"],
          },
          goals: [{ horizon: "short", description: "随缘而行", priority: 3, reason: "这次交谈让他决定顺路指引来者" }],
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
          placement: "world",
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
          placement: "world",
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
          anchors: {
            selfConcept: "把人带出迷路处的引路人",
            values: ["守望"],
            speechStyle: "只说亲眼见闻",
            capabilityBoundaries: ["不掌握深层内幕"],
            taboos: [],
          },
          goals: [{ horizon: "short", description: "指出前路", priority: 3, reason: "眼前有人需要一条可以继续追寻的方向" }],
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

/** 无行动上下文的 pacing 预览只补一名当前地点路人，避免离线 fixture 抢占主线物品。 */
function planScenePacingRecovery(ws: WorldState): WorldDeltaProposal {
  return {
    beatSummary: "当前地点多了一名可以提供旁观信息的路人",
    newLocation: null,
    newNpc: {
      name: uniqueName("旁观者", ws.npcs.map((npc) => npc.name), String(ws.npcs.length + 1)),
      role: "路人",
      description: "在场的普通路人，知道一些公开的动静。",
      locationRef: { kind: "existing", id: currentLocationId(ws) },
      anchors: {
        selfConcept: "留意街巷动静的旁观者",
        values: ["谨慎"],
        speechStyle: "先观察再开口",
        capabilityBoundaries: ["只能提供公开见闻"],
        taboos: ["不替陌生人作证"],
      },
      goals: [{ horizon: "short", description: "观察动静", priority: 2, reason: "周围的异常值得先留意清楚" }],
    },
    newItem: null,
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

function planNextAct(ws: WorldState, act: number): WorldDeltaProposal {
  const beat: EvolutionActBeat = actBeatFor(ws.generation.gameType, act);
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
              placement: "world",
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
      anchors: {
        selfConcept: `承接第${act}幕线索的${beat.npcRole}`,
        values: ["守住线索"],
        speechStyle: "只陈述亲身见闻",
        capabilityBoundaries: ["不能替别人作证"],
        taboos: ["不泄露无关者身份"],
      },
      goals: [{ horizon: "short", description: beat.npcGoal, priority: 3, reason: beat.questDescription }],
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
      investigationLabel: beat.investigationLabel ?? "现场留下的线索",
      // 确定性生成的调查事实直接附上题材词库里的安全默认方式
      // （repair 事实无 investigationLabel、走自动揭示，故不附方式）。
      investigationApproaches: defaultInvestigationApproachesFor(ws.generation.gameType),
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
  // 分歧信号：关键 NPC（stage 最大主线的交谈目标，回退首位 NPC）对玩家的亲和度；
  // 终幕 support/challenge 的直接裁决由 resolveEnding 读取最后一次结构化互动，
  // 不与此门槛混用。
  const keyNpcId: NpcId | undefined = deriveKeyEndingNpcId(ws);
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
          return { ok: true, proposal: null };
        case "next_act":
          return { ok: true, proposal: planNextAct(ctx.worldState, ctx.need.act) };
        case "ending_pair":
          return { ok: true, proposal: planEndingPair(ctx.worldState, ctx.storyState) };
        case "pacing":
          return {
            ok: true,
            proposal: ctx.action
              ? planRepairByAction(ctx.worldState, ctx.action)
              : ctx.reason === "scene_candidate_shortage"
                ? planSceneCandidateRecovery(ctx.worldState)
                : planScenePacingRecovery(ctx.worldState),
          };
      }
    },
  };
}
