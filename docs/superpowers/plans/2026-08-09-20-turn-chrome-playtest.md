# AI RPG Chrome 20 回合实机测试与修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用用户指定的 Chrome 从开局配置开始完成至少 20 个成功玩家回合，实机覆盖对白、剧情生成、选项、NPC、小镇、地图、物品给予/获得、战斗和当前目标引导，并把每个独立缺陷作为一个可验证的 Git 提交修复。

**Architecture:** 浏览器只走正式 `/api/game/**` 与 `GameSessionView`，服务器日志只用于核对请求、AI fallback、CAS 和安全错误分类。每个缺陷先在 Chrome 中保存可复现证据，再在所属 domain/gameplay/application/UI 层补回归测试和最小修复；修复后回到同一实机流程继续，不用自动化旅程替代浏览器验收。

**Tech Stack:** Chrome browser extension, Next.js 16, React 19, TypeScript 5.8, SQLite/libSQL, Vitest, `@ai-game/logging`

## Global Constraints

- 基线为 `d8a9c90`，分支为 `codex/real-playtest-20-turns`，worktree 为 `.worktrees/real-playtest-20-turns`。
- 不修改、删除、移动或重建 `.foundation` 与 `../ai-game-foundation`；本次只修改 `ai-rpg-game`。
- 正式试玩只使用短篇或中篇；开局必须填写并提交完整配置。
- 成功回合以 `/api/game/actions` 返回成功且权威 `turnNumber` 增加为准；纯地图/面板导航不计回合。
- 每个独立问题必须先复现、补最小回归、修复、运行相关测试和最低静态门禁，然后形成一个 Git 提交。
- 日志不得加入 prompt、模型原文、玩家原文、密钥、Authorization、cookie、完整存档或数据库连接字符串。
- 任何 AI 失败必须继续通过正式 proposal/approval/write-back 的确定性 fallback，不能绕过规则或中断主线可完成性。

---

### Task 1: 建立可复现的独立实测环境

**Files:**

- Verify: `.env.local`
- Verify: `.foundation`
- Verify: `package-lock.json`
- Runtime data: ignored SQLite game/log files inside the worktree

- [ ] **Step 1: 初始化 worktree 依赖与本地环境**

Run:

```text
npm run env:bootstrap
npm run bootstrap:foundation
npm ci
npm run doctor
npm run env:check
```

Expected: foundation 链接、依赖、RPG 自有 AI 配置和 SQLite 路径可用，命令不输出任何配置值。

- [ ] **Step 2: 运行基线门禁**

Run:

```text
npm run typecheck
npm run test:boundaries
npm run test:components
npm run test:app
```

Expected: PASS；若基线失败，先把每个独立失败修复并提交，再开始实机计回合。

- [ ] **Step 3: 启动开发服务器并确认日志健康**

Run:

```text
npm run dev
npm run logs:health
```

Expected: 首页可由 Chrome 打开，日志库健康，开发清档只删除当前游戏槽位。

---

### Task 2: Chrome 开局配置与世界生成验收

**Files under observation:**

- `src/components/NewGameSetupForm.tsx`
- `src/app/api/game/route.ts`
- `src/game/application/createGame.ts`
- `src/game/application/server/ai/worldGenerationSource.ts`
- `src/game/application/gameSessionView.ts`

- [ ] **Step 1: 清除旧试玩存档并刷新首页**

通过游戏内开发工具执行清档，确认回到唯一开局表单；刷新后仍没有旧局恢复。

- [ ] **Step 2: 完整填写并提交一局中篇配置**

在 Chrome 选择题材、角色名字、身份/职业、角色基础信息、世界观背景、故事开端、叙事风格和“中篇”，确认左侧预览与提交值一致，并只提交一次。

- [ ] **Step 3: 核对生成结果与服务端事实**

确认返回一局可恢复游戏，地图至少有当前位置和后续可解锁地点；日志显示开局生成的安全 outcome、耗时和 trace 关联。真实 AI 返回非法或失败时，确定性 fallback 仍须创建可完成世界。

- [ ] **Step 4: 验收序幕与当前目标引导**

确认序幕可读、确认操作可完成，HUD/任务面板显示当前目标，目标文案能指向玩家此刻可执行的地图、NPC、探索、物品或战斗入口。

---

### Task 3: 完成 20 个成功回合并维护覆盖账本

**Files under observation:**

- `src/components/AdventureGameShell.tsx`
- `src/components/WorldMapScreen.tsx`
- `src/components/LocationSceneScreen.tsx`
- `src/components/AdventureDetailsPanel.tsx`
- `src/game/application/performTurn.ts`
- `src/game/application/generatePendingScene.ts`
- `src/game/application/gameSessionView.ts`
- `src/game/gameplay/rpg/ruleEngine/`
- `src/game/gameplay/rpg/town/`

- [ ] **Step 1: 用权威回合号建立账本**

每次行动前记录当前 `turnNumber`、revision、当前位置、当前目标和可执行入口；行动成功后确认 `turnNumber + 1`、revision 前进、下一幕 pending 最终回到 ready。刷新恢复至少三次，恢复不另计回合。

- [ ] **Step 2: 覆盖对白、剧情和选择**

至少完成两个 NPC 固定对白选项和两个焦点 NPC 自定义输入；每次都生成下一幕，固定选项语义不同，自定义输入绑定当前焦点 NPC，关系/记忆或候选事件出现结构化变化。

- [ ] **Step 3: 覆盖地图、小镇与 NPC 生成**

