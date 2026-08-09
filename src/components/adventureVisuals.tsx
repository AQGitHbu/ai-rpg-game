import type { ReactNode } from "react";
import type { NewGameInput } from "@/game/application";

// ---------------------------------------------------------------------------
// 本地 SVG 视觉档案（Phase 7 Task 4）：七种题材 × 八类资源的内联占位视觉。
// 全部由仓库内可审查的几何形状组成——共用每类资源的基础形状，按题材映射
// 固定 palette、线条与小装饰；零图片 URL、零网络字体、零生图调用。
// 资源选择只依赖受校验的 gameType 与固定 kind 白名单：非法运行时输入一律
// 解析为 "generic" 档案，不抛错、不拼接路径。
// 非装饰用法暴露 role="img" + aria-label 并内含 <title>；纯背景装饰用法
// （decorative）以 aria-hidden 隐藏，地点名由相邻文本提供。
// ---------------------------------------------------------------------------

/** UI 层经 application 门面取题材类型（禁止直连 domain）。 */
type GameTypeId = NewGameInput["gameType"];

export const ADVENTURE_VISUAL_KINDS = [
  "map_base",
  "map_node",
  "map_node_locked",
  "location_backdrop",
  "npc",
  "fact",
  "item",
  "enemy"
] as const;

export type AdventureVisualKind = (typeof ADVENTURE_VISUAL_KINDS)[number];

export type AdventureVisualVariant = GameTypeId | "generic";

/** 七种合法题材（与 domain GameTypeId 一致；Record 键校验防漏）。 */
const GAME_TYPE_VARIANTS: readonly GameTypeId[] = [
  "wuxia",
  "xianxia",
  "fantasy",
  "science_fiction",
  "urban",
  "alternate_history",
  "post_apocalypse"
];

/** 每个题材的固定配色与小装饰：sky/ground 为面，fill 为主体，line 为线条，accent 为点缀。 */
type ThemeSpec = {
  readonly sky: string;
  readonly ground: string;
  readonly fill: string;
  readonly line: string;
  readonly accent: string;
  /** 题材小装饰：叠加在右上角的一条 path 数据。 */
  readonly motif: string;
};

/**
 * 题材→五色主题的只读映射，同时供视觉组件与本仓库内其他 UI（如新开局页面的
 * 类型选择主题切换）使用。sky/ground 为面、fill 为主体、line 为线条、accent 为点缀。
 */
export const ADVENTURE_THEMES: Readonly<Record<AdventureVisualVariant, ThemeSpec>> = {
  wuxia: {
    sky: "#2b2a26",
    ground: "#3d3a30",
    fill: "#6b5f4a",
    line: "#d7b96f",
    accent: "#c4675f",
    // 剑
    motif: "M70 20 L88 6 M79 9 l4 4"
  },
  xianxia: {
    sky: "#22303a",
    ground: "#2c4148",
    fill: "#5f8b8a",
    line: "#a8d8d0",
    accent: "#d6c28a",
    // 云
    motif: "M68 14 q5 -8 11 -3 q6 -5 11 2"
  },
  fantasy: {
    sky: "#2a2438",
    ground: "#3a3050",
    fill: "#6d5a9c",
    line: "#c9b8ff",
    accent: "#e0c060",
    // 四芒星
    motif: "M80 4 v14 M73 11 h14"
  },
  science_fiction: {
    sky: "#101b26",
    ground: "#16283a",
    fill: "#2f5d7c",
    line: "#7fd4f0",
    accent: "#ff8a5c",
    // 轨道线
    motif: "M70 8 h20 M74 14 h12"
  },
  urban: {
    sky: "#1f2326",
    ground: "#2c3136",
    fill: "#4d5a66",
    line: "#c0c8d0",
    accent: "#e0a458",
    // 天际线
    motif: "M70 18 v-8 h5 v4 h6 v-8 h5 v12"
  },
  alternate_history: {
    sky: "#2d2620",
    ground: "#40362a",
    fill: "#7a6448",
    line: "#d9c9a3",
    accent: "#a83c32",
    // 旗帜
    motif: "M74 20 V4 h12 l-4 4 4 4 h-12"
  },
  post_apocalypse: {
    sky: "#26221c",
    ground: "#38302a",
    fill: "#5c5244",
    line: "#c9a06a",
    accent: "#9fb85a",
    // 裂痕
    motif: "M70 6 l6 6 -4 4 6 6"
  },
  generic: {
    sky: "#20242a",
    ground: "#2e3338",
    fill: "#4a5560",
    line: "#b7b4a7",
    accent: "#d7b96f",
    // 菱形
    motif: "M80 5 l6 6 -6 6 -6 -6 Z"
  }
};

function isVisualKind(value: unknown): value is AdventureVisualKind {
  return (
    typeof value === "string" &&
    (ADVENTURE_VISUAL_KINDS as readonly string[]).includes(value)
  );
}

function isGameTypeVariant(value: unknown): value is GameTypeId {
  return (
    typeof value === "string" &&
    (GAME_TYPE_VARIANTS as readonly string[]).includes(value)
  );
}

/**
 * 把运行时输入解析为确定的档案变体：题材与类别都在白名单内才返回题材本身，
 * 否则一律 "generic"。纯查表，不抛错、不拼接任何路径。
 */
