// ---------------------------------------------------------------------------
// Phase 10 Task 5：get_or_create_scene 应用用例。
// 从 GameState.narrative.currentScene 获取当前场景，不存在则经由编排器创建。
// ---------------------------------------------------------------------------

import type { GameState, ScenarioBlueprint, NarrativeSceneState } from "@/game/domain";
import type { GameLogger } from "@/game/logging";
import type {
  DirectorSource,
  SceneScriptSource,
  NpcLineSource,
} from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";

// ---------------------------------------------------------------------------
// 输入/输出
// ---------------------------------------------------------------------------

export type GetOrCreateSceneInput = {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly directorSource: DirectorSource;
  readonly sceneScriptSource: SceneScriptSource;
  readonly npcLineSource: NpcLineSource;
  readonly logger?: GameLogger;
};

export type GetOrCreateSceneResult = {
  readonly scene: NarrativeSceneState;
  readonly provenance: "generated" | "fixture" | "fallback" | "cached";
  readonly diagnostics?: {
    readonly director: string;
    readonly script: string | null;
    readonly npcLineAttempted: boolean;
  };
};

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

export async function getOrCreateScene(
  input: GetOrCreateSceneInput
): Promise<GetOrCreateSceneResult> {
  const { blueprint, state, directorSource, sceneScriptSource, npcLineSource } = input;

  // 如果已有当前场景，直接返回（cached provenance）
  if (state.narrative.currentScene !== null) {
    return {
      scene: state.narrative.currentScene,
      provenance: "cached",
    };
  }

  // 编排新场景
  const traceId = `narrative-${Date.now()}`;
  const result = await orchestrateNarrativeScene({
    traceId,
    blueprint,
    state,
    directorSource,
    sceneScriptSource,
    npcLineSource,
    logger: input.logger,
  });

  return {
    scene: result.scene,
    provenance: result.provenance,
    diagnostics: {
      director: JSON.stringify(result.diagnostics.director),
      script: result.diagnostics.script !== null ? JSON.stringify(result.diagnostics.script) : null,
      npcLineAttempted: result.diagnostics.npcLineAttempted,
    },
  };
}
