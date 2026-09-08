# RPG 图片展示框架：静态资产 Registry 与异步图片接入

> 日期：2026-09-07；修订：2026-09-08
> 状态：已按当前仓库 review，并完成独立子智能体复核，待实现；本文不是已实现事实。
> Plan：`docs/superpowers/plans/2026-09-08-content-asset-registry.md`
> 依据：`docs/游戏设计原则.md`、`docs/游戏开发规范.md`、`docs/agent/地图与地点冒险.md`、`docs/agent/小镇程序化生成.md`、`docs/AI生图资产制作参考.md`。

## 1. 目标与交付边界

在现有地图、场景、对白和 CSS 布局上建立一套 RPG **图片展示框架**。同一图片位可消费预先制作的本地资产，也可消费未来服务端生图 API 返回的安全图片视图；加载、失败降级、尺寸、可访问性和版本切换遵循同一合同，新增图片无需重写页面。

本期完成展示端闭环：静态 manifest → 候选解析 → DOM/SVG 渲染 → 真实页面接入，并通过测试注入 `generating → ready / failed / stale` 证明异步图片可以接入。当前生产没有生图服务，本期不声称已经有真实 API 生图、队列、持久化缓存或图片恢复能力。

### 1.1 本期交付

1. application 层的纯展示 DTO：图片描述、绑定、六种生成状态，以及 `GameSessionView.visualAssets?` 可选入口；现有 projector 暂不产生该字段，缺省等价于只有静态模板。
2. RPG 静态 manifest 与纯候选解析器：`kind × gameType × variant` 匹配；实例专属图通过绑定传入，不能登记成题材公用图。
3. `ContentAssetImage`（基于 `next/image`）和 `ContentAssetSvgImage`，共用单次展示期内的候选/加载状态逻辑，显式处理资源失败。
4. 四个生产入口：新游戏题材卡、小镇屋顶、地点/建筑背景、NPC 对话立绘。后两者目前仍显示既有 SVG/首字占位，但已使用同一框架，测试可注入图片。
5. 单元、组件、真实消费者集成测试与浏览器降级验收。

### 1.2 Global Constraints

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

不做布局引擎、九宫格皮肤、图集/动画、通用引擎或全部图片位改造。共享模块目录只提供 Panel/InlineButton/Tag 等原语，没有该 RPG 图片绑定职责；首次需求保留本仓，不新建公共包。

## 2. Review 发现与修正

| 原稿问题 | 影响 | 本次决定 |
|---|---|---|
| 只有 `kind × variant → URL`，并禁止状态合同 | 无法表示同题材不同 NPC、异步结果、旧版本或未完成生成 | 分开静态模板与实例绑定，先落展示 DTO；实际服务另立后续计划 |
| `ContentAssetImage` 没有生产消费者 | 组件测试通过也无法证明游戏能接图片 | 四个真实入口均接框架，包含 DOM 和 SVG |
| 题材卡没有 `onError`，SVG 依赖浏览器“自然不渲染” | 404/损坏文件可能留下破图，不能证明统一降级 | 两种渲染器都显式推进候选/移除失败图片，底层占位始终可用 |
| 8 类历史中式屋顶不区分题材 | 科幻、都市等局使用不符题材的资产 | 增加 gameType 维度；历史屋顶只登记武侠/仙侠，其他题材暂用色块 |
| 将静态查表宣称为未来所有资产的固定机制 | 将实体、版本和展示时机问题延后，后续仍需改页面 | 固定图片展示接口；静态目录、专属绑定和后台生成各有责任 |
| 验收要求移动/删除资产，且交给用户补做 | 影响工作区，未覆盖图片优化缓存 | 实现者在浏览器阻断原图和 `/_next/image` 请求并硬刷新，保留文件 |
| 不触碰 application 类型 | 地点/物品 view 没有可用于图片绑定的稳定 ID，容易按名称串图 | 增加可选安全展示入口，不暴露隐藏实体或 Prompt |

这些是设计修订，不是对现有玩法状态的变更。

## 3. 分层与数据流

```text
本地 ContentAssetManifest（已审核预制模板） ───────┐
                                                ├→ resolveContentAssetCandidates
GameSessionView.visualAssets?（安全实例绑定） ────┘            │
                                  展示期固定候选 + 浏览器 load/error
                                                            │
                                ContentAssetImage / ContentAssetSvgImage
                                                            │
                                   既有布局、SVG、首字头像和逻辑交互层
```

未来服务端负责生成、去重、版本存储和可见性审批，通过 canonical application read model 下发 `visualAssets`。组件只读取结果，不自行生成请求、拼接实体路径或解析图片语义。本期使用受控测试数据驱动该入口，不添加第二套会话 store、全局图片缓存或空 Provider。

## 4. 类型合同与身份

