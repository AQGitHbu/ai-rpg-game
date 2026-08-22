# 叙事格式自动修复重试与单线移动一致性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 修复运行时叙事链中“预生成队列未优先消费、世界演化实体落点错误、格式错误没有自动修复、日志无法区分重试来源”四类问题，使单线移动优先消费已批准叙事，并让每次结构化 AI 响应失败最多自动修复一次后再持久化失败。

**Architecture:** 保留 RpgAiClient 对超时/网络/限流/服务错误的传输重试；在世界演化的“AI 响应解析 + 世界提案审批”边界增加一次统一的内容修复请求，避免解析重试与审批重试叠加失控。待处理场景先按 actionKind + 实体 ID 查找并消费 linearNarrativeQueue，命中时不进入候选不足的世界演化补救路径。所有 AI 审计事件携带“正常生成 / 自动传输重试 / 自动内容修复 / 手动失败 job 重试”的结构化标记。

**Tech Stack:** TypeScript, Next.js route handlers, Vitest, SQLite CAS repository, JSONL AI text audit, @ai-game/ai-transport。

**Spec:** docs/agent/运行时AI导演与场景表演.md、docs/agent/世界动态具象化.md、docs/agent/日志与追踪.md、docs/agent/AI文本审计.md。

## Global Constraints

- AI 只返回提案；规则层负责地点、NPC、任务、目标可达性、ID、状态写回和 choice token。
- world/scene 结构化响应或审批失败自动只允许一次内容修复；修复仍失败必须持久化 AI_RESPONSE_INVALID，不能改写成 deterministic/fallback 成功。
- 传输重试与内容修复重试是两层独立机制；empty_response 不重复发送完全相同的请求，仍由 source 按既有策略决定是否发带修复原因的新请求。
- 普通 /api/game/narrative/ensure 轮询只观察/恢复 pending；failed job 只有 { "retry": true } 才能以同一 job 手动重试。
- 单线移动、调查在不挂起 `needs_next_act/needs_ending_pair` 且命中已审批 `linearNarrativeQueue`（`move`/`investigate`）时不得调用 scene/world AI；幕推进/结局对挂起时仍保留完整世界演化编排。`take_item` 不参与队列（无预生成形态），仍经规则 CAS 成功后走正常队列/场景逻辑；队列消费仍必须经过同一场景审批和 CAS 写回。
- 新世界地点与其主线目标 NPC 必须空间一致；“先访问新地点、再与该 NPC 交谈”的目标链不能把 NPC 铸造到旧地点。
- 不新增 API route、不引入 deterministic fallback、不迁移或静默修复现有坏存档；旧开发存档按项目现有规则清档重开或由专门迁移计划处理。
- 新审计事件只能记录稳定重试类型（`AiRetryOrigin/Mechanism`）、原因码、`attempt`、`traceId`、`gameId`、`jobId` 和 `turnNumber`；历史 `repair` 只读显示为 CLI 派生值 `legacy_unknown`（不是新事件允许的 `AiRetryOrigin`），不得臆测其来源为普通调用或手动重试。日志不记录 API key、Authorization、Cookie 或完整 URL。

---

## 事故证据与修复边界

本计划以 logs/ai-text-audit/2026-08-22T05-54-41.505Z/events.jsonl 中 game 52de760c-1518-4dce-9d9b-0c0a54b3cdb6 的事实为回归基线：

- seq 281/282 已由 scene/talk_choice 生成并接受前往 loc_dyn_1 的 linearActionNarratives。
- seq 286 移动规则提交成功；之后没有新的 scene AI 调用。
- seq 285/307 都是 world/scene_candidate_shortage，且两次都是 attempt: 1，说明第二次是独立执行，不是 provider transport 的 attempt 2。
- 世界演化提案把“瘸腿老者”放到 loc_0，但 next quest 生成了“访问 loc_dyn_1 → 与瘸腿老者交谈”的目标链。
- 运行时日志中的 newLocation 契约缺少当前解析器要求的 placement，并重复生成“荒山废庙”，所以补救调用最终成为 AI_RESPONSE_INVALID。
- 当前 generatePendingScene 在查找 linearNarrativeQueue 前先做候选不足补救；当前存档在荒山废庙没有 NPC，因而进入了不必要的 world AI 路径。

本计划修复的是上述运行链和观测链；不把 provider 的一次有效 HTTP 响应误判为传输失败，也不把 /api/game/narrative/ensure 的轮询当成 AI 重试。

## 文件与职责总览

