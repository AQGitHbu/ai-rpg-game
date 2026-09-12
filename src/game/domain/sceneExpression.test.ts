import { describe, expect, it } from "vitest";
import { parseSceneExpressionProposal, type SceneExpressionProposal } from "./sceneExpression";

describe("scene expressions", () => {
  it("parses an ordered narration and NPC line without inventing a second body", () => {
    const expressions: readonly SceneExpressionProposal[] = [
      {
        kind: "narration",
        beatId: "arrival",
        text: "雨幕中的破庙显出一线灯火。",
        referencedEntityIds: ["location_temple"],
      },
      {
        kind: "npc_line",
        npcId: "npc_messenger",
        audienceIds: ["player_0"],
        text: "信筒只能交给渡口的接应人。",
        emotion: "guarded",
        answeredBeatIds: ["arrival"],
        usedFactIds: ["fact_letter"],
        usedEventIds: ["turn-1:letter_received"],
      },
    ];

    const result = parseSceneExpressionProposal(expressions);

    expect(result).toEqual({ ok: true, expressions });
  });

  it("rejects unknown fields instead of accepting an alternate text channel", () => {
    const result = parseSceneExpressionProposal([{
      kind: "narration",
      beatId: "arrival",
      text: "正文",
      referencedEntityIds: [],
      segments: ["偷偷追加的正文"],
    }]);

    expect(result).toEqual({
      ok: false,
      code: "INVALID_SCENE_EXPRESSIONS",
      path: "expressions[0]",
    });
  });
});
