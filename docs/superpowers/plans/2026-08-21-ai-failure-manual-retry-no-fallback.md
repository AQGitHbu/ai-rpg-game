# AI 调用失败不再剧情降级、改为失败提示与手动重试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除生产运行链中所有由 AI 调用失败、空响应、非法 JSON、结构不符合或审批拒绝触发的确定性剧情 fallback；对可持久化的 pending 场景在重试耗尽后持久化稳定失败状态，开局与自由输入则直接返回同样的安全失败分类，向玩家明确提示失败原因，并通过现有叙事 ensure API 提供“重试”按钮重新调用 AI。

**Architecture:** 保留 RpgAiClient 对瞬态 transport 错误的自动重试，并把结构化输出修复重试统一收口到各 live source；live source 不再导入或调用 deterministic source，失败返回带稳定分类的错误结果。pending 场景失败后不清除 pending job，而是通过一次 CAS 将 NarrativeGenerationState 置为 failed；手动重试再以 CAS 将同一个 job 恢复为 pending，因此不会重复提交玩家行动、不会重新裁决规则状态，也不会让剧情跳到确定性支线。

**本计划遵循 canonical runtime 原则**：不新增版本化路由、不保留旧接口、不提供兼容层。所有修改直接作用于唯一的无版本后缀生产链（`createGame`、`performTurn`、`generatePendingScene`、`/api/game/*` routes）。需要破坏性调整时直接修改该链并同步测试与文档，符合 `游戏开发规范.md` § 2.1。

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

### 向后兼容性

- 破坏性更新 StoryState schema 版本（4 → 5）；不提供旧存档迁移。
- 开发环境只通过现有 `DELETE /api/game/dev/current` 或 repository 的 `clearCurrentGame()` 清理 current slot；不得直接删除 SQLite 文件、schema、其它表、worktree、`.foundation` 或 sibling 仓库。
- 旧 schema v4 记录必须返回 UNSUPPORTED_RECORD，禁止静默降级为 idle 或自动修复为 v5。
- 不新增不存在的 `npm run dev:clear-db` 命令；测试使用独占临时数据库并在测试结束时按现有 repository 流程清理 current slot。

### 环境变量

- 本次修改不新增环境变量。
- 现有 `AI_API_BASE_URL`、`AI_MODEL`、`AI_API_KEY`、`AI_OUTPUT_FORMAT`、`AI_RUNTIME_THINKING_ROLES` 保持不变。
- AI 配置缺失或无效时注入 unavailable source；需要 AI 的调用返回 `AI_CALL_FAILED`，不走确定性 fallback。
- `.env.example` 无需更新。

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
- Create: src/game/domain/narrativeGenerationFailure.ts
- Create: src/game/domain/narrativeGenerationFailure.test.ts
- Create: src/game/application/aiGenerationFailure.ts
- Create: src/game/application/aiGenerationFailure.test.ts
- Modify: src/game/domain/narrative.ts
- Test: src/game/domain/narrative.test.ts
- Modify: src/game/domain/storyState.ts
- Test: src/game/domain/storyState.test.ts
- Modify: src/game/application/gameSessionView.ts
- Test: src/game/application/gameSessionView.test.ts
- Modify: src/game/application/index.ts
- Modify: src/game/application/server/persistence/sqliteGameRepository.ts

**Interfaces:**
- Produces AiFailureKind = "AI_CALL_FAILED" | "AI_RESPONSE_INVALID"。
- Produces AiFailurePhase = "opening" | "intent" | "world" | "scene"。
- src/game/domain/narrativeGenerationFailure.ts produces the persistence-safe types:

~~~ts
export type AiFailureKind = "AI_CALL_FAILED" | "AI_RESPONSE_INVALID";
export type AiFailurePhase = "opening" | "intent" | "world" | "scene";

export type AiGenerationFailure = {
  readonly kind: AiFailureKind;
  readonly phase: AiFailurePhase;
};

export type NarrativeGenerationFailure = AiGenerationFailure & {
  readonly phase: "scene";
  readonly failedAt: string;
};
~~~

src/game/application/aiGenerationFailure.ts produces the server/application error class and maps internal source results to the domain-safe types. Domain code must not import this application file. The error class avoids TypeScript parameter-property syntax because the project runs Node type stripping in some smoke scripts:

~~~ts
import type {
  AiFailureKind,
  AiFailurePhase,
} from "@/game/domain/narrativeGenerationFailure";

export class AiGenerationError extends Error {
  readonly kind: AiFailureKind;
  readonly phase: AiFailurePhase;

