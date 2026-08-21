# AI 调用失败不再剧情降级、改为失败提示与手动重试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox ( - [ ] ) syntax for tracking.

**Goal:** 移除生产运行链中所有由 AI 调用失败、空响应、非法 JSON、结构不符合或审批拒绝触发的确定性剧情 fallback；重试耗尽后持久化稳定失败状态，向玩家明确提示失败原因，并通过现有叙事 ensure API 提供“重试”按钮重新调用 AI。

**Architecture:** 保留 RpgAiClient 对瞬态 transport 错误的自动重试，并把结构化输出修复重试统一收口到各 live source；live source 不再导入或调用 deterministic source，失败返回带稳定分类的错误结果。pending 场景失败后不清除 pending job，而是通过一次 CAS 将 NarrativeGenerationState 置为 failed；手动重试再以 CAS 将同一个 job 恢复为 pending，因此不会重复提交玩家行动、不会重新裁决规则状态，也不会让剧情跳到确定性支线。

**Tech Stack:** TypeScript, React, Next.js, Vitest, SQLite CAS persistence

## Global Constraints

- 不新增版本化路由；重试统一扩展现有 POST /api/game/narrative/ensure，固定选择与自定义输入仍统一经 /api/game/actions。
- 生产 composition root 在 AI 配置缺失或无效时注入 unavailable source，不再注入 deterministic source；deterministic/fixture source 仅保留给显式测试与离线回放依赖注入。
- 规则回合先前已经成功提交的 WorldState、StoryState、event ledger 和 PendingNarrativeJob 不因 AI 失败回滚，也不因重试再次执行规则。
- AI provider 原始错误、响应正文、prompt、URL、模型名和密钥不进入客户端、存档或玩家文案；日志只记录角色、尝试次数和稳定失败分类。
- 玩家可见失败只使用两个稳定分类：AI_CALL_FAILED（不可用、网络、超时、限流、服务错误、空响应）和 AI_RESPONSE_INVALID（JSON、schema、引用、语义或审批契约不符合）。
- 失败状态必须跨 reload 保留；重试必须使用 expectedRevision/CAS 防止两个浏览器请求同时重试同一 job。
- 破坏性更新 StoryState schema 版本；不提供旧存档迁移，开发环境清档后重开，且同步更新 schema fixture 与文档。
- 失败时不展示任何 fallback 正文，也不把 deterministic scene 标记成 generated；成功的 live scene 才能写入 source: "generated"。

## 现状核对结论（实现前基线）

当前答案是“部分是，且不同角色的重试层级不一致；最终确实会 fallback”：

- src/game/application/server/ai/rpgAiClient.ts 只对 timeout、rate_limited、service_error、network_error 按角色 policy 自动重试。当前上限为 intent 1 次、opening 2 次、scene 2 次、world 3 次；empty_response 明确不重复相同请求。
- 开局链路由 createGame.ts 最多调用 live source 3 个候选尝试；openingGenerationSource.ts 对每次失败返回 fixture，生产 factory 虽把 allowFallback 设为 false，但 generateFallback 仍暴露 fixture，三次候选失败后 createGame 会显式调用它。因此开局是“候选重试后 fallback”。
- 场景链路的 liveScenePerformanceSource.ts 已有一次内容修复重试，并在仍失败时调用 deterministic scene；generatePendingScene.ts 对 generated proposal 审批失败还会再修复一次，最终因为 composition root 传入 allowDeterministicFallback: true 再写入 deterministic scene。move、take_item、investigate 的即时路径当前直接使用 deterministic scene；调查/移动的预生成队列未命中时也记录 linear_narrative_fallback。
- 世界演化链路的 liveWorldEvolutionSource.ts 在 AI 失败或输出无效时调用 deterministic proposal；evolveWorld.ts 在 source 失败或审批拒绝时还会再尝试 deterministic proposal，当前回合和 narrative coordinator 都允许这条路径。
- 自定义输入的 liveIntentParserSource.ts 在 AI 无响应、JSON 无效、意图不合法或越权时回到 ruleParse，当前不是“重试后 fallback”，而是几乎直接规则降级；intent policy 的自动 transport retry 上限还是 1。
- 战斗预热在 compositionRoot.ts 另起 deterministic fallback promise，live 预热失败时最后一击使用 deterministic scene，仍会把剧情与 AI 表演脱节。
- 客户端当前只有 pending/长时间等待和“重新检查生成状态”，没有持久化的 AI 失败态；轮询失败不会停止为 pending，亦没有一个真正重新触发 AI 的重试动作。

