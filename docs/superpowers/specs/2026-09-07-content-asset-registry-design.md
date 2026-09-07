# AI 预生成视觉资产接入设计：内容位图片 registry 与降级链

> 日期：2026-09-07
> 状态：待实现（已按「UI 视觉以 AI 预生成为主」的前提重新定向，取代同日早期版本中的九宫格方案）
> 参考：`docs/AI生图资产制作参考.md`（图片位总表与降级原则）、`docs/游戏开发规范.md` §2.3（共享 UI 边界）

## 1. 目标

为 AI 预先生成的视觉资产建立统一接入基础设施：内容位图片 registry（kind × variant 查表）与标准降级组件，使「有图用图、无图/失败回退现有视觉」成为全站一致的机制。AI 预生成 UI 的主体形态是**整图**（场景背景/立绘/插图，固定比例一图一位）与**单体图标**（固定尺寸原样显示），均通过 registry 接入；装饰性 UI 边框不在本期范围（见 §8 决策记录）。

### 1.1 范围内

- `src/components/contentAssets.ts` 内容位 registry（纯数据查表）
- `src/components/ContentAssetImage.tsx` 内容位 DOM 图片组件（多级降级入口）
- `NewGameSetupForm` 题材封面、`TownMapSvg` 建筑图两个既有图片映射迁入 registry
- 同目录测试：registry 单测、组件测试

### 1.2 明确不做

- 不做九宫格/装饰性 UI 边框皮肤系统（理由与未来路径见 §8 决策记录）
- 不接入运行时 AI 生图（`AssetStatus` 状态机不引入，类型契约留给未来生图 spec）
- 不修改共享包 `@ai-game/ui`：registry 含 RPG 业务语义且无第二消费者（`docs/游戏开发规范.md` §2.3）
- 不做图片预加载（静态资产小且缓存命中；生图文档预取窗口面向运行时生成）
- 不新增图片资产（v1 只管理既有 `public/assets/genres|town/`，新资产按生图文档管线另行制作）
- 不触碰 `src/game/**`、API、route、持久化或任何玩法链路

## 2. 架构

| 层 | 载体 | 规则 |
|---|---|---|
| Registry（数据） | `contentAssets.ts` 纯查表 | kind × variant → 图片 URL；与渲染形态解耦：DOM 场景经组件，SVG 场景直接调函数，next/image 场景只取 URL |
| DOM 渲染（组件） | `ContentAssetImage.tsx` | 有图 `<img>` + `onError` 回退 `fallback`；无图直接渲染 `fallback` |
| 既有渲染保持 | next/image / SVG `<image>` | 接入点迁移只换 URL 来源，渲染方式不变（等价重构） |
| foundation `@ai-game/ui` | 不动 | 无关 |

Registry 是未来所有 AI 预生成图片位（生图文档 §3 总表：立绘、场景背景、图标、插图等）的唯一挂点——新资产落位即新增 kind/映射项，渲染层按场景选形态，机制不再演进。

## 3. Registry 设计（`src/components/contentAssets.ts`）

```ts
// kind × variant → 图片 URL；查不到返回 null（调用方渲染现有视觉兜底）
type ContentAssetKind = "genre_cover" | "town_building";
// genre_cover 的 variant = GameTypeId（7 题材）
// town_building 的 variant = TownBuildingType（8 建筑类）
```

- 纯数据查表，无副作用、无状态。
- **variant 类型经派生而非导入**：`GameTypeId` 与 `TownBuildingType` 均非 `@/game/application` 的导出符号，按仓库现行模式从 facade 已导出类型派生（`NewGameInput["gameType"]`、`TownRenderSnapshot["buildings"][number]["buildingType"]`，同 `adventureVisuals` / `TownMapSvg` 现行写法）；不得 import `@/game/domain`，也不得为导入而修改 facade（受 §1.2「不触碰 `src/game/**`」约束）。
- **查表函数签名（重载保证 kind↔variant 配对，守卫保证非法返回 null）**：

```ts
export function contentAssetUrl(kind: "genre_cover", variant: GameTypeId): string | null;
export function contentAssetUrl(kind: "town_building", variant: TownBuildingType): string | null;
// 实现签名收宽（kind: unknown, variant: unknown），白名单 + typeof 守卫，非法一律 null
// （同 resolveAdventureVisualVariant 的「宽入参 + 白名单守卫」模式）
```

调用端 null 流转：next/image 场景条件渲染（见 §5）；SVG 场景 `href={url ?? undefined}` 或跳过渲染；`ContentAssetImage` 渲染 `fallback`。
- kind 白名单可扩展但不预建空映射项：未来按生图文档 §3 图片位总表逐个增加（如 `npc_portrait`、`scene_background`、`item_icon`）。
- `AssetStatus` 契约不引入（见 1.2）；未来运行时生图接入时在 registry 外层包状态机，查表接口不变。

## 4. DOM 组件（`src/components/ContentAssetImage.tsx`）