  constructor(
    kind: AiFailureKind,
    phase: AiFailurePhase,
    message: string,
  ) {
    super(message);
    this.name = "AiGenerationError";
    this.kind = kind;
    this.phase = phase;
  }
}
~~~

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

Run: npm test -- src/game/domain/narrativeGenerationFailure.test.ts src/game/application/aiGenerationFailure.test.ts src/game/domain/narrative.test.ts src/game/domain/storyState.test.ts src/game/application/gameSessionView.test.ts

Expected: FAIL，原因是 failed generation variant 与稳定 failure projection 尚未定义。

- [ ] Step 3: 实现共享 failure 类型、schema 版本与安全投影

在 aiGenerationFailure.ts 中提供 classifyAiFailure(input: { readonly phase: AiFailurePhase; readonly category: "transport" | "unavailable" | "timeout" | "rate_limit" | "service_error" | "empty_response" | "invalid_json" | "invalid_schema" | "invalid_reference" | "approval_rejected" | "unknown" }): AiGenerationFailure：transport/unavailable/timeout/rate_limit/service_error/empty_response 映射为 AI_CALL_FAILED，JSON/schema/reference/approval/semantic rejection 映射为 AI_RESPONSE_INVALID；未知异常只映射为 AI_CALL_FAILED。在 narrative.ts 增加 failed variant，在 storyState.ts 将 STORY_STATE_SCHEMA_VERSION 从 4 提升到 5，并使所有 narrative default/record parser 能识别新 variant。任何旧版本返回 UNSUPPORTED_RECORD，不自动修复为 idle。application facade 只 re-export UI 所需的 AiFailureKind 类型，不 re-export server-only error class。

- [ ] Step 4: 运行类型与单元测试

Run: npm test -- src/game/domain/narrativeGenerationFailure.test.ts src/game/application/aiGenerationFailure.test.ts src/game/domain/narrative.test.ts src/game/domain/storyState.test.ts src/game/application/gameSessionView.test.ts

Expected: PASS；npm run typecheck 不产生新的类型错误。

- [ ] Step 5: 提交

~~~bash
git add src/game/domain/narrativeGenerationFailure.ts src/game/domain/narrativeGenerationFailure.test.ts src/game/application/aiGenerationFailure.ts src/game/application/aiGenerationFailure.test.ts src/game/domain/narrative.ts src/game/domain/narrative.test.ts src/game/domain/storyState.ts src/game/domain/storyState.test.ts src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts src/game/application/index.ts src/game/application/server/persistence/sqliteGameRepository.ts
git commit -m "feat(ai): persist stable narrative generation failures"
~~~

### Task 2: 统一自动重试策略，移除 live source 的 deterministic fallback

**Files:**
- Modify: src/game/application/server/ai/rpgAiClient.ts
- Modify: src/game/application/server/ai/liveIntentParserSource.ts
- Modify: src/game/application/server/ai/liveScenePerformanceSource.ts
- Modify: src/game/application/server/ai/liveWorldEvolutionSource.ts
- Modify: src/game/application/server/ai/intentParserSourceFactory.ts
- Modify: src/game/application/server/ai/openingGenerationSource.ts
- Modify: src/game/application/server/ai/sourceFactory.ts
- Modify: src/game/application/createGame.ts
- Modify: src/game/application/sceneSource.ts
- Modify: src/game/application/worldEvolutionSource.ts
- Modify: src/game/gameplay/rpg/intentParser/intentParserSource.ts
- Modify: src/game/application/deterministicSceneSource.ts
- Modify: src/game/application/deterministicEvolutionSource.ts
- Modify: src/game/application/deterministicSceneSource.test.ts
- Modify: src/game/application/deterministicEvolutionSource.test.ts
- Test: src/game/application/server/ai/rpgAiClient.test.ts
- Test: src/game/application/server/ai/liveIntentParserSource.test.ts
- Test: src/game/application/server/ai/liveScenePerformanceSource.test.ts
- Test: src/game/application/server/ai/worldEvolutionSource.test.ts
- Test: src/game/application/server/ai/openingGenerationSource.test.ts
- Test: src/game/application/server/ai/sourceFactory.test.ts
- Create: src/game/application/server/ai/intentParserSourceFactory.test.ts

**Interfaces:**
- SceneSource.generateScene returns SceneSourceResult = { ok: true; proposal: ScenePerformanceProposal } | { ok: false; failure: AiGenerationFailure }。
- WorldEvolutionSource.propose returns WorldEvolutionSourceResult = { ok: true; proposal: WorldDeltaProposal } | { ok: false; failure: AiGenerationFailure }；proposal: null 不再代表“请换 deterministic source”。
- IntentParserSource 增加可区分的 AI failure result：