- src/game/application/server/ai/textAuditTypes.ts：定义 `AiRetryOrigin/Mechanism/Context` 与 `AiTextAuditContext.retry`，保留 `repair` deprecated 兼容。
- src/game/application/server/ai/rpgAiClient.ts：只负责传输层重试（`maxAttempts` 内），在审计中标记 `mechanism=transport`，不覆盖 `origin`。
- src/game/application/server/ai/liveWorldEvolutionSource.ts：按 `WorldEvolutionSourceContext.contentRepair` 构造一次内容修复提示，解析失败返回稳定 `repairReason`，并把 `context.retry` 传给统一 AI client。
- src/game/application/worldEvolutionSource.ts：扩展 `WorldEvolutionSourceContext.contentRepair` 与 `WorldEvolutionSourceResult.repairReason` 契约（`type-only` 复用 `WorldDeltaRejection`）。
- src/game/application/evolveWorld.ts：统一控制“初次提案 + 至多一次内容修复”两轮循环，覆盖解析失败和审批拒绝。
- src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts：新增常量 `REJECT_REASON_NPC_NOT_AT_NEW_LOCATION`，拒绝 `new_location` 与 `newNpc.locationRef` 空间不一致的提案。
- src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts：保持审批后的 NPC/location 双向索引一致，并补充回归断言。
- src/game/application/generatePendingScene.ts：`move/investigate` 先命中 `linearNarrativeQueue`（`take_item` 不参与），命中时跳过 `scene_candidate_shortage` 的 `evolveWorld` 与 `sceneSource`；记录 `NarrativeGenerationPath` 到 logger。
- src/game/application/server/ai/_shared/ensureCoordinator.ts、src/game/application/server/compositionRoot.ts：把 `AiRetryOrigin`（`normal`/`manual_failed_job`）透传到 `auditLink.retry`，确保同一 `jobId` 的 `origin` 可追溯。
- src/app/api/game/narrative/ensure/route.ts、src/components/gameActionRequest.ts、src/components/CurrentGameScreen.tsx：保持普通轮询 `{}` 与 `{ retry: true }` 语义分离，前者不触发重试，后者走 `retryNarrativeGeneration` CAS。
- scripts/aiTextAudit.mjs：查询时对新 `retry` 与历史 `repair` 做只读归一，`verify` 兼容历史日志；事件写入器不改写 append-only 审计记录。
- docs/agent/运行时AI导演与场景表演.md、docs/agent/世界动态具象化.md、docs/agent/日志与追踪.md、docs/agent/AI文本审计.md：实现完成后同步 canonical 事实（世界演化使用 `contentRepair`；场景内部继续使用 `repairAttempt`；审计统一使用 `retry` 字段）。

### Task 1: 固化重试类型与审计契约

**Files:**
- Modify: src/game/application/server/ai/textAuditTypes.ts （主责：新增 retry 契约 + Link 投影 + 保留 repair 兼容）
- Modify: src/game/application/server/ai/rpgAiClient.ts （仅补 `mechanism=transport` 标记，不改 scene/world 上下文）
- Modify: src/game/application/server/ai/liveIntentParserSource.ts （已有 intent 内容修复改写为 `context.retry`，不改变本任务的意图业务语义）
- Modify: scripts/aiTextAudit.mjs （query/verify 只读支持 `retry ?? repair`，历史 repair 显示为 `legacy_unknown`，不重写历史事件）
- Test: src/game/application/server/ai/textAuditRecorder.test.ts
- Test: src/game/application/server/ai/rpgAiClient.test.ts
- Test: src/game/application/server/ai/liveIntentParserSource.test.ts
- Test: scripts/aiTextAudit.node-test.mjs

> 约束：本任务不改 `sceneGenerationContext.ts`、`worldEvolutionSource.ts` 或场景内部的 `repairAttempt` 命名；审计字段统一使用 `context.retry`，不为了审计改动现有场景修复状态。

**Interfaces:**

新增内部审计类型，保留顶层 ai_call.attempt 作为 provider transport attempt；context.retry 用于区分来源和机制：

~~~ts
export type AiRetryOrigin = "normal" | "manual_failed_job";
export type AiRetryMechanism = "initial" | "transport" | "content_repair";

export type AiRetryContext = Readonly<{
  readonly origin: AiRetryOrigin;
  readonly mechanism: AiRetryMechanism;
  readonly attempt: number;
  readonly reason?: string;
}>;
~~~

AiTextAuditContext 增加 `retry?: AiRetryContext`（新增字段，旧字段 `repair?` 保留为 deprecated 只读兼容，`scripts/aiTextAudit.mjs` 对两者做 `retry ?? repair` 归一）；AiTextAuditLink 改为 `Pick<AiTextAuditContext, "traceId"|"gameId"|"jobId"|"turnNumber"|"retry">` 的投影（不再新增 `retryOrigin` 独立字段，通过 `link.retry.origin` 判定来源）。`SceneGenerationContext.repairAttempt` 与 `WorldEvolutionSourceContext.contentRepair` 是不同层的状态字段，保留现有命名；它们只携带 prompt 修复与审计所需元数据，不进入玩家可见正文。

- 初次普通调用：origin=normal、mechanism=initial、attempt=0。
- RpgAiClient 的 timeout/network/rate-limit/5xx 重试：保留 origin，mechanism=transport，顶层 attempt 为 2/3。
- 非法 JSON/schema/reference 或审批拒绝触发的修复：mechanism=content_repair，attempt=1，带稳定 reason。
- failed job 由玩家点击“重试”恢复后：origin 为 manual_failed_job；该 job 的第一次 AI 请求仍是 mechanism=initial，后续内容修复仍是 origin=manual_failed_job + mechanism=content_repair。

- [ ] **Step 1: 先写审计契约失败测试**

在 rpgAiClient.test.ts 增加断言：同一个 transport callId 的 attempt 1/2，attempt 2 的 context.retry.mechanism 为 transport；内容修复调用使用新 callId，但共享 game/job/trace，并标记 content_repair。在 textAuditRecorder.test.ts 增加四类重试元数据的合法事件测试。

~~~ts
expect(events.map((event) => event.context.retry)).toEqual([
  { origin: "normal", mechanism: "initial", attempt: 0 },
  { origin: "normal", mechanism: "transport", attempt: 2, reason: "network_error" },
]);
~~~

- [ ] **Step 2: 运行定向测试确认现状失败**

