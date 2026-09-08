# AI 文本与游戏 API 完整审计记录实施计划

> **For implementation:** Execute the tasks in order, keeping the checkbox state up to date. Each task should pass its focused tests before moving to the next task.

**Goal:** 增加一个默认开启、显式关闭的本地 AI 文本审计模式，完整记录游戏 API 语义输入输出、四类 AI 调用的完整 messages/模型结果、触发动作/用途和最终玩家可见文本，以支持完整游戏还原与后续 prompt 审核。

**Architecture:** 新增 RPG 专属的 append-only 审计日志，不复用普通诊断日志的脱敏和事件大小截断路径。`RpgAiClient` 统一记录所有 provider 调用；composition root 的 `executeHttpRequest` 记录所有游戏 HTTP API 的原始 body/response body（包括路由校验失败）；场景审批后的最终文本记录为独立 story 事件。所有记录通过 `runId/gameId/traceId/jobId/turnNumber` 关联；默认开启，首次事件写入时落到 `logs/ai-text-audit/<runId>/events.jsonl`（runId 取 `AI_TEXT_AUDIT_RUN_ID`，缺省由 recorder 创建时间派生并转为安全路径片段），只有显式 `AI_TEXT_AUDIT=off` 才完全不创建审计文件。审计类型契约放在 `application/server/ai/textAuditTypes.ts` 并作为第二个纯端口向 application 本体开放（与 `gameRepository` 纯端口同一纪律，需同步扩展边界守卫许可清单）。

**Tech Stack:** TypeScript strict、Next.js server-only、Node `fs/promises` JSONL、Vitest、现有 `RpgAiClient`/composition root/SQLite repository。

## Global Constraints

- 完整审计默认开启；`AI_TEXT_AUDIT` 缺失、空白或非 `off` 值均按 `full` 处理，只有 trim 后明确等于 `off` 才关闭；客户端不能开启或读取审计内容。
- 审计日志可以保存本游戏的完整语义文本、prompt、模型正文、玩家输入和游戏 API body；仍不得保存 `AI_API_KEY`、Authorization、cookie 或完整请求 URL。
- 游戏 API 审计记录保存请求/响应原始 body、HTTP method/route/status 和 traceId；不保存请求头，路由异常只记录稳定错误名，不记录异常 message/stack。
- 审计日志不是游戏状态源；游戏事务、CAS、fallback 和主流程不能因审计写入失败而失败。
- 普通 `GameLogger`/`data/logs.db` 继续用于稳定诊断；完整文本写入 `logs/ai-text-audit/<runId>/events.jsonl`，不经过普通日志的递归脱敏和 128 KiB 截断。
- 不修改 `@ai-game/*` foundation package；共享日志规范只通过本仓 RPG 规则和审计记录器适配。
- 不恢复旧的 director/writer/NPC 三角色质量评估体系；旧量表和历史实现事实标记为 retired，不再作为当前质量标准。
- 任何新增 server-only 文件不得被客户端 facade、UI、API route 直接导入；API route 继续只调用 application/server composition root。
- 验收至少运行 `npm run typecheck`、`npm run test:boundaries`、相关 Vitest 测试和 `npm run test:game-application`。

---

### Task 1: 明确审计事件契约与文件记录器

**Files:**
- Create: `src/game/application/server/ai/textAuditTypes.ts`
- Create: `src/game/application/server/ai/textAuditRecorder.ts`
- Test: `src/game/application/server/ai/textAuditRecorder.test.ts`
- Modify: `src/dependencyBoundaries.test.ts`

**Interfaces:**
- `textAuditTypes.ts` 只产生 `AiTextAuditMode`、`AiTextAuditRole`、`AiTextAuditLink`、`AiTextAuditContext`、`AiTextAuditPayload`、`AiTextAuditEntry` 和 `AiTextAuditRecorder` 类型；所有共享包引用必须是 `import type`，不能有 env/fs/transport 运行时依赖。
- `textAuditRecorder.ts` 产生 `createTextAuditRecorder(env, options?)`。`AiTextAuditRecorder.record(payload): Promise<void>` 是 best-effort、永不把写入异常抛回游戏主流程；`enabled: boolean` 便于启动诊断和测试；`close(): Promise<void>` 等待写入队列并吞掉关闭异常。
- recorder options 至少包含 `rootDir?`、`now?`、`onWriteFailure?: () => void` 和 `onConfigIssue?: (code: "invalid_run_id") => void`。写入失败只通过该 callback 让 composition root 调用普通 logger 的稳定事件 `ai_text_audit_write_failed`，非法 runId 只调用稳定配置告警，任何完整异常文本都不得再次写回审计文件。
- `src/dependencyBoundaries.test.ts` 把 `./server/ai/textAuditTypes` 加入 application 本体允许的纯端口清单（现有 `./server/persistence/gameRepository` 改为多项清单），并补一条 `generatePendingScene.ts` 实际导入该端口的非空转断言。

