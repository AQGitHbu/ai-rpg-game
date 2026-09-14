import type { TalkAction } from "@/game/domain/action";
import type { StoryState } from "@/game/domain/storyState";
import type { WorldState } from "@/game/domain/worldState";

export type EndingDecisionStance = {
  readonly candidateId: "ending_stance_support" | "ending_stance_challenge";
  readonly label: string;
  readonly action: TalkAction;
};

/**
 * 结局对已具象化、故事尚未结算：玩家必须在两种立场之间作出明确分歧，
 * `resolveEnding` 才会消费这次 support/challenge。
 */
export function isEndingDecisionDue(
  worldState: WorldState,
  storyState: StoryState,
): boolean {
  return storyState.endingAllowed
    && worldState.ending === null
    && worldState.endings.length >= 2;
}

/**
 * 终幕立场的 NPC 权威与 `resolveEnding` 读取的“最后一名 NPC”保持一致：优先
 * array 末尾的 NPC，只有他不在场时才退到场内最后一名 NPC，保证立场仍是一次
 * 通过 NPC_NOT_PRESENT 校验的合法交谈。
 */
export function endingStanceNpc(worldState: WorldState): WorldState["npcs"][number] | undefined {
  const last = worldState.npcs.at(-1);
  if (last !== undefined && String(last.locationId) === String(worldState.currentLocationId)) {
    return last;
  }
  return [...worldState.npcs].reverse()
    .find((npc) => String(npc.locationId) === String(worldState.currentLocationId));
}

/**
 * 结局立场由服务端铸造：它是规则裁决（trust/doubt）而不是叙事文本，因此不走
 * 叙事包契约——结局包的 `terminal.kind === "ending"` 明确禁止 provider 提交
 * currentScene choices。
 */
export function endingDecisionStances(
  worldState: WorldState,
  storyState: StoryState,
): readonly EndingDecisionStance[] {
  if (!isEndingDecisionDue(worldState, storyState)) return [];
  const npc = endingStanceNpc(worldState);
  if (npc === undefined) return [];
  return [
    {
      candidateId: "ending_stance_support",
      label: "我认可你的回应，愿意继续合作。",
      action: { type: "talk", npcId: npc.id, dialogueAct: "support" },
    },
    {
      candidateId: "ending_stance_challenge",
      label: "我仍有疑虑，暂不认可你的回应。",
      action: { type: "talk", npcId: npc.id, dialogueAct: "challenge" },
    },
  ];
}
