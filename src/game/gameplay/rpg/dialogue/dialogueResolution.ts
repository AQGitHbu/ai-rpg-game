import type { WorldState, NpcEntry, NpcInteraction } from "@/game/domain/worldState";
import type { DialogueAct, DialogueTopic, TalkAction } from "@/game/domain/action";
import { relationshipTierOf, type RelationshipTier } from "@/game/domain/relationship";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type { RelationshipSignal } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID, type FactId } from "@/game/domain/worldEntity";
import type { GameEvent } from "@/game/domain/events";
import type { StateChange } from "@/game/domain/resolvedEvent";
import { RELATIONSHIP_SIGNAL_POLICY } from "@/game/gameplay/rpg/npcMemory";
import type { EntityMutation, NpcInteractionPayload } from "@/game/gameplay/rpg/entityWorld/entityMutation";

// ---------------------------------------------------------------------------
// 固定对话选项的结构化裁决（Spec §7.2 / FND-03）。
// 纯规则：只读取 dialogueAct、topic、关系档位与 NPC 知识，绝不读取 utterance。
// 不读时钟/随机数：时间由调用方注入 deps.now。
// ---------------------------------------------------------------------------

export type DialogueDeps = {
  readonly now: () => string;
  /** 当前回合的 actionId：用于记忆零写入去重（同 actionId 不重复追加）。 */
  readonly actionId: string;
  /** 当前回合号：写入 NpcInteraction.turnNumber。 */
  readonly turnNumber: number;
};

export type DialogueStatus = "success" | "partial_success" | "failure";

/** NPC 对 topic fact 的披露情况；非 fact topic 为 not_applicable。 */
export type DialogueDisclosure =
  | { readonly kind: "revealed"; readonly factId: FactId }
  | { readonly kind: "withheld" }
  | { readonly kind: "not_applicable" };

export type DialogueResolution = {
  readonly status: DialogueStatus;
  readonly outcome: NpcInteraction["outcome"];
  readonly disclosure: DialogueDisclosure;
  readonly signal: RelationshipSignal | null;
  readonly interaction: NpcInteractionPayload;
  readonly mutations: readonly EntityMutation[];
  readonly event: GameEvent;
  readonly feedback: string;
  readonly stateChanges: readonly StateChange[];
};

/** 对话行为只声明既有关系 signal；数值、趋势和裁剪均由关系规则表负责。 */
const DIALOGUE_SIGNAL_BY_ACT: Readonly<Record<DialogueAct, RelationshipSignal | null>> = {
  ask: null,
  support: "supported",
  challenge: "challenged",
  threaten: "threatened",
  deceive: "deceived",
  offer: "offered_help",
  refuse: "refused",
  reassure: "reassured",
};

/** 档位坦诚度：NPC 主动透露的意愿基线。 */
export const DIALOGUE_TIER_CANDIDNESS: Readonly<Record<RelationshipTier, number>> = {
  hostile: 0.1,
  cold: 0.3,
  neutral: 0.5,
  friendly: 0.7,
  trusted: 0.9,
};

/** 每种 dialogueAct 的追问/威压系数：给坦诚度的加成。 */
export const DIALOGUE_ACT_PRESSURE: Readonly<Record<DialogueAct, number>> = {
  ask: 0,
  support: 0.2,
  challenge: 0.3,
  threaten: 0.7,
  deceive: 0.2,
  offer: 0.2,
  refuse: 0,
  reassure: 0.1,
};

/** 披露阈值：坦诚度 + 威压 ≥ 阈值才披露。 */
export const DIALOGUE_REVEAL_THRESHOLD = 0.5;

function outcomeFor(signal: RelationshipSignal | null): NpcInteraction["outcome"] {
  if (signal === null) return "neutral";
  const trend = RELATIONSHIP_SIGNAL_POLICY[signal].trend;
  if (trend === "improving") return "positive";
  if (trend === "worsening") return "negative";
  return "neutral";
}

/** 对话结果的情绪映射；情绪是 qualitative state，由对话批次提交窄写入。 */
export function emotionForOutcome(
  outcome: NpcInteraction["outcome"],
  prevEmotion: NarrativeEmotion,
): NarrativeEmotion {
  if (outcome === "positive") return "warm";
  if (outcome === "negative") return "guarded";
  if (outcome === "mixed" && (prevEmotion === "guarded" || prevEmotion === "angry")) return "neutral";
  return prevEmotion;
}