- [ ] **Step 1: Write failing tests for default-on, explicit-off and full append-only capture**

覆盖以下行为（测试文件顶部加 `// @vitest-environment node`，与 compositionRoot 测试同惯例）：

```ts
const recorder = createTextAuditRecorder({}, { rootDir: tempDir });
await recorder.record({ kind: "ai_call", ...fixtureCall });
// 无 AI_TEXT_AUDIT_RUN_ID 时 runId 由 now() 派生，文件仍写入 <rootDir>/<runId>/ 子目录
const runDirs = await fs.readdir(tempDir);
expect(runDirs).toHaveLength(1);
expect(await listFiles(path.join(tempDir, runDirs[0]))).toContain("events.jsonl");

const disabled = createTextAuditRecorder({ AI_TEXT_AUDIT: "off" }, { rootDir: tempDir });
await disabled.record({ kind: "ai_call", ...fixtureCall });
expect(disabled.enabled).toBe(false);
expect(await fs.readdir(tempDir)).toHaveLength(1); // 关闭实例不创建新 run 目录

const full = createTextAuditRecorder(
  { AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_RUN_ID: "run-test" },
  { rootDir: tempDir, now: () => "2026-08-20T00:00:00.000Z" },
);
await full.record({
  kind: "ai_call",
  callId: "call-1",
  role: "scene",
  context: { purpose: "scene_performance", trigger: "talk_choice", gameId: "game-1" },
  input: { messages: [{ role: "system", content: "完整 prompt" }] },
  output: { ok: true, content: "完整模型正文", latencyMs: 1 },
});
await full.close();
const rows = readJsonLines(path.join(tempDir, "run-test", "events.jsonl"));
expect(rows[0]).toMatchObject({ kind: "ai_call", input: { messages: [{ content: "完整 prompt" }] } });
expect(rows[0]).toMatchObject({ output: { content: "完整模型正文" } });
```

另加一条超过 131072 bytes 的正文测试，证明审计日志不会复用普通日志的截断逻辑；并验证记录失败时 `record()` resolve 而不是 throw、`onWriteFailure` 被调用。

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/game/application/server/ai/textAuditRecorder.test.ts`

Expected: FAIL because the recorder and types do not exist.

- [ ] **Step 3: Implement the typed append-only JSONL recorder**

事件契约至少包含：

```ts
type AiTextAuditContext = {
  readonly purpose:
    | "opening_generation"
    | "intent_parsing"
    | "world_evolution"
    | "scene_performance"
    | "final_story_text"
    | "game_api";
  readonly trigger: string;
  readonly gameId?: string;
  readonly traceId?: string;
  readonly jobId?: string;
  readonly actionId?: string;
  readonly turnNumber?: number;
  readonly revision?: number;
  readonly action?: unknown;
  /** 内容修复重试编号与拒绝原因（scene/opening 的 repair 路径）。 */
  readonly repair?: { readonly attempt: number; readonly reason: string };
};

/** role 的唯一契约来源，避免 textAuditTypes 与 rpgAiClient 互相 import 形成循环。 */
type AiTextAuditRole = "intent" | "opening" | "scene" | "world";

type AiTextAuditLink = Readonly<Pick<AiTextAuditContext, "traceId" | "gameId" | "jobId" | "turnNumber">>;

type AiTextAuditRequestOptions = Readonly<{
  readonly timeoutMs?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly jsonMode?: "json_object" | "prompt_only";
  readonly thinking?: "on" | "off";
}>;

/** 所有事件共享的公共信封：递增序号 + ISO 时间戳（来自 options.now）。 */
type AiTextAuditEnvelope = {
  readonly sequence: number;
  readonly timestamp: string;
};

