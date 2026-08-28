import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentGame: vi.fn(),
  executeHttpRequest: vi.fn(async (_method: string, _route: string, handler: () => Promise<Response>) => handler()),
}));

vi.mock("@/game/application/server/compositionRoot", () => ({
  getServerGameEntryPoints: () => mocks,
}));

import type { GameSessionView } from "@/game/application";
import { dynamic, GET } from "./route";

/**
 * 序列化边界夹具：一份完整的 canonical GameSessionView。
 * 组件单测/集成单测都直接构造 view 对象，绕过了 `JSON.stringify(result)`
 * 这条真实出口；这里刻意保留 npcs 的 relationshipTier 与 npcDialogues 的
 * 台词字段，验证它们能原样抵达浏览器（对话覆盖层徽标依赖该字段）。
 */
function buildActiveView(): GameSessionView {
  return {
    revision: 7,
    turnNumber: 8,
    gameType: "wuxia",
    setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
    player: { name: "侠客", identity: "剑客", hp: 90, attack: 10, defense: 5 },
    worldMap: {
      locations: [{ name: "客栈", current: true, visited: true, scale: "scene", travelChoice: null }],
    },
    currentLocation: {
      name: "客栈",
      description: "一间客栈",
      scale: "scene",
      actions: [{ choiceToken: "c_explore", label: "环顾四周", presentation: "explore" }],
      npcs: [
        {
          npcId: "npc_1",
          name: "薇拉",
          role: "酒保女儿",
          talkChoice: { choiceToken: "c_talk", label: "与薇拉交谈", presentation: "dialogue" },
          relationshipTier: "friendly",
        },
      ],
      town: null,
    },
    obtainableItems: [],
    inventory: [],
    story: {
      currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5,
      currentObjectiveLabel: null, currentObjectiveChoiceToken: null, currentObjectiveChoiceTokens: [],
    },
    narrative: {
      mode: "ai",
      hasScene: true,
      narration: "车轮印断续向北延伸。",
      choices: [],
      npcLine: null,
      npcDialogues: [{
        npcId: "npc_1",
        name: "薇拉",
        role: "酒保女儿",
        speechPages: ["最近来问井的事的人不少。"],
        choices: [
          { choiceToken: "c_answer_a", label: "追问井的事", presentation: "dialogue" },
          { choiceToken: "c_answer_b", label: "岔开话题", presentation: "dialogue" },
        ],
        freeInputEnabled: true,
        giveChoices: [{ itemName: "玉佩", choice: { choiceToken: "c_give", label: "给予玉佩", presentation: "item" } }],
      }],
    },
    narrativeGeneration: { status: "idle" },
    battle: null,
    quests: [],
    prologueShown: true,
    prologueText: "",
    ending: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentGame.mockResolvedValue({ ok: true, status: "active", revision: 7, view: buildActiveView() });
});

describe("GET /api/game/current", () => {
  it("is always dynamic because the current slot can change after a turn or restart", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("returns the latest current-game view through the canonical entry point", async () => {
    const response = await GET(new Request("http://localhost/api/game/current"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: "active", revision: 7, view: buildActiveView() });
    expect(mocks.getCurrentGame).toHaveBeenCalledOnce();
  });

  it("好感档位必须穿过 JSON 序列化抵达浏览器（对话覆盖层徽标的数据路径）", async () => {
    const response = await GET(new Request("http://localhost/api/game/current"));
    const body = await response.text();
    const parsed = JSON.parse(body) as { view: GameSessionView };

    // 序列化出口不做任何映射/收窄：徽标消费的 relationshipTier 原样下发。
    expect(parsed.view.currentLocation.npcs[0]?.relationshipTier).toBe("friendly");
    // 徽标文案所需的台词也一并到达。
    expect(parsed.view.narrative.npcDialogues[0]?.speechPages).toEqual(["最近来问井的事的人不少。"]);
    // 只给档位、绝不给数值：响应体内不得出现任何好感数字。
    expect(body).not.toMatch(/"relationship(?:Value|Score|Affinity)"\s*:/);
    expect(body).not.toMatch(/"affinity"\s*:/);
  });
});
