import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { PacingNeed } from "@/game/domain/storyState";
import type {
  LocationId,
  NpcId,
  FactId,
  ItemId,
  EnemyId,
} from "@/game/domain/scenarioBlueprint";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type { RecentBeat } from "@/game/domain/materializedView";
import type { GameRecord } from "./server/persistence/gameRepository";

/**
 * SceneGenerator 的最小输入 DTO（spec §7.1 / §10.1-10.2）：
 * 只暴露本回合叙事所需的稳定事实，绝不携带完整 World/Story 记录。
 * NPC 知识最小权限：每个 NpcSceneContext 只含该 NPC 自己的公开档案、
 * 自己的 known/hidden fact cards、当前场景可见事实、最近规则摘要、
 * relationship/emotion/goals 与 forbidden knowledge 索引；绝不泄漏其他
 * NPC 私密记忆正文或完整 eventLedger。
 */

/** 事实卡：仅含可安全下发的摘要/ID，不含私密正文。 */
export type FactCard = {
  readonly factId: FactId;
  readonly text: string;
};

/** 焦点 NPC 的最小知识上下文。 */
export type NpcSceneContext = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly publicProfile: string;
  /** 该 NPC 已知的事实卡（自己的 knownFactIds）。 */
  readonly knownFactCards: readonly FactCard[];
  /** 该 NPC 自己的 hidden facts（不泄漏给其他 NPC，只给该 NPC 自己）。 */
  readonly hiddenFactCards: readonly FactCard[];
  /** 当前场景对玩家可见的 factId（无正文泄漏）。 */
  readonly sceneVisibleFactIds: readonly FactId[];
  /** 最近交互的规则摘要（不含玩家原文）。 */
  readonly recentInteractionSummaries: readonly string[];
  readonly relationship: { readonly affinity: number };
  readonly emotion: NarrativeEmotion;
  readonly goals: readonly string[];
  /** forbidden knowledge 索引（仅 ID 列表，不含正文）。 */
  readonly forbiddenKnowledgeIds: readonly FactId[];
};

export type PlayerSceneSummary = {
  readonly name: string;
  readonly identity: string;
  readonly knownFactCards: readonly FactCard[];
};

export type LocationSceneCard = {
  readonly id: LocationId;
  readonly name: string;
  readonly description: string;
  readonly kind: string;
};

export type BudgetSummary = {
  readonly remainingLocations: number;
  readonly remainingNpcs: number;
  readonly remainingEvents: number;
};

export type LegalActionCandidate = {
  readonly kind: "move" | "talk" | "explore" | "battle_action";
  readonly label: string;
  readonly targetId?: string;
};

/** 只暴露权威实体 ID，供纯审批验证 event target；不附带隐藏正文或状态。 */
export type LegalEventTargets = {
  readonly locationIds: readonly LocationId[];
  readonly factIds: readonly FactId[];
  readonly itemIds: readonly ItemId[];
  readonly enemyIds: readonly EnemyId[];
};

export type SceneGenerationContext = {
  readonly job: PendingNarrativeJob;
  readonly player: PlayerSceneSummary;
  readonly currentLocation: LocationSceneCard;
  readonly publicWorldFacts: readonly FactCard[];
  readonly sceneVisibleFacts: readonly FactCard[];
  readonly presentNpcs: readonly NpcSceneContext[];
  readonly story: {
    readonly currentAct: number;
    readonly targetActs: number;
    readonly tension: number;
    readonly nextPacingNeed: PacingNeed;
    readonly remainingBudget: BudgetSummary;
    readonly unresolvedThreadSummaries: readonly string[];
  };
  readonly recentBeats: readonly RecentBeat[];
  readonly legalActionCandidates: readonly LegalActionCandidate[];
  readonly legalEventTargets: LegalEventTargets;
  readonly worldConstraints: readonly string[];
};

