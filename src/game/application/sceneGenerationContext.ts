import type { PendingNarrativeJob, ProviderGenerationKind } from "@/game/domain/pendingNarrativeJob";
import { hasExplorableContent } from "./buildChoiceMap";
import type { PacingNeed } from "@/game/domain/storyState";
import type { StoryContract } from "@/game/domain/storyContract";
import type {
  LocationId,
  NpcId,
  FactId,
  ItemId,
  EnemyId,
} from "@/game/domain/worldEntity";
import type { NarrativeEmotion } from "@/game/domain/narrative";
import type { RecentBeat } from "@/game/domain/materializedView";
import type { MandatoryNarrativeBeat, ObjectiveRef, ObjectiveTransition } from "@/game/domain/narrativeBeat";
import type { WorldState } from "@/game/domain/worldState";
import { entitiesOfKind, projectEntityStore } from "@/game/domain/entity";
import type { RelationshipStage, RelationshipTrend } from "@/game/domain/entity";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
import {
  buildPreparedStepDescriptors,
  type PreparedArrivalNpcContext,
  type PreparedStepDescriptor,
} from "@/game/gameplay/rpg/preparedContinuation";
import { buildFocusNpcContext, type FocusNpcContext, type FactCard } from "./focusNpcContext";
import { buildNpcSpeechAuthority, type NpcSpeechAuthority } from "./npcSpeechAuthority";
import { isObjectiveEntityReleased } from "@/game/gameplay/rpg/worldEvolution";
import { buildStylePolicy, type StylePolicy } from "./stylePolicy";
import type { GameRecord } from "./server/persistence/gameRepository";
import type { GameTypeId } from "@/game/domain/newGame";
import type { DialogueAct, DialogueTopic } from "@/game/domain/action";
import type { AiTextAuditLink } from "./server/ai/textAuditTypes";
import type { NarrativeGenerationRepairReason } from "@/game/domain/narrativeGenerationFailure";

/**
 * SceneGenerator 的最小输入 DTO（spec §7.1 / §10.1-10.2）：
 * 只暴露本回合叙事所需的稳定事实，绝不携带完整 World/Story 记录。
 * NPC 知识最小权限：每个 NpcSceneContext 只含该 NPC 自己的公开档案、
 * 自己的 known/hidden fact cards、当前场景可见事实、最近规则摘要、
 * relationship/emotion/goals 与 forbidden knowledge 索引；绝不泄漏其他
 * NPC 私密记忆正文或完整 eventLedger。
 */

/** 事实卡：仅含可安全下发的摘要/ID，不含私密正文。 */
export type { FactCard } from "./focusNpcContext";
/** 焦点 NPC 的最小知识上下文。 */
export type NpcSceneContext = {
  readonly id: NpcId;
  readonly name: string;
  readonly role: string;
  readonly publicProfile: string;
  /** 该 NPC 已知的事实卡（自己的 knownFactIds）。 */
  readonly knownFactCards: readonly FactCard[];
  /** 该 NPC 的服务端 speech authority；审批不得用下方兼容投影替代。 */
  readonly speechAuthority?: NpcSpeechAuthority;
  /** 该 NPC 自己的 hidden facts（不泄漏给其他 NPC，只给该 NPC 自己）。 */
  readonly hiddenFactCards: readonly FactCard[];
  /** 当前场景对玩家可见的 factId（无正文泄漏）。 */
  readonly sceneVisibleFactIds: readonly FactId[];
  /** 最近交互的规则摘要（不含玩家原文）。 */
  readonly recentInteractionSummaries: readonly string[];
  /** Task 6：该 NPC 最近交互的 actionId（供审批校验 usedEventIds 归属）。 */
  readonly recentInteractionActionIds: readonly string[];
  /** Qualitative relation only; cumulative dimensions never enter scene context. */
  readonly relationship: {
    readonly stage?: RelationshipStage;
    readonly trend?: RelationshipTrend;
    /** Legacy hand-built fixtures may still provide this; production never does. */
    readonly affinity?: number;
  };
  readonly emotion: NarrativeEmotion;
  readonly goals: readonly string[];
  /** forbidden knowledge 索引（仅 ID 列表，不含正文）。 */
  readonly forbiddenKnowledgeIds: readonly FactId[];
};

/** 下一地点即将成为主线目标的 NPC：只用于移动预生成，不等同于当前在场 NPC。 */
export type UpcomingArrivalNpcContext = Pick<
  NpcSceneContext,
  "id" | "name" | "role" | "publicProfile" | "knownFactCards" | "sceneVisibleFactIds" | "goals"
> & Readonly<{
  /** Production projections always fill this; old hand-built contexts may omit it. */
  readonly speechAuthority?: import("./npcSpeechAuthority").NpcSpeechAuthority;
}>;

