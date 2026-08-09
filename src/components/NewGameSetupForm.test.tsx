import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewGameSetupForm } from "./NewGameSetupForm";

describe("NewGameSetupForm canonical contract", () => {
  it("posts to the fixed game endpoint and invokes the one completion callback", async () => {
    const onCreated = vi.fn();
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: 0 }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    render(<NewGameSetupForm onCreated={onCreated} />);

    await userEvent.click(screen.getByRole("button", { name: "进入世界" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/game", expect.objectContaining({ method: "POST" }));
  });

  it("includes an explicit ended-save revision when creating a replacement game", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, revision: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    render(<NewGameSetupForm onCreated={vi.fn()} restartRevision={9} />);

    await userEvent.click(screen.getByRole("button", { name: "进入世界" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      gameType: "wuxia",
      gameLength: "short",
      restart: { expectedRevision: 9 },
    });
  });
});
