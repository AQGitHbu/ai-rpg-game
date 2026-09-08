import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewGameSetupForm } from "./NewGameSetupForm";

function mockCreateSuccess() {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: 0 }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NewGameSetupForm canonical contract", () => {
  it("keeps player-edited fields when switching the genre preset", async () => {
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    const premise = screen.getByRole("textbox", { name: "世界观背景" });
    await userEvent.clear(premise);
    await userEvent.type(premise, "这是玩家亲自写下、切换题材后也必须保留的世界。" );

    await userEvent.click(screen.getByRole("radio", { name: /奇幻/ }));

    expect(premise).toHaveValue("这是玩家亲自写下、切换题材后也必须保留的世界。");
    expect(screen.getByRole("textbox", { name: "角色名字" })).toHaveValue("凯尔");
  });

  it("posts to the fixed game endpoint and invokes the one completion callback", async () => {
    const onCreated = vi.fn();
    mockCreateSuccess();
    render(<NewGameSetupForm onCreated={onCreated} />);

    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/game", expect.objectContaining({ method: "POST" }));
  });

  it("includes the opaque ended-session identity and revision when creating a replacement game", async () => {
    mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} restart={{ identity: "opaque-ended-session", expectedRevision: 9 }} />);

    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      gameType: "wuxia",
      gameLength: "short",
      characterName: expect.any(String),
      characterIdentity: expect.any(String),
      characterProfile: expect.any(String),
      worldPremise: expect.any(String),
      storyOpening: expect.any(String),
      narrativeStyle: "novel",
      contentIntensity: "normal",
      restart: { identity: "opaque-ended-session", expectedRevision: 9 },
    });
  });
  it("uses the original seven cover URLs and survives an image load failure", async () => {
    const { container } = render(<NewGameSetupForm onCreated={vi.fn()} />);
    const cards = [...container.querySelectorAll(".game-type-card")];
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      const input = card.querySelector("input")!;
      const image = card.querySelector("img")!;
      const src = new URL(image.getAttribute("src")!, "http://localhost");
      expect(src.searchParams.get("url") ?? src.pathname).toBe(`/assets/genres/${input.value}.jpg`);
    }
    const first = cards[0]!;
    fireEvent.error(first.querySelector("img")!);
    expect(first.querySelector("img")).toBeNull();
    expect(first.querySelector(".game-type-card--visual")).toBeInTheDocument();
    await userEvent.click(first.querySelector("input")!);
    expect(first.querySelector("input")).toBeChecked();
    expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled();
  });
});

describe("NewGameSetupForm personality and intensity preferences", () => {
  it("exposes six controlled personality tags and two content-intensity choices", () => {
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    for (const tag of ["冷静", "冲动", "善良", "多疑", "幽默", "寡言"]) {
      expect(screen.getByRole("checkbox", { name: new RegExp(tag) })).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: /普通/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /黑暗/ })).toBeInTheDocument();
  });

  it("selected personality tags and dark intensity reach POST /api/game exactly", async () => {
    mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /冷静/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /多疑/ }));
    await userEvent.click(screen.getByRole("radio", { name: /黑暗/ }));
    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      personalityTags: ["冷静", "多疑"],
      contentIntensity: "dark",
    });
  });

  it("caps personality tags at three: selecting a fourth is ignored", async () => {
    mockCreateSuccess();
    render(<NewGameSetupForm onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /冷静/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /冲动/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /善良/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: /多疑/ }));
    await userEvent.click(screen.getByRole("button", { name: "踏上旅程" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      personalityTags: ["冷静", "冲动", "善良"],
    });
  });
});