/** Application-only enriched descriptor; gameplay graph shape stays unchanged for 8B. */
export type PreparedSceneStepDescriptor = Omit<PreparedStepDescriptor, "arrivalNpc"> & Readonly<{
  readonly arrivalNpc?: PreparedArrivalNpcContext & Readonly<{
    readonly speechAuthority?: import("./npcSpeechAuthority").NpcSpeechAuthority;
  }>;
}>;

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
  readonly kind: "move" | "talk" | "explore" | "attack" | "battle_action";
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

/** 节拍/目标引用实体的最小描述：供场景表演者引用实体名，不携带完整状态。 */
export type EntityDescription = {
  readonly id: string;
  readonly kind: "npc" | "location" | "item" | "fact" | "enemy" | "quest";
  readonly name: string;
  readonly description: string;
};

/** 当前权威目标引用的目标实体：用于目标推进/选项合法性校验（Task 6）。 */
export type ObjectiveTargetRef = {
  readonly questId: string;
  readonly objectiveIndex: number;
  readonly entityId: string;
  readonly entityName: string;
};

/**
 * Task 4：本回合已结算的调查方式结果（investigate + player 主动选择时存在）。
 * 从 job.domainEventIds 指向的 committed events 中解析 fact_discovered 事件；
 * 自动揭示（无 approachId）或范围内未命中时不存在。approachLabel 回退"现场调查"。
 */
export type ResolvedInvestigationContext = {
  readonly factId: FactId;
  readonly approachId: string;
  readonly approachLabel: string;
  readonly evidenceQuality: "clean" | "noisy";
  readonly tensionDelta: number;
};

/**
 * 从当前权威目标开始的单线链目标投影（Task 1）：只投影 discover_fact /
 * visit_location（含当前目标），供 live prompt 预生成抵达/事实确认叙事；
 * 如果 visit_location 的下一目标是同一地点的 talk_to_npc，则额外携带该 NPC
 * 的最小权限上下文，让移动预生成同时产出抵达后的首句对白。
 */
export type UpcomingObjectiveRef =
  | {
      readonly kind: "discover_fact";
      readonly factId: FactId;
      readonly investigationLabel: string;
      readonly factText: string;
      /** 链中下一目标的玩家可见实体名（服务端权威下发）。 */
      readonly nextObjectiveEntityName?: string;
    }
  | {
      readonly kind: "visit_location";
      readonly locationId: LocationId;
      readonly locationName: string;
      readonly nextObjectiveEntityName?: string;
      readonly arrivalNpc?: UpcomingArrivalNpcContext;
    };

/** 当前 pending 回合要承接的上一轮 NPC 台词与玩家回应。 */
export type PreviousDialogueContext = {
  readonly npcId: NpcId;
  readonly npcLine: string;
  /** 本轮 NPC 台词实际引用的事实；fallback 不得凭角色名另造证物。 */
  readonly usedFactIds?: readonly string[];
  readonly selectedChoice?: {
    readonly label?: string;
    readonly dialogueAct: DialogueAct;
    readonly topic?: DialogueTopic;
  };
};

/** 同一 pending 回合的内容修复尝试；不持久化，只用于下一次 live prompt。 */
export type SceneGenerationRepair = {
  readonly attempt: number;
  readonly reason: NarrativeGenerationRepairReason;
};

