# 中篇 Chrome 真机完整续测与剧情质量修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Chrome 中从全新中篇游戏开始，完整跑通主线并记录所有玩家可见剧情、对白、选项、任务与结局；按阻断优先策略修复问题并完成回归。

**Architecture:** 测试只通过真实 UI 和现有六个游戏 API 观察权威 `GameSessionView`；不绕过 opaque choice token 或规则层。测试证据以一份按回合排列的中文记录保存，代码修复只沿现有组件/application/gameplay 边界进行。

**Tech Stack:** Next.js 16、React 19、TypeScript、Vitest、Chrome 真机控制、现有 RPG 主题 CSS。

## Global Constraints

- 测试地点固定为 `.worktrees/real-browser-playtest`，不修改 `.foundation` 或 sibling 仓库。
- 必须新建一局中篇游戏；不得沿用旧 current slot 作为本次主证据。
- 阻断问题立即记录、修复、验证后继续同一流程；非阻断问题先记录，主流程完成后统一修复再回归。
- 每个焦点 NPC 场景检查恰好两个语义不同的固定选择和一个自由输入；固定选择需覆盖玩家口吻对白与非对白动作两类表达。
- 记录剧情因果链：玩家行为、NPC 多轮回应、任务目标、地点/物品/战斗推进、幕交接与结局；不能只记录内部 action ID。

### Task 1: 建立测试基线与证据文件

**Files:**
- Create: `docs/真机测试/2026-08-13-中篇Chrome完整剧情记录.md`
- Inspect: `src/components/NewGameSetupForm.tsx`, `src/components/AdventureGameShell.tsx`, `src/components/LocationSceneScreen.tsx`

- [ ] **Step 1: 启动 worktree 的开发服务器并记录地址、浏览器视口与 commit。**
- [ ] **Step 2: 使用开发工具清除当前槽位，只在 Chrome 中填写角色、背景、故事开端并选择“中篇”新建游戏。**
- [ ] **Step 3: 在证据文件中记录开局世界、地点、玩家、NPC、初始任务、序幕和第一场景的完整可见文案。**
- [ ] **Step 4: 建立覆盖表，列出固定对白、自由输入、闲聊、探索、调查、拾取、移动、城镇/建筑、物品、任务、战斗、信息面板、刷新和结局。**

### Task 2: 通过 Chrome 完成中篇主线并按回合记录剧情

**Files:**
- Modify: `docs/真机测试/2026-08-13-中篇Chrome完整剧情记录.md`
- Evidence: `artifacts/playtest/2026-08-13/`

- [ ] **Step 1: 每个回合记录操作前目标、场景旁白、NPC 名称/角色、两项选择、自由输入入口和提交后的直接回应。**
- [ ] **Step 2: 优先选择能继续主线的一项固定选项，至少在两个焦点 NPC 上提交一次玩家口吻自由输入，并观察下一场景是否承接原话。**
- [ ] **Step 3: 在可达时分别验证非对白动作型选项、闲聊、探索/调查/拾取/移动、城镇建筑、背包/任务/日志/角色面板和战斗。**
- [ ] **Step 4: 在序幕后、对白后、物品后、战斗后和结局前刷新 Chrome，确认目标、地点、物品、对话焦点、战斗或结局恢复一致。**
- [ ] **Step 5: 继续到结构化中篇结局，记录幕数、任务闭环、关系/选择造成的分支、结局名称/描述和结局后操作状态。**

### Task 3: 分级缺陷并处理阻断项

**Files:**
- Modify: `docs/真机测试/2026-08-13-中篇Chrome完整剧情记录.md`
- Modify: only the reproduced owner files under `src/`
- Test: adjacent tests for each changed owner module

- [ ] **Step 1: 对每个问题记录复现状态、实际表现、期望表现、严重级别、截图和可能 owner。**
- [ ] **Step 2: 对阻断项先补最小回归测试并修复，回到原回合重新操作，确认流程继续。**
- [ ] **Step 3: 将非阻断项保留在清单中，不在主流程中途打断剧情记录。**
- [ ] **Step 4: 对对白质量重点检查：是否只有一句无对象确认、是否缺少多轮承接、是否把动作包装混进 NPC 台词、固定选项是否只有同一种回答类型、任务描述是否支持玩家理解下一步。**

### Task 4: 主流程结束后统一修复非阻断剧情与交互问题

**Files:**
- Modify: reproduced files among `src/components/`, `src/game/domain/`, `src/game/application/`, `src/game/gameplay/rpg/`
- Modify: `docs/真机测试/2026-08-13-中篇Chrome完整剧情记录.md`
- Test: adjacent unit/component/application tests

- [ ] **Step 1: 按影响排序处理记录中的非阻断项，优先修复对白承接、选项语义、任务目标可理解性和场景/焦点同步。**
- [ ] **Step 2: 保持 NPC 直接台词、opaque token、单一 actions route、一次规则 CAS 与独立 scene CAS 不变。**
- [ ] **Step 3: 修复后运行对应测试，并在 Chrome 中重做原操作；若状态已不可复用，创建第二局最小回归局验证同一场景。**
- [ ] **Step 4: 更新记录中的问题状态、修复说明和回归证据。**

### Task 5: 运行门禁并完成剧情质量评估

**Files:**
- Modify: `docs/真机测试/2026-08-13-中篇Chrome完整剧情记录.md`
- Modify gameplay facts only when the observed behavior changes the documented contract: `docs/策划文档/`, `docs/agent/`, `docs/Agent文档索引.md`

- [ ] **Step 1: 运行与改动相关的组件、application、gameplay、typecheck、boundaries、build 测试，并记录结果。**
- [ ] **Step 2: 在中文记录中按“结构、悬念、因果、对白、选项、任务、旁白/环境描述、结局”评估 1–5 分，给出具体证据，不用一句总评代替。**
- [ ] **Step 3: 汇总阻断项、已修复项、残留非阻断项和复现步骤，确认全部剧情文案与关键截图已落盘。**
- [ ] **Step 4: 运行 `git diff --check`、核对 worktree 状态，并在最终交付中说明完整流程回合数、结局与剩余风险。**

## Self-Review

- [x] 覆盖新建中篇、完整主线、NPC 多轮对白、两类选项、动作模块、刷新、战斗、结局和最终质量评估。
- [x] 明确区分阻断即时修复与非阻断延后修复，并要求各自回归证据。
- [x] 未引入新路由、平行规则链或绕过服务端批准选择的测试方式。
