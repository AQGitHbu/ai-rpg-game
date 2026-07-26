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

工程脚手架和文档基线已建立。Phase 0 已实现 UI-only 的新游戏资料表单，真实消费 `@ai-game/ui`。Phase 1 已实现领域基线：`NewGameInput` 校验、7 类型/艺术风格 profile、蓝图与运行时类型、任务图可达性、候选蓝图 validate/compile、`GameState` 初始化和确定性 fallback 生成（同输入 + seed + templateVersion 结果相同，武侠/科幻/都市 fixture 钉值）。玩法回合推进、存档或 AI 调用仍未实现。

## 核心数据流

`NewGameInput → GameTypeProfile → ScenarioBlueprint 候选 → validate/compile → GameState → PlayerIntent → RuleResolution → NarrativeOutput → WorldEvent/Memory`

## 主要文件

- 玩家规则：`docs/策划文档/AI生成RPG_MVP.md`
- 开发 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`
- 领域层：`src/game/domain/`（`newGame.ts`、`scenarioBlueprint.ts`、`gameState.ts`、`events.ts`，facade `index.ts`）
- 玩法层：`src/game/gameplay/rpg/scenario/`（`gameTypeProfiles.ts`、`questGraph.ts`、`validateScenarioBlueprint.ts`、`compileScenarioBlueprint.ts`、`createFallbackBlueprint.ts`，facade `index.ts`）
- 数据：`data/base/gameTypeProfiles.json`、`data/base/artStyleProfiles.json`、`data/fixtures/phase1/*.json`
- 预留实现：`src/game/application/`、`src/game/application/server/`
- 当前 UI：`src/components/NewGameSetupForm.tsx`
- 当前阶段：`docs/agent/当前开发阶段.md`
- Phase 1 Plan：`docs/superpowers/plans/2026-07-26-mvp-phase-1-scenario-contracts.md`

## 主要测试

- `src/components/NewGameSetupForm.test.tsx`
- `src/components/sharedUiContract.test.tsx`
- 领域：`src/game/domain/*.test.ts`（输入校验、蓝图/GameState 类型契约）
- 玩法：`src/game/gameplay/rpg/scenario/*.test.ts`（profile loader、任务图、validate/compile、确定性 fallback + fixture 钉值）
- 边界与回归：`src/dependencyBoundaries.test.ts`、`src/game/gameplay/rpg/scenario/phase1Regression.test.ts`（含越权输入不进结构化状态）

## 修改注意事项

- 不把示例“灰石村/黑暗幻想”写死为产品规则。
- 不让 UI/API/store deep-import gameplay。
- 通用 UI 或 AI transport 命中共享触发条件，先读取 `docs/共同规范/`。
- 新建 gameplay 文件前先完成 Spec 对应阶段的测试用例。

## 最近维护

- 2026-07-26：完成 Phase 1 领域契约与确定性生成实现（domain + gameplay/scenario + 边界与回归测试，12 文件 / 229 用例）。
- 2026-07-26：建立 Phase 1 领域契约与确定性生成执行 Plan、机器可读当前阶段和 Agent 交接检查。
- 2026-07-26：Phase 0 新游戏资料表单成为 `@ai-game/ui@0.1.0` 的真实 RPG 消费者；提交只做 UI 校验，不提前创建 GameState 或调用 AI。
- 2026-07-26：建立动态生成型 MVP 开发基线。
