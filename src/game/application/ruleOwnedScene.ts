import type { Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { ApprovedChoice } from "@/game/domain/approvedChoice";
import type {
  DialogueResumeState,
  NarrativeEventState,
  NarrativeSceneState,
} from "@/game/domain/narrative";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { asEnemyId, asFactId, asItemId, asLocationId, asNpcId } from "@/game/domain/worldEntity";
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";

function eventForAction(action: Action, worldState: WorldState): NarrativeEventState {
  switch (action.type) {
    case "move": return { kind: "travel", locationId: asLocationId(action.locationId) };
    case "investigate": return { kind: "investigate", factId: asFactId(action.factId) };
    case "take_item":
    case "give_item": return { kind: "item", itemId: asItemId(action.itemId) };
    case "attack":
    case "battle_action": {
      const enemyId = worldState.battle.status === "active"
        ? worldState.battle.enemyId
        : action.type === "attack"
          ? action.enemyId
          : String(action.command?.targetId ?? "unknown_enemy");
      return { kind: "battle", enemyId: asEnemyId(enemyId) };
    }
    case "talk": return { kind: "dialogue", focusNpcId: asNpcId(action.npcId) };
    case "explore":
    case "ack_prologue":
    case "freeform": return { kind: "observe", locationId: asLocationId(worldState.currentLocationId) };
  }
}

function narrationFor(_action: Action, resolvedEvent: ResolvedEvent): string {
  // Task 9: Rule-owned scenes no longer produce player-visible prose.
  // Only generated/fixture scenes carry narration text.
  if (resolvedEvent.status === "failure" || resolvedEvent.status === "partial_success") return "";
  return "";
}

function dialogueResumeFor(
  worldState: WorldState,
  storyState: StoryState,
): DialogueResumeState | undefined {
  const narrative = storyState.narrative;
  if (narrative.status !== "ready") return undefined;

  const objectiveRef = currentObjectiveOf(worldState, storyState);
  const quest = objectiveRef === null
    ? undefined
    : worldState.quests.find((entry) => String(entry.id) === String(objectiveRef.questId));
  const objective = objectiveRef === null
    ? undefined
    : quest?.objectives[objectiveRef.objectiveIndex];
  const objectiveKey = objectiveRef === null
    ? null
    : `${objectiveRef.questId}:${objectiveRef.objectiveIndex}`;
  if (objective?.kind !== "talk_to_npc" || objectiveKey === null) return undefined;

  const existing = narrative.dialogueResume;
  if (
    existing !== undefined
    && existing.objectiveKey === objectiveKey
    && String(existing.npcId) === String(objective.npcId)
  ) {
    return existing;
  }

  const currentScene = narrative.currentScene;
  if (currentScene.npcLine === null || currentScene.choices.length !== 2) return undefined;
  if (String(currentScene.npcLine.npcId) !== String(objective.npcId)) return undefined;

  const choices = currentScene.choices
    .map((sceneChoice) => narrative.choiceRegistry.find((entry) =>
      entry.choiceToken === sceneChoice.choiceToken
      && entry.sceneId === currentScene.sceneId,
    ))
    .filter((entry): entry is ApprovedChoice => entry !== undefined);
  if (choices.length !== currentScene.choices.length) return undefined;
  if (choices.some((entry) => {
    if (entry.action.type !== "talk") return true;
    return String(entry.action.npcId) !== String(objective.npcId);
  })) return undefined;

  const locationId = currentScene.event?.kind === "travel"
    ? currentScene.event.locationId
    : asLocationId(worldState.currentLocationId);
  return {
    objectiveKey,
    npcId: asNpcId(objective.npcId),
    locationId,
    scene: currentScene,
    choiceRegistry: choices,
  };
}

/** Rule-owned presentation for actions that do not cross an NPC/provider boundary. */
export function buildRuleOwnedScene(input: {
  readonly action: Action;
  readonly resolvedEvent: ResolvedEvent;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly turn: number;
}): { readonly scene: NarrativeSceneState; readonly storyState: StoryState } {
  const dialogueResume = dialogueResumeFor(input.worldState, input.storyState);
  const narrativeWithoutDialogueResume = input.storyState.narrative.status === "ready"
    ? (() => {
        const { dialogueResume: _previousDialogueResume, ...readyNarrative } = input.storyState.narrative;
        return readyNarrative;
      })()
    : input.storyState.narrative;
  const scene: NarrativeSceneState = {
    sceneId: `scene-rule-${input.resolvedEvent.actionId}`,
    turn: input.turn,
    narration: narrationFor(input.action, input.resolvedEvent),
    usedFactIds: [],
    npcLine: null,
    choices: [],
    source: "rule",
    event: eventForAction(input.action, input.worldState),
  };
  return {
    scene,
    storyState: {
      ...input.storyState,
      narrative: {
        ...narrativeWithoutDialogueResume,
        status: "ready",
        currentScene: scene,
        choiceRegistry: [],
        ...(dialogueResume === undefined ? {} : { dialogueResume }),
      },
    },
  };
}
