# NPC 对话界面重构设计：视觉小说式覆盖层布局

> 日期：2026-08-27
> 状态：待实现
> 参考：`docs/设想/npc对话.png`（仅参考布局，不参考美术风格）

## 1. 目标

把当前居中模态式 NPC 对话界面重构为视觉小说（VN）式场景内覆盖层：立绘居左、底部全宽对话框带名字横幅、右侧竖排选项面板、右上角好感度档位徽标，对话文本逐页翻阅。提升对话沉浸感与可读性，同时完整保留现有对话规则与提交链路。

### 1.1 范围内

- `LocationSceneScreen.tsx` 中 `NpcDialogueModal`（约 :245-464）的布局与渲染重构
- 等待快照 reducer（现 `LocationSceneScreen.tsx:31-54` 类型与 `:56-74` 函数）随组件迁移
- 对话期间场景面板取舍（隐藏右侧 NPC 侧栏与底部行动栏）
- `GameSessionView.currentLocation.npcs[]` 新增 `relationshipTier` 只读投影字段
- `globals.css` 新增对话覆盖层样式区块

### 1.2 明确不做

- 不新增任何 API、route、domain 类型、持久化或行动链路变化（`/api/game/actions` 合同不变）
- 不引入真实立绘图片、AI 立绘生成或背景图替换（场景背景保持现有装饰 SVG）
- 不改变场景视图（非对话状态）的布局
- 不做打字机效果（逐字浮现）
- 不进入共享 foundation：对话布局是 RPG 业务（`docs/游戏开发规范.md` §2.3）

## 2. 布局设计

### 2.1 区块（对照参考图）

| 区块 | 位置 | 说明 |
|---|---|---|
| 场景背景 | 全屏 | 保持现有装饰 SVG 场景，不做修改 |
| 立绘占位 | 左侧，约 55% 屏高 | 风格化占位头像：NPC 名字首字 + 题材主题色（延续 `AdventureVisual` 程序化风格），不新增图片资源 |
| 好感度徽标 | 右上角 | `♥ {NPC名} · {档位}`，半透明底；档位取五档文案，不显示 -100~100 原始数值 |
| 对话框 | 底部居中约 80% 宽 | 深色底 + 描边；左上角名字横幅（NPC 名）；右上角 ✕ 关闭按钮；右下角 ▶ 翻页箭头 |
| 选项面板 | 对话框上方、右侧竖排 | 固定选项（恰好两个）→ 赠物选项 → 分隔线 → 内嵌自由输入框；每项 `>` 前缀 |

### 2.2 面板取舍（变体 1）

对话覆盖层打开期间：

- 隐藏：右侧 NPC 人物卡侧栏、底部行动栏
- 保留可见：顶部 HUD、场景背景、左下角地点描述
- 顶部 HUD 在覆盖层打开期间保持可见但**锁定不可交互**（与现有遮罩 `fixed inset:0 z-index:100` 的等效行为），避免引入对话中返回地图/小镇、切换面板等新边界场景；覆盖层关闭后恢复
- 覆盖层关闭后所有面板恢复

### 2.3 状态矩阵

| 状态 | 对话框内容 | 选项面板 |
|---|---|---|
| 焦点对话（翻页中） | 当前页台词 + ▶ | 隐藏 |
| 焦点对话（最后一页） | 台词 | 显示：两个固定选项 + 赠物（若有）+ 自由输入 |
| 等待回应（提交后） | 提交前快照台词 + 玩家本次回应临时展示 + 内联 loading；翻页冻结在提交时的页码 | 快照中的已选项/赠物项可见但全部禁用 |
| 仅有 startChoice（scene 未 ready） | 空态文案（不展示台词） | 仅单一"开始交谈"入口 |
| handoff 收尾 | 旧 NPC 最后一句 | 仅单一交接选择（本地确认关闭） |
| 非焦点闲聊（零回合） | 环境台词，描边降级为灰色调 | 无；仅"知道了"本地关闭 |
| 生成失败 | 维持最后内容 | 沿用现有失败重试模态，不在覆盖层内兜底 |

## 3. 组件架构

采用方案 A（抽独立组件）：

