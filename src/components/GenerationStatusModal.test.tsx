import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { GenerationStatusModal } from "./GenerationStatusModal";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("GenerationStatusModal", () => {
  it("shows elapsed time and a retry action after a long narrative wait", async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    render(<GenerationStatusModal kind="narrative" onRetry={onRetry} />);

    expect(screen.queryByRole("button", { name: "重新检查生成状态" })).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000);
    });

    expect(screen.getByText(/已等待 \d+ 秒/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新检查生成状态" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("distinguishes action retry from narrative retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <GenerationStatusModal
        kind="action-failure"
        failureKind="AI_CALL_FAILED"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("heading")).toHaveTextContent("本次选择提交失败");
    expect(screen.getByRole("alert")).toHaveTextContent(/这次选择尚未生效/);
    fireEvent.click(screen.getByRole("button", { name: "重试当前选择" }));
    expect(onRetry).toHaveBeenCalledOnce();

    rerender(
      <GenerationStatusModal
        kind="narrative-failure"
        failureKind="AI_RESPONSE_INVALID"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("heading")).toHaveTextContent("NPC回应生成失败");
    expect(screen.getByRole("alert")).toHaveTextContent(/你的选择已经生效/);
    expect(screen.getByRole("button", { name: "重试生成回应" })).toBeInTheDocument();
  });
});
