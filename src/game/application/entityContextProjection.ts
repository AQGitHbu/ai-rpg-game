import {
  entitiesOfKind,
  getEntity,
  type EntityId,
  type EntityKind,
  type EntityRecord,
} from "@/game/domain/entity";
import type { PendingNarrativeJob } from "@/game/domain/pendingNarrativeJob";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldDeltaEntityContextClosure } from "@/game/domain/worldDelta";
import type { QuestObjective } from "@/game/domain/worldEntries";
import type { WorldState } from "@/game/domain/worldState";
import { PLAYER_ENTITY_ID } from "@/game/domain/worldEntity";
import { retrieveStoryEvidence } from "@/game/gameplay/rpg/narrativeMemory";

export type NarrativeEntitySummary = Readonly<{
  id: string;
  kind: EntityKind;
  name: string;
  summary: string;
  locationId?: string;
  /** Author/reviewer references only; private goal text, state and conditions stay excluded. */
  goalBindings?: readonly Readonly<{ goalOrdinal: number; goalId: string; hasResolution: boolean }>[];
}>;

export type EntityContextProjection = Readonly<{
  mandatory: readonly NarrativeEntitySummary[];
  optional: readonly NarrativeEntitySummary[];
  occupiedNames: Readonly<Record<"location" | "npc" | "item" | "enemy" | "quest", readonly string[]>>;
}>;

function objectiveEntityId(objective: QuestObjective | undefined): string | undefined {
  if (objective === undefined) return undefined;
  switch (objective.kind) {
    case "visit_location": return String(objective.locationId);
    case "talk_to_npc": return String(objective.npcId);
    case "obtain_item": return String(objective.itemId);
    case "discover_fact": return String(objective.factId);
    case "defeat_enemy": return String(objective.enemyId);
  }
}

function actionEntityIds(action: PendingNarrativeJob["actionSummary"]): readonly string[] {
  switch (action.kind) {
    case "talk": return [String(action.npcId)];
    case "move": return [String(action.locationId)];
    case "take_item": return [String(action.itemId)];
    case "give_item": return [String(action.itemId), String(action.npcId)];
    case "abandon_quest": return [String(action.questId)];
    case "investigate": return [String(action.factId)];
    case "attack": return [String(action.enemyId)];
    case "explore":
    case "battle_action":
    case "ack_prologue":
    case "freeform":
      return [];
  }
}

function isEntityKind<K extends EntityKind>(
  record: EntityRecord,
  kind: K,
): record is Extract<EntityRecord, { core: { kind: K } }> {
  return record.core.kind === kind;
}

function directReferenceIds(record: EntityRecord, safeFactIds: ReadonlySet<string>): readonly string[] {
  if (isEntityKind(record, "player_character") || isEntityKind(record, "enemy")) {
    return [String(record.position.locationId)];
  }
  if (isEntityKind(record, "npc")) return [
    String(record.position.locationId),
    ...record.knowledge.entries
      .filter((entry) => entry.disclosure !== "secret")
      .map((entry) => String(entry.factId))
      .filter((id) => safeFactIds.has(id)),
  ];
  if (isEntityKind(record, "item")) {
    const owner = record.possession.owner;
    if (owner.kind === "player") return [String(owner.playerId)];
    if (owner.kind === "location") return [String(owner.locationId)];
    if (owner.kind === "npc") return [String(owner.npcId)];
  }
  if (isEntityKind(record, "fact") && record.fact.locationId !== undefined) {
    return [String(record.fact.locationId)];
  }
  return [];
}

