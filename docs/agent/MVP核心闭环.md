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

工程脚手架和文档基线已建立。Phase 0 已实现 UI-only 的新游戏资料表单，真实消费 `@ai-game/ui`，但尚未定义领域输入、生成世界、玩法、存档或 AI。

## 核心数据流

`NewGameInput → GameTypeProfile → ScenarioBlueprint 候选 → validate/compile → GameState → PlayerIntent → RuleResolution → NarrativeOutput → WorldEvent/Memory`

## 主要文件

- 玩家规则：`docs/策划文档/AI生成RPG_MVP.md`
- 开发 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`
- 预期实现：`src/game/domain/`、`src/game/gameplay/rpg/`、`src/game/application/`、`src/game/application/server/`
- 当前 UI：`src/components/NewGameSetupForm.tsx`

## 主要测试

- `src/components/NewGameSetupForm.test.tsx`
- `src/components/sharedUiContract.test.tsx`
- 领域与玩法测试尚未建立；开发 Spec 规定 schema、规则、AI 合同、固定 seed 通关和边界测试。

## 修改注意事项

- 不把示例“灰石村/黑暗幻想”写死为产品规则。
- 不让 UI/API/store deep-import gameplay。
- 通用 UI 或 AI transport 命中共享触发条件，先读取 `docs/共同规范/`。
- 新建 gameplay 文件前先完成 Spec 对应阶段的测试用例。

## 最近维护

- 2026-07-26：Phase 0 新游戏资料表单成为 `@ai-game/ui@0.1.0` 的真实 RPG 消费者；提交只做 UI 校验，不提前创建 GameState 或调用 AI。
- 2026-07-26：建立动态生成型 MVP 开发基线。
