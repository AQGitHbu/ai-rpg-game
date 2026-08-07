// ---------------------------------------------------------------------------
// Phase 10 Task 6：运行时叙事 fixture source。
// 返回确定的硬编码数据，用于离线测试与无 AI 环境。
// ---------------------------------------------------------------------------

import type { ApprovedDirectorPlan, ApprovedSceneScript, NpcPerformanceProposal } from "@/game/gameplay/rpg/narrative";
import {
  NARRATIVE_CONTRACT_VERSION,
  type DirectorSource,
  type DirectorAttempt,
  type SceneScriptSource,
  type SceneScriptAttempt,
  type NpcLineSource,
  type NpcLineAttempt,
} from "../../runtimeNarrative";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type RuntimeNarrativeFixtureSourceOptions = Readonly<{
  fixtureId: string;
  /** 出故障模式可选：故障模式字段将被视为模拟故障。 */
  scenario?: string;
}>;

/**
 * 创建三角色 runtime narrative fixture sources。
 * 三个 source 都返回硬编码 fixture 数据，不涉及 AI 调用。
 */
export function createRuntimeNarrativeFixtureSources(): {
  directorSource: DirectorSource;
  sceneScriptSource: SceneScriptSource;
  npcLineSource: NpcLineSource;
} {
  return {
    directorSource: createFixtureDirectorSource(),
    sceneScriptSource: createFixtureSceneScriptSource(),
    npcLineSource: createFixtureNpcLineSource(),
  };
}

// ---------------------------------------------------------------------------
// Fixture 数据
// ---------------------------------------------------------------------------

const FIXTURE_DIRECTOR_PLAN: ApprovedDirectorPlan = {
  sceneGoal: "fixture 目标：展示叙事能力",
  tensionLevel: 2,
  focusNpcId: null,
  relevantFactIds: [],
  allowedRevealFactIds: [],
  suggestedActionKeys: ["__fixture__", "__fixture__"] as unknown as readonly [string, string],
  introducedEntities: [],
  pacing: "develop",
  proposedNewLocations: [],
  proposedNewNpcs: [],
};

const FIXTURE_SCENE_SCRIPT: ApprovedSceneScript = {
  narration: "你来到一处安静的地方。微风吹过，带来远方的消息。",
  usedFactIds: [],
  npcInstruction: null,
  choices: [
    { actionKey: "__fixture__", label: "探索周围", strategy: "观察环境" },
    { actionKey: "__fixture__", label: "继续前进", strategy: "保持移动" },
  ],
};

const FIXTURE_NPC_PERFORMANCE: NpcPerformanceProposal = {
  text: "你好，旅行者。",
  usedFactIds: [],
  emotion: "neutral",
};

// ---------------------------------------------------------------------------
// 导演 fixture source
// ---------------------------------------------------------------------------

function createFixtureDirectorSource(): DirectorSource {
  return {
    async generate(request): Promise<DirectorAttempt> {
      const trigger = typeof request.context.triggerContext === "object" && request.context.triggerContext !== null
        ? request.context.triggerContext as Record<string, unknown>
        : null;
      const isDialogue = trigger !== null &&
        ["initial_opening", "talk", "free_input"].includes(String(trigger.kind));
      const candidates = Array.isArray(request.context.actionCandidates)
        ? request.context.actionCandidates.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).actionKey === "string")
        : [];
      const first = String(candidates[0]?.actionKey ?? "__fixture__");
      const second = String(candidates[1]?.actionKey ?? first);
      return {
        ok: true,
        provenance: "fixture",
        plan: {
          ...FIXTURE_DIRECTOR_PLAN,
          suggestedActionKeys: [first, second],
          ...(isDialogue ? {
            eventKind: "dialogue" as const,
            focusNpcId: typeof trigger?.npcId === "string" ? trigger.npcId : null,
            eventTargetId: typeof trigger?.npcId === "string" ? trigger.npcId : undefined,
          } : {}),
        },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "completed",
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 编剧 fixture source
// ---------------------------------------------------------------------------

function createFixtureSceneScriptSource(): SceneScriptSource {
  return {
    async generate(request): Promise<SceneScriptAttempt> {
      const plan = typeof request.context.plan === "object" && request.context.plan !== null
        ? request.context.plan as Record<string, unknown>
        : {};
      const isDialogue = plan.eventKind === "dialogue";
      return {
        ok: true,
        provenance: "fixture",
        script: isDialogue
          ? {
              ...FIXTURE_SCENE_SCRIPT,
              choices: [
                { actionKey: "dialogue:fixture:0", label: "询问目前发生了什么状况", strategy: "先了解现场情况", choiceKind: "dialogue_response", dialogueIntent: "ask_current_situation" },
                { actionKey: "dialogue:fixture:1", label: "追问刚维修为何又出故障", strategy: "质疑异常维修记录", choiceKind: "dialogue_response", dialogueIntent: "challenge_recent_repair" },
              ],
            }
          : { ...FIXTURE_SCENE_SCRIPT },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "completed",
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 演员 fixture source
// ---------------------------------------------------------------------------

function createFixtureNpcLineSource(): NpcLineSource {
  return {
    async generate(request): Promise<NpcLineAttempt> {
      return {
        ok: true,
        provenance: "fixture",
        performance: { ...FIXTURE_NPC_PERFORMANCE },
        diagnostics: {
          traceId: request.traceId,
          contractVersion: NARRATIVE_CONTRACT_VERSION,
          stage: "completed",
        },
      };
    },
  };
}
