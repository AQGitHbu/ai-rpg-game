import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneActionMenu } from "./SceneActionMenu";
import type { SceneInteractionView, NpcDialogueView } from "@/game/application";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OBSERVE: SceneInteractionView = {
  kind: "observe",
  locationId: "loc_qingshi",
  label: "观察青石镇",
  slot: "center"
};

const INVESTIGATE: SceneInteractionView = {
  kind: "investigate",
  factId: "fact_notice",
  label: "调查缉凶告示",
  slot: "left"
};

const TAKE_ITEM: SceneInteractionView = {
  kind: "take_item",
  itemId: "item_key",
  label: "拾取锈铁钥匙",
  slot: "right"
};

const NPC: NpcDialogueView = {
  npcId: "npc_lu",
  name: "陆掌柜",
  role: "客栈掌柜",
  slot: "left",
  speechPages: ["陆掌柜擦着酒碗抬起头。"],
  choices: [],
  freeInputEnabled: false,
  reviewClues: [],
  preparingNextScene: false
};

describe("SceneActionMenu", () => {
  it("行动栏只显示当前真正可执行的类别，不显示未实现玩法", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <SceneActionMenu
        interactions={[OBSERVE]}
        dialogues={[]}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByRole("button", { name: "观察" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "交易" })).toBeNull();
    expect(screen.queryByRole("button", { name: "偷窃" })).toBeNull();
  });

  it("有 NPC 时显示人物入口", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <SceneActionMenu
        interactions={[]}
        dialogues={[NPC]}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByRole("button", { name: "人物" })).toBeEnabled();
  });

  it("有 investigate 时显示线索入口", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <SceneActionMenu
        interactions={[INVESTIGATE]}
        dialogues={[]}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByRole("button", { name: "线索" })).toBeEnabled();
  });

  it("有 take_item 时显示物品入口", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <SceneActionMenu
        interactions={[TAKE_ITEM]}
        dialogues={[]}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByRole("button", { name: "物品" })).toBeEnabled();
  });

  it("地图入口始终存在，点击触发 onReturnMap", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onReturnMap = vi.fn();
    render(
      <SceneActionMenu
        interactions={[]}
        dialogues={[]}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={onReturnMap}
        busy={false}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "地图" }));
    expect(onReturnMap).toHaveBeenCalledOnce();
  });

  it("没有行动的类别不渲染", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <SceneActionMenu
        interactions={[]}
        dialogues={[]}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    expect(screen.queryByRole("button", { name: "观察" })).toBeNull();
    expect(screen.queryByRole("button", { name: "线索" })).toBeNull();
    expect(screen.queryByRole("button", { name: "物品" })).toBeNull();
    expect(screen.queryByRole("button", { name: "人物" })).toBeNull();
    expect(screen.getByRole("button", { name: "地图" })).toBeInTheDocument();
  });

  it("busy 时行动按钮禁用但地图仍可点击", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <SceneActionMenu
        interactions={[OBSERVE]}
        dialogues={[NPC]}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy
      />
    );

    expect(screen.getByRole("button", { name: "观察" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "人物" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "地图" })).toBeEnabled();
  });
});
