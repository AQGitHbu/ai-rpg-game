import type { WorldState } from "@/game/domain/worldState";
import { findItem } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { MandatoryNarrativeBeat, MandatoryNarrativeBeatKind } from "@/game/domain/narrativeBeat";
import { ATMOSPHERE_BEAT_ID, MAX_MANDATORY_BEATS } from "@/game/domain/narrativeBeat";
import type { NpcId } from "@/game/domain/worldEntity";
import { isObjectiveSatisfied, objectiveLabel } from "./objectiveRules";
import { currentObjectiveOf } from "./deriveObjectiveTransition";

export type BuildOutcomeBeatsInput = {
  readonly resolvedEvent: ResolvedEvent;
  readonly beforeWorldState: WorldState;
  readonly beforeStoryState: StoryState;
  readonly afterWorldState: WorldState;
  readonly afterStoryState: StoryState;
  /** Task 5：玩家本轮原话（talk 行动）；存在且指向焦点 NPC 时强制产出 player_utterance 节拍。 */
  readonly utterance?: string;
  /** Task 5：行动指向的焦点 NPC（talk 行动为 action.npcId）。 */
  readonly npcId?: NpcId;
};

// 固定优先级（数字小者优先保留）。battle 生死优先，纯展开信息（entity_introduced）最先丢弃。
const BEAT_PRIORITY: readonly MandatoryNarrativeBeatKind[] = [
  "battle_resolved", "battle_started", "battle_round", "quest_advanced",
  "quest_progress", "item_obtained", "fact_discovered", "player_utterance", "entity_introduced",
];

export function capMandatoryBeats(beats: readonly MandatoryNarrativeBeat[]): MandatoryNarrativeBeat[] {
  const rank = new Map<string, number>(BEAT_PRIORITY.map((kind, i) => [kind, i]));
  return [...beats]
    .sort((a, b) => (rank.get(a.kind) ?? 99) - (rank.get(b.kind) ?? 99))
    .slice(0, MAX_MANDATORY_BEATS);
}

type CollectInput = {
  readonly beforeW: WorldState;
  readonly afterW: WorldState;
  readonly beforeS: StoryState;
  readonly afterS: StoryState;
};