---

### Task 1: 建立稳定 AI 失败契约与可持久化的 narrative failed 状态

**Files:**
- Create: src/game/application/aiGenerationFailure.ts
- Test: src/game/application/aiGenerationFailure.test.ts
- Modify: src/game/domain/narrative.ts
- Modify: src/game/domain/storyState.ts
- Modify: src/game/application/gameSessionView.ts
- Modify: src/game/application/server/persistence/sqliteGameRepository.ts
- Modify: src/game/application/server/persistence/gameRepository.ts（如需要补充 CAS 结果类型）

**Interfaces:**
- Produces AiFailureKind = "AI_CALL_FAILED" | "AI_RESPONSE_INVALID"。
- Produces AiFailurePhase = "opening" | "intent" | "world" | "scene"。
- Produces NarrativeGenerationFailure = { kind: AiFailureKind; phase: "scene"; failedAt: string }；failedAt 只供审计/恢复，不投影给客户端。
- Extends NarrativeGenerationState with:

~~~ts
| {
    readonly status: "failed";
    readonly job: PendingNarrativeJob;
    readonly failure: NarrativeGenerationFailure;
  }
~~~

- Extends GameSessionView.narrativeGeneration to { status: "idle" | "pending" | "failed"; failureKind?: AiFailureKind }，失败时只投影分类，不投影 job、provider code 或错误正文。

- [ ] Step 1: 先写失败态与客户端投影的单元测试

~~~ts
it("projects only the stable AI failure kind", () => {
  const view = projectGameSessionView(world, {
    ...story,
    narrative: {
      ...story.narrative,
      generation: {
        status: "failed",
        job,
        failure: { kind: "AI_RESPONSE_INVALID", phase: "scene", failedAt: "2026-08-21T00:00:00.000Z" },
      },
    },
  }, 3, "ending-id");

  expect(view.narrativeGeneration).toEqual({
    status: "failed",
    failureKind: "AI_RESPONSE_INVALID",
  });
});
~~~

- [ ] Step 2: 运行测试确认新状态尚不存在

Run: npm test -- src/game/application/aiGenerationFailure.test.ts src/game/application/gameSessionView.test.ts

Expected: FAIL，原因是 failed generation variant 与稳定 failure projection 尚未定义。

- [ ] Step 3: 实现共享 failure 类型、schema 版本与安全投影

在 aiGenerationFailure.ts 中提供纯函数 classifyAiFailure(input)：transport/unavailable/timeout/rate-limit/service/empty response 映射为 AI_CALL_FAILED，JSON/schema/reference/approval/semantic rejection 映射为 AI_RESPONSE_INVALID；未知异常只映射为 AI_CALL_FAILED。在 narrative.ts 增加 failed variant，在 storyState.ts 将 STORY_STATE_SCHEMA_VERSION 从 4 提升到 5，并使所有 narrative default/record parser 能识别新 variant。任何旧版本返回 UNSUPPORTED_RECORD，不自动修复为 idle。

- [ ] Step 4: 运行类型与单元测试

Run: npm test -- src/game/application/aiGenerationFailure.test.ts src/game/application/gameSessionView.test.ts

Expected: PASS；npm run typecheck 不产生新的类型错误。

- [ ] Step 5: 提交

