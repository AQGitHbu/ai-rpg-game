import type { WorldState } from "@/game/domain/worldState";
import { findItem } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { MandatoryNarrativeBeat, MandatoryNarrativeBeatKind } from "@/game/domain/narrativeBeat";
import { MAX_MANDATORY_BEATS } from "@/game/domain/narrativeBeat";
import { isObjectiveSatisfied, objectiveLabel } from "./objectiveRules";
import { currentObjectiveOf } from "./deriveObjectiveTransition";

export type BuildOutcomeBeatsInput = {
  readonly resolvedEvent: ResolvedEvent;
  readonly beforeWorldState: WorldState;
  readonly beforeStoryState: StoryState;
  readonly afterWorldState: WorldState;
  readonly afterStoryState: StoryState;
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

  // player_utterance 不在此派生：resolvedEvent 不含玩家原文，由作业组合层用 job.utterance 注入。
  return beats;
}

export function buildOutcomeBeats(input: BuildOutcomeBeatsInput): MandatoryNarrativeBeat[] {
  const { resolvedEvent, beforeWorldState, beforeStoryState, afterWorldState, afterStoryState } = input;
  void resolvedEvent;
  return capMandatoryBeats(collectRawBeats({
    beforeW: beforeWorldState,
    afterW: afterWorldState,
    beforeS: beforeStoryState,
    afterS: afterStoryState,
  }));
}