~~~ts
import type { Action } from "@/game/domain/action";
import type { AiFailureKind } from "@/game/domain/narrativeGenerationFailure";

export type IntentParserResult =
  | { readonly ok: true; readonly action: Action }
  | { readonly ok: false; readonly reason: "unclassifiable" }
  | {
      readonly ok: false;
      readonly reason: "service_error";
      readonly failureKind: AiFailureKind;
    };
~~~

这里保留现有 action 字段和 fixture 的 unclassifiable 分支；live source 的 API/格式失败必须返回带 failureKind 的 service_error，不再转给 ruleParse。
- OpeningGenerationSource 删除 generateFallback；生成失败抛出携带稳定 kind 的 AiGenerationError，由 createGame 负责返回失败。
- **重试责任分层**：RpgAiClient 处理瞬态 transport 重试（timeout、rate_limit、5xx、network）；各 live source 处理内容修复重试（invalid JSON、schema violations、reference errors）。
- 显式 deterministic/fixture source 适配新的 result wrapper：成功返回 { ok: true, proposal }，不能让 production live source 在失败分支直接调用它。

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

Run: npm test -- src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/sourceFactory.test.ts src/game/application/server/ai/intentParserSourceFactory.test.ts src/game/application/deterministicSceneSource.test.ts src/game/application/deterministicEvolutionSource.test.ts

Expected: 现有 fallback 断言 FAIL，作为本次行为变更的红灯基线。

- [ ] Step 3: 保留 transport retry，增加结构 retry，删除 live fallback

保留 RpgAiClient 对瞬态 transport code 的 retry；将 intent policy 的 maxAttempts 从 1 调整为 2，使四个生产角色都至少有一次瞬态重试机会。empty_response 不重复同一 request，但由 source 以带修复原因的第二次内容请求处理。opening 保留 createGame 的最多三次候选生成循环；scene/world/intent 各增加一次带结构问题说明的 content repair request。任何 repair 仍失败都返回 typed failure。

删除 live source 对 createDeterministicSceneSource、createDeterministicEvolutionSource、createRuleIntentParser、createFixtureOpeningSource 的失败分支调用；删除 allowFallback 参数、fallbackScene/fallbackProposal 和 source 内用本地默认值、字段过滤或硬编码文本把非法响应转换成成功的 partial fallback 修复。首个 JSON/schema/reference 失败必须带错误说明发起 content repair request；repair 仍失败时整体返回 AI_RESPONSE_INVALID。opening 的三次尝试只用于有效候选的 novelty/语义重试，不得替代结构修复，也不得再调用 generateFallback。sourceFactory 与 intentParserSourceFactory 在 AI 配置不可用时分别注入 unavailable opening/scene/world/intent source；这些 source 只返回 typed failure，不调用 deterministic source。

source factory 在运行时配置无效或 client 不存在时注入 unavailable source；不得返回 deterministic source。deterministic source 文件本身保留，供测试和显式 offline fixture composition 使用。

- [ ] Step 4: 运行 AI source 测试

Run: npm test -- src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/sourceFactory.test.ts src/game/application/server/ai/intentParserSourceFactory.test.ts src/game/application/deterministicSceneSource.test.ts src/game/application/deterministicEvolutionSource.test.ts

Expected: PASS；失败路径只返回 stable failure，成功路径只接受 generated proposal/result。

- [ ] Step 5: 提交

~~~bash
git add src/game/application/server/ai src/game/application/createGame.ts src/game/application/sceneSource.ts src/game/application/worldEvolutionSource.ts src/game/gameplay/rpg/intentParser/intentParserSource.ts src/game/application/deterministicSceneSource.ts src/game/application/deterministicEvolutionSource.ts
git commit -m "refactor(ai): remove deterministic fallback from live sources"
~~~

### Task 3: 开局与自由输入失败直接返回可重试 API 错误

**Files:**
- Modify: src/game/application/createGame.ts
- Modify: src/game/application/performTurn.ts
- Modify: src/game/application/actionConverter.ts
- Modify: src/game/application/requestParser.ts
- Modify: src/game/application/server/compositionRoot.ts
- Modify: src/game/application/server/ai/intentParserSourceFactory.ts
- Modify: src/app/api/game/route.ts
- Modify: src/app/api/game/actions/route.ts
- Modify: src/components/gameActionRequest.ts
- Modify: src/components/NewGameSetupForm.tsx
- Modify: src/components/AdventureGameShell.tsx
- Test: src/game/application/createGame.test.ts
- Test: src/game/application/performTurn.test.ts
- Test: src/game/application/actionConverter.test.ts
- Test: src/app/api/game/routeContract.test.ts
- Test: src/components/NewGameSetupForm.test.tsx
- Test: src/components/AdventureGameShell.test.tsx