Run: npx vitest run src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/textAuditRecorder.test.ts

Expected: FAIL，因为当前 context 只有旧的 repair 字段，不能表达 transport/content/manual 三种来源。

- [ ] **Step 3: 实现审计类型与传递（拆为 3a/3b 可独立评审）**

**3a — 类型契约**：在 `textAuditTypes.ts` 新增 `AiRetryOrigin/Mechanism/Context`，`AiTextAuditContext` 新增可选 `retry` 并保留 `repair?` deprecated；在 `scripts/aiTextAudit.mjs` 增加只读 `normalizeRetryContext`：优先返回 `context.retry`，历史仅含 `repair` 的事件映射为 `origin:"legacy_unknown"、mechanism:"content_repair"`，绝不改写 JSONL；`query` 可展示该派生字段，`verify` 需同时接受新 `retry` 与旧 `repair`，并新增一条旧日志回归断言。

**3b — 运行时传递**：`rpgAiClient.ts` 在写入每次 `ai_call` 前先把缺省上下文补成 `{ origin:"normal", mechanism:"initial", attempt:0 }`，再根据 provider `attempt` 覆盖 `mechanism=transport` 但不覆盖 `origin`；`liveScenePerformanceSource.ts`、`liveWorldEvolutionSource.ts` 和已有 `liveIntentParserSource.ts` 的内容修复调用写入 `mechanism=content_repair, attempt=1`。`compositionRoot.ts` 仅在 `retryNarrativeGeneration` 成功后的 `manual_failed_job` 链路显式注入该 origin。

- [ ] **Step 4: 运行定向测试 + 历史兼容校验**

Run: npx vitest run src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/textAuditRecorder.test.ts

Run: node --test scripts/aiTextAudit.node-test.mjs

Run: npm run ai-text-audit -- verify --run 2026-08-22T05-54-41.505Z  # 对历史 runId 必须 PASS（兼容仅含 repair 的旧事件）

Expected: 三项均 PASS；`textAuditRecorder.test.ts` 需包含一条“旧事件仅含 repair 仍合法”的用例。

### Task 2: 为世界演化增加一次统一的内容修复重试

**Files:**
- Modify: src/game/application/worldEvolutionSource.ts （新增 `contentRepair` 与 `repairReason` 契约）
- Modify: src/game/application/server/ai/liveWorldEvolutionSource.ts （单次 `complete` + `repairReason` 映射）
- Modify: src/game/application/evolveWorld.ts （两轮循环：初次 + 一次 content repair）
- Test: src/game/application/server/ai/worldEvolutionSource.test.ts
- Create: src/game/application/evolveWorld.test.ts

> 注：`rpgAiClient.ts` 的传输重试由 Task 1 统一负责，本任务不重复修改。

**Interfaces:**

在 world source context 增加只供修复 prompt/审计使用的字段：

~~~ts
export type WorldEvolutionContentRepair = Readonly<{
  readonly attempt: 1;
  readonly reason:
    | "invalid_json"
    | "invalid_schema"
    | "invalid_reference"
    | "approval_rejected";
  readonly approvalCode?: WorldDeltaRejection;
}>;

~~~

从 gameplay facade 以 type-only 方式复用现有 `WorldDeltaRejection` 联合类型；不得在 application/server/ai 内复制另一份审批 code 列表。实现文件显式使用：

~~~ts
import type { WorldDeltaRejection } from "@/game/gameplay/rpg/worldEvolution";
~~~

在现有 WorldEvolutionSourceContext 保留 worldState、storyState、need、action、reason、auditLink 字段，并新增 contentRepair?: WorldEvolutionContentRepair。

source 失败结果增加可供 application 层决定是否修复的稳定原因；transport/unavailable/empty response 不带 repairReason：

~~~ts
type WorldEvolutionSourceResult =
  | { readonly ok: true; readonly proposal: WorldDeltaProposal | null }
  | {
      readonly ok: false;
      readonly failure: AiGenerationFailure;
      readonly repairReason?: "invalid_json" | "invalid_schema" | "invalid_reference";
    };
~~~

- [ ] **Step 1: 写 world source 的格式修复失败测试**

在 worldEvolutionSource.test.ts 断言单次 `source.propose(ctx)` 对非法 JSON、schema 或 reference 各只调用 `complete` 一次，并返回对应 `repairReason`；传入 `ctx.contentRepair` 时 prompt 包含“只修复上一轮的 invalid_json/invalid_schema/invalid_reference”，审计 context 标记 `content_repair`。再增加“source 自身不递归、不重复相同请求”的断言；两次调用由 Step 2 的 `evolveWorld` 测试覆盖。

~~~ts
const complete = vi.fn()
  .mockResolvedValueOnce({ ok: true as const, content: "not json", latencyMs: 1 });

const result = await source.propose({
  ...ctx,
  contentRepair: { attempt: 1, reason: "invalid_json" },
});
expect(complete).toHaveBeenCalledTimes(1);
expect(result).toMatchObject({ ok: false, repairReason: "invalid_json" });
~~~

从注入的 audit recorder 第一条 ai_call 事件断言 context.retry 为 `{ origin: "normal", mechanism: "content_repair", attempt: 1, reason: "invalid_json" }`。

- [ ] **Step 2: 写 world application 审批拒绝后的修复测试**