~~~bash
git add src/game/application/aiGenerationFailure.ts src/game/application/aiGenerationFailure.test.ts src/game/domain/narrative.ts src/game/domain/storyState.ts src/game/application/gameSessionView.ts src/game/application/server/persistence/sqliteGameRepository.ts src/game/application/server/persistence/gameRepository.ts
git commit -m "feat(ai): persist stable narrative generation failures"
~~~

### Task 2: 统一自动重试策略，移除 live source 的 deterministic fallback

**Files:**
- Modify: src/game/application/server/ai/rpgAiClient.ts
- Modify: src/game/application/server/ai/liveIntentParserSource.ts
- Modify: src/game/application/server/ai/liveScenePerformanceSource.ts
- Modify: src/game/application/server/ai/liveWorldEvolutionSource.ts
- Modify: src/game/application/server/ai/openingGenerationSource.ts
- Modify: src/game/application/server/ai/sourceFactory.ts
- Modify: src/game/application/sceneSource.ts
- Modify: src/game/application/worldEvolutionSource.ts
- Test: src/game/application/server/ai/rpgAiClient.test.ts
- Test: src/game/application/server/ai/liveIntentParserSource.test.ts
- Test: src/game/application/server/ai/liveScenePerformanceSource.test.ts
- Test: src/game/application/server/ai/worldEvolutionSource.test.ts
- Test: src/game/application/server/ai/openingGenerationSource.test.ts
- Test: src/game/application/server/ai/sourceFactory.test.ts

**Interfaces:**
- SceneSource.generateScene returns SceneSourceResult = { ok: true; proposal: ScenePerformanceProposal } | { ok: false; failure: NarrativeGenerationFailure }。
- WorldEvolutionSource.propose returns WorldEvolutionSourceResult = { ok: true; proposal: WorldDeltaProposal } | { ok: false; failure: NarrativeGenerationFailure }；proposal: null 不再代表“请换 deterministic source”。
- IntentParserSource 增加可区分的 AI failure result，不再把 AI failure 转给 ruleParse；显式 fixture source 仍可直接返回规则结果。
- OpeningGenerationSource 删除 generateFallback；生成失败抛出携带稳定 kind 的 AiGenerationError，由 createGame 负责返回失败。

- [ ] Step 1: 补充“无 fallback”回归测试

每个 live source 都增加以下断言：

~~~ts
it("returns a stable failure after retries instead of deterministic content", async () => {
  const source = createLiveScenePerformanceSource({ aiClient: alwaysInvalidClient });
  const result = await source.generateScene(context);

  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.failure.kind).toBe("AI_RESPONSE_INVALID");
  expect(deterministicNarrationSpy).not.toHaveBeenCalled();
});
~~~

同时覆盖 transport failure → AI_CALL_FAILED、invalid JSON/schema → AI_RESPONSE_INVALID、修复重试成功 → generated，以及重试次数达到上限后才返回失败。

- [ ] Step 2: 运行现有 AI source 测试确认旧 fallback 断言失败

Run: npm test -- src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/sourceFactory.test.ts

Expected: 现有 fallback 断言 FAIL，作为本次行为变更的红灯基线。

- [ ] Step 3: 保留 transport retry，增加结构 retry，删除 live fallback

保留 RpgAiClient 对瞬态 transport code 的 retry；将 intent policy 的 maxAttempts 从 1 调整为 2，使四个生产角色都至少有一次瞬态重试机会。empty_response 不重复同一 request，但由 source 以带修复原因的第二次内容请求处理。opening 保留 createGame 的最多三次候选生成循环；scene/world/intent 各增加一次带结构问题说明的 content repair request。任何 repair 仍失败都返回 typed failure。

删除 live source 对 createDeterministicSceneSource、createDeterministicEvolutionSource、createRuleIntentParser、createFixtureOpeningSource 的失败分支调用；删除 allowFallback 参数、fallbackScene/fallbackProposal 和 source 内的 partial fallback 修复。部分字段不能安全修复时整体返回 AI_RESPONSE_INVALID。

source factory 在运行时配置无效或 client 不存在时注入 unavailable source；不得返回 deterministic source。deterministic source 文件本身保留，供测试和显式 offline fixture composition 使用。

