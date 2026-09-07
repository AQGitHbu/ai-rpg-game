# 内容位图片 Registry 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 AI 预生成视觉资产的统一接入基础设施：内容位 registry（`contentAssets.ts`，kind × variant 查表）+ 降级组件（`ContentAssetImage.tsx`），并把题材封面与小镇建筑图两个既有硬编码映射等价迁入。

**Architecture:** 纯数据查表模块 `contentAssets.ts`（函数重载在编译期锁定 kind↔variant 配对，运行时白名单守卫使非法输入一律返回 null，不抛错、不拼接路径）；DOM 降级组件 `ContentAssetImage`（查表 null 或 `onError` 时渲染 `fallback`）；两个接入点只换 URL 来源，渲染方式（next/image / SVG `<image>`）保持不变。

**Tech Stack:** Next.js 15 + React 19（DOM 渲染）、TypeScript、vitest + @testing-library/react（jsdom，`src/test-setup.ts` 已接入 jest-dom）、next/image。

**Spec:** `docs/superpowers/specs/2026-09-07-content-asset-registry-design.md`

## Global Constraints

- 不触碰 `src/game/**`、API route、持久化或任何玩法链路（spec §1.2）
- 不修改共享包 `@ai-game/ui`；新文件全部在 `src/components/` 层内（spec §1.2）
- 不新增图片资产：v1 只迁移既有 `public/assets/genres/`（7 张 jpg）与 `public/assets/town/`（8 张 webp）映射（spec §1.2）
- 等价迁移铁律：URL 值逐字节不变——`TownLayerScreen.test.tsx:77` 断言精确 URL `image[href="/assets/town/<type>.webp"]`
- 不得触碰 `TownMapSvg` 的 `isUnexploredPlaceholder` 门控与未探索灰块渲染（反泄漏约束，spec §5）
- 不引入 `AssetStatus` 状态机（spec §1.2）
- variant 类型从 `@/game/application` 已导出类型**派生**（`NewGameInput["gameType"]`、`TownRenderSnapshot["buildings"][number]["buildingType"]`）；禁止 import `@/game/domain`，禁止为导入修改 facade（spec §3）
- 代码实现分支放 `.worktrees/`（用 using-git-worktrees 技能创建）；完成后从本仓 main 执行 `npm run branch:finish -- <branch>` 收尾
- 门禁：`npm run test:components`、`npm run test:fast`（不含 lint）、`npm run lint`（spec §7.2）

---

### Task 1: Registry 模块 `contentAssets.ts`

**Files:**
- Create: `src/components/contentAssets.ts`
- Test: `src/components/contentAssets.test.ts`

**Interfaces:**
- Consumes: `@/game/application` 导出的 `NewGameInput`、`TownRenderSnapshot`（仅类型）
- Produces（后续任务依赖的精确签名）:
  - `export type GameTypeId = NewGameInput["gameType"]`
  - `export type TownBuildingType = TownRenderSnapshot["buildings"][number]["buildingType"]`
  - `export type ContentAssetKind = "genre_cover" | "town_building"`
  - `export function contentAssetUrl(kind: "genre_cover", variant: GameTypeId): string | null`（重载，共两个签名）
  - `export const CONTENT_ASSET_URLS: readonly string[]`

- [ ] **Step 1: 写失败测试**

创建 `src/components/contentAssets.test.ts`：