function summaryOf(record: EntityRecord, focusNpcId: string | undefined): NarrativeEntitySummary {
  if (isEntityKind(record, "player_character")) return {
    id: String(record.core.id), kind: record.core.kind, name: record.core.name,
    summary: `身份=${record.identity.identity}`, locationId: String(record.position.locationId),
  };
  if (isEntityKind(record, "location")) return {
    id: String(record.core.id), kind: record.core.kind, name: record.core.name,
    summary: `${record.location.description}；已解锁=${record.location.unlocked}；已到访=${record.location.visited}`,
    locationId: String(record.core.id),
  };
  if (isEntityKind(record, "npc")) {
    const recent = String(record.core.id) === focusNpcId
      ? record.history.interactions.slice(-5)
        .map((entry) => entry.summary.replace(/关系[+-]?\d+(?:\.\d+)?/g, "关系变化"))
        .filter((entry) => entry.trim() !== "")
      : [];
    return {
      id: String(record.core.id), kind: record.core.kind, name: record.core.name,
      goalBindings: record.dynamicState.goals.map((goal, goalOrdinal) => ({ goalOrdinal, goalId: goal.goalId, hasResolution: goal.resolution !== undefined })),
      summary: `角色=${record.identity.role}；${record.identity.description}；角色条件由私有判断上下文裁决${recent.length === 0 ? "" : `；最近交互=${recent.join("｜")}`}`,
      locationId: String(record.position.locationId),
    };
  }
  if (isEntityKind(record, "item")) {
    const owner = record.possession.owner;
    const locationId = owner.kind === "location" ? String(owner.locationId) : undefined;
    const ownerText = owner.kind === "player"
      ? "玩家持有"
      : owner.kind === "location"
        ? `位于=${owner.locationId}`
        : owner.kind === "npc"
          ? `由NPC=${owner.npcId}持有`
          : "当前无主";
    return {
      id: String(record.core.id), kind: record.core.kind, name: record.core.name,
      summary: `${record.presentation.description}；${ownerText}`,
      ...(locationId === undefined ? {} : { locationId }),
    };
  }
  if (isEntityKind(record, "enemy")) return {
    id: String(record.core.id), kind: record.core.kind, name: record.core.name,
    summary: `强度=${record.enemy.tier}；已击败=${record.enemy.defeated}`,
    locationId: String(record.position.locationId),
  };
  if (isEntityKind(record, "faction")) return {
    id: String(record.core.id), kind: record.core.kind, name: record.core.name, summary: "已批准阵营",
  };
  if (isEntityKind(record, "quest")) return {
    id: String(record.core.id), kind: record.core.kind, name: record.core.name,
    summary: `${record.quest.description}；状态=${record.quest.status}`,
  };
  if (!isEntityKind(record, "fact")) throw new Error("unsupported entity kind");
  return {
    id: String(record.core.id), kind: record.core.kind, name: "已发现线索",
    summary: record.fact.text,
    ...(record.fact.locationId === undefined ? {} : { locationId: String(record.fact.locationId) }),
  };
}

function activeQuestRecord(worldState: WorldState): Extract<EntityRecord, { core: { kind: "quest" } }> | undefined {
  const quests = entitiesOfKind(worldState.entityStore, "quest");
  return quests.find((record) => record.quest.status === "active" && record.quest.kind === "main")
    ?? quests.find((record) => record.quest.status === "active");
}

/**
 * 从权威 store 选择 Prompt 所需实体。mandatory 只由服务器结构化引用闭包产生；
 * AI prose 和玩家原文都不能扩大它。optional 只走一跳空间/当前可见任务引用并受上限约束。
 */
