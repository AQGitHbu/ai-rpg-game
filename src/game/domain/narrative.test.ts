import { describe, expect, it } from "vitest";
import type { NarrativeSceneState } from "./narrative";

describe("NarrativeSceneState", () => {
  it("requires exactly two approved choices", () => {
    const scene = {
      sceneId: "scene-1",
      turn: 1,
      narration: "雨声压低了酒馆里的交谈。",
      usedFactIds: [],
      npcLine: null,
      choices: [
        { choiceToken: "scene-1:a", label: "询问掌柜", actionKey: "talk:npc_1" },
        { choiceToken: "scene-1:b", label: "检查角落", actionKey: "investigate:fact_1" }
      ],
      source: "generated"
    } satisfies NarrativeSceneState;
    expect(scene.choices).toHaveLength(2);
  });
});
