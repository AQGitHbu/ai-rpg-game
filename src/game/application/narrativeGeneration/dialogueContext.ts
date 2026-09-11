import type { NarrativeSceneState } from "@/game/domain/narrative";
import type { PlanningContext } from "./stageSource";

/** 最近实际展示的一轮，只给统一规划器；不把整个存档/其他角色历史传给表达器。 */
export function previousDialogue(input: PlanningContext) {
  if (input.kind !== "decision") return null;
  const narrative = input.story.narrative;
  const scene: NarrativeSceneState | null = "lastPresentedScene" in narrative
    ? narrative.lastPresentedScene : narrative.currentScene;
  if (scene === null || scene.npcLine === null || scene.npcLine.npcId !== input.job.focusNpcId) return null;
  return {
    npcId: String(scene.npcLine.npcId),
    narration: scene.narration,
    reply: { text: scene.npcLine.text, factIds: scene.npcLine.usedFactIds.map(String) },
    choices: scene.choices.map(choice => choice.label),
  };
}