- Props：`kind` / `variant` / `alt` / `decorative?` / `fallback: ReactNode` / `className?`。
- 行为：查表 null → 直接渲染 `fallback`（SSR 稳定，多数路径）；有图 → `<img src alt>` + `onError` 客户端切回 `fallback`。
- 可访问性对齐 `adventureVisuals` 现有模式：非装饰用 `role="img"` + alt；装饰用 `aria-hidden`，可访问名称由相邻文本提供。
- 不做加载中状态与渐入动画（静态小图渐进显示可接受）。
- 说明：v1 两个接入点一个保持 next/image、一个走 SVG 查表，本组件暂无生产消费者；作为后续 DOM 资源位（NPC 立绘、物品图标等）的标准降级入口随机制落地，以测试覆盖。

## 5. v1 接入点

| 接入点 | 形态 | 降级 |
|---|---|---|
| 新游戏题材卡封面（`NewGameSetupForm`） | `GAME_TYPE_BACKGROUNDS` 硬编码映射迁入 registry（`genre_cover`），渲染保持现有 next/image（`fill`/`sizes`/`priority`）不变——等价重构，保留布局约束与图片优化 | registry 返回 null 时**条件渲染跳过 `<Image>`**（next/image 的 `src` 不接受 null/空串，空串会产出非法 loader 请求），露出 `.game-type-card--visual` 自身背景（全局表面色） |
| 小镇建筑图（`TownMapSvg` 的 `BUILDING_ART`） | 直接调 registry 查表取 URL，塞进 SVG `<image href>` | `<image>` 失败不渲染，底层 `TILE_FILL` 色块天然兜底 |

两个接入点均为等价重构，URL 值不变，现有测试断言不受影响。**迁移约束：不得触碰 `TownMapSvg` 的 `isUnexploredPlaceholder` 门控与未探索灰块渲染**——「未探索建筑不加载真实图片」是反泄漏约束，`TownLayerScreen.test` 已锁定该行为。

## 6. 降级与错误处理汇总

| 场景 | 机制 | 层级 |
|---|---|---|
| 内容位 DOM 加载失败 | `onError` → `fallback` ReactNode | 多级入口，由调用方决定 fallback 层级 |
| 内容位 SVG 加载失败 | `<image>` 不渲染，底色 rect 兜底 | 两级 |
| 内容位 next/image 加载失败 | next/image 自身 `onError` 未启用时表现同裸 `<img>`（破图/隐藏由 CSS 控制）；registry 查不到时条件渲染跳过，露出卡片表面色背景（见 §5） | 两级 |
| 图片整体不可用 | 验收门禁：移除全部图片文件后全流程仍可玩（生图文档 §11 静态版） | — |

「对话/动画播放中不热切图片」原则（生图文档 §2.6）：静态资产无热切场景——内容图随场景切换加载，本设计记录为事实而非运行时机制。

## 7. 测试与验收

### 7.1 自动化

- `contentAssets.test.ts`（同目录）：白名单校验；非法 kind/variant 返回 null；registry 引用的文件必须真实存在于 `public/`（fs 存在性检查，防 registry 静默指向空文件）。
- `ContentAssetImage.test.tsx`：无图渲染 fallback；有图渲染 `<img>`（alt/aria 断言）；`onError` 切换 fallback。
- 既有 `NewGameSetupForm.test.tsx`、`TownLayerScreen.test.tsx` 断言不破（等价重构验证）。

### 7.2 门禁

- `npm run test:components`、`npm run test:fast`（typecheck/boundaries 等，不含 lint）+ `npm run lint`。
- `src/game/**` 零触碰；`dependencyBoundaries.test.ts` 无需新增规则（components 层内部新增，无新跨层 import）。

### 7.3 人工验收

- dev server：新游戏题材卡（封面图正常显示）、小镇地图（建筑图/未探索灰块行为不变）。
- 降级验收：移除 `public/assets/genres|town/` 后题材卡回退卡片表面色背景、小镇回退色块，全流程可玩。

## 8. 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 装饰性 UI 边框（九宫格） | v1 不做，机制不预建 | AI 预生成 UI 的形态是整图+图标（生图文档 §3 总表 20+ 行无一需要九宫格拉伸，「UI 装饰」未被列入 P0–P3 优先级、事实上的最低档）；AI 生图难以产出合格九宫格素材（中心透明需后处理、等宽切片无法保证、纹理拉伸变形）；UI 骨架保持 CSS 轻量样式叠加 AI 整图背景是既定视觉方向。未来若做手工重装饰边框，CSS `border-image` 是原生九宫格能力，届时按需设计，不预建 |
| 内容位实现 | React 组件 + registry 查表 | 多级降级链需要 JS；纯 CSS 无法表达；查表与渲染形态解耦使同一 registry 服务 DOM/SVG/next/image 三种场景 |
| registry 管辖范围 | 仅内容位（整图/图标），不含 UI chrome | 与 AI 预生成资产的实际形态对齐；chrome 保持现有 CSS 几何样式 |
| v1 资产口径 | 只迁移既有映射，不新增资产 | 机制先行；新资产按生图文档管线（预制→P0-P4 优先级）另行落位 |
| `AssetStatus` | 不引入 | 静态资产无状态机；避免为单一状态硬编码；未来生图接入时在查表接口外层包状态机 |
| 题材卡渲染 | registry 供 URL、保持 next/image | 保留 fill 布局约束与图片优化；ContentAssetImage 不适用于此接入点 |
| foundation | 不进共享包 | RPG 业务语义，无第二消费者（开发规范 §2.3） |
