# UI 视觉皮肤系统设计：九宫格 Chrome 皮肤与内容位图片 registry

> 日期：2026-09-07
> 状态：待实现
> 参考：`docs/AI生图资产制作参考.md`（资产规格与降级原则）、`docs/游戏开发规范.md` §2.3（共享 UI 边界）

## 1. 目标

为现有 DOM 渲染的 UI 引入视觉图片皮肤系统：UI 外壳（面板/对话框/HUD/模态/Toast/按钮）通过 CSS `border-image` 九宫格皮肤换肤，游戏内容视觉位（题材封面/小镇建筑等）通过统一 registry 实现「有图用图、无图回退现有视觉」。机制支持任意多套皮肤，v1 仅随附一套通用暗色古典皮肤与程序化占位资产。

### 1.1 范围内

- `src/app/globals.css` 新增皮肤 token 与 `[data-skin]` 作用域九宫格规则
- `src/app/layout.tsx` 的 `<body>` 挂 `data-skin="classic"`（一个属性，零新增 DOM）
- `src/components/contentAssets.ts` 内容位 registry（纯数据查表）
- `src/components/ContentAssetImage.tsx` 内容位 DOM 图片组件（多级降级入口）
- `public/assets/skins/classic/ui/` 程序化占位九宫格资产入库
- `NewGameSetupForm` 题材封面、`TownMapSvg` 建筑图两个接入点迁入 registry
- 同目录测试：registry 单测、组件测试

### 1.2 明确不做

- 不接入运行时 AI 生图（`AssetStatus` 状态机不引入，类型契约留给未来生图 spec）
- 不修改共享包 `@ai-game/ui`：皮肤含 RPG 业务语义且无第二消费者（`docs/游戏开发规范.md` §2.3）
- 不做皮肤运行时切换 UI（多套机制就位，切换入口留给未来需求）
- 不做图片预加载（静态资产小且缓存命中；生图文档预取窗口面向运行时生成）
- 不制作正式美术资产（占位资产验证机制，正式资产规格写入本 spec 供后续制作对齐）
- 不触碰 `src/game/**`、API、route、持久化或任何玩法链路

## 2. 架构总览

### 2.1 分层边界

| 层 | 载体 | 规则 |
|---|---|---|
| Chrome 皮肤（装饰性容器） | CSS `border-image` + `[data-skin]` 后代选择器 | 挂在既有 class contract（`.panel` 等）上；共享包与所有 skinned surface 的 JSX 零改动 |
| 内容位图片（语义性实体图） | React 组件 + TS registry | 复用 `adventureVisuals` 白名单查表模式；有图用图、无图/失败回退现有视觉（SVG/主题色块） |
| foundation `@ai-game/ui` | 不动 | 皮肤是本产品主题，不进共享包 |

边界判据：**装饰性容器（边框/面板底）走 CSS 皮肤层；语义性实体图（某一具体题材/建筑/物品的图）走内容位组件。**

### 2.2 文件布局

```text
public/assets/skins/classic/ui/        新增：皮肤 chrome 占位资产
public/assets/genres|town/             既有：内容位静态资产（迁入 registry 管理）
src/app/globals.css                    扩展：皮肤 token + [data-skin] 规则
src/app/layout.tsx                     微改：<body> 挂 data-skin="classic"
src/components/contentAssets.ts         新增：registry 查表
src/components/ContentAssetImage.tsx    新增：内容位 DOM 图片组件
```

`src/components/ui/` 空目录保持不动——本设计下九宫格 chrome 无 React 原语，不为用而用。

## 3. Chrome 皮肤层

### 3.1 Token 机制

```css
[data-skin="classic"] {
  --skin-panel-image: url("/assets/skins/classic/ui/panel-border.webp");
  --skin-panel-slice: 72;         /* 2x 源图的图像像素；见 3.4 资产规格 */
  --skin-panel-width: 18px;       /* 渲染宽 token，按 surface 独立定值；见 3.4 */
  --skin-panel-radius: 0;         /* 皮肤接管圆角，成组覆盖 */
}
[data-skin="classic"] .panel {
  border-width: var(--skin-panel-width);      /* 与 border-image-width 同值，见红线 4 */
  border-image: var(--skin-panel-image) var(--skin-panel-slice)
    / var(--skin-panel-width) / 0 stretch;
  border-radius: var(--skin-panel-radius);
  /* 兜底属性保留：border-style/color、background、backdrop-filter 不移除 */
}
```

- v1 唯一皮肤 `classic`，延续当前 `--game-*` 暗色古典调性。
- 每套皮肤 = `[data-skin="<id>"]` 作用域下的一组 `--skin-<surface>-*` token；新增皮肤即新增一组作用域规则，机制零扩展成本。

### 3.2 v1 Surface 清单

