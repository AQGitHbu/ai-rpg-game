# RPG 图片展示框架 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 RPG UI 中建立预制图片和未来实时生图结果共用的展示框架，完成题材封面、小镇屋顶、地点背景和 NPC 立绘四个入口的加载、降级与展示期稳定性。

**Architecture:** application 只定义可选的安全图片视图；RPG manifest 管理题材模板，纯解析器合并实例绑定、旧图与模板。DOM/SVG 渲染器共用展示期固定候选和 load/error 逻辑，API 状态变化只在下一次进入时采用；真实 provider、存储和异步请求协调属于后续服务计划。

**Tech Stack:** 本仓 Next.js 16.2.10、React 19.1.0、TypeScript 5.8.3、Vitest 3.1.4、Testing Library、jsdom；Node >=20.9.0、npm >=10.0.0。无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-07-content-asset-registry-design.md`

**状态：** 2026-09-08 review 后待执行。本次只修订文档；下面的 checkbox 均代表尚未落到生产仓库的工作。此功能独立于当前 MVP Plan 5，不运行 phase:start，不修改 current-phase.json。

## Global Constraints

- 不新增真实生图 provider、API route、轮询、队列、数据库表或持久化字段。
- 不修改 domain、gameplay、行动、叙事生成、CAS、存档版本或当前 MVP 阶段指针。
- `src/game/**` 只允许新增纯展示 DTO、修改 application facade 和 `GameSessionView` 的可选类型字段及相应测试；不改变 projector 的生产输出。
- 不修改 `@ai-game/*`、`.foundation`、sibling 仓库、依赖版本或测试配置；RPG 资产语义留在本仓。
- 不新增、移动或删除图片文件；保留既有 15 个 URL，建筑图只在明确匹配的题材中使用。
- UI 只经 `@/game/application` 消费游戏类型；不导入 domain、gameplay 或 server 私有模块。
- 图片加载、失败和生成状态不修改游戏 busy、叙事 pending、Action 或可操作入口。
- 未探索剧情建筑在解析候选前就退出；不得产生其专属图片、真实类型 DOM 属性或预加载请求。
- 同一展示期不因 API 状态更新、游戏 revision、对白分页或输入变化采用新图片版本。
- 图片 URL 只接受 `/assets/` 下无查询参数的同源 PNG/JPEG/WebP/AVIF 路径；不接受 provider URL、data/blob URL、任意远端地址或 SVG 文件。

- 实现分支放 `.worktrees/`；不用 git checkout。合并从本仓 main 运行 `npm run branch:merge -- codex/content-asset-registry`，已合入只收尾时运行 `npm run branch:finish -- codex/content-asset-registry`。不得直接递归删除 worktree/.foundation。
- 实现事实只在完成验收后写入 docs/agent 和索引；不得提前宣称已有真实 API 生图。

## 执行准备与文件责任

先读 Spec、游戏开发规范、Agent 索引和地图/小镇系统文档。同一任务已读的不重复加载。本次共享职责核对结论：现有 @ai-game/ui 只提供结构原语，未覆盖 RPG 图片位、题材和实体绑定，故不扩包或跨仓修改。

- [ ] 从干净 main 建实现 worktree；若路径或分支已存在，先检查，不覆盖。若读到的实现事实与本 Plan 不同，先调整相关任务再改代码。

```bash
git status --short
git worktree list
git worktree add .worktrees/content-asset-registry -b codex/content-asset-registry main
```

在新 worktree 按项目规范运行 `npm run setup`；只在该工作目录执行后续命令。首次基线运行 `npm run test:components` 与 `npm run test:fast`，失败先记录并区分既有问题。当前已核对基线提交为 `19aa640`，不是要求执行者回退到该提交。

| 文件 | 单一责任 |
|---|---|
| src/game/application/contentAssetView.ts | 纯展示 DTO，无 I/O、provider 或领域状态 |
| src/game/application/gameSessionView.ts / index.ts | 可选 visualAssets 类型字段与 type-only facade 出口 |
| src/components/contentAssets.ts | 静态 manifest、白名单、绑定/候选解析及展示键 helper |
| src/components/useContentAsset.ts | 一次展示期的浏览器加载/失败状态，无网络请求或生成状态写入 |
| src/components/ContentAssetImage.tsx | 有固定框的 next/image 渲染与占位可访问性 |
| src/components/ContentAssetSvgImage.tsx | 原生 SVG image 渲染与显式错误移除 |
| NewGameSetupForm / TownLayerScreen / town/TownMapSvg | 现有预制图迁移、题材路由和未探索门控 |
| LocationSceneScreen / NpcDialogueOverlay / AdventureGameShell | 安全实例绑定与图片展示期边界 |
| src/app/globals.css | 图片框、人物比例与既有布局适配 |
| docs/agent/图片展示框架.md、地图/小镇文档、索引、生图参考 | 验收后的实现事实，不改玩法或阶段指针 |

所有新模块有同目录测试；下面列出的测试是必须实施的行为合同，不能删成只断言组件存在。先完成一个 Task 的测试/实现/复核再提交；未经要求不合并或推送。

---

### Task 1: 安全展示合同与候选解析闭环

**Files:**
- Create: `src/game/application/contentAssetView.ts`
- Modify: `src/game/application/gameSessionView.ts`（GameSessionView 类型和 type import）
- Modify: `src/game/application/index.ts`（仅 type export）
- Create: `src/components/contentAssets.ts`
- Test: `src/game/application/contentAssetView.test.ts`
- Test: `src/components/contentAssets.test.ts`
- Modify/Test: `src/dependencyBoundaries.test.ts`

**Interfaces:**
- Consumes: application facade 的 `NewGameInput`、`TownRenderSnapshot`。
- Produces: `ContentAssetImageView`、`ContentAssetState`、`ContentAssetBindingView`、`GameVisualAssetsView`；`GameSessionView.visualAssets?: GameVisualAssetsView`。
- Produces: `ContentAssetQuery`、`ContentAssetManifestEntry`、`ContentAssetInput`、`CONTENT_ASSET_MANIFEST`；`resolveContentAssetCandidates(query, binding?, manifest?): readonly ContentAssetImageView[]`、`normalizeAssetGameType(value: unknown): GameTypeId | "generic"`、`usableVisualAssets(visuals?): GameVisualAssetsView | undefined`、`ownAssetBinding(entries, key): ContentAssetBindingView | undefined`、`assetPresentationKey(scope, query, subject, bindingKey?): string`。完整类型以下列代码为准。

- [ ] **Step 1: 写失败测试。** 分别创建下面两个测试文件。

`src/game/application/contentAssetView.test.ts`：

```ts
import { expectTypeOf, it } from "vitest";
import type { ContentAssetState, ContentAssetImageView, GameSessionView, GameVisualAssetsView } from "@/game/application";

it("requires a usable image at ready/stale and keeps the optional extension off old views", () => {
  expectTypeOf<Extract<ContentAssetState, { status: "ready" }>["image"]>().toEqualTypeOf<ContentAssetImageView>();
  expectTypeOf<Extract<ContentAssetState, { status: "stale" }>["image"]>().toEqualTypeOf<ContentAssetImageView>();
  expectTypeOf<GameSessionView["visualAssets"]>().toEqualTypeOf<GameVisualAssetsView | undefined>();
  // @ts-expect-error ready is not a URL-free success state
  const bad: ContentAssetState = { status: "ready" };
  void bad;
});
```

`src/components/contentAssets.test.ts`：

```ts
import { statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentAssetBindingView, ContentAssetImageView, ContentAssetState } from "@/game/application";
import {
  CONTENT_ASSET_MANIFEST, isContentAssetImage, normalizeAssetGameType, ownAssetBinding,
  resolveContentAssetCandidates, usableVisualAssets, type ContentAssetManifestEntry, type ContentAssetQuery,
} from "./contentAssets";

const query = { kind: "npc_portrait", gameType: "wuxia", variant: "neutral" } as const;
const image = (name: string): ContentAssetImageView => ({
  assetId: name, version: "1", src: `/assets/test/${name}.webp`, width: 768, height: 1024, source: "generated",
});
const binding = (state: ContentAssetState): ContentAssetBindingView => ({
  ...query, bindingKey: "opaque-npc-a", requestKey: "opaque-request-1", ...state,
});
const templates: readonly ContentAssetManifestEntry[] = [
  { ...query, image: image("theme") },
  { ...query, gameType: "generic", image: image("generic") },
];

describe("content asset resolution", () => {
  it("registers 23 distinct queries referencing 15 nonempty local files", () => {
    const keys = CONTENT_ASSET_MANIFEST.map(({ kind, gameType, variant }) => JSON.stringify([kind, gameType, variant]));
    expect(keys).toHaveLength(23);
    expect(new Set(keys).size).toBe(keys.length);
    const urls = new Set(CONTENT_ASSET_MANIFEST.map((entry) => entry.image.src));
    expect(urls.size).toBe(15);
    for (const entry of CONTENT_ASSET_MANIFEST) {
      expect(isContentAssetImage(entry.image)).toBe(true);
      const file = statSync(path.join(process.cwd(), "public", entry.image.src.slice(1)));
      expect(file.isFile()).toBe(true);
      expect(file.size).toBeGreaterThan(0);
      expect([entry.image.width, entry.image.height]).toEqual(entry.kind === "genre_cover" ? [1368, 768] : [512, 512]);
    }
    for (const genre of ["wuxia", "xianxia", "fantasy", "science_fiction", "urban", "alternate_history", "post_apocalypse"] as const) {
      expect(resolveContentAssetCandidates({ kind: "genre_cover", gameType: genre, variant: "default" })[0]?.src)
        .toBe(`/assets/genres/${genre}.jpg`);
    }
    for (const variant of ["tavern", "blacksmith", "house", "shop", "workshop", "warehouse", "well", "gatehouse"] as const) {
      expect(resolveContentAssetCandidates({ kind: "town_building", gameType: "wuxia", variant })[0]?.src)
        .toBe(`/assets/town/${variant}.webp`);
    }
  });
  it.each(["science_fiction", "urban", "fantasy", "alternate_history", "post_apocalypse", "generic"] as const)("does not use Chinese roofs for %s", (gameType) => {
    expect(resolveContentAssetCandidates({ kind: "town_building", variant: "tavern", gameType })).toEqual([]);
  });
  it.each([undefined, null, "__proto__", "constructor", "toString", 42])("rejects invalid game type %s", (value) => {
    expect(normalizeAssetGameType(value)).toBe("generic");
    expect(resolveContentAssetCandidates({ ...query, gameType: value } as ContentAssetQuery)).toEqual([]);
  });
  it("rejects invalid kind/variant, binding mismatch and inherited map keys", () => {
    for (const patch of [{ kind: "__proto__" }, { kind: "invented" }, { variant: "constructor" }]) {
      expect(resolveContentAssetCandidates({ ...query, ...patch } as ContentAssetQuery)).toEqual([]);
    }
    expect(resolveContentAssetCandidates(query, { ...binding({ status: "ready", image: image("wrong") }), variant: "angry" })).toEqual([]);
    expect(ownAssetBinding({}, "toString")).toBeUndefined();
    expect(usableVisualAssets({ scopeKey: "" })).toBeUndefined();
  });
  it.each([
    "https://provider.example/image.png", "//host/image.png", "data:image/png;base64,x",
    "blob:abc", "/assets/../private.png", "/assets/%2e%2e/private.png", "/assets/a.svg",
    "/assets/a.webp?token=secret", "/assets/a.webp#fragment", "",
  ])("rejects unsafe URL %s", (src) => expect(isContentAssetImage({ ...image("a"), src })).toBe(false));
  it("rejects invalid dimensions and empty identity", () => {
    for (const patch of [{ width: 0 }, { height: NaN }, { width: 0.5 }, { assetId: "" }, { version: " " }]) {
      expect(isContentAssetImage({ ...image("a"), ...patch })).toBe(false);
    }
  });
  it("orders current, previous, genre, generic and removes duplicate URLs", () => {
    const current = image("current");
    expect(resolveContentAssetCandidates(query, binding({ status: "ready", image: current, previous: image("old") }), templates)
      .map((entry) => entry.assetId)).toEqual(["current", "old", "theme", "generic"]);
    expect(resolveContentAssetCandidates(query, binding({ status: "ready", image: current, previous: current }), [])).toEqual([current]);
  });
  it.each(["queued", "generating", "failed"] as const)("%s preserves same-binding previous image", (status) => {
    expect(resolveContentAssetCandidates(query, binding({ status, previous: image("old") }), templates)
      .map((entry) => entry.assetId)).toEqual(["old", "theme", "generic"]);
  });
  it("handles not_requested, stale and unusable ready images", () => {
    expect(resolveContentAssetCandidates(query, binding({ status: "not_requested" }), templates).map((entry) => entry.assetId)).toEqual(["theme", "generic"]);
    expect(resolveContentAssetCandidates(query, binding({ status: "stale", image: image("old") }), templates)[0]?.assetId).toBe("old");
    expect(resolveContentAssetCandidates(query, binding({ status: "ready", image: { ...image("bad"), src: "https://x.test/a.webp" } }), templates)[0]?.assetId).toBe("theme");
  });
});
```

在 `src/dependencyBoundaries.test.ts` 新增以下合同。这里使用该文件已存在的 sourceRoot/readFileSync/resolve/extractSpecifiers，生产 DTO 必须无 import，facade 必须 type-only 转发它：

```ts
it("content asset DTO is pure and enters the browser only as a facade type", () => {
  const dto = readFileSync(resolve(sourceRoot, "game/application/contentAssetView.ts"), "utf8");
  expect(extractSpecifiers(dto)).toEqual([]);
  const facade = readFileSync(resolve(sourceRoot, "game/application/index.ts"), "utf8");
  expect(facade).toMatch(/export\s+type\s*\{[^}]*ContentAssetImageView[^}]*\}\s*from\s*["']\.\/contentAssetView["']/s);
});
```

- [ ] **Step 2: 运行并确认失败。**

Run: `npx vitest run src/components/contentAssets.test.ts src/game/application/contentAssetView.test.ts src/dependencyBoundaries.test.ts`
Expected: 新模块缺失/新的 facade 合同失败；不能把既有不相关失败当作预期红灯。Vitest 不检查 @ts-expect-error；后面的 typecheck 必须执行。

- [ ] **Step 3: 建立纯 DTO 和可选 facade 字段。**

`src/game/application/contentAssetView.ts`：

```ts
export type ContentAssetKind =
  | "genre_cover" | "town_building" | "location_backdrop" | "npc_portrait";

export type ContentAssetImageView = {
  readonly assetId: string;
  readonly version: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly source: "static" | "generated";
};

export type ContentAssetState =
  | { readonly status: "not_requested" }
  | { readonly status: "queued" | "generating" | "failed";
      readonly previous?: ContentAssetImageView }
  | { readonly status: "ready"; readonly image: ContentAssetImageView;
      readonly previous?: ContentAssetImageView }
  | { readonly status: "stale"; readonly image: ContentAssetImageView };

export type ContentAssetBindingView = {
  readonly bindingKey: string;
  readonly requestKey: string;
  readonly kind: ContentAssetKind;
  readonly gameType: string;
  readonly variant: string;
} & ContentAssetState;

export type GameVisualAssetsView = {
  readonly scopeKey: string;
  readonly locationBackdrop?: ContentAssetBindingView;
  readonly buildingBackdrops?: Readonly<Record<string, ContentAssetBindingView>>;
  readonly npcPortraits?: Readonly<Record<string, ContentAssetBindingView>>;
  readonly townBuildings?: Readonly<Record<string, ContentAssetBindingView>>;
};
```

在 `src/game/application/gameSessionView.ts` 的 import 区加入 type import，在唯一 GameSessionView 内加入可选字段；不改变 projectGameSessionView 函数、参数或返回表达式：

```ts
import type { GameVisualAssetsView } from "./contentAssetView";
// 在现有 GameSessionView 类型内加入：
readonly visualAssets?: GameVisualAssetsView;
```

在 `src/game/application/index.ts` 追加：

```ts
export type {
  ContentAssetKind, ContentAssetImageView, ContentAssetState,
  ContentAssetBindingView, GameVisualAssetsView,
} from "./contentAssetView";
```

- [ ] **Step 4: 实现静态 manifest 和纯解析器。** 创建 `src/components/contentAssets.ts`。显式 URL 表防路径拼接；gameType/buildingType 的类型断言只用于已经穷举的本地表，外来字符串通过白名单收窄。

```ts
import type {
  ContentAssetBindingView, ContentAssetImageView, GameVisualAssetsView,
  NewGameInput, TownRenderSnapshot,
} from "@/game/application";

export type GameTypeId = NewGameInput["gameType"];
export type TownBuildingType = TownRenderSnapshot["buildings"][number]["buildingType"];
export type ContentAssetQuery = { readonly gameType: GameTypeId | "generic" } & (
  | { readonly kind: "genre_cover" | "location_backdrop"; readonly variant: "default" }
  | { readonly kind: "npc_portrait"; readonly variant: "neutral" }
  | { readonly kind: "town_building"; readonly variant: TownBuildingType }
);
export type ContentAssetManifestEntry = ContentAssetQuery & {
  readonly image: ContentAssetImageView;
};
export type ContentAssetInput = {
  readonly query: ContentAssetQuery;
  readonly binding?: ContentAssetBindingView;
  readonly presentationKey: string;
};

const GENRE_COVERS = {
  wuxia: "/assets/genres/wuxia.jpg",
  xianxia: "/assets/genres/xianxia.jpg",
  fantasy: "/assets/genres/fantasy.jpg",
  science_fiction: "/assets/genres/science_fiction.jpg",
  urban: "/assets/genres/urban.jpg",
  alternate_history: "/assets/genres/alternate_history.jpg",
  post_apocalypse: "/assets/genres/post_apocalypse.jpg",
} as const satisfies Record<GameTypeId, string>;
const TOWN_BUILDINGS = {
  tavern: "/assets/town/tavern.webp",
  blacksmith: "/assets/town/blacksmith.webp",
  house: "/assets/town/house.webp",
  shop: "/assets/town/shop.webp",
  workshop: "/assets/town/workshop.webp",
  warehouse: "/assets/town/warehouse.webp",
  well: "/assets/town/well.webp",
  gatehouse: "/assets/town/gatehouse.webp",
} as const satisfies Record<TownBuildingType, string>;

export function normalizeAssetGameType(value: unknown): GameTypeId | "generic" {
  return typeof value === "string" && Object.hasOwn(GENRE_COVERS, value)
    ? value as GameTypeId : "generic";
}
function validQuery(query: ContentAssetQuery): boolean {
  if (!query || (query.gameType !== "generic" && normalizeAssetGameType(query.gameType) === "generic")) return false;
  switch (query.kind) {
    case "genre_cover": case "location_backdrop": return query.variant === "default";
    case "npc_portrait": return query.variant === "neutral";
    case "town_building": return typeof query.variant === "string" && Object.hasOwn(TOWN_BUILDINGS, query.variant);
    default: return false;
  }
}
function staticImage(assetId: string, src: string, width: number, height: number): ContentAssetImageView {
  return { assetId, src, width, height, version: "1", source: "static" };
}
export const CONTENT_ASSET_MANIFEST: readonly ContentAssetManifestEntry[] = [
  ...Object.entries(GENRE_COVERS).map(([gameType, src]) => ({
    kind: "genre_cover" as const, gameType: gameType as GameTypeId, variant: "default" as const,
    image: staticImage(`genre-${gameType}`, src, 1368, 768),
  })),
  ...(["wuxia", "xianxia"] as const).flatMap((gameType) =>
    Object.entries(TOWN_BUILDINGS).map(([variant, src]) => ({
      kind: "town_building" as const, gameType, variant: variant as TownBuildingType,
      image: staticImage(`legacy-roof-${variant}`, src, 512, 512),
    })),
  ),
];

// 同源路径合同：目录不可出现点段、编码或查询参数；版本点号只出现在文件名。
export function isContentAssetImage(value: unknown): value is ContentAssetImageView {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<ContentAssetImageView>;
  return typeof item.assetId === "string" && item.assetId.trim().length > 0
    && typeof item.version === "string" && item.version.trim().length > 0
    && typeof item.width === "number" && Number.isSafeInteger(item.width) && item.width > 0
    && typeof item.height === "number" && Number.isSafeInteger(item.height) && item.height > 0
    && (item.source === "static" || item.source === "generated")
    && typeof item.src === "string"
    && /^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:png|jpe?g|webp|avif)$/.test(item.src);
}

export function resolveContentAssetCandidates(
  query: ContentAssetQuery,
  binding?: ContentAssetBindingView,
  manifest: readonly ContentAssetManifestEntry[] = CONTENT_ASSET_MANIFEST,
): readonly ContentAssetImageView[] {
  if (!validQuery(query)) return [];
  const candidates: unknown[] = [];
  if (binding && binding.kind === query.kind && binding.gameType === query.gameType
    && binding.variant === query.variant
    && typeof binding.bindingKey === "string" && binding.bindingKey.trim() !== ""
    && typeof binding.requestKey === "string" && binding.requestKey.trim() !== "") {
    switch (binding.status) {
      case "ready": candidates.push(binding.image, binding.previous); break;
      case "stale": candidates.push(binding.image); break;
      case "queued": case "generating": case "failed": candidates.push(binding.previous); break;
      case "not_requested": break;
    }
  }
  for (const gameType of [query.gameType, "generic"] as const) {
    for (const entry of manifest) {
      if (entry.kind === query.kind && entry.variant === query.variant && entry.gameType === gameType) {
        candidates.push(entry.image);
      }
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate): candidate is ContentAssetImageView => {
    if (!isContentAssetImage(candidate) || seen.has(candidate.src)) return false;
    seen.add(candidate.src);
    return true;
  });
}

export function usableVisualAssets(visuals?: GameVisualAssetsView): GameVisualAssetsView | undefined {
  return typeof visuals?.scopeKey === "string" && visuals.scopeKey.trim() !== "" ? visuals : undefined;
}
export function ownAssetBinding(
  entries: Readonly<Record<string, ContentAssetBindingView>> | undefined,
  key: string | null | undefined,
): ContentAssetBindingView | undefined {
  return entries && typeof key === "string" && Object.hasOwn(entries, key) ? entries[key] : undefined;
}
export function assetPresentationKey(
  scope: string | undefined, query: ContentAssetQuery, subject: string, bindingKey?: string,
): string {
  return JSON.stringify([scope ?? "static", query.kind, query.gameType, query.variant, subject, bindingKey ?? null]);
}
```

- [ ] **Step 5: 运行绿灯与边界检查。**

Run: `npx vitest run src/components/contentAssets.test.ts src/game/application/contentAssetView.test.ts src/game/application/gameSessionView.test.ts && npm run typecheck && npm run test:boundaries`
Expected: 旧 view 无 visualAssets 仍合法；原 projector 测试原样通过；无 server 依赖进入 browser facade。

- [ ] **Step 6: 提交本任务。**

```bash
git add src/game/application/contentAssetView.ts src/game/application/contentAssetView.test.ts src/game/application/gameSessionView.ts src/game/application/index.ts src/components/contentAssets.ts src/components/contentAssets.test.ts src/dependencyBoundaries.test.ts
git commit -m "feat(ui): define RPG image views and resolve static and instance candidates"
```

---

### Task 2: DOM/SVG 渲染器与展示期状态

**Files:**
- Create: `src/components/useContentAsset.ts`
- Create: `src/components/ContentAssetImage.tsx`
- Create: `src/components/ContentAssetSvgImage.tsx`
- Test: `src/components/useContentAsset.test.tsx`
- Test: `src/components/ContentAssetImage.test.tsx`
- Test: `src/components/ContentAssetSvgImage.test.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: Task 1 的 `ContentAssetInput`（query/binding?/presentationKey）和解析器。
- Produces: `useContentAsset(input: readonly ContentAssetImageView[])` 返回 `{ image: ContentAssetImageView | null, loaded: boolean, onLoad: () => void, onError: () => void }`。
- Produces: `ContentAssetImage(props: ContentAssetImageProps)`；`ContentAssetSvgImage(props: ContentAssetSvgImageProps)`，完整 props 以下列代码为准。
- 调用者必须用 assetPresentationKey 或等价的明确展示边界，不能传每次轮询变化的 revision/requestKey。fallback 仅为 SVG/span 等静态展示内容，不放按钮或输入。

- [ ] **Step 1: 创建三个行为测试文件。**

`src/components/useContentAsset.test.tsx`：

```tsx
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { ContentAssetImageView } from "@/game/application";
import { useContentAsset } from "./useContentAsset";

it("pins candidates and ignores late events for a failed source", () => {
  const a: ContentAssetImageView = { assetId: "a", version: "1", src: "/assets/a.webp", width: 1, height: 1, source: "generated" };
  const b = { ...a, assetId: "b", src: "/assets/b.webp" };
  const { result, rerender } = renderHook(({ images }) => useContentAsset(images), { initialProps: { images: [a, b] } });
  const lateA = result.current;
  act(() => result.current.onError());
  expect(result.current.image).toEqual(b);
  act(() => lateA.onLoad());
  act(() => lateA.onError());
  expect(result.current.image).toEqual(b);
  expect(result.current.loaded).toBe(false);
  rerender({ images: [a] });
  expect(result.current.image).toEqual(b);
  act(() => result.current.onError());
  expect(result.current.image).toBeNull();
});
```

`src/components/ContentAssetImage.test.tsx`：

```tsx
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImageProps } from "next/image";
import type { ContentAssetBindingView, ContentAssetImageView } from "@/game/application";
import { ContentAssetImage } from "./ContentAssetImage";

// 仅隔离 Next 的解码/优化实现，测试实际 load/error 事件与框架行为。
vi.mock("next/image", () => ({ default: ({ src, alt, onError, onLoad, style, sizes }: ImageProps) =>
  createElement("img", { src: typeof src === "string" ? src : "", alt, onError, onLoad, style, sizes }),
}));
const query = { kind: "npc_portrait", gameType: "wuxia", variant: "neutral" } as const;
const picture: ContentAssetImageView = { assetId: "npc-a", version: "1", src: "/assets/generated/a-v1.webp", width: 768, height: 1024, source: "generated" };
const base = { ...query, bindingKey: "opaque-a", requestKey: "r1" };
const ready: ContentAssetBindingView = { ...base, status: "ready", image: picture };
const props = { query, presentationKey: "scope-a:npc-a:entry", sizes: "200px", fit: "contain" as const, label: "沈掌柜", fallback: <span data-testid="fallback">沈</span> };

describe("ContentAssetImage", () => {
  it("uses one accessible frame, loads then exhausts images without losing the fallback", () => {
    const { container } = render(<ContentAssetImage {...props} binding={ready} />);
    expect(screen.getAllByRole("img", { name: "沈掌柜" })).toHaveLength(1);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveStyle({ visibility: "hidden" });
    fireEvent.load(img);
    expect(img).toHaveStyle({ visibility: "visible" });
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("fallback").parentElement).toHaveStyle({ visibility: "visible" });
  });
  it("defers generating to ready until a new presentation, then resets failed URLs", () => {
    const { container, rerender } = render(<ContentAssetImage {...props} binding={{ ...base, status: "generating" }} />);
    rerender(<ContentAssetImage {...props} binding={ready} />);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ContentAssetImage {...props} binding={ready} presentationKey="entry-2" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ContentAssetImage {...props} binding={ready} presentationKey="entry-3" />);
    expect(container.querySelector("img")).toHaveAttribute("src", picture.src);
  });
  it("tries the previous image once after current fails and hides decorative semantics", () => {
    const previous = { ...picture, assetId: "old", src: "/assets/generated/a-old.webp" };
    const { container } = render(<ContentAssetImage query={query} presentationKey="a" sizes="200px" fit="contain"
      decorative fallback={<span>占位</span>} binding={{ ...ready, previous }} />);
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toHaveAttribute("src", previous.src);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
  });
  it("keeps a new version buffered but changes immediately at a different entity/scope boundary", () => {
    const next: ContentAssetBindingView = { ...ready, requestKey: "r2", image: { ...picture, version: "2", src: "/assets/generated/a-v2.webp" } };
    const { container, rerender } = render(<ContentAssetImage {...props} binding={ready} />);
    rerender(<ContentAssetImage {...props} binding={next} />);
    expect(container.querySelector("img")).toHaveAttribute("src", picture.src);
    rerender(<ContentAssetImage {...props} presentationKey="scope-b:npc-b" binding={{ ...next, bindingKey: "opaque-b" }} />);
    expect(container.querySelector("img")).toHaveAttribute("src", next.image.src);
  });
});
```

`src/components/ContentAssetSvgImage.test.tsx`：

```tsx
import { fireEvent, render } from "@testing-library/react";
import { expect, it } from "vitest";
import { ContentAssetSvgImage } from "./ContentAssetSvgImage";

it("removes a broken native SVG image while keeping the logical geometry", () => {
  const { container, rerender } = render(<svg><rect data-floor width={12} height={12} /><ContentAssetSvgImage
    query={{ kind: "town_building", gameType: "wuxia", variant: "tavern" }}
    presentationKey="entry-1" x={0} y={0} width={12} height={12} /></svg>);
  const img = container.querySelector("image")!;
  expect(img.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(img).toHaveAttribute("href", "/assets/town/tavern.webp");
  fireEvent.error(img);
  expect(container.querySelector("image")).toBeNull();
  expect(container.querySelector("[data-floor]")).not.toBeNull();
  rerender(<svg><rect data-floor width={12} height={12} /><ContentAssetSvgImage
    query={{ kind: "town_building", gameType: "wuxia", variant: "tavern" }}
    presentationKey="entry-2" x={0} y={0} width={12} height={12} /></svg>);
  expect(container.querySelector("image")).toHaveAttribute("href", "/assets/town/tavern.webp");
});
```

- [ ] **Step 2: 运行确认红灯。**

Run: `npx vitest run src/components/useContentAsset.test.tsx src/components/ContentAssetImage.test.tsx src/components/ContentAssetSvgImage.test.tsx`
Expected: 缺失渲染器/hook 导入；不能 mock 掉待测解析器或状态逻辑。

- [ ] **Step 3: 实现单次展示期状态。** 创建 `src/components/useContentAsset.ts`。只有输入首次挂载被固定；不使用 useEffect 同步 ready 结果，不在 module 级保存 failed URL。

```ts
"use client";

import { useState } from "react";
import type { ContentAssetImageView } from "@/game/application";

// 由 renderer 的 keyed 子组件拥有一次展示期。禁止加入依赖 API 更新的重置 effect。
export function useContentAsset(input: readonly ContentAssetImageView[]) {
  const [candidates] = useState(() => input.map((image) => ({ ...image })));
  const [failed, setFailed] = useState<readonly string[]>([]);
  const [loaded, setLoaded] = useState<readonly string[]>([]);
  const image = candidates.find((entry) => !failed.includes(entry.src)) ?? null;
  const src = image?.src;
  return {
    image,
    loaded: src !== undefined && loaded.includes(src),
    onLoad: () => {
      if (src !== undefined) setLoaded((seen) => seen.includes(src) ? seen : [...seen, src]);
    },
    onError: () => {
      if (src !== undefined) setFailed((seen) => seen.includes(src) ? seen : [...seen, src]);
    },
  };
}
```

- [ ] **Step 4: 实现两个渲染器。** 只重建图片内部 Entry，不 key 外部对白或表单。

`src/components/ContentAssetImage.tsx`：

```tsx
"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import { resolveContentAssetCandidates, type ContentAssetInput } from "./contentAssets";
import { useContentAsset } from "./useContentAsset";

export type ContentAssetImageProps = ContentAssetInput & {
  readonly fallback: ReactNode;
  readonly sizes: string;
  readonly fit: "cover" | "contain";
  readonly className?: string;
  readonly priority?: boolean;
} & (
  | { readonly decorative: true; readonly label?: never }
  | { readonly decorative?: false; readonly label: string }
);

export function ContentAssetImage(props: ContentAssetImageProps) {
  return <ContentAssetImageEntry key={props.presentationKey} {...props} />;
}
function ContentAssetImageEntry(props: ContentAssetImageProps) {
  const { image, loaded, onLoad, onError } = useContentAsset(
    resolveContentAssetCandidates(props.query, props.binding),
  );
  return (
    <span className={`content-asset-frame ${props.className ?? ""}`}
      data-content-asset={props.query.kind}
      data-load-state={image === null ? "exhausted" : loaded ? "loaded" : "loading"}
      role={props.decorative ? undefined : "img"}
      aria-label={props.decorative ? undefined : props.label}
      aria-hidden={props.decorative || undefined}>
      <span className="content-asset-fallback" aria-hidden="true"
        style={{ visibility: loaded ? "hidden" : "visible" }}>{props.fallback}</span>
      {image !== null && (
        <Image key={image.src} src={image.src} alt="" fill sizes={props.sizes}
          priority={props.priority} unoptimized={image.source === "generated"}
          style={{ objectFit: props.fit, visibility: loaded ? "visible" : "hidden" }}
          onLoad={onLoad} onError={onError} />
      )}
    </span>
  );
}
```

`src/components/ContentAssetSvgImage.tsx`：

```tsx
"use client";

import { resolveContentAssetCandidates, type ContentAssetInput } from "./contentAssets";
import { useContentAsset } from "./useContentAsset";

export type ContentAssetSvgImageProps = ContentAssetInput & {
  readonly x: number; readonly y: number;
  readonly width: number; readonly height: number;
};
export function ContentAssetSvgImage(props: ContentAssetSvgImageProps) {
  return <ContentAssetSvgImageEntry key={props.presentationKey} {...props} />;
}
function ContentAssetSvgImageEntry(props: ContentAssetSvgImageProps) {
  const { image, onError } = useContentAsset(resolveContentAssetCandidates(props.query, props.binding));
  if (image === null) return null;
  return <image key={image.src} href={image.src}
    x={props.x} y={props.y} width={props.width} height={props.height}
    preserveAspectRatio="xMidYMid slice" aria-hidden="true" pointerEvents="none" onError={onError} />;
}
```

- [ ] **Step 5: 追加框的基础 CSS。** 放在 `src/app/globals.css` 内容视觉样式段之后。外部调用处负责真实尺寸，本组件不按生成图片原尺寸撑大视窗。

```css
.content-asset-frame {
  display: block;
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  pointer-events: none;
}
.content-asset-fallback { display: block; position: absolute; inset: 0; }
.content-asset-fallback > svg { width: 100%; height: 100%; }
.content-asset-frame > img { display: block; }
```

- [ ] **Step 6: 运行绿灯。**

Run: `npx vitest run src/components/useContentAsset.test.tsx src/components/ContentAssetImage.test.tsx src/components/ContentAssetSvgImage.test.tsx && npm run typecheck`
Expected: DOM/SVG 同一展示期不会因 ready 更新采用新图；失败只推进一次；key 改变后同 URL 可以重试；装饰图不制造重复可访问名称。

- [ ] **Step 7: 提交本任务。**

```bash
git add src/components/useContentAsset.ts src/components/useContentAsset.test.tsx src/components/ContentAssetImage.tsx src/components/ContentAssetImage.test.tsx src/components/ContentAssetSvgImage.tsx src/components/ContentAssetSvgImage.test.tsx src/app/globals.css
git commit -m "feat(ui): render RPG images with stable presentation and explicit fallback"
```

---

### Task 3: 题材卡使用真正的 DOM 降级入口

**Files:**
- Modify: `src/components/NewGameSetupForm.tsx`（Image import、GAME_TYPE_BACKGROUNDS、GAME_TYPES.map 中封面）
- Test: `src/components/NewGameSetupForm.test.tsx`

**Interfaces:**
- Consumes: `ContentAssetImage`、`assetPresentationKey`；查询固定 `genre_cover / type.id / default`。
- Produces: 七张原图 URL、62px 高度、sizes=220px、默认题材 priority 和表单行为保留；加载失败显式移除图片。

- [ ] **Step 1: 在现有 canonical contract describe 中加入消费者测试。** import 区补 fireEvent（保留原有 imports）。测试文件继续使用真实 Next Image，验证页面确实连接 onError。

```tsx
it("uses the original seven cover URLs and survives an image load failure", async () => {
  const { container } = render(<NewGameSetupForm onCreated={vi.fn()} />);
  const cards = [...container.querySelectorAll(".game-type-card")];
  expect(cards).toHaveLength(7);
  for (const card of cards) {
    const input = card.querySelector("input")!;
    const image = card.querySelector("img")!;
    const src = new URL(image.getAttribute("src")!, "http://localhost");
    expect(src.searchParams.get("url") ?? src.pathname).toBe(`/assets/genres/${input.value}.jpg`);
  }
  const first = cards[0]!;
  fireEvent.error(first.querySelector("img")!);
  expect(first.querySelector("img")).toBeNull();
  expect(first.querySelector(".game-type-card--visual")).toBeInTheDocument();
  await userEvent.click(first.querySelector("input")!);
  expect(first.querySelector("input")).toBeChecked();
  expect(screen.getByRole("button", { name: "踏上旅程" })).toBeEnabled();
});
```

- [ ] **Step 2: 运行确认失败。**

Run: `npx vitest run src/components/NewGameSetupForm.test.tsx`
Expected: 原 URL 断言通过，但 error 后原 img 未被移除；这是实际行为差距，不是新增方法名断言。

- [ ] **Step 3: 替换封面入口。** 删除 `import Image from "next/image"` 与完整 GAME_TYPE_BACKGROUNDS 常量，添加：

```tsx
import { ContentAssetImage } from "./ContentAssetImage";
import { assetPresentationKey } from "./contentAssets";
```

GAME_TYPES.map 内其余 label/input/文案保持原样；只替换 `.game-type-card--visual` 的子内容：

```tsx
<ContentAssetImage
  query={{ kind: "genre_cover", gameType: type.id, variant: "default" }}
  presentationKey={assetPresentationKey(undefined,
    { kind: "genre_cover", gameType: type.id, variant: "default" }, type.id)}
  fallback={null}
  decorative
  fit="cover"
  sizes="220px"
  priority={type.id === DEFAULT_GAME_TYPE}
/>
```

- [ ] **Step 4: 验证与提交。**

Run: `npx vitest run src/components/NewGameSetupForm.test.tsx && npm run typecheck`
Expected: 全部原表单/开局请求测试与新 error 用例通过，无空 src 或额外表单请求。

```bash
git add src/components/NewGameSetupForm.tsx src/components/NewGameSetupForm.test.tsx
git commit -m "refactor(ui): route genre covers through the image fallback framework"
```

---

### Task 4: 小镇屋顶按题材解析，保留探索和交互边界

**Files:**
- Modify: `src/components/AdventureGameShell.tsx`（向 TownLayerScreen 传题材/视觉视图）
- Modify: `src/components/TownLayerScreen.tsx`（透传 props）
- Modify: `src/components/town/TownMapSvg.tsx`（删除 BUILDING_ART，图片层接 renderer）
- Test: `src/components/TownLayerScreen.test.tsx`

**Interfaces:**
- Consumes: `ContentAssetSvgImage`、`ContentAssetQuery`、`usableVisualAssets`、`ownAssetBinding`、`assetPresentationKey`。
- Produces: TownLayerScreen/TownMapSvg 增加必传 `gameType: ContentAssetQuery["gameType"]`、可选 `visualAssets?: GameVisualAssetsView`；其它 props 不变。
- 图片层仍位于 TILE_FILL 之上、交互矩形之下；isUnexploredPlaceholder 函数和未探索灰块分支保持原样。

- [ ] **Step 1: 增加消费者行为测试。** 在现有测试的所有五处 `<TownLayerScreen>` 加 `gameType="wuxia"`；`renderTown` helper 也传入。import 区补 fireEvent、ContentAssetBindingView。下面三个 it 放在原 describe 内，使用已存在的 townFixture。

```tsx
it("does not use historic Chinese roofs in a science-fiction town", () => {
  const { container } = render(<TownLayerScreen town={townFixture()} gameType="science_fiction"
    busy={false} onEnterBuilding={vi.fn()} onReturnMap={vi.fn()} />);
  expect(container.querySelector("image")).toBeNull();
  expect(container.querySelector(".town-demo-tile")).toBeInTheDocument();
});

it("never renders a supplied image for an unexplored story building", () => {
  const town = townFixture();
  const visible = new Set(town.interactiveBuildings.map((entry) => entry.buildingId));
  const hidden = town.snapshot.buildings.find((entry) => entry.storyRequired && !visible.has(entry.buildingId))!;
  expect(hidden).toBeDefined();
  const secret: ContentAssetBindingView = {
    bindingKey: "opaque-hidden", requestKey: "r1", kind: "town_building", gameType: "wuxia",
    variant: hidden.buildingType, status: "ready",
    image: { assetId: "hidden-roof", version: "1", src: "/assets/generated/hidden-roof.webp", width: 512, height: 512, source: "generated" },
  };
  const { container } = render(<TownLayerScreen town={town} gameType="wuxia" busy={false}
    visualAssets={{ scopeKey: "scope-a", townBuildings: { [hidden.buildingId]: secret } }}
    onEnterBuilding={vi.fn()} onReturnMap={vi.fn()} />);
  expect(container.innerHTML).not.toContain(secret.image.src);
  expect(container.querySelectorAll("[data-building-art] image")).toHaveLength(
    town.snapshot.buildings.filter((entry) => !entry.storyRequired || visible.has(entry.buildingId)).length,
  );
  expect(container.querySelector(".town-demo-building--unexplored")).toHaveAttribute("aria-hidden", "true");
});

it("keeps keyboard entry usable after all roof images fail", async () => {
  const town = townFixture();
  const onEnterBuilding = vi.fn();
  const { container } = render(<TownLayerScreen town={town} gameType="wuxia" busy={false}
    onEnterBuilding={onEnterBuilding} onReturnMap={vi.fn()} />);
  for (const image of container.querySelectorAll("image")) fireEvent.error(image);
  expect(container.querySelector("image")).toBeNull();
  const entry = town.interactiveBuildings[0]!;
  fireEvent.keyDown(screen.getByRole("button", { name: entry.displayName }), { key: "Enter" });
  await userEvent.click(screen.getByRole("button", { name: `进入${entry.displayName}` }));
  expect(onEnterBuilding).toHaveBeenCalledWith(entry.npcId);
});
```

- [ ] **Step 2: 运行确认失败。**

Run: `npx vitest run src/components/TownLayerScreen.test.tsx`
Expected: 科幻仍加载历史屋顶、error 后 image 未移除。原 URL 与门控测试保留，不将其改成放宽断言。

- [ ] **Step 3: 透传题材和可选视图。**

AdventureGameShell import `normalizeAssetGameType`（从 `./contentAssets`），在现有 TownLayerScreen 调用加：

```tsx
gameType={normalizeAssetGameType(view.gameType)}
visualAssets={view.visualAssets}
```

TownLayerScreen 和 TownMapSvg 的 Props 均加：

```ts
readonly gameType: ContentAssetQuery["gameType"];
readonly visualAssets?: GameVisualAssetsView;
```

两个文件分别经 `@/game/application` type-import GameVisualAssetsView，ContentAssetQuery 从 `./contentAssets` / `../contentAssets` 导入。函数参数解构加入两字段，TownLayerScreen 向内部 TownMapSvg 原样传 `gameType={gameType} visualAssets={visualAssets}`。不得加入缺省 wuxia。

- [ ] **Step 4: 替换受门控的 SVG 图片层。**

在 TownMapSvg 引入以下符号并删除本地 TownBuildingType/BUILDING_ART 常量；其它 tile/geometry/interaction 代码不动：

```tsx
import { ContentAssetSvgImage } from "../ContentAssetSvgImage";
import {
  assetPresentationKey, ownAssetBinding, usableVisualAssets,
  type ContentAssetQuery,
} from "../contentAssets";
```

函数内增加 `const visuals = usableVisualAssets(visualAssets);`。仅替换 data-building-art 组中的 map 回调，**第一行门控不可挪到解析之后**：

```tsx
{snapshot.buildings.map((building) => {
  if (isUnexploredPlaceholder(building)) return null;
  const query: ContentAssetQuery = { kind: "town_building", gameType, variant: building.buildingType };
  const binding = ownAssetBinding(visuals?.townBuildings, building.buildingId);
  return <ContentAssetSvgImage
    key={building.buildingId}
    query={query}
    binding={binding}
    presentationKey={assetPresentationKey(visuals?.scopeKey, query, building.buildingId, binding?.bindingKey)}
    x={building.footprint.x * TILE_SIZE}
    y={building.footprint.y * TILE_SIZE}
    width={building.footprint.width * TILE_SIZE}
    height={building.footprint.height * TILE_SIZE}
  />;
})}
```

此处不会保留原 data-building-type 属性，也不引入新的隐藏类型标签。已探索图片仍是 SVG image，原 `image[href="/assets/town/<type>.webp"]` 断言在武侠 fixture 下不变。

- [ ] **Step 5: 验证与提交。**

Run: `npx vitest run src/components/TownLayerScreen.test.tsx src/components/AdventureGameShell.test.tsx && npm run typecheck && npm run test:boundaries`
Expected: 武侠/仙侠静态图正常；其它题材色块可操作；hidden binding 不请求图片；三层导航/arrivalChoiceToken 行为不变。

```bash
git add src/components/AdventureGameShell.tsx src/components/TownLayerScreen.tsx src/components/town/TownMapSvg.tsx src/components/TownLayerScreen.test.tsx
git commit -m "feat(ui): resolve town art by genre without revealing unexplored buildings"
```

---

### Task 5: 地点背景与 NPC 立绘消费异步图片视图

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/components/NpcDialogueOverlay.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/LocationSceneScreen.test.tsx`
- Test: `src/components/NpcDialogueOverlay.test.tsx`

**Interfaces:**
- Consumes: `GameSessionView.visualAssets?`、ContentAssetImage 与 Task 1 的解析/helper。
- Produces: NpcDialogueOverlay 额外可选 props `portrait?: ContentAssetBindingView`、`assetScope?: string`；其它对白 props 不改。
- 不建立客户端生成 service；真实 view 缺少 visualAssets 时仍是当前 SVG/首字。生成状态测试通过直接注入可选 view/props 驱动真实消费者。

- [ ] **Step 1: 增加 NPC 真实消费者的异步回归。**

在 NpcDialogueOverlay.test.tsx 加 `createElement`、`ImageProps`、`ContentAssetBindingView` 类型 imports，并加入下面的 Next Image 事件适配 mock（只模拟图片解码层，不 mock ContentAssetImage/registry）。使用已存在的 makeDialogue/renderOverlay：

```tsx
vi.mock("next/image", () => ({ default: ({ src, alt, onError, onLoad, style, sizes }: ImageProps) =>
  createElement("img", { src: typeof src === "string" ? src : "", alt, onError, onLoad, style, sizes }),
}));

it("keeps typing and choices when a portrait completes, and uses it on re-entry", () => {
  const pending: ContentAssetBindingView = {
    kind: "npc_portrait", gameType: "wuxia", variant: "neutral",
    bindingKey: "opaque-npc-a", requestKey: "r1", status: "generating",
  };
  const ready: ContentAssetBindingView = { ...pending, status: "ready",
    image: { assetId: "npc-a", version: "1", src: "/assets/generated/npc-a-v1.webp", width: 768, height: 1024, source: "generated" },
  };
  const testDialogue = makeDialogue({ speechPages: ["还在交谈。"] });
  const { container, rerender, unmount, props } = renderOverlay({ dialogue: testDialogue, assetScope: "scope-a", portrait: pending });
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "还没写完的回应" } });
  input.focus();
  rerender(<NpcDialogueOverlay {...props} portrait={ready} />);
  expect(input).toHaveValue("还没写完的回应");
  expect(input).toHaveFocus();
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getAllByTestId("npc-dialogue-choice")).toHaveLength(2);
  expect(props.onSubmit).not.toHaveBeenCalled();
  unmount();
  const reopened = renderOverlay({ dialogue: testDialogue, assetScope: "scope-a", portrait: ready });
  const image = reopened.container.querySelector("img")!;
  expect(image).toHaveAttribute("src", ready.image.src);
  fireEvent.load(image);
  const frame = reopened.container.querySelector('[data-content-asset="npc_portrait"]')!;
  expect(frame).toHaveAttribute("data-load-state", "loaded");
  expect(frame.querySelector(".content-asset-fallback")).toHaveStyle({ visibility: "hidden" });
  fireEvent.error(image);
  expect(reopened.container.querySelector("img")).toBeNull();
  expect(frame.querySelector(".content-asset-fallback")).toHaveStyle({ visibility: "visible" });
  expect(screen.getByRole("textbox")).toBeEnabled();
});

it("does not reuse another NPC portrait in the same genre or accept an unscoped binding", () => {
  const portrait: ContentAssetBindingView = {
    kind: "npc_portrait", gameType: "wuxia", variant: "neutral", bindingKey: "opaque-a", requestKey: "r1", status: "ready",
    image: { assetId: "a", version: "1", src: "/assets/generated/a.webp", width: 768, height: 1024, source: "generated" },
  };
  const { container, props, rerender } = renderOverlay({ assetScope: "scope-a", portrait });
  expect(container.querySelector("img")).toHaveAttribute("src", "/assets/generated/a.webp");
  const next: ContentAssetBindingView = { ...portrait, bindingKey: "opaque-b",
    image: { ...portrait.image, assetId: "b", src: "/assets/generated/b.webp" },
  };
  rerender(<NpcDialogueOverlay {...props} dialogue={makeDialogue({ npcId: "npc_2", name: "另一人" })} portrait={next} />);
  expect(container.querySelector("img")).toHaveAttribute("src", "/assets/generated/b.webp");
  rerender(<NpcDialogueOverlay {...props} assetScope={undefined} portrait={portrait} />);
  expect(container.querySelector("img")).toBeNull();
});
```

- [ ] **Step 2: 增加地点/建筑背景的归属与操作回归。** 在 LocationSceneScreen.test.tsx 引入 ContentAssetBindingView，使用已有 viewWithInvestigationApproaches fixture：

```tsx
it("uses only the entered building background and stays usable when it fails", () => {
  const binding = (key: string): ContentAssetBindingView => ({
    kind: "location_backdrop", gameType: "wuxia", variant: "default", bindingKey: key,
    requestKey: "r1", status: "ready",
    image: { assetId: key, version: "1", src: `/assets/generated/${key}.webp`, width: 1920, height: 1080, source: "generated" },
  });
  const view: GameSessionView = { ...viewWithInvestigationApproaches(), visualAssets: {
    scopeKey: "scope-a", locationBackdrop: binding("outdoor"), buildingBackdrops: { b1: binding("interior") },
  } };
  const props = { view, busy: false, onSubmit: vi.fn(), onReturnMap: vi.fn(), initialFocusNpcId: "npc_1", sceneBuildingId: "b1" };
  const { container, rerender } = render(<LocationSceneScreen {...props} />);
  const frame = container.querySelector('[data-content-asset="location_backdrop"]')!;
  const backgroundUrl = new URL(frame.querySelector("img")!.getAttribute("src")!, "http://localhost");
  expect(backgroundUrl.pathname).toBe("/assets/generated/interior.webp");
  expect(container.innerHTML).not.toContain("/assets/generated/outdoor.webp");
  fireEvent.error(frame.querySelector("img")!);
  expect(frame.querySelector("img")).toBeNull();
  expect(screen.getByRole("button", { name: "返回地图" })).toBeEnabled();
  expect(props.onSubmit).not.toHaveBeenCalled();
  rerender(<LocationSceneScreen {...props} sceneBuildingId="b2" />);
  expect(container.querySelector('[data-content-asset="location_backdrop"] img')).toBeNull();
});
```

- [ ] **Step 3: 运行红灯。**

Run: `npx vitest run src/components/NpcDialogueOverlay.test.tsx src/components/LocationSceneScreen.test.tsx`
Expected: 旧消费者不渲染注入的图片/缺少 frame，新增用例失败；旧对白输入、等待、选择测试不能删。

- [ ] **Step 4: LocationSceneScreen 接入安全背景和当前对白头像绑定。**

新增 imports：

```tsx
import { ContentAssetImage } from "./ContentAssetImage";
import {
  assetPresentationKey, normalizeAssetGameType, ownAssetBinding, usableVisualAssets,
  type ContentAssetQuery,
} from "./contentAssets";
```

在已有 hasBuildingSceneContext 定义之后加入；既有 AdventureVisual 的题材兜底不改，新资产查询只使用规范化题材：

```tsx
const visuals = usableVisualAssets(view.visualAssets);
const backdropQuery: ContentAssetQuery = {
  kind: "location_backdrop", gameType: normalizeAssetGameType(view.gameType), variant: "default",
};
const backdropBinding = hasBuildingSceneContext
  ? ownAssetBinding(visuals?.buildingBackdrops, sceneBuildingId)
  : visuals?.locationBackdrop;
```

将 `.location-backdrop--fullscreen` 内原 AdventureVisual 替换为：

```tsx
<ContentAssetImage
  query={backdropQuery}
  binding={backdropBinding}
  presentationKey={assetPresentationKey(visuals?.scopeKey, backdropQuery,
    sceneBuildingId ?? "current-location", backdropBinding?.bindingKey)}
  fallback={<AdventureVisual gameType={gameType} kind="location_backdrop" label="" decorative />}
  decorative
  sizes="100vw"
  fit="cover"
/>
```

现有 displayedDialogue 的 NpcDialogueOverlay 调用增加两项，**按正在显示的对白快照取 NPC**，不能用最新焦点索引取代 waiting 中旧 NPC：

```tsx
portrait={ownAssetBinding(visuals?.npcPortraits, displayedDialogue.npcId)}
assetScope={visuals?.scopeKey}
```

不得修改 dialogueUi reducer、onSubmit、narrativeGeneration 或场景导航逻辑。

- [ ] **Step 5: NpcDialogueOverlay 使用同一 renderer。**

从 application facade type-import ContentAssetBindingView；引入 ContentAssetImage，以及 assetPresentationKey/normalizeAssetGameType/ContentAssetQuery。Props 与参数解构增加 portrait、assetScope。函数内加入：

```tsx
const portraitQuery: ContentAssetQuery = {
  kind: "npc_portrait", gameType: normalizeAssetGameType(gameType), variant: "neutral",
};
const scopedPortrait = typeof assetScope === "string" && assetScope.trim() !== "" ? portrait : undefined;
```

将 `.npc-dialogue-overlay-figure` 的内容替换为以下代码。使用 span 保持图片框的合法 HTML 内容；旧 class/图形/首字文案保留在 fallback 内，加载后整体隐藏，不让头像首字盖在真图上：

```tsx
<ContentAssetImage
  className="npc-dialogue-overlay-figure-frame"
  query={portraitQuery}
  binding={scopedPortrait}
  presentationKey={assetPresentationKey(assetScope, portraitQuery, dialogue.npcId)}
  decorative
  fit="contain"
  sizes="(max-width: 700px) 75vw, 460px"
  fallback={<>
    <span className="npc-dialogue-overlay-figure-art">
      <AdventureVisual gameType={gameType} kind="npc" label="" decorative />
    </span>
    <span className="npc-dialogue-overlay-avatar">{dialogue.name.charAt(0)}</span>
  </>}
/>
```

- [ ] **Step 6: 把立绘尺寸从首字占位移到公共框。**

在 globals.css 的 `.npc-dialogue-overlay-avatar` 规则中删除原 `--npc-dialogue-overlay-figure-height`、height 和 width 三条声明，其余边框、配色、字号等保持；在 Task 2 基础 CSS 之后添加：

```css
.npc-dialogue-overlay-figure-frame {
  --npc-dialogue-overlay-figure-height: clamp(226px, min(55dvh, 100vw), 613px);
  height: var(--npc-dialogue-overlay-figure-height);
  width: calc(var(--npc-dialogue-overlay-figure-height) * 0.75);
  overflow: visible;
}
.npc-dialogue-overlay-avatar { height: 100%; width: 100%; }
```

图片框不使用原 figure-art 的 opacity=0.28；该透明度只作用于旧 SVG 占位。地点外层现有 opacity、pointer-events 和文字/按钮层级保留。

- [ ] **Step 7: 验证与提交。**

Run: `npx vitest run src/components/NpcDialogueOverlay.test.tsx src/components/LocationSceneScreen.test.tsx src/components/AdventureGameShell.test.tsx && npm run typecheck && npm run test:boundaries`
Expected: 注入图片真实进入两个游戏 UI；生成完成不会打断输入；另一 NPC/新 scope 不串图；没有 visualAssets 时全部旧消费者合同通过。

```bash
git add src/components/LocationSceneScreen.tsx src/components/NpcDialogueOverlay.tsx src/components/NpcDialogueOverlay.test.tsx src/components/LocationSceneScreen.test.tsx src/app/globals.css
git commit -m "feat(ui): bind scene and NPC visuals without interrupting dialogue"
```

---

### Task 6: 隔离浏览器验收、完整门禁与实现文档

**Files:**
- Temporary, do not commit: `src/app/asset-preview/page.tsx`（下面的明确离线 UI 夹具，验收后删除）
- Create after acceptance: `docs/agent/图片展示框架.md`
- Modify after acceptance: `docs/Agent文档索引.md`
- Modify after acceptance: `docs/agent/地图与地点冒险.md`
- Modify after acceptance: `docs/agent/小镇程序化生成.md`
- Modify after acceptance: `docs/AI生图资产制作参考.md`（§1）

**Interfaces:**
- Consumes: 四个生产消费者及其测试；`npm run journey:foundation`（真实存在的离线 Vitest journey 入口）。
- Produces: 浏览器图片正常/阻断/延迟状态证据、无玩法回归证据，以及准确的已实现/未实现边界。
- 当前浏览器没有旧文档所说的“使用已有数据开始”入口；不要通过正式“踏上旅程”按钮误触生产 AI，也不要修改 composition root 注入 fixture。

- [ ] **Step 1: 建立一次性预览页。** 先确认 `src/app/asset-preview/` 不存在再创建。该页不是生产功能，不写入存档；对白提交只返回夹具小镇并卸载场景，重新进入可继续验收，不模拟规则成功。不能为恒定 `busy={false}` 的场景传空提交回调，否则真实对白会停在 waiting，锁住后续交互。真实 UI 与规则旅程分开验证。

```bash
test ! -e src/app/asset-preview
mkdir src/app/asset-preview
```

临时文件 `src/app/asset-preview/page.tsx` 完整内容如下。图片 ready 时复用现有封面充当诊断样图；“模拟 ready”不代表真的生图。TownView 手工快照只供渲染，不用它证明 town 生成算法正确。

```tsx
"use client";

import { useState } from "react";
import type { ContentAssetBindingView, GameSessionView, NpcDialogueView, TownView } from "@/game/application";
import { NewGameSetupForm } from "@/components/NewGameSetupForm";
import { TownLayerScreen } from "@/components/TownLayerScreen";
import { LocationSceneScreen } from "@/components/LocationSceneScreen";

const dialogue: NpcDialogueView = {
  npcId: "preview-npc", name: "预览人物", role: "视觉验收夹具",
  speechPages: ["这只是本地图片展示夹具，不会调用 AI 或写入存档。"],
  choices: [
    { choiceToken: "preview-a", label: "查看图片是否影响选项", presentation: "dialogue" },
    { choiceToken: "preview-b", label: "保留当前输入", presentation: "dialogue" },
  ],
  freeInputEnabled: true, giveChoices: [],
};
const town: TownView = {
  townName: "视觉预览镇",
  snapshot: {
    grid: { width: 24, height: 24, tiles: Array.from({ length: 576 }, () => "grass" as const) },
    buildings: [
      { buildingId: "b1", buildingType: "tavern", displayName: "预览酒馆", storyRequired: true,
        definitionState: "named", footprint: { x: 4, y: 4, width: 4, height: 4 },
        entrance: { x: 4, y: 8, direction: "south" } },
      { buildingId: "b2", buildingType: "shop", displayName: "隐藏夹具", storyRequired: true,
        definitionState: "generic", footprint: { x: 14, y: 4, width: 4, height: 4 },
        entrance: { x: 14, y: 8, direction: "south" } },
    ],
    plots: [], roadGraph: { nodes: [], edges: [] },
  },
  interactiveBuildings: [{ buildingId: "b1", buildingType: "tavern", displayName: "预览酒馆",
    npcId: dialogue.npcId, npcName: dialogue.name, isCurrentFocus: true }],
};
const baseView: GameSessionView = {
  revision: 1, turnNumber: 0, gameType: "wuxia",
  setup: { storyOpening: null, worldPremise: null, characterProfile: null, narrativeStyle: null },
  player: { name: "预览玩家", identity: "测试", hp: 100, attack: 10, defense: 5 },
  worldMap: { locations: [] },
  currentLocation: { name: town.townName, description: "测试场景", scale: "town", town, actions: [],
    npcs: [{ npcId: dialogue.npcId, name: dialogue.name, role: dialogue.role, talkChoice: null, relationshipTier: "neutral" }] },
  obtainableItems: [], inventory: [], quests: [],
  story: { currentAct: 1, targetActs: 3, tension: 0, pacingNeed: "", storyProgress: 0,
    currentObjectiveLabel: "与预览人物交谈", currentObjectiveChoiceToken: null, currentObjectiveChoiceTokens: [] },
  narrative: { mode: "offline", hasScene: true, narration: "预览旁注", choices: [], npcLine: null, npcDialogues: [dialogue] },
  narrativeGeneration: { status: "idle" }, battle: null, ending: null, prologueShown: true, prologueText: "",
};

export default function AssetPreview() {
  const [screen, setScreen] = useState<"cover" | "town" | "scene">("cover");
  const [genre, setGenre] = useState<"wuxia" | "science_fiction">("wuxia");
  const [ready, setReady] = useState(false);
  const binding = (kind: "npc_portrait" | "location_backdrop"): ContentAssetBindingView => {
    const base = { bindingKey: `preview-${kind}`, requestKey: "preview-request", kind, gameType: genre,
      variant: kind === "npc_portrait" ? "neutral" : "default" };
    return ready ? { ...base, status: "ready", image: { assetId: "preview-only", version: "1",
      src: "/assets/genres/wuxia.jpg", width: 1368, height: 768, source: "generated" } }
      : { ...base, status: "generating" };
  };
  const view: GameSessionView = { ...baseView, gameType: genre, visualAssets: {
    scopeKey: "preview-scope", buildingBackdrops: { b1: binding("location_backdrop") },
    npcPortraits: { [dialogue.npcId]: binding("npc_portrait") },
  } };
  return <>
    <nav aria-label="本地视觉夹具" style={{ position: "fixed", top: 0, left: 0, zIndex: 99999, background: "#111", padding: 8 }}>
      <strong>离线 UI 夹具 · 无生成/无存档</strong>
      <button onClick={() => setScreen("cover")}>题材卡</button>
      <button onClick={() => setScreen("town")}>小镇</button>
      <button onClick={() => setScreen("scene")}>场景</button>
      <button onClick={() => setGenre(genre === "wuxia" ? "science_fiction" : "wuxia")}>切换题材</button>
      <button onClick={() => setReady(!ready)}>模拟 {ready ? "generating" : "ready"}</button>
    </nav>
    {screen === "cover" ? <main className="new-game-page"
      onSubmitCapture={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <NewGameSetupForm onCreated={() => undefined} />
    </main> : screen === "town" ? <TownLayerScreen town={town} gameType={genre} busy={false}
      onEnterBuilding={() => setScreen("scene")} onReturnMap={() => setScreen("cover")} />
      : <LocationSceneScreen view={view} busy={false} initialFocusNpcId={dialogue.npcId}
        sceneBuildingId="b1" sceneLocationName="预览酒馆" sceneNpcName={dialogue.name}
        onSubmit={() => setScreen("town")} onReturnMap={() => setScreen("town")} />}
  </>;
}
```

- [ ] **Step 2: 浏览器验证四个真实消费者。**

Run: `npm run dev`，打开本地 `/asset-preview`。在 1440×900 与 390×844 两个视口验收并把截图放 `tmp/content-asset-review/`：

1. 题材卡七张封面正常；点击切换题材和编辑文本，不点击生产开局。夹具 capture 阻止 submit，Network 应无 POST /api/game。
2. 小镇已知酒馆有图且键盘 Enter 可选、可进入；另一个剧情建筑只显示未知灰块。切换科幻后无历史屋顶，交互仍可用。
3. generating 时进入场景，打开预览人物对白，输入未提交文本；点击夹具“模拟 ready”后新图不进入当前背景/对白，也不改变选项或输入。点击夹具按钮会因用户点击自然转移焦点，不能将它当作图片事件抢焦点；焦点不被数据更新改变由 Task 5 组件测试证明。
4. 关闭并重新打开对白后立绘使用诊断图；返回小镇再进入后背景使用诊断图。真图显示时首字占位整体隐藏，人物框保持 3:4，文字和按钮可读、可点击。分别点击一个对白选项、重新进入后发送文本，均只返回夹具小镇；再次进入并打开对白，输入、选项与关闭按钮仍可用，Network 无游戏 API 请求。
5. DevTools Network 的 Request blocking 同时添加 `*/assets/*`、`*/_next/image*`，禁用缓存并硬刷新。刷新会重置 ready：先点击“模拟 ready”，再进入场景并打开对白，确保两个消费者确实尝试诊断图片。确认 Network 有 `/assets/genres/wuxia.jpg` 被阻断记录，地点与 NPC 的 `data-content-asset` 框均在失败后为 `data-load-state="exhausted"`、其内部不再有 img；两处共用 URL，浏览器可以合并请求。重复题材选择、建筑进入、对白输入/关闭及提交返回，确认占位仍在、没有破图图标或挡住操作的 loading。不要用 generating 时没有请求的占位画面充当失败证据。
6. 取消阻断、硬刷新，重新点击“模拟 ready”后进入场景并打开对白，确认背景和立绘都能加载，占位隐藏；同时复核封面和武侠屋顶恢复。阻断只针对图片，不针对游戏 API 或 Next 脚本。

此夹具验证展示/输入，不模拟规则回合、结局或存档恢复；这些由下一步的现有离线 journey 验证。不把它记录为真实 API 生图验收。

- [ ] **Step 3: 移除一次性预览页，再跑生产门禁。** 只删除本 Task 刚创建的精确文件和空目录；不能触碰原 page.tsx、public 文件或链接目录。停止该预览 dev server 后执行：

```bash
rm src/app/asset-preview/page.tsx
rmdir src/app/asset-preview
npm run test:components
npm run test:fast
npm run lint
npm test
npm run build
```

Expected: 全部通过；`npm test` 包含 `src/game/application/testing/foundationJourney.test.ts` 的离线完整旅程。需要单独定位旅程失败时运行 `npm run journey:foundation`，正常通过后不重复跑。test:fast 含 typecheck/boundaries/check:standards 等，但不含 lint、完整组件测试或 build，因此不能把 test:fast 作为唯一门禁。

检查 `git status --short`：没有预览页、图片改动、server/持久化/领域逻辑改动、current-phase 或共享目录改动。不要为了让门禁通过更改真实 AI fallback、共享基础设施或放宽既有断言。

- [ ] **Step 4: 记录完成后的实现事实。** 先确认浏览器与自动门禁证据齐全，再创建 `docs/agent/图片展示框架.md`：

```markdown
# 图片展示框架