- [ ] Step 4: 运行 AI source 测试

Run: npm test -- src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/sourceFactory.test.ts

Expected: PASS；失败路径只返回 stable failure，成功路径只接受 generated proposal/result。

- [ ] Step 5: 提交

~~~bash
git add src/game/application/server/ai src/game/application/sceneSource.ts src/game/application/worldEvolutionSource.ts
git commit -m "refactor(ai): remove deterministic fallback from live sources"
~~~

### Task 3: 开局与自由输入失败直接返回可重试 API 错误

**Files:**
- Modify: src/game/application/createGame.ts
- Modify: src/game/application/performTurn.ts
- Modify: src/game/application/requestParser.ts
- Modify: src/game/application/server/compositionRoot.ts
- Modify: src/app/api/game/route.ts
- Modify: src/app/api/game/actions/route.ts
- Modify: src/components/gameActionRequest.ts
- Modify: src/components/NewGameSetupForm.tsx
- Modify: src/components/AdventureGameShell.tsx
- Test: src/game/application/createGame.test.ts
- Test: src/game/application/performTurn.test.ts
- Test: src/app/api/game/routeContract.test.ts
- Test: src/components/NewGameSetupForm.test.tsx
- Test: src/components/AdventureGameShell.test.tsx

**Interfaces:**
- CreateGameResult 增加 AI_GENERATION_FAILED，并携带安全 failureKind；不再返回 generationSource: "fallback"。
- performTurn 在意图 AI 失败时直接返回 AI_CALL_FAILED 或 AI_RESPONSE_INVALID 的安全错误结果；意图失败时不得写规则 state、event ledger 或 pending job。
- postAction 的 error/rejected outcome 保存 code 与原交互，允许 UI 用相同 free text 再发一次新 actionId。

- [ ] Step 1: 编写开局与 intent 失败测试

~~~ts
it("does not create a game when all opening AI attempts fail", async () => {
  const result = await createGame(input, { repository, source: alwaysFailingOpeningSource, now });
  expect(result).toEqual({ ok: false, code: "AI_GENERATION_FAILED", failureKind: "AI_CALL_FAILED" });
  expect(await repository.getCurrentGame()).toMatchObject({ ok: true, status: "none" });
});

it("does not rule-parse free text after AI intent failure", async () => {
  const result = await performTurn(command, { ...deps, intentParserSource: failingIntentSource });
  expect(result).toMatchObject({ ok: false, code: "AI_CALL_FAILED" });
  expect(repository.applyState).not.toHaveBeenCalled();
});
~~~

- [ ] Step 2: 移除 opening generateFallback 与 intent rule fallback

createGame 保留最多三次 live candidate/novelty 尝试；全部失败直接返回 AI_GENERATION_FAILED，不再调用 source.generateFallback。generationSource 只允许 generated，无法生成时不创建存档。performTurn 将 live intent failure 映射为安全 API error，规则 parser 仅能由显式 deterministic/fixture source 在测试或离线 composition 注入，不能作为 live source 的异常分支。

- [ ] Step 3: 在 action UI 保存可重试交互

AdventureGameShell 的 ActionFeedback 增加 retryable 与 interaction；收到 AI failure 时显示“AI 调用失败，请重试”或“AI 返回格式不符合要求，请重试”，并显示按钮“重试”。点击按钮使用同一 PlayerInteraction 再调用 postAction，由 helper 生成新的 UUID actionId；原失败请求没有规则写入，因此可以安全重复。

NewGameSetupForm 在 AI_GENERATION_FAILED 时显示相同的稳定文案，并把提交按钮文案切换为“重试生成”，保留用户填写的全部 setup 字段。

- [ ] Step 4: 运行 application、route 与组件测试

Run: npm run test:game-application -- createGame performTurn && npm run test:app -- routeContract && npm run test:components -- NewGameSetupForm AdventureGameShell

Expected: PASS；AI intent 失败不产生回合，开局失败不产生存档，两个 UI 都提供真实重试动作。