**Interfaces:**
- CreateGameResult 将旧的 GENERATION_FAILED 替换为 AI_GENERATION_FAILED，并携带安全 failureKind；不再返回 generationSource: "fallback"。
- compositionRoot 删除 openingGenerationSources、onResult/source marker 及 ServerGameEntryPoints 上的 generationSource 字段；AI 成功只由结果 code/view 体现，不保留 fallback 来源兼容字段。
- performTurn 在意图 AI 失败时直接返回 AI_CALL_FAILED 或 AI_RESPONSE_INVALID 的安全错误结果；意图失败时不得写规则 state、event ledger 或 pending job。
- performTurn 在为规则重演算调用 world AI source 失败时也直接返回 AI_CALL_FAILED 或 AI_RESPONSE_INVALID，不把 provider 失败伪装成 ACTION_REJECTED；该路径同样零写入并保留原 interaction 供客户端重试。
- ConvertResult 增加 { ok: false; reason: "ai_failure"; failureKind: AiFailureKind }；actionConverter 不再把 live intent failure 转成 focused NPC 的默认 ask 或 freeform action。
- postAction 的 error/rejected outcome 保存 code 与原交互，允许 UI 用相同 free text 再发一次新 actionId。
- create route 按 `result.failureKind` 将 `AI_CALL_FAILED`（以及缺失 failureKind 的 `AI_GENERATION_FAILED`）映射为 503，将 `AI_RESPONSE_INVALID` 映射为 502；不再把 AI 失败包装成 generationSource: "fallback"。

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

it("does not turn world AI failure into a rule rejection", async () => {
  const result = await performTurn(commandThatNeedsWorldEvolution, {
    ...deps,
    worldEvolutionSource: alwaysFailingWorldSource,
  });
  expect(result).toMatchObject({ ok: false, code: "AI_CALL_FAILED" });
  expect(repository.applyState).not.toHaveBeenCalled();
});
~~~

- [ ] Step 2: 移除 opening generateFallback 与 intent rule fallback

createGame 保留最多三次 live candidate/novelty 尝试；全部失败直接返回 AI_GENERATION_FAILED，不再调用 source.generateFallback。捕获 AiGenerationError 时保留其 failureKind；候选 parse、schema、引用、语义或 novelty 校验耗尽时归类为 AI_RESPONSE_INVALID，source 不可用/transport 失败归类为 AI_CALL_FAILED。generationSource 只允许 generated，无法生成时不创建存档。performTurn 将 live intent failure 映射为安全 API error，规则 parser 仅能由显式 deterministic/fixture source 在测试或离线 composition 注入，不能作为 live source 的异常分支。纯规则 preClassifyFreeText 仍可处理无需 AI 的明确实体输入，但它不是 AI 失败后的 fallback。CurrentGameScreen 不得在生产 AI 模式下用 setup.storyOpening 或硬编码文本替代空的 prologueText；有效 AI 存档必须由开局生成写入可展示的 generated prologue，异常空值按 AI_RESPONSE_INVALID 处理。

- [ ] Step 3: 在 action UI 保存可重试交互

AdventureGameShell 的 ActionFeedback 增加 retryable 与 interaction；收到 AI failure 时显示“AI 调用失败，请重试”或“AI 返回格式不符合要求，请重试”，并显示按钮“重试”。点击按钮使用同一 PlayerInteraction 再调用 postAction，由 helper 生成新的 UUID actionId；原失败请求没有规则写入，因此可以安全重复。

NewGameSetupForm 在 AI_GENERATION_FAILED 时显示相同的稳定文案，并把提交按钮文案切换为“重试”，保留用户填写的全部 setup 字段。

- [ ] Step 4: 运行 application、route 与组件测试

Run: npm run test:game-application -- createGame performTurn && npm run test:app -- routeContract && npm run test:components -- NewGameSetupForm AdventureGameShell

Expected: PASS；AI intent 失败不产生回合，开局失败不产生存档，两个 UI 都提供真实重试动作。actions route 将 AI_CALL_FAILED/AI_RESPONSE_INVALID 映射为 503/502，并在客户端保留可重试 code。

- [ ] Step 5: 提交

