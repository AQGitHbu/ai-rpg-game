# MVP Phase 4：确定性探索与任务推进执行 Plan

> 日期：2026-07-27
> 状态：已完成（2026-07-27）
> 目标分支：`codex/mvp-phase-4-exploration-quest-progression`
> 唯一修改仓库：`ai-rpg-game`
> 上游基线：Phase 3 已合入 `main`（`4943ef6`）
> 上游 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`

## 定位与目标

原始高层 Spec 将无 AI 的可玩闭环归入一个宽泛的 Phase 3；实际实现已先完成其中的开场行动与安全续存档。本 Phase 4 继续完成该确定性基础：移动到已解锁且连通的地点，自动以规则核验已发生的 visit / talk / discover objective，并持久化任务完成与后续任务解锁。

这是实现顺序的拆分，不改变产品范围；共享 AI transport 与动态开局仍在确定性主线可验证后再规划。

```text
当前场景 read model（地点 / NPC / 可移动目标 / active quests）
→ POST /api/game/actions { move | Phase 3 intent, revision }
→ performAction → pure action resolver → reconcile quests
→ SQLite compare-and-swap
→ 最新 GameSessionView + 规则反馈
```

## 开始条件

1. 本 Plan、`current-phase.json` 和入口文档必须提交到 `ai-rpg-game/main`，主工作区干净。
2. 从主工作区 `main` 执行 `npm run phase:start`；只在 `.worktrees/mvp-phase-4-exploration-quest-progression` 开发。
3. 开始前阅读根 `AGENTS.md`、`docs/游戏设计原则.md`、`docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/MVP核心闭环.md`、`docs/agent/行动裁决.md`、`docs/agent/探索与任务推进.md`、玩家规则和本 Plan。
4. 只修改 `ai-rpg-game`；不修改 foundation、SLG 或 `@ai-game/*` package。现有 `Panel`、`InlineButton`、`Tag` 足够，不读取共享模块流程。

## 明确边界

### 包含

- `PlayerIntent` 新增 `move { locationId }`，连通/解锁/当前地点校验和确定性移动事件；
- 当前地点的 NPC、可移动目的地和可行动列表投影，不再把 opening scene 的 NPC 误用于其他地点；
- 纯任务 reconciliation：`visit_location`、`talk_to_npc`、`discover_fact` objective 的进度与完成；
- `onSuccess.unlock_quests` 的状态解锁及事件，任务 read model/UI；
- 在现有 revision compare-and-swap 内持久化移动、行动与任务状态；
- application/API/UI/边界与固定 seed 回归测试。

### 排除

- `obtain_item`、`defeat_enemy`、道具获取/使用、奖励、关系数值、失败分支、结局判定、战斗；
- 自由输入、AI 意图识别、NPC 对话、叙事、memory、AI transport 或任何模型网络调用；
- 隐藏地点的动态发现、生成新内容、存档列表、共享 UI/foundation/SLG 改动；
- 以临时脚本直接修改 SQLite 或由 UI/API 自行写 `GameState`。

## 固定规则决定

- `move` 只允许从 `currentLocationId` 到蓝图 `connectedLocationIds` 中、同时存在于 `unlockedLocationIds` 的非当前地点。未知、未连通、未解锁和重复移动均返回稳定拒绝码且零写入。
- 移动成功追加 `location_visited`；原 Phase 3 的 talk/investigate/observe 仍追加既有事件。所有成功 action 后在同一纯 resolver 内执行任务 reconciliation。
- objective 是状态事实的读取条件：visit 读取移动/初始地点事实，talk 读取 `NpcRuntimeState.met`，discover 读取 `WorldFactState.discovered`。只有 active quest 的全部已支持 objective 满足时才变为 completed。
- completed quest 依次应用 `onSuccess`：只实现 `unlock_quests`，将仍为 locked 的目标置为 active 并追加 `quest_completed` / `quest_unlocked` 事件；`closed` 可标 closed；`reach_ending` 保留为未支持路径，绝不能伪造结局。
- 含 `obtain_item` 或 `defeat_enemy` 的 active quest 保持 active，并在 read model 中准确显示“后续阶段能力”；不得绕过条件完成。
- 读模型从 `OpeningGameView` 演进为语义中性的 `GameSessionView`（可保留兼容 type alias 直到所有消费者迁移）：当前地点的 description/NPC/actions、已发现事实、active quest 摘要和 revision。它不泄漏锁定 quest、隐藏地点、完整蓝图、seed 或 inputDigest。

## 任务拆分

### Task 1：领域事件、move 校验与当前场景投影

扩展 action union、validation、resolver 和 action facade；从 `blueprint.npcs` + `NpcRuntimeState.locationId` 投影当前地点 NPC，从连通且解锁的地点投影 move actions。新增移动事件与稳定拒绝码，保持 Phase 3 的不可变更新和 injected clock。

测试：有效移动、未知/当前/未连通/未解锁目标、移动后可见 NPC 与可用 talk action 正确切换、旧 opening NPC 不泄漏到新地点、所有 Phase 3 action 回归。

### Task 2：纯任务 reconciliation

新建 `src/game/gameplay/rpg/quests/` facade 和纯函数，输入 compiled blueprint + next GameState，输出包含 quest 状态与新增任务事件的下一 state。它不 import application、repository、UI 或 AI。

覆盖：初始 stage 1 active；移动满足 visit 后完成 stage 1 并解锁 stage 2/允许的 side quest；重复 action 不重复解锁；talk/discover objective 完成；多 objective 未齐不完成；unsupported objective 保持 active；不可达/非法蓝图继续被 Phase 1 图校验拒绝。

### Task 3：应用与持久化整合

`performAction` 唯一调用 actions + quests facade，并把最终 next state 交给既有 `applyResolvedAction`。继续使用同一 revision CAS，不引入旁路 SQL 或第二次写入。若 reconciliation / 投影异常，映射稳定基础设施失败且没有 state/revision/事件变化。

扩展 repository/application 集成测试：移动与 quest event 同次写入、竞争 revision 仅一方成功、失败/拒绝零写入、刷新后任务与地点保持一致。除非确有持久化 schema 变化，不提高 SQLite schema version。

### Task 4：API 与场景/任务 UI

扩展 actions handler 严格解析 `move`，拒绝 freeText、任意 state、quest status、seed 和未知字段。`CurrentGameScreen` 使用 `GameSessionView`；增加地点移动与 active quest 面板，所有按钮 loading 时禁用，结果通过 aria-live 反馈。完成/解锁只展示允许信息，未支持 objective 说明后续能力，不给出假按钮。

组件/API 测试至少覆盖：移动请求的 revision 与 payload、成功后新地点/NPC/任务更新、拒绝、陈旧 revision reload、刷新恢复、UI 不 import gameplay/SQLite，且无 AI 网络请求。

### Task 5：边界、回归与文档

- 更新 actions/quests/application/public facade 和 `dependencyBoundaries.test.ts`，同时阻止 UI/API 直连游戏规则、server persistence 或 SQLite。
- 为武侠、科幻、都市固定 seed 建立自动探索回归：创建 → 移动 → stage 1 完成 → stage 2 解锁 → reload；验证类型内容与预算不变。
- 更新 `探索与任务推进.md`、`行动裁决.md`、当前阶段、MVP 核心闭环、索引和必要的玩家规则事实。
- 完成时更新为 `completed / implemented`，但不自动切到 Phase 5。

## 建议目录

```text
src/game/gameplay/rpg/actions/
src/game/gameplay/rpg/quests/
src/game/application/performAction.ts
src/game/application/gameSessionView.ts
src/app/api/game/actions/
src/components/SceneActionPanel.tsx
src/components/QuestTracker.tsx
src/components/TravelPanel.tsx
```

## 验收命令

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
```

另须证明：真实临时 SQLite 中移动 + task progression 原子保存；同 revision 并发只落一个完整结果；三种固定 seed 的 stage 1 可达并能刷新恢复；`git diff --check` 通过且无 db/tmp/log/.env.local 入库。`handoff:check` 只在阶段启动前使用。

## 完成定义

- 玩家可从开场移动到合法相邻地点，场景 NPC 与固定行动随地点变化；
- 已发生的移动、交谈、调查能由规则推进受支持的主线/支线 objective，不能跳过未支持条件；
- 任务完成、解锁、地点与 revision 在同一存档事务内恢复；
- 没有 AI、自由文本、物品、战斗、结局或共享范围混入；
- 新 agent 可据入口文档和本 Plan 启动、实现、验证 Phase 4。
