# 中篇 Chrome 完整真机测试与界面修复 Implementation Plan

> Status: Completed on 2026-08-12. Chrome medium journeys reached structured endings; fixes, regression tests, documentation, and final build gates passed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Chrome 真机中从新建一局中篇游戏开始，覆盖完整可玩流程与所有玩家动作模块直到结构化结局；对测试中发现的阻断、交互不合理和不符合 RPG 表现的界面问题补充回归测试、修复并继续同一流程。

**Architecture:** 保持现有 `GameSessionView`、opaque choice token、单一 `/api/game/actions` 与规则/存档边界不变。浏览器测试负责观察真实状态与视觉层级；修复只落在组件及主题 CSS，若发现权威事实缺失才沿现有 application read model 链路补齐。战斗展示由 `LocationSceneScreen` 消费现有 battle view，使用客户端展示状态表达攻击动画、伤害飘字和回合反馈，不把动画结果写入游戏状态。

**Tech Stack:** Next.js 16、React 19、TypeScript、Vitest、Testing Library、Chrome 真机控制、现有 RPG 主题 CSS。

## Global Constraints

- 正式产品时长只使用短篇/中篇；本次必须新建中篇游戏。
- 不改变 canonical 六个 `/api/game/**` route、opaque choice token、一次规则 CAS、独立 scene CAS 或存档格式。
- UI 只能消费 `GameSessionView` 与服务端批准的 choice token；不从文案推导 Action，不在组件中裁决战斗、任务或结局。
- 战斗视觉固定为己方左侧、敌方右侧、按回合行动；动画与飘字仅为展示层状态，必须在刷新/回合结束后安全重置。
- 闲聊、固定对话、自由输入、给予道具、探索/调查、拾取、移动、战斗与结局都必须有可达的 Chrome 证据。
- 发现缺陷时先记录复现状态与截图/可见证据，再写最小回归测试、修复并回到原游戏继续跑流程。
- 不修改受保护的 `.foundation` junction 或 sibling foundation 仓库；保留工作区已有未提交修改。

---

### Task 1: 建立 Chrome 中篇新局基线与覆盖清单

**Files:**
- Inspect: `src/components/CurrentGameScreen.tsx`
- Inspect: `src/components/NewGameSetupForm.tsx`
- Inspect: `src/components/AdventureGameShell.tsx`
- Inspect: `src/components/LocationSceneScreen.tsx`
- Test evidence: Chrome local development page
- Create if needed: `docs/中篇真机测试记录-2026-08-12.md`

**Interfaces:**
- Consumes: 新游戏表单、`GameSessionView`、六个现有游戏 API。
- Produces: 一局新的中篇存档、逐回合覆盖表和每个问题的可复现证据。

- [ ] **Step 1: 启动开发服务器并确认入口可达**

  Run: `npm run dev`

  Expected: 本地开发页返回 200；如果已有 current slot，只通过游戏内开发工具的二次确认清除当前试玩存档。

- [ ] **Step 2: 在 Chrome 新建中篇游戏**

  输入完整角色、身份、角色基础信息、世界观背景、故事开端；选择一个题材、叙事风格和“中篇”，提交后确认序幕、开始冒险和首场景生成反馈均可见。

- [ ] **Step 3: 建立覆盖矩阵并按当前可用动作推进**

  逐次记录回合、地点/城镇/建筑层、当前目标、按钮标签、可见状态和是否产生下一场景；至少完成固定对话、自由输入、闲聊本地回复、给予道具（有背包物品时）、探索、调查、拾取、地图移动、城镇建筑进入、战斗攻击/回合推进、日志/背包/任务/角色面板和结局。

- [ ] **Step 4: 为每个缺陷留存最小证据**

  记录“操作前状态 → 操作 → 实际表现 → 期望表现”，并保留 Chrome 可见文本/布局或截图；阻断问题优先处理，非阻断视觉问题按系统归类。

