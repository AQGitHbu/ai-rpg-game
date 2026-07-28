# 无 AI MVP 试玩验收执行 Plan

> 日期：2026-07-28  
> 状态：已完成（2026-07-28）
> 目标分支：`codex/mvp-no-ai-playable-vertical-slice`  
> 唯一修改仓库：`ai-rpg-game`  
> 上游基线：MVP Phase 6 已合入 `main`（`501f99f`）

## 定位

这不是原始 Spec 的新 Phase，也不修改其 Phase 0–6 编号。原 Spec 的无 AI 规则闭环已由实际 Phase 3–6 实现；本工作包只补齐试玩所需的表达、可见性和本地开发重开局能力，使开发者无需 AI 即可手工走完一局。

## 目标

在 `next dev` 的开发环境中，玩家能够：填写开局资料、查看世界/角色属性/地点/NPC/物品/任务、执行固定行动并看到连续的模板化冒险记录、通过战斗走到成功或失败结局；需要重试时，可明确确认后仅清除当前本地开发存档并重新开局。

```text
新建配置 → fallback 世界与开场叙事 → 探索 / 对话 / 调查 / 拾取 / 移动
→ 任务推进 → boss 战（胜利或撤退）→ 结局 → 开发环境清档 → 新一局
```

## 边界

### 包含

- `GameSessionView` 安全投影基础角色属性与最近的结构化事件；
- RPG 内的模板化冒险记录和更可读的 NPC 对话/行动反馈；
- 开发环境专用的当前存档清除 use case、repository 操作、`DELETE /api/game/dev/current` 与明确确认的 UI；
- 成功/失败两条手工试玩路线与自动回归；
- 同步更新 README、开发规范、索引和相关 agent 文档。

### 排除

- 原 Spec Phase 4 及以后的真实 AI、自由输入、AI 对话、记忆、图片、streaming；
- 任意游戏规则、数值、任务图、世界预算或存档格式的大范围重做；
- 多存档、生产环境删档、管理后台；
- `@ai-game/*`、foundation、SLG 或共享 UI 修改。

## 固定决定

1. 清档是**仅开发环境**能力：客户端仅在开发构建显示按钮；服务端仍以 `NODE_ENV === "development"` 为权威门禁。非开发环境不可调用，不能通过隐藏按钮或直接请求绕过。
2. 清档只删除当前槽位指向的那一局存档，并在同一 SQLite 事务先删除指针再删除对应记录；没有存档是幂等成功。它不删除数据库文件、schema、其它表或任意 sibling 仓库/路径。
3. 冒险记录只由已有的结构化 event ledger + 当前安全 read model 投影生成；浏览器不读取 blueprint、seed、内部 ID 或原始 state，也不自行裁决剧情。
4. 基础属性展示为玩家已知的初始 HP / 攻击 / 防御；战斗中的当前 HP 继续以现有 battle read model 为准。
5. 本阶段是 RPG 业务 UI，现有 `Panel` / `InlineButton` / `Tag` 已足够；不得为此扩展共享包。

## 任务

### Task 1：安全 read model 与模板叙事

- 扩展会话 read model，投影安全的 player stats 与有限条最近事件摘要；
- 新建 RPG `AdventureLogPanel`，将事件转为确定性中文叙事（包含地点、NPC、线索、物品、战斗与结局）；
- 在开场视图显示角色属性，在现有互动 UI 中呈现更清晰的反馈；
- 测试不泄漏 seed、内部 ID、未解锁内容或原始 state。

### Task 2：开发环境清档

- 给 persistence port / SQLite adapter / server composition root 增加最小的 clear-current 操作；
- 增加 thin API handler 与 dev-only route guard；
- `CurrentGameScreen` 在开发构建显示“清除本地试玩存档”控制项，需 `window.confirm`，成功后回到新建表单；
- 覆盖无档、正常档、事务失败、生产拒绝和客户端请求路径；不能让 API 或 UI 直接接触 SQLite。

### Task 3：试玩验收与文档

- 建立一份可由任何 agent/开发者执行的无 AI 手工验收文档，含成功路线、失败路线、刷新恢复和清档重开局；
- 增加真实临时 SQLite 的端到端回归，锁定两种结局与清档后的重新创建；
- 更新 README、`游戏开发规范.md`、阶段文档、索引和 MVP 核心闭环，使事实不再停留在 Phase 5/6 的“计划”状态。

## 验收

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
```

还须人工确认：`npm run dev` 下完成一条成功路线与一条失败路线；刷新后状态不丢失；确认清档后回到新开局表单；生产构建既不显示清档按钮，也拒绝其 API。

## 完成定义

- 没有 AI 或外部网络时，可从开局资料走到任意正式结局；
- NPC、地点、线索、物品、任务、属性、战斗和结局都有玩家可见的连续反馈；
- 清档准确、可确认、仅限开发环境，且不会影响数据库 schema 或其它项目；
- 新 agent 可从当前阶段入口和本 Plan 直接实现及验收。