function statusFor(
  act: DialogueAct,
  tier: RelationshipTier,
  outcome: NpcInteraction["outcome"],
  disclosure: DialogueDisclosure,
): DialogueStatus {
  if (tier === "hostile" && (act === "threaten" || act === "deceive")) return "failure";
  // hostile NPC 对没有具体披露内容的 ask 仍只勉强交流；这保持既有 qualitative status 语义，
  // 不把它重新伪造成关系数值或 signal。
  if (tier === "hostile" && act === "ask" && disclosure.kind !== "revealed") return "partial_success";
  if (outcome === "negative" || disclosure.kind === "withheld") return "partial_success";
  return "success";
}

/** 主题摘要（规则生成，绝不含玩家原文；不含事实内容本身）。 */
function topicSummaryFor(topic: DialogueTopic): string {
  if (topic.kind === "fact") return "询问线索";
  if (topic.kind === "quest") return "谈论任务";
  if (topic.kind === "thread") return "延续话题";
  return "闲谈";
}

function feedbackFor(name: string, status: DialogueStatus, disclosure: DialogueDisclosure): string {
  const base = `你与${name}交谈`;
  if (status === "failure") return `${base}，对方不愿继续交流。`;
  if (disclosure.kind === "revealed") return `${base}，对方透露了线索。`;
  if (disclosure.kind === "withheld") return `${base}，但对方没有透露实情。`;
  return `${base}。`;
}

export function resolveDialogue(
  ws: WorldState,
  npc: NpcEntry,
  action: TalkAction,
  deps: DialogueDeps,
): DialogueResolution {
  const act = action.dialogueAct;
  const topic = action.topic ?? { kind: "general" };
  const tier = relationshipTierOf(npc.memory.relationship);

  // 披露裁决：NPC 不知道（或藏着）topic fact 时绝不能直接透露
  let disclosure: DialogueDisclosure = { kind: "not_applicable" };
  if (topic.kind === "fact") {
    const known = npc.memory.knownFactIds.includes(topic.factId);
    const hidden = npc.memory.hiddenFactIds.includes(topic.factId);
    const candidness = DIALOGUE_TIER_CANDIDNESS[tier];
    const pressure = DIALOGUE_ACT_PRESSURE[act];
    disclosure = known && !hidden && candidness + pressure >= DIALOGUE_REVEAL_THRESHOLD
      ? { kind: "revealed", factId: topic.factId }
      : { kind: "withheld" };
  }

  const signal = act === "ask" && disclosure.kind !== "revealed"
    ? null
    : act === "ask"
      ? "shared_fact"
      : DIALOGUE_SIGNAL_BY_ACT[act];
  const outcome = outcomeFor(signal);
  const status = statusFor(act, tier, outcome, disclosure);
  // NPC 当场披露的事实才进入本轮 learnedFactIds（玩家由此得知）。
  const learnedFactIds = disclosure.kind === "revealed" ? [disclosure.factId] : [];

  const interaction: NpcInteractionPayload = {
    turnNumber: deps.turnNumber,
    actionId: deps.actionId,
    locationId: ws.currentLocationId,
    dialogueAct: act,
    topic,
    topicSummary: topicSummaryFor(topic),
    outcome,
    learnedFactIds,
  };
  const emotion = emotionForOutcome(outcome, npc.memory.emotion);
  const mutations: EntityMutation[] = [];
  if (signal !== null) {
    mutations.push({
      kind: "apply_relationship_signal",
      fromNpcId: npc.id,
      targetId: PLAYER_ENTITY_ID,
      signal,
      source: { kind: "action", actionId: deps.actionId, turnNumber: deps.turnNumber },
    });
  }
  mutations.push({ kind: "record_npc_interaction", npcId: npc.id, ...interaction });
  if (emotion !== npc.memory.emotion) mutations.push({ kind: "set_npc_emotion", npcId: npc.id, emotion });
  // met 写在最后：interaction append 时仍能读到 false，摘要才会记录「首次见面」。
  if (!npc.met) mutations.push({ kind: "set_npc_met", npcId: npc.id, met: true });
  const event: GameEvent = { type: "npc_met", npcId: action.npcId, occurredAt: deps.now(), interactionKind: "greet" };

  // 与既有 talk 裁决的 stateChanges 契约保持一致：met 变化必有；关系变化仅在部分成功时显式声明
  const stateChanges: StateChange[] = [
    { path: `npcs[${String(action.npcId)}].met`, description: `与${npc.name}交谈`, operation: "set" },
  ];
  if (status === "partial_success") {
    stateChanges.push({
      path: `npcs[${String(action.npcId)}].memory.relationship`,
      description: `${npc.name}态度敌对，勉强交流`,
      operation: "update",
    });
  }

  return {
    status,
    outcome,
    disclosure,
    signal,
    interaction,
    mutations,
    event,
    feedback: feedbackFor(npc.name, status, disclosure),
    stateChanges,
  };
}
