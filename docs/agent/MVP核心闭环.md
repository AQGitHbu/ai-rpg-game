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

工程脚手架和文档基线已建立。Phase 0 已实现 UI-only 的新游戏资料表单，真实消费 `@ai-game/ui`。Phase 1 已实现领域基线：`NewGameInput` 校验、7 类型/艺术风格 profile、蓝图与运行时类型、任务图可达性、候选蓝图 validate/compile、`GameState` 初始化和确定性 fallback 生成（同输入 + seed + templateVersion 结果相同，武侠/科幻/都市 fixture 钉值）。Phase 2 已实现创建与本地存档闭环：表单提交经 POST /api/game 进入 `createGame` use case（domain 校验 → fallback 生成 → validate/compile → SQLite 原子保存，失败无半存档），返回只含允许信息的开场 read model；刷新经 GET /api/game/current 恢复同一存档；UI/API 只消费 `@/game/application` 门面，libsql 与数据库路径只存在于 server-only 层。Phase 3 已规划固定选项的确定性行动、revision 续存档和行动 UI；玩法回合推进、自由输入与 AI 调用仍未实现。

## 核心数据流

`NewGameInput → GameTypeProfile → ScenarioBlueprint 候选 → validate/compile → GameState → PlayerIntent → RuleResolution → NarrativeOutput → WorldEvent/Memory`

## 主要文件

- 玩家规则：`docs/策划文档/AI生成RPG_MVP.md`
- 开发 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`
- 领域层：`src/game/domain/`（`newGame.ts`、`scenarioBlueprint.ts`、`gameState.ts`、`events.ts`，facade `index.ts`）
- 玩法层：`src/game/gameplay/rpg/scenario/`（`gameTypeProfiles.ts`、`questGraph.ts`、`validateScenarioBlueprint.ts`、`compileScenarioBlueprint.ts`、`createFallbackBlueprint.ts`，facade `index.ts`）
- 数据：`data/base/gameTypeProfiles.json`、`data/base/artStyleProfiles.json`、`data/fixtures/phase1/*.json`
- 应用层：`src/game/application/`（`createGame.ts`、`getCurrentGame.ts`、`openingGameView.ts`，facade `index.ts`——UI/API 唯一游戏业务入口）
- server-only 持久化：`src/game/application/server/`（`compositionRoot.ts` 生产装配点；`persistence/gameRepository.ts` 纯端口、`persistence/sqliteClient.ts` 全库唯一 libsql/`GAME_DB_PATH` 感知文件、`persistence/sqliteGameRepository.ts` 事务化 adapter）
- API：`src/app/api/game/route.ts` + `createGameHandler.ts`（POST 创建）、`src/app/api/game/current/route.ts` + `currentGameHandler.ts`（GET 恢复）
- 当前 UI：`src/components/CurrentGameScreen.tsx`（协调器）、`NewGameSetupForm.tsx`（真实提交）、`OpeningGameView.tsx`（开场展示）
- 当前阶段：`docs/agent/当前开发阶段.md`
- Phase 3 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-3-deterministic-action-loop.md`
- Phase 1 Plan：`docs/superpowers/plans/2026-07-26-mvp-phase-1-scenario-contracts.md`
- Phase 2 Plan：`docs/superpowers/plans/2026-07-27-mvp-phase-2-create-game-persistence.md`

## 主要测试

- `src/components/NewGameSetupForm.test.tsx`、`CurrentGameScreen.test.tsx`、`OpeningGameView.test.tsx`
- `src/components/sharedUiContract.test.tsx`
- 领域：`src/game/domain/*.test.ts`（输入校验、蓝图/GameState 类型契约）
- 玩法：`src/game/gameplay/rpg/scenario/*.test.ts`（profile loader、任务图、validate/compile、确定性 fallback + fixture 钉值）
- 应用与持久化：`src/game/application/*.test.ts`（use case + 真实 SQLite 集成）、`src/game/application/server/**/*.test.ts`（adapter 原子性/故障注入、组合根）、`src/app/api/**/*.test.ts`（状态码与不泄漏断言）
- 边界与回归：`src/dependencyBoundaries.test.ts`（含 server-only 静态守卫）、`src/game/gameplay/rpg/scenario/phase1Regression.test.ts`（含越权输入不进结构化状态）

## 修改注意事项

- 不把示例“灰石村/黑暗幻想”写死为产品规则。
- 不让 UI/API/store deep-import gameplay。
- 通用 UI 或 AI transport 命中共享触发条件，先读取 `docs/共同规范/`。
- 新建 gameplay 文件前先完成 Spec 对应阶段的测试用例。
- Phase 2 起 UI/API 只调用 application facade；不得直连 domain、scenario 或 SQLite repository（已由 `dependencyBoundaries.test.ts` 别名 + 相对路径双拦截与 server-only 静态守卫强制）。

## 最近维护

- 2026-07-27：完成 Phase 2 创建游戏与本地存档实现（application use case + server-only SQLite 持久化 + API thin adapter + 开场/恢复 UI + 边界与 server-only 静态守卫，22 文件 / 321 用例）。
- 2026-07-26：完成 Phase 1 领域契约与确定性生成实现（domain + gameplay/scenario + 边界与回归测试，12 文件 / 229 用例）。
- 2026-07-27：建立 Phase 2 创建游戏、本地事务存档与开场恢复执行 Plan；实现尚未开始。
- 2026-07-26：建立 Phase 1 领域契约与确定性生成执行 Plan、机器可读当前阶段和 Agent 交接检查。
- 2026-07-26：Phase 0 新游戏资料表单成为 `@ai-game/ui@0.1.0` 的真实 RPG 消费者；提交只做 UI 校验，不提前创建 GameState 或调用 AI。
- 2026-07-26：建立动态生成型 MVP 开发基线。
