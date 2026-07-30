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
      return {
        ok: true,
        provenance: "fixture",
        plan: { ...FIXTURE_DIRECTOR_PLAN },
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
      return {
        ok: true,
        provenance: "fixture",
        script: { ...FIXTURE_SCENE_SCRIPT },
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