/** 从持久化 record 投影最小权限上下文（唯一构造入口）。 */
export function buildSceneGenerationContext(record: GameRecord): SceneGenerationContext {
  const ws = record.worldState;
  const ss = record.storyState;

  const narrative = ss.narrative;
  if (narrative.generation.status !== "pending") {
    throw new Error("buildSceneGenerationContext requires a pending narrative job");
  }
  const job = narrative.generation.job;

  const currentLocation = ws.locations.find((l) => l.id === ws.currentLocationId)
    ?? ws.locations[0];
  const currentLocId = currentLocation.id;

  // 玩家已知事实卡：只含玩家已发现（discovered）的事实（不含 NPC 私密）。
  const factById = new Map(ws.worldFacts.map((f) => [String(f.factId), f]));
  const playerKnownFactCards = ws.worldFacts
    .filter((f) => f.discovered)
    .map((f) => ({ factId: f.factId, text: f.text }));

  const presentNpcs: NpcSceneContext[] = ws.npcs
    .filter((n) => n.locationId === currentLocId)
    .map((n) => {
      const knownCards = n.memory.knownFactIds
        .map((id) => factById.get(String(id)))
        .filter((f): f is NonNullable<typeof f> => f !== undefined)
        .map((f) => ({ factId: f.factId, text: f.text }));
      const hiddenCards = n.memory.hiddenFactIds
        .map((id) => factById.get(String(id)))
        .filter((f): f is NonNullable<typeof f> => f !== undefined)
        .map((f) => ({ factId: f.factId, text: f.text }));
      return {
        id: n.id,
        name: n.name,
        role: n.role,
        publicProfile: n.description,
        knownFactCards: knownCards,
        hiddenFactCards: hiddenCards,
        sceneVisibleFactIds: ws.worldFacts
          .filter((f) => f.locationId === currentLocId || f.discovered)
          .map((f) => f.factId),
        recentInteractionSummaries: n.memory.interactionHistory.slice(-3).map((h) => h.summary),
        relationship: { affinity: n.memory.relationship.affinity },
        emotion: n.memory.emotion,
        goals: [...n.memory.goals],
        forbiddenKnowledgeIds: [...n.memory.hiddenFactIds],
      };
    });

  const reachableLocations = ws.locations.filter(
    (l) => currentLocation.connectedLocationIds.includes(l.id)
      && ws.unlockedLocationIds.includes(l.id),
  );

  // 私密事实集合：属于任何 NPC hiddenFactIds 的事实不得进入公开/场景可见卡，
  // 只出现在对应 NPC 自己的 hiddenFactCards（最小权限，spec §10.2）。
  const secretFactKeys = new Set<string>();
  for (const npc of ws.npcs) {
    for (const id of npc.memory.hiddenFactIds) secretFactKeys.add(String(id));
  }
  const publicFacts = ws.worldFacts
    .filter((f) => !secretFactKeys.has(String(f.factId)))
    .map((f) => ({ factId: f.factId, text: f.text }));
  const sceneVisible = ws.worldFacts
    .filter((f) => !secretFactKeys.has(String(f.factId)))
    .filter((f) => f.locationId === currentLocId || f.discovered)
    .map((f) => ({ factId: f.factId, text: f.text }));
  const activeBattleEnemyId = ws.battle.status === "active" ? ws.battle.enemyId : null;

  return {
    job,
    player: {
      name: ws.player.name,
      identity: ws.player.identity,
      knownFactCards: playerKnownFactCards,
    },
    currentLocation: {
      id: currentLocation.id,
      name: currentLocation.name,
      description: currentLocation.description,
      kind: currentLocation.kind,
    },
    publicWorldFacts: publicFacts,
    sceneVisibleFacts: sceneVisible,
    presentNpcs,
    story: {
      currentAct: ss.currentAct,
      targetActs: ss.targetActs,
      tension: ss.tension,
      nextPacingNeed: ss.nextPacingNeed,
      remainingBudget: {
        remainingLocations: Math.max(0, ss.budget.locations.max - ss.budget.locations.expanded),
        remainingNpcs: Math.max(0, ss.budget.npcs.max - ss.budget.npcs.expanded),
        remainingEvents: Math.max(0, ss.budget.events.max - ss.budget.events.expanded),
      },
      unresolvedThreadSummaries: [...ss.unresolvedThreads],
    },
    recentBeats: (ss.recentBeats as readonly RecentBeat[]).slice(-5),
    legalActionCandidates: ws.battle.status === "active"
      ? [
          { kind: "battle_action" as const, label: "攻击", targetId: "attack" },
          { kind: "battle_action" as const, label: "防守", targetId: "guard" },
          { kind: "battle_action" as const, label: "撤退", targetId: "flee" },
        ]
      : [
          ...presentNpcs.map((npc) => ({
            kind: "talk" as const,
            label: `与${npc.name}交谈`,
            targetId: npc.id,
          })),
          ...reachableLocations.map((l) => ({
            kind: "move" as const,
            label: `前往${l.name}`,
            targetId: l.id,
          })),
          { kind: "explore" as const, label: "查看四周" },
        ],
    legalEventTargets: {
      locationIds: ws.locations.map((location) => location.id),
      factIds: Array.from(new Set([
        ...sceneVisible.map((fact) => fact.factId),
        ...job.resolvedEvent.facts.map((fact) => fact.factId),
      ])),
      itemIds: ws.items.map((item) => item.id),
      enemyIds: activeBattleEnemyId !== null
        ? [
            activeBattleEnemyId,
            ...ws.enemies.filter((enemy) => enemy.id !== activeBattleEnemyId).map((enemy) => enemy.id),
          ]
        : ws.enemies.map((enemy) => enemy.id),
    },
    worldConstraints: [],
  };
}
