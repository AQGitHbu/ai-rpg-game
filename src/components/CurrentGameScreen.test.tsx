import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameSessionView } from "@/game/application";
import { CurrentGameScreen } from "./CurrentGameScreen";
import { fetchCurrentGame } from "./gameActionRequest";

vi.mock("./gameActionRequest", () => ({
  fetchCurrentGame: vi.fn(),
  ensureNarrative: vi.fn(async () => true),
  ackPrologue: vi.fn(async () => true),
}));

const endedView: GameSessionView = {
  revision: 9,
  gameType: "wuxia",
  player: { name: "侠客", identity: "剑客", hp: 80, attack: 10, defense: 5 },
  worldMap: { locations: [] },
  currentLocation: { name: "终局", description: "", actions: [] },
  obtainableItems: [],
  inventory: [],
  story: { currentAct: 3, targetActs: 3, tension: 100, pacingNeed: "resolve", storyProgress: 100 },
  narrative: { mode: "offline", hasScene: false, choices: [], npcLine: null, npcDialogues: [] },
  narrativeGeneration: { status: "idle" },
  battle: null,
  quests: [],
  prologueShown: true,
  ending: { name: "并肩破局", description: "故事结束。", outcome: "success", restartIdentity: "opaque-ended-session" },
};

afterEach(() => {
  cleanup();
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
});