type AiTextAuditPayload =
  | { readonly kind: "ai_call"; readonly callId: string; readonly role: AiTextAuditRole; readonly attempt: number; readonly context: AiTextAuditContext; readonly input: { readonly messages: readonly AiMessage[]; readonly options?: AiTextAuditRequestOptions }; readonly output: AiCompletionResult }
  | { readonly kind: "game_api"; readonly route: string; readonly method: string; readonly context: AiTextAuditContext; readonly request: { readonly rawBody: string | null; readonly json?: unknown }; readonly response: { readonly rawBody: string | null; readonly json?: unknown; readonly errorName?: string }; readonly httpStatus: number }
  | { readonly kind: "story_text"; readonly context: AiTextAuditContext; readonly source: "generated" | "fallback" | "deterministic"; readonly path?: "normal" | "prewarmed"; readonly scene?: unknown; readonly visibleText: unknown };

type AiTextAuditEntry = AiTextAuditPayload & AiTextAuditEnvelope;
```

`AiMessage`、`AiCompletionResult` 从 `@ai-game/ai-transport` 以 type-only 方式导入（成功/失败共用该 union，含 `content`/`code`/`latencyMs`/`usage`/`finishReason`）；`AiTextAuditRole` 在本文件定义，`rpgAiClient.ts` 复用该类型，不反向 import。`AiTextAuditRequestOptions` 是审计本地投影，不是 foundation 导出；只能写入 `timeoutMs`、`temperature`、从 `extraBody.max_tokens` 投影的 `maxTokens`、`response_format` 投影的 `jsonMode` 和 `thinking`，不能把 transport config、API key、Authorization、`AbortSignal` 或 `extraBody` 原文写入记录。`record()` 的入参是 `AiTextAuditPayload`，不含 `sequence/timestamp`；recorder 负责附加公共信封后落盘。文件写入使用单一 `events.jsonl`：路径恒为 `<rootDir>/<runId>/events.jsonl`（`rootDir` 取 `options.rootDir`，缺省为 env `AI_TEXT_AUDIT_DIR`，再缺省 `logs/ai-text-audit`；`runId` 取 env `AI_TEXT_AUDIT_RUN_ID`，缺省由 `now()` 派生一次并固定）。显式 runId 必须是单一安全路径片段；空值、`.`、`..` 或含 `/`、`\\` 的值不能直接作为路径，改用安全的自动 runId 并调用稳定配置告警。自动 runId 把 ISO 时间戳中的 `:` 等路径非法字符替换为 `-`。并发 `record()` 由 recorder 内部串行化（promise 链），保证 `sequence` 递增且与落盘顺序一致；关闭模式在首次 record 前不创建目录或文件。

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npx vitest run src/game/application/server/ai/textAuditRecorder.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/game/application/server/ai/textAuditTypes.ts src/game/application/server/ai/textAuditRecorder.ts src/game/application/server/ai/textAuditRecorder.test.ts src/dependencyBoundaries.test.ts
git commit -m "feat: add full AI text audit recorder"
```

### Task 2: 在统一 RpgAiClient 记录所有 provider 输入输出

