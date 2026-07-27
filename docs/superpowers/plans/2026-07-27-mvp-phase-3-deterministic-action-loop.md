# MVP Phase 3：确定性场景行动与续存档执行 Plan

> 日期：2026-07-27
> 状态：待执行
> 目标分支：`codex/mvp-phase-3-deterministic-action-loop`
> 唯一修改仓库：`ai-rpg-game`
> 上游基线：Phase 2 已合入 `main`（`3b41b21`）
> 上游 Spec：`docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md`

## 目标

让已创建并恢复的开场世界第一次变得可操作：玩家从固定、规则允许的选项中选择观察、交谈或调查；纯规则 resolver 裁决结果，原子地续存档，并把合法结果或明确拒绝反馈回场景。

```text
OpeningGameView（revision + 固定行动）
→ POST /api/game/actions
→ application performAction
→ load current record → validate intent → pure resolver
→ SQLite compare-and-swap transaction
→ ActionResultView（最新开场 + 规则反馈）
```

本阶段验证“玩家输入只是意图、规则独占状态写入”的最小闭环。叙事只使用确定性模板反馈，不调用 AI；每次成功行动刷新同一局的状态与 revision，刷新页面仍恢复最新状态。

## 开始条件

1. 本 Plan、`current-phase.json` 与入口文档必须先提交并位于 `ai-rpg-game/main`；主工作区干净。
2. 从 `ai-rpg-game` 主工作区（`main`）运行：

```powershell
npm run phase:start
```

3. 脚本创建或核对 `.worktrees/mvp-phase-3-deterministic-action-loop`，完成 setup 与严格 `handoff:check` 后，实现 agent 只在该 worktree 开发。开始前阅读根 `AGENTS.md`、`docs/游戏设计原则.md`、`docs/游戏开发规范.md`、`docs/Agent文档索引.md`、`docs/agent/当前开发阶段.md`、`docs/agent/MVP核心闭环.md`、`docs/agent/行动裁决.md`、`docs/策划文档/AI生成RPG_MVP.md` 和本 Plan。
4. 本阶段仅修改 `ai-rpg-game`。不得修改 `ai-game-foundation`、`ai-slg-game` 或任何 `@ai-game/*` package；已有 `Panel`、`InlineButton`、`Tag` 足够，未命中共享基础设施触发条件。

## 明确边界

### 包含

- 只包含 `observe`、`talk`、`investigate` 三类结构化固定意图、稳定拒绝码和纯 resolver；
- 将可调查事实显式纳入场景蓝图，并由 fallback 生成器、校验器、编译器和 fixture 同步支持；
- 行动领域事件、不可变 `GameState` 演进、可见事实/read model 与确定性反馈模板；
- SQLite 存档 revision、Phase 1 → Phase 2 的兼容 migration、compare-and-swap 原子更新；
- `performAction` application use case、薄 HTTP adapter、固定行动 UI 与刷新恢复；
- domain / gameplay / repository / application / API / UI / migration / 依赖边界测试。

### 排除

- 自由文本输入、AI 意图识别、AI NPC 对话、AI 场景叙事、prompt、streaming 或任何网络模型调用；
- `move`、`use_item`、给予、交易、攻击、休息、离开、任务状态推进、奖励、战斗、结束条件和新地点/NPC/道具生成；
- 删除/重开/多存档、云同步、多人会话；
- 新共享 UI 原语、主题迁移、foundation/SLG 改动；
- 重写 Phase 1 内容预算或 fallback 的剧情结构（只可为场景增加受校验的可调查事实引用）。

若某项需求越过此边界，停止实现并先建立下一阶段 Plan；不得将“能点击”扩张为自由输入、任务或战斗系统。

## 固定规则决定

### 行动契约

Phase 3 的 `PlayerIntent` 是封闭 discriminated union：

```ts
type PlayerIntent =
  | { readonly type: "observe"; readonly locationId: LocationId }
  | { readonly type: "talk"; readonly npcId: NpcId }
  | { readonly type: "investigate"; readonly factId: FactId };
```

- 浏览器只能从当前 read model 返回的 `AvailableAction` 中提交一种意图，并且必须附带当前 `revision`；不得提交 freeText、seed、gameId、完整 state 或任何数值字段。
- `observe` 只能针对当前地点，成功追加观察事件；`talk` 只能针对当前地点在场 NPC，成功将该 NPC 标为已见并追加事件；`investigate` 只能针对当前场景列出的、尚未发现的事实，成功将该事实标为已发现并追加事件。
- 重复观察、已见 NPC 或已发现事实必须返回稳定的、玩家可读的拒绝结果；错误目标、目标不在场和旧 revision 同样必须有稳定代码。拒绝永远不写入状态或事件账本。
- resolver 的成功结果必须包含下一份不可变 `GameState`、追加的领域事件、以及只由已确认结果组成的确定性反馈；application、API、UI 不得自行 patch state 或编写叙事事实。