在新建的 src/game/application/evolveWorld.test.ts 中让 source 第一次返回“新地点 + 新 NPC 但 NPC 在旧地点”的提案，第二次返回 locationRef: { kind: "new_location" } 的合法提案；断言 source 只调用 2 次、第二次收到 contentRepair.attempt=1 和 approval_rejected 原因，最终返回 ok=true。再覆盖重复地点名的审批拒绝。

- [ ] **Step 3: 实现 world source 的单次内容修复**

让 liveWorldEvolutionSource.ts 每次 propose(ctx) 只执行一次 aiClient.complete("world", ... )；把 ctx.contentRepair 写入修复 prompt，并在 parseJsonResponse、parseWorldDeltaProposal、filterProposalRefs 失败时返回对应 repairReason。禁止 source 自己递归多次，修复预算由 evolveWorld 统一控制。

修复 prompt 必须明确：保留当前事实边界，只修复上一响应的稳定原因；placement、locationRef、已有地点名、任务目标可达性均是契约，不允许通过省略字段绕过。若 `approvalCode` 存在，必须把该稳定审批 code 一并放入修复上下文和审计 reason，不能只记录笼统的 `approval_rejected`。

审计 reason 统一采用 `approval_rejected:<WorldDeltaRejection>` 或解析器稳定 reason；该字符串只进结构化审计/诊断字段，不进入玩家可见正文。

- [ ] **Step 4: 实现 evolveWorld 的初次 + 一次修复循环**

用一个最多两轮的循环覆盖“source 解析失败”和“approveWorldDelta 拒绝”：

~~~ts
let repair: WorldEvolutionContentRepair | undefined;
for (let attempt = 0; attempt < 2; attempt += 1) {
  const sourceResult = await source.propose({ ...context, contentRepair: repair });
  if (!sourceResult.ok) {
    if (attempt === 0 && sourceResult.repairReason !== undefined) {
      repair = { attempt: 1, reason: sourceResult.repairReason };
      continue;
    }
    return {
      ok: false,
      code: "source_error",
      failure: sourceResult.failure,
    };
  }
  if (sourceResult.proposal === null) {
    if (attempt === 0) {
      repair = { attempt: 1, reason: "invalid_schema" };
      continue;
    }
    return {
      ok: false,
      code: "no_proposal",
      failure: { kind: "AI_RESPONSE_INVALID", phase: "world" },
    };
  }
  const approval = approveWorldDelta({
    proposal: sourceResult.proposal,
    need: input.need,
    ws: input.worldState,
    ss: input.storyState,
    idOverride: input.idOverride,
  });
  if (!approval.ok) {
    if (attempt === 0) {
      repair = { attempt: 1, reason: "approval_rejected", approvalCode: approval.code };
      continue;
    }
    return {
      ok: false,
      code: "rejected",
      rejectionCode: approval.code,
      failure: { kind: "AI_RESPONSE_INVALID", phase: "world" },
    };
  }
  const delta = materializeWorldDelta({
    approved: approval.approved,
    need: input.need,
    ws: input.worldState,
    ss: input.storyState,
    now: input.now,
  });
  return { ok: true, proposal: sourceResult.proposal, approved: approval.approved, delta };
}
return {
  ok: false,
  code: "rejected",
  failure: { kind: "AI_RESPONSE_INVALID", phase: "world" },
};
~~~

传输失败、不可用、空响应不进入该内容修复循环；由 RpgAiClient 的传输策略或稳定 AI_CALL_FAILED 处理。修复耗尽统一返回 AI_RESPONSE_INVALID，不创建 deterministic source。

- [ ] **Step 5: 运行 world 修复测试**

Run: npx vitest run src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/evolveWorld.test.ts

Expected: PASS；旧的“非法 JSON 只调用一次”的测试改为“非法 JSON 初次 + 一次修复，共两次”，empty_response 仍不重复完全相同请求。

### Task 3: 阻止世界演化生成不可达的地点/NPC/任务链

**Files:**
- Modify: src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts
- Modify: src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.ts
- Modify: src/game/application/server/ai/liveWorldEvolutionSource.ts
- Test: src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts
- Test: src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts
- Test: src/game/application/server/ai/worldEvolutionSource.test.ts

**Interfaces:**

保持现有 `WorldDeltaRejection` 联合类型，不新增玩家可见错误；将 `unreachable_objective` 的内部 `reason` 扩展为 `npc_not_at_new_location`。在 `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts` 导出常量 `export const REJECT_REASON_NPC_NOT_AT_NEW_LOCATION = "npc_not_at_new_location" as const`，测试与实现均引用该常量而非魔法字符串。规则检查必须发生在 ID 铸造/预算提交前。

- [ ] **Step 1: 写错误提案回归测试**

用事故中的结构测试：`newLocation.placement=world`、`newNpc.locationRef={ kind: existing, id: loc_0 }`、`next_act` 会生成“visit new location → talk new NPC”。断言 `approveWorldDelta` 返回 `code=unreachable_objective` 且 `reason` 为导出常量值，不产生任何 approved IDs。

~~~ts
import { REJECT_REASON_NPC_NOT_AT_NEW_LOCATION } from "@/game/gameplay/rpg/worldEvolution/approveWorldDelta";

const base = nextActProposal();
const proposal = {
  ...base,
  newNpc: {
    ...base.newNpc!,
    locationRef: { kind: "existing" as const, id: "loc_0" },
  },
};
const result = approveWorldDelta({
  proposal,
  need: { kind: "next_act", act: 2 },
  ws: makeWorld(),
  ss: makeStory({ currentAct: 2 }),
});
expect(result).toEqual({
  ok: false,
  code: "unreachable_objective",
  reason: REJECT_REASON_NPC_NOT_AT_NEW_LOCATION,
});
~~~

