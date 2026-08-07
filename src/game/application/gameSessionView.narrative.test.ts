import { describe, expect, it } from "vitest";
import { asNpcId, type GameState } from "@/game/domain";
import { projectGameSessionView } from "./gameSessionView";
import { runScenarioPipeline, TEST_GAME_ID } from "./applicationFixture.testutil";
import wuxiaFixture from "../../../data/fixtures/phase1/wuxia.json";

// ---------------------------------------------------------------------------
// Phase 14 场景一体化叙事循环：叙事生成状态投影测试。
// 独立于 gameSessionView.test.ts（该文件依赖 Phase 14 前的多地点/物品 fixture，
// 在 Phase 14 单地点 fallback 蓝图下模块级加载失败）。
// ---------------------------------------------------------------------------

type Phase1Fixture = { input: NewGameInput; seed: string };
const FIXTURE = wuxiaFixture as unknown as Phase1Fixture;
const PIPELINE = runScenarioPipeline({ ...FIXTURE.input, gameLength: "short" }, FIXTURE.seed);

import type { NewGameInput } from "@/game/domain";

function project(state: GameState, revision: number) {
  return projectGameSessionView({
    gameId: TEST_GAME_ID,
    blueprint: PIPELINE.blueprint,
    state,
    revision,
    worldName: "武侠",
  });
}

describe("projectNarrativeGenerationView：followup 桥接状态", () => {
  it("generation pending 时返回 pending，即使 currentScene 非空", () => {
    const stateWithFollowupAndPending: GameState = {
      ...PIPELINE.state,
      narrative: {
        currentScene: {
          sceneId: "scene-followup-1",
          turn: 2,
          narration: "陆掌柜沉吟片刻。",
          usedFactIds: [],
          npcLine: { npcId: asNpcId("npc_1"), text: "此事说来话长。", emotion: "neutral", usedFactIds: [] },
          choices: [
            { choiceToken: "t1", label: "请问一下目前状况是怎么样的？", actionKey: "a1", choiceKind: "dialogue_response", dialogueIntent: "intent_1" },
            { choiceToken: "t2", label: "是否可以告诉我事情的缘由？", actionKey: "a2", choiceKind: "dialogue_response", dialogueIntent: "intent_2" },
          ],
          source: "generated",
          event: { kind: "dialogue", focusNpcId: asNpcId("npc_1") },
          npcDialogues: [{ npcId: asNpcId("npc_1"), npcName: "陆掌柜", npcRole: "客栈掌柜", speechPages: ["此事说来话长。"] }],
        },
        generation: { status: "pending", requestedAt: "2026-08-06T00:00:00Z" },
        mode: "ai",
      },
    };
    const view = project(stateWithFollowupAndPending, 1);
    expect(view.narrativeGeneration.status).toBe("pending");
    expect(view.narrative).not.toBeNull();
  });

  it("generation idle 且 currentScene 非空时返回 ready", () => {
    const stateWithSceneIdle: GameState = {
      ...PIPELINE.state,
      narrative: {
        currentScene: {
          sceneId: "scene-1",
          turn: 1,
          narration: "你走进客栈。",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "观察", actionKey: "observe:loc_1" },
            { choiceToken: "c2", label: "离开", actionKey: "move:loc_2" },
          ],
          source: "generated",
          event: { kind: "observe", locationId: asNpcId("npc_1") as unknown as import("@/game/domain").LocationId },
        },
        generation: { status: "idle" },
        mode: "ai",
      },
    };
    const view = project(stateWithSceneIdle, 0);
    expect(view.narrativeGeneration.status).toBe("ready");
    expect(view.narrative).not.toBeNull();
  });

  it("generation pending 且 currentScene 为 null 时返回 pending", () => {
    const statePending: GameState = {
      ...PIPELINE.state,
      narrative: {
        currentScene: null,
        generation: { status: "pending", requestedAt: "2026-08-06T00:00:00Z" },
        mode: "ai",
      },
    };
    const view = project(statePending, 0);
    expect(view.narrativeGeneration.status).toBe("pending");
    expect(view.narrative).toBeNull();
  });
});

describe("projectNarrativeSceneView：choices 可空投影", () => {
  it("generation pending 时 currentScene 的 choices 投影为 null", () => {
    const stateWithFollowupAndPending: GameState = {
      ...PIPELINE.state,
      narrative: {
        currentScene: {
          sceneId: "scene-followup-1",
          turn: 2,
          narration: "陆掌柜沉吟片刻。",
          usedFactIds: [],
          npcLine: { npcId: asNpcId("npc_1"), text: "此事说来话长。", emotion: "neutral", usedFactIds: [] },
          choices: [
            { choiceToken: "t1", label: "请问一下目前状况是怎么样的？", actionKey: "a1", choiceKind: "dialogue_response", dialogueIntent: "intent_1" },
            { choiceToken: "t2", label: "是否可以告诉我事情的缘由？", actionKey: "a2", choiceKind: "dialogue_response", dialogueIntent: "intent_2" },
          ],
          source: "generated",
          event: { kind: "dialogue", focusNpcId: asNpcId("npc_1") },
          npcDialogues: [{ npcId: asNpcId("npc_1"), npcName: "陆掌柜", npcRole: "客栈掌柜", speechPages: ["此事说来话长。"] }],
        },
        generation: { status: "pending", requestedAt: "2026-08-06T00:00:00Z" },
        mode: "ai",
      },
    };
    const view = project(stateWithFollowupAndPending, 1);
    expect(view.narrative).not.toBeNull();
    expect(view.narrative!.choices).toBeNull();
  });

  it("generation idle 且 currentScene 非空时 choices 正常投影", () => {
    const stateWithSceneIdle: GameState = {
      ...PIPELINE.state,
      narrative: {
        currentScene: {
          sceneId: "scene-1",
          turn: 1,
          narration: "你走进客栈。",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "观察", actionKey: "observe:loc_1" },
            { choiceToken: "c2", label: "离开", actionKey: "move:loc_2" },
          ],
          source: "generated",
          event: { kind: "observe", locationId: asNpcId("npc_1") as unknown as import("@/game/domain").LocationId },
        },
        generation: { status: "idle" },
        mode: "ai",
      },
    };
    const view = project(stateWithSceneIdle, 0);
    expect(view.narrative).not.toBeNull();
    expect(view.narrative!.choices).not.toBeNull();
    expect(view.narrative!.choices!.length).toBe(2);
  });
});
