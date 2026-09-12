import type { Action } from "@/game/domain/action";
import type { StoryState } from "@/game/domain/storyState";
import type { QuestObjective, QuestEntry, WorldState } from "@/game/domain/worldState";
import type { ItemId } from "@/game/domain/worldEntity";
import { isObjectiveSatisfiedInStory } from "@/game/gameplay/rpg/narrativeContext";
import { applyEntityMutations, EntityMutationInvariantError } from "@/game/gameplay/rpg/entityWorld";

/** 旧存档没有 reveal 字段时，保持既有“全部已物化内容可用”的兼容语义。 */
export function isQuestObjectiveReleased(
  storyState: StoryState,
  questId: string,
  objectiveIndex: number,
): boolean {
  const reveal = storyState.reveal;
  if (reveal === undefined || reveal === null) return true;
  if (String(reveal.questId) !== String(questId)) return true;
  return objectiveIndex <= reveal.visibleObjectiveIndex;
}

function objectiveIndexFor(
  quest: QuestEntry,
  predicate: (objective: QuestObjective) => boolean,
): number | null {
  const index = quest.objectives.findIndex(predicate);
  return index < 0 ? null : index;
}

/**
 * 判断一个动态实体是否已经随主线目标释放。旁支任务和没有游标的旧存档
 * 不受影响；同一实体若被当前主线引用，则只认该引用第一次出现的位置。
 */
export function isObjectiveEntityReleased(
  worldState: WorldState,
  storyState: StoryState | undefined,
  predicate: (objective: QuestObjective) => boolean,
): boolean {
  if (storyState === undefined) return true;
  const questId = storyState.reveal?.questId;
  if (questId === undefined || questId === null) return true;
  const quest = worldState.quests.find((entry) => String(entry.id) === String(questId));
  if (quest === undefined) return true;
  const index = objectiveIndexFor(quest, predicate);
  return index === null || isQuestObjectiveReleased(storyState, quest.id, index);
}

export function isActionReleased(
  worldState: WorldState,
  storyState: StoryState,
  action: Action,
): boolean {
  switch (action.type) {
    case "move":
      return isObjectiveEntityReleased(worldState, storyState, (objective) =>
        objective.kind === "visit_location" && String(objective.locationId) === String(action.locationId));
    case "talk":
      return isObjectiveEntityReleased(worldState, storyState, (objective) =>
        objective.kind === "talk_to_npc" && String(objective.npcId) === String(action.npcId));
    case "investigate":
      return isObjectiveEntityReleased(worldState, storyState, (objective) =>
        objective.kind === "discover_fact" && String(objective.factId) === String(action.factId));
    case "take_item":
      return isObjectiveEntityReleased(worldState, storyState, (objective) =>
        objective.kind === "obtain_item" && String(objective.itemId) === String(action.itemId));
    case "give_item":
      {
        const bundle = storyState.narrative.status === "ready"
          ? storyState.narrative.narrativeBundle
          : undefined;
      return isObjectiveEntityReleased(worldState, storyState, (objective) =>
        objective.kind === "obtain_item" && String(objective.itemId) === String(action.itemId))
        || (bundle?.activeStepIds.some((stepId) => {
            const step = bundle.steps.find((candidate) => candidate.stepId === stepId);
            return step?.trigger.kind === "give_item"
              && String(step.trigger.itemId) === String(action.itemId)
              && String(step.trigger.npcId) === String(action.npcId);
          }) === true);
      }
    case "abandon_quest":
      return worldState.quests.some((quest) => quest.id === action.questId && quest.kind === "main" && quest.status === "active")
        && (storyState.reveal === undefined || storyState.reveal === null || String(storyState.reveal.questId) === String(action.questId));
    case "attack":
      return isObjectiveEntityReleased(worldState, storyState, (objective) =>
        objective.kind === "defeat_enemy" && String(objective.enemyId) === String(action.enemyId));
    case "explore":
    case "battle_action":
    case "ack_prologue":
    case "freeform":
      return true;
  }
}

/**
 * A v7 bundle owns which deterministic item action can be consumed next.
 * Older saves without a bundle retain their historical projection behavior.
 */
export function isTakeItemPrepared(storyState: StoryState, itemId: ItemId): boolean {
  const bundle = storyState.narrative.status === "ready"
    ? storyState.narrative.narrativeBundle
    : undefined;
  // Live AI mode has always required a prepared continuation to consume a
  // deterministic item action. Keep the permissive path only for offline
  // fixture/legacy saves, which have no v7 bundle to consult.
  if (bundle === undefined) return storyState.narrative.mode !== "ai";
  const activeStepIds = new Set(bundle.activeStepIds);
  return bundle.steps.some((step) => activeStepIds.has(step.stepId)
    && step.trigger.kind === "take_item"
    && String(step.trigger.itemId) === String(itemId));
}

/** 只把当前已释放目标推进一格；不会跳过中间的调查/抵达/交谈步骤。 */
export function advanceStoryReveal(input: {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
}): { readonly worldState: WorldState; readonly storyState: StoryState } {
  const { worldState, storyState } = input;
  const reveal = storyState.reveal;
  if (reveal === undefined || reveal === null) return { worldState, storyState };

  const quest = worldState.quests.find((entry) => String(entry.id) === String(reveal.questId));
  const currentObjective = quest?.objectives[reveal.visibleObjectiveIndex];
  if (
    quest === undefined
    || currentObjective === undefined
    || !isObjectiveSatisfiedInStory(worldState, storyState, currentObjective)
  ) {
    return { worldState, storyState };
  }

  const nextIndex = reveal.visibleObjectiveIndex + 1;
  if (nextIndex >= quest.objectives.length) {
    return {
      worldState,
      storyState: { ...storyState, reveal: null },
    };
  }

  const nextObjective = quest.objectives[nextIndex];
  let nextWorldState = worldState;
  // 新地点在“调查现场”完成后才解锁；之后的移动、交谈、取物、战斗仍按
  // 游标逐段释放，因此地图不会提前出现完整下一幕。
  if (nextObjective.kind === "visit_location" && !worldState.unlockedLocationIds.includes(nextObjective.locationId)) {
    const applied = applyEntityMutations(worldState, [{ kind: "set_location_unlocked", locationId: nextObjective.locationId, unlocked: true }]);
    if (!applied.ok) throw new EntityMutationInvariantError(applied);
    nextWorldState = applied.worldState;
  }

  return {
    worldState: nextWorldState,
    storyState: {
      ...storyState,
      reveal: { ...reveal, visibleObjectiveIndex: nextIndex },
    },
  };
}