| 优先级 | Surface | 挂载 class（真实类名） | 说明 |
|---|---|---|---|
| 必做 | 面板 | `.panel` | Panel 共享原语输出；`.panel.compact-panel` 为复合类，一条规则即覆盖，不单列 |
| 必做 | NPC 对话框 | `.npc-dialogue-*` 对话框主体容器类 | VN 式对话框是视觉焦点 |
| 必做 | HUD | `.adventure-hud-player-card` | `adventure-hud-layer` 是全屏定位壳、`adventure-hud-topbar` 是无边框渐变条，均不挂皮肤 |
| 必做 | 模态 | `.adventure-overlay-content`、`.narrative-generation-modal-content` | 后者是 `GenerationStatusModal` 的实际输出类名（组件名与类名不同源）；两者共用 `modal-border.webp` |
| 必做 | Toast | `.adventure-toast` | |
| 应做 | 按钮 | `.inline-button`（InlineButton 输出） | hover/disabled 用 CSS filter（brightness/saturate）叠加，不做多状态资产 |

注：依赖既有边框几何定位的装饰元素（如 `.npc-dialogue-overlay-banner` 以负偏移压在边框上）换肤后需复核偏移值。

### 3.3 编码红线

1. **`border-image` 与 `border-radius` 互斥**——皮肤 token 必须成组覆盖：radius 归零，圆角由图提供。
2. **v1 边框图不用 `fill` 关键字**——中心保留现有半透明背景 + `backdrop-filter: blur(14px)`；未来皮肤需要中心纹理时由同一 surface 的 token 成组提供，且必须保证文字对比度。
3. **兜底属性永不移除**——皮肤规则不移除 `border-style/color` 与 `background`；`border-image` 加载失败时 CSS 原生回退到几何边框（颜色/样式不变，宽度为皮肤宽），这就是离线降级。
4. **`border-width` 必须与 `border-image-width` 同值成组覆盖**——`border-image` 不改变布局，内容区仍由 `border-width` 决定；现有各 surface 几何边框多为 1px，若不把 `border-width` 提到与 `border-image-width` 一致，九宫格边缘会向内侵入 padding 区压住文字（`.panel` padding 20–32px、`.adventure-toast` padding 10px、`.inline-button--sm` padding 7px 都会被压）。渲染宽 token 按 surface 独立定值，为视觉比例负责（见 3.4）。

### 3.4 资产规格（占位资产同样遵守；正式资产按此制作）

- 每个 surface 一张边框源图：`{surface}-border.webp`（`panel-border.webp`、`dialogue-border.webp`、`hud-border.webp`、`modal-border.webp`、`toast-border.webp`、`button-border.webp`）。
- 逻辑尺寸：面板/对话框/HUD/模态/Toast 512×512，按钮 256×256；物理分辨率统一 2x（1024×1024 / 512×512）。
- **slice 四边等宽固定**：大 surface 2x 图 72px（逻辑 36px），按钮 2x 图 48px（逻辑 24px）——slice 是源图切割线，与渲染宽无关，全部 surface 共用同一套切割规格。
- **渲染宽是独立 token**（`--skin-<surface>-width`），按 surface 视觉比例定值，并按红线 4 同值覆盖 `border-width`。v1 参考值：panel/dialogue/modal/hud 18px、toast 12px、button 8px；实现期可微调，但不得大于该 surface 的 padding（避免边框吃掉内容留白）。
- 中心透明（无 `fill`），WebP 带 alpha。
- 占位资产由一次性脚本程序化生成（纯色底 + 角部标记 + 描边），脚本不入库，产物入库。
- 正式资产制作对齐 `docs/AI生图资产制作参考.md` §3「UI 装饰」行（128–512、透明、统一设计系统、禁图内文字）。

## 4. 内容位 registry 与组件

### 4.1 Registry（`src/components/contentAssets.ts`）

```ts
// kind × variant → 图片 URL；查不到返回 null（调用方渲染现有 SVG 兜底）
type ContentAssetKind = "genre_cover" | "town_building";
// genre_cover 的 variant = GameTypeId（7 题材）
// town_building 的 variant = TownBuildingType（8 建筑类）
```

- 纯数据查表，与渲染形态解耦：DOM 场景经 `ContentAssetImage` 组件，SVG 场景直接调用查表函数。
- 类型只从 `@/game/application` 导入（与 `adventureVisuals` 同模式，合规）。
- kind 白名单可扩展但不预建空映射项：未来 SVG→位图替换按 `AdventureVisualKind` 资源位逐个增加，与生图文档 §3 图片位总表对位。
- `AssetStatus` 契约不引入（见 1.2）。

### 4.2 组件（`src/components/ContentAssetImage.tsx`）

- Props：`kind` / `variant` / `alt` / `decorative?` / `fallback: ReactNode` / `className?`。
- 行为：查表 null → 直接渲染 `fallback`（SSR 稳定，多数路径）；有图 → `<img src alt>` + `onError` 客户端切回 `fallback`。
- 可访问性对齐 `adventureVisuals` 现有模式：非装饰用 `role="img"` + alt；装饰用 `aria-hidden`，可访问名称由相邻文本提供。
- 不做加载中状态与渐入动画（静态小图渐进显示可接受）。
- 说明：v1 的两个接入点一个保持 next/image（见 4.3）、一个走 SVG 查表，本组件暂无生产消费者；作为后续 DOM 资源位（NPC 立绘、物品图等）的标准降级入口随机制落地，以测试覆盖。

