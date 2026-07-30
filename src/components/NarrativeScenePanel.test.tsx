import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NarrativeScenePanel } from "./NarrativeScenePanel";

describe("NarrativeScenePanel", () => {
  it("shows only player-safe text and submits the opaque token", async () => {
    const onChoose = vi.fn();
    render(<NarrativeScenePanel busy={false} onChoose={onChoose} onReturnMap={vi.fn()} scene={{ narration: "雨落在屋檐上。", npcLine: null, choices: [{ label: "继续追问", choiceToken: "a" }, { label: "检查角落", choiceToken: "b" }] }} />);
    await userEvent.click(screen.getByRole("button", { name: "继续追问" }));
    expect(onChoose).toHaveBeenCalledWith("a");
    expect(screen.queryByText("actionKey")).toBeNull();
  });

  it("returns to the map locally without exposing narrative internals", async () => {
    const onReturnMap = vi.fn();
    render(<NarrativeScenePanel busy={false} onChoose={vi.fn()} onReturnMap={onReturnMap} scene={{ narration: "雨落在屋檐上。", npcLine: null, choices: [{ label: "继续追问", choiceToken: "a" }, { label: "检查角落", choiceToken: "b" }] }} />);
    await userEvent.click(screen.getByRole("button", { name: "返回地图" }));
    expect(onReturnMap).toHaveBeenCalledTimes(1);
  });
});
