# 非战斗游戏视窗与交互层设计 Spec

> 日期：2026-07-30
> 状态：已确认，供 Phase 8 实现使用
> 范围：单仓 ai-rpg-game；不修改 foundation、AI 或战斗规则

## 目标

在不改变确定性的地图、地点、NPC、线索、物品、任务与存档规则的前提下，把当前的卡片、文本列表和行内按钮重组为可持续游玩的非战斗 RPG 界面：地图和地点成为主画面，玩家通过 HUD、场景热点、行动栏与独立信息界面操作。

~~~text
世界地图（可视路线与节点）
→ 进入 / 前往地点
→ 地点主场景（背景、热点、行动栏）
→ NPC 对话 / 观察 / 调查 / 拾取
→ 规则裁决、任务与日志更新
→ 返回地图或打开角色 / 背包 / 任务 / 日志
~~~

## 参考图对比

| 参考图体验 | 当前 Phase 7 | Phase 8 改造 |
|---|---|---|
| 大地图是一张主画面，节点、路线、目标和系统入口同时可见 | 节点是等宽网格里的文字按钮，map_base SVG 未承担地图主体 | map_base 成为地图背景；安全 read model 给出稳定节点位置，节点叠加在地图上 |
| 地点是一张可探索的场景，右侧有行动入口 | 背景、热点和返回按钮排成普通网格 | 地点成为大场景；热点按既有 slot 定位，右侧行动栏只显示已有真实能力 |
| 角色、背包、任务、日志是可打开和关闭的独立界面 | 四项信息藏在行内 tab，开场资料长期占据页面 | 固定 HUD 提供四个图标化入口，各自打开 RPG 业务弹层 |
| NPC 对话有角色焦点、对白区、选项区 | 对话是裸 dialog 与按钮 | 对话弹层加入本地 SVG 肖像、中性开场语、固定选项和只读线索区 |
| 信息与行动围绕当前场景 | OpeningGameView 在每个 active 页面顶部重复大段开场报告 | active 主界面不再渲染 OpeningGameView；开场叙事进入日志 |

交易、偷窃、赠与、自由输入、同伴、装备使用、技能、随机遭遇和战斗改造均不在本阶段范围；不能以可点击的假按钮暗示尚未存在的规则。

## 玩家可见设计

### 持续 HUD

非战斗状态下 AdventureGameShell 顶部固定显示世界名、当前地点、玩家姓名/身份、HP 和安全主线摘要；右侧或底部显示角色、背包、任务、日志四个图标化按钮。窄屏时变为可折行的底部工具栏，所有入口仍可键盘访问。

HUD 只读取 GameSessionView 已公开字段。主线摘要只取 active main quest 的名称与第一个未完成 objective label；没有主线时显示“暂无线索”。不得读取完整蓝图、隐藏地点、seed、GameState 或 SQLite。

### 世界地图

地图是旅行层：本地 SVG 背景作为舞台，节点覆盖在确定位置。current 点击仅进入当前地点（零请求）；travelable 提交既有 move；known 与 locked 保持禁用。节点位置由 application 层纯投影给出，不写入 GameState；locked 节点仍不含真实地点 ID、名称或描述。

地图显示只读“当前目标”小卡，只复用 HUD 的安全主线摘要，不能反推出隐藏地点。

### 地点与行动栏

地点背景占据主区域。既有 SceneSlot 映射为热点位置；热点保留可访问名称、键盘可达性和现有真实 intent。右侧行动栏每个入口必须对应当前可用能力：

- 人物：打开在场 NPC 热点/选择界面；
- 观察：只有 observe 时出现，提交该 action；
- 线索：只有 investigate 时出现，打开或聚焦对应线索热点；
- 物品：只有 take_item 时出现，打开或聚焦对应物品热点；
- 地图：本地返回地图，零请求。

没有行动的类别不渲染。敌人热点仍可触发既有 start_battle；battle active 后继续显示现有 BattlePanel，不重制战斗。

### 弹层与信息页

角色、背包、任务、日志、场景行动和 NPC 对话共享 RPG 业务弹层壳：role=dialog、清晰标题、关闭按钮、Escape 关闭、打开时焦点进入、关闭后恢复触发按钮焦点。不得创建 foundation 通用 Modal。

- 角色：姓名、身份和既有数值。
- 背包：inventoryItems，空时显示空态。
- 任务：activeQuests 与既有完成态。
- 日志：storyEvents，并把安全的 openingNarration 显示为“旅程开端”。
- NPC：肖像、名字、身份、中性开场语、可写固定选项、review_clue 本地展开。

只有既有 dialogue_choice、observe、investigate、take_item、start_battle、move 可以发送请求。提交中所有写状态入口禁用；纯关闭与只读线索保持本地行为。

## 技术与安全约束

- 不增加 GameState、蓝图持久化字段、事件类型、intent 类型或 stateVersion；旧存档直接可投影。
- 地图节点可见范围和 locked 零泄漏契约不变；布局字段不携带 locked 真实 ID、名称或描述。
- UI/API 仍只从 application facade 消费 GameSessionView；不读取 .env.local。
- 所有视觉继续使用仓库内 AdventureVisual 内联 SVG 与 CSS；零 AI 生图、零外部图片 URL、零网络图片 fetch。
- OpeningGameView 与兼容测试保留，但 active 游戏根界面不再把它作为主布局。
- battle/ending 路由不变：BattlePanel 与 EndingPanel 继续处理。
- max-width: 700px 下 HUD、地图节点、行动栏、热点和弹层不能溢出；所有操作可键盘完成。

## 验收标准

1. 开局或恢复后，非战斗页面首先显示 HUD 与地图视窗，而非 OpeningGameView 卡片堆。
2. current、travelable、known、locked 节点的交互与零泄漏不变；节点位置稳定。
3. 进入地点后显示主场景、热点和仅含真实可用能力的行动栏；每个 payload 与 Phase 7 完全一致。
4. HUD 四项入口与 NPC 对话都以可关闭、可访问弹层呈现；日志含开场叙事，背包/任务空态正确。
5. 对话、复盘线索、stale revision、规则拒绝、提交禁用、battle/ending 切换不回归。
6. 三题材离线 SQLite 完整旅程与所有离线门禁通过；不调用真实 AI 或图片网络。

## 明确排除

- 战斗场景、普通敌人、技能、装备使用、交易、赠与、偷窃、同伴、语音；
- 自由输入、AI 对话/叙事、AI 生图、真实 API smoke；
- 地图内容扩张、随机事件、任务规则或数值重做、多存档；
- foundation 或 @ai-game/ui 修改。
