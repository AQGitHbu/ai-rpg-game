import type { Action } from "@/game/domain/action";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeEventState, NarrativeSceneState } from "@/game/domain/narrative";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";
import { asEnemyId, asFactId, asItemId, asLocationId, asNpcId } from "@/game/domain/worldEntity";

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

function narrationFor(action: Action, resolvedEvent: ResolvedEvent): string {
  if (resolvedEvent.status === "failure" || resolvedEvent.status === "partial_success") return resolvedEvent.rejectedEffects[0]?.description ?? "行动未能完全达成。";
  switch (action.type) {
    case "move": return "你确认了脚下的方向，暂时退回熟悉的路径。";
    case "investigate": return "你按规则记录下眼前的调查结果。";
    case "take_item": return "你收起了眼前的物品。";
    case "give_item": return "你完成了物品交接。";
    case "attack":
    case "battle_action": return "战斗结果已经由规则结算。";
    case "explore": return "你环顾当前地点，确认了周围的结构。";
    case "ack_prologue": return "你记下了眼前的安排。";
    case "talk":
    case "freeform": return "行动结果已经由规则记录。";
  }
}

/** Rule-owned presentation for actions that do not cross an NPC/provider boundary. */
export function buildRuleOwnedScene(input: {
  readonly action: Action;
  readonly resolvedEvent: ResolvedEvent;
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly turn: number;
}): { readonly scene: NarrativeSceneState; readonly storyState: StoryState } {
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
        ...input.storyState.narrative,
        status: "ready",
        currentScene: scene,
        choiceRegistry: [],
      },
    },
  };
}