export function resolveAdventureVisualVariant(
  gameType: unknown,
  kind: unknown
): AdventureVisualVariant {
  if (!isVisualKind(kind) || !isGameTypeVariant(gameType)) return "generic";
  return gameType;
}

// ---------------------------------------------------------------------------
// 八类资源的基础几何：同一形状被全部题材复用，只换 ThemeSpec。
// viewBox 统一 0 0 96 64。
// ---------------------------------------------------------------------------

const KIND_SHAPES: Record<AdventureVisualKind, (t: ThemeSpec) => ReactNode> = {
  // 地图基底：地形块 + 虚线路径 + 途经节点
  map_base: (t) => (
    <>
      <path d="M0 44 Q24 36 48 42 T96 40 V64 H0 Z" fill={t.ground} />
      <path
        d="M10 50 C28 40 44 46 60 34 S84 24 88 18"
        fill="none"
        stroke={t.line}
        strokeWidth={2}
        strokeDasharray="4 3"
      />
      <circle cx={10} cy={50} r={3} fill={t.accent} />
      <circle cx={60} cy={34} r={3} fill={t.accent} />
      <circle cx={88} cy={18} r={3} fill={t.accent} />
    </>
  ),
  // 地点节点：同心圆标记
  map_node: (t) => (
    <>
      <circle cx={48} cy={32} r={18} fill={t.fill} stroke={t.line} strokeWidth={2} />
      <circle cx={48} cy={32} r={7} fill={t.accent} />
    </>
  ),
  // 锁定节点：暗淡圆 + 锁
  map_node_locked: (t) => (
    <>
      <circle
        cx={48}
        cy={32}
        r={18}
        fill={t.ground}
        stroke={t.line}
        strokeWidth={2}
        opacity={0.6}
      />
      <path d="M44 31 v-4 a4 4 0 0 1 8 0 v4" fill="none" stroke={t.line} strokeWidth={2} />
      <rect x={42} y={31} width={12} height={10} rx={2} fill={t.line} />
    </>
  ),
  // 地点背景：远山棱线 + 地面 + 天体
  location_backdrop: (t) => (
    <>
      <circle cx={76} cy={14} r={6} fill={t.accent} />
      <path
        d="M0 40 L18 24 34 38 52 20 70 36 96 26 V64 H0 Z"
        fill={t.fill}
        opacity={0.85}
      />
      <rect x={0} y={48} width={96} height={16} fill={t.ground} />
    </>
  ),
  // NPC 剪影：头 + 肩
  npc: (t) => (
    <>
      <circle cx={48} cy={22} r={10} fill={t.fill} stroke={t.line} strokeWidth={2} />
      <path d="M28 56 q20 -22 40 0 Z" fill={t.fill} stroke={t.line} strokeWidth={2} />
    </>
  ),
  // 线索：放大镜
  fact: (t) => (
    <>
      <circle cx={42} cy={26} r={13} fill={t.ground} stroke={t.line} strokeWidth={3} />
      <path d="M52 36 L66 50" stroke={t.line} strokeWidth={4} strokeLinecap="round" />
      <circle cx={38} cy={22} r={3} fill={t.accent} />
    </>
  ),
  // 物品：多面宝石
  item: (t) => (
    <>
      <path d="M48 12 L66 28 48 54 30 28 Z" fill={t.fill} stroke={t.line} strokeWidth={2} />
      <path d="M48 12 V54 M30 28 H66" fill="none" stroke={t.accent} strokeWidth={1.5} />
    </>
  ),
  // 敌人：带角剪影 + 双目
  enemy: (t) => (
    <>
      <path
        d="M32 54 V30 q0 -16 16 -16 t16 16 v24 Z"
        fill={t.fill}
        stroke={t.line}
        strokeWidth={2}
      />
      <path d="M36 18 l-6 -8 M60 18 l6 -8" stroke={t.line} strokeWidth={2} strokeLinecap="round" />
      <circle cx={42} cy={32} r={3} fill={t.accent} />
      <circle cx={54} cy={32} r={3} fill={t.accent} />
    </>
  )
};

type AdventureVisualProps = {
  readonly gameType: GameTypeId;
  readonly kind: AdventureVisualKind;
  readonly label: string;
  /** true 时按纯装饰渲染（aria-hidden），可访问名称由相邻文本提供。 */
  readonly decorative?: boolean;
};

export function AdventureVisual({ gameType, kind, label, decorative = false }: AdventureVisualProps) {
  const variant = resolveAdventureVisualVariant(gameType, kind);
  const theme = ADVENTURE_THEMES[variant];
  // 类别兜底与 resolve 同口径：非法 kind 用通用节点形状，绝不抛错。
  const shape = isVisualKind(kind) ? KIND_SHAPES[kind] : KIND_SHAPES.map_node;
  const accessibilityProps = decorative
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": label } as const);

  return (
    <svg
      viewBox="0 0 96 64"
      preserveAspectRatio="xMidYMid meet"
      focusable="false"
      className={`adventure-visual adventure-visual--${variant}`}
      data-variant={variant}
      data-kind={kind}
      {...accessibilityProps}
    >
      {decorative ? null : <title>{label}</title>}
      <rect x={0} y={0} width={96} height={64} rx={6} fill={theme.sky} />
      {shape(theme)}
      <path
        d={theme.motif}
        fill="none"
        stroke={theme.accent}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </svg>
  );
}