- [ ] Step 5: 提交

~~~bash
git add src/game/application/createGame.ts src/game/application/performTurn.ts src/game/application/requestParser.ts src/game/application/server/compositionRoot.ts src/app/api/game/route.ts src/app/api/game/actions/route.ts src/components/gameActionRequest.ts src/components/NewGameSetupForm.tsx src/components/AdventureGameShell.tsx
git commit -m "feat(ai): expose retryable opening and intent failures"
~~~

### Task 4: 场景/世界演化失败写入 failed state，而不是 deterministic scene

**Files:**
- Modify: src/game/application/evolveWorld.ts
- Modify: src/game/application/generatePendingScene.ts
- Modify: src/game/application/approveAndWriteScene.ts
- Modify: src/game/application/server/compositionRoot.ts
- Modify: src/game/application/server/battleScenePrewarm.ts
- Modify: src/game/application/server/ai/_shared/ensureCoordinator.ts
- Modify: src/game/application/server/persistence/sqliteGameRepository.ts
- Test: src/game/application/evolveWorld.test.ts
- Test: src/game/application/generatePendingScene.test.ts
- Test: src/game/application/server/battleScenePrewarm.test.ts
- Test: src/game/application/server/ai/_shared/ensureCoordinator.test.ts

**Interfaces:**
- GeneratePendingSceneResult 增加 failed；失败时必须先 CAS 持久化 generation: { status: "failed", job, failure }，再返回 failed。
- 新增 application helper markNarrativeGenerationFailed(repository, record, failure)，只允许将匹配的 pending job 转为 failed；CAS 失败返回 stale，不覆盖新 revision。
- ensureCoordinator.loadPending 对 failed 返回 failed，不自动重复请求；对 pending 才能启动后台任务。

- [ ] Step 1: 写失败持久化与不写世界演化的测试

~~~ts
it("persists scene AI failure and keeps the committed rule state", async () => {
  const before = await repository.getCurrentGame();
  const result = await generatePendingScene({ ...deps, sceneSource: alwaysFailingSceneSource });
  const after = await repository.getCurrentGame();

  expect(result).toBe("failed");
  expect(after.record.worldState).toEqual(before.record.worldState);
  expect(after.record.storyState.narrative.generation.status).toBe("failed");
  expect(after.record.storyState.narrative.generation.job.jobId).toBe(before.record.storyState.narrative.generation.job.jobId);
});

it("does not use deterministic world evolution after live proposal failure", async () => {
  const result = await evolveWorld({ ...input, source: failingWorldSource });
  expect(result.ok).toBe(false);
  expect(deterministicSourceSpy).not.toHaveBeenCalled();
});
~~~

- [ ] Step 2: 移除 scene/world 的编排 fallback

evolveWorld 只执行注入的 source 一次（source 内含 transport/content retry），失败或审批拒绝返回 stable failure；不再建立 deterministicSource 第二次 attempt。generatePendingScene 对世界演化失败、候选不足、scene source 失败、scene approval 失败和 write-back 前的异常统一调用 markNarrativeGenerationFailed，不写 currentScene、不清空 job、不提交预览世界。

对于 move、take_item、investigate：如果队列命中已审批的 generated 预生成叙事，仍可即时消费；如果未命中，AI mode 必须调用 live scene source，不能改用 createDeterministicSceneSource。只有显式 fixture/offline source 才能产生 deterministic scene。

- [ ] Step 3: 收口战斗预热

删除 battleSceneFallbackPromises、ensureBattleSceneFallback 以及所有 deterministic prewarm。prewarmBattleVictoryScene 只接受 generated proposal；预热失败后让正常 pending coordinator 调用 live source，最终失败则持久化 failed state。普通战斗回合仍不等待 narrative；战斗胜利的场景不会因为预热失败伪造 deterministic 结果。

- [ ] Step 4: 让 coordinator 停止自动轮询失败 job

