import type { ReactNode } from "react";
import type { ItemIconKey } from "@/game/application";

const ICON_SHAPES: Record<ItemIconKey, ReactNode> = {
  sword: (
    <>
      <path d="M10 38 L30 18 L34 10 L38 14 L30 18" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M14 30 l4 4" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
      <path d="M8 40 l4 -4" stroke="currentColor" strokeWidth={3} strokeLinecap="round" />
    </>
  ),
  armor: (
    <>
      <path d="M14 10 L24 14 L34 10 L38 18 L34 24 v10 Q24 40 14 34 v-10 L10 18 Z" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M24 16 V36" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  trinket: (
    <>
      <circle cx={24} cy={18} r={8} fill="none" stroke="currentColor" strokeWidth={2.5} />
      <path d="M20 26 L24 40 L28 26" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <circle cx={24} cy={18} r={3} fill="currentColor" />
    </>
  ),
  potion: (
    <>
      <path d="M20 8 h8 v8 l6 12 a10 10 0 0 1 -20 0 l6 -12 Z" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M17 30 h14" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  material: (
    <>
      <path d="M12 30 l6 -8 h12 l6 8 -6 8 H18 Z" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M18 22 l6 8 12 0 M24 30 l-6 8" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
    </>
  ),
  key: (
    <>
      <circle cx={17} cy={17} r={7} fill="none" stroke="currentColor" strokeWidth={2.5} />
      <path d="M22 22 L38 38 M32 32 l5 -5 M27 27 l4 -4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
    </>
  ),
};

export function InventoryItemIcon({ icon }: { readonly icon: ItemIconKey }) {
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