function collectRawBeats({ beforeW, afterW, beforeS, afterS }: CollectInput): MandatoryNarrativeBeat[] {
  const beats: MandatoryNarrativeBeat[] = [];
  let seq = 0;
  const push = (kind: MandatoryNarrativeBeatKind, subjectIds: readonly string[], instruction: string): void => {
    beats.push({ beatId: `${kind}_${seq}`, kind, subjectIds: [...subjectIds], instruction });
    seq += 1;
  };

  // ── 战斗 ──
  const bBattle = beforeW.battle;
  const aBattle = afterW.battle;
  if (bBattle.status === "idle" && aBattle.status === "active") {
    const enemy = afterW.enemies.find((e) => e.id === aBattle.enemyId);
    push("battle_started", [String(aBattle.enemyId)], `遭遇了${enemy?.name ?? "敌人"}，战斗开始`);
  } else if (bBattle.status === "active" && aBattle.status === "active") {
    const enemy = afterW.enemies.find((e) => e.id === aBattle.enemyId);
    push("battle_round", [String(aBattle.enemyId)], `战斗进入第${aBattle.round}回合，我方生命 ${aBattle.playerHp}，敌方生命 ${aBattle.enemyHp}`);
  } else if (bBattle.status === "active" && aBattle.status === "resolved") {
    const enemy = afterW.enemies.find((e) => e.id === aBattle.enemyId);
    const outcomeLabel =
      aBattle.outcome === "victory" ? "胜利"
      : aBattle.outcome === "defeat" ? "败北"
      : "撤退";
    push("battle_resolved", [String(aBattle.enemyId)], `与${enemy?.name ?? "敌人"}的战斗以${outcomeLabel}告终`);
  }

  // ── 物品获得（库存增量；名称取当前世界状态）──
  for (const itemId of afterW.inventory) {
    if (beforeW.inventory.includes(itemId)) continue;
    const item = findItem(afterW, itemId);
    push("item_obtained", [String(itemId)], `获得物品「${item?.name ?? "未知物品"}」`);
  }

  // ── 事实发现 ──
  for (const fact of afterW.worldFacts) {
    const beforeFact = beforeW.worldFacts.find((f) => f.factId === fact.factId);
    if (!fact.discovered) continue;
    if (beforeFact?.discovered) continue;
    push("fact_discovered", [String(fact.factId)], `发现了线索：${fact.text}`);
  }

  // ── 任务目标推进（当前 authoritative 任务的前置目标新达成）──
  const beforeRef = currentObjectiveOf(beforeW, beforeS);
  const afterRef = currentObjectiveOf(afterW, afterS);
  const questId = afterRef?.questId ?? beforeRef?.questId;
  if (questId) {
    const beforeQuest = beforeW.quests.find((q) => q.id === questId);
    const afterQuest = afterW.quests.find((q) => q.id === questId);
    if (beforeQuest && afterQuest) {
      const limit = Math.max(beforeRef?.objectiveIndex ?? 0, afterRef?.objectiveIndex ?? 0);
      const newlySatisfied: string[] = [];
      for (let i = 0; i <= limit && i < beforeQuest.objectives.length; i += 1) {
        const objective = beforeQuest.objectives[i];
        if (objective && !isObjectiveSatisfied(beforeW, objective) && isObjectiveSatisfied(afterW, objective)) {
          newlySatisfied.push(objectiveLabel(afterW, afterQuest.objectives[i] ?? objective));
        }
      }
      if (newlySatisfied.length > 0) {
        push("quest_progress", [String(questId)], `完成了任务「${afterQuest.name}」的目标：${newlySatisfied.join("、")}`);
      }
    }
  }

  // ── 幕推进 ──
  if (afterS.currentAct > beforeS.currentAct) {
    const doneLabel = beforeRef?.label ?? "先前的目标";
    const targetLabel = afterRef?.label ?? "新的线索";
    push(
      "quest_advanced",
      afterRef ? [String(afterRef.questId)] : [],
      `主线推进到第${afterS.currentAct}幕。已完成：${doneLabel}；当前目标：${targetLabel}`,
    );
  }

  // ── 新实体现身（世界演化产物）──
  for (const npc of afterW.npcs) {
    if (beforeW.npcs.some((b) => b.id === npc.id)) continue;
    push("entity_introduced", [String(npc.id)], `新的角色「${npc.name}」登场（${npc.role}）`);
  }
  for (const quest of afterW.quests) {
    if (beforeW.quests.some((b) => b.id === quest.id)) continue;
    push("entity_introduced", [String(quest.id)], `新的任务「${quest.name}」开始`);
  }
  for (const location of afterW.locations) {
    if (beforeW.locations.some((b) => b.id === location.id)) continue;
    push("entity_introduced", [String(location.id)], `新的地点「${location.name}」解开了面纱`);
  }
  for (const item of afterW.items) {
    if (beforeW.items.some((b) => b.id === item.id)) continue;
    push("entity_introduced", [String(item.id)], `新的物品「${item.name}」出现了`);
  }
  for (const enemy of afterW.enemies) {
    if (beforeW.enemies.some((b) => b.id === enemy.id)) continue;
    push("entity_introduced", [String(enemy.id)], `新的威胁「${enemy.name}」出没`);
  }

  // player_utterance 不在 raw beats 中派生：由 buildOutcomeBeats 根据
  // input.utterance/npcId 生成强制节拍（原话只存在于 job.utterance）。
  return beats;
}

function requiredUtteranceBeat(input: BuildOutcomeBeatsInput): MandatoryNarrativeBeat | null {
  const utterance = input.utterance?.trim() ?? "";
  if (utterance === "" || input.npcId === undefined) return null;
  return {
    beatId: "player_utterance",
    kind: "player_utterance",
    subjectIds: [String(input.npcId)],
    // 只含规范化指示，绝不含玩家原话正文（原话只在 job.utterance 内）。
    instruction: "直接回应玩家刚说的话，并承接当前情境",
  };
}

export function buildOutcomeBeats(input: BuildOutcomeBeatsInput): MandatoryNarrativeBeat[] {
  const { resolvedEvent, beforeWorldState, beforeStoryState, afterWorldState, afterStoryState } = input;
  void resolvedEvent;
  const raw = collectRawBeats({
    beforeW: beforeWorldState,
    afterW: afterWorldState,
    beforeS: beforeStoryState,
    afterS: afterStoryState,
  });
  const capped = capMandatoryBeats(raw);
  const required = requiredUtteranceBeat(input);
  const base = required === null
    ? capped
    : capped.some((b) => b.kind === "player_utterance")
      ? capped
      // Mandatory：替换最低优先级节拍，保证 player_utterance 存在
      : [...capped.slice(0, MAX_MANDATORY_BEATS - 1), required];
  // Task 6：服务端氛围节拍恒在最后（可选表演段；缺失不算非法）。
  // 已达上限时替换最低优先级节拍，但 player_utterance 是 mandatory 必须保留。
  const atmosphere: MandatoryNarrativeBeat = {
    beatId: ATMOSPHERE_BEAT_ID,
    kind: "atmosphere",
    subjectIds: [],
    instruction: "对当前场景氛围的简短描写（可选，放在最后）",
  };
  if (base.length < MAX_MANDATORY_BEATS) return [...base, atmosphere];
  if (base[base.length - 1]?.kind === "player_utterance") {
    return [...base.slice(0, MAX_MANDATORY_BEATS - 2), base[base.length - 1]!, atmosphere];
  }
  return [...base.slice(0, MAX_MANDATORY_BEATS - 1), atmosphere];
}
