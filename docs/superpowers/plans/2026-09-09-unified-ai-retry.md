# Unified AI Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 所有可达 AI 重试使用统一错误转换、反馈结构、审计格式，消除丢失原因与错误分类。

**Architecture:** transport 继续只处理网络协议。application 的 aiGenerationRetry 提供 source failure、repair、prompt envelope 和 audit helper；各系统只提供拒绝码和业务修复说明。保持现有预算与玩家错误分类。

**Tech Stack:** TypeScript、Vitest。

## Global Constraints

- 只在 opening-context 工作，不修改 foundation 或共享规范副本。
- 不产生额外生产调用，不写用户存档；不把异常原文作为反馈原因。
- 内容修复保留在上下文必选块，继续计入预算。

### Task 1: 统一反馈并覆盖所有调用

**Files:** `src/game/application/aiGenerationRetry.ts` 及同目录测试；opening、bundle、scene、world、intent 的 source、编排和 prompt。

**Interfaces:** `createAiSourceFailure(phase, category, repairReason?, repairDetail?)`；`repairFromSourceFailure(result, attempt)`；`aiRepairAuditContext(repair, previous?)`；`renderAiRepairFeedback(repair)`。

- [x] 单测覆盖每个角色的 schema detail、provider failure 分类、多轮 attempt、manual origin 与 approval code。
- [x] source 采用共享失败构造器；prompt 采用统一反馈包裹，保留业务针对性提示。
- [x] 开局所有重试分支传入原因；bundle 不再把网络错误当 invalid_json，持久化稳定原因供手动重试使用。
- [x] 运行 application、domain、边界、类型、文档检查；核对传输请求正文不因网络重试改变，内容修复正文含上一原因。

## 检查范围

- RpgAiClient.complete：统一处理五个 role 的 transport retries，已有上一稳定失败码。
- openingGenerationSource：旧候选入口无内容重试，只有 client transport retries。
- initialization bundle：原先仅传递 source repair，candidate/审批/novelty 拒绝不完整。
- decision bundle：source 缺失原因被写成 invalid_json；attempt 固定 1；手动重试未消费 retryContext。
- intent：内容重试有粗原因，单独拼 prompt。
- scene：自动与手动有原因，单独构造失败和审计。
- world：JSON/schema/引用/审批有原因，独立 approvalCode 和审计拼接。

## 验收证据

- 全量回归 2578 项通过，1 项真实 AI 测试按门禁跳过；JSON 报告位于忽略的 logs/unified-retry-full.json。
- 最后补充的持久化原因过滤及定向回归通过，报告位于 logs/unified-retry-final.json。
- typecheck、124 项依赖边界、修改文件 ESLint、check:docs 和 diff --check 通过。
- 五种 role 的 transport 回归确认请求 messages 不变、审计携带上一失败码；生成包回归确认自动 attempt 递增、失败分类保留、同 job 手动重试消费已保存原因。
- 未调用真实 provider，未修改用户存档，未提交或合并。

