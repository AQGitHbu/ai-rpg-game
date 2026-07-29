"use client";

import type { TownBuildingType } from "@/game/application";

// ---------------------------------------------------------------------------
// Town demo（Task 8）：程序生成的 SVG 占位外观图（用户硬约束：不接入
// AI 生图、无任何网络图片）。200×120 简笔立面：按建筑类型选屋顶形状与
// 招牌/烟囱等元素，用 seed 派生的 hue 微调配色；同一输入永远同一输出。
// ---------------------------------------------------------------------------

/** 建筑类型中文标签（档案面板复用）。 */
export const TOWN_BUILDING_TYPE_LABELS: Record<TownBuildingType, string> = {
  tavern: "酒馆",
  blacksmith: "铁匠铺",
  house: "民居",
  shop: "商铺",
  workshop: "工坊",
  warehouse: "仓库",
  well: "水井",
  gatehouse: "门楼"
};

type RoofShape = "gable" | "flat" | "slant" | "twin";

/** 每种建筑类型的简笔立面配置：屋顶形状 + 附属元素。 */
const BUILDING_ART: Record<
  TownBuildingType,
  { readonly roof: RoofShape; readonly sign: boolean; readonly chimney: boolean }
> = {
  tavern: { roof: "gable", sign: true, chimney: true },
  blacksmith: { roof: "flat", sign: false, chimney: true },
  house: { roof: "gable", sign: false, chimney: false },
  shop: { roof: "flat", sign: true, chimney: false },
  workshop: { roof: "slant", sign: false, chimney: true },
  warehouse: { roof: "flat", sign: false, chimney: false },
  well: { roof: "slant", sign: false, chimney: false },
  gatehouse: { roof: "twin", sign: false, chimney: false }
};

/** FNV-1a 32-bit：UI 本地的确定性 hash，只用于占位图配色，不触碰生成器。 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function renderRoof(roof: RoofShape, fill: string) {
  switch (roof) {
    case "gable":
      return <polygon points="35,54 100,18 165,54" fill={fill} />;
    case "flat":
      return <rect x={38} y={40} width={124} height={14} fill={fill} />;
    case "slant":
      return <polygon points="35,54 45,24 165,40 165,54" fill={fill} />;
    case "twin":
      return (
        <g>
          <rect x={30} y={26} width={26} height={76} fill={fill} />
          <rect x={144} y={26} width={26} height={76} fill={fill} />
          <rect x={40} y={40} width={120} height={12} fill={fill} />
        </g>
      );
  }
}

export function BuildingPlaceholderArt({
  buildingType,
  seed
}: {
  buildingType: TownBuildingType;
  seed: string;
}) {
  const hue = hashSeed(`${seed}:${buildingType}`) % 360;
  const wallFill = `hsl(${hue} 22% 40%)`;
  const roofFill = `hsl(${(hue + 24) % 360} 30% 27%)`;
  const trimFill = `hsl(${(hue + 48) % 360} 45% 64%)`;
  const art = BUILDING_ART[buildingType];

  return (
    <svg
      className="town-demo-profile-art"
      viewBox="0 0 200 120"
      role="img"
      aria-label={`${TOWN_BUILDING_TYPE_LABELS[buildingType]}占位外观图`}
      data-building-art={buildingType}
    >
      {/* 背景与地面 */}
      <rect x={0} y={0} width={200} height={120} fill="#141a16" />
      <rect x={0} y={100} width={200} height={20} fill="#242b22" />

      {/* 墙体 + 屋顶 */}
      <rect x={45} y={52} width={110} height={50} fill={wallFill} />
      {renderRoof(art.roof, roofFill)}

      {/* 门与窗 */}
      <rect x={92} y={74} width={16} height={28} fill={roofFill} />
      <rect x={58} y={64} width={14} height={12} fill={trimFill} />
      <rect x={128} y={64} width={14} height={12} fill={trimFill} />

      {/* 附属元素：招牌 / 烟囱 */}
      {art.sign && (
        <g>
          <line x1={70} y1={52} x2={70} y2={60} stroke={trimFill} strokeWidth={2} />
          <circle cx={70} cy={66} r={7} fill={trimFill} />
        </g>
      )}
      {art.chimney && <rect x={138} y={22} width={10} height={26} fill={roofFill} />}
    </svg>
  );
}