### Task 2: 修复战斗视窗的阵营布局、回合反馈与动效

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/AdventureGameShell.test.tsx`
- Test: `src/components/LocationSceneScreen.test.tsx` (create if component test split is required)

**Interfaces:**
- Consumes: `view.battle.enemyName`, `enemyHp`, `round`, `controls`、`view.player.name`, `view.player.hp` 与现有 action feedback/busy 状态。
- Produces: 可访问且明确的左己方/右敌方战斗视窗；玩家攻击后显示动作状态、伤害/结果飘字与短暂攻击位移；敌方回合结果有独立反馈；所有动画不影响 opaque token 提交。

- [ ] **Step 1: 为战斗布局和反馈写失败回归测试**

  渲染 active battle，断言己方战斗单位出现在 DOM 先于敌方或具有明确 `data-side="player"`，敌方具有 `data-side="enemy"`；断言战斗区出现“己方”“敌方”、回合号、双方 HP 和 battle control。用 action outcome 更新模拟回合变化，断言至少一个可访问的 `role="status"` 反馈节点存在。

- [ ] **Step 2: 在 Chrome 复现当前战斗布局与提交体验**

  通过真实流程进入战斗，确认桌面布局己方在左、敌方在右，连续攻击时按钮是否重复提交、战斗日志是否遮挡操作、回合切换是否可感知；在证据中标出真实缺陷。

- [ ] **Step 3: 调整战斗语义结构和布局**

  将战斗结构改为固定的 player-left / enemy-right 两个 combatant 区块，增加阵营标签与 HP meter 语义；保留服务端 controls 及现有 `renderChoiceButton`，不新增规则 Action。

- [ ] **Step 4: 添加展示层攻击反馈**

  基于提交前后的 battle 快照保存短暂 `battleFx`，在玩家 action 提交时让己方视觉向右移动、目标方向出现“攻击”状态；当 HP 下降或回合结果返回时显示“−N HP”或服务端安全可用的结果短文案；用 `aria-live` 同步回合与结果，并在 `prefers-reduced-motion` 下关闭位移只保留状态变化。

- [ ] **Step 5: 调整响应式层级并运行战斗定向测试**

  确保移动端不把战斗单位、日志和 controls 挤出视口；运行 `npm run test:components -- src/components/AdventureGameShell.test.tsx` 和对应 LocationScene 测试，确认通过。

### Task 3: 修复全流程中发现的非战斗交互与 RPG 表现问题

**Files:**
- Modify only as evidenced: `src/components/LocationSceneScreen.tsx`, `src/components/AdventureGameShell.tsx`, `src/components/CurrentGameScreen.tsx`, `src/components/TownLayerScreen.tsx`, `src/components/town/TownMapSvg.tsx`, `src/components/AdventureDetailsPanel.tsx`, `src/components/NewGameSetupForm.tsx`, `src/components/WorldMapScreen.tsx`, `src/app/globals.css`
- Test: the component test matching each reproduced defect
- Modify: `docs/短篇真机测试汇总-2026-08-12.md` only if the same shared UI fix affects its recorded facts

**Interfaces:**
- Consumes: existing read-model states for pending, error, scene, town, dialogue, small talk, items, inventory, quests, journal and ending.
- Produces: no fake buttons, no hidden/covered required actions, clear pending/error/retry/return paths, and game-like cards/overlays where a raw form or ambiguous control was observed.

- [ ] **Step 1: 按覆盖矩阵逐项验证非战斗动作**

  确认对话两个固定选项和一个自由输入共享 action path；闲聊不产生回合且回复可见；给予道具只出现合法物品；探索/调查/拾取/移动各自有明确反馈；地图→小镇→建筑→场景和返回路径不丢失焦点；四个信息面板可打开、关闭、Esc 返回且不遮挡错误反馈。

- [ ] **Step 2: 对每个实际缺陷补玩家行为测试**

  测试只断言可见文本、可点击性、disabled/role/aria-live、导航层级和提交次数；不断言 CSS 私有实现或服务端内部 ID。

- [ ] **Step 3: 实现最小 UI 修复**

  优先在现有组件与 CSS 中调整布局、文案和状态；若“表单感”来自把选择渲染为普通输入，则改为语义化 RPG 选项/卡片/行动条，但继续提交现有 choice token；若是规则缺口，停止在 UI 打补丁并沿 application/gameplay 端口修复。

- [ ] **Step 4: 修复后回到 Chrome 原中篇存档继续**

  热更新/刷新后从当前回合继续，不为了非阻断问题重置进度；每个问题修复后至少重做一次原操作并更新覆盖矩阵。

### Task 4: 完成结局、跨刷新复验并同步实现事实

**Files:**
- Modify: `docs/中篇真机测试记录-2026-08-12.md`
- Modify if facts changed: `docs/agent/地图与地点冒险.md`, `docs/agent/战斗与结局.md`, `docs/Agent文档索引.md`
- Verify: all files changed in Tasks 2–3

**Interfaces:**
- Consumes: 修复后的 Chrome 中篇存档与结构化 `view.ending`。
- Produces: 结局可见、普通行动终止、刷新恢复结局，以及可复查的覆盖与已知限制记录。

- [ ] **Step 1: 继续同一中篇流程到结局**

  完成剩余幕链，直到出现结构化结局名称、描述和 outcome；确认战斗胜负分支、任务状态与当前目标收束一致，结局界面不再展示普通行动。

- [ ] **Step 2: 刷新 Chrome 验证结局持久化**

  刷新页面后确认仍显示同一结局；若刷新恢复失败，先记录证据并修复 current-game/组件恢复路径，再重复刷新。

- [ ] **Step 3: 同步实现文档与测试记录**

  在真机记录中写明环境、输入、覆盖矩阵、修复项、最终回合数和已知非阻断问题；只有当生产实现事实变化时更新对应 `docs/agent/` 与索引，不把一次性视觉观察写成规则事实。

### Task 5: 运行分层门禁并做最终 Chrome 复验

**Files:**
- Verify: all modified source/test/docs files

**Interfaces:**
- Consumes: completed implementation and the recorded medium-length browser journey.
- Produces: passing test/build evidence and a concise handoff.

- [ ] **Step 1: 运行组件、应用与边界检查**

  Run: `npm run test:components`; `npm run test:app`; `npm run typecheck`; `npm run test:boundaries`.

  Expected: all pass.

- [ ] **Step 2: 运行变更感知测试和生产构建**

  Run: `npm run test:changed`; `npm run build`.

  Expected: all pass;若既有无关测试失败，记录精确命令与失败摘要，不修改无关模块。

- [ ] **Step 3: 在 Chrome 做最终关键路径抽查**

  抽查新建中篇、序幕、地图/小镇/建筑、固定对话、自由输入、闲聊、物品、战斗左右阵营/回合动效、四个面板、结局和刷新恢复；确认没有关键操作被裁切或仍以裸表单呈现。

- [ ] **Step 4: 完成计划自检并交付**

  核对用户六项要求都有浏览器证据、代码或测试对应项；在最终回复中说明完成的修复、测试命令和若仍存在的非阻断限制。