export function buildEntityContextProjection(input: {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly job: PendingNarrativeJob;
  readonly optionalLimit?: number;
  /** Entity references already authorized by the memory projection. */
  readonly memoryEntityIds?: readonly EntityId[];
}): EntityContextProjection {
  const { entityStore } = input.worldState;
  const hiddenFactIds = new Set(
    entitiesOfKind(entityStore, "npc")
      .flatMap((record) => record.knowledge.entries)
      .filter((entry) => entry.disclosure === "secret")
      .map((entry) => String(entry.factId)),
  );
  const safeFactIds = new Set(
    entitiesOfKind(entityStore, "fact")
      .filter((record) => record.fact.discovered && !hiddenFactIds.has(String(record.core.id)))
      .map((record) => String(record.core.id)),
  );
  const quest = activeQuestRecord(input.worldState);
  const after = input.job.objectiveTransition.after;
  const currentObjective = after !== null && quest !== undefined && String(after.questId) === String(quest.core.id)
    ? quest.quest.objectives[after.objectiveIndex]
    : undefined;
  const objectiveId = objectiveEntityId(currentObjective);
  const storyEvidence = retrieveStoryEvidence({
    worldState: input.worldState,
    storyState: input.storyState,
    observerId: PLAYER_ENTITY_ID,
    text: input.job.utterance ?? input.job.selectedDialogue?.label ?? "",
    actionEntityIds: actionEntityIds(input.job.actionSummary) as readonly EntityId[],
    focusEntityIds: input.job.focusNpcId === undefined ? [] : [input.job.focusNpcId],
  });

  const mandatoryIds = new Set<string>([
    "player_0",
    String(input.worldState.currentLocationId),
    ...actionEntityIds(input.job.actionSummary),
    ...input.job.mandatoryBeats.flatMap((beat) => beat.subjectIds),
    ...(input.job.focusNpcId === undefined ? [] : [String(input.job.focusNpcId)]),
    ...(quest === undefined ? [] : [String(quest.core.id)]),
    ...(objectiveId === undefined ? [] : [objectiveId]),
    ...(input.memoryEntityIds ?? []).map(String),
    ...storyEvidence.entityIds.map(String),
    ...entitiesOfKind(entityStore, "item")
      .filter((record) => record.possession.owner.kind === "player")
      .map((record) => String(record.core.id)),
  ]);

  // 只闭包结构化种子直接引用的地点/安全事实/持有者；不会沿地点成员扩成全世界。
  const pendingReferenceIds = [...mandatoryIds];
  const expandedIds = new Set<string>();
  while (pendingReferenceIds.length > 0) {
    const id = pendingReferenceIds.shift();
    if (id === undefined || expandedIds.has(id)) continue;
    expandedIds.add(id);
    const record = getEntity(entityStore, id);
    if (record === undefined) continue;
    for (const referencedId of directReferenceIds(record, safeFactIds)) {
      if (!mandatoryIds.has(referencedId)) {
        mandatoryIds.add(referencedId);
        pendingReferenceIds.push(referencedId);
      }
    }
  }

  const mandatory = [...mandatoryIds]
    .map((id) => getEntity(entityStore, id))
    .filter((record): record is EntityRecord => record !== undefined)
    .filter((record) => record.core.kind !== "fact" || safeFactIds.has(String(record.core.id)))
    .map((record) => summaryOf(record, input.job.focusNpcId === undefined ? undefined : String(input.job.focusNpcId)))
    .sort((left, right) => left.id.localeCompare(right.id));

  const optionalIds = new Set<string>();
  const currentLocationId = String(input.worldState.currentLocationId);
  const currentLocation = getEntity(entityStore, currentLocationId);
  for (const record of entityStore.records) {
    if (mandatoryIds.has(String(record.core.id)) || record.core.lifecycle !== "active") continue;
    if ((isEntityKind(record, "npc") || isEntityKind(record, "enemy")) && String(record.position.locationId) === currentLocationId) {
      optionalIds.add(String(record.core.id));
    }
    if (isEntityKind(record, "item") && record.possession.owner.kind === "location" && String(record.possession.owner.locationId) === currentLocationId) {
      optionalIds.add(String(record.core.id));
    }
    if (isEntityKind(record, "location") && currentLocation !== undefined && isEntityKind(currentLocation, "location") && currentLocation.location.connectedLocationIds.includes(record.core.id)) {
      optionalIds.add(String(record.core.id));
    }
  }

  // 只投影 reveal 游标以内的任务目标，避免把未来未释放实体泄漏给 Prompt。
  if (quest !== undefined) {
    const visibleIndex = input.storyState.reveal?.questId === quest.core.id
      ? input.storyState.reveal.visibleObjectiveIndex
      : after?.questId === quest.core.id
        ? after.objectiveIndex
        : 0;
    quest.quest.objectives.slice(0, visibleIndex + 1).forEach((objective) => {
      const id = objectiveEntityId(objective);
      if (id !== undefined && !mandatoryIds.has(id)) optionalIds.add(id);
    });
  }

  const optional = [...optionalIds]
    .map((id) => getEntity(entityStore, id))
    .filter((record): record is EntityRecord => record !== undefined && record.core.lifecycle === "active")
    .filter((record) => record.core.kind !== "fact" || safeFactIds.has(String(record.core.id)))
    .map((record) => summaryOf(record, input.job.focusNpcId === undefined ? undefined : String(input.job.focusNpcId)))
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, Math.max(0, input.optionalLimit ?? 12));

  const names = (kind: "location" | "npc" | "item" | "enemy" | "quest"): readonly string[] =>
    entitiesOfKind(entityStore, kind).map((record) => record.core.name).sort((left, right) => left.localeCompare(right, "zh-CN"));

  return {
    mandatory,
    optional,
    occupiedNames: {
      location: names("location"), npc: names("npc"), item: names("item"),
      enemy: names("enemy"), quest: names("quest"),
    },
  };
}

/**
 * 将同一应用边界已经计算出的实体闭包交给 world-delta 审批。
 * 这是关系种子的 allowlist，不是让审批层自行遍历全世界的替代入口。
 */
export function buildWorldDeltaEntityContextClosure(input: {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly job: PendingNarrativeJob;
}): WorldDeltaEntityContextClosure {
  const projection = buildEntityContextProjection(input);
  const currentLocationId = String(input.worldState.currentLocationId);
  const currentLocationActiveNpcIds = entitiesOfKind(input.worldState.entityStore, "npc")
    .filter((record) => record.core.lifecycle === "active" && String(record.position.locationId) === currentLocationId)
    .map((record) => String(record.core.id));
  const projectedFactIds = new Set([...projection.mandatory, ...projection.optional]
    .filter((entity) => entity.kind === "fact").map((entity) => entity.id));
  const declarableExistingFactIds = [...new Set(entitiesOfKind(input.worldState.entityStore, "npc")
    .flatMap((record) => record.knowledge.entries)
    .filter((entry) => entry.certainty === "known" && entry.disclosure === "public" && entry.source.kind === "initial_world")
    .map((entry) => String(entry.factId))
    .filter((factId) => projectedFactIds.has(factId)))].sort();
  return {
    mandatoryEntityIds: projection.mandatory.map((entity) => entity.id),
    directReferenceEntityIds: projection.mandatory.map((entity) => entity.id),
    currentLocationActiveNpcIds,
    declarableExistingFactIds,
  };
}
