# Narrative P2 Readiness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 `a1109902` 的 P2 准入核查缺口，使记忆与恢复契约真实贯通，并提供可执行、可严格回放的完整故事验收驱动。

**Architecture:** 保留整场作者、单 NPC 判断、现有审批和规则 A/B 提交；补现有 observer 检索、派生摘要及固定包。验收复用正式 application/SQLite/provider transport 入口，不用结果标记或手填 History 代替旅程。

**Tech Stack:** TypeScript 5.8、Vitest 3、Node.js ≥24.15.0 SQLite、现有 RPG transport 和回放接口。

## Global Constraints

- 原 [P2 Plan](2026-09-14-narrative-architecture-p2.md) 是功能与验收范围；本页只组织已确认缺口的修复，不新开架构阶段。
- 继续 `codex/narrative-architecture` / `.worktrees/narrative-architecture`，不动 main、旧 staged、`.foundation` 或 `current-phase.json`。
- EntityStore3 / World7 / Story12 保持；原文不因摘要删除。候选修订与接管使用同一 job/epoch 固定记忆；已结算 A 不重跑。
- 本轮执行代码与离线检查，不启动真实 API。live 能力必须有显式门禁，实际质量由后续冻结实跑证明。
- 按独立模块分工，所有公共接口变更及时协调；不并发修改相同文件。最终由主智能体统一验证生产装配与全量门禁。

---

## Task 1：完整记忆选择、事件去重与当前输入保护

**Files:** `src/game/application/prepareNarrativeMemory.ts`；`src/game/gameplay/rpg/narrativeMemory/{buildNarrativeMemoryContext,retrieveStoryEvidence,planMemorySummary}.ts` 及其测试；必要 memory domain 类型、作者/NPC 记忆渲染文件。

**Interfaces:** 保留 `prepareNarrativeMemory` 的 policy/source/repository/observer/job 输入及显式 overflow/cancel 结果。prepared packet 消费一次 `retrieveStoryEvidence(EvidenceQuery)` 的实际选择；overview/uncovered 既有引用作为软查询来源，action/Thread/精确追问保留 mandatory。

- [x] 将核查反例转成持久回归：两个 mandatory Event、概览地点省略旧话、九条旧原文加一条当前输入；先运行对应测试确认失败。
- [x] 按事件 ID 去重，按 observer 贯通概览→实体/事件引用→一次旧事检索；完整未覆盖原文必须保留，展示端跨原文/概览/召回去重。
- [x] 用当前 job/action 排除正在响应的原文，50/10 与长度提前压缩共用同一候选边界；叶事件源按实际关联引用而非比较两种 sequence。
- [x] 验收真实作者/NPC 渲染的原话、事件内容和权限，不只检查 ID：

```ts
expect(packet.requiredEvents.map(event => event.eventId)).toEqual([firstEventId, secondEventId]);
expect(packet.recalled.map(entry => entry.id)).toContain(omittedQuoteId);
expect(summarySourceHistoryIds).not.toContain(currentJobHistoryId);
```

三个 ID 均取同一测试实际来源。运行 memory、preparation、作者/NPC 请求测试。

## Task 2：缓存和固定包的真实来源校验

**Files:** `src/game/application/narrativeMemorySourceFingerprint.ts`、`narrativeMemorySummaryRepository.ts`；`src/game/application/server/persistence/sqliteNarrativeMemorySummaryRepository.ts`、必要 SQLite schema/cleanup 及测试。

**Interfaces:** 原 summary `load/publish` 和 attempt `loadPrepared/freezePrepared/reserve*` 端口保持职责；共享源指纹函数同时供生产装配与 SQLite 校验使用，避免两个算法。读固定包需校验真实 job/observer/来源，不只验证保存 JSON 的哈希。

- [x] 先复现覆盖来源变化仍返回旧缓存；补同 epoch 来源变化、权限变化、尾追加、回滚降水位、租约接管的真实 SQLite 测试。
- [x] 分开摘要稳定来源前缀与 job 完整输入指纹；History 与 Event 独立游标。摘要失效返回 miss 并保留真实 revision；失效缓存允许旧 revision CAS 重建较短来源。
- [x] load/freeze 校验固定包结构、来源、observer 与策略；无效包明确失败，不能重建后继续已有候选。预留在同库事务校验 generation/pending/job/epoch/lease/time。
- [x] 不以 external repository 为由关闭源或租约校验；实际生产/验收仓储必须共用数据库契约。运行 SQLite 与恢复测试。