### 场景与可见信息

- 在 `SceneDefinition` 增加 `investigableFactIds`。校验器要求其无重复、均引用同一蓝图存在的事实，并且 opening scene 至少有一个条目；compile 后保持品牌化 ID。
- fallback 以确定规则选择开场可调查事实，所有 7 个类型和既有固定 fixture 必须同步更新。不得从玩家自由文本解析出额外事实、物品或数值。
- `OpeningGameView` 扩展为 `revision`、`availableActions`、`knownFacts` 和最近一次可安全展示的 action feedback；它仍不得泄漏未发现事实、隐藏地点、未解锁任务、蓝图、seed 或 inputDigest。
- `availableActions` 仅由已编译蓝图和当前 `GameState` 投影，UI 不得自己猜测哪些目标可行动。

### 事件与持久化

- 扩展 `GameEvent` union，最小包含地点观察、NPC 初次交谈、事实发现三种事件。事件由 resolver 接受注入的时间/序号产生；domain 不读取时钟或随机数。
- 存档记录增加单调 `revision`。读取把 revision 投影到 read model；初始游戏为 revision 0。
- repository 增加一个原子 `applyResolvedAction` 端口：同一 SQLite 写事务按 `gameId + expectedRevision` 条件更新 state JSON 与 revision；不匹配返回 `STALE_GAME_REVISION`，不重试、不覆盖。
- 将 SQLite schema 从 v1 迁移到 v2，保留已有 Phase 2 存档及 current-game 指针，并为旧记录补 revision 0。迁移必须幂等、事务化、可测试；未知未来 schema 仍安全失败，绝不重置玩家存档。
- application 在读取后执行 validate/resolver，再调用 compare-and-swap；竞争冲突只返回稳定冲突结果，客户端读取最新存档后才能继续。数据库异常不泄漏驱动文本。

## 目录与 public facade

```text
src/game/domain/events.ts
src/game/domain/gameState.ts
src/game/gameplay/rpg/actions/
  index.ts
  intents.ts
  validateIntent.ts
  resolveAction.ts
src/game/application/performAction.ts
src/game/application/openingGameView.ts
src/game/application/index.ts
src/game/application/server/persistence/gameRepository.ts
src/game/application/server/persistence/sqliteGameRepository.ts
src/app/api/game/actions/route.ts
src/app/api/game/actions/actionHandler.ts
src/components/SceneActionPanel.tsx
```

- `actions/index.ts` 是 application 可用的唯一 actions facade；application 不能 deep import actions 内部文件。
- `application/index.ts` 是 API/UI 唯一可用的游戏业务 facade；route 仅可向 server composition root 请求入口。
- `application/server/**` 继续是唯一可接触 SQLite、数据库路径和 transaction 的层；游戏规则、组件和 API 不得导入 libsql 或 SQL adapter。
- 相对路径也必须受 `dependencyBoundaries.test.ts` 守卫；新增文件后同步更新允许与禁止方向。

## Task 1：行动 domain 与场景契约

先写测试，再扩展 `GameEvent`、`GameState` 关联 helper 和 `SceneDefinition.investigableFactIds`。实现候选校验、编译与 fallback 的最小变更，并更新三类型 fixture 钉值与现有全量回归。

测试至少覆盖：错误/重复/跨场景 ID；已编译 ID 不可与普通 string 混用；所有 fallback 类型的 opening scene 有可调查事实；玩家输入越权内容不进入可调查事实；Phase 1 双结局和内容预算仍成立。

## Task 2：纯 intent 校验与 resolver

建立 `src/game/gameplay/rpg/actions/`，不依赖 application、repository、UI、`Date`、`Math.random` 或 AI。

- `validateIntent` 只读取 compiled blueprint + 当前 GameState，返回 collectable stable validation code/参数，不改状态。
- `resolveAction` 对有效 intent 返回下一份 state、精确事件和确定性反馈；对无效 intent 返回拒绝而不返回 next state。
- 保持所有数组不可变，不 mutate 输入；事件账本只追加，不重写初始化事件。
- 覆盖 observe、首次/重复 talk、首次/重复 investigate、未知 ID、离场 NPC、跨场景事实、规则失败零状态变化和相同输入/注入依赖的确定性。

本 Task 不实现 location 解锁或 quest objective 完成，即便事件与未来目标语义看似相近。

## Task 3：revision migration 与原子续存档

扩展纯 repository 端口、SQLite schema 与真实 adapter。