export type SceneGenerationContext = {
  /** 仅用于关联 scene AI 审计事件，不进入 prompt 的世界事实字段。 */
  readonly auditLink?: AiTextAuditLink;
  /** 审计触发分类覆盖值；不参与场景规则。 */
  readonly auditTrigger?: string;
  /** 题材边界与开局设定：允许 live 表演者保持同一世界语义，不可改写规则。 */
  readonly gameType?: GameTypeId;
  /**
   * 本局的稳定叙事种子：只供确定性文案变体使用，不直接暴露给 live prompt。
   * 同一局可重放；不同开局不会因为 NPC 角色模板相同而复用同一组对白。
   */
  readonly generationSeed?: string;
  readonly worldPremise?: string;
  readonly storyOpening?: string;
  readonly job: PendingNarrativeJob;
  /** Provider authorization is copied from the immutable pending job. */
  readonly generationKind?: ProviderGenerationKind;
  /** Handoff semantics are fixed by the job, never inferred from mutable dialogue state. */
  readonly finalDialogueHandoff?: boolean;
  /** Server-authored continuation graph projected for this accepted rule result. */
  readonly preparedStepDescriptors?: readonly PreparedSceneStepDescriptor[];
  readonly preparedActiveStepIds?: readonly string[];
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
    readonly contract: Pick<StoryContract, "centralConflict" | "endingDirections">;
    readonly remainingBudget: BudgetSummary;
    readonly unresolvedThreadSummaries: readonly string[];
    /** 当前权威主线的最小叙事摘要；选项/提示词不得再从对白文本猜主题。 */
    readonly activeQuest?: {
      readonly questId: string;
      readonly name: string;
      readonly description: string;
      readonly objectiveIndex: number;
      readonly objectiveLabel: string;
      readonly objectiveKind: string;
    };
    /** Task 8：开局呈现政策（人格标签/叙事风格/内容强度 → 指令）。 */
    readonly stylePolicy: StylePolicy;
  };
  readonly recentBeats: readonly RecentBeat[];
  readonly legalActionCandidates: readonly LegalActionCandidate[];
  readonly legalEventTargets: LegalEventTargets;
  readonly worldConstraints: readonly string[];
  /** Task 4：本回合的目标转换（job 持久化的权威值）。 */
  readonly objectiveTransition: ObjectiveTransition;
  /** Task 4：本回合的强制叙事节拍（job 持久化的权威值，≤8）。 */
  readonly mandatoryBeats: readonly MandatoryNarrativeBeat[];
  /** Task 4：节拍/目标引用实体从持久化状态解析出的最小描述。 */
  readonly beatSubjects: readonly EntityDescription[];
  /**
   * 允许场景 proposal 用稳定 ID 表达叙事 grounding 的实体集合。
   * 自然语言正文不参与规则裁决；该字段只供 source/parser/approval 共享边界。
   */
  readonly narrativeReferenceIds?: readonly string[];
  /** Task 5：焦点 NPC 的隔离记忆 + 关系政策（talk 指向 job.focusNpcId，否则第一个在场 NPC）。 */
  readonly focusNpcContext?: FocusNpcContext;
  /** Task 6：当前权威目标引用的目标实体（无 after 目标时为 null）。 */
  readonly objectiveTarget: ObjectiveTargetRef | null;
  /** Task 4：本回合已结算的调查方式结果（approach 选择 + 证据质量 + 动静代价）。 */
  readonly resolvedInvestigation?: ResolvedInvestigationContext;
  /**
   * Task 1：从当前权威目标开始的连续单线目标前缀（含当前目标，discover_fact →
   * visit_location，止于 talk_to_npc / defeat_enemy 等分支点）；由
   * buildSceneGenerationContext 恒投影（无单线链时为空数组），手工构造上下文
   * 缺失时按空数组处理。
   */
  readonly upcomingLinearObjectives?: readonly UpcomingObjectiveRef[];
  /** 若本轮是对当前场景 NPC 的后续回应，提供上一句原话及玩家选项。 */
  readonly previousDialogue?: PreviousDialogueContext;
  /** 规则层在完成所需正式回应后置位；用于区分普通 talk 与收尾 handoff。 */
  readonly dialogueSessionCompleted?: boolean;
  /** AI 提案未通过内容契约时的单次修复提示。 */
  readonly repairAttempt?: SceneGenerationRepair;
};

/**
 * 对话目标完成后的收尾场景：上一名 NPC 已经说完本轮最后一句，下一步由
 * 同一次场景生成返回一个唯一、可执行的 handoff 选项，不能再伪造第二个对白选项。
 */
export function isFinalDialogueHandoff(
  context: Pick<SceneGenerationContext, "job" | "objectiveTransition" | "dialogueSessionCompleted">
    & Pick<SceneGenerationContext, "finalDialogueHandoff">,
): boolean {
  if (context.finalDialogueHandoff !== undefined) return context.finalDialogueHandoff;
  return context.job.actionSummary.kind === "talk"
    && context.dialogueSessionCompleted === true
    && context.objectiveTransition.completed.length > 0
    && context.objectiveTransition.after !== null
    && context.objectiveTransition.mode !== "unchanged";
}

function buildPreviousDialogueContext(
  narrative: GameRecord["storyState"]["narrative"],
  job: PendingNarrativeJob,
): PreviousDialogueContext | undefined {
  if (job.actionSummary.kind !== "talk") return undefined;
  const scene = narrative.status === "ready"
    ? narrative.currentScene
    : narrative.lastPresentedScene;
  const npcLine = scene?.npcLine;
  if (npcLine === null || npcLine === undefined) return undefined;
  if (String(npcLine.npcId) !== String(job.actionSummary.npcId)) return undefined;
  // sceneId/revision 校验会在 choice map/审批层完成；这里仅按服务端保存的
  // selectedDialogue 投影，避免从客户端 label 反推动作语义。
  return {
    npcId: npcLine.npcId,
    npcLine: npcLine.text,
    ...(npcLine.usedFactIds.length === 0 ? {} : { usedFactIds: [...npcLine.usedFactIds].map(String) }),
    ...(job.selectedDialogue === undefined ? {} : {
      selectedChoice: {
        ...(job.selectedDialogue.label === undefined ? {} : { label: job.selectedDialogue.label }),
        dialogueAct: job.selectedDialogue.dialogueAct,
        ...(job.selectedDialogue.topic === undefined ? {} : { topic: job.selectedDialogue.topic }),
      },
    }),
  };
}

