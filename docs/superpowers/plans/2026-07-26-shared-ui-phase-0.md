# Shared UI Phase 0 执行 Plan

> 日期：2026-07-26
> 状态：已完成
> Public API：`ai-game-foundation/docs/specs/2026-07-26-shared-ui-v0.1-public-api.md`

## 目标

用 RPG 新游戏创建入口的真实需求验证第一次跨三仓共享抽取。完成后，SLG 和 RPG 都从 `@ai-game/ui@0.1.0` 消费 `InlineButton`、`Panel`、`Tag`，foundation 负责公共实现和独立测试。

## 基线

| 仓库 | 分支 | 起始 SHA |
|---|---|---|
| `ai-game-foundation` | `codex/shared-ui-phase-0` | `62df39b` |
| `ai-slg-game` | `codex/shared-ui-phase-0` | `73216fc3` |
| `ai-rpg-game` | `codex/shared-ui-phase-0` | `b7046de` |

三个 worktree 目录均为各仓库 `.worktrees/shared-ui-phase-0/`。SLG 主工作区原有 `vitest-full.log`、`vitest2.log` 不进入本任务。

## Task 1：修复 foundation 发现与本地联调

- 两个游戏新增同构的 `foundationLocator.mjs`，读取 `.ai-game-foundation.json`。
- locator 通过 `git rev-parse --git-common-dir` 找到主仓根，在存在时选择同名 foundation worktree。
- 新增 `linkFoundation.mjs`，安全建立被忽略的 `.foundation` junction；目标不一致时失败而不是覆盖。
- `syncStandards` 和 `checkStandards` 使用 locator；check 同时验证本地副本与当前 foundation 源。
- `shared:lookup` 输出 released 和 planned/candidate packages。
- 为主仓、同名 worktree和 env override 编写 locator 测试。

验收：在 RPG/SLG Phase 0 worktree 中不设置绝对路径即可解析到 foundation Phase 0 worktree。

## Task 2：建立 `@ai-game/ui`

- 按 Public API Spec 创建 `packages/ui`。
- 增加 build、declaration、独立 node test 和 pack 检查。
- 更新共享模块目录、foundation README/AGENTS/CHANGELOG。

验收：package 无游戏 import，`npm test` 与 `npm pack --dry-run` 通过。

## Task 3：迁移 SLG 消费者

- package 依赖使用 `file:.foundation/packages/ui` 本地 bootstrap。
- 三个现有组件文件改为 package adapter。
- 原组件测试保持，新增 package consumer contract。
- 补齐 UI agent 文档中的 Tag/package 所有权。

验收：定向 UI 测试、typecheck、boundary tests、build 通过；截图/浏览器检查无明显视觉回退。

## Task 4：建立 RPG 真实消费者

- 实现 UI-only 的新游戏创建表单，包含预设游戏类型、角色资料、世界观、开端和叙事风格。
- 页面真实挂载该表单；提交只展示“世界生成将在 Phase 1 接入”，不创建 GameState/DB/AI。
- 使用 `Panel` 组织区域、`Tag` 表示类型/状态、`InlineButton type="submit"` 提交。
- 建立表单与 package consumer contract 测试，RPG 自己提供主题 CSS。
- 更新 `docs/共享候选登记表.md` 和 `docs/agent/MVP核心闭环.md` 实现现状。

验收：RPG lint、typecheck、测试、boundary tests 和 build 通过。

## Task 5：三仓验收与回滚

- 记录 dependency/lockfile 不含机器绝对路径。
- 运行 standards 同步与漂移检查。
- foundation 先提交，SLG/RPG 再分别提交。
- 使用全新无历史 agent 只读复验 AGENTS 路由、locator 和两个消费者证据。

## 明确排除

- `TabBar`、Surface、Modal、focus/portal；
- 对白 UI、角色立绘、streaming；
- `NewGameInput` domain、ScenarioBlueprint、GameState、任务、战斗；
- SQLite、AI transport、真实 AI 调用；
- registry/remote 发布。

## 风险与回滚

- 如果 package 使 SLG 视觉或测试回退，恢复三个 adapter 的本地实现，RPG 暂留本地组件，foundation package 不发布。
- 如果 `.foundation` junction 在环境中不可创建，保留 locator，并改用同一路径下的目录链接或后续 registry；不得提交绝对路径。
- 如果 RPG 对某原语没有真实使用，立即从 v0.1 exports 和候选清单移除，不为满足数量保留。

## 完成记录

- foundation：standards 与 UI package 测试通过，`npm pack --dry-run` 通过。
- SLG：lint、locator、typecheck、40 项边界测试、11 项 UI 测试和生产构建通过。
- RPG：doctor、lint、8 项测试、locator、边界测试、typecheck 和生产构建通过。
- 浏览器实测：七种类型可见；“科幻”切换、完整表单填写、叙事风格切换和提交反馈正常；控制台无错误。
- 本地依赖通过被忽略的 `.foundation` junction 解析，lockfile 不含机器绝对路径；foundation 跟踪确定性 `dist/`，两个消费者的正式 `setup` 已并行通过且没有写共享依赖目录。
- 同时移走 foundation 根与 UI package 的 `node_modules/` 后，RPG production build 仍通过，证明消费者不依赖 foundation 的未提交安装状态。
