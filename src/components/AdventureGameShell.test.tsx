import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdventureGameShell } from "./AdventureGameShell";
import {
  buildMovedSessionViewFixture,
  buildSessionViewFixture
} from "./sessionViewFixture.testutil";

type FakeResponse = { json: () => Promise<unknown> };

function jsonResponse(body: unknown): FakeResponse {
  return { json: async () => body };
}

function renderShell(overrides?: {
  view?: ReturnType<typeof buildSessionViewFixture>;
  onBusyChange?: ReturnType<typeof vi.fn>;
  onViewChange?: ReturnType<typeof vi.fn>;
  onStaleRevision?: ReturnType<typeof vi.fn>;
  developmentTools?: boolean;
  onClearDevelopmentSave?: ReturnType<typeof vi.fn>;
}) {
  const props = {
    view: overrides?.view ?? buildSessionViewFixture(),
    busy: false,
    onBusyChange: overrides?.onBusyChange ?? vi.fn(),
    onViewChange: overrides?.onViewChange ?? vi.fn(),
    onStaleRevision: overrides?.onStaleRevision ?? vi.fn(),
    developmentTools: overrides?.developmentTools ?? false,
    onClearDevelopmentSave: overrides?.onClearDevelopmentSave ?? vi.fn()
  };
  return { ...render(<AdventureGameShell {...props} />), props };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdventureGameShell", () => {
  it("首次 active view 显示 HUD 与世界地图", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderShell();

    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "角色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "背包" })).toBeInTheDocument();
  });

  describe("开发工具入口", () => {
    it("developmentTools=false：右上角不显示“开发工具”入口", () => {
      vi.stubGlobal("fetch", vi.fn());
      renderShell();

      expect(screen.queryByRole("button", { name: "开发工具" })).toBeNull();
    });

    it("developmentTools=true：点击“开发工具”弹出提示与清除按钮，并触发清档回调", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const onClearDevelopmentSave = vi.fn();
      const user = userEvent.setup();
      renderShell({ developmentTools: true, onClearDevelopmentSave });

      await user.click(screen.getByRole("button", { name: "开发工具" }));

      const dialog = screen.getByRole("dialog");
      expect(dialog).toBeInTheDocument();
      expect(
        screen.getByText("仅清除当前本地试玩存档；不会删除数据库文件或其它项目数据。")
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "清除本地试玩存档" }));
      expect(onClearDevelopmentSave).toHaveBeenCalledTimes(1);
    });

    it("开发工具弹窗可通过关闭按钮收起", async () => {
      vi.stubGlobal("fetch", vi.fn());
      const user = userEvent.setup();
      renderShell({ developmentTools: true, onClearDevelopmentSave: vi.fn() });

      await user.click(screen.getByRole("button", { name: "开发工具" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "关闭开发工具" }));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("HUD 打开背包弹层，关闭后回到触发按钮", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderShell();

    const inventory = screen.getByRole("button", { name: "背包" });
    await user.click(inventory);
    expect(screen.getByRole("dialog", { name: "背包" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(inventory).toHaveFocus();
  });

  it("进入当前地点只做本地 map → scene 切换：零请求、view 不变", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onViewChange = vi.fn();
    const user = userEvent.setup();
    renderShell({ onViewChange });

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));

    expect(screen.getByText("镇口贴着一张字迹潦草的缉凶告示。")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("返回地图同样是本地切换，零请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));
    await user.click(screen.getByRole("button", { name: "地图" }));

    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("移动成功：提交精确 move payload、上报最新 view 并自动切换到地点场景", async () => {
    const movedView = buildMovedSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      submittedRequest = init;
      return jsonResponse({ view: movedView, feedback: { ok: true, message: "你来到了城外官道。" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onViewChange = vi.fn();
    const onBusyChange = vi.fn();
    const user = userEvent.setup();
    const { rerender, props } = renderShell({ onViewChange, onBusyChange });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    await waitFor(() => expect(onViewChange).toHaveBeenCalledWith(movedView));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game/actions",
      expect.objectContaining({ method: "POST" })
    );
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "move", locationId: "loc_guandao" },
      revision: 0
    });
    expect(onBusyChange).toHaveBeenNthCalledWith(1, true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);

    rerender(<AdventureGameShell {...props} view={movedView} />);
    expect(screen.getByText("黄土道上车辙纵横，隐约可见几处暗色血迹。")).toBeInTheDocument();
  });

  it("移动被规则拒绝：留在地图并显示反馈，不上报新 view", async () => {
    const view = buildSessionViewFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: "ACTION_REJECTED",
          view,
          feedback: { ok: false, message: "那条路尚未打通。" }
        })
      )
    );
    const onViewChange = vi.fn();
    const user = userEvent.setup();
    renderShell({ view, onViewChange });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    expect(await screen.findByRole("status")).toHaveTextContent("那条路尚未打通。");
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it("revision 冲突：只触发 onStaleRevision，不上报新 view、不切换场景", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ code: "STALE_GAME_REVISION" })));
    const onViewChange = vi.fn();
    const onStaleRevision = vi.fn();
    const user = userEvent.setup();
    renderShell({ onViewChange, onStaleRevision });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    await waitFor(() => expect(onStaleRevision).toHaveBeenCalledTimes(1));
    expect(onViewChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
  });

  it("网络异常：显示错误、留在地图，绝不伪造移动成功", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const onViewChange = vi.fn();
    const onStaleRevision = vi.fn();
    const user = userEvent.setup();
    renderShell({ onViewChange, onStaleRevision });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "网络异常，请检查连接后重试。"
    );
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(onViewChange).not.toHaveBeenCalled();
    expect(onStaleRevision).not.toHaveBeenCalled();
  });

  it("进入地点后显示 HUD 场景标题，返回地图后隐藏", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByText("青石镇", { selector: ".adventure-hud-location-title" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "进入青石镇" }));
    expect(screen.getByText("青石镇", { selector: ".adventure-hud-location-title" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "地图" }));
    expect(screen.queryByText("青石镇", { selector: ".adventure-hud-location-title" })).toBeNull();
  });

  it("成功行动用 toast 显示反馈", async () => {
    const movedView = buildMovedSessionViewFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ view: movedView, feedback: { ok: true, message: "你来到了城外官道。" } })
      )
    );
    const user = userEvent.setup();
    renderShell({ onViewChange: vi.fn() });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    const toast = await screen.findByRole("status");
    expect(toast).toHaveTextContent("你来到了城外官道。");
    expect(toast).toHaveClass("adventure-toast");
  });
});
