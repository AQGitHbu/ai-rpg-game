import type { WorldState } from "@/game/domain/worldState";
import type { StoryState } from "@/game/domain/storyState";
import type { ResolvedEvent } from "@/game/domain/resolvedEvent";
import type { NarrativeSceneState } from "@/game/domain/narrative";

/** SceneGenerator 的可注入 AI source 接口（spec §7.1）。 */
export type SceneSourceContext = {
  readonly worldState: WorldState;
  readonly storyState: StoryState;
  readonly resolvedEvent: ResolvedEvent;
  /** 玩家原话（若有），供叙事引用（spec §7.1 utterance）。 */
  readonly utterance?: string;
};

/** SceneGenerator 的事件提议（spec §7.4 newEvents）。 */
export type EventProposal = {
  readonly id: string;
  readonly description: string;
  readonly proposedAtTurn: number;
};

/** SceneGenerator 调用结果（spec §7.3 ScenePackage 映射）。 */
export type SceneSourceResult = {
  readonly scene: NarrativeSceneState;
  readonly eventProposals: readonly EventProposal[];
  readonly source: "generated" | "fallback";
};

/** 可注入的叙事场景 source。离线 fixture 不调用 AI。 */
export type SceneSource = {
  generateScene(context: SceneSourceContext): Promise<SceneSourceResult>;
};
