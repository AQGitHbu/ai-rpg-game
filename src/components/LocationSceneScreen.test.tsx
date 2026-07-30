import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocationSceneScreen } from "./LocationSceneScreen";
import { buildSessionViewFixture } from "./sessionViewFixture.testutil";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocationSceneScreen", () => {
  it("渲染地点描述和观察热点，视窗保留可访问名称", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <LocationSceneScreen
        view={buildSessionViewFixture()}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    expect(screen.getByLabelText("地点场景：青石镇")).toBeInTheDocument();
    expect(screen.getByText("镇口贴着一张字迹潦草的缉凶告示。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "观察青石镇" })).toBeInTheDocument();
  });

  it("观察热点点击触发 onAction 携带精确 intent", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onAction = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationSceneScreen
        view={buildSessionViewFixture()}
        onAction={onAction}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "观察青石镇" }));
    expect(onAction).toHaveBeenCalledWith({ type: "observe", locationId: "loc_qingshi" });
  });

  it("调查热点点击触发 onAction 携带 factId", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onAction = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationSceneScreen
        view={buildSessionViewFixture()}
        onAction={onAction}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "调查缉凶告示" }));
    expect(onAction).toHaveBeenCalledWith({ type: "investigate", factId: "fact_notice" });
  });

  it("拾取热点点击触发 onAction 携带 itemId", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onAction = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationSceneScreen
        view={buildSessionViewFixture()}
        onAction={onAction}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "拾取锈铁钥匙" }));
    expect(onAction).toHaveBeenCalledWith({ type: "take_item", itemId: "item_key" });
  });

  it("NPC 热点点击触发 onOpenDialogue 携带 npcId", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const onOpenDialogue = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationSceneScreen
        view={buildSessionViewFixture()}
        onAction={vi.fn()}
        onOpenDialogue={onOpenDialogue}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "陆掌柜，客栈掌柜" }));
    expect(onOpenDialogue).toHaveBeenCalledWith("npc_lu");
  });

  it("返回地图触发 onReturnMap，零 fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onReturnMap = vi.fn();
    const user = userEvent.setup();

    render(
      <LocationSceneScreen
        view={buildSessionViewFixture()}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={onReturnMap}
        busy={false}
      />
    );

    await user.click(screen.getByRole("button", { name: "地图" }));
    expect(onReturnMap).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("busy 时全部行动按钮禁用", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(
      <LocationSceneScreen
        view={buildSessionViewFixture()}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy
      />
    );

    const buttons = screen.getAllByRole("button");
    for (const button of buttons) {
      if (button.textContent !== "地图") {
        expect(button).toBeDisabled();
      }
    }
  });

  it("所有互动热点都是 button（键盘可达）", () => {
    vi.stubGlobal("fetch", vi.fn());
    const view = buildSessionViewFixture();
    render(
      <LocationSceneScreen
        view={view}
        onAction={vi.fn()}
        onOpenDialogue={vi.fn()}
        onReturnMap={vi.fn()}
        busy={false}
      />
    );

    const interactionCount = view.locationScene.interactions.length;
    const npcCount = view.dialogues.length;
    // hotspot buttons + action rail (人物 + 观察 + 线索 + 物品 + 地图)
    const actionRailCount = 5;
    expect(screen.getAllByRole("button").length).toBe(interactionCount + npcCount + actionRailCount);
  });
});