**Files:**
- Modify: `src/game/application/server/ai/rpgAiClient.ts`
- Modify: `src/game/application/server/ai/rpgAiClient.test.ts`
- Modify: `src/game/application/server/ai/liveIntentParserSource.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts`
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts`
- Modify: `src/game/application/server/ai/liveScenePerformanceSource.ts`
- Modify: `src/game/application/worldEvolutionSource.ts`
- Modify: `src/game/gameplay/rpg/intentParser/intentParserSource.ts`
- Modify: `src/game/application/actionConverter.ts`

**Interfaces:**
- `RpgAiRole` reuses the `AiTextAuditRole` union from `textAuditTypes.ts`; `textAuditTypes.ts` never imports `rpgAiClient.ts`, eliminating a type-cycle.
- `RpgAiClient.complete(role, messages, context?)` gains an optional `AiTextAuditContext`.
- `CreateRpgAiClientOptions` gains `auditRecorder?: AiTextAuditRecorder`.
- `createServerRpgAiClient(env, logger?, auditRecorder?)` 同步增加可选 `auditRecorder` 参数并透传给 `createRpgAiClient`——生产 client 由该工厂在 composition root 内创建，recorder 必须经此入口注入。
- `IntentParserSource.parseIntent`、`WorldEvolutionSourceContext` 和各 source 的输入 DTO 增加可选 `AiTextAuditLink`；它只携带 `traceId/gameId/jobId/turnNumber`，不进入游戏状态，也不改变规则判断。
- Existing callers with two arguments remain valid for offline/unit fixtures.

- [ ] **Step 1: Add failing client tests for successful, failed and retried calls**

使用 fake transport 和 fake recorder 断言：

```ts
await client.complete("scene", messages, {
  purpose: "scene_performance",
  trigger: "talk_choice",
  gameId: "game-1",
  action: { kind: "talk", npcId: "npc-1" },
});
expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
  kind: "ai_call",
  role: "scene",
  context: expect.objectContaining({ trigger: "talk_choice" }),
  input: { messages },
  output: expect.objectContaining({ ok: true, content: "模型正文" }),
}));
```

另测 transport retry 会留下每次 attempt 的独立记录，`empty_response`/解析修复请求也能区分；断言记录中不出现 `apiKey`、`authorization` 或 base URL。

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `npx vitest run src/game/application/server/ai/rpgAiClient.test.ts`

Expected: FAIL because `complete` does not accept audit context and the client does not call a recorder.

- [ ] **Step 3: Implement request/response capture at the single provider boundary**

在每次 `transport.complete` 返回后写入一条 `ai_call`；`callId` 由 client 为每次逻辑调用生成，`attempt` 记录 client retry 的实际次数，调用方通过 context 的 `repair` 字段提供内容修复编号/触发原因。成功记录完整 `messages` 和 `content`，失败记录完整 request、稳定 failure code、latency、finish reason 和 usage metadata。审计写入失败只调用普通 logger 的稳定 `ai_text_audit_write_failed`，不改变返回结果。

四个 live source 调用 `complete` 时传入明确用途：

- opening：`purpose=opening_generation`，`trigger=new_game`，并携带 `createGame` 的 `gameId/traceId`。
- intent：`purpose=intent_parsing`，`trigger=free_text_action`，携带当前 `gameId/traceId`，action 中记录目标 NPC。
- world：`purpose=world_evolution`，携带 `AiTextAuditLink`；`trigger` 直接使用编排层传入 `WorldEvolutionSourceContext.reason` 的稳定值——当前正常场景路径为 `scene_evolution`/`scene_candidate_shortage`，`performTurn` 的未知实体修复路径使用实际 `resolveTurn` 拒绝码（如 `UNKNOWN_LOCATION`）；代码库中不存在 `battle_victory` 触发。action 中记录 `EvolutionNeed` 和玩家结构化动作。
- scene：`purpose=scene_performance`，携带 `gameId/traceId/jobId/turnNumber`；`trigger` 必须由现有 `StructuredActionSummary` 和 `PendingNarrativeJob` 派生，不凭空引入旧架构类型：`actionId` 以 `start_` 开头为 `initial_opening`；`talk` 且有 `job.utterance` 为 `free_text_dialogue`，`talk` 且无 utterance 为 `talk_choice`；其余使用 `explore_action`、`investigate_action`、`move_action`、`take_item_action`、`give_item_action`、`attack_action`、`battle_action`、`ack_prologue_action`、`freeform_action`。战斗预热调用通过 context 上附加的审计标记（见 Task 3）覆盖为 `battle_prewarm`；action 中保留完整 `PendingNarrativeJob.actionSummary`。

不记录 transport config 的 `baseUrl/apiKey`，完整 messages 中的 RPG 文本和模型输出保留。

- [ ] **Step 4: Run AI source and client tests**

Run: `npx vitest run src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/game/application/server/ai
git commit -m "feat: capture complete provider AI exchanges"
```

### Task 3: 记录游戏 HTTP API 完整输入输出与最终玩家可见文本

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/server/battleScenePrewarm.ts`
- Modify: `src/game/application/sceneGenerationContext.ts`
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/performTurn.ts`
- Modify: `src/game/application/evolveWorld.ts`
- Modify: `src/game/application/server/compositionRoot.test.ts`
- Modify: `src/game/application/generatePendingScene.test.ts`
- Create: `src/game/application/server/battleScenePrewarm.test.ts`
- Modify: `src/app/api/game/route.ts`
- Modify: `src/app/api/game/actions/route.ts`
- Modify: `src/app/api/game/current/route.ts`
- Modify: `src/app/api/game/dev/current/route.ts`
- Modify: `src/app/api/game/narrative/ensure/route.ts`
- Modify: `src/app/api/game/prologue/ack/route.ts`

**Interfaces:**
- `createServerGameEntryPoints(env)` creates one `AiTextAuditRecorder` before the AI client and closes it with the existing runtime close path（现有 `close()` 已依次关闭 repository 与 logRuntime；recorder 的 `close()` 必须放入最外层 finally，确保前两者抛错时也会尝试 flush）。recorder 经 `createServerRpgAiClient(env, logger, recorder)` 注入 AI client。
- `GeneratePendingSceneDeps` gains optional `textAuditRecorder`（类型从纯端口 `./server/ai/textAuditTypes` 导入——Task 1 已扩展边界守卫许可，勿从 recorder 实现文件导入类型）。
- `CreateGameDeps`/`OpeningGenerationInput`、`PerformTurnDeps`/`convertInteraction`、`EvolveWorldInput` 和 `GeneratePendingSceneDeps` 增加可选 `AiTextAuditLink`；`createGame` 从 entry point 接收 `traceId` 并把 `gameId/traceId` 传给 opening，`performTurn` 把 `gameId/traceId` 传给 intent/world，后台 `BackgroundEnsureCoordinator.run(traceId)` 把 `traceId` 传给 scene/world。该 link 只用于日志关联，不写入 `GameState`、`StoryState` 或 event ledger。
- `prewarmBattleVictoryScene`/`applyPrewarmedBattleScene` 的 deps 和调用点同样接收当前 action 的 `gameId/traceId/jobId/turnNumber`；battle prewarm AI call 关联原始战斗请求，最终 `story_text` 关联实际写回的 battle action。
- `executeHttpRequest` 的签名增加 `request: Request`；composition root 在 handler 前读取 `request.clone().text()`，在 handler 后读取 `response.clone().text()`，并以 best-effort JSON parse 同时保存 `rawBody` 与 `json`。这样 `/api/game`、`/api/game/actions` 等路由的成功、业务失败、非法 JSON 和 schema 校验失败都能有完整输入输出记录；读取失败只保留稳定错误名，不阻塞响应。
- `recordGameApiExchange` 是 composition root 内的本地 helper，写入 `kind: "game_api"`、method/route/status、traceId 和稳定用途触发值：`create_game`、`perform_turn`、`get_current_game`、`ensure_narrative_scene`、`ack_prologue`、`dev_current`；不保存 headers/cookie/URL。
- `SceneGenerationContext` 增加可选 `auditLink?: AiTextAuditLink` 和 `auditTrigger?: string` 字段：战斗预热在构造的 context 上附加 `battle_prewarm`，live scene source 读取它覆盖默认派生的 trigger；普通路径不设置，行为不变。两者都只用于审计关联/分类，不进入玩家世界事实。

- [ ] **Step 1: Write failing tests for replay-critical API and story records**

覆盖：

- `createGame` records raw new-game input and exact returned body; opening text appears in subsequent story/API response record。
- `performTurn` records raw `actionId/expectedRevision/interaction` input and full returned `view`。
- free-text interaction keeps complete player text in the audit record。
- initial scene, generated scene, deterministic immediate scene and fallback scene each produce `story_text` with `purpose/trigger/source`。
- `linearNarrativeQueue` consumption records the final composed investigation/move text, not just the earlier AI proposal。
- battle prewarm AI calls are tagged `battle_prewarm`, while the final committed scene is tagged by its actual battle action and `path: "prewarmed"`.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npx vitest run src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts`

