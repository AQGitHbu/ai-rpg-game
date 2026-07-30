# MVP 核心闭环

## 系统定位

玩家从预设游戏类型、角色资料、世界观背景和故事开端创建一局新游戏；系统生成受约束的世界蓝图，并通过"输入意图 → 规则裁决 → 结构化记忆"持续推进到可完成结局。

## 当前规则摘要

- 游戏类型不是自由文本；它限制世界观范围并绑定 AI 绘图风格。
- 具体剧情、地点、NPC、任务内容和对白按局动态生成。
- 开局必须一次生成可验证的主线骨架和结局可达性，后续 AI 不能无限扩张世界。
- AI 只产生蓝图、意图和叙事候选；规则系统独占状态写入与数值结算。
- AI、图片或语音失败时使用模板降级，不能阻断通关。

## 当前实现现状

工程脚手架和文档基线已建立。Phase 0 已实现 UI-only 的新游戏资料表单，真实消费 `@ai-game/ui`。Phase 1 已实现领域基线：`NewGameInput` 校验、7 类型/艺术风格 profile、蓝图与运行时类型、任务图可达性、候选蓝图 validate/compile、`GameState` 初始化和确定性 fallback 生成（同输入 + seed + templateVersion 结果相同，武侠/科幻/都市 fixture 钉值）。Phase 2 已实现创建与本地存档闭环：表单提交经 POST /api/game 进入 `createGame` use case（domain 校验 → fallback 生成 → validate/compile → SQLite 原子保存，失败无半存档），返回只含允许信息的开场 read model；刷新经 GET /api/game/current 恢复同一存档；UI/API 只消费 `@/game/application` 门面，libsql 与数据库路径只存在于 server-only 层。Phase 3 已实现 observe / talk / investigate 固定行动：纯 resolver 生成下一状态和事件，经 SQLite revision compare-and-swap 原子续存档，再由 API/UI 展示规则反馈和刷新后的 read model。Phase 4 已实现确定性移动与任务推进：`move` 按连通与解锁裁决并追加 `location_visited`；纯任务 reconciliation（`src/game/gameplay/rpg/quests/`）推进 visit/talk/discover objective（`quest_completed` / `quest_unlocked`，`onSuccess: closed` 终态为 `closed`；objective `obtain_item` / `defeat_enemy` 未支持，任务保持 active；`onSuccess: reach_ending` 任务可完成为 `completed`，结局判定未实现、不伪造结局事件）；`GameSessionView` 提供当前地点、在场 NPC、含 move 的可用行动与 active 任务清单。Phase 5 已实现确定性物品取得与主线第二阶段：蓝图 `LocationDefinition.availableItemIds` 预置可取得物品（fallback 把 key 物品放在 `loc_3`）；`take_item` 按当前地点与背包裁决（`UNKNOWN_ITEM` / `ITEM_NOT_AVAILABLE_HERE` / `ITEM_ALREADY_OWNED`），成功追加 `item_obtained` 并写入 `GameState.inventory`；`obtain_item` objective 以背包事实判定，stage 2 完成并解锁 stage 3（`defeat_enemy` 仍未支持）；视图新增 `obtainableItems` / `inventoryItems` 与 take 行动，UI 新增 `ItemPanel.tsx`。Phase 6 已实现确定性轻量战斗与双结局：`GameState` 新增 `battle` / `defeatedEnemyIds` / `ending` runtime state；`start_battle` / `battle_action` intent 与稳定拒绝码；battle facade 提供确定性的 attack/guard/withdraw 伤害计算与回合结算；`failQuest` 显式失败入口支持失败分支；`resolveEnding` 结局解析器检查 `quest_completed` / `quest_failed` requirements 并写入 ending runtime state；`GameSessionView` 新增 `BattleView` 与 `EndingView`，UI 新增 `BattlePanel.tsx` 与 `EndingPanel.tsx`；三类型固定 seed SQLite 回归验证胜利与失败双结局路径、刷新一致性、内容预算不变、结局后行动安全拒绝。Phase 4A 已实现 AI 契约模拟：`createGame` 经纯 `ScenarioCandidateSource` port（契约 `phase4a-v1`）请求候选，最多 2 次尝试、每次允许一次机械确定性修复（修复后重新完整校验），全部失败稳定走确定性 fallback；候选不绕过 validate/compile；生产组合根注入 unavailable source（真实 AI 与 `@ai-game/ai-transport` 留给 Phase 4B）；server-only fixture source + `data/fixtures/phase4/` 仅供开发与契约回归；生成阶段事件仅供内部（contract test/结构化日志）；`POST /api/game` 返回安全 `generationSource`（generated/fallback 二元），UI 提供等待态与一次性 fallback 降级提示（不持久化）。Phase 4B 已实现真实 AI 动态开局：契约升级为 `phase4b-v1`；生产 composition root 经 `parseAiRuntimeConfig` 解析本项目 AI 环境键，有效时注入 live source（经共享 `@ai-game/ai-transport@0.1.0` 调用真实 OpenAI-compatible 服务），无效时注入 unavailable source（稳定 `AI_CONFIG_*` 诊断）；配置/服务/候选失败在最多两次尝试与每次一次机械确定性修复后安全回到确定性 fallback；live 候选同样不绕过 validate/compile；fixture 测试仍为主回归（离线确定性）；真实计费 smoke（`npm run smoke:ai:phase4b`，opt-in）已于本机执行，三例均满足 generated|fallback 契约。Phase 4C 已实现结构化输出可靠性与离线回归：live source 可按 `AI_OUTPUT_FORMAT`（json_schema | json_object | prompt_only，缺省 prompt_only，无效值稳定降级 unavailable → fallback）附带 OpenAI-compatible `response_format` extraBody；候选校验/修复/fallback 契约不变（契约仍 `phase4b-v1`）；`data/fixtures/phase4c/` 版本化离线 fixture 集与三类型完整旅程回归使日常验收零网络零计费；smoke 增加脱敏安全汇总行。Phase 10 已实现运行时 AI 导演、编剧和 NPC 三请求最小权限链路：规则结算先持久化 pending，后台生成经 CAS 写回；两个 opaque choiceToken 只映射当前合法行动；角色失败有界重试后整场确定性 fallback；fixture record/replay 完整旅程保持零网络。2026-07-31 离线可靠性门禁通过。自由输入、物品使用和运行时实体扩容仍未实现。

