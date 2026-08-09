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
});