- 新增 `src/components/NpcDialogueOverlay.tsx`：取代 `NpcDialogueModal` 的全部渲染职责。接收 `NpcDialogueView` 数据与回调（`onSubmit`、`onAcknowledge`、`onClose`）、`phase`、等待快照相关 props（`pendingPlayerResponse`、`pendingChoiceToken`、`resetInputNonce`）、`gameType` 与新增的 `relationshipTier`。纯展示 + 局部交互状态，不访问 store、不生成/解析 token。
- 等待快照 reducer（现 `LocationSceneScreen.tsx:31-54` 类型与 `:56-74` 函数）迁移至新组件文件（或其同目录私有模块），行为不变。
- `LocationSceneScreen.tsx`：保留覆盖层显隐调度与对话数据装配；覆盖层打开时隐藏右侧 NPC 侧栏与底部行动栏的渲染。
- 样式：在 `src/app/globals.css` 新增独立样式区块（项目规范：RPG 主题 CSS 集中于该文件），命名前缀 `npc-dialogue-overlay-*`。同时清理被取代的旧对话样式：现有对话样式分散于四处（约 `:1247-1487`、`:2873-2894`、`:3101-3126`、`:3430-3458`），其中 `npc-dialogue-pager`、`npc-dialogue-continue`、`npc-dialogue-next-step`、`npc-dialogue-reply`、`npc-dialogue-phase-label` 为零引用死样式，随本次重构删除；仍被其他界面使用的样式不删。

## 4. 交互流程与翻页状态机

### 4.1 翻页（纯客户端本地状态）

- 本地状态 `pageIndex`，初始 0。
- `pageIndex < 末页`：选项面板不渲染；点击对话框主体、▶ 箭头或键盘（对话框聚焦时 Enter/Space）翻到下一页。键盘翻页必须排除自由输入框持有焦点的情况：输入框内 Enter/Space 保持现有文本输入与提交语义，不触发翻页。
- `pageIndex = 末页`：▶ 隐藏，选项面板显示。
- 重置判定使用**内容键**而非引用比较：内容键 = 当前显示 NPC 的 `npcId` 与其 `speechPages` 全部页文本的拼接。内容键变化（新 NPC 回应写回）时 `pageIndex` 重置为 0 并 clamp 到有效范围。原因：`projectGameSessionView` 每次投影都新建数组，轮询返回内容相同的新 view 也会改变引用，引用比较会导致翻页中途被意外重置。

### 4.2 提交链路（不变）

固定选项、赠物选项、自由输入统一走现有单一链路：`gameActionRequest`（每次新 UUID）→ `POST /api/game/actions` → `performTurn`。覆盖层不新增任何入口形态。

### 4.3 等待态规则（逐条保留现有行为）

- 提交瞬间捕获本页临时快照（台词、已选项、赠物项与当前页码）；等待态从快照渲染并冻结在提交时的页码，不依赖 pending `GameSessionView` 提供 choices。
- 固定选项已选态、赠物选项、内联 loading 在 pending 快照清空 choices 时仍可见。
- 自由输入只保留在当前页临时状态，不写入对话记录。
- 所有对话入口（选项、输入、关闭、翻页）锁定，`aria-busy` 置位。
- ready 写回后清理快照，直接显示同一 NPC 的新台词与下一组选项，不增加"继续"按钮。

### 4.4 关闭与交接

- ✕ 关闭按钮：等待态/提交中禁用；行为等同现有 `resetDialogue`（本地关闭，不发请求）。
- handoff 收尾：单一交接选择，本地确认关闭（无 choiceToken、不创建 action、不改 revision/turn/location）。
- 非焦点闲聊："知道了"关闭，零写入。
- 目标切换后旧焦点对白的降级/关闭沿用现有规则。

### 4.5 NPC 切换

覆盖层内不提供多 NPC 切换入口。关闭覆盖层回到场景视图后点击其他 NPC 打开其对话/闲聊，与"新出现 NPC 不自动打开"规则一致。

## 5. 数据流与 read model