/** 从持久化世界状态解析 subject ID 为最小实体描述；引用未命中时保留 ID 兜底。 */
function resolveEntityDescriptions(ws: WorldState, subjectIds: readonly string[]): EntityDescription[] {
  const result: EntityDescription[] = [];
  const seen = new Set<string>();
  const secretFactIds = new Set(
    entitiesOfKind(ws.entityStore, "npc").flatMap((npc) => npc.knowledge.entries
      .filter((entry) => entry.disclosure === "secret")
      .map((entry) => String(entry.factId))),
  );
  const push = (desc: EntityDescription): void => {
    if (seen.has(desc.id)) return;
    seen.add(desc.id);
    result.push(desc);
  };
  for (const id of subjectIds) {
    const npc = ws.npcs.find((n) => String(n.id) === id);
    if (npc) { push({ id, kind: "npc", name: npc.name, description: npc.description }); continue; }
    const location = ws.locations.find((l) => String(l.id) === id);
    if (location) { push({ id, kind: "location", name: location.name, description: location.description }); continue; }
    const item = ws.items.find((i) => String(i.id) === id);
    if (item) { push({ id, kind: "item", name: item.name, description: item.description }); continue; }
    const enemy = ws.enemies.find((e) => String(e.id) === id);
    if (enemy) { push({ id, kind: "enemy", name: enemy.name, description: `威胁等级：${enemy.tier}` }); continue; }
    const quest = ws.quests.find((q) => String(q.id) === id);
    if (quest) { push({ id, kind: "quest", name: quest.name, description: quest.description }); continue; }
    const fact = ws.worldFacts.find((f) => String(f.factId) === id);
    if (fact) {
      push({
        id,
        kind: "fact",
        name: "线索",
        description: fact.discovered && !secretFactIds.has(id) ? fact.text : "尚未查明的线索",
      });
      continue;
    }
    push({ id, kind: "npc", name: id, description: "（尚未具象化的实体）" });
  }
  return result;
}

/** 从目标引用解析其目标实体（推进/接近该目标所需的实体 ID 与名称）。 */
function resolveObjectiveTarget(
  ws: WorldState,
  ref: { readonly questId: string; readonly objectiveIndex: number } | null,
): ObjectiveTargetRef | null {
  if (ref === null) return null;
  const secretFactIds = new Set(
    entitiesOfKind(ws.entityStore, "npc").flatMap((npc) => npc.knowledge.entries
      .filter((entry) => entry.disclosure === "secret")
      .map((entry) => String(entry.factId))),
  );
  const quest = ws.quests.find((q) => String(q.id) === String(ref.questId));
  const objective = quest?.objectives[ref.objectiveIndex];
  if (objective === undefined) return null;
  switch (objective.kind) {
    case "visit_location": {
      const loc = ws.locations.find((l) => String(l.id) === String(objective.locationId));
      return { questId: String(ref.questId), objectiveIndex: ref.objectiveIndex, entityId: String(objective.locationId), entityName: loc?.name ?? "某地" };
    }
    case "talk_to_npc": {
      const npc = ws.npcs.find((n) => String(n.id) === String(objective.npcId));
      return { questId: String(ref.questId), objectiveIndex: ref.objectiveIndex, entityId: String(objective.npcId), entityName: npc?.name ?? "某人" };
    }
    case "obtain_item": {
      const item = ws.items.find((i) => String(i.id) === String(objective.itemId));
      return { questId: String(ref.questId), objectiveIndex: ref.objectiveIndex, entityId: String(objective.itemId), entityName: item?.name ?? "某物" };
    }
    case "discover_fact": {
      const fact = ws.worldFacts.find((f) => String(f.factId) === String(objective.factId));
      return {
        questId: String(ref.questId),
        objectiveIndex: ref.objectiveIndex,
        entityId: String(objective.factId),
        entityName: fact?.discovered === true && !secretFactIds.has(String(objective.factId))
          ? fact.text
          : `调查${fact?.investigationLabel ?? "现场线索"}`,
      };
    }
    case "defeat_enemy": {
      const enemy = ws.enemies.find((e) => String(e.id) === String(objective.enemyId));
      return { questId: String(ref.questId), objectiveIndex: ref.objectiveIndex, entityId: String(objective.enemyId), entityName: enemy?.name ?? "强敌" };
    }
  }
}

