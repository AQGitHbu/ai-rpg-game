import type { WorldState } from "@/game/domain/worldState";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { GameRecord } from "./server/persistence/gameRepository";
import type { FactId, NpcId } from "@/game/domain/worldEntity";
import { relationshipTierOf, type RelationshipTier } from "@/game/domain/relationship";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type { DialogueAct } from "@/game/domain/action";
import {
  createNpcResponsePolicy,
  selectAllowedDisclosureFactIds,
  type NpcResponsePolicy,
} from "@/game/gameplay/rpg/narrativeContext";

// ---------------------------------------------------------------------------
// Task 5 Step 2/5：焦点 NPC 的隔离记忆 + 关系政策上下文。
// 只含选中 NPC 的最近 5 条结构化交互；绝不含其他 NPC 条目、玩家原话、
// 或未披露的私密事实正文（私密事实只下发 ID + 政策中的扣留指示）。
// 关系以“回合后档位 + 情绪 + 本轮 relationshipDelta/outcome”形式承载，绝不裸给数字。
// ---------------------------------------------------------------------------

/** 事实卡：仅含可安全下发的摘要/ID，不含私密正文。 */
export type FactCard = {
  readonly factId: FactId;
  readonly text: string;
};

export type FocusNpcContext = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly publicProfile: string;
  /** 回合后档位派生的回应政策（post-turn tier 内嵌于 responsePolicy.tier）。 */
  readonly responsePolicy: NpcResponsePolicy;
  /** 只含允许披露事实的卡片（带正文）；其余知识只给 ID/扣留指示。 */
  readonly speakableFactCards: readonly FactCard[];
  /** 只含选中 NPC 最近 5 条结构化交互（actionId + dialogueAct + topicSummary + outcome + summary）。 */
  readonly recentInteractions: readonly {
    readonly actionId: string;
    readonly dialogueAct: DialogueAct | "freeform";
    readonly topicSummary: string;
    readonly outcome: "positive" | "negative" | "neutral" | "mixed";
    readonly summary: string;
  }[];
  readonly goals: readonly string[];
  /** 回合后情绪。 */
  readonly emotion: NarrativeEmotion;
  /** 本轮关系结果（decision 5）：delta + outcome，不是裸数字。 */
  readonly thisTurn: {
    readonly relationshipDelta: number;
    readonly outcome: "positive" | "negative" | "neutral" | "mixed";
  };
};

const FOCUS_INTERACTION_LIMIT = 5;

function findNpc(ws: WorldState, npcId: NpcId) {
  return ws.npcs.find((n) => n.id === npcId);
}

function thisTurnResult(
  npc: NonNullable<ReturnType<typeof findNpc>>,
  job: PendingNarrativeJob,
): { readonly relationshipDelta: number; readonly outcome: FocusNpcContext["thisTurn"]["outcome"] } {
  for (let i = npc.memory.interactionHistory.length - 1; i >= 0; i -= 1) {
    const entry = npc.memory.interactionHistory[i];
    if (entry !== undefined && entry.actionId === job.actionId) {
      return { relationshipDelta: entry.relationshipDelta, outcome: entry.outcome };
    }
  }
  return { relationshipDelta: 0, outcome: "neutral" };
}

/**
 * 从持久化 record 投影焦点 NPC 的隔离上下文（唯一构造入口）。
 * - allowedDisclosureFactIds：规则推导（已知 ∩ 非私密 ∩ 档位坦诚度达标）。
 * - privateKnowledgeIds：NPC 私密事实，只下发 ID，正文绝不出现。
 * - recentInteractions：最近 5 条，只含规范化字段。
 */
export function buildFocusNpcContext(record: GameRecord, npcId: NpcId): FocusNpcContext {
  const ws = record.worldState;
  const npc = findNpc(ws, npcId);
  if (npc === undefined) {
    throw new Error(`buildFocusNpcContext: unknown NPC ${String(npcId)}`);
  }

  const narrative = record.storyState.narrative;
  const job = narrative.status === "provider_pending" ? narrative.job : null;

  const tier: RelationshipTier = relationshipTierOf(npc.memory.relationship);
  const allowedDisclosureFactIds = selectAllowedDisclosureFactIds({
    tier,
    knownFactIds: npc.memory.knownFactIds,
    hiddenFactIds: npc.memory.hiddenFactIds,
  });
  const responsePolicy = createNpcResponsePolicy({
    tier,
    allowedDisclosureFactIds,
    privateKnowledgeIds: [...npc.memory.hiddenFactIds],
  });

  const factById = new Map(ws.worldFacts.map((f) => [String(f.factId), f]));
  const speakableFactCards: FactCard[] = allowedDisclosureFactIds
    .map((id) => factById.get(String(id)))
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
    .map((f) => ({ factId: f.factId, text: f.text }));

  const recentInteractions = npc.memory.interactionHistory
    .slice(-FOCUS_INTERACTION_LIMIT)
    .map((h) => ({
      actionId: h.actionId,
      dialogueAct: h.dialogueAct,
      topicSummary: h.topicSummary,
      outcome: h.outcome,
      summary: h.summary,
    }));

  return {
    id: npc.id,
    name: npc.name,
    role: npc.role,
    publicProfile: npc.description,
    responsePolicy,
    speakableFactCards,
    recentInteractions,
    goals: [...npc.memory.goals],
    emotion: npc.memory.emotion,
    thisTurn: job !== null ? thisTurnResult(npc, job) : { relationshipDelta: 0, outcome: "neutral" },
  };
}