## 系统定位

RPG 图片只增强展示，不参与行动、叙事、地图几何或存档裁决。预制题材模板和实例图片绑定共用解析器与 DOM/SVG 渲染器；当前生产没有真实 API 生图。

## 当前合同

- GameSessionView.visualAssets 是可选安全展示入口，定义在 application/contentAssetView.ts 并仅经 application facade 导出。当前 projector 不填充此字段。
- scopeKey 隔离游戏；bindingKey 标识公开对象的图片位；requestKey 标识生成需求；assetId/version/src 标识不可变图片。组件不得用名称或 choiceToken 拼图片身份。
- 六种生成状态与浏览器 loading/loaded/exhausted 分离；图片失败不改变 narrative pending、busy、Action 或游戏 revision。
- 内容候选依次为专属当前/旧图、同题材模板、generic 模板、原 SVG/首字/色块；没有的层跳过。候选 URL 有白名单，失败在本次展示内只尝试一次。
- presentationKey 对应的图片子组件固定候选；对白输入、API ready 和分页不采用新版本，关闭重开/场景重入再采样。
- manifest 当前 23 条查询映射、15 个唯一文件。七题材封面保留；历史屋顶只登记武侠/仙侠，其它题材使用色块。

## 入口与验证

- NewGameSetupForm：题材封面；TownMapSvg：屋顶，未探索门控先于解析。
- LocationSceneScreen：地点或当前建筑背景；NpcDialogueOverlay：当前 displayedDialogue 的立绘。
- contentAssets.test、useContentAsset.test、两个 renderer 测试及四个消费者测试覆盖状态、失败、实体隔离、输入与探索门控。
- 浏览器通过一次性本地 UI 夹具验证布局、模拟 ready 与图片阻断；完整规则旅程由 foundationJourney.test 验证。