- [ ] **Step 2: 写正确落点和物化索引测试**

断言 locationRef={ kind: new_location } 的合法提案仍生成：

~~~ts
expect(approved.newNpcs[0]?.locationId).toBe("loc_dyn_1");
expect(approved.newLocations[0]?.npcIds).toEqual(["npc_dyn_1"]);
~~~

再通过 materializeWorldDelta 断言新地点 npcIds、NPC locationId、下一目标 talk_to_npc 三者一致。

- [ ] **Step 3: 实现审批层空间一致性门槛**

在 approveWorldDelta.ts 的 ID 铸造/预算预占前，按 proposal 直接检查：若 `need.kind === "next_act"`、同一提案同时包含 `newLocation.placement === "world"`、`newNpc` 和 `nextMainQuest`，则必须要求 `newNpc.locationRef.kind === "new_location"`；否则返回 `unreachable_objective / npc_not_at_new_location`。不把旧地点的 NPC 静默搬迁到新地点；不接受“审批成功但玩家永远看不到目标 NPC”的状态。

- [ ] **Step 4: 收紧 world prompt 的可达性约束**

buildWorldEvolutionPrompt 增加现有地点的安全名称/ID 列表和明确规则：

~~~text
如果 newLocation.placement=world 且 newNpc 同时存在，newNpc.locationRef 必须为 {"kind":"new_location"}，除非本次任务明确不把该 NPC 作为新地点目标。
新地点名称不得与现有地点名称重复；新任务的目标顺序必须在玩家可达的地点/实体上成立。
~~~

提示词只提供已批准地点摘要，不序列化完整存档或私密事实。

- [ ] **Step 5: 运行世界演化领域测试**

Run: npx vitest run src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts src/game/gameplay/rpg/worldEvolution/materializeWorldDelta.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts

Expected: PASS；事故提案在规则审批层被拒绝并进入 Task 2 的一次内容修复，而不是写入错误世界状态。

### Task 4: 让单线移动优先消费预生成队列

**Files:**
- Modify: src/game/application/generatePendingScene.ts
- Test: src/game/application/generatePendingScene.test.ts
- Test: src/game/application/deterministicSceneSource.test.ts

**Interfaces:**

保留现有 `findMatchingQueueEntry(queue, summary)` 和 `removeMatchingQueueEntry` 的稳定键规则。`LinearActionNarrativeState` 仅支持 `investigate`/`move`，因此队列查找仅对这两种 `summary.kind` 生效；`take_item` 不参与队列匹配（规则已完全确定，无预生成叙事）。新增内部生成路径标记：

~~~ts
// 仅用于 server logger 的结构化字段，不持久化到 StoryState/GameSessionView 或审计正文
export type NarrativeGenerationPath = "pre_generated_queue" | "live_scene";
~~~

定义位置：`src/game/application/generatePendingScene.ts` 内局部类型，禁止在 `StoryState` 或 `GameSessionView` 新增字段。

- [ ] **Step 1: 写队列优先回归测试**

构造一个 move pending job：队列中有精确匹配的 locationId，scene source 与 world evolution source 都是会抛错/计数的 spy；断言 generatePendingScene 成功写回 generated narration，两个 source 均为 0 次调用，linearNarrativeQueue 只删除匹配 move 条目。

再构造一个队列未命中的 move：断言只在此时允许进入 live scene/candidate shortage 路径，并保留其他未来队列条目。

- [ ] **Step 2: 运行测试确认现状暴露顺序问题**

Run: npx vitest run src/game/application/generatePendingScene.test.ts

Expected: 新增的“候选不足但队列命中不调用 world”测试在现状失败，失败点是 scene_candidate_shortage 先于 queue lookup。

- [ ] **Step 3: 调整 generatePendingScene 的顺序（YAGNI 收敛）**

保留现有 `immediateAction` 的规则语义（其中 `take_item` 仍是规则已确定的即时动作），另新增只用于队列查找的 `isQueueEligible`；不能用队列资格改写 `take_item` 的既有规则写回语义。对于 `move`/`investigate`，且仅当当前 evolution status 不是 `needs_next_act/needs_ending_pair` 时，必须在任何 `derivedNeed` 计算、初始世界演化和 `scene_candidate_shortage` 的 `evolveWorld` 调用之前，直接从当前权威 `record.storyState.narrative.linearNarrativeQueue` 查找：

~~~ts
const evolutionBlocksImmediatePath = record.storyState.evolution.status === "needs_next_act"
  || record.storyState.evolution.status === "needs_ending_pair";
const isQueueEligible = !evolutionBlocksImmediatePath
  && (summary.kind === "move" || summary.kind === "investigate");
const queuedEntry = isQueueEligible
  ? findMatchingQueueEntry(record.storyState.narrative.linearNarrativeQueue, summary)
  : undefined;
const hasPreGeneratedNarrative = queuedEntry !== undefined;
~~~

`hasPreGeneratedNarrative` 命中时，`derivedNeed` 固定为 `none`，`scenarioWs/scenarioSs` 保持当前权威存档状态；因此队列命中不会触发任何 world AI。只有未命中时，才沿用现有 `immediateAction`/`deriveEvolutionNeed` 逻辑。候选上下文随后从未被演化的 `scenarioRecord` 建立。

命中时：

