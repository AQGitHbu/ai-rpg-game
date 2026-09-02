import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { FactId, NpcId, PlayerEntityId } from "@/game/domain/worldEntity";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type { DialogueAct } from "@/game/domain/action";
import { entitiesOfKind } from "@/game/domain/entity";
import type { NpcResponsePolicy } from "@/game/gameplay/rpg/narrativeContext";
import type { GameRecord } from "./server/persistence/gameRepository";
import {
  buildNpcSpeechAuthority,
  type NpcSpeechAuthority,
  type NpcSpeechInteraction,
} from "./npcSpeechAuthority";

/** 事实卡：仅含 authority 放行的事实正文。 */
export type FactCard = Readonly<{
  readonly factId: FactId;
  readonly text: string;
}>;

/** 允许旧手工上下文暂时携带字段，但生产投影不再填充私密 ID 或数值 delta。 */
export type FocusNpcResponsePolicy = Omit<NpcResponsePolicy, "privateKnowledgeIds"> & Readonly<{
  readonly privateKnowledgeIds?: readonly FactId[];
}>;

export type FocusNpcContext = Readonly<{
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly publicProfile: string;
  readonly speechAuthority?: NpcSpeechAuthority;
  readonly identityAnchors?: NpcSpeechAuthority["identityAnchors"];
  readonly responsePolicy: FocusNpcResponsePolicy;
  readonly speakableFactCards: readonly FactCard[];
  readonly recentInteractions: readonly NpcSpeechInteraction[];
  readonly goals: readonly string[];
  readonly emotion: NarrativeEmotion;
  readonly relationships?: NpcSpeechAuthority["relationships"];
  readonly evidenceKeys?: readonly string[];
  readonly thisTurn: Readonly<{
    readonly outcome: "positive" | "negative" | "neutral" | "mixed";
    /** Compatibility-only input field; production projection intentionally omits it. */
    readonly relationshipDelta?: number;
  }>;
}>;

function responseInitiativeOf(tier: NpcResponsePolicy["tier"]): NpcResponsePolicy["initiative"] {
  switch (tier) {
    case "hostile": return "refuse";
    case "cold": return "guarded";
    case "neutral": return "reactive";
    case "friendly": return "helpful";
    case "trusted": return "proactive";
  }
}

function responseToneOf(tier: NpcResponsePolicy["tier"]): string {
  switch (tier) {
    case "hostile": return "简短冷淡，拒绝配合，只做必要回应。";
    case "cold": return "谨慎防备，回答简短，只谈表面的公事。";
    case "neutral": return "就事论事，照实回答，不主动展开。";
    case "friendly": return "温和友好，乐于帮忙，适度主动提供帮助。";
    case "trusted": return "坦诚相待，主动说明情况并给出建议。";
  }
}

function sceneVisibleFactIds(record: GameRecord): readonly FactId[] {
  return entitiesOfKind(record.worldState.entityStore, "fact")
    .filter((entity) => entity.fact.discovered)
    .map((entity) => entity.core.id);
}

function targetContextOf(
  record: GameRecord,
  targetContext?: Readonly<{
    readonly targetId?: PlayerEntityId | NpcId;
    readonly interactionActionIds?: readonly string[];
  }>,
): Readonly<{
  readonly targetId?: PlayerEntityId | NpcId;
  readonly interactionActionIds?: readonly string[];
}> {
  if (targetContext !== undefined) return targetContext;
  const narrative = record.storyState.narrative;
  const job: PendingNarrativeJob | undefined = narrative.status === "provider_pending" ? narrative.job : undefined;
  if (job?.actionSummary.kind !== "talk") return {};
  return { targetId: "player_0" as PlayerEntityId };
}

function thisTurnOutcomeOf(
  interactions: readonly NpcSpeechInteraction[],
  actionId: string | undefined,
): FocusNpcContext["thisTurn"]["outcome"] {
  if (actionId === undefined) return "neutral";
  return interactions.find((interaction) => interaction.actionId === actionId)?.outcome ?? "neutral";
}

/**
 * Build the isolated focus context from the one speech authority projection.
 * No compatibility `NpcEntry.memory` field is read here.
 */
export function buildFocusNpcContext(
  record: GameRecord,
  npcId: NpcId,
  targetContext?: Readonly<{
    readonly targetId?: PlayerEntityId | NpcId;
    readonly interactionActionIds?: readonly string[];
  }>,
): FocusNpcContext {
  const npcRecord = entitiesOfKind(record.worldState.entityStore, "npc").find(
    (entity) => String(entity.core.id) === String(npcId),
  );
  if (npcRecord?.core.kind !== "npc") {
    throw new Error(`buildFocusNpcContext: unknown NPC ${String(npcId)}`);
  }
  const authority = buildNpcSpeechAuthority({
    store: record.worldState.entityStore,
    speakerNpcId: npcId,
    sceneVisibleFactIds: sceneVisibleFactIds(record),
    targetContext: targetContextOf(record, targetContext),
  });
  if (authority === null) {
    throw new Error(`buildFocusNpcContext: unknown NPC ${String(npcId)}`);
  }
  const tier = authority.responseTier;
  const responsePolicy: FocusNpcResponsePolicy = {
    tier,
    toneInstruction: responseToneOf(tier),
    initiative: responseInitiativeOf(tier),
    allowedDisclosureFactIds: authority.allowedFactIds,
  };
  const job = record.storyState.narrative.status === "provider_pending"
    ? record.storyState.narrative.job
    : undefined;
  return {
    id: npcRecord.core.id,
    name: npcRecord.core.name,
    role: npcRecord.identity.role,
    publicProfile: npcRecord.identity.description,
    speechAuthority: authority,
    identityAnchors: authority.identityAnchors,
    responsePolicy,
    speakableFactCards: authority.allowedFactCards,
    recentInteractions: authority.recentInteractions,
    goals: authority.activeGoals,
    emotion: npcRecord.dynamicState.emotion,
    relationships: authority.relationships,
    evidenceKeys: authority.evidenceKeys,
    thisTurn: {
      outcome: thisTurnOutcomeOf(authority.recentInteractions, job?.actionId),
    },
  };
}

export type FocusNpcInteraction = NpcSpeechInteraction & Readonly<{
  readonly dialogueAct: DialogueAct | "freeform";
}>;