后台执行返回 failed 时只记录稳定 failure kind；下一次 /narrative/ensure 对 failed job 返回 failed，不重新排队。手动 retry API 完成 failed→pending CAS 后才允许 coordinator 再跑。

- [ ] Step 5: 运行 application/server 测试

Run: npm run test:game-application && npm test -- src/game/application/server/battleScenePrewarm.test.ts src/game/application/server/ai/_shared/ensureCoordinator.test.ts

Expected: PASS；所有 AI failure 路径只保留 pending job + failed state，世界/场景状态无 deterministic 写入。

- [ ] Step 6: 提交

~~~bash
git add src/game/application/evolveWorld.ts src/game/application/generatePendingScene.ts src/game/application/approveAndWriteScene.ts src/game/application/server/compositionRoot.ts src/game/application/server/battleScenePrewarm.ts src/game/application/server/ai/_shared/ensureCoordinator.ts src/game/application/server/persistence/sqliteGameRepository.ts
git commit -m "feat(narrative): persist scene failures instead of fallback"
~~~

### Task 5: 扩展现有 ensure API 为 CAS 安全的手动重试入口

**Files:**
- Modify: src/app/api/game/narrative/ensure/route.ts
- Modify: src/game/application/requestParser.ts（或新增同目录的 ensure body parser）
- Modify: src/game/application/server/compositionRoot.ts
- Modify: src/game/application/server/persistence/gameRepository.ts
- Modify: src/game/application/server/persistence/sqliteGameRepository.ts
- Modify: src/components/gameActionRequest.ts
- Test: src/app/api/game/narrative/ensure/route.test.ts
- Test: src/game/application/server/compositionRoot.test.ts
- Test: src/components/gameActionRequest.test.ts

**Interfaces:**
- Request body 精确为 {} 或 { "retry": true }；其它字段、非 boolean retry、数组和未知字段均返回 INVALID_INPUT。
- ensureNarrativeScene({ retry?: boolean })：
  - pending + retry 任意值：复用当前 job，调用 coordinator ensure；
  - failed + retry: false/缺省：返回 { ok:false, code:"AI_GENERATION_FAILED", failureKind }，不调用 AI；
  - failed + retry:true：以当前 revision CAS 将同一 job 恢复为 pending，再调用 coordinator；
  - idle：返回 not_pending。
- Response 保留现有 result，失败增加安全 code/failureKind；不返回 provider code 或错误原文。

- [ ] Step 1: 先写 route contract 与 CAS retry 测试

~~~ts
it("retries the same failed job without creating a second action", async () => {
  const failed = await getRecordWithFailedNarrative();
  const response = await postEnsure({ retry: true });
  const retried = await repository.getCurrentGame();

  expect(response.status).toBe(200);
  expect(retried.record.storyState.narrative.generation.status).toBe("pending");
  expect(retried.record.storyState.narrative.generation.job.jobId)
    .toBe(failed.record.storyState.narrative.generation.job.jobId);
  expect(retried.record.worldState.eventLedger).toEqual(failed.record.worldState.eventLedger);
});
~~~

另测两个并发 retry 只有一个 CAS 成功，重复 retry 不增加 revision、不产生第二个 job。

- [ ] Step 2: 实现严格 body parser 与 failed→pending CAS

新增 retryNarrativeGeneration application/server 方法，读取当前 record，检查 generation.status === "failed"，复制原 job 写入 pending，使用 incrementRevision: false 的 compare-and-swap；如果 CAS stale，则重新读取并返回当前状态，不重复调用 AI。retry 成功后立即调用现有 BackgroundEnsureCoordinator.ensure。

- [ ] Step 3: 更新客户端 API helper

将 ensureNarrative() 改为 ensureNarrative(options?: { retry?: boolean }): Promise<EnsureNarrativeOutcome>，保留 response 的 failureKind，并新增 retryNarrative() 包装 ensureNarrative({ retry: true })。普通轮询不能偷偷传 retry。

- [ ] Step 4: 运行 route/application/helper 测试

