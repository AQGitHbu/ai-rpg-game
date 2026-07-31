import { describe, expect, it } from "vitest";
import type { NarrativeSceneState, PlayerNpcChatState } from "./narrative";

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

describe("PlayerNpcChatState 类型", () => {
  it("正确构造", () => {
    const chat: PlayerNpcChatState = { npcId: "npc_1" as never, playerText: "你好", npcName: "铁匠", npcRole: "铁匠铺老板" };
    expect(chat.npcId).toBe("npc_1");
    expect(chat.playerText).toBe("你好");
  });
  it("pending 状态可携带 playerNpcChat", () => {
    const gen: { readonly status: "pending"; readonly requestedAt: string; readonly playerNpcChat?: PlayerNpcChatState } = {
      status: "pending", requestedAt: "2026-01-01T00:00:00Z",
      playerNpcChat: { npcId: "npc_1" as never, playerText: "测试", npcName: "铁匠", npcRole: "铁匠铺老板" }
    };
    expect(gen.status).toBe("pending");
    expect(gen.playerNpcChat?.playerText).toBe("测试");
  });
  it("pending 状态可不携带 playerNpcChat（兼容旧存档）", () => {
    const gen: { readonly status: "pending"; readonly requestedAt: string; readonly playerNpcChat?: PlayerNpcChatState } = {
      status: "pending", requestedAt: "2026-01-01T00:00:00Z"
    };
    expect(gen.playerNpcChat).toBeUndefined();
  });
});