## 核心数据流

`NewGameInput → GameTypeProfile → ScenarioBlueprint 候选 → validate/compile → GameState → PlayerIntent → RuleResolution → NarrativeOutput → WorldEvent/Memory`

## 主要文件

- 玩家规则：`docs/策划文档/AI生成RPG_MVP.md`
- 开发 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`
- 领域层：`src/game/domain/`（`newGame.ts`、`scenarioBlueprint.ts`、`gameState.ts`、`events.ts`，facade `index.ts`）
- 玩法层：`src/game/gameplay/rpg/scenario/`（蓝图/profile/compile/fallback）、`src/game/gameplay/rpg/actions/`（intent、校验、resolver、可用行动/当前场景投影）、`src/game/gameplay/rpg/battle/`（战斗 start/action）和 `src/game/gameplay/rpg/quests/`（纯任务 reconciliation + 失败入口 + 结局解析），各自 facade
- 数据：`data/base/gameTypeProfiles.json`、`data/base/artStyleProfiles.json`、`data/fixtures/phase1/*.json`
- 应用层：`src/game/application/`（`createGame.ts`、`getCurrentGame.ts`、`performAction.ts`、`gameSessionView.ts`（含 `OpeningGameView` 兼容别名）、`scenarioGeneration.ts`（Phase 4A 纯 port：`ScenarioCandidateSource`、稳定失败类别、仅供内部的生成阶段事件），facade `index.ts`——UI/API 唯一游戏业务入口）
- server-only 持久化与 AI：`src/game/application/server/`（`compositionRoot.ts` 生产装配点，本项目 AI 配置有效时注入 live scenario source、无效时注入 unavailable source；`persistence/gameRepository.ts` 纯端口、`persistence/sqliteClient.ts` 全库唯一 libsql/`GAME_DB_PATH` 感知文件、`persistence/sqliteGameRepository.ts` 事务化 adapter；`ai/aiRuntimeConfig.ts` 环境键解析（`AI_CONFIG_*` 诊断）、`ai/liveScenarioCandidateSource.ts` + `ai/scenarioPrompt.ts` + `ai/scenarioGenerationAudit.ts` 真实 AI source（共享 transport、`LIVE_*` 诊断、脱敏 audit）；`ai/fixtureScenarioCandidateSource.ts` 开发/测试专用 fixture source + `data/fixtures/phase4/`（含 `manifest.json` 事件序列契约））
- API：`src/app/api/game/route.ts` + `createGameHandler.ts`（POST 创建）、`src/app/api/game/current/route.ts` + `currentGameHandler.ts`（GET 恢复）、`src/app/api/game/actions/`（POST 固定行动）
- 当前 UI：`src/components/CurrentGameScreen.tsx`（协调器）、`NewGameSetupForm.tsx`（真实提交）、`OpeningGameView.tsx`（场景展示）、`AdventureGameShell.tsx`（Phase 7 地图优先壳）、`WorldMapScreen.tsx`（旅行层）、`LocationSceneScreen.tsx`（地点热点）、`NpcDialoguePanel.tsx`（固定对话）、`AdventureDetailsPanel.tsx`（次级信息）、`adventureVisuals.tsx`（SVG 视觉档案）、`SceneActionPanel.tsx`（固定行动，兼容保留）、`TravelPanel.tsx`（移动，兼容保留）、`QuestTracker.tsx`（任务追踪，兼容保留）、`ItemPanel.tsx`（可拾取物品与背包，兼容保留）、`BattleArena.tsx`（战斗主视窗，Phase 9）、`BattleActionRail.tsx`（战斗行动栏，Phase 9）、`BattlePanel.tsx`（战斗面板，Phase 6→9 场景化）、`EndingPanel.tsx`（结局面板，Phase 6）
- 当前阶段：`docs/agent/当前开发阶段.md`
- Phase 1 Plan：`docs/superpowers/plans/2026-07-26-mvp-phase-1-scenario-contracts.md`
- Phase 2 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-2-create-game-persistence.md`
- Phase 3 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-3-deterministic-action-loop.md`
- Phase 4 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-4-exploration-quest-progression.md`
- Phase 5 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-5-item-acquisition-quest-stage-2.md`
- Phase 6 Plan：`docs/superpowers/plans/2026-07-28-mvp-phase-6-deterministic-battle-endings.md`
- Phase 4A Plan：`docs/superpowers/plans/2026-07-28-mvp-phase-4a-ai-contract-simulation.md`（Spec：`docs/superpowers/specs/2026-07-28-ai-contract-simulation-and-dynamic-opening-design.md`）
- Phase 4B Plan：`docs/superpowers/plans/2026-07-29-mvp-phase-4b-real-ai-dynamic-opening.md`（跨仓原子工作包：foundation `@ai-game/ai-transport` + SLG 迁移 + RPG live source）
- Phase 4C Plan：`docs/superpowers/plans/2026-07-29-mvp-phase-4c-structured-output-offline-regression.md`（Spec：`docs/superpowers/specs/2026-07-29-phase4c-real-ai-output-reliability-and-offline-regression-design.md`）

## 主要测试

- `src/components/NewGameSetupForm.test.tsx`、`CurrentGameScreen.test.tsx`、`OpeningGameView.test.tsx`、`SceneActionPanel.test.tsx`、`TravelPanel.tsx`、`QuestTracker.test.tsx`、`ItemPanel.test.tsx`、`BattlePanel.test.tsx`（Phase 6）、`EndingPanel.test.tsx`（Phase 6）
- `src/components/sharedUiContract.test.tsx`
- 领域：`src/game/domain/*.test.ts`（输入校验、蓝图/GameState 类型契约）
- 玩法：`src/game/gameplay/rpg/scenario/*.test.ts`（profile loader、任务图、validate/compile、确定性 fallback + fixture 钉值）、`actions/*.test.ts`、`quests/*.test.ts`、`battle/*.test.ts`（Phase 6）
- 应用与持久化：`src/game/application/*.test.ts`（use case + 真实 SQLite 集成）、`src/game/application/server/**/*.test.ts`（adapter 原子性/故障注入、组合根）、`src/app/api/**/*.test.ts`（状态码与不泄漏断言）
- 边界与回归：`src/dependencyBoundaries.test.ts`（含 server-only 静态守卫与 actions/quests/scenario/battle facade deep-import 守卫，Phase 6）、`src/game/gameplay/rpg/scenario/phase1Regression.test.ts`（含越权输入不进结构化状态）、`src/game/application/phase4ExplorationRegression.test.ts`（三类型固定 seed 探索旅程 + reload + 内容预算不变）、`src/game/application/phase5ItemQuestRegression.test.ts`（三类型固定 seed 物品取得 + stage 2 完成/stage 3 解锁 + reload）、`src/game/application/phase6BattleEndingRegression.test.ts`（三类型固定 seed 战斗与双结局 + reload + 内容预算不变，Phase 6）、`src/game/application/phase7MapLocationRegression.test.ts`（三类型固定 seed 地图地点旅程：observe → dialogue_choice → move → reload + 零泄漏，Phase 7）、`src/game/application/phase4aScenarioGenerationRegression.test.ts`（三类型合法 fixture generated + 三失败 fixture fallback，manifest 事件契约 + reload + 预算/双结局 + 零泄漏，Phase 4A）

## 修改注意事项

- 不把示例"灰石村/黑暗幻想"写死为产品规则。
- 不让 UI/API/store deep-import gameplay。
- 通用 UI 或 AI transport 命中共享触发条件，先读取 `docs/共同规范/`。
- 新建 gameplay 文件前先完成 Spec 对应阶段的测试用例。
- Phase 2 起 UI/API 只调用 application facade；不得直连 domain、scenario 或 SQLite repository（已由 `dependencyBoundaries.test.ts` 别名 + 相对路径双拦截与 server-only 静态守卫强制）。

## 最近维护

- 2026-07-31：完成 Phase 10 收口（completed / merged）：补齐 `server-only@0.0.1` 依赖，并将 Vitest 单独映射到无副作用 shim，生产 Next.js 的 server-only marker 保持不变；`npm run journey:phase10` 和全套离线验收通过（124 个测试文件、1,360 个通过、2 个显式跳过），本次未执行真实 AI 调用。
- 2026-07-30：建立 Phase 10 运行时 AI 导演与场景表演设计基线（planned / not_started）：三个独立 AI 请求、两个服务端批准固定选项、NPC 最小知识上下文、规则结果与下一场景单次 CAS、完整 fallback；不做自由输入、运行时蓝图扩容或生图。Spec：`docs/superpowers/specs/2026-07-30-runtime-ai-director-scene-performance-design.md`；Plan：`docs/superpowers/plans/2026-07-30-mvp-phase-10-runtime-ai-director.md`。
- 2026-07-30：完成 Phase 9 场景化战斗与敌人遭遇（implemented）：新增 `BattleArena.tsx`（纯呈现战场背景 + 敌我肖像 + HP）与 `BattleActionRail.tsx`（固定行动栏）；`BattlePanel.tsx` 根布局从 Panel 卡片改为 battle-viewport 战斗视窗，行动按钮改用 BattleActionRail，反馈增加 aria-label="战斗日志"；globals.css 新增 battle-viewport / arena / action-rail / 响应式样式。战斗规则、伤害、任务、结局、API、存档、AI、共享 UI 均未修改。956 tests 全绿。Plan：`docs/superpowers/plans/2026-07-30-mvp-phase-9-battle-viewport.md`，见 `docs/agent/战斗与结局.md`。
- 2026-07-29：完成 Phase 7 地图优先地点冒险主循环（completed / implemented）：地图旅行层 `current|travelable|known|locked` 四状态节点 → 地点场景点击互动 → `dialogue_choice` 固定对话（greet|ask_main_quest|review_clue）→ 任务推进 → 返回地图；本仓 SVG 占位视觉（七题材×八类），零 AI/图片调用；`CurrentGameScreen` 以 `AdventureGameShell` 替代旧面板主布局；API 白名单新增 `dialogue_choice`；三题材 SQLite 完整旅程回归通过；921 tests 全绿。Plan：`docs/superpowers/plans/2026-07-29-mvp-phase-7-map-first-location-playable-loop.md`，见 `docs/agent/地图与地点冒险.md`。
- 2026-07-29：完成 Phase 4C 结构化输出可靠性与离线回归（`AI_OUTPUT_FORMAT` 三值配置 + `response_format` extraBody 纯函数与 strict schema + live source/factory 装配 + `data/fixtures/phase4c/` 契约与三类型完整旅程离线回归 + smoke 脱敏安全汇总；失败类别/重试/fallback 语义不变，最终 fallback 额外携带既有稳定分类以避免汇总漏因，零 foundation 改动）；Phase 4B 真实计费 smoke 已于本机执行，三例均满足 generated|fallback 契约。
- 2026-07-29：完成 Phase 4B 真实 AI 动态开局（跨仓：foundation `@ai-game/ai-transport@0.1.0` + SLG 迁移 + RPG live source）：生产在有效本项目 AI 配置时使用 live source；配置/服务/候选失败在最多两次尝试与一次机械修复后安全 fallback；fixture 测试仍为主回归；opt-in 真实 smoke（`smoke:ai:phase4b`）就绪（后已执行，见上条）。
- 2026-07-28：完成 Phase 4A AI 契约模拟与生成体验（`ScenarioCandidateSource` 纯 port + `phase4a-v1` 契约 + server-only fixture source；一次机械修复/一次重试/确定性 fallback 编排；生产注入 unavailable source；`generationSource` 安全字段 + 等待态与一次性降级提示 UI；边界守卫与契约回归）。真实 AI 网络调用与 shared `@ai-game/ai-transport` 尚未实现（Phase 4B）。
- 2026-07-28：完成无 AI MVP 试玩验收工作包：`GameSessionView` 安全投影基础属性与最近结构化事件，`AdventureLogPanel` 提供确定性冒险记录；`DELETE /api/game/dev/current` 仅在 server development 门禁下原子清除 current slot；`CurrentGameScreen` 仅在 API 显式授权时显示确认清档按钮。未接入 AI、自由输入或共享 package。

- 2026-07-28：完成 Phase 6 确定性轻量战斗与双结局（battle/defeatedEnemyIds/ending runtime state + start_battle/battle_action intent + 确定性伤害计算 + failQuest/resolveEnding + BattleView/EndingView + BattlePanel/EndingPanel + 三类型固定 seed 战斗与双结局 SQLite 回归；无随机命中、技能、掉落、经验、治疗、装备、普通敌人或 AI）。
- 2026-07-27：完成 Phase 5 确定性物品取得与主线第二阶段（availableItemIds 蓝图契约 + take_item 裁决与 item_obtained、obtain_item reconciliation、obtainableItems/inventoryItems read model + ItemPanel、三类型固定 seed 物品回归；无 AI、物品使用、战斗或结局）。
- 2026-07-27：完成 Phase 4 确定性探索与任务推进（move 裁决 + location_visited、纯任务 reconciliation（visit/talk/discover、unlock_quests/closed）、GameSessionView + TravelPanel/QuestTracker、三类型固定 seed 探索回归；无 AI、物品、战斗或结局）。
- 2026-07-27：完成 Phase 3 确定性行动与 revision 续存档（observe / talk / investigate、v1→v2 migration、compare-and-swap、API/UI/边界测试；无 AI、移动、任务或战斗）。
- 2026-07-27：完成 Phase 2 创建游戏与本地存档实现（application use case + server-only SQLite 持久化 + API thin adapter + 开场/恢复 UI + 边界与 server-only 静态守卫，22 文件 / 322 用例）。
- 2026-07-26：完成 Phase 1 领域契约与确定性生成实现（domain + gameplay/scenario + 边界与回归测试，12 文件 / 229 用例）。
- 2026-07-27：建立 Phase 2 创建游戏、本地事务存档与开场恢复执行 Plan；实现尚未开始。
- 2026-07-26：建立 Phase 1 领域契约与确定性生成执行 Plan、机器可读当前阶段和 Agent 交接检查。
- 2026-07-26：Phase 0 新游戏资料表单成为 `@ai-game/ui@0.1.0` 的真实 RPG 消费者；提交只做 UI 校验，不提前创建 GameState 或调用 AI。
- 2026-07-26：建立动态生成型 MVP 开发基线。