- 不调用初始 `evolveWorld`，也不调用 `evolveWorld({ reason: "scene_candidate_shortage" })`；
- 不调用 `sceneSource.generateScene`；
- 继续使用当前权威 `scenarioWs/scenarioSs` 构建 `queued proposal`、走既有 scene approval 和 scene CAS；
- 写回时按稳定键 `actionKind+entityId` 消费一条队列记录；
- 记录 `narrative_queue_hit` 与 `generationPath=pre_generated_queue` 到 logger 的结构化字段（不进存档）。

未命中或非队列 eligible 仍沿用候选不足处理；只对 queue eligible 的未命中记录 `narrative_queue_miss`，并记录 `generationPath=live_scene`。后续消费变量直接使用本次查找得到的 `queuedEntry`，不得在可能重建状态后再次查找。若旧坏存档命中队列但当前合法候选仍不足，必须无 AI 地返回稳定 `AI_RESPONSE_INVALID`（`markNarrativeGenerationFailed` with `phase:"scene"`），并在 logger 记录 `world_state_inconsistent`（仅日志分类，不新增 `AiFailureKind`），不能为补按钮再次调用 world AI。

实现时把队列命中的候选数检查放在 `try` 外，或单独捕获队列状态错误；不能让 `buildQueuedGeneratedSceneProposal` 的存档不一致异常落入通用 provider 异常分支而被误报成 `AI_CALL_FAILED`。

- [ ] **Step 4: 保持 ready scene 的双选项不变量**

不通过客户端伪造第二个 action。buildQueuedGeneratedSceneProposal 仍须使用当前服务端合法候选构造两个不同 choice；Task 3 保证新地点目标 NPC 正确在场，移动回程与目标交谈/探索因此形成可审批的候选集合。对历史坏存档只失败并记录，不静默修复；若队列命中但合法候选少于两个，直接 `AI_RESPONSE_INVALID`，不得为补足候选再调用 world/scene AI。

- [ ] **Step 5: 运行队列与场景测试**

Run: npx vitest run src/game/application/generatePendingScene.test.ts src/game/application/deterministicSceneSource.test.ts

Expected: PASS；队列命中时没有新的 scene/world provider 调用，移动叙事来源为 generated，消费只影响精确匹配条目。

### Task 5: 后端贯通 retry 来源（可独立评审，不含 UI）

**Files:**
- Modify: src/game/application/server/ai/_shared/ensureCoordinator.ts
- Modify: src/game/application/server/compositionRoot.ts
- Modify: src/game/application/server/ai/liveScenePerformanceSource.ts
- Modify: src/game/application/generatePendingScene.ts
- Test: src/game/application/server/ai/_shared/ensureCoordinator.test.ts
- Test: src/game/application/server/compositionRoot.test.ts
- Test: src/game/application/server/compositionRoot.audit.test.ts
- Test: src/app/api/game/narrative/ensure/route.test.ts

**Interfaces:**

复用 Task 1 的 `AiRetryOrigin`，不在本任务重复定义联合类型：

~~~ts
import type { AiRetryOrigin } from "@/game/application/server/ai/textAuditTypes";

// ensure 的 options 复用同一类型，默认保持普通轮询语义
ensure(
  traceId?: string,
  options?: { readonly origin?: AiRetryOrigin },
): Promise<EnsureResult>;

type BackgroundEnsureRun = (traceId?: string, origin?: AiRetryOrigin) => Promise<unknown>;
~~~

`BackgroundEnsureConfig.run` 接收同一 `origin`，并把完整的 `{ origin, mechanism: "initial", attempt: 0 }` 写入 `generatePendingScene` 的 `auditLink.retry`（`AiTextAuditLink.retry`）。`retryNarrativeGeneration` 仍只恢复同一 `jobId`，不创建新 job、不重新执行规则回合。

- [ ] **Step 1: 写普通轮询与手动重试的分流测试（后端）**

在 `ensureCoordinator.test.ts` 与 `compositionRoot.test.ts` 通过 route/entrypoint 的解析 body 新增断言（客户端请求体断言放到 Task 6）：

- 普通 ensure body `{}` 解析为 `origin=normal`，`failed` 状态不调用 AI；
- retry body `{ retry: true }` 解析为 `origin=manual_failed_job`，先做 `failed→pending` CAS，再调用一次 `coordinator`；
- 两个并发手动 retry 仍只有一个 CAS 成功和一个后台 job。

~~~ts
expect(auditEvents.filter(e => e.kind==="ai_call").map(e => e.context.retry)).toEqual(
  expect.arrayContaining([{ origin: "manual_failed_job", mechanism: "initial", attempt: 0 }])
);
~~~

- [ ] **Step 2: 给 coordinator 增加 origin 传递**

普通 `narrativeCoordinator.ensure(traceId)` 传 `origin=normal`；`ensureNarrativeScene({ retry: true })` 在 CAS 成功后调用 `narrativeCoordinator.ensure(traceId, { origin: "manual_failed_job" })`。`BackgroundEnsureCoordinator` 的 task 日志增加结构化字段 `retryOrigin`（仅日志，不进存档），但不记录玩家文案或 provider 细节。

- [ ] **Step 3: 给 scene/world 内容修复补齐审计来源**