~~~bash
git add src/game/application/createGame.ts src/game/application/performTurn.ts src/game/application/requestParser.ts src/game/application/server/compositionRoot.ts src/app/api/game/route.ts src/app/api/game/actions/route.ts src/components/gameActionRequest.ts src/components/gameActionRequest.test.ts src/components/NewGameSetupForm.tsx src/components/NewGameSetupForm.test.tsx src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx src/game/application/createGame.test.ts src/game/application/performTurn.test.ts src/game/application/actionConverter.ts src/game/application/actionConverter.test.ts src/app/api/game/routeContract.test.ts
git commit -m "feat(ai): expose retryable opening and intent failures"
~~~

### Task 4: 场景/世界演化失败写入 failed state，而不是 deterministic scene

**Files:**
- Modify: src/game/application/evolveWorld.ts
- Modify: src/game/application/generatePendingScene.ts
- Create: src/game/application/markNarrativeGenerationFailed.ts
- Create: src/game/application/markNarrativeGenerationFailed.test.ts
- Modify: src/game/application/approveAndWriteScene.ts
- Modify: src/game/application/server/compositionRoot.ts
- Modify: src/game/application/server/battleScenePrewarm.ts
- Modify: src/game/application/server/ai/_shared/ensureCoordinator.ts
- Modify: src/game/application/server/persistence/sqliteGameRepository.ts
- Create: src/game/application/evolveWorld.test.ts
- Test: src/game/application/generatePendingScene.test.ts
- Test: src/game/application/server/battleScenePrewarm.test.ts
- Test: src/game/application/server/ai/_shared/ensureCoordinator.test.ts

**Interfaces:**
- GeneratePendingSceneResult 增加 failed；失败时必须先 CAS 持久化 generation: { status: "failed", job, failure }，再返回 failed。
- EvolveWorldResult 的失败分支按 discriminated union 携带稳定 failure：`no_need` 不带 failure；`source_error` 映射为 AI_CALL_FAILED；`no_proposal`、`rejected` 和 candidate shortage 映射为 AI_RESPONSE_INVALID，供 generatePendingScene 生成 phase: "scene" 的持久化 failure。
- 新增 application helper markNarrativeGenerationFailed，完整签名：

~~~ts
export async function markNarrativeGenerationFailed(
  repository: GameRepository,
  record: GameRecord,
  failure: NarrativeGenerationFailure
): Promise<
  | { readonly ok: true; readonly result: "failed" }
  | { readonly ok: false; readonly code: "STALE_GAME_REVISION" | "NO_ACTIVE_GAME" | "INFRASTRUCTURE_FAILURE" }
>
~~~

只允许将匹配的 pending job 转为 failed；使用 commitState 的 incrementRevision: false，CAS 失败映射为现有 repository code，不覆盖新 revision。若 scene write-back 已返回 stale，则不要再调用此 helper，以免覆盖可能已经成功写回的新场景。
- ensureCoordinator 的 EnsureResult 增加 "failed"；loadPending 对 failed 返回 failed，不自动重复请求；对 pending 才能启动后台任务。

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

evolveWorld 只执行注入的 source 一次（source 内含 transport/content retry），失败或审批拒绝返回带 AiGenerationFailure 的 stable failure；source 缺失也只能返回 AI_CALL_FAILED，不得在 application 层创建 deterministic source，也不再建立 deterministicSource 第二次 attempt。generatePendingScene 对世界演化失败、候选不足、scene source 失败、scene approval 失败和 write-back 前的异常统一调用 markNarrativeGenerationFailed，不写 currentScene、不清空 job、不提交预览世界。scene write-back 返回 stale 时直接返回 stale，不把新 revision 覆盖成 failed。

对于 move、take_item、investigate：如果队列命中已审批的 generated 预生成叙事，仍可即时消费；如果未命中，AI mode 必须调用注入的 live scene source，不能在 generatePendingScene 内直接创建 createDeterministicSceneSource。删除该 production fast path 的隐式 deterministic source；只有显式 fixture/offline composition 注入的 source 才能产生 deterministic scene。队列命中只能复用已审批的 generated 文本，不能把新的 live 失败改写成 deterministic 成功。

- [ ] Step 3: 收口战斗预热

删除 battleSceneFallbackPromises、ensureBattleSceneFallback 以及所有 deterministic prewarm。prewarmBattleVictoryScene 只接受 generated proposal；预热失败后让正常 pending coordinator 调用 live source，最终失败则持久化 failed state。普通战斗回合仍不等待 narrative；战斗胜利的场景不会因为预热失败伪造 deterministic 结果。

- [ ] Step 4: 让 coordinator 停止自动轮询失败 job

后台执行返回 failed 时只记录稳定 failure kind；下一次 /narrative/ensure 对 failed job 返回 failed，不重新排队。手动 retry API 完成 failed→pending CAS 后才允许 coordinator 再跑。

