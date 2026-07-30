import { describe, expect, it } from "vitest";
import { resolveItemPresentation } from "./itemPresentation";
import type { ItemDefinitionCandidate } from "./scenarioBlueprint";

// ---------------------------------------------------------------------------
// 背包界面重构（Task 1）：物品展示元数据解析纯函数。
// 蓝图物品的 category / rarity / level / statLines 均为可选展示字段：
// 显式提供时透传，缺省时按 kind 确定性推导。旧存档蓝图（无新字段）
// 因此零迁移可投影。展示元数据不是规则事实：不参与战斗或任务结算。
// ---------------------------------------------------------------------------

function item(overrides: Partial<ItemDefinitionCandidate> = {}): ItemDefinitionCandidate {
  return {
    id: "item_x",
    name: "测试物品",
    description: "测试描述。",
    kind: "misc",
    tags: [],
    ...overrides
  };
}

describe("resolveItemPresentation：显式字段透传", () => {
  it("category / rarity / level / statLines 显式提供时原样返回", () => {
    const presentation = resolveItemPresentation(
      item({
        kind: "weapon",
        category: "equipment",
        rarity: "rare",
        level: 8,
        statLines: [
          { label: "攻击力", value: "24" },
          { label: "暴击率", value: "+3%" }
        ]
      })
    );
    expect(presentation.category).toBe("equipment");
    expect(presentation.rarity).toBe("rare");
    expect(presentation.level).toBe(8);
    expect(presentation.statLines).toEqual([
      { label: "攻击力", value: "24" },
      { label: "暴击率", value: "+3%" }
    ]);
  });
});

describe("resolveItemPresentation：按 kind 推导缺省分类", () => {
  it.each([
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
    ["potion", "consumable"],
    ["misc", "consumable"],
    ["未知种类", "consumable"]
  ] as const)("kind=%s → category=%s", (kind, category) => {
    expect(resolveItemPresentation(item({ kind })).category).toBe(category);
  });

  it("kind 大小写不敏感（AI 候选可能大写）", () => {
    expect(resolveItemPresentation(item({ kind: "Weapon" })).category).toBe("equipment");
  });
});

describe("resolveItemPresentation：缺省稀有度与等级", () => {
  it("任务物品缺省稀有度为 rare，其余为 common", () => {
    expect(resolveItemPresentation(item({ kind: "key" })).rarity).toBe("rare");
    expect(resolveItemPresentation(item({ kind: "weapon" })).rarity).toBe("common");
    expect(resolveItemPresentation(item({ kind: "misc" })).rarity).toBe("common");
  });

  it("level 缺省为 null；非法值（0、负数、非整数）防御性归 null", () => {
    expect(resolveItemPresentation(item()).level).toBeNull();
    expect(resolveItemPresentation(item({ level: 0 })).level).toBeNull();
    expect(resolveItemPresentation(item({ level: -3 })).level).toBeNull();
    expect(resolveItemPresentation(item({ level: 2.5 })).level).toBeNull();
  });

  it("statLines 缺省为 []", () => {
    expect(resolveItemPresentation(item()).statLines).toEqual([]);
  });
});

describe("resolveItemPresentation：图标键推导", () => {
  it.each([
    ["weapon", "sword"],
    ["armor", "armor"],
    ["gear", "trinket"],
    ["talisman", "trinket"],
    ["key", "key"],
    ["material", "material"],
    ["potion", "potion"],
    ["misc", "potion"]
  ] as const)("kind=%s → icon=%s", (kind, icon) => {
    expect(resolveItemPresentation(item({ kind })).icon).toBe(icon);
  });

  it("显式 category=quest 时图标跟随分类而非 kind", () => {
    expect(resolveItemPresentation(item({ kind: "misc", category: "quest" })).icon).toBe("key");
  });
});

describe("resolveItemPresentation：纯函数约束", () => {
  it("不修改输入物品", () => {
    const input = item({ kind: "weapon" });
    const frozen = Object.freeze({ ...input, tags: Object.freeze([...input.tags]) });
    expect(() => resolveItemPresentation(frozen)).not.toThrow();
    expect(frozen).toEqual(item({ kind: "weapon" }));
  });
});