```ts
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_ASSET_URLS, contentAssetUrl } from "./contentAssets";

const PUBLIC_DIR = path.join(process.cwd(), "public");

/**
 * 运行时守卫验证别名：绕过重载的编译期 kind↔variant 配对，
 * 直接喂非法输入（对应 JS 调用方 / 无类型边界）。
 */
const lookup = contentAssetUrl as unknown as (
  kind: unknown,
  variant: unknown
) => string | null;

describe("contentAssets registry", () => {
  it("genre_cover：七个题材解析到不变的封面 URL", () => {
    expect(contentAssetUrl("genre_cover", "wuxia")).toBe("/assets/genres/wuxia.jpg");
    expect(contentAssetUrl("genre_cover", "xianxia")).toBe("/assets/genres/xianxia.jpg");
    expect(contentAssetUrl("genre_cover", "fantasy")).toBe("/assets/genres/fantasy.jpg");
    expect(contentAssetUrl("genre_cover", "science_fiction")).toBe("/assets/genres/science_fiction.jpg");
    expect(contentAssetUrl("genre_cover", "urban")).toBe("/assets/genres/urban.jpg");
    expect(contentAssetUrl("genre_cover", "alternate_history")).toBe("/assets/genres/alternate_history.jpg");
    expect(contentAssetUrl("genre_cover", "post_apocalypse")).toBe("/assets/genres/post_apocalypse.jpg");
  });

  it("town_building：八类建筑解析到不变的建筑图 URL", () => {
    expect(contentAssetUrl("town_building", "tavern")).toBe("/assets/town/tavern.webp");
    expect(contentAssetUrl("town_building", "blacksmith")).toBe("/assets/town/blacksmith.webp");
    expect(contentAssetUrl("town_building", "house")).toBe("/assets/town/house.webp");
    expect(contentAssetUrl("town_building", "shop")).toBe("/assets/town/shop.webp");
    expect(contentAssetUrl("town_building", "workshop")).toBe("/assets/town/workshop.webp");
    expect(contentAssetUrl("town_building", "warehouse")).toBe("/assets/town/warehouse.webp");
    expect(contentAssetUrl("town_building", "well")).toBe("/assets/town/well.webp");
    expect(contentAssetUrl("town_building", "gatehouse")).toBe("/assets/town/gatehouse.webp");
  });

  it("非法 kind / variant / 非字符串输入一律返回 null（不抛错）", () => {
    expect(lookup("genre_cover", "steampunk")).toBeNull();
    expect(lookup("town_building", "castle")).toBeNull();
    expect(lookup("npc_portrait", "wuxia")).toBeNull();
    expect(lookup(undefined, undefined)).toBeNull();
    expect(lookup("genre_cover", 42)).toBeNull();
    expect(lookup(null, "wuxia")).toBeNull();
  });

  it("registry 引用的文件必须真实存在于 public/", () => {
    // 长度下限防止清单意外清空导致循环空转通过
    expect(CONTENT_ASSET_URLS.length).toBeGreaterThanOrEqual(15);
    for (const url of CONTENT_ASSET_URLS) {
      expect(url.startsWith("/")).toBe(true);
      expect(existsSync(path.join(PUBLIC_DIR, url))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/contentAssets.test.ts`
Expected: FAIL —— `Error: Failed to resolve import "./contentAssets"`（模块尚不存在）

- [ ] **Step 3: 实现最小 registry**

创建 `src/components/contentAssets.ts`：

```ts
import type { NewGameInput, TownRenderSnapshot } from "@/game/application";

// ---------------------------------------------------------------------------
// 内容位图片 registry（spec: docs/superpowers/specs/2026-09-07-content-asset-registry-design.md）。
// kind × variant → 本地静态图片 URL 的唯一登记处。纯数据查表：无副作用、无状态、
// 不拼接路径。非法 kind/variant 一律返回 null，由调用方渲染既有视觉兜底
// （SVG/色块/表面色），保证「图片不可用时游戏完全可用」。
// 未来 AI 预生成资产按生图文档 §3 图片位总表逐 kind 增补；运行时生图的
// AssetStatus 状态机届时在查表接口外层包裹，本模块签名不变。
// ---------------------------------------------------------------------------

/** UI 层经 application 门面派生题材类型（禁止直连 domain）。 */
export type GameTypeId = NewGameInput["gameType"];
export type TownBuildingType = TownRenderSnapshot["buildings"][number]["buildingType"];

export type ContentAssetKind = "genre_cover" | "town_building";

/** 新游戏题材卡封面（原 NewGameSetupForm 的 GAME_TYPE_BACKGROUNDS，等价迁移）。 */
const GENRE_COVERS: Readonly<Record<GameTypeId, string>> = {
  wuxia: "/assets/genres/wuxia.jpg",
  xianxia: "/assets/genres/xianxia.jpg",
  fantasy: "/assets/genres/fantasy.jpg",
  science_fiction: "/assets/genres/science_fiction.jpg",
  urban: "/assets/genres/urban.jpg",
  alternate_history: "/assets/genres/alternate_history.jpg",
  post_apocalypse: "/assets/genres/post_apocalypse.jpg",
};

/** 小镇建筑俯视图（原 TownMapSvg 的 BUILDING_ART，等价迁移）。 */
const TOWN_BUILDINGS: Readonly<Record<TownBuildingType, string>> = {
  tavern: "/assets/town/tavern.webp",
  blacksmith: "/assets/town/blacksmith.webp",
  house: "/assets/town/house.webp",
  shop: "/assets/town/shop.webp",
  workshop: "/assets/town/workshop.webp",
  warehouse: "/assets/town/warehouse.webp",
  well: "/assets/town/well.webp",
  gatehouse: "/assets/town/gatehouse.webp",
};

/** kind → variant → URL 的运行时总表（守卫查表用；新增 kind 在此登记）。 */
const KIND_TABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  genre_cover: GENRE_COVERS,
  town_building: TOWN_BUILDINGS,
};

/** registry 内登记的全部 URL（fs 存在性测试用）。 */
export const CONTENT_ASSET_URLS: readonly string[] = Object.values(KIND_TABLE).flatMap(
  (table) => Object.values(table),
);

/**
 * 查表取内容位图片 URL。重载在编译期锁定 kind↔variant 配对；运行期
 * 白名单守卫（Object.hasOwn 防原型链键）拒绝一切非法输入并返回 null——
 * 不抛错、不拼接路径。查不到时调用方渲染既有视觉兜底。
 */
export function contentAssetUrl(kind: "genre_cover", variant: GameTypeId): string | null;
export function contentAssetUrl(kind: "town_building", variant: TownBuildingType): string | null;
export function contentAssetUrl(kind: unknown, variant: unknown): string | null {
  if (typeof kind !== "string" || typeof variant !== "string") return null;
  const table = Object.hasOwn(KIND_TABLE, kind) ? KIND_TABLE[kind] : undefined;
  if (table === undefined || !Object.hasOwn(table, variant)) return null;
  return table[variant] ?? null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/contentAssets.test.ts`