- 为现有新建/读取记录补 `revision`，扩展 Phase 2 创建和 get-current 测试；Phase 2 现有数据库升级后必须仍能恢复。
- 以可控方式构造真实 v1 SQLite 临时文件，验证升级到 v2 后状态、蓝图、指针、generationId 都保留且 revision 为 0；重复初始化不改变数据。
- 用真实临时 SQLite 验证成功 action 只递增一次 revision、写入完整下一 state 与事件；模拟 execute/commit 故障时旧 state/revision 完整保留；并发相同 expectedRevision 时仅一个成功。
- 持久化层不认识 `PlayerIntent` 规则语义，只接收 resolver 已产出的 state/events 数据；它不投影 UI/read model。

## Task 4：performAction application use case 与 API

- 新建 `performAction`：读取当前游戏；无存档/损坏/基础设施失败均映射稳定结果；检查 gameId 与 expectedRevision；调用 actions facade；有效结果经原子 repository 写入后从已保存 state 投影最新 `OpeningGameView` 与反馈。
- application 注入时钟/事件 ID 等外部依赖以保证测试可重复；不读取 `process.env`、路径、libsql 或 AI 环境。
- production composition root 暴露 `performAction`，但浏览器无权指定 seed、时钟、gameId provider 或数据库路径。
- `POST /api/game/actions` 仅接受明确字段，拒绝未知字段、freeText、state、seed、蓝图、修改后的 action label；映射 malformed/validation/rejected/stale/no-active/corrupt/infrastructure 到稳定 HTTP 与安全 body。
- API 测试验证 action 成功、所有拒绝无写入、陈旧 revision、非法 JSON/越权字段、无存档、损坏存档以及不泄漏 SQL/state/seed。

## Task 5：固定行动 UI、恢复和边界

- `CurrentGameScreen` 在 active 状态渲染 `SceneActionPanel`；面板只消费 `OpeningGameView.availableActions`，禁用提交中的所有按钮，以 `aria-live` 提示结果。
- 成功后用 API 返回的最新 view 替换本地 view；规则拒绝显示具体但不伪造成功；版本冲突后重新请求 current-game 并显示“状态已更新，请重试”。
- 显示已发现事实；不显示未发现事实、不可用的未来移动/任务/战斗按钮，也不提供自由文本输入框。
- 保持键盘可用和现有主题；不新增 shared UI 导出。
- UI/API/边界测试验证真实闭环：创建 → action → 刷新 → 新 revision 与已发现/已见状态仍在；重复点击和 stale request 不会双写；客户端 bundle 不含 SQLite、fallback 生成器、actions 内部实现或 AI 环境变量。

## Task 6：回归与文档

- 更新 `docs/agent/行动裁决.md` 为真实实现、`当前开发阶段.md`、`current-phase.json`、`MVP核心闭环.md`、`Agent文档索引.md`；玩法规则变化只更新 `docs/策划文档/`，不在其中写实现路径。
- 更新 `dependencyBoundaries.test.ts`，守住 domain / actions / application / server / API / UI 的双向边界。
- 完成后将 `current-phase.json` 更新为 `completed / implemented`，但不自动建立或切换 Phase 4。

## 提交拆分

1. `feat: define RPG action intents and deterministic resolver`
2. `feat: persist resolved RPG actions with revisions`
3. `feat: expose saved scene actions through application and API`
4. `feat: render deterministic scene action loop`
5. `test: guard Phase 3 action and persistence boundaries`
6. `docs: record Phase 3 implementation`

## 验收命令

```powershell
npm run lint
npm test
npm run test:fast
npm run build
npm run phase:status
```

完成时还必须：

- 用真实临时 SQLite v1 文件证明一次、幂等的 v2 migration；
- 用真实临时 SQLite 证明两个相同 revision 的并发提交只有一个成功；
- 证明拒绝/冲突/事务故障没有新增事件、没有 revision 递增、没有部分 state；
- 创建一个 fallback 世界，执行 talk 与 investigate，刷新后仍显示 NPC 已见、事实已发现和递增 revision；
- `git diff --check` 通过，`db/`、`tmp/`、日志和 `.env.local` 未进入 Git；
- `npm run handoff:check` 仅在实现前由 `phase:start` 使用；完成后以 `phase:status` 确认 completed 状态。

## 完成定义

- 当前开场不再是只读页面：玩家可在固定选项内执行至少观察、交谈和调查；
- 状态改变只来自纯 resolver，数据库操作不能绕过它；
- 所有成功行动都可恢复，重复/陈旧/非法行动不会改写或损坏存档；
- UI 只消费 read model 与 API，SQLite、完整蓝图和内部状态不进入客户端；
- 没有 AI、自由文本、移动、任务或战斗范围混入；
- 新 Agent 可仅据根 AGENTS、当前阶段文档、行动裁决文档和本 Plan 启动、实现、验证 Phase 3。