### 4.3 v1 接入点

| 接入点 | 形态 | 降级 |
|---|---|---|
| 新游戏题材卡封面（`NewGameSetupForm`） | `GAME_TYPE_BACKGROUNDS` 硬编码映射迁入 registry（`genre_cover`），渲染保持现有 next/image（`fill`/`sizes`/`priority`）不变——等价重构，保留布局约束与图片优化 | registry 查不到时回退题材主题色背景（卡片底色即兜底） |
| 小镇建筑图（`TownMapSvg` 的 `BUILDING_ART`） | 直接调 registry 查表取 URL，塞进 SVG `<image href>` | `<image>` 失败不渲染，底层 `TILE_FILL` 色块天然兜底 |

两个接入点均为等价重构，URL 值不变，现有测试断言不受影响。**迁移约束：不得触碰 `TownMapSvg` 的 `isUnexploredPlaceholder` 门控与未探索灰块渲染**——「未探索建筑不加载真实图片」是反泄漏约束，`TownLayerScreen.test` 已锁定该行为。

## 5. 降级与错误处理汇总

| 场景 | 机制 | 层级 |
|---|---|---|
| Chrome 图缺失/404/离线 | CSS 原生：`border-image` 失效自动露出几何边框（`border-style/color` 不变，宽度为皮肤 `border-width`）+ 半透明背景 | 两级（有皮/无皮），零代码 |
| 内容位 DOM 加载失败 | `onError` → `fallback` ReactNode | 多级入口，由调用方决定 fallback 层级 |
| 内容位 SVG 加载失败 | `<image>` 不渲染，底色 rect 兜底 | 两级 |
| 图片整体不可用 | 验收门禁：移除全部图片文件后全流程仍可玩（生图文档 §11 静态版） | — |

「对话/动画播放中不热切图片」原则（生图文档 §2.6）：静态资产无热切场景——皮肤全站恒定、内容图随场景切换加载，本设计记录为事实而非运行时机制。

## 6. 测试与验收

### 6.1 自动化

- `contentAssets.test.ts`（同目录）：白名单校验；非法 kind/variant 返回 null；registry 引用的文件必须真实存在于 `public/`（fs 存在性检查，防 registry 静默指向空文件）。
- `ContentAssetImage.test.tsx`：无图渲染 fallback；有图渲染 `<img>`（alt/aria 断言）；`onError` 切换 fallback。
- `sharedUiContract.test.tsx` 既有断言继续锁定 class contract 不变。`data-skin="classic"` 挂载验证：src/app 现有测试均为 API route 契约测试、无 DOM 渲染先例，v1 不首创 app 层 DOM 测试，采用源码级断言（`layout.tsx` 包含 `data-skin="classic"`）+ 人工验收确认皮肤生效。

### 6.2 门禁

- `npm run test:components`、`npm run test:fast`（typecheck/lint/boundaries）。
- `src/game/**` 零触碰；`dependencyBoundaries.test.ts` 无需新增规则（components 层内部新增，无新跨层 import）。

### 6.3 人工验收

- dev server 全界面截图：panel（新游戏表单/详情面板）、NPC 对话框、HUD、模态、Toast、按钮（含 hover/disabled）。
- 离线降级：临时移除 `public/assets/skins/` 与内容图后，创建→游玩→结局全流程可玩且视觉回到现有几何样式。

## 7. 文档维护（实现完成后）

- 更新 `docs/AI生图资产制作参考.md`：§1 当前视觉实现补充皮肤系统现状；占位资产与正式资产规格的关系。
- 更新 `docs/Agent文档索引.md` 对应条目：UI 皮肤 token 机制、registry、降级链为已实现事实。
- 策划文档无变化（视觉皮肤不构成玩家可见规则）。

## 8. 决策记录

| 决策 | 选择 | 理由 |
|---|---|---|
| 九宫格实现 | CSS `border-image` 而非 React 组件 | 浏览器原生九宫格语义；挂既有 class contract，共享包与 JSX 零改动；流式布局 `stretch` 天然适配 |
| 内容位实现 | React 组件 + registry | 多级降级链与加载状态需要 JS；纯 CSS 无法表达 |
| v1 皮肤数量 | 机制多套、v1 一套 `classic` | 资产量最小，机制扩展性完整 |
| registry 范围 | chrome 与内容位统一机制 | 降级语义各得其所，边际成本低 |
| 资产口径 | 机制先行 + 程序化占位资产 | 机制与美术解耦，验收不被资产迭代阻塞 |
| `AssetStatus` | 不引入 | 静态资产无状态机；避免为单一状态硬编码 |
| `src/components/ui/` | 保持空置 | 无 React 原语需求，不为用而用 |
| `data-skin` 挂载点 | `<body>` 元素（非新增包装 div） | layout.tsx 现为 html/body 结构；挂 body 零新增 DOM，且对未来 portal 到 document.body 的组件免疫 |
| 题材卡渲染 | registry 供 URL、保持 next/image | 保留 fill 布局约束与图片优化；ContentAssetImage 不适用于此接入点 |