Expected: PASS（4 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/components/contentAssets.ts src/components/contentAssets.test.ts
git commit -m "feat(components): 新增内容位图片 registry（kind×variant 查表 + 白名单守卫）"
```

---

### Task 2: 降级组件 `ContentAssetImage`

**Files:**
- Create: `src/components/ContentAssetImage.tsx`
- Test: `src/components/ContentAssetImage.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `contentAssetUrl`（重载）与 `GameTypeId` / `TownBuildingType` 类型
- Produces: `export function ContentAssetImage(props: ContentAssetImageProps)`——props 为判别联合（`kind` 判别），字段：`kind` / `variant` / `alt: string` / `decorative?: boolean` / `fallback: ReactNode` / `className?: string`。v1 无生产消费者（spec §4），以测试覆盖。

- [ ] **Step 1: 写失败测试（vi.mock 隔离 registry 数据）**

创建 `src/components/ContentAssetImage.test.tsx`：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContentAssetImage } from "./ContentAssetImage";

// 组件单测隔离 registry 数据：mock 查表函数——仅 wuxia 题材有图，其余一律 null。
vi.mock("./contentAssets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./contentAssets")>();
  return {
    ...actual,
    contentAssetUrl: vi.fn((kind: unknown, variant: unknown) =>
      kind === "genre_cover" && variant === "wuxia"
        ? "/assets/genres/wuxia.jpg"
        : null,
    ),
  };
});

