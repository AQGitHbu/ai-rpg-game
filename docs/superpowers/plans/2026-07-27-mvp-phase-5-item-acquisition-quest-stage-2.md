# MVP Phase 5：确定性物品取得与主线第二阶段执行 Plan

> 日期：2026-07-27  
> 状态：已完成（2026-07-27）
> 目标分支：`codex/mvp-phase-5-item-acquisition-quest-stage-2`  
> 唯一修改仓库：`ai-rpg-game`  
> 上游基线：Phase 4 已合入 `main`（`60d3d90`）  
> 上游 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`

## 定位与目标

原始高层 Spec 将无 AI 的可玩闭环集中在一个宽泛的 Phase 3。实际交付已先拆出固定行动（Phase 3）和探索/任务基础（Phase 4）。本阶段继续该确定性链路：把蓝图中预先定义的关键物品放在指定地点，玩家通过固定 `take_item` 行动取得它，任务 reconciliation 以背包事实完成主线第二阶段并解锁第三阶段。

这不是通用背包或奖励系统，也不是提前抽取共享 UI。它只补全现有三阶段主线中已经定义、但尚未被规则支持的 `obtain_item` objective；战斗/`defeat_enemy` 和两个结局留给后续阶段。因此仍能在无 AI 条件下逐段验证规则、存档与 UI 的同一条真实链路。

```text
当前地点的预置可取得物品
→ POST /api/game/actions { type: "take_item", itemId, revision }
→ performAction → pure action resolver → reconcileQuests
→ 单次 SQLite revision CAS
→ GameSessionView（背包 / 当前地点可取得物品 / active quests）
```

## 开始条件

1. 本 Plan、`current-phase.json` 与入口文档已提交到 `ai-rpg-game/main`，主工作区干净。
2. 从主工作区 `main` 执行 `npm run phase:start`；仅在 `.worktrees/mvp-phase-5-item-acquisition-quest-stage-2` 实现。
3. 开始前阅读根 `AGENTS.md`、`docs/游戏设计原则.md`、`docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/MVP核心闭环.md`、`docs/agent/行动裁决.md`、`docs/agent/探索与任务推进.md`、`docs/agent/物品与任务奖励.md`、玩家规则、开发 Spec 与本 Plan。
4. 只修改 `ai-rpg-game`。现有 `@ai-game/ui` 的 `Panel`、`InlineButton`、`Tag` 足够；不得读取/修改 foundation 或 SLG，也不触发共享模块流程。

## 明确边界

### 包含

- 蓝图中可验证的“地点 → 可取得物品”定义、候选校验和 fallback 配置；
- 固定 `take_item { itemId }` 意图、稳定拒绝码、`item_obtained` 领域事件及不可变状态更新；
- 当前地点可取得物品与背包摘要的 application read model、API 严格解析和 RPG 业务 UI；
- `obtain_item` objective 读取背包事实；第二阶段完成与第三阶段解锁，复用现有固定点 reconciliation；
- 真实 SQLite 单事务保存、reload、边界守卫和三类型固定 seed 回归。

### 排除

- `use_item`、给予、交易、装备栏、消耗品效果、数值奖励、掉落、随机奖励或物品堆叠；
- 攻击、战斗、`defeat_enemy`、失败分支、结局判定、隐藏地点发现；
- 自由文本、AI 意图识别/NPC 对话/叙事/memory/transport、图片调用；
- 新共享 UI/package、foundation/SLG 改动、由 UI/API 直接写入 `GameState`。

## 固定规则决定

1. 蓝图需显式指明每个地点可取得的 item ID（例如在 `LocationDefinition` 使用 `availableItemIds`）；引用必须存在，单个 item 至多出现在一个地点，且不得与 `player.startingItemIds` 重复。必须同步 candidate validator、compile、fixture/helper 与 fallback，不能在 application 层维护平行表。
2. `take_item` 仅当 item 存在、玩家位于其配置地点、且 `player.itemIds` 尚未包含它时成功。拒绝码至少区分 `UNKNOWN_ITEM`、`ITEM_NOT_AVAILABLE_HERE`、`ITEM_ALREADY_OWNED`；拒绝、陈旧 revision 或 resolver/reconciliation 异常必须零写入。
3. 成功取得追加 `item_obtained { itemId, locationId, occurredAt }`，只把该 item ID 加入 `GameState.player.itemIds`；不改变数值、装备、关系或地点。可取得性由“蓝图地点定义 + 是否已拥有”推导，故不新增可变地面掉落状态。
4. `isQuestObjectiveSatisfied` 对 `obtain_item` 检查背包 ID；`defeat_enemy` 继续不支持。只有第二阶段的 `talk_to_npc` 与 `obtain_item` 都满足才完成，完成事件和第三阶段解锁事件与 `item_obtained` 一同由既有一次 CAS 写入。
5. `GameSessionView` 只公开当前地点的可取得物品摘要、玩家已拥有物品摘要、`take_item` 可用行动与 active quest 状态；不泄漏其他地点、锁定任务、完整蓝图、seed 或输入 digest。当前 UI 只增加 RPG 业务组合，不在 shared UI 创建“背包组件”。

## 任务拆分

### Task 1：蓝图契约、校验与确定性 fallback

扩展候选/已编译地点定义、验证与编译，让地点可引用预定义 item。更新 fixture builders、阶段 1 fixture（如受结构变化影响）和 fallback；关键 `item_key` 放在第二阶段可达地点，初始物品不列为可取得物品。保持 templateVersion/digest/固定 seed 契约：若 fallback 结构变化导致 fixture 漂移，按既有规范有意识地升级版本和更新 pin，而不是隐式接受漂移。

测试：悬空 item 引用、同一 item 多地点、初始物品重复配置均被候选校验收集为诊断；compile 后均为品牌化 ID；三类型仍满足内容预算、任务图与结局可达性。

### Task 2：`take_item` 规则、事件与任务 reconciliation

扩展 actions facade 的 intent union、严格 validation、resolver、事件 union、状态更新和可用行动投影。只允许从当前地点取得蓝图预置物品。将 quests facade 的 `obtain_item` 由未支持改为读取 `state.player.itemIds`；不改动 `defeat_enemy` / `reach_ending` 的现有边界。

测试：成功取得、未知/异地/非可取得/已拥有 item、不可变更新、事件时间由注入时钟提供；talk 与 obtain 的任意顺序都不会在条件未齐时完成 stage 2，条件齐时只完成/解锁一次；重复 reconciliation 幂等；所有 Phase 3/4 行动回归。

### Task 3：application、SQLite 与 read model

保持 `performAction` 的顺序为 resolveAction → reconcileQuests → `applyResolvedAction`。为 `GameSessionView` 增加当前地点可取得物品、背包摘要和 take action，不让 UI/API 触达 blueprint 或 gameplay。API 严格白名单解析 `{ intent, revision }`，拒绝 freeText、任意 state、未知字段和伪造地点。

测试：成功取 key 后 `item_obtained`、`quest_completed`、`quest_unlocked` 与 revision 只通过一次持久化出现；刷新恢复的 read model 完全一致；并发同 revision 至多一个成功；拒绝与故障注入不改变 state/revision/event ledger；旧存档兼容策略明确并测试（若不需 schema 变化，不能无故升 schema）。

### Task 4：RPG 物品 UI 与可访问反馈

在当前场景组合中增加“可取得物品”和“背包”业务区域。按钮经现有 request adapter 发送 `take_item` 与当前 revision；加载期间禁用全部行动，成功后使用服务端 read model 替换页面状态，拒绝/冲突经 aria-live 呈现，冲突重新读取。物品名称/描述只能来自 read model；没有物品时显示中性空态，绝不显示未来 use/give/trade 按钮。

组件/API 测试至少覆盖：payload/revision、成功后物品从地点消失且出现在背包、重复点击/拒绝、刷新恢复、键盘可操作与加载禁用；确保 UI/API 没有 deep import gameplay/SQLite。

### Task 5：回归、边界与文档

- 更新 `dependencyBoundaries.test.ts`，使新增 actions/quest/read-model 路径仍只能经 application facade 被 UI/API/store 使用。
- 新增或扩展三类型固定 seed 的真实临时 SQLite 回归：创建 → Phase 4 的移动/第一阶段 → 前往 key 所在地点、与目标 NPC 交谈、取得 key → stage 2 completed / stage 3 active → reload；断言内容预算不变、物品仅一次、状态/视图一致。
- 更新 `物品与任务奖励.md`、`行动裁决.md`、`探索与任务推进.md`、`MVP核心闭环.md`、当前阶段、索引及必要玩家规则事实。
- 完成时将机器状态更新为 `completed / implemented`，但不自动切换下一阶段。

## 建议目录

```text
src/game/domain/scenarioBlueprint.ts
src/game/domain/events.ts
src/game/gameplay/rpg/scenario/
src/game/gameplay/rpg/actions/
src/game/gameplay/rpg/quests/
src/game/application/gameSessionView.ts
src/game/application/performAction.ts
src/app/api/game/actions/
src/components/CurrentGameScreen.tsx
src/components/SceneActionPanel.tsx
src/components/<RPG item panel>.tsx
```

## 验收命令

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
```

还必须证明：真实临时 SQLite 中 `take_item` + stage 2 任务事件一次保存；同 revision 并发只落一个完整结果；武侠、科幻、都市固定 seed 都能完成 stage 2 并刷新恢复；重复/异地/未知 item 零写入；`git diff --check` 通过且无 db/tmp/log/.env.local 入库。`handoff:check` 只在阶段启动前使用。

## 完成定义

- 玩家只能在正确地点一次取得蓝图预定义物品，无法由 UI、请求或文本伪造背包内容；
- `obtain_item` objective 被实际背包事实推进，第二阶段主线完成且第三阶段解锁；
- 物品事件、任务事件和 revision 原子保存并可刷新恢复；
- 无物品使用、数值奖励、战斗、结局、AI 或共享范围混入；
- 新 agent 仅凭入口文档和本 Plan 即可启动、实现和验收 Phase 5。
