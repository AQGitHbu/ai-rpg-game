import type { SceneGenerationContext } from "./sceneGenerationContext";
import type { NarrativeSceneState } from "@/game/domain/narrative";
import type { EventCandidate } from "@/game/domain/candidateEvent";

/**
 * SceneGenerator 的事件提议（spec §7.4 newEvents）。
 * R4 后为结构化候选事件（含可执行 proposedEffects），由 SceneWriteBack 追加进池。
 */
export type EventProposal = EventCandidate;

/** SceneGenerator 调用结果（spec §7.3 ScenePackage 映射）。 */
export type SceneSourceResult = {
  readonly scene: NarrativeSceneState;
  readonly eventProposals: readonly EventProposal[];
  readonly source: "generated" | "fallback";
};

/** 可注入的叙事场景 source。离线 fixture 不调用 AI。 */
export type SceneSource = {
  generateScene(context: SceneGenerationContext): Promise<SceneSourceResult>;
};