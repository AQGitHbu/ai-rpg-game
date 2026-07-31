// ---------------------------------------------------------------------------
// Phase 10 Task 4：运行时叙事场面的 fallback 数据。
// 任何 source 失败或审批未通过时，回退到此确定的 fallback 场景。
// ---------------------------------------------------------------------------

import type { ApprovedDirectorPlan, ApprovedSceneScript } from "@/game/gameplay/rpg/narrative";

export const FALLBACK_DIRECTOR_PLAN: ApprovedDirectorPlan = Object.freeze({
  sceneGoal: "让玩家继续探索",
  tensionLevel: 1 as const,
  focusNpcId: null,
  relevantFactIds: Object.freeze([] as readonly string[]),
  allowedRevealFactIds: Object.freeze([] as readonly string[]),
  suggestedActionKeys: Object.freeze([] as unknown as readonly [string, string]),
  introducedEntities: Object.freeze([] as readonly never[]),
  pacing: "setup" as const,
  proposedNewLocations: Object.freeze([] as readonly never[]),
  proposedNewNpcs: Object.freeze([] as readonly never[]),
});

export const FALLBACK_SCENE_SCRIPT: ApprovedSceneScript = Object.freeze({
  narration: "你环顾四周，等待着下一步的决定。",
  usedFactIds: Object.freeze([] as readonly string[]),
  npcInstruction: null,
  choices: Object.freeze([
    Object.freeze({
      actionKey: "__fallback__",
      label: "继续前行",
      strategy: "等待玩家选择",
    }),
    Object.freeze({
      actionKey: "__fallback__",
      label: "四处观察",
      strategy: "等待玩家选择",
    }),
  ]) as unknown as readonly [
    { readonly actionKey: string; readonly label: string; readonly strategy: string },
    { readonly actionKey: string; readonly label: string; readonly strategy: string },
  ],
});
