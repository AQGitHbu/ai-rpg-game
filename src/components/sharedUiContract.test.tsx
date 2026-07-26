import { render, screen } from "@testing-library/react";
import { InlineButton, Panel, Tag } from "@ai-game/ui";
import { describe, expect, it } from "vitest";

describe("@ai-game/ui RPG consumer contract", () => {
  it("imports all v0.1 primitives from the package root", () => {
    render(
      <Panel title="生成状态">
        <Tag variant="info">等待生成</Tag>
        <InlineButton type="submit">继续</InlineButton>
      </Panel>,
    );

    expect(screen.getByText("生成状态").closest("section")).toHaveClass("panel");
    expect(screen.getByText("等待生成")).toHaveClass("tag--info");
    expect(screen.getByRole("button", { name: "继续" })).toHaveAttribute("type", "submit");
  });
});
