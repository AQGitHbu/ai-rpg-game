import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { PrologueScreen } from "./PrologueScreen";

// ---------------------------------------------------------------------------
// Phase 14 Task 6：黑底白字序幕开场组件测试。
// 渲染 role="dialog"；逐字淡入完成后，再次点击/按键触发 onComplete。
// ---------------------------------------------------------------------------

describe("PrologueScreen", () => {
  test("渲染序幕文本", () => {
    render(
      <PrologueScreen
        prologue={{ text: "南宋覆灭五十余年", tone: "serious" }}
        onComplete={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("点击触发 onComplete", () => {
    const onComplete = vi.fn();
    render(
      <PrologueScreen
        prologue={{ text: "测试", tone: "epic" }}
        onComplete={onComplete}
      />,
    );
    // 第一次点击：显示全文
    fireEvent.click(screen.getByRole("dialog"));
    // 第二次点击：触发 onComplete
    fireEvent.click(screen.getByRole("dialog"));
    expect(onComplete).toHaveBeenCalled();
  });

  test.each([
    ["Enter", "Enter"],
    ["Space", " "],
    ["Escape", "Escape"]
  ])("完成后按 %s 触发 onComplete", (_label, key) => {
    const onComplete = vi.fn();
    render(
      <PrologueScreen
        prologue={{ text: "测试", tone: "serious" }}
        onComplete={onComplete}
      />
    );

    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.keyDown(window, { key });

    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  test("父组件轮询重渲染后，键盘继续使用最新 onComplete", () => {
    const firstOnComplete = vi.fn();
    const latestOnComplete = vi.fn();
    const { rerender } = render(
      <PrologueScreen
        prologue={{ text: "测试", tone: "serious" }}
        onComplete={firstOnComplete}
      />
    );

    fireEvent.click(screen.getByRole("dialog"));
    rerender(
      <PrologueScreen
        prologue={{ text: "测试", tone: "serious" }}
        onComplete={latestOnComplete}
      />
    );
    fireEvent.keyDown(window, { key: "Enter" });

    expect(firstOnComplete).not.toHaveBeenCalled();
    expect(latestOnComplete).toHaveBeenCalledTimes(1);
  });
});
