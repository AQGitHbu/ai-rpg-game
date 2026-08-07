import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SceneNarrationBar } from "./SceneNarrationBar";

describe("SceneNarrationBar", () => {
  it("显示旁白文本", () => {
    render(<SceneNarrationBar narration="你仔细查看石碑，发现上面刻着古老的符文。" onDismiss={vi.fn()} />);
    expect(screen.getByText("你仔细查看石碑，发现上面刻着古老的符文。")).toBeInTheDocument();
  });

  it("点击关闭按钮调用 onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<SceneNarrationBar narration="测试旁白。" onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "关闭旁白" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("不渲染空旁白", () => {
    const { container } = render(<SceneNarrationBar narration="" onDismiss={vi.fn()} />);
    expect(container.querySelector(".scene-narration-bar")).toBeNull();
  });
});