Run: npm run test:app -- narrative/ensure && npm test -- src/game/application/server/compositionRoot.test.ts src/components/gameActionRequest.test.ts

Expected: PASS；只有用户点击重试才会重新发起 AI，轮询失败态只读不重试。

- [ ] Step 5: 提交

~~~bash
git add src/app/api/game/narrative/ensure/route.ts src/game/application/requestParser.ts src/game/application/server/compositionRoot.ts src/game/application/server/persistence/gameRepository.ts src/game/application/server/persistence/sqliteGameRepository.ts src/components/gameActionRequest.ts
git commit -m "feat(api): add CAS-safe narrative retry"
~~~

### Task 6: 增加失败提示与“重试”按钮，停止 failed 状态自动轮询

**Files:**
- Modify: src/components/CurrentGameScreen.tsx
- Modify: src/components/AdventureGameShell.tsx
- Modify: src/components/GenerationStatusModal.tsx
- Modify: src/app/globals.css
- Test: src/components/CurrentGameScreen.test.tsx
- Test: src/components/AdventureGameShell.test.tsx
- Test: src/components/GenerationStatusModal.test.tsx

**Interfaces:**
- GenerationStatusModal 新增 kind: "narrative-failure"、failureKind 和必需的 onRetry；按钮文案固定为 重试。
- CurrentGameScreen 只在 narrativeGeneration.status === "pending" 时启动轮询；failed 状态不自动调用 ensure，展示失败 modal。
- onRetryNarrative 必须调用 retryNarrative()，成功后重新读取 current view；不能只递增本地 nonce。

- [ ] Step 1: 写失败文案与交互测试

~~~tsx
it("shows the API call failure and retries through the API", async () => {
  render(<CurrentGameScreenWithFailedNarrative failureKind="AI_CALL_FAILED" />);

  expect(screen.getByRole("alert")).toHaveTextContent("AI 调用失败");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(retryNarrative).toHaveBeenCalledOnce();
});

