import { describe, expect, it } from "vitest";
import { composeNpcCasualReply } from "./npcCasualReply";
import type { ScenarioBlueprint, GameState } from "@/game/domain";

function buildMinimalState(): GameState {
  return {
    stateVersion: 1 as const, generation: {} as never,
    player: { name: "P", identity: "H", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: "loc_1" as never,
    unlockedLocationIds: ["loc_1" as never], visitedLocationIds: ["loc_1" as never],
    npcs: [
      { npcId: "npc_1" as never, locationId: "loc_1" as never, met: true },
      { npcId: "npc_2" as never, locationId: "loc_1" as never, met: true },
      { npcId: "npc_3" as never, locationId: "loc_2" as never, met: true },
    ],
    quests: [], inventory: [], worldFacts: [], defeatedEnemyIds: [],
    battle: { status: "idle" }, ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    eventLedger: [],
  } as unknown as GameState;
}

describe("composeNpcCasualReply", () => {
  const blueprint = {
    npcs: [
      { id: "npc_1" as never, name: "铁匠", role: "铁匠", locationId: "loc_1" as never, knownFactIds: [] },
      { id: "npc_2" as never, name: "学者", role: "学者", locationId: "loc_1" as never, knownFactIds: [] },
      { id: "npc_3" as never, name: "卫兵", role: "卫兵", locationId: "loc_2" as never, knownFactIds: [] },
    ],
  } as unknown as ScenarioBlueprint;

  it("NPC 不在当前地点 → 空串", () => {
    const state = buildMinimalState();
    expect(composeNpcCasualReply(blueprint, state, "npc_3" as never, "你好")).toBe("");
  });

  it("铁匠角色 → 铁匠模板", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_1" as never, "今天天气真好");
    expect(reply).toContain("铁匠");
    expect(reply).toContain("笑了笑");
  });

  it("学者角色 → 学者模板", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_2" as never, "今天天气真好");
    expect(reply).toContain("学者");
    expect(reply).toContain("推了推眼镜");
  });

  it("问句末尾追加'我也不太清楚'", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_1" as never, "你吃饭了吗？");
    expect(reply).toContain("我也不太清楚");
  });

  it("短文本追加'嗯？'", () => {
    const state = buildMinimalState();
    const reply = composeNpcCasualReply(blueprint, state, "npc_1" as never, "嗨");
    expect(reply).toContain("嗯？");
  });
});