/** 目标实体名：仅单线目标（discover_fact / visit_location）有玩家可见实体名，分支点无。 */
function objectiveEntityNameOf(
  ws: WorldState,
  objective: WorldState["quests"][number]["objectives"][number] | undefined,
): string | undefined {
  if (objective === undefined) return undefined;
  switch (objective.kind) {
    case "discover_fact": {
      const fact = ws.worldFacts.find((f) => String(f.factId) === String(objective.factId));
      return fact?.investigationLabel;
    }
    case "visit_location": {
      const loc = ws.locations.find((l) => String(l.id) === String(objective.locationId));
      return loc?.name;
    }
    default:
      return undefined;
  }
}

/**
 * 从权威 quest objectives 投影从当前目标开始的连续单线前缀（Task 1）：
 * 当前目标与后续 discover_fact / visit_location 一并纳入；遇 talk_to_npc /
 * defeat_enemy 等分支点立即停止；当前目标即为分支点或无单线链时返回空数组。
 */
function buildUpcomingLinearObjectives(
  ws: WorldState,
  after: ObjectiveRef | null,
): readonly UpcomingObjectiveRef[] {
  if (after === null) return [];
  const quest = ws.quests.find((q) => String(q.id) === String(after.questId));
  if (quest === undefined) return [];
  const secretFactIds = new Set(
    entitiesOfKind(ws.entityStore, "npc").flatMap((npc) => npc.knowledge.entries
      .filter((entry) => entry.disclosure === "secret")
      .map((entry) => String(entry.factId))),
  );
  const buildArrivalNpc = (locationId: LocationId, objectiveIndex: number): UpcomingArrivalNpcContext | undefined => {
    const next = quest.objectives[objectiveIndex + 1];
    if (next?.kind !== "talk_to_npc") return undefined;
    const npc = ws.npcs.find((entry) =>
      String(entry.id) === String(next.npcId) && String(entry.locationId) === String(locationId),
    );
    if (npc === undefined) return undefined;
    const authority = buildNpcSpeechAuthority({
      store: ws.entityStore,
      speakerNpcId: npc.id,
      sceneVisibleFactIds: entitiesOfKind(ws.entityStore, "fact")
        .filter((fact) => fact.fact.discovered)
        .map((fact) => fact.core.id),
      targetContext: { targetId: PLAYER_ENTITY_ID },
    });
    if (authority === null) return undefined;
    return {
      id: npc.id,
      name: npc.name,
      role: npc.role,
      publicProfile: npc.description,
      knownFactCards: authority.allowedFactCards,
      sceneVisibleFactIds: authority.allowedFactIds,
      goals: authority.activeGoals,
      speechAuthority: authority,
    };
  };
  const result: UpcomingObjectiveRef[] = [];
  for (let index = after.objectiveIndex; index < quest.objectives.length; index += 1) {
    const objective = quest.objectives[index];
    const nextEntityName = objectiveEntityNameOf(ws, quest.objectives[index + 1]);
    if (objective.kind === "discover_fact") {
      const fact = ws.worldFacts.find((f) => String(f.factId) === String(objective.factId));
      result.push({
        kind: "discover_fact",
        factId: objective.factId,
        investigationLabel: fact?.investigationLabel ?? "现场线索",
        factText: fact !== undefined && !secretFactIds.has(String(fact.factId)) ? fact.text : "",
        ...(nextEntityName === undefined ? {} : { nextObjectiveEntityName: nextEntityName }),
      });
      continue;
    }
    if (objective.kind === "visit_location") {
      const loc = ws.locations.find((l) => String(l.id) === String(objective.locationId));
      const arrivalNpc = buildArrivalNpc(objective.locationId, index);
      result.push({
        kind: "visit_location",
        locationId: objective.locationId,
        locationName: loc?.name ?? "某地",
        ...(arrivalNpc === undefined && nextEntityName === undefined
          ? {}
          : { nextObjectiveEntityName: arrivalNpc?.name ?? nextEntityName }),
        ...(arrivalNpc === undefined ? {} : { arrivalNpc }),
      });
      continue;
    }
    break;
  }
  return result;
}

function enrichPreparedStepDescriptors(
  ws: WorldState,
  descriptors: readonly PreparedStepDescriptor[],
): readonly PreparedSceneStepDescriptor[] {
  const sceneVisibleFactIds = entitiesOfKind(ws.entityStore, "fact")
    .filter((fact) => fact.fact.discovered)
    .map((fact) => fact.core.id);
  return descriptors.map((descriptor) => {
    const arrivalNpc = descriptor.arrivalNpc;
    if (arrivalNpc === undefined) return descriptor;
    const speechAuthority = buildNpcSpeechAuthority({
      store: ws.entityStore,
      speakerNpcId: arrivalNpc.id,
      sceneVisibleFactIds,
      targetContext: { targetId: PLAYER_ENTITY_ID },
    });
    if (speechAuthority === null) return descriptor;
    return {
      ...descriptor,
      authority: {
        ...descriptor.authority,
        visibleFactIds: speechAuthority.allowedFactIds,
      },
      arrivalNpc: {
        ...arrivalNpc,
        knownFactCards: speechAuthority.allowedFactCards,
        sceneVisibleFactIds: speechAuthority.allowedFactIds,
        goals: speechAuthority.activeGoals,
        speechAuthority,
      },
    };
  });
}

