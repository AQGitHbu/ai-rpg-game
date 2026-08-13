import type { ItemCategory, ItemRarity, ItemStatLine } from "./worldEntity";

/**
 * 背包图标的封闭键集合。图标由客户端内联渲染，不依赖网络或图片服务。
 */
export type ItemIconKey =
  | "sword"
  | "armor"
  | "trinket"
  | "potion"
  | "material"
  | "key";

export type ItemPresentation = {
  readonly category: ItemCategory;
  readonly rarity: ItemRarity;
  readonly level: number | null;
  readonly statLines: readonly ItemStatLine[];
  readonly icon: ItemIconKey;
};

/** 展示元数据只读输入；它不包含物品 ID 或其它内部规则字段。 */
export type ItemPresentationSource = {
  readonly kind: string;
  readonly category?: ItemCategory;
  readonly rarity?: ItemRarity;
  readonly level?: number;
  readonly statLines?: readonly ItemStatLine[];
};

const CATEGORY_BY_KIND: ReadonlyMap<string, ItemCategory> = new Map([
  ["weapon", "equipment"],
  ["armor", "equipment"],
  ["gear", "equipment"],
  ["talisman", "equipment"],
  ["equipment", "equipment"],
  ["key", "quest"],
  ["quest", "quest"],
  ["material", "material"],
  ["ore", "material"],
  ["herb", "material"],
]);

const EQUIPMENT_ICON_BY_KIND: ReadonlyMap<string, ItemIconKey> = new Map([
  ["weapon", "sword"],
  ["armor", "armor"],
  ["gear", "trinket"],
  ["talisman", "trinket"],
]);

/**
 * 将物品领域字段解析为稳定的 UI 展示元数据。
 * 缺省值按 kind 确定性推导，展示字段不参与规则结算。
 */
export function resolveItemPresentation(item: ItemPresentationSource): ItemPresentation {
  const kind = item.kind.toLowerCase();
  const category = item.category ?? CATEGORY_BY_KIND.get(kind) ?? "consumable";
  const rarity = item.rarity ?? (category === "quest" ? "rare" : "common");
  const level = item.level !== undefined && Number.isInteger(item.level) && item.level > 0
    ? item.level
    : null;

  return {
    category,
    rarity,
    level,
    statLines: item.statLines ?? [],
    icon: resolveIcon(category, kind),
  };
}

function resolveIcon(category: ItemCategory, kind: string): ItemIconKey {
  switch (category) {
    case "equipment":
      return EQUIPMENT_ICON_BY_KIND.get(kind) ?? "sword";
    case "quest":
      return "key";
    case "material":
      return "material";
    case "consumable":
      return "potion";
  }
}
