# 叙事失败重试上下文与场景 Schema 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (recommended). Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让场景 AI 在违反结构化协议时收到可执行的具体错误原因，并让同一失败 job 的手动重试继承该原因，同时正确记录自动内容修复重试。

**Architecture:** 保留“每个场景 job 最多一次自动内容修复、失败后人工恢复”的预算边界；把解析器现有的稳定失败码从 live source 传到 `NarrativeGenerationFailure`，安全持久化到 `provider_failed`，再由手动 requeue 写入 pending 的内部 retry context。场景 prompt 根据具体失败码给出字段级修复指令，AI 审计把第一次生成、内容修复和手动失败 job 来源分开记录。

**Tech Stack:** TypeScript, Next.js, SQLite CAS, Vitest, JSONL AI text audit。

**Spec:** `docs/agent/运行时AI导演与场景表演.md`、`docs/agent/日志与追踪.md`、`docs/游戏开发规范.md`。

## Global Constraints

- AI 只返回表演提案；beat ID、实体 ID、choice token 和规则状态仍由服务端权威校验。
- 每个场景 job 最多自动内容修复一次；失败后不自动无限重试，手动重试复用同一 job 和规则 CAS。
- 失败原因只允许稳定、脱敏的枚举/代码，不保存模型原文、prompt、玩家输入、URL 或密钥。
- 旧存档缺少新增 retry context 或 failure reason 时必须继续可读，并使用 `invalid_schema` 作为安全兼容原因。
- 不引入新 API route，不使用 deterministic fallback 掩盖生产 AI 失败。

---

### Task 1: 固化场景解析失败码与持久化契约

**Files:**

- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/domain/narrativeGenerationFailure.ts`
- Modify: `src/game/domain/narrative.ts`
- Test: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Test: `src/game/domain/narrative.test.ts`

**Interfaces:**

- `SceneSourceResult.repairReason` 传递 `segment_unknown_beat` 等稳定解析码，而不再把所有解析失败压成 `invalid_schema`。
- `NarrativeGenerationFailure.reason?: string` 只接受小写稳定代码；旧失败对象仍可省略该字段。

- [x] **Step 1: 写解析原因和失败对象的失败测试**

在 live scene source 测试中让 `segments[0].beatId` 使用 actionId，断言返回 `repairReason: "segment_unknown_beat"`。在 narrative parser 测试中增加带 reason 的 provider_failed 可读断言，并拒绝包含空格/过长文本的 reason。

- [x] **Step 2: 运行定向测试确认现状失败**

Run: `npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/domain/narrative.test.ts`

Expected: 新增断言因 source 返回 `invalid_schema` 或 persisted failure 不接受 reason 而失败。

- [x] **Step 3: 实现稳定原因贯穿**

复用现有 `ScenePerformanceParseFailureReason`，扩展 `SceneSourceResult.repairReason` 联合类型；live source 对 JSON 解析失败返回 `invalid_json`，结构解析失败返回具体 parser reason。失败持久化类型增加经过格式限制的可选 reason，`parseNarrativeRuntimeState` 对旧对象保持兼容。

- [x] **Step 4: 运行定向测试**

Run: `npx vitest run src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/domain/narrative.test.ts`

Expected: PASS。

---

### Task 2: 自动内容修复携带具体错误和可审计 retry 元数据

**Files:**

- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts`
- Test: `src/game/application/generatePendingScene.test.ts`
- Test: `src/game/application/server/ai/liveScenePerformanceSource.test.ts`
- Test: `src/game/application/server/ai/textAuditRecorder.test.ts`

**Interfaces:**

- `SceneGenerationContext.repairAttempt` 继续只用于本次 prompt，但内容为具体 reason。
- 第二次自动 `aiClient.complete` 的 `context.retry` 为 `{ origin, mechanism: "content_repair", attempt: 1, reason }`。

- [x] **Step 1: 写自动修复失败测试**