/** 从持久化 record 投影最小权限上下文（唯一构造入口）。 */
export function buildSceneGenerationContext(record: GameRecord): SceneGenerationContext {
  const projected = projectEntityStore(record.worldState.entityStore);
  const ws = {
    ...record.worldState,
    ...projected,
  };
  const ss = record.storyState;

  const narrative = ss.narrative;
  if (narrative.status !== "provider_pending") {
    throw new Error("buildSceneGenerationContext requires a pending narrative job");
  }
  const job = narrative.job;
  const previousDialogue = buildPreviousDialogueContext(narrative, job);

  // Task 4：节拍与目标转换引用的 subject ID 全部收集后从持久化状态解析描述。
  // after 以持久化状态里的权威当前目标为准（幕边界时 job 快照尚无下一幕目标，
  // 而场景装配的预览状态里下一幕任务已具象化，故在此修正投影）。
  const transition: ObjectiveTransition = {
    ...job.objectiveTransition,
    after: currentObjectiveOf(ws, record.storyState),
  };
  const activeQuest = transition.after === null
    ? undefined
    : (() => {
        const quest = ws.quests.find((entry) => String(entry.id) === String(transition.after?.questId));
        const objective = quest?.objectives[transition.after?.objectiveIndex ?? -1];
        if (quest === undefined || objective === undefined || transition.after === null) return undefined;
        return {
          questId: String(quest.id),
          name: quest.name,
          description: quest.description,
          objectiveIndex: transition.after.objectiveIndex,
          objectiveLabel: transition.after.label,
          objectiveKind: objective.kind,
        };
      })();
  const transitionQuestIds: string[] = [];
  if (transition.before !== null) transitionQuestIds.push(String(transition.before.questId));
  for (const completed of transition.completed) transitionQuestIds.push(String(completed.questId));
  if (transition.after !== null) transitionQuestIds.push(String(transition.after.questId));
  const beatSubjectIds = job.mandatoryBeats.flatMap((beat) => beat.subjectIds);
  const beatSubjects = resolveEntityDescriptions(ws, [...transitionQuestIds, ...beatSubjectIds]);

  const currentLocation = ws.locations.find((l) => l.id === ws.currentLocationId)
    ?? ws.locations[0];
  const currentLocId = currentLocation.id;

  const secretFactKeys = new Set<string>();
  for (const entity of entitiesOfKind(ws.entityStore, "npc")) {
    for (const entry of entity.knowledge.entries) {
      if (entry.disclosure === "secret") secretFactKeys.add(String(entry.factId));
    }
  }

  // 玩家已知事实卡：只含玩家已发现（discovered）的事实（不含 NPC 私密）。
  const playerKnownFactCards = ws.worldFacts
    .filter((f) => f.discovered && !secretFactKeys.has(String(f.factId)))
    .map((f) => ({ factId: f.factId, text: f.text }));

  const presentNpcs: NpcSceneContext[] = ws.npcs
    .filter((n) => n.locationId === currentLocId)
    .filter((n) => isObjectiveEntityReleased(ws, ss, (objective) =>
      objective.kind === "talk_to_npc" && String(objective.npcId) === String(n.id)))
    .flatMap((n) => {
      const speechAuthority = buildNpcSpeechAuthority({
        store: ws.entityStore,
        speakerNpcId: n.id,
        sceneVisibleFactIds: ws.worldFacts.filter((fact) => fact.discovered).map((fact) => fact.factId),
        targetContext: { targetId: PLAYER_ENTITY_ID },
      });
      if (speechAuthority === null) return [];
      return [{
        id: n.id,
        name: n.name,
        role: n.role,
        publicProfile: n.description,
        knownFactCards: speechAuthority.allowedFactCards,
        speechAuthority,
        hiddenFactCards: [],
        sceneVisibleFactIds: speechAuthority.allowedFactIds,
        recentInteractionSummaries: speechAuthority.recentInteractions.slice(-3).map((h) => h.summary),
        recentInteractionActionIds: speechAuthority.allowedEventIds.map(String),
        relationship: speechAuthority.relationship === undefined ? {} : {
          stage: speechAuthority.relationship.stage,
          trend: speechAuthority.relationship.trend,
        },
        emotion: entitiesOfKind(ws.entityStore, "npc").find((entity) =>
          String(entity.core.id) === String(n.id),
        )?.dynamicState.emotion ?? "neutral",
        goals: speechAuthority.activeGoals,
        forbiddenKnowledgeIds: [],
      }];
    });

  const reachableLocations = ws.locations.filter(
    (l) => currentLocation.connectedLocationIds.includes(l.id)
      && ws.unlockedLocationIds.includes(l.id),
  );

  // 对话回合的原话只能由当时的对象承接。幕交接可以引入下一位目标 NPC，
  // 但不能把玩家刚对旧 NPC 说的话改写成新 NPC 听见；新目标仍通过权威
  // objectiveTarget 出现在交接场景的行动入口中。
  const objectiveNpcId = transition.after?.objectiveIndex === undefined
    ? undefined
    : (() => {
        const quest = ws.quests.find((q) => String(q.id) === String(transition.after?.questId));
        const objective = quest?.objectives[transition.after?.objectiveIndex ?? -1];
        return objective?.kind === "talk_to_npc" ? objective.npcId : undefined;
      })();
  // 对话回合必须继续由玩家刚回应的 NPC 承接；非对白回合只有在本回合
  // 的权威目标已经是当前地点的 talk_to_npc 时才有焦点 NPC。普通调查、移动
  // 或探索即使地点里有已释放 NPC，也不能把该 NPC误当成焦点，否则队列旁白
  // 会被错误地当成正式对白场景，最终以 npcLine=null 写回并触发 fallback。
  const objectiveNpcIsPresent = objectiveNpcId !== undefined
    && presentNpcs.some((npc) => String(npc.id) === String(objectiveNpcId));
  const focusNpcId = job.actionSummary.kind === "talk"
    ? job.focusNpcId
      ?? (objectiveNpcIsPresent ? objectiveNpcId : presentNpcs[0]?.id)
    : objectiveNpcIsPresent
      ? objectiveNpcId
      : undefined;
  const focusNpcContext = focusNpcId !== undefined
    ? buildFocusNpcContext(record, focusNpcId, { targetId: PLAYER_ENTITY_ID })
    : undefined;

  // 私密事实集合：属于任何 NPC secret knowledge entry 的事实不得进入公开/场景可见卡；
  // 兼容字段 hiddenFactCards/forbiddenKnowledgeIds 保持为空，authority 只向焦点路径放行卡片。
  const publicFacts = ws.worldFacts
    .filter((f) => !secretFactKeys.has(String(f.factId)) && f.discovered)
    .map((f) => ({ factId: f.factId, text: f.text }));
  const sceneVisible = ws.worldFacts
    .filter((f) => !secretFactKeys.has(String(f.factId)))
    .filter((f) => f.discovered)
    .map((f) => ({ factId: f.factId, text: f.text }));
  const activeBattleEnemyId = ws.battle.status === "active" ? ws.battle.enemyId : null;
  const releasedFacts = ws.worldFacts
    .filter((fact) => fact.discovered || isObjectiveEntityReleased(ws, ss, (objective) =>
      objective.kind === "discover_fact" && String(objective.factId) === String(fact.factId)))
    .map((fact) => fact.factId);
  const releasedItems = ws.items
    .filter((item) => ws.inventory.includes(item.id) || isObjectiveEntityReleased(ws, ss, (objective) =>
      objective.kind === "obtain_item" && String(objective.itemId) === String(item.id)))
    .map((item) => item.id);
  const releasedEnemies = ws.enemies
    .filter((enemy) => isObjectiveEntityReleased(ws, ss, (objective) =>
      objective.kind === "defeat_enemy" && String(objective.enemyId) === String(enemy.id)))
    .map((enemy) => enemy.id);

  // Task 4：本回合已结算的调查方式结果。仅在 investigate 行动（player 主动选择
  // approach）时存在；自动揭示（无 approachId）或范围外未命中时不存在。
  const resolvedInvestigation = (() => {
    if (job.actionSummary.kind !== "investigate") return undefined;
    const eventById = new Map(ws.eventLedger.map((event) => [String(event.eventId), event]));
    for (const eventId of job.domainEventIds) {
      const event = eventById.get(String(eventId));
      if (event === undefined) return undefined;
      if (event.kind !== "fact_discovered") continue;
      const payload = event.payload as { factId: FactId; approachId?: string; evidenceQuality?: "clean" | "noisy"; tensionDelta?: number };
      if (String(payload.factId) !== String(job.actionSummary.factId)) continue;
      if (payload.approachId === undefined) return undefined;
      const fact = ws.worldFacts.find((entry) => String(entry.factId) === String(payload.factId));
      const approach = fact?.investigationApproaches?.find((entry) => entry.approachId === payload.approachId);
      return {
        factId: payload.factId,
        approachId: payload.approachId,
        approachLabel: approach?.label ?? "现场调查",
        evidenceQuality: payload.evidenceQuality ?? "clean",
        tensionDelta: payload.tensionDelta ?? 0,
      };
    }
    return undefined;
  })();

  const objectiveTarget = resolveObjectiveTarget(ws, transition.after);
  const upcomingLinearObjectives = buildUpcomingLinearObjectives(ws, transition.after);
  const preparedProjection = buildPreparedStepDescriptors({
    worldState: ws,
    storyState: ss,
    transition,
  });
  const preparedDescriptors = enrichPreparedStepDescriptors(ws, preparedProjection.descriptors);
  const narrativeReferenceIds = [...new Set([
    ...beatSubjects.map((subject) => subject.id),
    ...(objectiveTarget === null ? [] : [objectiveTarget.entityId]),
    ...upcomingLinearObjectives.flatMap((ref) => ref.kind === "discover_fact"
      ? [String(ref.factId)]
      : [
          String(ref.locationId),
          ...(ref.arrivalNpc === undefined ? [] : [String(ref.arrivalNpc.id)]),
        ]),
    ...preparedDescriptors.flatMap((descriptor) => [
      ...descriptor.authority.allowedEntityIds,
      ...descriptor.authority.visibleFactIds.map(String),
      ...(descriptor.arrivalNpc === undefined ? [] : [String(descriptor.arrivalNpc.id)]),
    ]),
  ])];

  return {
    gameType: ws.generation.gameType,
    generationSeed: ws.generation.seed,
    ...(ws.generation.setup?.worldPremise === undefined ? {} : { worldPremise: ws.generation.setup.worldPremise }),
    ...(ws.generation.setup?.storyOpening === undefined ? {} : { storyOpening: ws.generation.setup.storyOpening }),
    job,
    ...(job.generationKind === null ? {} : { generationKind: job.generationKind }),
    finalDialogueHandoff: job.sceneRequestKind === "npc_handoff",
    preparedStepDescriptors: preparedDescriptors,
    preparedActiveStepIds: preparedProjection.activeStepIds,
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
      contract: {
        centralConflict: ss.contract.centralConflict,
        endingDirections: [
          {
            key: ss.contract.endingDirections[0].key,
            theme: ss.contract.endingDirections[0].theme,
          },
          {
            key: ss.contract.endingDirections[1].key,
            theme: ss.contract.endingDirections[1].theme,
          },
        ],
      },
      remainingBudget: {
        remainingLocations: Math.max(0, ss.budget.locations.max - ss.budget.locations.expanded),
        remainingNpcs: Math.max(0, ss.budget.npcs.max - ss.budget.npcs.expanded),
        remainingEvents: Math.max(0, ss.budget.events.max - ss.budget.events.expanded),
      },
      unresolvedThreadSummaries: [...ss.unresolvedThreads],
      ...(activeQuest === undefined ? {} : { activeQuest }),
      stylePolicy: buildStylePolicy(ws.generation.setup),
    },
    recentBeats: (ss.recentBeats as readonly RecentBeat[]).slice(-5),
    legalActionCandidates: ws.battle.status === "active"
      ? [
          { kind: "battle_action" as const, label: "攻击", targetId: "attack" },
          { kind: "battle_action" as const, label: "防守", targetId: "guard" },
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
          ...(hasExplorableContent(ws, ss)
            ? [{ kind: "explore" as const, label: "查看四周" }]
            : []),
          ...ws.enemies
            .filter((enemy) => enemy.locationId === ws.currentLocationId)
            .filter((enemy) => !ws.defeatedEnemyIds.includes(enemy.id))
            .filter((enemy) => releasedEnemies.includes(enemy.id))
            .map((enemy) => ({
              kind: "attack" as const,
              label: `挑战${enemy.name}`,
              targetId: enemy.id,
            })),
        ],
    legalEventTargets: {
      locationIds: ws.locations
        .filter((location) => ws.unlockedLocationIds.includes(location.id))
        .map((location) => location.id),
      factIds: Array.from(new Set([
        ...releasedFacts,
        ...job.resolvedEvent.facts.map((fact) => fact.factId),
      ])),
      itemIds: releasedItems,
      enemyIds: activeBattleEnemyId !== null
        ? [
            activeBattleEnemyId,
            ...releasedEnemies.filter((enemyId) => enemyId !== activeBattleEnemyId),
          ]
        : releasedEnemies,
    },
    worldConstraints: [],
    objectiveTransition: transition,
    mandatoryBeats: job.mandatoryBeats,
    beatSubjects,
    focusNpcContext,
    objectiveTarget,
    narrativeReferenceIds,
    ...(resolvedInvestigation === undefined ? {} : { resolvedInvestigation }),
    upcomingLinearObjectives,
    ...(previousDialogue === undefined ? {} : { previousDialogue }),
    ...(ss.narrative.dialogueSession?.completed === true ? { dialogueSessionCompleted: true } : {}),
  };
}