### 4.1 图片与绑定（`src/game/application/contentAssetView.ts`）

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

`GameSessionView` 增加 `readonly visualAssets?: GameVisualAssetsView`。只从 application facade 转发上述类型，不向 facade 添加 server 逻辑。

- `scopeKey`：服务端提供的本局视觉命名空间；新局必须不同，不能使用玩家名或 seed。
- `bindingKey`：本局某个已公开实体的某个图片位的稳定 opaque 标识。同 NPC 更新图片不改该值；换 NPC/地点必须不同。
- `requestKey`：一次视觉版本需求的 opaque 标识，未来服务端由规范化生成合同派生；不是 Action ID 或游戏 revision。
- `assetId + version`：不可变内容身份；内容改变必须产生新的版本化 URL，不得覆盖旧版本文件。
- 三种 map 只按 view 已公开的 buildingId / npcId 查找，使用 own-property 守卫。地点图直接挂在当前地点对应的视图中；不得用名称、数组下标或 choiceToken 创建专属图片身份。
- 后续 producer 必须在任务开始前下发稳定 scope/binding（可为 `not_requested`）；同一游戏内不得先无 scope，等 ready 后才临时加入整套视觉身份。已有存档缺省无 visualAssets 时继续静态展示。
- `previous` 只允许属于同一 binding 的仍可公开展示旧图；不能拿另一个 NPC 或未来分支的图顶替。`source="static"` 也可作为实例专属预制图，不要求实例图片都是 API 产物。
- 生成 `status` 与浏览器图片 `loading / loaded / exhausted` 是两个维度。生成 ready 后文件仍可能 404；图片失败不改服务端 status，也不自动重试生图。

### 4.2 静态图片查询（`src/components/contentAssets.ts`）

GameTypeId 与 TownBuildingType 从 NewGameInput、TownRenderSnapshot 派生；不假设 facade 已直接导出这两个名字。

```ts
type ContentAssetQuery = { readonly gameType: GameTypeId | "generic" } & (
  | { readonly kind: "genre_cover" | "location_backdrop"; readonly variant: "default" }
  | { readonly kind: "npc_portrait"; readonly variant: "neutral" }
  | { readonly kind: "town_building"; readonly variant: TownBuildingType }
);
type ContentAssetManifestEntry = ContentAssetQuery & {
  readonly image: ContentAssetImageView;
};
```

manifest 为只读数组，禁止同一个 `(kind, gameType, variant)` 有两个默认模板。静态图片必须有尺寸与版本；当前封面实测 `1368×768`，屋顶 `512×512`，不能把推荐生产尺寸当现有文件尺寸。7 个 JPG 逐项保留；8 个屋顶 WebP 各登记武侠/仙侠两条题材映射，共 23 条 manifest、15 个唯一文件。

`generic` 只表示审核过的通用剪影，不能把历史中式建筑标成 generic。`alternate_history` 当前也不默认复用中式屋顶，因为该题材不保证世界是中国历史背景。没有匹配模板时回退既有色块；以后有实际资产再加条目。地点背景/NPC 暂无图片条目，但有生产图片位和明确 SVG fallback。

### 4.3 解析与降级

```ts
resolveContentAssetCandidates(
  query: ContentAssetQuery,
  binding?: ContentAssetBindingView,
  manifest?: readonly ContentAssetManifestEntry[],
): readonly ContentAssetImageView[]
```

解析器纯函数、无网络/全局可变状态：

1. 校验 query 的 kind、gameType、variant 白名单。非法输入返回空数组，不能借 generic 绕过非法 kind/variant。
2. binding 的 kind/gameType/variant 必须精确匹配 query，且 bindingKey/requestKey 非空；不匹配即忽略整条绑定。
3. 按状态取候选：ready 的 image、同绑定 previous；stale 的 image；queued/generating/failed 的 previous；not_requested 无专属图。
4. 追加精确题材模板，再追加同 kind/variant 的 generic 模板。运行时当前图/旧图优先于模板；没有的层直接跳过。
5. 校验每张图：非空 assetId/version、正整数尺寸、合法 source 与允许的 src；排除非法条目，并按 src 去重保持顺序。浏览器单次展示内每个 URL 最多尝试一次。
6. 全部失败后显示调用方的既有 SVG/首字/表面色，不产生新剧情或替代文字。视觉 fallback 不放宽“生产 AI 剧情绝不 fallback”。

原 `contentAssetUrl(kind, variant)` 不再作为公共 API，避免组件继续绕过状态和降级。静态 manifest 与未来图片存储清单不是同一回事；专属图片不塞进全局题材表。

## 5. 渲染和展示期

### 5.1 DOM

ContentAssetImage 消费 query、binding?、presentationKey、fallback、sizes、fit、className?、priority? 和可访问性参数。所有 DOM 入口使用它；内部 `<Image fill>` 保留 Next 图片能力。预制图正常优化，`source="generated"` 使用 unoptimized 直接加载同源文件，未来需要认证的图片不绕经共享优化缓存。

