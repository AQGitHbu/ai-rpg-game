# MVP Phase 6：确定性轻量战斗与双结局执行 Plan

> 日期：2026-07-28  
> 状态：已规划，尚未开始  
> 目标分支：`codex/mvp-phase-6-deterministic-battle-endings`  
> 唯一修改仓库：`ai-rpg-game`  
> 上游基线：Phase 5 已合入 `main`（`8ae05d5`）  
> 上游 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`

## 定位与目标

原始高层 Spec 把无 AI 可玩闭环概括为一个宽泛的 Phase 3；实际实现已依次拆出固定行动、探索/任务和物品取得。Phase 6 补齐其最后一段：第三阶段 boss 战、`defeat_enemy` 任务目标、成功/失败 outcome 和两个可恢复结局。完成后，玩家可在没有 AI 的情况下从创建世界走到任一正式结局。

本阶段只做一场确定性的轻量 boss 战。它验证规则裁决、失败后果、任务图和存档，而不是建立可扩张的 RPG 战斗系统或提前接入 AI。

```text
stage 3 active + 到达 boss 地点
→ POST /api/game/actions { start_battle, enemyId, revision }
→ active battle: battle_action { attack | guard | withdraw }
→ pure battle resolver → quest success/failure resolver → ending resolver
→ 单次 SQLite revision CAS
→ GameSessionView（battle 或 ending 状态）
```

## 开始条件

1. 本 Plan、`current-phase.json` 和入口文档已提交到 `ai-rpg-game/main`，主工作区干净。
2. 从主工作区 `main` 执行 `npm run phase:start`；只在 `.worktrees/mvp-phase-6-deterministic-battle-endings` 修改。
3. 开始前阅读根 `AGENTS.md`、`docs/游戏设计原则.md`、`docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/MVP核心闭环.md`、`docs/agent/行动裁决.md`、`docs/agent/探索与任务推进.md`、`docs/agent/物品与任务奖励.md`、`docs/agent/战斗与结局.md`、玩家规则、开发 Spec 与本 Plan。
4. 只修改 `ai-rpg-game`。不用新 shared UI/package，不读/改 foundation 或 SLG；现有 `Panel`、`InlineButton`、`Tag` 足够。

## 明确边界

### 包含

- 敌人预置地点、boss 可达性与 fallback 兼容更新；
- `GameState` 的最小 battle / defeated-enemy / ending runtime state、领域事件与安全存档兼容；
- `start_battle`、`battle_action`（`attack` / `guard` / `withdraw`）的纯规则、稳定拒绝码和确定性伤害；
- `defeat_enemy` objective、stage 3 success/failure、`onSuccess` / `onFailure` outcome 与两个 ending 的纯结算；
- application facade、严格 API、RPG Battle/Ending UI、一次 CAS、真实 SQLite 回归和边界测试。

### 排除

- 普通敌人遭遇、随机数/命中、技能、状态、暴击、掉落、经验、治疗、装备或物品效果、连续战斗、重试；
- 自由输入、AI 意图/对白/叙事/memory/transport、图片或 streaming；
- 新 NPC/地点/物品、隐藏地点解锁、关系系统、存档列表、shared package/foundation/SLG 改动；
- UI/API 直接修改生命、任务、敌人、结局或 SQLite。

## 固定规则决定

1. 为 `EnemyTemplate` 增加稳定的 `locationId`。validator 要求地点存在；fallback 把第三阶段 boss 放在 `loc_4`（stage 2 后由现有连通图可达），普通敌人可有落位但绝不自动暴露为 battle 行动。candidate/compile/fixture/digest/templateVersion 的变更必须成套处理。
2. `GameState` 新增最小 `battle`（`idle | active | resolved`，active 含 enemyId、playerHp、enemyHp、round）和 `defeatedEnemyIds`；新增 `ending: null | { endingId, outcome: "success" | "failure" }`。不得把可变战斗生命塞回 blueprint 的 `StatBlock`，也不得以 eventLedger 文本反推状态。
3. `start_battle { enemyId }` 仅在未结局、无 active battle、玩家位于敌人地点、该 enemy 是 active stage 3 的 `defeat_enemy` target 时合法。`battle_action` 仅在 active battle 内接受 `attack`、`guard`、`withdraw`；所有其它行动在 active battle 或 ending 后返回稳定拒绝码且零写入。
4. 回合完全确定：`attack` 先造成 `max(1, player.attack - enemy.defense)`，敌人未倒下才反击 `max(1, enemy.attack - player.defense)`；`guard` 不造成敌伤，反击伤害固定减 2、最低 1；`withdraw` 立即以失败结束 battle。胜利不触发反击；生命归零同样失败。fallback boss 数值必须调整为在玩家初始数值下存在有限 attack 胜利序列（建议 boss `hp: 20, attack: 5, defense: 2`），并以固定 seed 回归锁定。
5. 战斗成功追加 `enemy_defeated` 并把 enemy ID 写入 `defeatedEnemyIds`；quests facade 将 `defeat_enemy` 读取该事实，再走既有 success reconciliation。失败由明确的 `failQuest` 纯入口把 stage 3 置为 `failed` 并仅应用 `onFailure`，不能把失败当 completed。
6. 结局 resolver 只在已完成的 `reach_ending` outcome 后落 `ending_reached` 与 ending runtime state。扩展 ending requirement 契约以表达 `quest_failed`，使 fallback 成功 ending 依赖 stage 3 completed、失败 ending 依赖 stage 3 failed；结局状态只能写入一次，之后所有 action 安全拒绝。
7. `GameSessionView` 在未结局时可公开当前 battle 摘要及允许 battle action；在结局时只公开允许的 ending 名称、描述、outcome 与终局状态，不能泄漏完整蓝图、seed、隐藏内容或内部 ID。UI 只消费该 read model。

## 任务拆分

### Task 1：蓝图、运行时状态、事件与迁移契约

扩展 enemy 地点、battle/ending runtime state、`defeatedEnemyIds`、ending requirement 与事件 union（至少 `battle_started`、`battle_round_resolved`、`battle_resolved`、`enemy_defeated`、`quest_failed`、`ending_reached`）。校验所有引用、结局 requirement 和 boss 可达性；更新 compile、initialize、fallback、fixture helper 与三类 pinned fixture。为旧 Phase 1–5 存档制定并测试读取默认值迁移，不能无提示丢失状态。

测试：悬空敌人地点/ending requirement、错误的 battle/ending runtime state、重复 ID、不可达 boss 或两条结局失效均被拒；固定 seed 保持确定，三类型 stage 3 boss 可到达并有有限胜利序列。

### Task 2：纯 battle 与任务 outcome 规则

创建 `src/game/gameplay/rpg/battle/` facade；它只依赖 domain，接收 compiled blueprint、state、intent 与 injected clock，输出不可变 state、事件和安全反馈。扩展 actions facade 的 intent/validation，或由 application 先路由到 battle facade，但不得让 UI/API 直接选择规则结果。为 quests facade 增加显式失败入口，严格限制其只能处理当前 active quest 的确定性失败。

测试：所有合法前置、非法 stage/location/enemy/battle 状态、attack/guard 数值顺序、胜利不反击、生命归零、withdraw、重复结算、一次性 defeatedEnemyId、胜利完成 stage 3、失败只标 failed 且只走 `onFailure`。所有 Phase 3–5 intent 及 immutable/zero-write 规则回归。

### Task 3：application、持久化与 ending read model

将 `performAction` 统一编排普通 actions、battle、quest success/failure 与 ending resolver，最终只调用一次 `applyResolvedAction` compare-and-swap。扩展 read model：普通场景、active battle、ending 三种明确状态；结局后不投影普通可行动按钮。API 对两个新 intent 使用按 type 严格字段白名单，拒绝客户端 hp、damage、round、quest status、ending、state/freeText/未知字段。

测试：成功战斗/失败撤退各只写一次完整 state + event ledger + revision；并发 revision 只有一方成功；repository 故障、规则拒绝和 stale revision 零写入；reload 后 battle（若中途保存）及 ending read model 一致；客户端 bundle 不含 server persistence。

### Task 4：RPG Battle 与 Ending UI

在 `CurrentGameScreen` 组合 BattlePanel 与 EndingPanel。战斗中只显示服务器 read model 给出的血量摘要、回合信息与 attack/guard/withdraw；请求期间禁用全部行为并用 aria-live 报告规则反馈。结局页面显示 outcome、名称和描述，普通互动区不再可操作；不得用前端逻辑自行减少 HP 或判断胜负。

组件/API 测试至少覆盖：start payload/revision、各 battle action、loading 禁用、规则拒绝、stale reload、中途 reload、胜利/失败 ending 与结局后无可用 action；确保没有 gameplay/SQLite deep import。

### Task 5：完整无 AI 双结局回归、边界与文档

- 三种固定 seed 在真实临时 SQLite 各跑两条旅程：创建 → stage 1 → stage 2 → stage 3 → boss 胜利 → 成功 ending，以及同路径 → withdraw（或受控生命归零）→ failed stage 3 → 失败 ending；验证刷新一致、预算不变和没有重复事件。
- 保持 Phase 4/5 回归，并新增 dependency boundaries，battle 只能通过 facade 被 application 消费，UI/API/store 仍只依赖 `@/game/application`。
- 更新 `战斗与结局.md`、`行动裁决.md`、`探索与任务推进.md`、`MVP核心闭环.md`、当前阶段、索引、开发规范和必要玩家规则事实。
- 完成时状态更新为 `completed / implemented`，但不自动切换下一阶段。

## 建议目录

```text
src/game/domain/gameState.ts
src/game/domain/events.ts
src/game/domain/scenarioBlueprint.ts
src/game/gameplay/rpg/scenario/
src/game/gameplay/rpg/actions/
src/game/gameplay/rpg/battle/
src/game/gameplay/rpg/quests/
src/game/application/performAction.ts
src/game/application/gameSessionView.ts
src/app/api/game/actions/
src/components/BattlePanel.tsx
src/components/EndingPanel.tsx
```

## 验收命令

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
```

另须证明：真实 SQLite 的成功、失败两条结局各只写一次；battle 中途和 ending 刷新恢复；同 revision 并发只落一个完整结果；武侠、科幻、都市三类型均可按有限序列到达成功与失败 ending；结局后 action、非法 enemy/地点/动作与客户端伪造 hp/ending 全部零写入；`git diff --check` 通过且没有 db/tmp/log/.env.local 入库。

## 完成定义

- 玩家无需 AI 即可从新建游戏走到第三阶段 boss 的成功或失败结局；
- 伤害、回合、胜负、任务状态与结局全部由纯规则和结构化状态裁决；
- 失败保留存档并产生可见后果，不能伪装为成功或死局；
- 所有状态变化原子保存并可刷新恢复；
- 没有 AI、自由输入、物品效果、普通战斗系统或共享范围混入；
- 新 agent 可仅凭入口文档与本 Plan 启动、实现并验收 Phase 6。
