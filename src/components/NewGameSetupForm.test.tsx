import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NewGameSetupForm } from "./NewGameSetupForm";

describe("NewGameSetupForm", () => {
  it("offers all configured MVP game types", () => {
    render(<NewGameSetupForm />);
    for (const label of ["武侠", "仙侠", "奇幻", "科幻", "都市", "历史架空", "末日"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it("uses the shared UI contract in a real submit flow", async () => {
    const user = userEvent.setup();
    render(<NewGameSetupForm />);

    await user.click(screen.getByRole("radio", { name: /科幻/ }));
    await user.type(screen.getByLabelText("角色名字"), "林渡");
    await user.type(screen.getByLabelText("身份 / 职业"), "失踪航站的维修员");
    await user.type(
      screen.getByLabelText("世界观背景"),
      "人类城市依靠一座不断删除居民记忆的轨道电梯维持能源。",
    );
    await user.type(
      screen.getByLabelText("故事开端"),
      "我在停运十年的站台收到了一张写着自己名字的返程票。",
    );
    await user.click(screen.getByRole("button", { name: "确认开局资料" }));

    expect(screen.getByRole("status")).toHaveTextContent("“科幻”开局资料已通过 UI 校验");
    expect(screen.getByText("资料已就绪")).toHaveClass("tag", "tag--success");
    expect(screen.getByRole("button", { name: "确认开局资料" })).toHaveClass(
      "inline-button",
      "inline-button--md",
    );
  });
});