## Task 3：生产装配的失败分流、预算与恢复

**Files:** `src/game/application/generatePendingNarrativeBundle.ts`、`src/game/application/server/compositionRoot.ts`、`src/game/application/prepareNpcNarrativeContext.ts`、必要独立 preparation adapter/测试、AI 最终输入预算/审计入口。

**Interfaces:** `prepareMemoryPackage` 由 generator 提供可读取当前 durableRecord 的租约条件与取消控制；server 准备只用共用 `selectNpcDeliberationTarget`。端口结构化失败适配为 provider boolean 时必须保留原因：

```ts
if (reservation.ok) return true;
if (reservation.code === "BUDGET_EXHAUSTED") return false;
abortAttempt(reservation.code);
return false;
```

`abortAttempt` 为该次尝试的局部取消函数；只接受稳定错误码，不能把原文写入失败原因。

- [x] 将预留三类结果、租约接管与固定包恢复、真实作者/NPC 不串包分别落实到 generator、真实 SQLite 和完整旅程的回归；不把分层测试宣称为所有崩溃时点的组合实测。
- [x] 每次发送/冻结使用当前 guard 与时钟；冻结成功后才预留候选，已有包直接恢复。NPC/作者/reviewer/summary 的实际输入均遵循冻结长度政策。
- [x] 取消和不可用不得走成功原文路径；摘要单纯额度耗尽/选编失败仍读完整来源，超长明确失败；A 不重复提交。
- [x] 接入来源/覆盖/固定包审计元数据，保护普通日志不含私密原文；运行 generator、composition、request、NPC 和审计测试。

## Task 4：完整故事执行、严格回放与最终准入

**Files:** `scripts/narrativeP2Journey.mjs`、对应 node 测试；`src/game/application/testing/narrativeP2Journey.ts`、测试与 testutil；必要 P1 helper 抽取及 package scripts。系统文档和原 P2 gate 仅依据实际证据更新。

**Interfaces:** `runNarrativeP2Journey({mode,runId,protocolPath,outputDirectory,replaySource?})` 使用唯一协议构造；register 零网络冻结实际配置，live 经正式 API，replay 通过真实请求匹配与状态校验判定，不能读取 completed 冒充通过。

- [x] 先以伪造 completed、改动 prompt/响应/状态、缺磁带为拒绝用例，补 driver 测试。
- [x] 复用现有 P1 production route/transport/identity/time helper，实现原 P2 的 S-short / M-medium 预算、追问条件、摘要开关诊断、reload 和产物；不改 P1 协议语义。
- [x] 离线五幕 source 经正式创建/行动/ensure/SQLite 达成至少70条有效原文、两次摘要、长间隔追问、合法交付和终局；不注入历史或结局。严格 replay 必须响应全部消费且正式状态、缓存及固定包匹配。
- [x] 两臂使用同一 ready 状态及同一追问，每臂最多一个 job；生成 UI checkpoint/操作 manifest 并标记未执行，后续真实 UI 事件必须接登记协议。断言：

```ts
expect(result.completed).toBe(true);
expect(result.publishedSummaryRevisions).toBeGreaterThanOrEqual(2);
expect(result.oldQuoteInActualAuthorRequest).toBe(true);
expect(result.oldQuoteLeakedToUninformedNpc).toBe(false);
expect(result.itemGivenEventCount).toBe(1);
```

字段由实际旅程产生，不能用预置布尔值。
- [x] 完成 typecheck、lint、boundaries、完整 Vitest、相关脚本、check:docs 与 build；记录离线与未实跑边界，逐项复核 R1–R6。限定文件提交，不合并或启动真实 API。

## 执行结果

修复实现与分层测试证据见 [准入修复验收](../reports/2026-09-14-narrative-p2-readiness-fixes.md)。R1–R6 已闭环，独立复核发现的 reviewer 记忆审计漏传也已修复并有完整旅程断言。API 质量验收仍由原 P2 Task 7 单独执行；不以 UI checkpoint 或离线模型响应替代实跑。