保留 `liveScenePerformanceSource.ts` 现有 `repairAttempt` 内部命名，只在构造 AI 审计上下文时写入 `context.retry={ origin, mechanism:"content_repair", attempt:1, reason }`；world source 使用 Task 2 的 `contentRepair` 并同样写入 `context.retry`。普通、自动修复、手动 failed job 的 AI 调用必须能仅凭 `runId + gameId + jobId + traceId + context.retry` 还原。历史 `repair` 字段仅作只读兼容，不再写入新事件。

- [ ] **Step 4: 给 API 审计补充 manual/poll 模式（后端）**

`compositionRoot.ts` 的 `executeHttpRequest/recordGameApiExchange` 增加可选安全 audit metadata。对 `/api/game/narrative/ensure`，通过 `request.clone()` 只读取 body 中的布尔 `retry`（不保存原始 body，也不依赖 handler 已消费的 body），在 `compact` API 事件的 `context.retry` 写入：

~~~json
"context": {
  "trigger": "narrative_ensure",
  "retry": { "origin": "manual_failed_job", "mechanism": "initial", "attempt": 0 }
}
~~~

普通轮询写 `origin=normal`。`compact` 模式仍不保存原始 body；`full` 模式保留既有脱敏规则。

- [ ] **Step 5: 运行后端审计测试**

Run: npx vitest run src/game/application/server/compositionRoot.test.ts src/game/application/server/compositionRoot.audit.test.ts src/game/application/server/ai/_shared/ensureCoordinator.test.ts src/app/api/game/narrative/ensure/route.test.ts

Expected: PASS；失败后的轮询不会偷偷变成 retry。

### Task 6: 前端重试语义与 UI 接线（依赖 Task 5，可独立回滚）

**Files:**
- Modify: src/components/gameActionRequest.ts
- Modify: src/components/CurrentGameScreen.tsx
- Test: src/components/gameActionRequest.test.ts
- Test: src/components/CurrentGameScreen.test.tsx

**Interfaces:**

不让客户端导入 server-only 的 `AiRetryOrigin` 类型；只复用同一请求语义：`gameActionRequest.ts` 暴露 `ensureNarrative()` vs `retryNarrative()` 两个 helper，前者发送 `{}`，后者发送 `{ retry: true }`；`CurrentGameScreen.tsx` 仅在 `narrativeGeneration.status==="failed"` 时渲染“重试”入口。

- [ ] **Step 1: 写前端分流测试**

在 `gameActionRequest.test.ts` 断言 `ensureNarrative()` 发送 `{}`、`retryNarrative()` 发送 `{ retry: true }`。在 `CurrentGameScreen.test.tsx` 断言：failed 时不自动轮询，点击“重试”调用 `retryNarrative()`；pending 时才轮询。`manual_failed_job` 的审计字段由 Task 5/7 的后端测试验证，不在组件测试中伪造 server audit。

- [ ] **Step 2: 接线 UI**

`gameActionRequest.ts` 保持 `ensureNarrative(options?: {retry?:true})` 签名薄封装，`CurrentGameScreen.tsx` 的 `onRetry` 仅调用 `retryNarrative()`。

- [ ] **Step 3: 运行前端测试**

Run: npx vitest run src/components/gameActionRequest.test.ts src/components/CurrentGameScreen.test.tsx

Expected: PASS；点击“重试”才发送 `{ retry: true }`，轮询不偷跑；后端链路的 `manual_failed_job` 由 Task 5 验证。

### Task 7: 增加事故级端到端回归与日志验收

**Files:**
- Create: src/game/application/testing/linearMovePrefetchRegression.test.ts
- Test: src/game/application/evolveWorld.test.ts
- Test: src/game/application/server/ai/worldEvolutionSource.test.ts
- Test: src/game/application/server/compositionRoot.audit.test.ts

**Interfaces:**

新增回归场景必须证明以下可观测合同：

~~~ts
type ExpectedRetryTrace = {
  readonly queueHit: boolean;
  readonly sceneCalls: number;
  readonly worldCalls: number;
  readonly automaticContentRepairs: number;
  readonly manualFailedJobRetries: number;
};
~~~

- [ ] **Step 1: 写移动队列回归 journey**

从一次 NPC 选择生成含 move(locationId) 的预生成队列，提交移动 choice 后断言：规则 revision 只推进一次；移动 scene 直接使用该 narration；scene/world source provider 调用数均为 0；队列只消费 move 条目；到达地点后 NPC 在场且 HUD 目标与 NPC ID 一致。

- [ ] **Step 2: 写世界提案坏响应修复 journey**

让第一 world 响应缺 placement 或把目标 NPC 放在旧地点，第二 world 响应修复为 placement=world + locationRef={ kind: new_location }；断言两次 world AI 调用后成功写回，不产生第三次调用，不写入中间错误世界状态。

- [ ] **Step 3: 写自动/手动日志断言（含历史兼容）**

从审计事件中过滤同一 `jobId`，对 `context.retry ?? context.repair` 做只读归一后断言；新事件只接受 `normal/manual_failed_job`，历史 `repair` 只能得到 `legacy_unknown`：

- 初次 world：`retry.origin=normal、mechanism=initial`；
- 格式修复：`retry.origin=normal、mechanism=content_repair、reason=invalid_schema`；
- 玩家点击失败重试：`retry.origin=manual_failed_job、mechanism=initial`；
- 手动重试后的格式修复：`origin` 保持 `manual_failed_job`，`mechanism` 为 `content_repair`。

另增一条历史兼容断言：对 `logs/ai-text-audit/2026-08-22T05-54-41.505Z` 的旧 `repair` 事件，CLI `query` 仍能显示且 `verify` 不报错；不得把没有 `retry` 的旧事件臆测成 `manual_failed_job`。断言 provider transport `attempt:2` 仅当 `mechanism=transport` 出现，不能被误报为 content repair。