Expected: FAIL because no audit recorder is wired and no API/story events are emitted.

- [ ] **Step 3: Wire one recorder through composition root and record canonical exchanges**

六个 API route 都把当前 `Request` 传给 `executeHttpRequest`；在 handler 返回后用 `response.clone()` 取 body，再返回原响应（含原 status/headers 和 `X-Request-Trace-Id`）。`executeHttpRequest` 对每个 canonical route 写入 `game_api` 事件，覆盖 handler 返回的所有 HTTP status；`getCurrentGame` 的重复轮询允许记录，后续分析器按 traceId/route/revision 去重。handler 抛异常时仍写入事件，但 response 只含 `errorName`，不回显异常 message/stack。API 原始 body 与业务 JSON 同时保留，便于还原固定选项、NPC 自定义输入、场景轮询和错误请求。

`generatePendingScene` 构造 `SceneGenerationContext` 后附加 `auditLink`（gameId/traceId/jobId/turnNumber），并在必要时附加 `auditTrigger`；live scene/world source 只从该 link 生成审计上下文，不让 link 进入 prompt 的 RPG 事实字段。场景审批重试要更新“最终通过的 context”，否则 story 记录无法对应真正被接受的 prompt。

在 `generatePendingScene` 的 approved scene 成功 CAS 写回后写入 `story_text`，内容至少包含（若走内容修复，`context` 使用最终通过审批的 repair context）：

