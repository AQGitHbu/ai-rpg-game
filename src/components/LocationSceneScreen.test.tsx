import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { LocationSceneScreen } from "./LocationSceneScreen";

/** Task 5：当前目标为 discover_fact 且两个调查方法都已投影为 opaque token。 */
function viewWithInvestigationApproaches(): GameSessionView {
  return {
    revision: 9,
    turnNumber: 8,
    gameType: "wuxia",
    setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
    player: { name: "侠客", identity: "剑客", hp: 90, attack: 10, defense: 5 },
    worldMap: {
      locations: [
        { name: "客栈", current: true, visited: true, scale: "scene", travelChoice: null },
      ],
    },
    currentLocation: {
      name: "客栈", description: "一间客栈", scale: "scene",
      actions: [
        { choiceToken: "c_follow", label: "沿痕迹追查", presentation: "investigate" },
        { choiceToken: "c_search", label: "翻查附近杂物", presentation: "investigate" },
      ],
      npcs: [],
      town: null,
    },
    obtainableItems: [],
    inventory: [],
    story: {
      currentAct: 1, targetActs: 3, tension: 30, pacingNeed: "reveal", storyProgress: 5,
      currentObjectiveLabel: "调查酒楼后巷的车轮印",
      currentObjectiveChoiceToken: "c_follow",
      currentObjectiveChoiceTokens: ["c_follow", "c_search"],
    },
    narrative: {
      mode: "offline", hasScene: true, narration: "车轮印断续向北延伸。", choices: [], npcLine: null, npcDialogues: [],
    },
    narrativeGeneration: { status: "idle" },
    battle: null,
    quests: [{ name: "追查车轮印", description: "查明去向", kind: "main", status: "active", objectives: [{ label: "调查酒楼后巷的车轮印", completed: false }] }],
    prologueShown: true,
    prologueText: "",
    ending: null,
  };
}

describe("LocationSceneScreen（Task 5：调查方法按钮）", () => {
  it("renders two investigation methods as separate action buttons", async () => {
    render(<LocationSceneScreen view={viewWithInvestigationApproaches()} busy={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />);
    expect(screen.getByRole("button", { name: "沿痕迹追查" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "翻查附近杂物" })).toBeInTheDocument();
  });
});