- 外层稳定定位框始终存在，调用方决定宽高；fill 父节点必须有明确尺寸。背景用 cover，人物用 contain；图片/占位不承载按钮。
- 占位先可见，图片完成初次 load 后显示；onError 显式移除该 URL 并尝试下一候选，全部失败只剩占位。
- 非装饰模式只有框提供 `role="img" + aria-label`；内层图片空 alt、fallback 子树 aria-hidden，避免重复朗读。装饰模式整个框 aria-hidden，可访问名称由相邻 UI 文字承担。
- 不显示全屏生图 loading，不新增自动重试、不改变焦点、布局高度、对白或输入值。

### 5.2 SVG

ContentAssetSvgImage 消费同一查询和展示期合同，以及 SVG x/y/width/height。输出仍是原生 `<image>`，不能在 SVG 中放 HTML img 或 next/image。onError 推进候选，耗尽时返回 null，保留底层 TILE_FILL 和建筑交互 rect。

小镇的未探索门控先于解析与组件创建执行；外层继续 `aria-hidden="true" pointerEvents="none"`。图片不影响 footprint、寻路、按钮标签、点击或键盘操作。

### 5.3 固定候选，不在阅读中升级

每个 renderer 在 presentationKey 对应的子组件首次挂载时固定候选数组。此后同 key 的 ready、stale、requestKey 更新只作为下次进入的输入，不改变当前图片 URL；生成完成也不得插入隐藏预加载图。初次选定 URL 的浏览器 load 完成属于正常加载，不是采用新生成版本；它只在固定框内显示，不渐入、不影响输入。

presentationKey 改变时通过 React key 重建子组件，清除候选、加载与失败状态。它来自 **scope + 图片位 + 当前公开对象/绑定**，不来自游戏 revision、台词、输入或 requestKey。关闭/重新打开对话、离开/重新进入地点时原组件卸载，同 key 也会重新采样。不同实体必须重建，不能跨 NPC 保留旧脸；只有图片子树重建，不能 key 整个对白表单导致输入丢失。

错误状态以候选 URL 记录在本次展示内：A 失败后尝试 B，A 的迟到事件不能使 A 重新显示；退出重入允许重新尝试同 URL。新图片版本使用新 URL。没有跨场景缓存或计费重试状态机。

## 6. 四个入口与实际数据来源

| 入口 | query / binding 来源 | 展示期与 fallback |
|---|---|---|
| NewGameSetupForm | genre_cover / 卡片 gameType / default；无 binding | `genre-cover:<题材>`；现有 62px 框，空内容让表面色露出；保留 sizes=220px 与默认题材 priority |
| TownMapSvg | town_building / 从 AdventureGameShell 传入规范化题材 / buildingType；visualAssets.townBuildings 的 own buildingId 条目 | scope + town-roof + buildingId + bindingKey；门控先执行，失败剩 TILE_FILL |
| LocationSceneScreen 背景 | location_backdrop / 当前题材 / default；建筑内只用 buildingBackdrops[sceneBuildingId]，独立地点用 locationBackdrop | scope + backdrop + buildingId/绑定；不把镇外背景用于内景；fallback 原 AdventureVisual |
| NpcDialogueOverlay 立绘 | npc_portrait / 当前题材 / neutral；LocationSceneScreen 依据 displayedDialogue.npcId 查 npcPortraits 后传入 | scope + npc-portrait + npcId；整个对话期间固定；fallback 保留原题材 SVG + 首字头像，真图加载后隐藏这整组占位 |

TownLayerScreen/TownMapSvg 的 gameType 必传，不能默认为 wuxia。旧 view 的 gameType 是 string，统一经 `normalizeAssetGameType(unknown)` 规范化为合法题材或 generic；不要使用 as 掩盖非法输入。

当前 server 不产出 visualAssets；因此缺少 scope 的旧会话只使用静态模板/占位。未来启用运行时图片时，scope 必须从首个 view 就存在；异步只更新既有 binding 的状态/版本。没有 scope 的孤立 binding 一律不接入。

地图锁定节点、物品、敌人、玩家立绘、战斗背景、序幕/结局等后续按同一流程增加：先确定 view 中已公开的对象与绑定入口，再补 kind/variant、manifest（有实际素材才登记）、生产消费者和测试。物品当前不暴露 itemId，不能按名称接专属图，应由后续 read model 直接附加图片绑定。序列帧/atlas 需要独立 renderer 合同，不承诺用单张图片接口播放动画。

## 7. 后续真实 API 的明确责任

框架交付后，生图服务另行设计实现以下工作，不能把测试注入冒充完成：