```ts
{
  kind: "story_text",
  context: {
    purpose: "final_story_text",
    trigger,
    gameId: record.gameId,
    jobId: context.job.jobId,
    actionId: context.job.actionId,
    turnNumber: context.job.turnNumber,
    revision: record.revision + 1,
    action: context.job.actionSummary,
  },
  source: immediateAction ? "deterministic" : approved.scene.source,
  path: "normal",
  scene: approved.scene,
  visibleText: {
    narration: approved.scene.narration,
    npcLine: approved.scene.npcLine,
    npcDialogues: approved.scene.npcDialogues,
    choices: approved.scene.choices,
  },
}
```

注意 `NarrativeSceneState.source` 的值域只有 `"generated" | "fallback"`（确定性即时场景的 proposal 也标 `fallback`），因此 `"deterministic"` 只能由 immediateAction fast path（move/take_item/investigate）显式判定，不能取自 `approved.scene.source`。composition root 的 `applyPrewarmedBattleScene` 是第二条场景写回路径（预热提案直接 CAS 写回，不经 `generatePendingScene`），同样要在写回成功后记录 `story_text`，trigger 按该次实际 battle action 标注并设置 `path: "prewarmed"`——否则预热命中的场景在审计中缺失最终文本。

opening 的 `prologueText`、结局名称/描述、规则确定性即时文本和非焦点 NPC 闲聊通过 API view/story 事件保留；不把任何文本塞入 `GameState` 或事件账本。

- [ ] **Step 4: Run application tests**

Run: `npx vitest run src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts src/game/application/server/battleScenePrewarm.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/game/application/server/compositionRoot.ts src/game/application/generatePendingScene.ts src/game/application/server/battleScenePrewarm.ts src/game/application/sceneGenerationContext.ts src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts
git commit -m "feat: record game API and final story audit events"
```

### Task 4: 提供审计日志定位、导出和完整性检查命令

**Files:**
- Create: `scripts/aiTextAudit.mjs`
- Create: `scripts/aiTextAudit.node-test.mjs`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `docs/operations/logging.md`
- Modify: `docs/agent/AI环境.md`

**Interfaces:**
- `npm run ai-text-audit -- list`
- `npm run ai-text-audit -- query --run <runId> [--kind ai_call|game_api|story_text] [--game <gameId>]`
- `npm run ai-text-audit -- verify --run <runId>` checks contiguous sequence, valid JSONL, required context and no secret keys.
- `npm run ai-text-audit -- export --run <runId> --out <file>` copies the audit ledger without modifying it.

- [ ] **Step 1: Write node tests for list/query/verify**

构造包含四种 `ai_call.role`（opening、intent、world、scene）以及 `game_api`、`story_text` 的临时 run；断言按 run/kind/gameId 查询、序列缺口检测和 `apiKey/authorization/baseUrl` 机密字段检测均正确。不要把 role 名称误当成新的事件 kind。

- [ ] **Step 2: Run script tests to verify failure**

Run: `node --test scripts/aiTextAudit.node-test.mjs`

Expected: FAIL because the CLI and package script do not exist.

- [ ] **Step 3: Implement CLI without importing server-only application modules**

脚本只读取 JSONL，不连接游戏数据库，不输出模型 key，不自动删除日志。`verify` 对缺字段、坏 JSON、序列不连续、敏感配置字段直接非零退出。

- [ ] **Step 4: Add package script and operations documentation**

记录默认目录 `logs/ai-text-audit/<runId>/events.jsonl`、环境变量 `AI_TEXT_AUDIT`、`AI_TEXT_AUDIT_DIR`、`AI_TEXT_AUDIT_RUN_ID`（含缺省 runId 由启动时间派生的规则）和完整性/导出命令；三个环境变量同步补进 `.env.example` 的可选注释段。说明普通 `logs:query` 只查诊断 SQLite，完整正文使用新 CLI。

