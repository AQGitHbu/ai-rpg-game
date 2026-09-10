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

  // Task 11：开局任务独立于 GameRecord，失败时旧存档仍完好。
  // 因此文案必须说明「尚未创建」，并同时给出同任务重试与放弃两个出口。
  it("creation failure offers same-task retry and an explicit give-up path", () => {
    const onRetry = vi.fn();
    const onCancel = vi.fn();
    render(
      <GenerationStatusModal
        kind="creation-failure"
        failureKind="AI_RESPONSE_INVALID"
        onRetry={onRetry}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole("heading")).toHaveTextContent("开局生成失败");
    expect(screen.getByRole("alert")).toHaveTextContent(/本次开局尚未创建/);
    expect(screen.getByText(/继续同一个生成任务/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试生成" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "放弃本次生成" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
