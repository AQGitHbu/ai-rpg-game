import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TravelNarrationScreen } from "./TravelNarrationScreen";

describe("TravelNarrationScreen", () => {
  it("显示旅行旁白文本", () => {
    render(<TravelNarrationScreen narration="你沿着官道前行，远处城楼的轮廓逐渐清晰。" onComplete={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "旅行旁白" })).toBeInTheDocument();
  });

  it("首次点击跳过动画完成文字显示", async () => {
    const user = userEvent.setup();
    render(<TravelNarrationScreen narration="这是一段较长的旅行旁白文字。" onComplete={vi.fn()} />);
    await user.click(screen.getByRole("dialog"));
    // 动画被跳过后，继续提示出现
    expect(screen.getByText("点击或按 Enter / Space / Esc 继续")).toBeInTheDocument();
  });

  it("文字完成后点击调用 onComplete", async () => {
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<TravelNarrationScreen narration="短。" onComplete={onComplete} />);
    // 等待逐字动画完成
    await new Promise((resolve) => setTimeout(resolve, 200));
    await user.click(screen.getByRole("dialog"));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
