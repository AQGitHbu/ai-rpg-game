import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { CurrentGameScreen } from "./CurrentGameScreen";
import { fetchCurrentGame, ensureNarrative, ackPrologue } from "./gameActionRequest";

vi.mock("./gameActionRequest", () => ({
  fetchCurrentGame: vi.fn(),
  ensureNarrative: vi.fn(async () => true),
  ackPrologue: vi.fn(async () => true),
}));

const baseView: GameSessionView = {
  revision: 9,
  turnNumber: 8,
  gameType: "wuxia",
  setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
  player: { name: "侠客", identity: "剑客", hp: 80, attack: 10, defense: 5 },
  worldMap: { locations: [] },
  currentLocation: { name: "终局", description: "", scale: "scene", actions: [], npcs: [], town: null },
  obtainableItems: [],
  inventory: [],
  story: { currentAct: 3, targetActs: 3, tension: 100, pacingNeed: "resolve", storyProgress: 100, currentObjectiveLabel: null, currentObjectiveChoiceToken: null, currentObjectiveChoiceTokens: [] },
  narrative: { mode: "offline", hasScene: false, choices: [], npcLine: null, npcDialogues: [] },
  narrativeGeneration: { status: "idle" },
  battle: null,
  quests: [],
  prologueShown: true,
  prologueText: "",
  ending: { name: "并肩破局", description: "故事结束。", outcome: "success", restartIdentity: "opaque-ended-session" },
};

const endedView: GameSessionView = { ...baseView, prologueShown: true, prologueText: "" };

const activeViewWithPrologue: GameSessionView = {
  ...baseView,
  prologueShown: false,
  prologueText: "你在听雨客栈醒来，雨声压住了街道上的马蹄。",
  ending: null,
};

const pendingPrologueView: GameSessionView = {
  ...activeViewWithPrologue,
  narrativeGeneration: { status: "pending" },
};

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe("CurrentGameScreen ending restart", () => {
  it("opens a replacement-game form instead of reloading the same ended record", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: endedView });
    render(<CurrentGameScreen />);

    expect(await screen.findByRole("region", { name: "冒险结局" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "重新开始" }));

    expect(await screen.findByRole("heading", { name: "开始新的冒险" })).toBeInTheDocument();
    expect(fetchCurrentGame).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled());

    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    const init = vi.mocked(globalThis.fetch).mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      restart: { identity: "opaque-ended-session", expectedRevision: 9 },
    });
  });

  it("keeps the replacement-game form open after a page refresh", async () => {
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: endedView });

    const firstMount = render(<CurrentGameScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "重新开始" }));
    expect(screen.getByRole("heading", { name: "开始新的冒险" })).toBeInTheDocument();

    firstMount.unmount();
    render(<CurrentGameScreen />);

    expect(await screen.findByRole("heading", { name: "开始新的冒险" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "冒险结局" })).not.toBeInTheDocument();
  });

  it("ignores a restart marker when the ended save identity or revision has changed", async () => {
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: endedView });

    const firstMount = render(<CurrentGameScreen />);
    await userEvent.click(await screen.findByRole("button", { name: "重新开始" }));
    firstMount.unmount();

    const newerEndedView: GameSessionView = {
      ...endedView,
      revision: endedView.revision + 1,
      ending: { ...endedView.ending!, restartIdentity: "new-ended-session" },
    };
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: newerEndedView });
    render(<CurrentGameScreen />);

    expect(await screen.findByRole("region", { name: "冒险结局" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "开始新的冒险" })).not.toBeInTheDocument();
  });
});

describe("CurrentGameScreen prologue display", () => {
  it("shows the generated prologueText on the black screen when present", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: activeViewWithPrologue });
    render(<CurrentGameScreen />);

    expect(await screen.findByText("你在听雨客栈醒来，雨声压住了街道上的马蹄。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始冒险" })).toBeInTheDocument();
  });

  it("falls back to the player's original storyOpening only when prologueText is empty", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const failedGenerationView: GameSessionView = {
      ...activeViewWithPrologue,
      prologueText: "",
      setup: {
        storyOpening: "我收到一封来自失踪妹妹、却署着三年前日期的信……",
        worldPremise: null,
        characterProfile: null,
        narrativeStyle: null,
      },
    };
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: failedGenerationView });
    render(<CurrentGameScreen />);

    expect(await screen.findByText("我收到一封来自失踪妹妹、却署着三年前日期的信……")).toBeInTheDocument();
  });

  it("does not submit the prologue acknowledgement twice while the first request is pending", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    let resolveAck!: (value: boolean) => void;
    vi.mocked(ackPrologue).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveAck = resolve;
    }));
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: activeViewWithPrologue });
    render(<CurrentGameScreen />);

    const button = await screen.findByRole("button", { name: "开始冒险" });
    await userEvent.click(button);
    await userEvent.click(screen.getByRole("button", { name: "正在进入……" }));

    expect(ackPrologue).toHaveBeenCalledOnce();
    resolveAck(true);
    await waitFor(() => expect(fetchCurrentGame).toHaveBeenCalledTimes(2));
  });

  it("shows a retryable error when the prologue acknowledgement fails", async () => {
    vi.mocked(ackPrologue).mockResolvedValueOnce(false);
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: activeViewWithPrologue });
    render(<CurrentGameScreen />);

    await userEvent.click(await screen.findByRole("button", { name: "开始冒险" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("进入失败，请检查连接后重试。");
    expect(screen.getByRole("button", { name: "开始冒险" })).toBeEnabled();
  });

  it("starts polling the opening scene behind the prologue before acknowledgement", async () => {
    vi.mocked(fetchCurrentGame)
      .mockResolvedValueOnce({ ok: true, status: "active", view: pendingPrologueView })
      .mockResolvedValueOnce({
        ok: true,
        status: "active",
        view: pendingPrologueView,
      });
    render(<CurrentGameScreen />);

    await waitFor(() => expect(ensureNarrative).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "开始冒险" })).toBeInTheDocument();
    expect(screen.getByText("你在听雨客栈醒来，雨声压住了街道上的马蹄。")).toBeInTheDocument();
  });

  it("uses only the button busy state while acknowledging the prologue", async () => {
    let resolveAck!: (value: boolean) => void;
    vi.mocked(ackPrologue).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveAck = resolve;
    }));
    vi.mocked(fetchCurrentGame).mockResolvedValue({ ok: true, status: "active", view: activeViewWithPrologue });
    render(<CurrentGameScreen />);

    await userEvent.click(await screen.findByRole("button", { name: "开始冒险" }));

    expect(screen.getByRole("button", { name: "正在进入……" })).toBeDisabled();
    expect(screen.queryByRole("dialog", { name: "正在处理……" })).not.toBeInTheDocument();
    resolveAck(true);
    await waitFor(() => expect(fetchCurrentGame).toHaveBeenCalledTimes(2));
  });
});
