# Opening Schema Retry Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复初始化字段说明不完整及重试丢失拒绝原因的问题。

**Architecture:** 保留严格 parser 和关系规则，通过现有 source repair 契约把稳定错误送回下一次 opening prompt。调查方式明确对象字段，避免字符串数组。

**Tech Stack:** TypeScript、Vitest。

## Global Constraints

- 只修改 opening-context worktree；不修改共享副本、用户存档或原始日志。
- 保持初始化最多三次调用和原子写入，不补造规则数值或剧情。

### Task 1: Prompt 与修复反馈闭环

**Files:** `src/game/application/narrativeBundleSource.ts`、`createGame.ts`、`server/ai/liveNarrativeBundleSource.ts`、`server/ai/openingNarrativePrompt.ts` 及同目录测试。

**Interfaces:** opening context 增加 `contentRepair?: NarrativeBundleRepair`；沿用 source 的 `repairReason`、`repairDetail`。

- [x] 在 createGame 测试模拟首次失败 `repairReason: "invalid_schema", repairDetail: "opening_INVALID_FACT"`，断言下一次 context.contentRepair 包含相同 detail，且第二次成功才写入。
- [x] 在 source 测试输入字符串调查方式及 stranger/wary，断言失败保留 repairDetail；prompt 测试断言实际下一次消息包含该错误。
- [x] 运行 `npx vitest run src/game/application/createGame.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/server/ai/openingNarrativePrompt.test.ts` 确认新增测试失败。
- [x] source 使用 `failBundle("invalid_schema", "invalid_schema", openingResult.reason)`；createGame 保存失败原因并传入下一次 context；prompt 输出该原因与完整 investigationApproaches 字段说明。
- [x] 运行 application 测试、typecheck、test:boundaries、check:docs 和 diff --check；在运行时系统文档说明初始化修复反馈。

## 诊断证据

审计 run `2026-09-09T02-10-56.319Z`：sequence 2、3、6、7、8 返回字符串 investigationApproaches，被 `opening_INVALID_FACT` 拒绝；sequence 4 的陌生人关系带 wary 和 history 依据，被 `invalid_response_reference` 拒绝。两次 HTTP 请求各三次完整尝试后返回 502；provider 全部正常完成。

## 验收证据

- 新增三项回归测试修复前失败；修复后 application 868 项通过，边界 124 项通过，typecheck 通过。
- 使用原审计 sequence 9 的玩家输入与生产 source，在独立 SQLite 完成真实初始化；run：opening-schema-smoke-1788921034580。仅一次 provider 调用，9617 ms，finishReason=stop，创建成功且可读取 active 存档。临时验证脚本已移除，审计及独立测试库保留于忽略的 logs 目录。
- 不提交、不合并、不修改玩家存档。