describe("ContentAssetImage", () => {
  it("有图：渲染 <img>（role=img + alt + src）", () => {
    render(
      <ContentAssetImage
        kind="genre_cover"
        variant="wuxia"
        alt="武侠封面"
        fallback={<p>兜底</p>}
      />,
    );
    const img = screen.getByRole("img", { name: "武侠封面" });
    expect(img).toHaveAttribute("src", "/assets/genres/wuxia.jpg");
  });

  it("无图：直接渲染 fallback，不渲染 img", () => {
    render(
      <ContentAssetImage
        kind="town_building"
        variant="tavern"
        alt="酒馆"
        fallback={<p data-testid="fallback">兜底</p>}
      />,
    );
    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("加载失败：onError 后切换为 fallback", () => {
    render(
      <ContentAssetImage
        kind="genre_cover"
        variant="wuxia"
        alt="武侠封面"
        fallback={<p data-testid="fallback">兜底</p>}
      />,
    );
    expect(screen.getByRole("img", { name: "武侠封面" })).toBeInTheDocument();

    fireEvent.error(screen.getByRole("img", { name: "武侠封面" }));

    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("decorative：aria-hidden 且不带 role=img", () => {
    const { container } = render(
      <ContentAssetImage
        kind="genre_cover"
        variant="wuxia"
        alt=""
        decorative
        fallback={<p>兜底</p>}
      />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(img).not.toHaveAttribute("role");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/ContentAssetImage.test.tsx`
Expected: FAIL —— `Error: Failed to resolve import "./ContentAssetImage"`（模块尚不存在）

- [ ] **Step 3: 实现组件**

创建 `src/components/ContentAssetImage.tsx`：

```tsx
"use client";

import { useState, type ReactNode } from "react";
import { contentAssetUrl, type GameTypeId, type TownBuildingType } from "./contentAssets";

// ---------------------------------------------------------------------------
// 内容位 DOM 图片组件（spec §4）：registry 查表结果 + onError 多级降级入口。
// 查表 null → 直接渲染 fallback（SSR 稳定）；有图 → <img>，客户端加载失败
// 切回 fallback。可访问性对齐 adventureVisuals 现行模式：非装饰用
// role="img" + alt；装饰用 aria-hidden，可访问名称由相邻文本提供。
// ---------------------------------------------------------------------------

type ContentAssetImageProps = {
  readonly alt: string;
  readonly decorative?: boolean;
  readonly fallback: ReactNode;
  readonly className?: string;
} & (
  | { readonly kind: "genre_cover"; readonly variant: GameTypeId }
  | { readonly kind: "town_building"; readonly variant: TownBuildingType }
);

export function ContentAssetImage({
  kind,
  variant,
  alt,
  decorative = false,
  fallback,
  className,
}: ContentAssetImageProps) {
  const url =
    kind === "genre_cover"
      ? contentAssetUrl("genre_cover", variant)
      : contentAssetUrl("town_building", variant);
  // 记录加载失败的 src：variant 变化时新 URL 不受旧失败影响。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (url === null || failedSrc === url) {
    return <>{fallback}</>;
  }

  return (
    <img
      src={url}
      alt={alt}
      className={className}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      onError={() => setFailedSrc(url)}
    />
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/ContentAssetImage.test.tsx`
Expected: PASS（4 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/components/ContentAssetImage.tsx src/components/ContentAssetImage.test.tsx
git commit -m "feat(components): 新增 ContentAssetImage 内容位降级组件"
```

---

### Task 3: 题材卡封面迁入 registry（NewGameSetupForm）

**Files:**
- Modify: `src/components/NewGameSetupForm.tsx`（删除 `GAME_TYPE_BACKGROUNDS` 常量块 L109-118，改 map 回调 L427-445，新增一行 import）
- Test: `src/components/NewGameSetupForm.test.tsx`（新增等价锁定测试）

**Interfaces:**
- Consumes: Task 1 的 `contentAssetUrl("genre_cover", type.id)`（`GAME_TYPES` 的 `id` 经 `satisfies` 约束为 `NewGameInput["gameType"]`，类型直接匹配）
- Produces: 无（渲染保持 next/image `fill`/`sizes`/`priority` 不变；registry 返回 null 时条件渲染跳过 `<Image>`，露出 `.game-type-card--visual` 自身背景）

- [ ] **Step 1: 先加等价锁定测试（重构前基线）**

在 `src/components/NewGameSetupForm.test.tsx` 的 `describe("NewGameSetupForm canonical contract", ...)` 块末尾（第三个 `it` 之后）新增：

```tsx
  it("题材卡封面仍渲染 7 张题材图（registry 等价迁移锁定）", () => {
    const { container } = render(<NewGameSetupForm onCreated={vi.fn()} />);
    const imgs = [...container.querySelectorAll(".game-type-card--visual img")];
    expect(imgs).toHaveLength(7);
    const srcs = imgs.map((img) => img.getAttribute("src") ?? "").join("\n");
    for (const id of [
      "wuxia",
      "xianxia",
      "fantasy",
      "science_fiction",
      "urban",
      "alternate_history",
      "post_apocalypse",
    ]) {
      // raw 形式含 "/assets/genres/wuxia.jpg"，loader 形式含编码后的同路径
      expect(srcs).toContain(id);
    }
  });
```

- [ ] **Step 2: 运行测试确认通过（基线）**

Run: `npx vitest run src/components/NewGameSetupForm.test.tsx`
Expected: PASS——新测试在现有 `GAME_TYPE_BACKGROUNDS` 实现下即通过（证明测试本身有效）

- [ ] **Step 3: 等价重构**

3a. 在 import 区（`import { AdventureVisual, ADVENTURE_THEMES } from "./adventureVisuals";` 之后）加：

```tsx
import { contentAssetUrl } from "./contentAssets";
```

3b. 删除 `GAME_TYPE_BACKGROUNDS` 常量块（连同其 JSDoc 注释，原 L109-118）：

```tsx
/** 每个题材对应的本地背景图路径（游戏开始配置页的题材选择卡片用）。 */
const GAME_TYPE_BACKGROUNDS: Record<NewGameInput["gameType"], string> = {
  wuxia: "/assets/genres/wuxia.jpg",
  xianxia: "/assets/genres/xianxia.jpg",
  fantasy: "/assets/genres/fantasy.jpg",
  science_fiction: "/assets/genres/science_fiction.jpg",
  urban: "/assets/genres/urban.jpg",
  alternate_history: "/assets/genres/alternate_history.jpg",
  post_apocalypse: "/assets/genres/post_apocalypse.jpg"
};
```

3c. 把题材卡 map 回调（原简洁箭头改为块体，计算 `coverUrl` 并条件渲染 `<Image>`）：

```tsx
            {GAME_TYPES.map((type) => {
              const coverUrl = contentAssetUrl("genre_cover", type.id);
              return (
                <label
                  key={type.id}
                  className={`game-type-card${gameType === type.id ? " game-type-card--selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="gameType"
                    value={type.id}
                    checked={gameType === type.id}
                    onChange={() => handleGameTypeChange(type.id)}
                  />
                  <span className="game-type-card--visual" aria-hidden="true">
                    {coverUrl !== null && (
                      <Image src={coverUrl} alt="" fill sizes="220px" priority={type.id === DEFAULT_GAME_TYPE} />
                    )}
                  </span>
                  <strong>{type.label}</strong>
                  <span>{type.hint}</span>
                </label>
              );
            })}
```

（`<input>`/`<strong>`/`<span>` 的属性与原实现逐字一致，只是整体挪进块体 return。）

- [ ] **Step 4: 运行测试 + 类型检查确认通过**

Run: `npx vitest run src/components/NewGameSetupForm.test.tsx && npx tsc --noEmit`
Expected: 测试 PASS（含 Step 1 新增的等价锁定测试）；typecheck 无错误

- [ ] **Step 5: 提交**

```bash
git add src/components/NewGameSetupForm.tsx src/components/NewGameSetupForm.test.tsx
git commit -m "refactor(components): 题材卡封面迁入内容位 registry（等价重构）"
```

---

### Task 4: 小镇建筑图迁入 registry（TownMapSvg）

**Files:**
- Modify: `src/components/town/TownMapSvg.tsx`（删除 `TownBuildingType` 本地类型与 `BUILDING_ART` 常量 L17-28，改 L164 href，新增一行 import）
- Test: 既有 `src/components/TownLayerScreen.test.tsx`（L77 已断言 `image[href="/assets/town/${buildingType}.webp"]`，不新增测试）

**Interfaces:**
- Consumes: Task 1 的 `contentAssetUrl("town_building", building.buildingType)`
- Produces: 无（SVG `<image>` 渲染方式不变；`isUnexploredPlaceholder` 门控与未探索灰块渲染**一字不动**）

- [ ] **Step 1: 运行既有测试确认基线通过**

Run: `npx vitest run src/components/TownLayerScreen.test.tsx`
Expected: PASS（含 L77 的精确 URL 断言——重构后该断言不破即为等价证明）

- [ ] **Step 2: 等价重构**

2a. 在 `import { tileIndex, type TileType, type TownRenderSnapshot } from "@/game/application";` 之后加：

```tsx
import { contentAssetUrl } from "../contentAssets";
```

2b. 删除本地类型与常量（原 L17-28）：

```tsx
type TownBuildingType = TownRenderSnapshot["buildings"][number]["buildingType"];

const BUILDING_ART: Record<TownBuildingType, string> = {
  tavern: "/assets/town/tavern.webp",
  blacksmith: "/assets/town/blacksmith.webp",
  house: "/assets/town/house.webp",
  shop: "/assets/town/shop.webp",
  workshop: "/assets/town/workshop.webp",
  warehouse: "/assets/town/warehouse.webp",
  well: "/assets/town/well.webp",
  gatehouse: "/assets/town/gatehouse.webp",
};
```

2c. 建筑图层里唯一一行改动（原 L164）：

```tsx
              href={contentAssetUrl("town_building", building.buildingType) ?? undefined}
```

（`?? undefined`：查不到时省略 href 属性，`<image>` 不渲染，底层 `TILE_FILL` 色块天然兜底。`isUnexploredPlaceholder` 门控行与灰块渲染保持原样。）

- [ ] **Step 3: 运行测试 + 类型检查确认通过**

Run: `npx vitest run src/components/TownLayerScreen.test.tsx && npx tsc --noEmit`
Expected: 测试 PASS（URL 断言不变）；typecheck 无错误

- [ ] **Step 4: 提交**

```bash
git add src/components/town/TownMapSvg.tsx
git commit -m "refactor(components): 小镇建筑图迁入内容位 registry（等价重构）"
```

---

### Task 5: 全量门禁与文档更新

**Files:**
- Modify: `docs/AI生图资产制作参考.md`（§1 当前视觉实现）
- Modify: `docs/Agent文档索引.md`（视觉资产与 AI 生图参考行）

**Interfaces:**
- Consumes: 前四个任务的全部产物
- Produces: 无

- [ ] **Step 1: 运行全量门禁**

Run: `npm run test:components && npm run test:fast && npm run lint`
Expected: 全部 PASS（`test:fast` 含 check:standards / typecheck / boundaries，不含 lint，故单独跑 lint）

- [ ] **Step 2: 更新 `docs/AI生图资产制作参考.md` §1**

把 §1 当前视觉实现的前两个列表项：

```markdown
- 新游戏页使用 `public/assets/genres/` 的 7 张题材封面 JPG。
- 小镇地图复用 `public/assets/town/` 的 8 张静态建筑 WebP；它们来自历史预设图，不是运行时生成。
```

改为：

```markdown
- 新游戏页使用 `public/assets/genres/` 的 7 张题材封面 JPG，URL 经内容位 registry（`src/components/contentAssets.ts` 的 `genre_cover`）解析。
- 小镇地图复用 `public/assets/town/` 的 8 张静态建筑 WebP，URL 经内容位 registry（`town_building`）解析；它们来自历史预设图，不是运行时生成。
- 静态内容位图统一走 registry 查表（kind × variant → URL，非法输入返回 null）；查不到或加载失败一律回退既有视觉（DOM 组件 `ContentAssetImage` 为标准降级入口）。未来 AI 预生成资产按 §3 图片位总表逐 kind 增补。
```

- [ ] **Step 3: 更新 `docs/Agent文档索引.md` 视觉资产行**

把「视觉资产与 AI 生图参考」行的说明结尾（原文「…小镇当前只复用静态历史预设图」）改为：

```markdown
小镇当前只复用静态历史预设图；静态内容位图（题材封面/小镇建筑）统一经 `src/components/contentAssets.ts` registry 查表解析，非法输入返回 null、加载失败回退既有视觉（2026-09-08）
```

- [ ] **Step 4: 提交文档**

```bash
git add docs/AI生图资产制作参考.md docs/Agent文档索引.md
git commit -m "docs: 记录内容位 registry 实现事实"
```

- [ ] **Step 5: 人工验收（交给用户，实现完成后执行）**

- dev server（`npm run dev`）：新游戏页 7 张题材卡封面正常显示；进入小镇地图建筑图正常、未探索建筑仍为灰块。
- 降级验收（spec §7.3）：临时移走 `public/assets/genres/` 与 `public/assets/town/` 后刷新——题材卡露出卡片表面色背景、小镇露出色块，全流程可玩；验收后还原资产目录。

---

## 自查记录（Self-Review）

1. **Spec 覆盖**：§1.1 范围内五项产物 → Task 1（registry+测试）、Task 2（组件+测试）、Task 3/4（两个接入点）；§3 查表签名与守卫 → Task 1；§4 组件行为（fallback/onError/可访问性双模式）→ Task 2 测试四例对应；§5 接入点与迁移约束（next/image 条件渲染、探索门控不动）→ Task 3/4；§7.1 自动化测试 → Task 1/2 新增 + Task 3/4 既有断言验证；§7.2 门禁 → Task 5 Step 1；§7.3 人工验收 → Task 5 Step 5。文档更新超出 spec 范围，源自工作区规则（实现事实变化须更新 docs），合理。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；「Similar to Task N」未出现。
3. **类型一致性**：`contentAssetUrl` 重载签名在 Task 1（定义）、Task 2/3/4（调用）一致；`GameTypeId`/`TownBuildingType` 从 Task 1 导出、Task 2 组件 props 消费；`CONTENT_ASSET_URLS` 在 Task 1 定义并被同任务测试消费。
