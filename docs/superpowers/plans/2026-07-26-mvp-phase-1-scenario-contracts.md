# MVP Phase 1：领域契约与确定性生成执行 Plan

> 日期：2026-07-26
> 状态：已完成（2026-07-26，分支 `codex/mvp-phase-1-scenario-contracts`）
> 目标分支：`codex/mvp-phase-1-scenario-contracts`
> 唯一修改仓库：`ai-rpg-game`
> 上游 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`

## 目标

建立不依赖 UI、数据库和 AI 的 RPG 领域基线：

```text
NewGameInput
→ GameTypeProfile
→ deterministic fallback ScenarioBlueprint
→ validate/compile
→ initialize GameState
```

Phase 1 完成时，相同 `NewGameInput + seed + templateVersion` 必须生成相同规则蓝图；至少武侠、科幻、都市三种类型能生成合法世界，并证明两个结局可达。

## 开始条件

1. `ai-game-foundation`、`ai-slg-game`、`ai-rpg-game` 的 Phase 0 已进入各自 `main`。
2. 从 RPG `main` 创建 `.worktrees/mvp-phase-1-scenario-contracts`，禁止在 main 直接开发。
3. 在目标 worktree 执行：

```powershell
npm run setup
npm run phase:status
npm run handoff:check
```

4. `handoff:check` 必须确认当前分支、Plan、入口文档和仓库范围。

## 明确边界

### 包含

- `NewGameInput`、枚举、长度和标签约束；
- 七种 `GameTypeProfile` 与艺术风格引用；
- `ScenarioBlueprint`、稳定 ID、内容预算和引用；
- 三阶段主线任务图、关闭方式和两个可达结局；
- 蓝图候选校验、编译和 `GameState` 初始化；
- 基于输入、seed、模板版本的确定性 fallback；
- 同目录测试、fixture 和跨层边界测试。

### 排除

- 修改 Phase 0 表单或接线 UI；
- SQLite、repository、API route、store；
- 真实 AI、prompt、transport、重试和 streaming；
- 战斗 resolver、NPC 对话、记忆和运行时任务推进；
- 新增或修改 `@ai-game/*` package；
- 把 SLG 类型、GameState、玩法或 fixture 复制进 RPG。

若实现过程中发现必须触碰排除项，应停止并更新 Plan，不得顺手扩展。

## 目录与 public facade

```text
data/base/gameTypeProfiles.json
data/base/artStyleProfiles.json
data/fixtures/phase1/
src/game/domain/newGame.ts
src/game/domain/scenarioBlueprint.ts
src/game/domain/gameState.ts
src/game/domain/events.ts
src/game/domain/index.ts
src/game/gameplay/rpg/scenario/gameTypeProfiles.ts
src/game/gameplay/rpg/scenario/questGraph.ts
src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts
src/game/gameplay/rpg/scenario/compileScenarioBlueprint.ts
src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts
src/game/gameplay/rpg/scenario/index.ts
```

- `src/game/domain/index.ts` 是稳定领域类型 facade。
- `src/game/gameplay/rpg/scenario/index.ts` 是场景生成规则 facade。
- 测试可导入同目录内部 helper；生产跨层 import 只能走 facade。
- domain 不读取 JSON、环境变量、时间、随机数、网络或文件系统。

## Task 1：新游戏输入契约

建立：

- `GameTypeId`
- `NarrativeStyle`
- `ContentIntensity`
- `NewGameInput`
- `validateNewGameInput`
- 规范化后的 `ValidatedNewGameInput`

验证规则以策划文档为准：

- 角色名字 2–20 字符；
- 身份/职业 2–80 字符；
- 角色基础信息最多 300 字；
- 性格标签 0–3 个，去重后校验；
- 世界观背景 20–500 字；
- 故事开端 20–300 字；
- 枚举必须来自 public union。

验证返回结构化错误 `{ field, code, params }`，不抛面向玩家的自然语言异常。输入中的数值、神器、权力或完成事件不进入状态。

测试先行：

- 每个长度边界的最小值、最大值、空白和越界；
- 未知枚举；
- 重复性格标签；
- trim/Unicode 字符计数保持确定性；
- 原始对象不被修改。

## Task 2：类型与艺术风格配置

建立七种 profile，字段至少包括：

```ts
type GameTypeProfile = {
  id: GameTypeId;
  label: string;
  worldConstraints: string[];
  allowedTags: string[];
  forbiddenTags: string[];
  namingGuide: string[];
  artStyleProfileId: string;
};
```

配置加载器负责：

- 七种 ID 完整且唯一；
- profile ID 与对象键一致；
- `artStyleProfileId` 引用存在；
- tag、命名规则和约束非空且去重；
- JSON 只在 gameplay loader 读取，domain 不依赖配置文件。

不要在 Phase 1 实现自然语言题材审查模型；fallback 只从已验证 profile 的允许模板构造。

## Task 3：蓝图与运行时类型

定义 `ScenarioBlueprintCandidate`、编译后的 `ScenarioBlueprint` 和最小 `GameState`。

必须包含：

- `schemaVersion: 1`
- `generationId`
- `seed`
- `templateVersion`
- `gameType`
- `inputDigest`
- world/player/locations/NPC/quests/enemies/items/endings/openingScene
- 固定 `ContentBudget`

所有引用使用品牌化或明确别名的稳定字符串 ID；显示名称不能作为引用。候选和已编译蓝图必须是不同类型，只有成功校验/编译后才能初始化状态。

`GameState` 在本阶段只建立可供后续扩展的最小结构：玩家、当前位置、已解锁地点、NPC、任务、背包、世界事实、事件账本、生成元数据和版本。不得提前实现行动 resolver。

## Task 4：任务图与结局可达性

MVP 主线固定为三阶段结构，但阶段内容动态生成。任务 objective 只允许 Phase 1 明确定义的可验证类型，例如：

- `visit_location`
- `talk_to_npc`
- `obtain_item`
- `discover_fact`
- `defeat_enemy`

校验必须拒绝：

- 重复或悬空 ID；
- objective 引用不存在实体；
- 没有唯一初始主线节点；
- 节点没有成功、失败或显式关闭路径；
- 无限循环且无可达关闭；
- 任一结局不可从初始节点到达；
- 结局数量不是 2；
- 超过主线阶段或支线预算。

提供纯函数 `analyzeQuestReachability`，返回可达节点、不可达节点、可达结局和检测到的无关闭强连通区域，便于测试和后续诊断。

## Task 5：蓝图校验、编译与初始化

`validateScenarioBlueprintCandidate` 至少检查：

- schema/version/game type/input digest；
- 内容预算数量；
- 全局 ID 唯一；
- location/NPC/item/enemy/quest/ending 引用完整；
- 起始场景只引用已公开地点和存在实体；
- 玩家初始物品存在；
- 任务图合法且两个结局可达；
- 数值在 Phase 1 catalog 允许范围内；
- profile 禁止标签未进入结构化 tags。

`compileScenarioBlueprint`：

- 不修改候选；
- 生成稳定排序和只读结构；
- 只接受验证成功结果；
- 失败返回结构化诊断，不产生部分 `GameState`。

`initializeGameState`：

- 完全由已编译蓝图构造；
- 不读取当前时间或随机源；
- 初始事件账本记录 generation metadata；
- 同一蓝图深度相等。

## Task 6：确定性 fallback

建立本地 deterministic PRNG/hash helper，随机源只能显式接收 seed。

`createFallbackBlueprint(input, seed)` 必须：

- 使用已验证输入和 `GameTypeProfile`；
- `inputDigest` 覆盖影响规则蓝图的全部输入；
- 生成 4 个主要地点、4–6 名核心 NPC、三阶段主线、最多 2 条短支线、3 类普通敌人、1 名 Boss 和 2 个可达结局；
- 在世界摘要、玩家身份解释、开场和主线冲突中记录输入来源标记；
- 不把玩家宣称的数值、神器或已完成事件直接写入状态；
- 不调用 AI、网络、时间或未注入随机数。

至少提供武侠、科幻、都市三个 fixture。fixture 保存输入与期望摘要/关键 ID，不保存大段容易漂移的完整文案。

## Task 7：边界与回归

更新 `src/dependencyBoundaries.test.ts`，守卫：

- domain 不依赖 gameplay/application/UI/store/provider；
- scenario gameplay 不依赖 application/UI/store/server-only；
- UI/API/store 不 deep-import scenario 内部文件；
- Phase 1 不新增 `@ai-game/*` 或 SLG import。

新增聚合回归：

1. 三种类型 fallback 均通过完整 validator；
2. 每种任务图均有两个可达结局；
3. 相同输入/seed/version 深度相等；
4. 改变 seed 会改变至少一个生成 ID 或选择，但不改变预算；
5. 编译和初始化不修改候选；
6. 恶意越权输入不会成为规则事实。

## 提交拆分

推荐同一分支内按以下顺序提交：

1. `feat: define new game and profile contracts`
2. `feat: validate RPG scenario blueprints`
3. `feat: add deterministic fallback scenarios`
4. `docs: record Phase 1 implementation`

如果任务由一个 Agent 完成，也必须保持这些逻辑边界，不把全部实现压成一个不可审查的大提交。

## 验收命令

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
```

完成时还必须：

- 将 `docs/agent/current-phase.json` 的状态从 `planned` 更新为 `completed`；
- 更新 `docs/agent/当前开发阶段.md`；
- 更新 `docs/agent/MVP核心闭环.md` 的实现现状、文件和测试；
- 保持策划文档只记录玩家规则，不写实现路径；
- `git diff --check` 通过且工作区没有意外生成文件。

## 完成定义

- 三种类型世界由纯 deterministic fallback 生成；
- 所有蓝图通过 schema、预算、引用和任务图校验；
- 两个结局均从初始主线可达；
- 同输入、seed、模板版本生成相同规则蓝图；
- 不存在 UI/DB/AI/foundation 范围扩张；
- 新 Agent 可以仅依据 AGENTS、当前阶段文档和本 Plan 完成并验证实现。
