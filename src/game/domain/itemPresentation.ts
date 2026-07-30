import type { ItemCategory, ItemRarity, ItemStatLine } from "./scenarioBlueprint";

// ---------------------------------------------------------------------------
// 物品展示元数据解析（背包界面重构 Task 1）。
// 蓝图物品的 category / rarity / level / statLines 是可选展示字段：显式提供
// 时透传，缺省时按 kind 确定性推导。纯函数：不读环境/时间/随机，不改输入。
// 展示元数据不是规则事实：不参与战斗、任务或行动结算。
// ---------------------------------------------------------------------------

/** 背包图标的封闭键集合：UI 据此渲染内联 SVG 占位图标，零网络零 AI。 */
export type ItemIconKey =
  | "sword"
  | "armor"
  | "trinket"
  | "potion"
  | "material"
  | "key";

/** 解析完成的展示元数据：所有字段均已落定，UI 不再做任何推导。 */
export type ItemPresentation = {
  readonly category: ItemCategory;
  readonly rarity: ItemRarity;
  /** null = 蓝图未提供等级，UI 不显示等级行。 */
  readonly level: number | null;
  readonly statLines: readonly ItemStatLine[];
  readonly icon: ItemIconKey;
};

/** 解析输入只依赖展示相关字段：候选与已编译物品定义皆可传入。 */
export type ItemPresentationSource = {
  readonly kind: string;
  readonly category?: ItemCategory;
  readonly rarity?: ItemRarity;
  readonly level?: number;
  readonly statLines?: readonly ItemStatLine[];
};

/** kind → 分类的确定性映射；未命中的 kind 一律归入「道具」。 */
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
  ["herb", "material"]
]);

/** 装备分类内 kind → 图标的细分映射；其余分类图标由分类唯一确定。 */
const EQUIPMENT_ICON_BY_KIND: ReadonlyMap<string, ItemIconKey> = new Map([
  ["weapon", "sword"],
  ["armor", "armor"],
  ["gear", "trinket"],
  ["talisman", "trinket"]
]);

export function resolveItemPresentation(item: ItemPresentationSource): ItemPresentation {
  const kind = item.kind.toLowerCase();
  const category = item.category ?? CATEGORY_BY_KIND.get(kind) ?? "consumable";
  // 任务物品缺省即为关键物品：稀有度抬升为 rare，其余缺省 common。
  const rarity = item.rarity ?? (category === "quest" ? "rare" : "common");
  const level =
    item.level !== undefined && Number.isInteger(item.level) && item.level > 0
      ? item.level
      : null;
  const statLines = item.statLines ?? [];
  return { category, rarity, level, statLines, icon: resolveIcon(category, kind) };
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
