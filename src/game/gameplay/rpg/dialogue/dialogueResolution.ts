import type { WorldState, NpcEntry, NpcInteraction } from "@/game/domain/worldState";
import type { DialogueAct, TalkAction } from "@/game/domain/action";
import { relationshipTierOf, RELATIONSHIP_CHANGE, type RelationshipTier } from "@/game/domain/relationship";
import type { FactId } from "@/game/domain/scenarioBlueprint";
import type { GameEvent } from "@/game/domain/events";
import type { StateChange } from "@/game/domain/resolvedEvent";
import { updateNpcMemory } from "@/game/gameplay/rpg/ruleEngine/updateNpcMemory";

// ---------------------------------------------------------------------------
// 固定对话选项的结构化裁决（Spec §7.2 / FND-03）。
// 纯规则：只读取 dialogueAct、topic、关系档位与 NPC 知识，绝不读取 utterance。
// 不读时钟/随机数：时间由调用方注入 deps.now。
// ---------------------------------------------------------------------------

export type DialogueDeps = { readonly now: () => string };

export type DialogueStatus = "success" | "partial_success" | "failure";

/** NPC 对 topic fact 的披露情况；非 fact topic 为 not_applicable。 */
export type DialogueDisclosure =
  | { readonly kind: "revealed"; readonly factId: FactId }
  | { readonly kind: "withheld" }
  | { readonly kind: "not_applicable" };

export type DialogueResolution = {
  readonly status: DialogueStatus;
  readonly outcome: NpcInteraction["outcome"];
  readonly relationshipDelta: number;
  readonly disclosure: DialogueDisclosure;
  readonly interaction: NpcInteraction;
  readonly npcAfter: NpcEntry;
  readonly event: GameEvent;
  readonly feedback: string;
  readonly stateChanges: readonly StateChange[];
};

/** 每种 dialogueAct 的基础好感变化（neutral 档位基准）。 */
export const DIALOGUE_ACT_BASE_DELTA: Readonly<Record<DialogueAct, number>> = {
  ask: 1,
  support: 3,
  challenge: -2,
  threaten: -4,
  deceive: -1,
  offer: 2,
  refuse: -2,
  reassure: 3,
};

/** 档位对好感变化的修正：敌意更差，信任更好。 */
export const DIALOGUE_TIER_DELTA_MODIFIER: Readonly<Record<RelationshipTier, number>> = {
  hostile: -2,
  cold: -1,
  neutral: 0,
  friendly: 1,
  trusted: 2,
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

function outcomeFor(delta: number): NpcInteraction["outcome"] {
  if (delta > 0) return "positive";
  if (delta < 0) return "negative";
  return "neutral";
}

function statusFor(
  act: DialogueAct,
  tier: RelationshipTier,
  outcome: NpcInteraction["outcome"],
  disclosure: DialogueDisclosure,
): DialogueStatus {
  if (tier === "hostile" && (act === "threaten" || act === "deceive")) return "failure";
  if (outcome === "negative" || disclosure.kind === "withheld") return "partial_success";
  return "success";
}

function summaryFor(npc: NpcEntry, outcome: NpcInteraction["outcome"], delta: number): string {
  const meetPart = npc.met ? "再次交谈" : "首次见面";
  const moodPart = outcome === "positive" ? "气氛融洽" : outcome === "negative" ? "氛围紧张" : "语气平淡";
  const deltaText = delta >= 0 ? `+${delta}` : `${delta}`;
  return `${meetPart}，${moodPart}，关系${deltaText}`;
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

  // 关系变化：act 基础值 + 档位修正 + 首次见面奖励（仅一次，敌意 NPC 不奖励）
  const actDelta = DIALOGUE_ACT_BASE_DELTA[act];
  const tierDelta = DIALOGUE_TIER_DELTA_MODIFIER[tier];
  const firstMeetDelta = npc.met || tier === "hostile" ? 0 : RELATIONSHIP_CHANGE.GREET_FIRST_MEET;
  const relationshipDelta = actDelta + tierDelta + firstMeetDelta;

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

  const outcome = outcomeFor(relationshipDelta);
  const status = statusFor(act, tier, outcome, disclosure);

  const interaction: NpcInteraction = {
    turn: ws.eventLedger.length,
    locationId: ws.currentLocationId,
    actionType: "talk",
    outcome,
    relationshipDelta,
    summary: summaryFor(npc, outcome, relationshipDelta),
  };
  const npcAfter = { ...updateNpcMemory(npc, interaction), met: true };
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
    relationshipDelta,
    disclosure,
    interaction,
    npcAfter,
    event,
    feedback: feedbackFor(npc.name, status, disclosure),
    stateChanges,
  };
}