- [ ] **Step 4: 运行事故回归测试**

Run: npx vitest run src/game/application/testing/linearMovePrefetchRegression.test.ts src/game/application/evolveWorld.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/compositionRoot.audit.test.ts

Expected: PASS；队列命中、world 修复、手动失败重试和审计字段均可在最小回归夹具中重放；完整 journey 在 Task 9 统一执行。

### Task 8: 同步 canonical 文档与当前阶段入口

**Files:**
- Modify: docs/agent/运行时AI导演与场景表演.md
- Modify: docs/agent/世界动态具象化.md
- Modify: docs/agent/日志与追踪.md
- Modify: docs/agent/AI文本审计.md
- Modify: docs/agent/当前开发阶段.md
- Modify: docs/Agent文档索引.md

- [ ] **Step 1: 更新运行时事实**

明确写入：

- world source 的结构化响应/审批失败自动最多一次内容修复；
- 传输 retry、content repair、manual failed-job retry 的定义和边界；
- immediate action 队列命中优先于 candidate shortage/world evolution；
- 队列命中仍走本地审批/CAS，未命中才允许 live scene；
- 新地点与主线 NPC 的空间一致性由审批层硬拒绝。

- [ ] **Step 2: 更新日志审计字段**

在日志与追踪.md 和 AI文本审计.md 增加 context.retry.origin/mechanism/attempt/reason 的说明、普通轮询与手动 retry 的 API 观测方式，以及 ai_call.attempt 与内容修复 attempt 的区别。

- [ ] **Step 3: 更新当前阶段唯一 Plan 指针**

实现开始前将 docs/agent/当前开发阶段.md 的唯一执行入口切换到本计划；实现完成后将阶段状态改为待验收，并在索引中记录实现事实日期。

- [ ] **Step 4: 做文档一致性检查**

Run: npm run check:standards

Expected: PASS；没有旧文档继续宣称“world source 只调用一次且没有内容修复”或“普通 ensure 会自动重试 failed job”。

### Task 9: 构建、运行时重启和最终验收

**Files:**
- No source file changes beyond Tasks 1–8.
- Verify: .next/ is rebuilt from the implemented source before playtest.

- [ ] **Step 1: 运行完整静态与单元检查**

Run:

~~~bash
npm run typecheck
npm run lint
npm run test:boundaries
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:components
npm run test:app
npm test
~~~

Expected: PASS；没有新增跨层 import 或 server-only 泄漏。

- [ ] **Step 2: 重新构建并重启开发运行时**

Run: npm run build

停止旧 dev server 后再启动项目当前使用的开发命令；不得拿 placement 修复前的 .next bundle 继续做验收。构建后用一次最小 AI smoke 确认 world prompt 已包含 placement 和修复原因。

- [ ] **Step 3: 做 fresh-save 事故复现**

使用开发环境清档能力重开，不直接修改 db/rpg.sqlite。重走“NPC 选择 → 前往荒山废庙”：

- 上一次 talk 生成 move 预热；
- 点击移动只提交规则 action 并消费队列；
- 不出现 scene_candidate_shortage world 调用；
- 荒山废庙出现正确 NPC，目标可交互；
- 若人为注入非法 world JSON，日志显示一次 automatic_content_repair 后才成功/失败。

- [ ] **Step 4: 验收失败后的手动重试**

让自动修复耗尽，确认存档进入 failed；普通 polling 只返回 failed，不新增 AI call；点击 UI“重试”后同一 job 恢复 pending，审计标记 manual_failed_job，规则 revision/event ledger 不重复提交。

- [ ] **Step 5: 验收日志查询（含历史兼容）**

Run:

~~~bash
RUN_ID=2026-08-22T05-54-41.505Z
npm run ai-text-audit -- verify --run "$RUN_ID"   # 历史 repair 日志必须 PASS
npm run ai-text-audit -- query --run "$RUN_ID" --game 52de760c-1518-4dce-9d9b-0c0a54b3cdb6
npm run ai-text-audit -- list   # 新 run 的 runId 从该命令输出取得，再按同样的 query --kind ai_call 查看 context.retry
~~~

Expected: 可按 `context.retry.origin / mechanism`（历史日志只读归一为 `legacy_unknown`）明确区分：普通调用、自动传输重试、自动内容修复、手动 failed-job 重试；历史日志 `verify` 仍通过。

## 交付验收标准

- world/scene 的格式/schema/reference/审批契约失败会自动发送一次带稳定原因的修复请求；修复失败才显示 AI_RESPONSE_INVALID。
- transport retry 的 attempt 不再与内容修复混淆；empty_response 不重复相同请求。
- “荒山废庙”类单线移动命中预生成队列时不触发 scene/world AI，不因候选不足进入世界演化补救。
- 世界演化不会再审批通过“新地点在新地点、目标 NPC 在旧地点、任务要求抵达后与该 NPC 交谈”的不可达链。
- 普通 ensure 轮询不会自动重跑 failed job；只有 { retry: true } 标记为 manual_failed_job 并复用同一 job。
- 日志可回答“这是首次调用、自动传输重试、自动内容修复，还是手动失败重试”，且不泄漏敏感信息。
- .next 运行时与源码一致；fresh save 和 reload 后的场景/地图/NPC/HUD 视图一致。