## 后续责任

真实生图 provider、队列/预算、去重计费、版本存储、同源资产交付、乱序请求处理和刷新恢复尚未实现。后续只能由 server-only 服务经 canonical read model 下发图片，先审批可见性，不能把图片字段写进规则状态或从 UI 发起生图。
```

将真实执行的日期、浏览器视口和命令结果追加到该页验收记录；失败/未执行项如实记录，不能预填通过。

更新三份现状文档与索引，加入以下事实（按现有段落位置合并，不重复旧日期记录）：

```markdown
- AI生图资产制作参考.md §1：题材封面与屋顶 URL 由 contentAssets.ts manifest 管理；历史屋顶仅用于武侠/仙侠，其它题材暂回退色块。地点背景和 NPC 对话立绘已接 ContentAssetImage，但当前 projector 尚不提供专属图；异步状态只通过受控测试验证，真实生图服务未接入。
- agent/地图与地点冒险.md：GameSessionView.visualAssets? 为纯展示入口；LocationSceneScreen 根据当前建筑与 displayedDialogue 选择绑定，图片展示期与叙事/输入分离；无新增 Action/API/存档字段。
- agent/小镇程序化生成.md：TownLayerScreen 从壳层接收题材；屋顶通过 ContentAssetSvgImage 渲染，error 后显式回退 TILE_FILL；isUnexploredPlaceholder 先于解析，地图几何与规则不变。
```

Agent 索引新增系统行，并保留原“视觉资产与 AI 生图参考”制作资料入口，不把它变成实现文档：

```markdown
| 图片展示框架 | `agent/图片展示框架.md` | `AI生图资产制作参考.md` | 已建立四个生产图片位、静态 manifest、可选安全视图与展示期固定/降级；真实生图 provider、队列与持久化未实现 |
```

- [ ] **Step 5: 文档一致性与最终提交。**

Run: `git diff --check`，检查仅本任务的文件被修改；更新本 Plan 的任务勾选与真实验收记录。无需再跑未受文档影响的全套测试。

```bash
git add docs/agent/图片展示框架.md docs/agent/地图与地点冒险.md docs/agent/小镇程序化生成.md docs/Agent文档索引.md docs/AI生图资产制作参考.md docs/superpowers/plans/2026-09-08-content-asset-registry.md
git commit -m "docs: record RPG image presentation contracts and verified limits"
```

## Spec 覆盖与 review 记录

| Spec | 交付任务 |
|---|---|
| §1–3 范围/分层，§4 DTO/身份/查询/降级 | Task 1；Task 6 明确生产能力边界 |
| §5 DOM/SVG、固定候选、迟到事件与重入 | Task 2 + Task 5 的实际对白回归 |
| §6 四个入口与题材/对象归属 | Task 3–5 |
| §7 后续服务责任 | Task 6 的实现文档保留未实现说明；不在本 Plan 假造 provider/存储 |
| §8 自动化、浏览器、文档维护 | Task 1–6；临时预览页不进入提交 |

2026-09-08 文档 review：核对真实源码、15 张资源文件及尺寸、当前 package scripts、application facade/读模型和 SVG/Next Image 接入。独立代码示例通过 37 个用例；另外在临时源码副本中按本 Plan 预演四个消费者的接入，172 个定向用例及 1 个新增边界用例通过，完整类型检查（含临时预览页）和选定的 8 个生产/预览文件 lint 通过。测试已适配真实对白的分页合同与 Next Image 的 URL 归一化。

同日，文档修改完成后另派独立子智能体 review，发现并修复两项 P2：预览提交空回调导致对白永久 waiting；图片阻断后硬刷新重置 ready，导致地点/NPC 没有实际尝试图片。已同步修正 Spec §8.2 与 Task 6 的夹具和操作顺序，独立子智能体复核通过。临时源码副本中的 3 个新增定向用例通过，覆盖选项/文本提交后返回与重入、两个真实消费者的图片尝试/错误降级与重入重试；完整类型检查、预览页及验证用例 lint 通过。这些临时验证文件不进入生产仓库。

这些是文档可执行性预演：生产仓库只修改本 Spec/Plan，所有实现 checkbox 仍未执行；全量门禁、production build 与浏览器验收仍由执行阶段完成。未调用真实 AI，未修改图片文件。

执行中若扩展为真实 API 生图，必须先为 Spec §7 的服务工作建立独立设计/计划，列明 producer、状态与持久化合同、同源交付和计费去重验收；不能把本 Plan 的完成状态扩张为“运行时生图完成”。