1. server-only 调用 provider，公开事实审批先于排队；只服务当前已释放实体和确实选定的结果，不为隐藏 NPC、未探索建筑或另一结局预付费生成。
2. generationKey 至少包含本局/对象视觉身份、kind、variant、档案版本、题材风格版本、Prompt 版本、模型版本、尺寸和参考图 hash；相同需求去重。服务端排队、取消、预算和手动重试独立于 narrative job。
3. 只在 `(scopeKey, bindingKey, requestKey)` 仍为当前需求时提交/投影异步结果；旧请求完成只存旧资产，不能覆盖新需求。保存不可变版本引用，恢复存档不重新收费生成。
4. provider 产物经校验与存储后转换为同源版本化 `/assets/…` URL，再投影 DTO；URL 中不带 token、Prompt、内部 ID 或供应商临时签名。交付方式/认证/缓存头/存储回收在服务计划内定义，不在组件增加任意域名白名单。
5. 将 DTO 挂到唯一 GameSessionView；只投影可见 binding，map 键必须属于当前允许显示的 NPC/建筑。没有隐藏实体全量 manifest、Prompt、失败原文或私密记忆。
6. 实现专属 server/请求适配器与持久化测试，包括乱序结果、新局隔离、刷新恢复和去重计费；本期 UI 生命周期测试不能替代这些服务测试。

## 8. 验收与文档维护

### 8.1 自动化验收矩阵

| 验收项 | 必需证据 |
|---|---|
| 静态登记正确 | 23 条唯一查询键、15 个实际非空文件；URL 原值与实际尺寸；不匹配题材不使用历史屋顶 |
| 候选解析 | 非法 kind/variant、原型链键、URL/尺寸错误；绑定 mismatch；六种状态；旧图→题材→generic 的顺序与去重 |
| DOM/SVG 错误 | 首图失败进入次图；全部失败移除图片；占位、尺寸、可访问名称和操作入口仍在 |
| 异步显示 | generating→ready 同展示期不加载新 URL；重入后采用；failed/stale 可显示授权旧图；不触发 fetch/Action |
| 实体/版本隔离 | 同题材两个 NPC 不串图；scope/对象切换清除旧失败；同 URL 重入可重试；旧元素迟到 load/error 无法恢复旧图 |
| 真消费者 | 题材卡 error 后仍能选择；town 图片失败后仍能点击/键盘进入；未探索建筑没有专属 image；对白输入和选择不因图片更新丢失 |
| 分层与无行为回归 | 可选 DTO 经唯一 facade；原六 route、游戏状态和生产 projector 输出不变；现有组件、应用和旅程回归通过 |

### 8.2 命令与浏览器

定向 TDD 后运行 `npm run test:components`、`npm run test:fast`、`npm run lint`，合入前按开发规范运行 `npm test` 与 `npm run build`。不执行真实 AI smoke，不修改 current-phase 指向另一个功能。

实现者负责浏览器验收：按 Plan Task 6 建立一次性 `/asset-preview` UI 夹具，桌面与窄屏检查题材卡/地图/场景/对话以及模拟生成完成。用浏览器请求阻断覆盖 `/assets/**` **及** `/_next/image*` 并禁用缓存、硬刷新；刷新后先模拟 ready，再进入场景/打开对白，确认地点背景与 NPC 立绘确实尝试过图片并降级，不能把 generating 时从未请求图片的占位算作失败证据。取消阻断、硬刷新后同样先模拟 ready 再进入，验证恢复。失败时无破图标记、输入/地图入口不丢失；夹具对白选项和文本提交仅返回预览小镇，重入后仍可交互，不模拟规则结果。夹具不连接游戏 API、不写入存档，验收后删除精确的临时页面，不能进入提交。不得移动/删除 public 资产，不要求用户补做正常开发验收。

当前浏览器已没有旧文档描述的离线开局入口，不通过正式开局触发真实 AI 验收。规则可完成性与恢复使用现有 `foundationJourney.test.ts`（`npm test` 包含，定向命令为 `npm run journey:foundation`）证明；浏览器夹具仅证明真实组件的图片/交互行为，不冒充完整游戏或真实生图服务。

### 8.3 状态与文档

本次 review 只改 Spec/Plan，不把架构标为已实现。执行结束后新增 `docs/agent/图片展示框架.md`，更新 Agent 索引、地图/小镇实现文档与生图参考 §1，并说明“展示合同已接入，真实生图服务未实现”。不改策划玩法或 MVP 当前阶段。

框架行为依据：Next 的 [`fill`、`onLoad`、`onError`、`unoptimized`](https://nextjs.org/docs/app/api-reference/components/image)；React 的 [用 key 重置局部状态](https://react.dev/learn/preserving-and-resetting-state)。版本以本仓 package.json 的 Next 16.2.10 / React 19.1.0 为准，不借 review 升级依赖。
