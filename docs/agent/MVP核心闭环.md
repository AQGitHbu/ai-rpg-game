# MVP 核心闭环

## 系统定位

玩家从预设游戏类型、角色资料、世界观背景和故事开端创建一局新游戏；系统生成受约束的世界蓝图，并通过“输入意图 → 规则裁决 → AI 表现 → 结构化记忆”持续推进到可完成结局。

## 当前规则摘要

- 游戏类型不是自由文本；它限制世界观范围并绑定 AI 绘图风格。
- 具体剧情、地点、NPC、任务内容和对白按局动态生成。
- 开局必须一次生成可验证的主线骨架和结局可达性，后续 AI 不能无限扩张世界。
- AI 只产生蓝图、意图和叙事候选；规则系统独占状态写入与数值结算。
- AI、图片或语音失败时使用模板降级，不能阻断通关。

## 当前实现现状

工程脚手架和文档基线已建立。Phase 0 已实现 UI-only 的新游戏资料表单，真实消费 `@ai-game/ui`。Phase 1 已实现领域基线：`NewGameInput` 校验、7 类型/艺术风格 profile、蓝图与运行时类型、任务图可达性、候选蓝图 validate/compile、`GameState` 初始化和确定性 fallback 生成（同输入 + seed + templateVersion 结果相同，武侠/科幻/都市 fixture 钉值）。Phase 2 已实现创建与本地存档闭环：表单提交经 POST /api/game 进入 `createGame` use case（domain 校验 → fallback 生成 → validate/compile → SQLite 原子保存，失败无半存档），返回只含允许信息的开场 read model；刷新经 GET /api/game/current 恢复同一存档；UI/API 只消费 `@/game/application` 门面，libsql 与数据库路径只存在于 server-only 层。Phase 3 已实现 observe / talk / investigate 固定行动：纯 resolver 生成下一状态和事件，经 SQLite revision compare-and-swap 原子续存档，再由 API/UI 展示规则反馈和刷新后的 read model。Phase 4 已实现确定性移动与任务推进：`move` 按连通与解锁裁决并追加 `location_visited`；纯任务 reconciliation（`src/game/gameplay/rpg/quests/`）推进 visit/talk/discover objective（`quest_completed` / `quest_unlocked`，`onSuccess: closed` 终态为 `closed`；objective `obtain_item` / `defeat_enemy` 未支持，任务保持 active；`onSuccess: reach_ending` 任务可完成为 `completed`，结局判定未实现、不伪造结局事件）；`GameSessionView` 提供当前地点、在场 NPC、含 move 的可用行动与 active 任务清单。Phase 5 已实现确定性物品取得与主线第二阶段：蓝图 `LocationDefinition.availableItemIds` 预置可取得物品（fallback 把 key 物品放在 `loc_3`）；`take_item` 按当前地点与背包裁决（`UNKNOWN_ITEM` / `ITEM_NOT_AVAILABLE_HERE` / `ITEM_ALREADY_OWNED`），成功追加 `item_obtained` 并写入 `GameState.inventory`；`obtain_item` objective 以背包事实判定，stage 2 完成并解锁 stage 3（`defeat_enemy` 仍未支持）；视图新增 `obtainableItems` / `inventoryItems` 与 take 行动，UI 新增 `ItemPanel.tsx`。自由输入、AI、物品使用、战斗与结局仍未实现。

## 核心数据流

`NewGameInput → GameTypeProfile → ScenarioBlueprint 候选 → validate/compile → GameState → PlayerIntent → RuleResolution → NarrativeOutput → WorldEvent/Memory`

## 主要文件