- [ ] Step 5: 运行 application/server 测试

Run: npm run test:game-application && npm test -- src/game/application/server/battleScenePrewarm.test.ts src/game/application/server/ai/_shared/ensureCoordinator.test.ts

Expected: PASS；所有 AI failure 路径只保留 pending job + failed state，世界/场景状态无 deterministic 写入。

- [ ] Step 6: 提交

~~~bash
git add src/game/application/evolveWorld.ts src/game/application/evolveWorld.test.ts src/game/application/generatePendingScene.ts src/game/application/generatePendingScene.test.ts src/game/application/markNarrativeGenerationFailed.ts src/game/application/markNarrativeGenerationFailed.test.ts src/game/application/approveAndWriteScene.ts src/game/application/server/compositionRoot.ts src/game/application/server/battleScenePrewarm.ts src/game/application/server/battleScenePrewarm.test.ts src/game/application/server/ai/_shared/ensureCoordinator.ts src/game/application/server/ai/_shared/ensureCoordinator.test.ts src/game/application/server/persistence/sqliteGameRepository.ts
git commit -m "feat(narrative): persist scene failures instead of fallback"
~~~

### Task 5: 扩展现有 ensure API 为 CAS 安全的手动重试入口

**Files:**
- Modify: src/app/api/game/narrative/ensure/route.ts
- Modify: src/game/application/requestParser.ts
- Create: src/game/application/retryNarrativeGeneration.ts
- Create: src/game/application/retryNarrativeGeneration.test.ts
- Modify: src/game/application/server/compositionRoot.ts
- Modify: src/game/application/server/persistence/sqliteGameRepository.ts
- Modify: src/components/gameActionRequest.ts
- Create: src/app/api/game/narrative/ensure/route.test.ts
- Test: src/game/application/server/compositionRoot.test.ts
- Test: src/components/gameActionRequest.test.ts

**Interfaces:**
- Request body 精确为 {} 或 { "retry": true }；其它字段、非 boolean retry、数组和未知字段均返回 INVALID_INPUT。
- Request body parser 扩展现有 requestParser.ts，新增精确结果类型与函数：

~~~ts
export type EnsureNarrativeBodyResult =
  | { readonly ok: true; readonly retry?: true }
  | { readonly ok: false; readonly code: "INVALID_INPUT" };

export function parseEnsureNarrativeBody(body: unknown): EnsureNarrativeBodyResult;
~~~

只接受 `{}` 或 `{ "retry": true }`；其它返回 INVALID_INPUT。
- ensureNarrativeScene({ retry?: true })：
  - pending + retry 缺省或 true：复用当前 job，调用 coordinator ensure；
  - failed + retry 缺省：返回 { ok:false, code:"AI_GENERATION_FAILED", failureKind }，不调用 AI；
  - failed + retry:true：以当前 revision CAS 将同一 job 恢复为 pending，再调用 coordinator；
  - idle：返回 not_pending。
- ServerGameEntryPoints 的 `ensureNarrativeScene` 直接接收已解析的 `{ retry?: true }` 与现有 traceId；route 不把原始 body 透传到 use case。
- Response 保留现有 result，失败增加安全 code/failureKind；不返回 provider code 或错误原文。
- coordinator 返回 `failed` 时，composition root 读取当前 failed generation 的稳定 failureKind 并返回 `AI_GENERATION_FAILED`；不得把 `failed` 当成 HTTP 成功或继续触发后台任务。
- Route status mapping must return 400 for INVALID_INPUT, 503 for direct AI_CALL_FAILED or AI_GENERATION_FAILED with failureKind AI_CALL_FAILED, 502 for direct AI_RESPONSE_INVALID or AI_GENERATION_FAILED with failureKind AI_RESPONSE_INVALID, 409 only for stale revision, 404 for NO_ACTIVE_GAME, and 200 for queued/already-running/not-pending results.

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

在 src/game/application/retryNarrativeGeneration.ts 新增 retryNarrativeGeneration(repository, gameId, now) use case：读取当前 record，检查 generation.status === "failed"，复制原 job 写入 pending，使用 incrementRevision: false 的 compare-and-swap；如果 CAS stale，则重新读取并返回当前状态，不重复调用 AI。composition root 在该 use case 成功后立即调用现有 BackgroundEnsureCoordinator.ensure。

- [ ] Step 3: 更新客户端 API helper

