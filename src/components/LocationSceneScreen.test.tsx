import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { LocationSceneScreen } from "./LocationSceneScreen";

/** 回归夹具：历史 view 仍可能带 investigate presentation，但地点页不再渲染它。 */
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

describe("LocationSceneScreen：调查和底部行动栏已移除", () => {
  it("does not render investigation buttons or the bottom action rail", () => {
    render(<LocationSceneScreen view={viewWithInvestigationApproaches()} busy={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "沿痕迹追查" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "翻查附近杂物" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "行动栏" })).not.toBeInTheDocument();
  });

  it("renders the sole AI boundary-preparation action so a completed act cannot dead-end", () => {
    const onSubmit = vi.fn();
    const view: GameSessionView = {
      ...viewWithInvestigationApproaches(),
      currentLocation: {
        ...viewWithInvestigationApproaches().currentLocation,
        actions: [{ choiceToken: "c_boundary", label: "继续追查下一幕线索", presentation: "explore" }],
      },
      story: {
        ...viewWithInvestigationApproaches().story,
        currentObjectiveLabel: null,
        currentObjectiveChoiceToken: null,
        currentObjectiveChoiceTokens: [],
      },
      narrative: {
        ...viewWithInvestigationApproaches().narrative,
        mode: "ai",
      },
    };

    render(<LocationSceneScreen view={view} busy={false} onSubmit={onSubmit} onReturnMap={vi.fn()} />);

    const button = screen.getByRole("button", { name: "继续追查下一幕线索" });
    fireEvent.click(button);
    expect(onSubmit).toHaveBeenCalledWith({ kind: "fixed_choice", choiceToken: "c_boundary" });
  });

  it("renders the rule-owned battle start action without exposing general action clutter", () => {
    const onSubmit = vi.fn();
    const view: GameSessionView = {
      ...viewWithInvestigationApproaches(),
      currentLocation: {
        ...viewWithInvestigationApproaches().currentLocation,
        actions: [{ choiceToken: "c_battle", label: "挑战黑衣夜行者", presentation: "battle" }],
      },
      story: {
        ...viewWithInvestigationApproaches().story,
        currentObjectiveLabel: "击败黑衣夜行者",
        currentObjectiveChoiceToken: "c_battle",
        currentObjectiveChoiceTokens: ["c_battle"],
      },
    };

    render(<LocationSceneScreen view={view} busy={false} onSubmit={onSubmit} onReturnMap={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "挑战黑衣夜行者" }));
    expect(onSubmit).toHaveBeenCalledWith({ kind: "fixed_choice", choiceToken: "c_battle" });
    expect(screen.queryByRole("button", { name: "沿痕迹追查" })).not.toBeInTheDocument();
  });

  it("hides the next-act explore action when a pre-generated formal dialogue pair is ready", () => {
    const base = viewWithInvestigationApproaches();
    const view: GameSessionView = {
      ...base,
      currentLocation: {
        ...base.currentLocation,
        actions: [{ choiceToken: "c_boundary", label: "继续追查下一幕线索", presentation: "explore" }],
      },
      narrative: {
        ...base.narrative,
        npcDialogues: [{
          npcId: "npc_1", name: "线人", role: "镖局旧人", speechPages: ["我有话要说。"],
          choices: [
            { choiceToken: "c_dialogue_1", label: "追问线索", presentation: "dialogue" },
            { choiceToken: "c_dialogue_2", label: "先表明来意", presentation: "dialogue" },
          ],
          freeInputEnabled: true,
          giveChoices: [],
        }],
      },
    };

    render(<LocationSceneScreen view={view} busy={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "继续追查下一幕线索" })).not.toBeInTheDocument();
  });
});

const SIDE_NOTE = "夜色如墨，窗外风声呜咽，远处矿洞方向隐约传来铁器碰撞的声响。";
const LOCATION_DESCRIPTION = "废弃猎户小屋，木墙斑驳，窗外风声呜咽，远处隐约传来矿洞方向的动静。";

describe("LocationSceneScreen：地点旁注与地点描述不重复复述", () => {
  function renderWithNarration(narration: string) {
    const base = viewWithInvestigationApproaches();
    const view: GameSessionView = {
      ...base,
      currentLocation: { ...base.currentLocation, description: LOCATION_DESCRIPTION },
      narrative: { ...base.narrative, narration },
    };
    return render(<LocationSceneScreen view={view} busy={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />)
      .container.querySelector(".location-scene-caption")?.textContent ?? "";
  }

  it("旁注已经复述过的氛围小句不再出现在左下角描述里", () => {
    expect(renderWithNarration(SIDE_NOTE)).toBe("废弃猎户小屋，木墙斑驳。");
  });

  it("没有旁注时完整保留地点描述", () => {
    expect(renderWithNarration("")).toBe(LOCATION_DESCRIPTION);
  });
});