从世界地图进入当前地点，移动到至少一个新地点；进入标记为 town 的地点后必须出现可操作的小镇层或等价的正式 town read model，并能从小镇进入剧情建筑/NPC 场景。新 NPC 必须有名称、角色和可交互入口，且不会泄露内部 ID/seed。

- [ ] **Step 4: 覆盖物品获得与给予**

通过服务器下发的合法选项获得一个地点物品，刷新后背包仍保留；再通过正式规则入口把一个已拥有物品给予合法 NPC，确认背包、NPC/任务状态和结构化事件原子更新，重复或无物品给予稳定拒绝且零写入。

- [ ] **Step 5: 覆盖探索、任务推进与当前目标**

完成探索或调查、地点访问、NPC 交谈、获得/给予物品等目标；每次状态改变后任务面板的完成标记和下一目标同步刷新，不能指向锁定、缺失或无按钮的能力。

- [ ] **Step 6: 覆盖战斗与结局前流程**

从合法敌人入口开始战斗，执行多个战斗回合直至胜负，核对双方 HP、round、战斗控制和任务结果。战斗期间不出现普通场景选择，stale/重复提交不能重复伤害或奖励。

- [ ] **Step 7: 达到至少 20 个成功玩家回合**

只有 `/api/game/actions` 成功并令权威 `turnNumber` 增加的操作才计数。第 20 回合后继续到当前剧情节点稳定 ready 或结局；最终账本必须明确列出每回合行动类别和上述模块首次覆盖回合。

---

### Task 4: 对每个实机缺陷执行单问题修复闭环

**Ownership routing:**

- 规则/状态事实：`src/game/domain/`、`src/game/gameplay/rpg/`
- 用例/read model/API：`src/game/application/`、`src/app/api/game/`
- 浏览器呈现/交互：`src/components/`
- 可观测性：`src/game/logging/` 与 composition root 注入点

- [ ] **Step 1: 固化复现证据并定位层级**

记录 Chrome 可见状态、触发操作、HTTP 结果、前后 revision/turn 和相关安全日志事件；用现有门面和依赖方向确定唯一归属层。

- [ ] **Step 2: 在改代码前把缺陷写成失败测试**

使用所属模块的同目录测试；跨层缺陷用最小的 application/component/route 组合测试。测试必须在修复前失败，并断言玩家可见结果与权威结构化状态，而不是只断言文案片段。

- [ ] **Step 3: 实现最小修复并更新实现事实文档**

只修改该缺陷所需路径；玩法事实变化更新 `docs/策划文档/`，实现事实变化更新对应 `docs/agent/` 和 `docs/Agent文档索引.md`。

- [ ] **Step 4: 运行相关测试与静态门禁**

Run the matching behavior suite plus:

```text
npm run typecheck
npm run test:boundaries
```

跨层或 UI/API 修改再运行 `npm run test:related -- <changed source files>`、`npm run test:components` 或 `npm run test:app`。

- [ ] **Step 5: 一个问题形成一个提交并回到 Chrome 复验**

提交只包含该问题的测试、实现和必要文档。Chrome 从可恢复存档继续；若规则 schema 变化必须重开，则在账本中标出作废局并从新局重新累计完整 20 回合。

---

### Task 5: 最终验收与证据汇总

**Files:**

- Update when implementation facts changed: `docs/agent/*.md`
- Update when player-visible rules changed: `docs/策划文档/*.md`
- Verify: `docs/Agent文档索引.md`

- [ ] **Step 1: 复核 Chrome 最终状态**

确认已完成至少 20 个成功回合，配置、对白、剧情生成、选项、NPC、小镇、地图、物品获得/给予、战斗和当前目标引导均有实际操作证据；页面无未处理错误或无限 pending。

- [ ] **Step 2: 查询失败日志与生成降级**

Run:

```text
npm run logs:query -- --event http_request_failed
npm run logs:query -- --limit 200
```

Expected: 没有未解释的请求失败、泄密字段、重复 CAS 副作用或永久 pending；所有 AI fallback 都有稳定分类且流程可继续。

- [ ] **Step 3: 运行完整验收**

Run:

```text
npm run check:standards
npm run typecheck
npm run lint
npm run test:boundaries
npm run test:fast
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
npm test
npm run test:foundation-journey
npm run journey:foundation
npm run build
npm run phase:status
```

- [ ] **Step 4: 审计提交边界**

确认每个实机缺陷各自只有一个专属修复提交，没有把多个不相关问题揉在一起；最终 worktree 干净，`.foundation` 未纳入版本控制。

---

## Self-Review

### Requirement coverage

- [x] 指定使用 Chrome 实机操作，而非仅跑自动化测试。
- [x] 从完整游戏配置开始，成功回合按权威状态计数且至少 20 个。
- [x] 对白、剧情生成、选项、NPC、小镇、地图、物品给予/获得、战斗和当前目标均有明确实测步骤。
- [x] 日志用于核对 AI/HTTP/CAS，缺日志时只能增加安全白名单日志。
- [x] 每个独立问题都要求失败测试、最小修复、相关门禁、单独提交和 Chrome 复验。
- [x] 刷新恢复、AI fallback、stale/重复请求与永久 pending 都纳入验收。

### Placeholder scan

- [x] 测试环境、浏览器动作、覆盖条件、缺陷闭环、命令和完成标准均已具体定义。
- [x] 未预设尚未由实机证据证明的代码缺陷或虚构修复文件。

### Completion rule

只有 Chrome 中完成至少 20 个成功玩家回合、全部指定基础模块均被实际操作、所有发现的问题均单独提交修复，且完整验收命令通过后，本计划才完成。
