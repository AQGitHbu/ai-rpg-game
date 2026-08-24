import type { NarrativeRuntimeState, NarrativeSceneState } from "./narrative";
import type { StoryState } from "./storyState";
import { asLocationId } from "./worldEntity";

export function createFixtureNarrativeScene(
  overrides: Partial<NarrativeSceneState> = {},
): NarrativeSceneState {
  return {
    sceneId: "fixture-scene",
    turn: 0,
    narration: "测试场景。",
    usedFactIds: [],
    npcLine: null,
    choices: [],
    source: "fixture",
    event: { kind: "observe", locationId: asLocationId("loc_0") },
    ...overrides,
  };
}

/** Explicit ready runtime for tests that only need a valid StoryState baseline. */
export function createFixtureNarrativeRuntimeState(
  scene: NarrativeSceneState = createFixtureNarrativeScene(),
): Extract<NarrativeRuntimeState, { readonly status: "ready" }> {
  return {
    status: "ready",
    mode: "offline",
    currentScene: scene,
    choiceRegistry: [],
  };
}

export type ReadyNarrativeRuntimeState = Extract<
  NarrativeRuntimeState,
  { readonly status: "ready" }
>;

export function readyNarrative(
  storyState: Pick<StoryState, "narrative">,
): ReadyNarrativeRuntimeState {
  if (storyState.narrative.status !== "ready") {
    throw new Error(`expected ready narrative, received ${storyState.narrative.status}`);
  }
  return storyState.narrative;
}

export function readyScene(
  storyState: Pick<StoryState, "narrative">,
): NarrativeSceneState {
  return readyNarrative(storyState).currentScene;
}
