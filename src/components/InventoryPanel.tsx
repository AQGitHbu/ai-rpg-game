"use client";

import { useState } from "react";
import type { InventoryItemView, ItemCategory, ItemRarity } from "@/game/application";
import { InventoryItemIcon } from "./inventoryVisuals";

// ---------------------------------------------------------------------------
// 背包界面（示意图 G）：四分类页签 + 左侧物品图标网格 + 右侧选中物品详情。
// 数据全部来自 InventoryItemView 富视图（application 门面投影）；组件本身
// 零 fetch、零随机——只有页签与选中项两个本地 UI 状态。
// ---------------------------------------------------------------------------

const CATEGORY_TABS: readonly { readonly id: ItemCategory; readonly label: string }[] = [
  { id: "equipment", label: "装备" },
  { id: "consumable", label: "道具" },
  { id: "material", label: "材料" },
  { id: "quest", label: "任务" }
];

const RARITY_LABELS: Record<ItemRarity, string> = {
  common: "普通",
  fine: "精良",
  rare: "稀有",
  epic: "史诗"
};

type InventoryPanelProps = {
  readonly items: readonly InventoryItemView[];
};

export function InventoryPanel({ items }: InventoryPanelProps) {
  const [activeCategory, setActiveCategory] = useState<ItemCategory>("equipment");
  const [selectedIndex, setSelectedIndex] = useState(0);

  if (items.length === 0) {
    return <p className="inventory-empty">背包空空如也。</p>;
  }

  const categoryItems = items.filter((item) => item.category === activeCategory);
  // 越界防御：切页签后选中项重置为 0，但外部 items 变化也可能使索引失效。
  const selected = categoryItems[selectedIndex] ?? categoryItems[0] ?? null;

  return (
    <div className="inventory-panel">
      <div className="inventory-tabs" role="tablist" aria-label="物品分类">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeCategory}
            className={`inventory-tab${tab.id === activeCategory ? " inventory-tab--active" : ""}`}
            onClick={() => {
              setActiveCategory(tab.id);
              setSelectedIndex(0);
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="inventory-body">
        <div className="inventory-grid" data-testid="inventory-grid">
          {categoryItems.map((item, index) => (
            <button
              key={item.name}
              type="button"
              aria-label={item.name}
              aria-pressed={item === selected}
              data-rarity={item.rarity}
              className={`inventory-cell inventory-cell--${item.rarity}${
                item === selected ? " inventory-cell--selected" : ""
              }`}
              onClick={() => setSelectedIndex(index)}
            >
              <InventoryItemIcon icon={item.icon} />
            </button>
          ))}
          {categoryItems.length === 0 ? (
            <p className="inventory-category-empty">此分类暂无物品。</p>
          ) : null}
        </div>
        {selected !== null ? (
          <aside
            className={`inventory-details inventory-details--${selected.rarity}`}
            data-testid="inventory-details"
          >
            <header className="inventory-details-header">
              <h4 className="inventory-details-name">{selected.name}</h4>
              <span className={`inventory-rarity inventory-rarity--${selected.rarity}`}>
                {RARITY_LABELS[selected.rarity]}
              </span>
            </header>
            {selected.level !== null ? (
              <p className="inventory-details-type">等级 {selected.level}</p>
            ) : null}
            {selected.statLines.length > 0 ? (
              <dl className="inventory-details-stats">
                {selected.statLines.map((line) => (
                  <div key={line.label}>
                    <dt>{line.label}</dt>
                    <dd>{line.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="inventory-details-description">{selected.description}</p>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
