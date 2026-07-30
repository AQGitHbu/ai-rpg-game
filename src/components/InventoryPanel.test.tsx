import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { InventoryItemView } from "@/game/application";
import { InventoryPanel } from "./InventoryPanel";

// ---------------------------------------------------------------------------
// 背包界面组件契约（示意图 G）：四分类页签 + 左侧图标网格 + 右侧选中物品详情。
// 数据全部来自 InventoryItemView 富视图；组件零 fetch、零随机、零直连 domain。
// ---------------------------------------------------------------------------

const OLD_BLADE: InventoryItemView = {
  name: "旧刀",
  description: "父亲留下的佩刀，刀鞘磨损严重。",
  category: "equipment",
  rarity: "fine",
  level: 2,
  statLines: [
    { label: "攻击力", value: "+6" },
    { label: "身法", value: "+3%" }
  ],
  icon: "sword"
};

const WOOD_SHIELD: InventoryItemView = {
  name: "铁木盾",
  description: "边缘包铁的木盾，挡过不少刀箭。",
  category: "equipment",
  rarity: "common",
  level: 1,
  statLines: [{ label: "防御力", value: "+4" }],
  icon: "armor"
};

const SALVE: InventoryItemView = {
  name: "金疮药",
  description: "止血生肌的伤药。",
  category: "consumable",
  rarity: "common",
  level: null,
  statLines: [],
  icon: "potion"
};

const RUSTY_KEY: InventoryItemView = {
  name: "锈铁钥匙",
  description: "钥匙柄上刻着镖局的徽记。",
  category: "quest",
  rarity: "rare",
  level: null,
  statLines: [],
  icon: "key"
};

const ITEMS: readonly InventoryItemView[] = [OLD_BLADE, WOOD_SHIELD, SALVE, RUSTY_KEY];

describe("InventoryPanel：分类页签", () => {
  it("渲染 装备/道具/材料/任务 四个页签，默认选中「装备」", () => {
    render(<InventoryPanel items={ITEMS} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["装备", "道具", "材料", "任务"]);
    expect(screen.getByRole("tab", { name: "装备" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "道具" })).toHaveAttribute("aria-selected", "false");
  });

  it("点击「任务」页签后切换网格内容并展示任务物品", async () => {
    const user = userEvent.setup();
    render(<InventoryPanel items={ITEMS} />);

    await user.click(screen.getByRole("tab", { name: "任务" }));

    expect(screen.getByRole("tab", { name: "任务" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "锈铁钥匙" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "旧刀" })).not.toBeInTheDocument();
  });

  it("当前分类无物品时显示分类空态", async () => {
    const user = userEvent.setup();
    render(<InventoryPanel items={ITEMS} />);

    await user.click(screen.getByRole("tab", { name: "材料" }));

    expect(screen.getByText("此分类暂无物品。")).toBeInTheDocument();
  });

  it("背包为空时显示整体空态", () => {
    render(<InventoryPanel items={[]} />);

    expect(screen.getByText("背包空空如也。")).toBeInTheDocument();
  });
});

describe("InventoryPanel：图标网格与选中详情", () => {
  it("装备页签网格按物品顺序渲染图标按钮，默认选中第一件", () => {
    render(<InventoryPanel items={ITEMS} />);

    const grid = screen.getByTestId("inventory-grid");
    const cells = within(grid).getAllByRole("button");
    expect(cells.map((cell) => cell.getAttribute("aria-label"))).toEqual(["旧刀", "铁木盾"]);
    expect(cells[0]).toHaveAttribute("aria-pressed", "true");
    expect(cells[1]).toHaveAttribute("aria-pressed", "false");
  });

  it("详情区显示选中物品的名称、稀有度、等级、属性行与描述", () => {
    render(<InventoryPanel items={ITEMS} />);

    const details = screen.getByTestId("inventory-details");
    expect(within(details).getByText("旧刀")).toBeInTheDocument();
    expect(within(details).getByText("精良")).toBeInTheDocument();
    expect(within(details).getByText(/等级 2/)).toBeInTheDocument();
    expect(within(details).getByText("攻击力")).toBeInTheDocument();
    expect(within(details).getByText("+6")).toBeInTheDocument();
    expect(within(details).getByText("身法")).toBeInTheDocument();
    expect(within(details).getByText("+3%")).toBeInTheDocument();
    expect(within(details).getByText("父亲留下的佩刀，刀鞘磨损严重。")).toBeInTheDocument();
  });

  it("点击另一件物品后详情切换，无等级/属性行的物品不渲染对应区块", async () => {
    const user = userEvent.setup();
    render(<InventoryPanel items={ITEMS} />);

    await user.click(screen.getByRole("tab", { name: "任务" }));
    await user.click(screen.getByRole("button", { name: "锈铁钥匙" }));

    const details = screen.getByTestId("inventory-details");
    expect(within(details).getByText("锈铁钥匙")).toBeInTheDocument();
    expect(within(details).getByText("稀有")).toBeInTheDocument();
    expect(within(details).queryByText(/等级/)).not.toBeInTheDocument();
    expect(within(details).getByText("钥匙柄上刻着镖局的徽记。")).toBeInTheDocument();
  });

  it("切换页签后选中项重置为该分类第一件物品", async () => {
    const user = userEvent.setup();
    render(<InventoryPanel items={ITEMS} />);

    await user.click(within(screen.getByTestId("inventory-grid")).getByRole("button", { name: "铁木盾" }));
    await user.click(screen.getByRole("tab", { name: "道具" }));

    const details = screen.getByTestId("inventory-details");
    expect(within(details).getByText("金疮药")).toBeInTheDocument();
  });

  it("图标为内联 SVG 占位：携带 data-icon 与稀有度 data-rarity", () => {
    render(<InventoryPanel items={ITEMS} />);

    const grid = screen.getByTestId("inventory-grid");
    const blade = within(grid).getByRole("button", { name: "旧刀" });
    expect(blade.querySelector("svg[data-icon='sword']")).not.toBeNull();
    expect(blade).toHaveAttribute("data-rarity", "fine");
  });
});
