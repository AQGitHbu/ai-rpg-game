import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastContainer, type ToastMessage } from "./ToastNotification";

describe("ToastNotification", () => {
  it("正确渲染单条和多条 toast 提示框", () => {
    const toasts: ToastMessage[] = [
      { id: "1", message: "你来到了铁剑山庄。", createdAt: 1000 },
      { id: "2", message: "你获得了锈铁钥匙。", createdAt: 2000 }
    ];
    render(<ToastContainer toasts={toasts} onDismiss={vi.fn()} />);

    const statusElements = screen.getAllByRole("status");
    expect(statusElements).toHaveLength(2);
    expect(statusElements[0]).toHaveTextContent("你来到了铁剑山庄。");
    expect(statusElements[1]).toHaveTextContent("你获得了锈铁钥匙。");
  });

  it("退场动画结束时触发 onDismiss 回调", () => {
    const onDismiss = vi.fn();
    const toasts: ToastMessage[] = [
      { id: "t1", message: "你来到了铁剑山庄。", createdAt: 1000 }
    ];
    render(<ToastContainer toasts={toasts} onDismiss={onDismiss} />);

    const exitAnimationEnd = new Event("animationend", { bubbles: true });
    Object.assign(exitAnimationEnd, { animationName: "adventure-toast-exit" });
    fireEvent(screen.getByRole("status"), exitAnimationEnd);

    expect(onDismiss).toHaveBeenCalledWith("t1");
  });

  it("当动画结束或超时 5.1s 时触发 onDismiss 回调", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const toasts: ToastMessage[] = [
      { id: "t1", message: "你来到了铁剑山庄。", createdAt: 1000 }
    ];
    render(<ToastContainer toasts={toasts} onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(5100);
    });

    expect(onDismiss).toHaveBeenCalledWith("t1");
    vi.useRealTimers();
  });
});