- 对话内容来源不变：`GameSessionView.narrative.npcDialogues`（`NpcDialogueView`：`speechPages` / `choices` / `freeInputEnabled` / `giveChoices` / `startChoice` / `handoffAcknowledgement`）。
- 新增投影字段：`GameSessionView.currentLocation.npcs[]` 每项增加 `relationshipTier: RelationshipTier`（`"hostile" | "cold" | "neutral" | "friendly" | "trusted"`），由 `projectGameSessionView` 用现有纯函数 `relationshipTierOf(npc.memory.relationship)` 计算。只投影既有领域事实，不新增领域字段；旧存档缺省回落中立由上游 worldState 迁移保证（`npc.memory.relationship` 在类型上必存在），投影层直接调用 `relationshipTierOf`，不做额外兜底。
- 徽标取值规则：按当前显示对话的 `npcId` 从 `GameSessionView.currentLocation.npcs[]` 匹配 `relationshipTier`；该规则同时覆盖非焦点闲聊与 handoff 显示旧 NPC 台词的情况；匹配不到时隐藏徽标，不做默认值兜底。
- 档位→中文文案映射在组件层（敌视/冷淡/中立/友善/信任），UI 永不显示原始数值，遵守现有"关系绝不裸给数字"约定。
- `RelationshipTier` 类型经 `@/game/application` facade 导出供组件使用；组件不 import domain。

## 6. 错误与降级

- AI 生成失败：沿用现有失败重试模态与稳定 `failureKind` 展示；重试复用同一 narrative job；覆盖层不做失败兜底文本。
- 等待/轮询：`ensureNarrative` 观测逻辑原样保留。
- 旧存档兼容：read model 现有过期焦点降级、`speechPurpose` 用途推断逻辑不动，覆盖层只消费投影结果。
- 边界：`speechPages` 为空且存在 `startChoice` 时渲染空态；翻页索引始终 clamp。
- 可访问性：覆盖层 `role="dialog"`、`aria-modal`、`aria-label` 含 NPC 名；等待态 `aria-busy`；翻页与关闭可键盘操作；关闭后焦点回到场景。

## 7. 测试策略

- 新增 `src/components/NpcDialogueOverlay.test.tsx`（规范：新模块必须同目录测试）：
  - 展示：首页台词且选项面板隐藏；翻到末页选项面板出现；名字横幅、好感度档位徽标、占位头像渲染。
  - 交互：点击与键盘翻页；新台词到达重置页码；固定选项与自由输入经 `onSubmit` 提交；等待快照（台词 + 已选项 + 赠物可见且全部入口禁用）；handoff 确认关闭；"知道了"关闭；startChoice 空态。
- 现有测试适配：对话相关用例（约 20+ 例）是 `AdventureGameShell.test.tsx` 中的壳层集成用例（开局→地点→对话→回合），保留在原文件并按新 DOM 适配查询（新布局的 DOM 结构与查询方式必然变化，如等待态 spinner 断言），语义断言不变量必须继续成立；`NpcDialogueOverlay.test.tsx` 承担覆盖层单元级契约（展示/翻页/提交/等待快照/各状态）；`LocationSceneScreen.test.tsx` 新增对话期间侧栏/行动栏隐藏与徽标取值/隐藏的集成用例，既有调查/行动栏用例保持不动。
- `gameSessionView.test.ts`：新增 `relationshipTier` 投影用例（五档边界值；旧存档缺省回落由上游迁移保证，投影层无兜底路径，不单独设例）；现有 fixture 已含 `relationship` 数据。
- 行为回归：`AdventureGameShell.test.tsx` 中"焦点 NPC 恰好两个固定选择 + 一个自定义输入、同一请求 helper"的语义断言必须在适配后的壳层用例中继续成立。

### 验收门禁

`npm run test:boundaries`、`npm run typecheck`、`npm run test:components`、`npm run test:game-application`；合入前全量 `npm test`。

## 8. 规则不变量（重构不得破坏）

1. 焦点 NPC ready 场景恰好两个语义不同的固定选择 + 一个自定义输入。
2. 固定选择由服务端以 opaque `choiceToken` 下发；UI 只显示 label，不生成、不解析、不回退业务 action key。
3. 每次提交产生独立浏览器 UUID，统一经 `/api/game/actions` 与 `performTurn`。
4. 等待态从提交前快照渲染；入口全部锁定。
5. handoff 收尾与非焦点闲聊的本地关闭不创建 action、不推进回合。
6. 闲聊零写入；新出现 NPC 不自动打开。
7. `npcLine.text` 展示规则（无名称前缀、无叙述性包装）沿用现有归一化结果。