断言同一 `generatePendingScene` 的第二次 source context 为 `{ attempt: 1, reason: "segment_unknown_beat" }`，并在 live source 的审计事件中断言 `retry.mechanism === "content_repair"`。增加一个 prompt 断言，明确告诉模型 `segments[].beatId` 必须从当前允许 beat 列表复制，不能使用 actionId/jobId。

- [x] **Step 2: 运行定向测试确认现状失败**

Run: `npx vitest run src/game/application/generatePendingScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/textAuditRecorder.test.ts`

Expected: 自动修复仍只有泛化 `invalid_schema`，审计仍标成 `initial`。

- [x] **Step 3: 实现 reason 和 retry link 透传**

在 `generatePendingScene` 中把 `sceneResult.repairReason` 写入 terminal failure，并为每次 attempt 构造审计 link：第一次保留调用来源，第二次覆盖为 `content_repair`。scene prompt 的 repair block 输出字段级修复指令和稳定码。

- [x] **Step 4: 运行定向测试**

Run: `npx vitest run src/game/application/generatePendingScene.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/textAuditRecorder.test.ts`

Expected: PASS。

---

### Task 3: 手动失败 job 重试继承上一次失败原因

**Files:**

- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/application/retryNarrativeGeneration.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/server/ai/narrativeContext/sceneNarrativeContext.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Test: `src/game/application/retryNarrativeGeneration.test.ts`
- Test: `src/game/application/server/compositionRoot.test.ts`

**Interfaces:**

- `provider_pending` 增加可选内部 `retryContext: { attempt: 1; reason: string }`；不投影到 `GameSessionView`。
- `retryNarrativeGeneration` 从 failed failure.reason 生成 retryContext，旧失败无 reason 时使用 `invalid_schema`。

- [x] **Step 1: 写手动重试失败测试**

断言 failed → pending CAS 保留同一 jobId，并写入 `retryContext.reason === "segment_unknown_beat"`；旧失败对象断言回退到 `invalid_schema`。组合层断言重试后的第一次 scene prompt 已包含该 reason，且 audit origin 为 `manual_failed_job`。

- [x] **Step 2: 运行定向测试确认现状失败**

Run: `npx vitest run src/game/application/retryNarrativeGeneration.test.ts src/game/application/server/compositionRoot.test.ts`

Expected: pending 状态没有 retryContext，手动重试 prompt 不包含上一失败原因。

- [x] **Step 3: 实现兼容持久化和消费**

扩展 narrative runtime parser 的 pending key 白名单；retry use case 只在可用 reason 存在时写入 retryContext，否则使用安全兼容码。`generatePendingScene` 初始 context 消费 retryContext；成功写回 ready 时丢弃它，失败时把新具体 reason 写回 failure。

- [x] **Step 4: 运行定向测试**

Run: `npx vitest run src/game/application/retryNarrativeGeneration.test.ts src/game/application/server/compositionRoot.test.ts src/game/domain/narrative.test.ts`

Expected: PASS。

---

### Task 4: 完成文档、UI/日志验证和全量门禁

**Files:**

- Modify: `docs/agent/日志与追踪.md`
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/Agent文档索引.md` only if implementation facts require an index change

- [x] **Step 1: 更新实现事实**

记录“自动内容修复最多一次、repair reason 为稳定 parser code、手动 failed job 重试继承上一 reason、audit mechanism=content_repair”的 canonical 事实。

- [x] **Step 2: 运行相关门禁**

Run: `npm run test:game-domain`

Run: `npm run test:game-application`

Run: `npm run test:components`

Run: `npm run typecheck`

Run: `npm run test:boundaries`

Expected: PASS。

- [x] **Step 3: 对最新存档做只读复核**

确认当前存档旧 failed reason 可兼容读取；不修改或清理 `db/rpg.sqlite`。复核新测试证明：未知 beat 会被拒绝、自动修复会收到具体码、手动重试会继承该码、成功后 retryContext 不进入 ready 状态。
