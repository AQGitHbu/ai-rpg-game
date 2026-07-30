import type { ReactNode } from "react";
import type { ItemIconKey } from "@/game/application";

// ---------------------------------------------------------------------------
// 背包物品图标（示意图 G）：六类物品图标的内联 SVG 占位视觉。与 adventureVisuals
// 同一模式——仓库内可审查的几何形状，零图片 URL、零网络字体、零生图调用。
// 颜色使用 currentColor，由外层格子按稀有度着色；图标本身纯装饰
// （aria-hidden），可访问名称由格子按钮的 aria-label 提供。
// ---------------------------------------------------------------------------

/** 六类图标的基础几何：viewBox 统一 0 0 48 48，线条几何 + currentColor。 */
const ICON_SHAPES: Record<ItemIconKey, ReactNode> = {
  // 剑：斜刃 + 护手 + 柄
  sword: (
    <>
      <path d="M10 38 L30 18 L34 10 L38 14 L30 18" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M14 30 l4 4" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
      <path d="M8 40 l4 -4" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </>
  ),
  // 护甲：胸甲轮廓 + 中线
  armor: (
    <>
      <path
        d="M14 10 L24 14 L34 10 L38 18 L34 24 V34 Q24 40 14 34 V24 L10 18 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <path d="M24 16 V36" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  // 饰品：吊坠环 + 宝石
  trinket: (
    <>
      <circle cx={24} cy={18} r={8} fill="none" stroke="currentColor" strokeWidth={2.5} />
      <path d="M20 26 L24 40 L28 26" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <circle cx={24} cy={18} r={3} fill="currentColor" />
    </>
  ),
  // 药剂：细颈瓶 + 液面
  potion: (
    <>
      <path
        d="M20 8 h8 v8 l6 12 a10 10 0 0 1 -20 0 l6 -12 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <path d="M17 30 h14" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  // 材料：矿锭堆叠
  material: (
    <>
      <path d="M12 30 l6 -8 h12 l6 8 -6 8 H18 Z" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M18 22 l6 8 12 0 M24 30 l-6 8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
    </>
  ),
  // 钥匙：环柄 + 齿
  key: (
    <>
      <circle cx={17} cy={17} r={7} fill="none" stroke="currentColor" strokeWidth={2.5} />
      <path d="M22 22 L38 38 M32 32 l5 -5 M27 27 l4 -4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
    </>
  )
};

type InventoryItemIconProps = {
  readonly icon: ItemIconKey;
};

export function InventoryItemIcon({ icon }: InventoryItemIconProps) {
  // 类别兜底：非法运行时输入退化为药剂形状，不抛错。
  const shape = ICON_SHAPES[icon] ?? ICON_SHAPES.potion;
  return (
    <svg
      viewBox="0 0 48 48"
      preserveAspectRatio="xMidYMid meet"
      focusable="false"
      aria-hidden="true"
      data-icon={icon}
      className={`inventory-icon inventory-icon--${icon}`}
    >
      {shape}
    </svg>
  );
}