- [ ] **Step 5: Run CLI tests**

Run: `node --test scripts/aiTextAudit.node-test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add scripts/aiTextAudit.mjs scripts/aiTextAudit.node-test.mjs package.json .env.example docs/operations/logging.md docs/agent/AI环境.md
git commit -m "feat: add AI text audit query tools"
```

### Task 5: 退役旧故事质量标准并建立当前审计事实文档

**Files:**
- Create: `docs/agent/AI文本审计.md`
- Modify: `docs/游戏开发规范.md`
- Modify: `docs/agent/日志与追踪.md`
- Modify: `docs/archive/AI内容质量评估标准.md`
- Modify: `docs/archive/AI内容质量评估.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Update the RPG logging principle**

将普通诊断日志与 AI 文本审计日志明确分开：普通日志仍只保留稳定诊断字段；默认审计开启，只有 `AI_TEXT_AUDIT=off` 时关闭，其他值均按 `full` 处理。开启时审计日志允许完整保存本游戏 prompt、模型正文、玩家语义输入、游戏 API 输入输出、最终文本、动作和用途。唯一保留的安全排除项是 API key、Authorization、cookie 和完整 URL。

- [ ] **Step 2: Mark the old quality standard and historical implementation as retired**

在 `docs/archive/AI内容质量评估标准.md` 与 `docs/archive/AI内容质量评估.md` 顶部增加 `retired` 声明，明确它们基于旧的 director/writer/NPC 运行链，不能用于当前 canonical runtime 的质量结论。保留正文作为历史决策记录，不删除历史资料。

- [ ] **Step 3: Add current audit facts and index routing**

`docs/agent/AI文本审计.md` 记录当前四类 AI 角色、触发动作、审计事件 schema、文件位置、回放字段和默认开关。索引将“AI 内容质量评估”改为“AI 文本审计与质量审核”，当前质量量表标记为“待基于新审计基线另立方案”，不再引用旧量表作为唯一事实源。

- [ ] **Step 4: Run standards and documentation checks**

Run: `npm run check:standards`

Expected: PASS，且 `Select-String -Path docs/agent/AI文本审计.md -Pattern "导演|writer|directorPlan|allowedRevealFactIds"`（PowerShell）无任何输出，即旧运行链未在新文档中作为当前实现描述出现。

- [ ] **Step 5: Commit**

```powershell
git add docs/游戏开发规范.md docs/agent/日志与追踪.md docs/archive/AI内容质量评估标准.md docs/archive/AI内容质量评估.md docs/agent/AI文本审计.md docs/Agent文档索引.md
git commit -m "docs: retire legacy story quality standard and define text audit"
```

### Task 6: 全链路验收与实际完整局记录

**Files:**
- Modify only if tests expose a contract defect; do not change unrelated gameplay files.

- [ ] **Step 1: Run static and focused gates**

```powershell
npm run typecheck
npm run test:boundaries
npx vitest run src/game/application/server/ai src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts
node --test scripts/aiTextAudit.node-test.mjs
```

- [ ] **Step 2: Start a full audit run**

```powershell
# 默认已经是 full；清除当前 shell 可能残留的关闭开关
Remove-Item Env:AI_TEXT_AUDIT -ErrorAction SilentlyContinue
$env:AI_TEXT_AUDIT_RUN_ID = "manual-2026-08-20-01"
npm run dev
```

完成一局短篇或中篇，覆盖开局、NPC 对话固定选项、NPC 自定义输入、探索、调查/移动即时反馈、世界演化、战斗和结局；关闭服务后执行：

```powershell
npm run ai-text-audit -- verify --run manual-2026-08-20-01
npm run ai-text-audit -- query --run manual-2026-08-20-01 --kind ai_call
npm run ai-text-audit -- query --run manual-2026-08-20-01 --kind story_text
```

- [ ] **Step 3: Confirm audit completeness**

检查每个 AI call 都有 purpose/trigger/action；每个 scene write-back 都有 story_text；每个玩家 action 都能在 game_api 记录找到 request/response；opening、intent、world、scene 和 deterministic/fallback 均能按 trace/game/turn 关联。

- [ ] **Step 4: Run final project gates**

```powershell
npm run test:game-application
npm run test:game-logging
npm run test:app
npm run build
```

Expected: 全部 PASS；审计文件留在 `logs/ai-text-audit/<runId>/`，不进入 git。
