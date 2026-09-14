# Narrative Architecture P2 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复独立 code review 发现的 P1 权限、来源一致性、并发恢复和输入预算缺陷，并用 TDD 补齐关键契约测试。

**Architecture:** 保持 Entity/Event/History 为唯一事实来源；observer 投影只授权经过事实权限校验的事件。摘要缓存和 attempt 预算在 SQLite 同一事务中完成条件校验与写入，生成器对已有候选只接受已冻结的固定记忆包。最终 provider 请求使用完整编译 prompt 的估算预算，而不是只估算记忆片段。

**Tech Stack:** TypeScript 5.8、Vitest 3、Node.js SQLite、现有 narrative context compiler 与 repository ports。

## Global Constraints

- 不修改 `.foundation`、公共 package 或 `docs/共同规范/`。
- 规则事实不可由摘要改写；原始 History 不因摘要删除。
- 所有 observer 原文必须按 speaker/audience/事实来源投影；公开 alias 不授权未知实体的 core.name。
- 严格 TDD：每个缺陷先添加可复现失败测试，再实现最小修复，再运行聚焦测试和回归。
- 不新增运行时依赖，不修改已有轻量 fixture 的必填构造契约。

---

### Task 1: 修复 observer 事件与实体名称权限旁路

**Files:**
- Modify: `src/game/gameplay/rpg/narrativeMemory/projectObserverEvidence.ts`
- Modify: `src/game/gameplay/rpg/narrativeMemory/retrieveStoryEvidence.ts`
- Test: 对应 `*.test.ts`

**Interfaces:** 保持 `projectObserverEvidence`、`retrieveStoryEvidence` 的公开签名；事件只有在其事实 payload 全部对 observer 可见且事件原文来源合法时进入 observer evidence。

- [x] **Step 1: Write the failing tests**

增加两个测试：可见 History 引用含私密 fact 的 event 时，`ObserverEvidence.events` 不包含该 event；未知实体拥有公开 alias 时，查询其 core.name 不得产生 entity selection 或 entity context。

- [x] **Step 2: Run the focused tests and verify failure**

运行 `npx vitest run src/game/gameplay/rpg/narrativeMemory/projectObserverEvidence.test.ts src/game/gameplay/rpg/narrativeMemory/retrieveStoryEvidence.test.ts --minWorkers=1 --maxWorkers=2`，预期新增断言失败。

- [x] **Step 3: Implement the minimal permission fix**

在 History→event 投影中复用既有 fact visibility 判定，不能以 History 可见直接授权整个事件；在 entity term 匹配中，未知实体只允许使用 observer 已授权 alias，不把 `core.name` 加入匹配词。

- [x] **Step 4: Run focused tests and boundaries**

重新运行上述测试，并运行 `npm run test:boundaries`。

- [x] **Step 5: Commit**

提交信息：`fix: close narrative observer permission bypasses`。

### Task 2: 修复摘要水位、来源校验和 History 重复检测

**Files:**
- Modify: `src/game/gameplay/rpg/narrativeMemory/planMemorySummary.ts`
- Modify: `src/game/application/server/persistence/sqliteNarrativeMemorySummaryRepository.ts`
- Modify: `src/game/application/narrativeMemorySummaryRepository.ts`
- Modify: `src/game/application/prepareNarrativeMemory.ts`
- Test: `planMemorySummary.test.ts`、`sqliteNarrativeMemorySummaryRepository.test.ts`、`prepareNarrativeMemory.test.ts`

**Interfaces:** 摘要发布保持现有 port，但拒绝低于已发布水位的 batch；若 repository 提供 game guard，则来源和水位校验在同一写事务完成。

- [x] **Step 1: Write failing tests**

增加测试：跨 watermark 的重复 History ID（旧记录与新记录文本不同）被拒绝；已发布 watermark=100 后尝试发布 watermark=10 返回冲突且不改行；变更当前游戏 revision/epoch 后旧 worker 的 publish/reservation 不增长计数；发布的 source fingerprint 必须来自 canonical source 数据而不是任意调用方字符串。

- [x] **Step 2: Run focused tests and verify failure**

运行 `npx vitest run src/game/gameplay/rpg/narrativeMemory/planMemorySummary.test.ts src/game/application/server/persistence/sqliteNarrativeMemorySummaryRepository.test.ts src/game/application/prepareNarrativeMemory.test.ts --minWorkers=1 --maxWorkers=2`，预期新增断言失败。

- [x] **Step 3: Implement validation and transactional CAS**

先对全部 visible History 做 ID/sequence/text 一致性校验，再按 watermark 过滤；repository 在 SQLite 写事务内读取并校验 game guard、当前水位、fingerprint/source generation，然后执行 CAS 和 attempt 计数更新，失败不产生计数副作用。使用稳定 canonical source 序列计算 SHA-256，并覆盖 observer、History、Event、facts、实体当前状态和 active Thread 所需字段。

- [x] **Step 4: Run focused tests, typecheck, and boundaries**

运行聚焦测试、`npm run typecheck`、`npm run test:boundaries`。

- [x] **Step 5: Commit**

提交信息：`fix: make narrative summary publication source-consistent`。

### Task 3: 修复候选恢复和完整 provider 输入预算

**Files:**
- Modify: `src/game/application/generatePendingNarrativeBundle.ts`
- Modify: `src/game/application/prepareNarrativeMemory.ts`
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.ts`
- Test: 对应 generator、context compiler、live source 测试

**Interfaces:** 轻量 fixture 未提供持久化记忆 repository 时保持当前 raw path；durable pending job 有候选版本但缺少冻结包时返回明确失败，不重新准备或调用 author。

- [x] **Step 1: Write failing tests**

增加测试：`candidateVersion > 0` 且 `loadPrepared()` 为空或 hash 无效时，生成流程失败且 `prepareMemoryPackage`、author source 均未调用；构造规则/实体/历史组合使完整 prompt 超过 `promptMaxEstimatedTokens`，在任何 author HTTP 前返回 overflow；`rawSoftEstimatedTokens` 超限时启用摘要准备。

- [x] **Step 2: Run focused tests and verify failure**

运行 `npx vitest run src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/prepareNarrativeMemory.test.ts src/game/application/server/ai/narrativeContext/narrativeBundleContext.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts --minWorkers=1 --maxWorkers=2`，预期新增断言失败。

- [x] **Step 3: Implement recovery and budget enforcement**

生成器区分首次准备与已有候选恢复；已有候选只接受 hash 验证通过的固定包。将冻结的完整 prompt budget 注入最终 context compiler，编译规则、实体、历史、记忆、候选和 reviewer 输入后统一估算；mandatory 内容超限时返回明确错误并阻止 author/reviewer HTTP。把 `rawSoftEstimatedTokens` 与 `forceForLength` 传入 planner。

- [x] **Step 4: Run focused tests, full regression, docs checks, and build**

运行聚焦测试、`npm run typecheck`、`npm run test:boundaries`、`npm run check:docs`、`npm run test:docs`、`npm test -- --minWorkers=1 --maxWorkers=2 --reporter=dot` 和 `npm run build`。

- [x] **Step 5: Commit**

提交信息：`fix: enforce narrative recovery and prompt budgets`。

## Coverage gaps recorded for follow-up

- 真实 AI live driver、完整中篇 journey 和 UI 验收仍不属于本修复计划；继续由原 P2 Task 6/7 负责。
- 若 SQLite 驱动无法在单事务中锁定 game guard，必须通过同一事务的条件 `UPDATE/INSERT ... WHERE` 表达 CAS，而不是退回到事务外读取后写入。
