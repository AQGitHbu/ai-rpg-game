import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { InventoryItemView } from "@/game/application";
import { InventoryPanel } from "./InventoryPanel";

const ITEMS: readonly InventoryItemView[] = [
  {
    name: "旧刀",
    description: "父亲留下的佩刀，刀鞘磨损严重。",
    category: "equipment",
    rarity: "fine",
    level: 2,
    statLines: [{ label: "攻击力", value: "+6" }],
    icon: "sword",
  },
  {
    name: "金疮药",
    description: "止血生肌的伤药。",
    category: "consumable",
    rarity: "common",
    level: null,
    statLines: [],
    icon: "potion",
  },
  {
    name: "锈铁钥匙",
    description: "钥匙柄上刻着镖局的徽记。",
    category: "quest",
    rarity: "rare",
    level: null,
    statLines: [],
    icon: "key",
  },
];

describe("InventoryPanel", () => {
  it("renders four category tabs and an icon grid by default", () => {
    render(<InventoryPanel items={ITEMS} />);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["装备", "道具", "材料", "任务"]);
    const grid = screen.getByTestId("inventory-grid");
    expect(within(grid).getByRole("button", { name: "旧刀" })).toHaveAttribute("aria-pressed", "true");
    expect(within(grid).getByRole("button", { name: "旧刀" }).querySelector("svg[data-icon='sword']")).not.toBeNull();
  });

  it("shows the selected item's rarity, metadata, and description", () => {
    render(<InventoryPanel items={ITEMS} />);

    const details = screen.getByTestId("inventory-details");
    expect(within(details).getByText("旧刀")).toBeInTheDocument();
    expect(within(details).getByText("精良")).toBeInTheDocument();
    expect(within(details).getByText("等级 2")).toBeInTheDocument();
    expect(within(details).getByText("攻击力")).toBeInTheDocument();
    expect(within(details).getByText("+6")).toBeInTheDocument();
    expect(within(details).getByText("父亲留下的佩刀，刀鞘磨损严重。")).toBeInTheDocument();
  });

  it("opens on the first populated category when no equipment is present", () => {
    render(<InventoryPanel items={[ITEMS[2]!]} />);

    expect(screen.getByRole("tab", { name: "任务" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("inventory-details")).toHaveTextContent("钥匙柄上刻着镖局的徽记。");
  });

  it("switches category and resets selection to the first item", async () => {
    const user = userEvent.setup();
    render(<InventoryPanel items={ITEMS} />);

    await user.click(screen.getByRole("tab", { name: "任务" }));

    expect(screen.getByRole("button", { name: "锈铁钥匙" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "旧刀" })).not.toBeInTheDocument();
    expect(screen.getByTestId("inventory-details")).toHaveTextContent("钥匙柄上刻着镖局的徽记。");
  });

  it("renders empty states for an empty bag and an empty category", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<InventoryPanel items={[]} />);
    expect(screen.getByText("背包空空如也。")).toBeInTheDocument();

    rerender(<InventoryPanel items={ITEMS} />);
    await user.click(screen.getByRole("tab", { name: "材料" }));
    expect(screen.getByText("此分类暂无物品。")).toBeInTheDocument();
  });
});