将 ensureNarrative() 改为 ensureNarrative(options?: { retry?: true }): Promise<EnsureNarrativeOutcome>，普通轮询明确发送 body {}；保留 response 的 failureKind，并新增 retryNarrative() 包装 ensureNarrative({ retry: true })。普通轮询不能偷偷传 retry。定义 `EnsureNarrativeOutcome`：

~~~ts
type EnsureNarrativeOutcome =
  | { readonly ok: true; readonly result: "queued" | "already_running" | "not_pending" }
  | {
      readonly ok: false;
      readonly code: "INVALID_INPUT" | "NO_ACTIVE_GAME" | "STALE_GAME_REVISION" | "AI_GENERATION_FAILED" | "AI_CALL_FAILED" | "AI_RESPONSE_INVALID" | "INFRASTRUCTURE_FAILURE";
      readonly failureKind?: AiFailureKind;
    };
~~~

让 CurrentGameScreen 能区分失败态而不是只得到 boolean。

- [ ] Step 4: 运行 route/application/helper 测试

Run: npm run test:app -- narrative/ensure && npm test -- src/game/application/server/compositionRoot.test.ts src/components/gameActionRequest.test.ts

Expected: PASS；只有用户点击重试才会重新发起 AI，轮询失败态只读不重试。

- [ ] Step 5: 提交

~~~bash
git add src/app/api/game/narrative/ensure/route.ts src/app/api/game/narrative/ensure/route.test.ts src/game/application/requestParser.ts src/game/application/retryNarrativeGeneration.ts src/game/application/retryNarrativeGeneration.test.ts src/game/application/server/compositionRoot.ts src/game/application/server/compositionRoot.test.ts src/game/application/server/persistence/sqliteGameRepository.ts src/components/gameActionRequest.ts src/components/gameActionRequest.test.ts
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
- GenerationStatusModal 新增 props 类型：

~~~ts
type GenerationStatusModalProps =
  | {
      readonly kind: "narrative-failure";
      readonly failureKind: AiFailureKind;
      readonly onRetry: () => void | Promise<void>;
      readonly battleVisible?: boolean;
    }
  | {
      readonly kind: "creation" | "narrative" | "action";
      readonly onRetry?: () => void | Promise<void>;
      readonly battleVisible?: boolean;
    };
~~~

保留现有 creation/narrative/action 三种调用合同，新增 kind: "narrative-failure"；该 kind 必须提供 failureKind 和 onRetry，按钮文案固定为 重试。不要新增 onCancel，因为当前 modal 没有取消语义。
- CurrentGameScreen 只在 narrativeGeneration.status === "pending" 时启动轮询；failed 状态不自动调用 ensure，展示失败 modal。
- onRetryNarrative 必须调用 retryNarrative()，成功后重新读取 current view；不能只递增本地 nonce。

- [ ] Step 1: 写失败文案与交互测试

~~~tsx
it("shows the API call failure and retries through the API", async () => {
  vi.mocked(fetchCurrentGame).mockResolvedValue({
    ok: true,
    status: "active",
    view: {
      ...activeViewWithPrologue,
      prologueShown: true,
      narrativeGeneration: { status: "failed", failureKind: "AI_CALL_FAILED" },
    },
  });
  render(<CurrentGameScreen />);

  expect(screen.getByRole("alert")).toHaveTextContent("AI 调用失败");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(retryNarrative).toHaveBeenCalledOnce();
});

it("shows invalid response copy without exposing provider details", async () => {
  render(<GenerationStatusModal kind="narrative-failure" failureKind="AI_RESPONSE_INVALID" onRetry={vi.fn()} />);
  expect(screen.getByRole("alert")).toHaveTextContent("AI 返回格式不符合要求");
  expect(screen.queryByText(/DeepSeek|JSON.parse|timeout|http/i)).not.toBeInTheDocument();
});

