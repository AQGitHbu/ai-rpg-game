# MVP Phase 2：创建游戏与本地存档执行 Plan

> 日期：2026-07-27
> 状态：待执行
> 目标分支：`codex/mvp-phase-2-create-game-persistence`
> 唯一修改仓库：`ai-rpg-game`
> 上游基线：Phase 1 已合入 `main`（`e71cc2b`）
> 上游 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`

## 目标

让玩家的有效开局资料经过已有的确定性生成管线，原子地保存为一个本地可恢复的游戏，并展示开场场景。

```text
NewGameSetupForm
→ POST /api/game
→ application createGame
→ validate input / fallback / validate / compile / initialize
→ SQLite transaction
→ OpeningGameView
→ GET current game after refresh
```

Phase 2 的生成来源固定为 fallback，不调用 AI。数据库或生成失败时，页面给出可理解的错误，且没有部分蓝图、部分状态或半初始化的“当前存档”。

## 开始条件

1. 本 Plan 和 `current-phase.json` 必须先提交并 fast-forward 合入 `ai-rpg-game/main`；主工作区必须干净。
2. 从 `ai-rpg-game` 主工作区（`main`）运行：

```powershell
npm run phase:start
```

3. 脚本创建或核对 `.worktrees/mvp-phase-2-create-game-persistence`，完成 setup 与严格 `handoff:check` 后，实现 agent 在该 worktree 运行。开始前先读根 `AGENTS.md`、`docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/MVP核心闭环.md` 和本 Plan。
4. 当前 worktree 必须是 `codex/mvp-phase-2-create-game-persistence`，且仅修改 `ai-rpg-game`。`@ai-game/ui` 仅使用已有 `Panel`、`InlineButton`、`Tag`；本阶段不得修改 `ai-game-foundation`、`ai-slg-game` 或任何 `@ai-game/*` package。

## 明确边界

### 包含

- application 层的 `createGame`、`getCurrentGame` 和稳定 read model；
- SQLite server-only repository、schema migration/初始化和原子写入；
- 已有 fallback 生成→校验→编译→初始 `GameState` 的应用编排；
- `POST /api/game` 与读取当前游戏的薄 API adapter；
- 新游戏表单真实提交、加载/校验/失败反馈、开场展示和刷新恢复；
- repository、application、API、UI 与跨层依赖边界测试。

### 排除

- 真实 AI、prompt、streaming、重试、图片或 `@ai-game/ai-transport`；
- 移动、调查、对话、自由输入解析、任务推进、战斗、奖励或任何 GameState 写入 resolver；
- NPC 记忆、关系演进、存档列表、删除/覆盖存档 UI、云存档和多账户；
- 新增共享 UI 原语、主题迁移或修改 foundation/SLG；
- 改写 Phase 1 domain/scenario 规则、内容预算或 fixture。

若需要越过这些边界，停止实现并先更新 Spec/Plan；不得把 Phase 3 或 Phase 4 的能力顺手并入。

## 数据与所有权决定

- Phase 2 只暴露一个“当前本地游戏”，没有存档管理界面。检测到已有当前游戏时，创建请求返回稳定业务错误 `ACTIVE_GAME_EXISTS`，不删除、不覆盖旧存档；重开/多存档留待后续明确设计。
- 默认数据库文件为仓库本地被忽略的 `db/rpg.sqlite`；允许仅在 server 运行时用一个专用环境变量覆盖路径，测试必须显式注入临时数据库路径，不能读 sibling SLG 环境或写入版本控制文件。
- 每局持久化独立 `gameId`（用于 API/read model）与既有 `generationId`（用于 deterministic blueprint 追溯）。`gameId`、时钟和 seed 都由 application 的可注入依赖提供；domain 与 scenario 保持纯函数，测试不依赖真实时间或随机数。
- SQLite 存储编译后的 `ScenarioBlueprint` 与 `GameState` 的 JSON、schema/version、生成元数据和当前游戏指针。读取后必须验证可解析、版本兼容且 `state.generation.generationId` 与蓝图一致；损坏记录不得伪装成可玩的存档。
- 首次创建在同一个 SQLite 写事务内写入蓝图、状态和 current-game 指针。任何一步失败都回滚；不允许分别写“蓝图成功、状态失败”。

## 目录与 public facade

```text
src/game/application/createGame.ts
src/game/application/getCurrentGame.ts
src/game/application/index.ts
src/game/application/server/persistence/gameRepository.ts
src/game/application/server/persistence/sqliteGameRepository.ts
src/game/application/server/persistence/sqliteClient.ts
src/app/api/game/route.ts
src/app/api/game/current/route.ts
src/components/NewGameSetupForm.tsx
src/components/OpeningGameView.tsx
```

- `src/game/application/index.ts` 是 UI/API 唯一可用的游戏业务 facade。
- `application` 可以导入 `domain` 和 scenario facade `@/game/gameplay/rpg/scenario`；禁止 deep import scenario 内部文件。
- `application/server/**` 是唯一能导入 `@libsql/client`、`server-only` 和数据库路径配置的层；repository interface 不泄漏 libsql 类型。
- `app/api/**` 只做 HTTP 参数/响应映射；`components/**` 只通过 API/client adapter 消费 application read model，不能导入 repository、SQLite、domain 或 gameplay。
- 更新 `src/dependencyBoundaries.test.ts`：允许上述 application→facade 的受限方向，同时继续禁止 UI/API/store 直连 gameplay，禁止客户端进入 `application/server`，并新增 server-only/persistence 逃逸的相对路径守卫。

## Task 1：应用契约与 read model

先为 application 写测试并建立：

- `CreateGameCommand`（原始 `NewGameInput`、可选仅测试用 seed 不从浏览器接收）；
- `CreateGameResult` 联合：成功返回 `gameId`、`OpeningGameView` 与生成来源 `fallback`；失败返回稳定代码、字段错误或可显示参数；
- `CurrentGameResult`：`none`、`active`、`corrupt` 三种明确状态；
- 最小 `OpeningGameView`：gameId、世界名称/摘要/类型、玩家身份、当前地点、可见 NPC、初始物品、开场叙事、建议行动文案和 generation metadata 的非敏感展示字段。

不要把完整 blueprint、全部隐藏地点、未解锁任务或任何 repository 实体直接返回浏览器。read model 仅从已编译蓝图和初始 `GameState` 投影，不能由 UI 拼装规则事实。

测试覆盖：有效输入的 view、所有验证错误透传、候选/编译失败不触及 repository、view 不泄漏隐藏内容、依赖注入下 seed/gameId/clock 可重复。

## Task 2：server-only SQLite repository

建立与 application 解耦的 repository interface 和 libsql adapter。

- schema 必须版本化、可重复初始化，并包含 active game 指针；默认文件位于被忽略的 `db/`。
- 提供 `createInitialGame`、`getCurrentGame`；返回区分无存档、数据损坏、冲突和基础设施失败的结构化结果，不向 UI 暴露 SQL/libsql 异常文本。
- `createInitialGame` 在单个写事务内持久化完整的 compiled blueprint、初始 state 与 pointer；若已有 active game，返回 `ACTIVE_GAME_EXISTS`，不修改任何记录。
- 读取必须 JSON parse、防御性检查版本和 generation ID 一致性；不合法数据为 `corrupt`，不自动重置或覆盖。
- repository 测试使用临时 `tmp/` SQLite 文件和真实 adapter；验证初始化幂等、round-trip、重复创建不覆盖、注入故障时回滚、损坏 JSON/版本不兼容的安全响应。

`@libsql/client` 的具体 transaction API 以锁定版本 `0.17.3` 的类型和测试为准；不得为了方便在应用层拼 SQL 或让客户端创建数据库连接。

## Task 3：确定性 createGame 编排

实现 application use case 的严格顺序：

1. 服务端 `validateNewGameInput`；失败立即返回字段错误。
2. 加载 profile，调用 `createFallbackBlueprint(validatedInput, injectedSeed)`。
3. 对候选执行既有 validate/compile，成功后 `initializeGameState`；任何规则诊断映射为稳定 `GENERATION_INVALID`，不写库。
4. 使用 injected `gameId`/clock 调用 repository 的原子 `createInitialGame`。
5. 成功后从同一已编译蓝图和初始状态投影 `OpeningGameView`，标记来源为 `fallback`。

application 不读取 `process.env`、文件路径或 libsql 类型；production composition root 在 server-only 层提供真实 repository、UUID/clock/seed。浏览器提交不得指定 seed、gameId、数据库路径、生成来源或任意 state 字段。

新增 use-case 测试：三种类型成功创建、确定性依赖注入、无效输入零写入、validator/repository 异常映射、冲突不覆盖、返回 view 与已存记录一致。

## Task 4：HTTP adapter 与 UI 接线

- `POST /api/game` 只接受允许的开局字段，拒绝多余的规则字段和不合法 JSON；调用 application facade 后映射为明确 HTTP status 与无密钥响应。
- `GET /api/game/current` 返回 `none`、active opening view 或可恢复的 corrupt 状态；不返回 blueprint/state JSON。
- 将 `NewGameSetupForm` 改为受控资料表单：提交时调用 API，显示字段校验、loading、服务器错误和 active-game 冲突；移除 Phase 0 的“将在 Phase 1 接入”文案。
- 根页面/客户端协调器加载 current game：无存档显示创建表单；有 active game 显示 `OpeningGameView`；刷新后恢复相同开场。
- `OpeningGameView` 显示世界、角色、当前地点、开场叙事和已允许信息。动作按钮、自由输入与战斗不出现为可执行功能；可展示“交互将在下一阶段开放”的非交互提示，但不得伪造状态变化。
- 延续现有 `Panel`、`InlineButton`、`Tag`，不新增 shared UI 需求。必须保持键盘可用、loading 期间防止重复提交，并通过 `aria-live` 反馈状态。

组件/API 测试覆盖：有效表单→loading→opening view、字段错误、重复提交防护、active-game 冲突、reload/current API、UI 不接触 SQLite/scenario、无 AI 网络请求。

## Task 5：回归、边界与文档

- 更新 architecture boundary tests，加入 application/server/persistence 的许可与禁止方向，并保留 Phase 1 的 domain/scenario 纯度。
- 为 server-only 模块添加防止 client import 的静态测试；确保 `next build` 不把 libsql 或数据库路径带入客户端 bundle。
- 更新 `docs/agent/当前开发阶段.md`、`current-phase.json`、`MVP核心闭环.md` 和 `Agent文档索引.md` 为 Phase 2 实际实现事实；不要在 `策划文档/` 中加入代码路径。
- 如增加数据库路径环境变量，只更新 `.env.example` 与 `docs/agent/AI环境.md` 的运行环境说明；不读取或复制 SLG 的 `.env`，不写入真实值。

## 提交拆分

建议同一分支按以下逻辑提交，避免把持久化、应用与 UI 混成不可审查的大提交：

1. `feat: add RPG game persistence repository`
2. `feat: create fallback games through application`
3. `feat: connect new game UI to saved opening state`
4. `test: guard Phase 2 persistence boundaries`
5. `docs: record Phase 2 implementation`

## 验收命令

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
npm run handoff:check
```

完成时还必须：

- 用真实临时 SQLite 文件证明创建后重新打开 repository 可恢复同一 current game；
- 用故障注入证明写入失败后无 current game、无半初始化数据；
- `git diff --check` 通过，数据库、日志、临时文件和 `.env.local` 未进入 Git；
- `current-phase.json` 改为 `completed / implemented`，但不自动切到 Phase 3。

## 完成定义

- 玩家可从现有表单创建一个 fallback 世界，并立即看到只包含允许信息的开场；
- 刷新页面可恢复该本地存档；
- 无效输入、生成失败、数据库失败或重复创建不会损坏当前存档；
- UI/API 不直连 gameplay 或 SQLite，server-only 代码不进入客户端；
- 没有真实 AI、动作系统或跨仓共享范围扩张；
- 新 Agent 可仅根据 AGENTS、当前阶段文档和本 Plan 实现并验证 Phase 2。
