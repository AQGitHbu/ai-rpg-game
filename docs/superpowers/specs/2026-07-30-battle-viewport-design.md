# 场景化战斗与敌人遭遇设计 Spec

> 日期：2026-07-30
> 状态：已确认，供 Phase 9 实现使用
> 范围：单仓 ai-rpg-game；只提升已存在 boss 战的表现和交互

## 目标

让玩家从地点热点发起既有战斗后，进入一个连续、可读、可操作的 RPG 战斗主视窗，而不是回退到信息卡与普通按钮。战斗规则、回合、伤害、任务推进、失败结局与存档仍完全由现有确定性流程裁决。

~~~text
地点敌人热点 → start_battle 成功 → 战斗主视窗
→ 攻击 / 防御 / 撤退 → 服务端规则裁决 → 回合反馈
→ 胜利结局 / 失败结局 / 返回非战斗地点
~~~

## 参考图对比与产品决定

参考图 E 表现为：一张横向战斗场景、敌我角色焦点、顶部回合信息、底部状态区域、右侧行动菜单。当前 BattlePanel 只显示敌名、三个数值和文本按钮。

Phase 9 将把参考图中的空间组织转译为当前 MVP 可支持的界面：

- 本地 SVG 的地点背景成为战斗场景；玩家与敌人以既有 npc/enemy SVG 肖像分列，不调用 AI 生图。
- 顶部显示“战斗中”、当前回合和敌方名称；两侧显示由 BattleView 提供的真实 HP 数值。
- 右侧/底部只显示已有 attack、guard、withdraw action；每个入口仍发送原有 battle_action payload。
- 最近一次成功、拒绝或失败反馈显示为战斗日志条；不伪造伤害、命中、胜负或回合。
- start_battle 成功后由 CurrentGameScreen 既有 battle 分支切换；战斗 resolved 后仍由最新 view 路由到 EndingPanel 或 AdventureGameShell。

## 玩家界面

### 战斗主视窗

BattlePanel 的根布局改为 battle-viewport。其视觉层级为：

1. 战斗 HUD：敌名、回合、可访问的“战斗中”区域名称。
2. 战场：装饰性 location_backdrop SVG、左侧玩家肖像与当前 HP、右侧敌人肖像与当前 HP。
3. 行动栏：攻击、防御、撤退三个可用项。按钮上显示固定图标和安全文案；没有技能、物品、交涉等未来操作。
4. 战斗日志：只在 API 返回 feedback 后显示该反馈；提交期间显示“正在裁决本回合…”。

HP 必须直接显示 BattleView.playerHp 和 BattleView.enemyHp。不得在客户端减少 HP、计算百分比、判断死亡或生成战斗事件。

### 状态与可访问性

- BattlePanel 仍只从 GameSessionView 与 SessionActionView 读数据。
- 提交中与外部 busy 时，所有 battle_action 按钮禁用；不显示新的可写入口。
- 战斗区域使用语义 region，行动栏使用 group；结果反馈使用 aria-live。
- SVG 为装饰性，敌我可访问名称由相邻文本提供。
- max-width: 700px 时战场纵向排列、行动栏改为底部横向可滚动区，HP 和按钮不会重叠。

## 技术约束

- 不修改 GameState、ScenarioBlueprint、battle gameplay、quest reconciliation、ending、intent、API 白名单或 stateVersion。
- 不新增普通敌人、技能、状态、暴击、掉落、经验、治疗、装备/物品效果、重试或自由输入。
- 不泄漏 enemyId、敌人 attack/defense/tier、蓝图、seed、SQLite 或服务端错误。
- 不读取 .env.local，不发 AI/图片/外部网络请求。
- battle/ending 根路由语义保持：active battle 只显示战斗界面；ending 只显示 EndingPanel。
- BattleArena、BattleActionRail、主题 CSS 都是 RPG 业务 UI，不修改 foundation 或 @ai-game/ui。

## 验收

1. active battle 显示场景化战斗主视窗，且玩家、敌人、回合、HP 都来自 GameSessionView。
2. attack、guard、withdraw 均只提交原有 battle_action 和当前 revision；提交中不会重复写入。
3. API 成功、规则拒绝、stale revision、网络错误反馈正确显示；客户端不改 HP/胜负。
4. 非 battle、ending 与 Phase 8 的非战斗游戏壳路由不回归。
5. 三题材 SQLite 胜利与失败旅程继续可重载；所有离线验收和 webpack 构建通过。
6. 不出现 AI、外部图片、未来技能/物品/交涉按钮或新增规则字段。