it("shows invalid response copy without exposing provider details", async () => {
  render(<GenerationStatusModal kind="narrative-failure" failureKind="AI_RESPONSE_INVALID" onRetry={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent("AI 返回格式不符合要求");
  expect(screen.queryByText(/DeepSeek|JSON.parse|timeout|http/i)).not.toBeInTheDocument();
});
~~~

- [ ] Step 2: 实现 pending/failed 两种显示状态

pending 继续使用等待遮罩；failed 显示底层已提交的规则状态但锁住新的规则行动，提示“AI 调用失败，请重试”或“AI 返回格式不符合要求，请重试”，并提供唯一“重试”按钮。按钮请求成功后回到 pending，失败则保留 failure modal 并允许再次点击。删除“重新检查生成状态”在失败态的语义，普通轮询仍只负责 pending 的恢复。

- [ ] Step 3: 校验 revision 与竞态

applyResponse 继续拒绝旧 revision；retry response 返回后立即 fetch current，只有当前 view 仍是同一 failed job 时才更新状态。连续点击由 in-flight ref 禁止，按钮请求完成后恢复。

- [ ] Step 4: 运行组件测试

Run: npm run test:components -- CurrentGameScreen AdventureGameShell GenerationStatusModal

Expected: PASS；failed 不会产生自动轮询，点击“重试”真实调用 API 并恢复 pending。

- [ ] Step 5: 提交

~~~bash
git add src/components/CurrentGameScreen.tsx src/components/AdventureGameShell.tsx src/components/GenerationStatusModal.tsx src/app/globals.css
git commit -m "feat(ui): show AI failure and offer manual retry"
~~~

### Task 7: 更新剧情事实、离线 fixture 边界与回归验收

**Files:**
- Modify: docs/策划文档/运行时AI角色职责与生成规则.md
- Modify: docs/策划文档/AI生成RPG_MVP.md
- Modify: docs/agent/运行时AI导演与场景表演.md
- Modify: docs/agent/世界动态具象化.md
- Modify: docs/agent/NPC对话驱动叙事场景触发.md
- Modify: docs/agent/AI环境.md
- Modify: docs/agent/当前开发阶段.md
- Modify: docs/Agent文档索引.md
- Modify: docs/agent/无AI试玩验收.md（明确仅为显式 fixture/offline 回放）
- Modify: src/dependencyBoundaries.test.ts（若新增共享 application facade 或跨层 import）
- Test: src/game/application/testing/foundationJourney.test.ts
- Test: src/game/application/testing/narrativeGroundingJourney.test.ts
- Test: src/game/application/testing/dynamicMaterializationJourney.test.ts
- Test: src/game/application/testing/investigationChoiceJourney.test.ts
- Test: src/game/application/testing/storyDivergenceJourney.test.ts

**Interfaces:**
- 生产文档统一描述：AI 失败/输出不合法经过自动重试仍失败时，场景进入失败态，玩家点击“重试”重新调用 AI；不得写“同轨 deterministic fallback”。
- 离线 journey 明确通过显式 fixture source 注入，不代表生产 API 不可用时的行为。
- 真实 AI smoke 的成功判定从 generated | fallback 改为：成功必须 generated；失败必须返回 AI_CALL_FAILED 或 AI_RESPONSE_INVALID，不得将 fallback 计为成功或可玩通过。

- [ ] Step 1: 更新玩法与实现文档

删除或改写以下旧事实：

- 运行时AI角色职责与生成规则.md §7 的“整幕切换 deterministic fallback”；改为“自动 retry exhausted 后阻塞当前剧情并提示重试”。
- AI生成RPG_MVP.md §9 与验收中的“AI 不可用仍能完成一局”；改为“生产 AI 不可用时保留规则已提交状态并显示重试，离线可玩性只属于显式 fixture 回放”。
- runtime/world/NPC/AI environment agent 文档中的 fallback 率、fallback source 与生产 composition 描述，改为 stable failure + manual retry，并记录 failed → pending 的 CAS 恢复链。
- 当前阶段计划与索引补充 NarrativeGenerationState.failed、现有 ensure route retry body、schema v5 和生产必须配置 AI 的事实。

- [ ] Step 2: 更新离线测试装配

不删除 createDeterministicSceneSource、createDeterministicEvolutionSource、createFixtureOpeningSource 或 createRuleIntentParser；将生产 factory 与 fixture factory 分开。所有 no-AI journey 显式注入 fixture source，测试断言生产 source factory 在配置缺失时返回 unavailable/failure source，而不是 deterministic source。

- [ ] Step 3: 运行全量验收

~~~powershell
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
npm run build
npm run phase:status
~~~

真实 AI 验收另执行 npm run env:check 与受控 smoke；验收至少覆盖：transport failure、empty response、invalid JSON、schema invalid、越权引用、审批拒绝、manual retry success、manual retry second failure、reload 后失败态保持、两个并发 retry 只有一次 AI 调用、规则回合不重复写入、move/investigate 队列未命中时不走 deterministic scene。

- [ ] Step 4: 提交文档与验收调整

~~~bash
git add docs src/dependencyBoundaries.test.ts src/game/application/testing
git commit -m "docs(test): define manual retry contract for AI failures"
~~~

## 自审清单

- 现状问题已覆盖：transport retry、结构 retry 不一致、opening fallback、scene fallback、world fallback、intent rule fallback、battle prewarm fallback。
- 用户要求已逐项覆盖：失败/格式不对提示、失败态不再自动轮询、明确“重试”按钮、按钮再次调用 AI、同一 job/CAS 防重复规则回合。
- 没有新增 route；所有重试都复用 /api/game/narrative/ensure，自定义输入重试复用 /api/game/actions。
- 不会把真实 API 错误或模型原文发送到客户端；稳定 failure kind 足以区分“调用失败”和“返回格式不对”。
- deterministic source 没有被误删为测试能力，但已从 production AI failure path 和缺失配置 path 中移除。
- schema 版本、实现文档、玩法文档、索引和离线 fixture 边界都有明确任务。