it("does not replace an empty AI prologue with the player's setup text", async () => {
  vi.mocked(fetchCurrentGame).mockResolvedValue({
    ok: true,
    status: "active",
    view: {
      ...activeViewWithPrologue,
      prologueText: "",
      setup: { ...activeViewWithPrologue.setup, storyOpening: "玩家自定义故事开端" },
      narrativeGeneration: { status: "failed", failureKind: "AI_RESPONSE_INVALID" },
    },
  });
  render(<CurrentGameScreen />);
  expect(screen.queryByText("玩家自定义故事开端")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("AI 返回格式不符合要求");
});
~~~

- [ ] Step 2: 实现 pending/failed 两种显示状态

pending 继续使用等待遮罩；failed 显示底层已提交的规则状态但锁住新的规则行动，提示“AI 调用失败，请重试”或“AI 返回格式不符合要求，请重试”，并提供唯一“重试”按钮。AdventureGameShell 的 busy 判定必须包含 failed，确保失败 modal 仍然锁住操作。按钮请求成功后回到 pending，失败则保留 failure modal 并允许再次点击。删除“重新检查生成状态”在失败态的语义，普通轮询仍只负责 pending 的恢复；失败文案使用 p[role="alert"]。

- [ ] Step 3: 校验 revision 与竞态

applyResponse 继续拒绝旧 revision；retry response 返回后立即 fetch current，只有当前 view 仍是同一 failed job 时才更新状态。连续点击由 in-flight ref 禁止，按钮请求完成后恢复。

- [ ] Step 4: 运行组件测试

Run: npm run test:components -- CurrentGameScreen AdventureGameShell GenerationStatusModal

Expected: PASS；failed 不会产生自动轮询，点击“重试”真实调用 API 并恢复 pending。

- [ ] Step 5: 提交

~~~bash
git add src/components/CurrentGameScreen.tsx src/components/CurrentGameScreen.test.tsx src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx src/components/GenerationStatusModal.tsx src/components/GenerationStatusModal.test.tsx src/app/globals.css
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
- Modify: docs/agent/无AI试玩验收.md（明确该文档仅描述显式 fixture source 的离线回放验证，不代表生产 AI 不可用时的用户体验）
- Modify: scripts/phase4bAiSmoke.mjs
- Test: scripts/phase4bAiSmoke.node-test.mjs
- Modify: src/game/application/testing/foundationJourney.testutil.ts
- Modify: src/game/application/testing/investigationFlowJourney.test.ts
- Modify: src/game/application/testing/mediumActJourney.test.ts
- Test: src/game/application/testing/foundationJourney.test.ts
- Test: src/game/application/testing/narrativeGroundingJourney.test.ts
- Test: src/game/application/testing/dynamicMaterializationJourney.test.ts
- Test: src/game/application/testing/investigationChoiceJourney.test.ts
- Test: src/game/application/testing/storyDivergenceJourney.test.ts

**Interfaces:**
- 生产文档统一描述：AI 失败/输出不合法经过自动重试仍失败时，场景进入失败态，玩家点击“重试”重新调用 AI；不得写“同轨 deterministic fallback”。
- 离线 journey 明确通过显式 fixture source 注入，不代表生产 API 不可用时的行为。
- 真实 AI smoke 的成功判定从 generated | fallback 改为：成功必须 generated；失败必须暴露稳定 `failureKind`（AI_CALL_FAILED 或 AI_RESPONSE_INVALID；开局外层 code 为 AI_GENERATION_FAILED），不得将 fallback 计为成功或可玩通过。

- [ ] Step 1: 更新玩法与实现文档

删除或改写以下旧事实：

- 运行时AI角色职责与生成规则.md §7 的“整幕切换 deterministic fallback”；改为“自动 retry exhausted 后阻塞当前剧情并提示重试”。
- AI生成RPG_MVP.md §9 与验收中的“AI 不可用仍能完成一局”；改为“生产 AI 不可用时保留规则已提交状态并显示重试，离线可玩性只属于显式 fixture 回放”。
- runtime/world/NPC/AI environment agent 文档中的 fallback 率、fallback source 与生产 composition 描述，改为 stable failure + manual retry，并记录 failed → pending 的 CAS 恢复链。
- 当前阶段计划与索引补充 NarrativeGenerationState.failed、现有 ensure route retry body、schema v5 和生产必须配置 AI 的事实；不要把“生产 AI 不可用仍走 fallback”保留在任何 canonical 文档中。

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
git add docs scripts/phase4bAiSmoke.mjs scripts/phase4bAiSmoke.node-test.mjs src/game/application/testing
git commit -m "docs(test): define manual retry contract for AI failures"
~~~

## 自审清单

- 现状问题已覆盖：transport retry、结构 retry 不一致、opening fallback、scene fallback、world fallback、intent rule fallback、battle prewarm fallback。
- 用户要求已逐项覆盖：失败/格式不对提示、失败态不再自动轮询、明确“重试”按钮、按钮再次调用 AI、同一 job/CAS 防重复规则回合。
- 没有新增 route；场景失败重试复用 /api/game/narrative/ensure，开局失败重试复用现有 /api/game，自定义输入重试复用 /api/game/actions。
- 不会把真实 API 错误或模型原文发送到客户端；稳定 failure kind 足以区分“调用失败”和“返回格式不对”。
- deterministic source 没有被误删为测试能力，但已从 production AI failure path 和缺失配置 path 中移除。
- schema 版本、实现文档、玩法文档、索引和离线 fixture 边界都有明确任务。
