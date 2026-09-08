# 渐进式文档与维护门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. 本任务按用户授权由子代理整理文档，主代理复核。

**Goal:** 当前事实按职责单点维护，Agent 按任务渐进阅读，文档结构通过本地门禁保护。

**Architecture:** AGENTS 负责路由和硬约束，索引只导航，系统文档维护现状。current-phase.json 是阶段状态唯一来源；历史资料退出当前阅读链。Node 检查器验证当前文档引用、索引覆盖和阶段入口，提示历史标题与重复长段落。

**Tech Stack:** Markdown、JSON、Node.js 内置 test runner、现有 npm 门禁。

**Spec:** 本任务对话中用户确认的文档优化与防退化方案。

## Global Constraints

- 仅修改 ai-rpg-game；不改变游戏行为、共享 package、foundation 或共同规范副本。
- 当前文档只陈述现状；不以日期补充、修复批次或上一阶段段落替代正文重写。
- 保留 junction/worktree 安全约束；不启动或改变 Plan 5 实施状态。
- 代码和现有测试是实现事实证据；历史测试成绩不能当作当前验收。

### Task 1: 入口、规则与历史隔离

**Files:** AGENTS.md、README.md、docs/Agent文档索引.md、docs/游戏开发规范.md、docs/agent/README.md、template.md、当前开发阶段.md、current-phase.json、项目脚手架.md、docs/archive/。

- [x] 精简路由与维护归属；当前阶段仅链接 JSON 与执行资料。
- [x] 将退役评估、Demo 与闲聊历史移入 archive，修复当前入口。
- [x] 检查 README 命令与 package.json；保留分层和安全规则。

### Task 2: 当前系统与策划事实

**Files:** docs/agent/ 内玩法、UI、状态、AI 系统文档；docs/游戏设计原则.md；docs/策划文档/。

- [x] 分组读取现状并核实关键源代码与测试入口。
- [x] 替换全文为当前契约，删除历史流水，合并闲聊与对话文档。
- [x] 运行时、记忆、NPC、世界与 UI 各自维护职责内事实，通过链接追加阅读。

### Task 3: 文档自动检查

**Files:** scripts/checkDocs.mjs、scripts/checkDocs.node-test.mjs、package.json。

- [x] 使用临时仓库测试坏链接、退役索引目标、阶段入口失效、当前文档覆盖、历史标题提醒及合法链接。
- [x] 实现纯检查 API 与 CLI；只扫描当前文档，不要求修复历史记录。
- [x] 将 check:docs 与 test:docs 接入 test:fast，并由 accept 间接执行。

### Task 4: 集成复核

- [x] 主代理逐组审阅事实与职责，校验当前文档没有补丁式段落。
- [x] 运行文档测试、check:docs、交接文档检查、typecheck、边界与快速门禁。
- [x] 核对 Git diff、共享副本未修改、阶段状态未改变，报告结果。

实施与复核证据见 [验收报告](../reports/2026-09-08-progressive-documentation.md)。
