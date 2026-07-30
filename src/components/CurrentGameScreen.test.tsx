import { render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentGameScreen } from "./CurrentGameScreen";
import {
  buildItemTakenSessionViewFixture,
  buildMovedSessionViewFixture,
  buildSessionViewFixture,
  buildBattleSessionViewFixture,
  buildSuccessEndingSessionViewFixture,
  buildFailureEndingSessionViewFixture
} from "./sessionViewFixture.testutil";

// ---------------------------------------------------------------------------
// Phase 7 Task 7：根页面客户端协调器测试。
// 挂载时读取 /api/game/current：none → 创建表单；active → 地图优先游戏壳
//（世界地图 → 地点场景 → NPC 对话 → 返回地图）；corrupt → 按 reason 分支的
// 可恢复提示。battle/ending 仍渲染既有面板。fetch 全程打桩。
// ---------------------------------------------------------------------------

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };

function jsonResponse(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function stubFetch(implementation: (input: unknown, init?: RequestInit) => Promise<FakeResponse>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const FALLBACK_NOTICE = "已使用稳定模板完成开局，仍可完整游玩。";

async function fillAndSubmitSetupForm(user: UserEvent) {
  await screen.findByText("选择游戏类型");
  await user.type(screen.getByLabelText("角色名字"), "沈青崖");
  await user.type(screen.getByLabelText("身份 / 职业"), "落魄镖师");
  await user.click(screen.getByLabelText("世界观背景"));
  await user.paste("镖局一夜覆灭，江湖各派暗流涌动，真凶身份成谜。");
  await user.click(screen.getByLabelText("故事开端"));
  await user.paste("暮色四合，主角背着旧刀走进青石镇，镇口贴着缉凶告示。");
  await user.click(screen.getByRole("button", { name: "确认开局资料" }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CurrentGameScreen", () => {
  it("加载中先显示读取状态（aria-live）", () => {
    stubFetch(() => new Promise<FakeResponse>(() => {}));
    render(<CurrentGameScreen />);
    expect(screen.getByRole("status")).toHaveTextContent("正在读取当前存档");
  });

  it("current=none：显示创建表单，且只请求过 /api/game/current", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { status: "none" }));
    render(<CurrentGameScreen />);

    expect(await screen.findByText("选择游戏类型")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/game/current");
  });

  it("current=active：显示地图壳（世界地图），不显示旧面板主布局", async () => {
    const view = buildSessionViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    expect(await screen.findByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "前往城外官道" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开角色面板" })).toBeInTheDocument();
    expect(screen.queryByText("选择游戏类型")).toBeNull();
  });

  it("非战斗 active 会话渲染地图 HUD", async () => {
    stubFetch(async () => jsonResponse(200, { status: "active", view: buildSessionViewFixture() }));
    render(<CurrentGameScreen />);
    expect(await screen.findByLabelText("游戏 HUD")).toBeInTheDocument();
    expect(document.querySelector(".adventure-game-shell")).toBeTruthy();
  });

  it("进入地点场景后可见互动热点和 NPC，返回地图零请求", async () => {
    const view = buildSessionViewFixture();
    const fetchMock = stubFetch(async () => jsonResponse(200, { status: "active", view }));
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "进入青石镇" }));

    expect(screen.getByRole("button", { name: "观察青石镇" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "陆掌柜，客栈掌柜" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "地图" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "地图" }));
    expect(screen.getByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    // 进入/返回地图都是纯本地导航：只有初始 GET current 一次 fetch。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("NPC 对话：greet 提交 dialogue_choice payload，成功后更新 view", async () => {
    const view = buildSessionViewFixture();
    const greetedView = {
      ...view,
      revision: 1,
      dialogues: view.dialogues.map((d) =>
        d.npcId === "npc_zhao"
          ? { ...d, choices: d.choices.filter((c) => c.kind !== "greet") }
          : d
      )
    };
    let submittedBody: unknown;
    stubFetch(async (input, init?) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      submittedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        view: greetedView,
        feedback: { ok: true, message: "你与捕头赵五交谈。" }
      });
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "进入青石镇" }));
    await user.click(screen.getByRole("button", { name: "捕头赵五，官府捕头" }));
    await user.click(screen.getByRole("button", { name: "1. 与捕头赵五初次交谈" }));

    expect(submittedBody).toEqual({
      intent: { type: "dialogue_choice", npcId: "npc_zhao", choiceId: "npc_zhao:greet" },
      revision: 0
    });
    expect(await screen.findByText("你与捕头赵五交谈。")).toBeInTheDocument();
  });

  it("developmentTools=true：确认后只请求开发清档接口并回到新开局表单", async () => {
    const view = buildSessionViewFixture();
    const fetchMock = stubFetch(async (input, init) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view, developmentTools: true });
      if (input === "/api/game/dev/current" && init?.method === "DELETE") return jsonResponse(200, { status: "cleared" });
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "开发工具" }));
    await user.click(await screen.findByRole("button", { name: "清除本地试玩存档" }));
    expect(await screen.findByText("选择游戏类型")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/game/dev/current", { method: "DELETE" });
  });

  it("corrupt=UNPARSEABLE_RECORD：显示数据损坏提示，而非数据库不可用", async () => {
    stubFetch(async () =>
      jsonResponse(200, { status: "corrupt", reason: "UNPARSEABLE_RECORD" })
    );
    render(<CurrentGameScreen />);

    expect(await screen.findByText(/存档记录无法解析/)).toBeInTheDocument();
    expect(screen.getByText(/存档数据已损坏/)).toBeInTheDocument();
    expect(screen.queryByText(/暂时不可用/)).toBeNull();
  });

  it("corrupt=INFRASTRUCTURE_FAILURE：显示数据库暂不可用，而非数据损坏", async () => {
    stubFetch(async () =>
      jsonResponse(503, { status: "corrupt", reason: "INFRASTRUCTURE_FAILURE" })
    );
    render(<CurrentGameScreen />);

    expect(await screen.findByText(/本地存档数据库暂时不可用/)).toBeInTheDocument();
    expect(screen.queryByText(/已损坏/)).toBeNull();
  });

  it("current API 网络异常：提示刷新重试，不显示表单", async () => {
    stubFetch(async () => {
      throw new TypeError("failed to fetch");
    });
    render(<CurrentGameScreen />);

    expect(await screen.findByText(/未能读取当前存档/)).toBeInTheDocument();
    expect(screen.queryByText("选择游戏类型")).toBeNull();
  });

  it("完整闭环：none → 填表创建成功 → 无需刷新直接看到开场视图，只访问本地 API", async () => {
    const view = buildSessionViewFixture();
    const fetchMock = stubFetch(async (input) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "none" });
      if (input === "/api/game") return jsonResponse(201, { view, generationSource: "generated" });
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await fillAndSubmitSetupForm(user);

    expect(await screen.findByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.queryByText("选择游戏类型")).toBeNull();
    expect(screen.queryByText(FALLBACK_NOTICE)).toBeNull();
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/game(\/current)?$/);
    }
  });

  it("fallback 创建后：显示一次性降级提示，不阻断游玩", async () => {
    const view = buildSessionViewFixture();
    stubFetch(async (input) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "none" });
      if (input === "/api/game") return jsonResponse(201, { view, generationSource: "fallback" });
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await fillAndSubmitSetupForm(user);

    expect(await screen.findByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.getByText(FALLBACK_NOTICE)).toBeInTheDocument();
  });

  it("刷新恢复同一存档：GET current 不携带来源 ⇒ 不显示降级提示", async () => {
    const view = buildSessionViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    expect(await screen.findByRole("button", { name: "进入青石镇" })).toBeInTheDocument();
    expect(screen.queryByText(FALLBACK_NOTICE)).toBeNull();
  });

  it("移动闭环：发送 move payload 与 revision，成功后自动进入新地点场景", async () => {
    const view = buildSessionViewFixture();
    const movedView = buildMovedSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = stubFetch(async (input, init) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      if (input === "/api/game/actions") {
        submittedRequest = init;
        return jsonResponse(200, {
          view: movedView,
          feedback: { ok: true, message: "你来到了城外官道。" }
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "前往城外官道" }));

    expect(
      (await screen.findAllByText("黄土道上车辙纵横，隐约可见几处暗色血迹。")).length
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/巡道老兵/).length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "move", locationId: "loc_guandao" },
      revision: 0
    });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/game\/(current|actions)$/);
    }
  });

  it("行动请求进行中：行动按钮一律禁用", async () => {
    const view = buildSessionViewFixture();
    let resolvePost: ((response: FakeResponse) => void) | undefined;
    stubFetch(async (input) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      return new Promise<FakeResponse>((resolve) => { resolvePost = resolve; });
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "前往城外官道" }));

    const buttons = screen.getAllByRole("button").filter(
      (b) =>
        !["地图", "背包", "任务", "日志"].includes(b.textContent ?? "") &&
        b.getAttribute("aria-label") !== "打开角色面板"
    );
    for (const button of buttons) {
      expect(button).toBeDisabled();
    }

    resolvePost?.(
      jsonResponse(200, {
        view: buildMovedSessionViewFixture(),
        feedback: { ok: true, message: "你来到了城外官道。" }
      })
    );
    await screen.findByText("你来到了城外官道。");
  });

  it("拾取闭环：进入场景后发送 take_item payload，成功后更新 view", async () => {
    const view = buildSessionViewFixture();
    const takenView = buildItemTakenSessionViewFixture();
    let submittedRequest: RequestInit | undefined;
    const fetchMock = stubFetch(async (input, init) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      if (input === "/api/game/actions") {
        submittedRequest = init;
        return jsonResponse(200, {
          view: takenView,
          feedback: { ok: true, message: "你拾起了锈铁钥匙。" }
        });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "进入青石镇" }));
    await user.click(screen.getByRole("button", { name: "拾取锈铁钥匙" }));

    expect(await screen.findByText("你拾起了锈铁钥匙。")).toBeInTheDocument();
    expect(JSON.parse(String(submittedRequest?.body))).toEqual({
      intent: { type: "take_item", itemId: "item_key" },
      revision: 0
    });
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toMatch(/^\/api\/game\/(current|actions)$/);
    }
  });

  it("移动遇到陈旧 revision：重新读取当前存档并渲染最新视图", async () => {
    const view = buildSessionViewFixture();
    const refreshedView = { ...buildMovedSessionViewFixture(), revision: 2 };
    let currentCalls = 0;
    stubFetch(async (input) => {
      if (input === "/api/game/current") {
        currentCalls += 1;
        return jsonResponse(200, {
          status: "active",
          view: currentCalls === 1 ? view : refreshedView
        });
      }
      if (input === "/api/game/actions") {
        return jsonResponse(409, { code: "STALE_GAME_REVISION" });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "前往城外官道" }));

    expect(
      await screen.findByRole("button", { name: "进入城外官道" })
    ).toBeInTheDocument();
    expect(currentCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 Task 4：战斗与结局 UI 集成测试。
// ---------------------------------------------------------------------------

describe("CurrentGameScreen：战斗面板", () => {
  it("active battle 时渲染战斗面板与 battle_action 按钮", async () => {
    const view = buildBattleSessionViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    const region = await screen.findByRole("region", { name: "战斗" });
    expect(region).toBeInTheDocument();
    expect(region).toHaveTextContent("暗影刺客");
    expect(screen.getByRole("button", { name: "攻击" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "防御" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "撤退" })).toBeInTheDocument();
  });

  it("active battle 显示战斗主视窗，且不渲染地图壳", async () => {
    stubFetch(async () => jsonResponse(200, { status: "active", view: buildBattleSessionViewFixture() }));
    render(<CurrentGameScreen />);
    expect(await screen.findByRole("region", { name: "战斗" })).toHaveClass("battle-viewport");
    expect(screen.queryByRole("button", { name: "进入青石镇" })).toBeNull();
  });

  it("战斗中提交 attack 带正确 revision 与 payload", async () => {
    const view = buildBattleSessionViewFixture();
    const updatedView = {
      ...view,
      revision: 4,
      battle: { ...view.battle!, enemyHp: 11, round: 3 },
    };
    let submittedBody: unknown;
    stubFetch(async (input, init?) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      submittedBody = JSON.parse(String(init?.body));
      return jsonResponse(200, {
        view: updatedView,
        feedback: { ok: true, message: "你挥刀斩中敌人！" },
      });
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "攻击" }));

    expect(submittedBody).toEqual({
      intent: { type: "battle_action", action: "attack" },
      revision: 3,
    });
    expect(await screen.findByText("你挥刀斩中敌人！")).toBeInTheDocument();
  });

  it("战斗中提交期间禁用全部按钮", async () => {
    const view = buildBattleSessionViewFixture();
    let resolvePost: ((response: FakeResponse) => void) | undefined;
    stubFetch(async (input) => {
      if (input === "/api/game/current") return jsonResponse(200, { status: "active", view });
      return new Promise<FakeResponse>((resolve) => { resolvePost = resolve; });
    });
    const user = userEvent.setup();
    render(<CurrentGameScreen />);

    await user.click(await screen.findByRole("button", { name: "攻击" }));

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }

    resolvePost?.(
      jsonResponse(200, { view, feedback: { ok: true, message: "攻击成功。" } })
    );
    await screen.findByText("攻击成功。");
  });
});

describe("CurrentGameScreen：结局面板", () => {
  it("成功结局时渲染结局面板，不渲染行动按钮", async () => {
    const view = buildSuccessEndingSessionViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    expect(await screen.findByRole("region", { name: "结局" })).toBeInTheDocument();
    expect(screen.getByText("真相大白")).toBeInTheDocument();
    expect(screen.getByText(/成功/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("失败结局时渲染结局面板，不渲染行动按钮", async () => {
    const view = buildFailureEndingSessionViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    expect(await screen.findByRole("region", { name: "结局" })).toBeInTheDocument();
    expect(screen.getByText("功亏一篑")).toBeInTheDocument();
    expect(screen.getByText(/失败/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("结局后中途刷新恢复结局状态", async () => {
    const view = buildSuccessEndingSessionViewFixture();
    stubFetch(async () => jsonResponse(200, { status: "active", view }));
    render(<CurrentGameScreen />);

    expect(await screen.findByText("真相大白")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