- 玩家规则：`docs/策划文档/AI生成RPG_MVP.md`
- 开发 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`
- 领域层：`src/game/domain/`（`newGame.ts`、`scenarioBlueprint.ts`、`gameState.ts`、`events.ts`，facade `index.ts`）
- 玩法层：`src/game/gameplay/rpg/scenario/`（蓝图/profile/compile/fallback）、`src/game/gameplay/rpg/actions/`（intent、校验、resolver、可用行动/当前场景投影）和 `src/game/gameplay/rpg/quests/`（纯任务 reconciliation），各自 facade
- 数据：`data/base/gameTypeProfiles.json`、`data/base/artStyleProfiles.json`、`data/fixtures/phase1/*.json`
- 应用层：`src/game/application/`（`createGame.ts`、`getCurrentGame.ts`、`performAction.ts`、`gameSessionView.ts`（含 `OpeningGameView` 兼容别名），facade `index.ts`——UI/API 唯一游戏业务入口）
- server-only 持久化：`src/game/application/server/`（`compositionRoot.ts` 生产装配点；`persistence/gameRepository.ts` 纯端口、`persistence/sqliteClient.ts` 全库唯一 libsql/`GAME_DB_PATH` 感知文件、`persistence/sqliteGameRepository.ts` 事务化 adapter）
- API：`src/app/api/game/route.ts` + `createGameHandler.ts`（POST 创建）、`src/app/api/game/current/route.ts` + `currentGameHandler.ts`（GET 恢复）、`src/app/api/game/actions/`（POST 固定行动）
- 当前 UI：`src/components/CurrentGameScreen.tsx`（协调器）、`NewGameSetupForm.tsx`（真实提交）、`OpeningGameView.tsx`（场景展示）、`SceneActionPanel.tsx`（固定行动）、`TravelPanel.tsx`（移动）、`QuestTracker.tsx`（任务追踪）、`ItemPanel.tsx`（可拾取物品与背包）
- 当前阶段：`docs/agent/当前开发阶段.md`
- Phase 3 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-3-deterministic-action-loop.md`
- Phase 4 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-4-exploration-quest-progression.md`
- Phase 5 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-5-item-acquisition-quest-stage-2.md`
- Phase 1 Plan：`docs/superpowers/plans/2026-07-26-mvp-phase-1-scenario-contracts.md`
- Phase 2 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-2-create-game-persistence.md`

## 主要测试

- `src/components/NewGameSetupForm.test.tsx`、`CurrentGameScreen.test.tsx`、`OpeningGameView.test.tsx`、`SceneActionPanel.test.tsx`、`TravelPanel.test.tsx`、`QuestTracker.test.tsx`、`ItemPanel.test.tsx`
- `src/components/sharedUiContract.test.tsx`
- 领域：`src/game/domain/*.test.ts`（输入校验、蓝图/GameState 类型契约）
- 玩法：`src/game/gameplay/rpg/scenario/*.test.ts`（profile loader、任务图、validate/compile、确定性 fallback + fixture 钉值）、`actions/*.test.ts`、`quests/*.test.ts`
- 应用与持久化：`src/game/application/*.test.ts`（use case + 真实 SQLite 集成）、`src/game/application/server/**/*.test.ts`（adapter 原子性/故障注入、组合根）、`src/app/api/**/*.test.ts`（状态码与不泄漏断言）
- 边界与回归：`src/dependencyBoundaries.test.ts`（含 server-only 静态守卫与 actions/quests/scenario facade deep-import 守卫）、`src/game/gameplay/rpg/scenario/phase1Regression.test.ts`（含越权输入不进结构化状态）、`src/game/application/phase4ExplorationRegression.test.ts`（三类型固定 seed 探索旅程 + reload + 内容预算不变）、`src/game/application/phase5ItemQuestRegression.test.ts`（三类型固定 seed 物品取得 + stage 2 完成/stage 3 解锁 + reload）

## 修改注意事项

- 不把示例“灰石村/黑暗幻想”写死为产品规则。
- 不让 UI/API/store deep-import gameplay。
- 通用 UI 或 AI transport 命中共享触发条件，先读取 `docs/共同规范/`。
- 新建 gameplay 文件前先完成 Spec 对应阶段的测试用例。
- Phase 2 起 UI/API 只调用 application facade；不得直连 domain、scenario 或 SQLite repository（已由 `dependencyBoundaries.test.ts` 别名 + 相对路径双拦截与 server-only 静态守卫强制）。

## 最近维护

- 2026-07-27：完成 Phase 5 确定性物品取得与主线第二阶段（availableItemIds 蓝图契约 + take_item 裁决与 item_obtained、obtain_item reconciliation、obtainableItems/inventoryItems read model + ItemPanel、三类型固定 seed 物品回归；无 AI、物品使用、战斗或结局）。
- 2026-07-27：完成 Phase 4 确定性探索与任务推进（move 裁决 + location_visited、纯任务 reconciliation（visit/talk/discover、unlock_quests/closed）、GameSessionView + TravelPanel/QuestTracker、三类型固定 seed 探索回归；无 AI、物品、战斗或结局）。
- 2026-07-27：完成 Phase 3 确定性行动与 revision 续存档（observe / talk / investigate、v1→v2 migration、compare-and-swap、API/UI/边界测试；无 AI、移动、任务或战斗）。
- 2026-07-27：完成 Phase 2 创建游戏与本地存档实现（application use case + server-only SQLite 持久化 + API thin adapter + 开场/恢复 UI + 边界与 server-only 静态守卫，22 文件 / 322 用例）。
- 2026-07-26：完成 Phase 1 领域契约与确定性生成实现（domain + gameplay/scenario + 边界与回归测试，12 文件 / 229 用例）。
- 2026-07-27：建立 Phase 2 创建游戏、本地事务存档与开场恢复执行 Plan；实现尚未开始。
- 2026-07-26：建立 Phase 1 领域契约与确定性生成执行 Plan、机器可读当前阶段和 Agent 交接检查。
- 2026-07-26：Phase 0 新游戏资料表单成为 `@ai-game/ui@0.1.0` 的真实 RPG 消费者；提交只做 UI 校验，不提前创建 GameState 或调用 AI。
- 2026-07-26：建立动态生成型 MVP 开发基线。
