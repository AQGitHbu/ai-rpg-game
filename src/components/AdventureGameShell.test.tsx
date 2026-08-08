import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: "打开角色面板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "背包" })).toBeInTheDocument();
  });

  it("场景生成 pending 时保留当前地图/场景，并在 ready 后解除模态", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const base = buildSessionViewFixture();
    const pendingView = {
      ...base,
      narrativeGeneration: {
        status: "pending" as const,
        progress: { completedCalls: 1, totalCalls: 3 as const, currentRole: "writer" as const, attempt: 1 }
      }
    };
    const readyView = {
      ...base,
      narrativeGeneration: { status: "ready" as const }
    };
    const user = userEvent.setup();
    const { rerender, props } = renderShell({ view: pendingView });

    expect(screen.getByRole("dialog", { name: "正在准备场景" })).toBeInTheDocument();
    expect(screen.getByText("正在调用 AI 生成下一段剧情，请稍候…"))
      .toBeInTheDocument();
    expect(screen.getByText(/已完成 1 \/ 3 个阶段，当前编剧第1次尝试/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));

    expect(screen.getByRole("region", { name: "地点场景：青石镇" })).toBeInTheDocument();
    expect(screen.getByText("镇口贴着一张字迹潦草的缉凶告示。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "陆掌柜，客栈掌柜" })).toBeInTheDocument();

    rerender(<AdventureGameShell {...props} view={readyView} />);

    expect(screen.queryByRole("dialog", { name: "正在准备场景" })).toBeNull();
    expect(screen.getByRole("region", { name: "地点场景：青石镇" })).toBeInTheDocument();
  });

  it("轻量事件旁白条可通过关闭按钮主动关闭", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const base = buildSessionViewFixture();
    const worldEventView = {
      ...base,
      narrativeGeneration: { status: "ready" as const },
      narrative: {
        narration: "雨夜，客栈大门被人一脚踹开，一名蒙面人闯了进来。",
        npcLine: null,
        eventKind: "observe" as const,
        choices: [
          { label: "上前盘问", choiceToken: "event:a" },
          { label: "按兵不动", choiceToken: "event:b" },
        ] as const,
        npcDialogues: [],
      },
    };
    const user = userEvent.setup();
    const { rerender, props } = renderShell({ view: worldEventView });

    // 进入场景层才能看到 SceneNarrationBar。
    await user.click(screen.getByRole("button", { name: "进入青石镇" }));

    // 初始：旁白条可见。
    expect(screen.getByText("雨夜，客栈大门被人一脚踹开，一名蒙面人闯了进来。")).toBeInTheDocument();

    // 点击关闭按钮后旁白条消失。
    await user.click(screen.getByRole("button", { name: "关闭旁白" }));
    expect(screen.queryByText("雨夜，客栈大门被人一脚踹开，一名蒙面人闯了进来。")).toBeNull();

    // 同一事件视图下重新渲染仍保持关闭。
    rerender(<AdventureGameShell {...props} view={worldEventView} />);
    expect(screen.queryByText("雨夜，客栈大门被人一脚踹开，一名蒙面人闯了进来。")).toBeNull();
  });

  it("旅行事件全屏旁白点击后完成并进入场景", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const base = buildSessionViewFixture();
    const worldEventView = {
      ...base,
      narrativeGeneration: { status: "ready" as const },
      narrative: {
        narration: "驿道尽头浮现一支火把队伍。",
        npcLine: null,
        eventKind: "travel" as const,
        choices: [
          { label: "迎上前去", choiceToken: "event:a" },
          { label: "隐入道旁", choiceToken: "event:b" },
        ] as const,
        npcDialogues: [],
      },
    };
    const user = userEvent.setup();
    renderShell({ view: worldEventView });

    // 旅行事件全屏旁白可见。
    expect(screen.getByRole("dialog", { name: "旅行旁白" })).toBeInTheDocument();
    // 第一次点击跳过逐字动画。
    await user.click(screen.getByRole("dialog", { name: "旅行旁白" }));
    // 第二次点击完成旁白。
    await user.click(screen.getByRole("dialog", { name: "旅行旁白" }));
    expect(screen.queryByRole("dialog", { name: "旅行旁白" })).toBeNull();
  });

  it("叙事选项提交 pending 时独占场景，不与上一幕 NPC 对话叠加", async () => {
    const base = buildSessionViewFixture();
    const readyView = {
      ...base,
      narrativeGeneration: { status: "ready" as const },
      dialogues: base.dialogues.map((dialogue, index) =>
        index === 0
          ? {
              ...dialogue,
              choices: [{ label: "查问后院", choiceToken: "choice:backyard" }]
            }
          : dialogue
      )
    };
    const pendingView = {
      ...readyView,
      revision: readyView.revision + 1,
      narrativeGeneration: { status: "pending" as const }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          view: pendingView,
          feedback: { ok: true, message: "选择已记录。" }
        })
      )
    );
    const onViewChange = vi.fn();
    const user = userEvent.setup();
    const { rerender, props } = renderShell({ view: readyView, onViewChange });

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));
    await user.click(screen.getByRole("button", { name: "陆掌柜，客栈掌柜" }));
    await user.click(screen.getByRole("button", { name: "1. 查问后院" }));

    await waitFor(() => expect(onViewChange).toHaveBeenCalledWith(pendingView));
    rerender(<AdventureGameShell {...props} view={pendingView} />);

    expect(screen.queryByRole("dialog", { name: "与陆掌柜对话" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "正在准备场景" })).toBeInTheDocument();
    expect(screen.getByText("正在调用 AI 生成下一段剧情，请稍候…"))
      .toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "与陆掌柜对话" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "正在准备场景" })).toBeInTheDocument();

    rerender(<AdventureGameShell {...props} view={readyView} />);
    expect(screen.queryByRole("dialog", { name: "与陆掌柜对话" })).toBeNull();
  });

  it("已生成 AI 剧情仍以地图为入口；进入地点后才显示场景（含 NPC 热点）", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const base = buildSessionViewFixture();
    // 模拟 Phase 14 后已经完成 AI 场景生成：narrative.currentScene 已就绪，
    // 但玩家必须先点"进入"才能离开地图层进入 LocationSceneScreen。
    const view = {
      ...base,
      narrativeGeneration: { status: "ready" as const },
      narrative: {
        narration: "客栈的灯火在雨幕里摇曳。",
        npcLine: null,
        choices: [
          { label: "推门进入客栈", choiceToken: "scene:a" },
          { label: "先查看告示", choiceToken: "scene:b" },
        ] as const,
        npcDialogues: [],
      },
    };
    const user = userEvent.setup();
    renderShell({ view });

    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeVisible();
    expect(screen.queryByText("镇口贴着一张字迹潦草的缉凶告示。")).toBeNull();

    await user.click(screen.getByRole("button", { name: "进入青石镇" }));
    // 地点场景层是 LocationSceneScreen：场景描述作为 caption 出现；
    // AI 剧情已就绪，但场景本身（背景图 / 互动 / NPC 热点）才是玩家首先看到的内容。
    expect(screen.getByText("镇口贴着一张字迹潦草的缉凶告示。")).toBeVisible();
    expect(screen.getByRole("button", { name: /陆掌柜.*客栈掌柜/ })).toBeVisible();
    // 场景返回地图使用 SceneActionMenu 中的"地图"按钮（不再走 NarrativeScenePanel）。
    expect(screen.queryByRole("button", { name: "返回地图" })).toBeNull();
    expect(screen.getByRole("button", { name: "地图" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "地图" }));
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeVisible();
  });

  it("对白场景 ready 后不自动弹窗，必须进入地点再点击 NPC 热点", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const base = buildSessionViewFixture();
    const view = {
      ...base,
      narrativeGeneration: { status: "ready" as const },
      narrative: {
        narration: "陆掌柜放下酒碗，等着你的问题。",
        npcLine: null,
        eventKind: "dialogue" as const,
        choices: [
          { label: "请问一下目前状况是怎么样的？", choiceToken: "dialogue:a" },
          { label: "是否可以告诉我事情的缘由？", choiceToken: "dialogue:b" },
        ] as const,
        npcDialogues: [],
      },
      dialogues: base.dialogues.map((dialogue, index) => index === 0
        ? {
            ...dialogue,
            choices: [
              { label: "请问一下目前状况是怎么样的？", choiceToken: "dialogue:a" },
              { label: "是否可以告诉我事情的缘由？", choiceToken: "dialogue:b" },
            ],
          }
        : dialogue),
    };
    const user = userEvent.setup();
    renderShell({ view });

    expect(screen.queryByRole("dialog", { name: "与陆掌柜对话" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "进入青石镇" }));
    expect(screen.queryByRole("dialog", { name: "与陆掌柜对话" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "陆掌柜，客栈掌柜" }));
    expect(screen.getByRole("dialog", { name: "与陆掌柜对话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "1. 请问一下目前状况是怎么样的？" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2. 是否可以告诉我事情的缘由？" })).toBeInTheDocument();
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

  it("点击左上角头像打开角色弹层，关闭后焦点回到头像", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const user = userEvent.setup();
    renderShell();

    const avatar = screen.getByRole("button", { name: "打开角色面板" });
    await user.click(avatar);
    expect(screen.getByRole("dialog", { name: "角色" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(avatar).toHaveFocus();
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

  describe("统一 toast 通知", () => {
    it("连续成功行动叠加显示多条 toast", async () => {
      const movedView = buildMovedSessionViewFixture();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({ view: movedView, feedback: { ok: true, message: "你来到了城外官道。" } })
        )
        .mockResolvedValueOnce(
          jsonResponse({ view: movedView, feedback: { ok: true, message: "你再次踏上了官道。" } })
        );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      renderShell({ onViewChange: vi.fn() });

      await user.click(screen.getByRole("button", { name: "前往城外官道" }));
      await screen.findByText("你来到了城外官道。");

      await user.click(screen.getByRole("button", { name: "地图" }));
      await user.click(screen.getByRole("button", { name: "前往城外官道" }));
      await screen.findByText("你再次踏上了官道。");

      expect(screen.getByText("你来到了城外官道。")).toBeInTheDocument();
      expect(document.querySelectorAll(".adventure-toast")).toHaveLength(2);
    });

    it("toast 退场动画结束后自动移除", async () => {
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
      const toast = await screen.findByText("你来到了城外官道。");

      const exitAnimationEnd = new Event("animationend", { bubbles: true });
      Object.assign(exitAnimationEnd, { animationName: "adventure-toast-exit" });
      fireEvent(toast, exitAnimationEnd);

      expect(screen.queryByText("你来到了城外官道。")).toBeNull();
    });
  });

  describe("NPC 自由对话", () => {
    async function openLuDialogue(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await user.click(screen.getByRole("button", { name: "进入青石镇" }));
      // 场景行动菜单的“人物”按钮打开 dialogues[0]（陆掌柜）的对话面板。
      await user.click(screen.getByRole("button", { name: "人物" }));
    }

    it("闲聊结果：提交精确 payload 到对话端点，面板显示 NPC 回应，不上报新 view", async () => {
      let submittedRequest: RequestInit | undefined;
      const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
        submittedRequest = init;
        return jsonResponse({
          kind: "chat",
          npcSpeech: "陆掌柜笑了笑：雨夜路滑，客官早些歇息。",
          view: buildSessionViewFixture()
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const onViewChange = vi.fn();
      const onBusyChange = vi.fn();
      const user = userEvent.setup();
      renderShell({ onViewChange, onBusyChange });

      await openLuDialogue(user);
      await user.type(screen.getByPlaceholderText("请输入你的话..."), "今天生意如何？");
      await user.click(screen.getByRole("button", { name: "发送" }));

      expect(
        await screen.findByText("陆掌柜笑了笑：雨夜路滑，客官早些歇息。")
      ).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/game/npc/dialogue",
        expect.objectContaining({ method: "POST" })
      );
      expect(JSON.parse(String(submittedRequest?.body))).toEqual({
        npcId: "npc_lu",
        text: "今天生意如何？",
        revision: 0
      });
      // 闲聊零写入：不切换全局 view，对话面板保持打开。
      expect(onViewChange).not.toHaveBeenCalled();
      expect(onBusyChange).toHaveBeenNthCalledWith(1, true);
      expect(onBusyChange).toHaveBeenLastCalledWith(false);
    });

    it("叙事触发：上报 pending view 以便 CurrentGameScreen 自动轮询", async () => {
      const pendingView = {
        ...buildSessionViewFixture(),
        narrativeGeneration: { status: "pending" as const }
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse({ kind: "narrative_trigger", view: pendingView }))
      );
      const onViewChange = vi.fn();
      const user = userEvent.setup();
      renderShell({ onViewChange });

      await openLuDialogue(user);
      await user.type(screen.getByPlaceholderText("请输入你的话..."), "带我去看看后院");
      await user.click(screen.getByRole("button", { name: "发送" }));

      await waitFor(() => expect(onViewChange).toHaveBeenCalledWith(pendingView));
    });

    it("网络异常：面板显示兜底闲聊回应，不伪造叙事触发", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => {
        throw new Error("network down");
      }));
      const onViewChange = vi.fn();
      const user = userEvent.setup();
      renderShell({ onViewChange });

      await openLuDialogue(user);
      await user.type(screen.getByPlaceholderText("请输入你的话..."), "你听得见吗？");
      await user.click(screen.getByRole("button", { name: "发送" }));

      expect(await screen.findByText("（对方似乎没听清。）")).toBeInTheDocument();
      expect(onViewChange).not.toHaveBeenCalled();
    });
  });
});
