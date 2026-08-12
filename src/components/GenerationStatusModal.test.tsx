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
});
