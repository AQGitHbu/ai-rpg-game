import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AdventureOverlay } from "./AdventureOverlay";

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      {open ? (
        <AdventureOverlay title="测试弹层" onClose={() => setOpen(false)} returnFocusRef={triggerRef}>
          <p>弹层内容</p>
        </AdventureOverlay>
      ) : null}
    </div>
  );
}

describe("AdventureOverlay", () => {
  it("弹层获得焦点、Escape 关闭并恢复触发焦点", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开" });
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "测试弹层" });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("关闭按钮可关闭弹层", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "打开" }));

    await userEvent.click(screen.getByRole("button", { name: "关闭测试弹层" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("渲染 children 内容", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "打开" }));

    expect(screen.getByText("弹层内容")).toBeVisible();
  });
});
