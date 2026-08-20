# AI 文本与游戏 API 完整审计记录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一个默认开启、显式关闭的本地 AI 文本审计模式，完整记录游戏 API 语义输入输出、四类 AI 调用的完整 messages/模型结果、触发动作/用途和最终玩家可见文本，以支持完整游戏还原与后续 prompt 审核。

**Architecture:** 新增 RPG 专属的 append-only 审计日志，不复用普通诊断日志的脱敏和事件大小截断路径。`RpgAiClient` 统一记录所有 provider 调用；composition root 记录游戏 API 交换；场景审批后的最终文本记录为独立 story 事件。所有记录通过 `runId/gameId/traceId/jobId/turnNumber` 关联，默认不创建审计文件。

**Tech Stack:** TypeScript strict、Next.js server-only、Node `fs/promises` JSONL、Vitest、现有 `RpgAiClient`/composition root/SQLite repository。

## Global Constraints

- 完整审计默认开启；`AI_TEXT_AUDIT` 缺失、空白或非 `off` 值均按 `full` 处理，只有 trim 后明确等于 `off` 才关闭；客户端不能开启或读取审计内容。
- 审计日志可以保存本游戏的完整语义文本、prompt、模型正文、玩家输入和游戏 API body；仍不得保存 `AI_API_KEY`、Authorization、cookie 或完整请求 URL。
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

**Interfaces:**
- Produces `AiTextAuditRecorder`, `AiTextAuditMode`, `AiTextAuditContext`, `AiTextAuditEntry` and `createTextAuditRecorder(env, options?)` for later server composition.
- `AiTextAuditRecorder.record(entry): Promise<void>` is best-effort and never throws into gameplay; `close(): Promise<void>` flushes/关闭文件。

- [ ] **Step 1: Write failing tests for default-on, explicit-off and full append-only capture**

覆盖以下行为：

```ts
const recorder = createTextAuditRecorder({}, { rootDir: tempDir });
await recorder.record({ kind: "ai_call", ...fixtureCall });
expect(await listFiles(tempDir)).toContain("events.jsonl");

const disabled = createTextAuditRecorder({ AI_TEXT_AUDIT: "off" }, { rootDir: tempDir });
await disabled.record({ kind: "ai_call", ...fixtureCall });
expect(await disabled.isEnabled()).toBe(false);

const full = createTextAuditRecorder(
  { AI_TEXT_AUDIT: "full", AI_TEXT_AUDIT_RUN_ID: "run-test" },
  { rootDir: tempDir, now: () => "2026-08-20T00:00:00.000Z" },
);
await full.record({
  kind: "ai_call",
  callId: "call-1",
  role: "scene",
  context: { purpose: "scene_performance", trigger: "talk_action", gameId: "game-1" },
  input: { messages: [{ role: "system", content: "完整 prompt" }] },
  output: { ok: true, content: "完整模型正文" },
});
await full.close();
const rows = readJsonLines(path.join(tempDir, "run-test", "events.jsonl"));
expect(rows[0]).toMatchObject({ kind: "ai_call", input: { messages: [{ content: "完整 prompt" }] } });
expect(rows[0]).toMatchObject({ output: { content: "完整模型正文" } });
```

另加一条超过 131072 bytes 的正文测试，证明审计日志不会复用普通日志的截断逻辑；并验证记录失败时 `record()` resolve 而不是 throw。

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
};

type AiTextAuditEntry =
  | { readonly kind: "ai_call"; readonly callId: string; readonly sequence?: number; readonly role: RpgAiRole; readonly attempt: number; readonly context: AiTextAuditContext; readonly input: { readonly messages: readonly AiMessage[]; readonly options?: SafeAiRequestOptions }; readonly output: SafeAiOutput }
  | { readonly kind: "game_api"; readonly route: string; readonly method: string; readonly context: AiTextAuditContext; readonly request: unknown; readonly response: unknown; readonly httpStatus?: number }
  | { readonly kind: "story_text"; readonly context: AiTextAuditContext; readonly source: "generated" | "fallback" | "deterministic"; readonly scene?: unknown; readonly visibleText: unknown };
```

`SafeAiRequestOptions` 只允许 timeout、temperature、maxTokens、jsonMode、thinking 等非秘密字段；不能把 transport config、API key 或 Authorization 写入记录。文件写入使用单一 `events.jsonl`，记录顺序由 recorder 内部递增 sequence 保证。

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npx vitest run src/game/application/server/ai/textAuditRecorder.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/game/application/server/ai/textAuditTypes.ts src/game/application/server/ai/textAuditRecorder.ts src/game/application/server/ai/textAuditRecorder.test.ts
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

**Interfaces:**
- `RpgAiClient.complete(role, messages, context?)` gains an optional `AiTextAuditContext`.
- `CreateRpgAiClientOptions` gains `auditRecorder?: AiTextAuditRecorder`.
- Existing callers with two arguments remain valid for offline/unit fixtures.

- [ ] **Step 1: Add failing client tests for successful, failed and retried calls**

使用 fake transport 和 fake recorder 断言：

```ts
await client.complete("scene", messages, {
  purpose: "scene_performance",
  trigger: "talk_action",
  gameId: "game-1",
  action: { kind: "talk", npcId: "npc-1" },
});
expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
  kind: "ai_call",
  role: "scene",
  context: expect.objectContaining({ trigger: "talk_action" }),
  input: { messages },
  output: expect.objectContaining({ ok: true, content: "模型正文" }),
}));
```

另测 transport retry 会留下每次 attempt 的独立记录，`empty_response`/解析修复请求也能区分；断言记录中不出现 `apiKey`、`authorization` 或 base URL。

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `npx vitest run src/game/application/server/ai/rpgAiClient.test.ts`

Expected: FAIL because `complete` does not accept audit context and the client does not call a recorder.

- [ ] **Step 3: Implement request/response capture at the single provider boundary**

在每次 `transport.complete` 返回后写入一条 `ai_call`；attempt 号同时包含 client retry attempt，调用方通过 context 提供内容修复编号/触发原因。成功记录完整 `messages` 和 `content`，失败记录完整 request、稳定 failure code、latency、finish reason 和 usage metadata。审计写入失败只调用普通 logger 的稳定 `ai_text_audit_write_failed`，不改变返回结果。

四个 live source 调用 `complete` 时传入明确用途：

- opening：`purpose=opening_generation`，`trigger=new_game`。
- intent：`purpose=intent_parsing`，`trigger=free_text_action`，action 中记录目标 NPC。
- world：`purpose=world_evolution`，`trigger=scene_evolution|scene_candidate_shortage|battle_victory`，action 中记录 EvolutionNeed 和玩家结构化动作。
- scene：`purpose=scene_performance`，`trigger=initial_opening|talk_action|free_text_dialogue|explore_action|battle_action|battle_prewarm|narrative_choice_followup|location_entered`，action 中记录 `PendingNarrativeJob.actionSummary`。

不记录 transport config 的 `baseUrl/apiKey`，完整 messages 中的 RPG 文本和模型输出保留。

- [ ] **Step 4: Run AI source and client tests**

Run: `npx vitest run src/game/application/server/ai/rpgAiClient.test.ts src/game/application/server/ai/liveIntentParserSource.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/server/ai/liveScenePerformanceSource.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/game/application/server/ai
git commit -m "feat: capture complete provider AI exchanges"
```

### Task 3: 记录游戏 API 语义输入输出与最终玩家可见文本

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/generatePendingScene.ts`
- Modify: `src/game/application/server/battleScenePrewarm.ts`
- Modify: `src/game/application/server/compositionRoot.test.ts`
- Modify: `src/game/application/generatePendingScene.test.ts`

**Interfaces:**
- `createServerGameEntryPoints(env, deps?)` creates one `AiTextAuditRecorder` and closes it with the existing runtime close path.
- `GeneratePendingSceneDeps` gains optional `textAuditRecorder`.
- `recordGameApiExchange(route, request, response, traceId)` records canonical application input/output, not secrets or HTTP headers.

- [ ] **Step 1: Write failing tests for replay-critical API and story records**

覆盖：

- `createGame` records new-game input and safe result; opening text appears in subsequent story/API record。
- `performTurn` records `actionId/expectedRevision/interaction` and full returned `view`。
- free-text interaction keeps complete player text in the audit record。
- initial scene, generated scene, deterministic immediate scene and fallback scene each produce `story_text` with `purpose/trigger/source`。
- `linearNarrativeQueue` consumption records the final composed investigation/move text, not just the earlier AI proposal。
- battle prewarm is tagged `battle_prewarm`, while the final committed scene is tagged by its actual battle action.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npx vitest run src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts`

Expected: FAIL because no audit recorder is wired and no API/story events are emitted.

- [ ] **Step 3: Wire one recorder through composition root and record canonical exchanges**

调用 `createGame`、`performTurn`、`getCurrentGame`、`ensureNarrativeScene`、`ackPrologue` 后写入 `game_api` 事件。记录完整业务 request/result；`getCurrentGame` 的重复轮询允许记录，但增加 `sceneId/revision` 字段，后续分析器按 revision 去重。

在 `generatePendingScene` 的 approved scene 成功 CAS 写回后写入 `story_text`，内容至少包含：

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
  source: approved.scene.source,
  scene: approved.scene,
  visibleText: {
    narration: approved.scene.narration,
    npcLine: approved.scene.npcLine,
    npcDialogues: approved.scene.npcDialogues,
    choices: approved.scene.choices,
  },
}
```

opening 的 `prologueText`、结局名称/描述、规则确定性即时文本和非焦点 NPC 闲聊通过 API view/story 事件保留；不把任何文本塞入 `GameState` 或事件账本。

- [ ] **Step 4: Run application tests**

Run: `npx vitest run src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts src/game/application/server/battleScenePrewarm.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/game/application/server/compositionRoot.ts src/game/application/generatePendingScene.ts src/game/application/server/battleScenePrewarm.ts src/game/application/server/compositionRoot.test.ts src/game/application/generatePendingScene.test.ts
git commit -m "feat: record game API and final story audit events"
```

### Task 4: 提供审计日志定位、导出和完整性检查命令

**Files:**
- Create: `scripts/aiTextAudit.mjs`
- Create: `scripts/aiTextAudit.node-test.mjs`
- Modify: `package.json`
- Modify: `docs/operations/logging.md`
- Modify: `docs/agent/AI环境.md`

**Interfaces:**
- `npm run ai-text-audit -- list`
- `npm run ai-text-audit -- query --run <runId> [--kind ai_call|game_api|story_text] [--game <gameId>]`
- `npm run ai-text-audit -- verify --run <runId>` checks contiguous sequence, valid JSONL, required context and no secret keys.
- `npm run ai-text-audit -- export --run <runId> --out <file>` copies the audit ledger without modifying it.

- [ ] **Step 1: Write node tests for list/query/verify**

构造包含 opening、intent、world、scene、game_api、story_text 六类记录的临时 run；断言按 run/kind/gameId 查询、序列缺口检测和 `apiKey/authorization/baseUrl` 机密字段检测均正确。

- [ ] **Step 2: Run script tests to verify failure**

Run: `node --test scripts/aiTextAudit.node-test.mjs`

Expected: FAIL because the CLI and package script do not exist.

- [ ] **Step 3: Implement CLI without importing server-only application modules**

脚本只读取 JSONL，不连接游戏数据库，不输出模型 key，不自动删除日志。`verify` 对缺字段、坏 JSON、序列不连续、敏感配置字段直接非零退出。

- [ ] **Step 4: Add package script and operations documentation**

记录默认目录 `logs/ai-text-audit/<runId>/events.jsonl`、环境变量 `AI_TEXT_AUDIT`、`AI_TEXT_AUDIT_DIR`、`AI_TEXT_AUDIT_RUN_ID` 和完整性/导出命令。说明普通 `logs:query` 只查诊断 SQLite，完整正文使用新 CLI。

- [ ] **Step 5: Run CLI tests**

Run: `node --test scripts/aiTextAudit.node-test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add scripts/aiTextAudit.mjs scripts/aiTextAudit.node-test.mjs package.json docs/operations/logging.md docs/agent/AI环境.md
git commit -m "feat: add AI text audit query tools"
```

### Task 5: 退役旧故事质量标准并建立当前审计事实文档

**Files:**
- Create: `docs/agent/AI文本审计.md`
- Modify: `docs/游戏开发规范.md`
- Modify: `docs/agent/日志与追踪.md`
- Modify: `docs/策划文档/AI内容质量评估标准.md`
- Modify: `docs/agent/AI内容质量评估.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Update the RPG logging principle**

将普通诊断日志与 AI 文本审计日志明确分开：普通日志仍只保留稳定诊断字段；默认审计开启，只有 `AI_TEXT_AUDIT=off` 时关闭，其他值均按 `full` 处理。开启时审计日志允许完整保存本游戏 prompt、模型正文、玩家语义输入、游戏 API 输入输出、最终文本、动作和用途。唯一保留的安全排除项是 API key、Authorization、cookie 和完整 URL。

- [ ] **Step 2: Mark the old quality standard and historical implementation as retired**

在 `docs/策划文档/AI内容质量评估标准.md` 与 `docs/agent/AI内容质量评估.md` 顶部增加 `retired` 声明，明确它们基于旧的 director/writer/NPC 运行链，不能用于当前 canonical runtime 的质量结论。保留正文作为历史决策记录，不删除历史资料。

- [ ] **Step 3: Add current audit facts and index routing**

`docs/agent/AI文本审计.md` 记录当前四类 AI 角色、触发动作、审计事件 schema、文件位置、回放字段和默认开关。索引将“AI 内容质量评估”改为“AI 文本审计与质量审核”，当前质量量表标记为“待基于新审计基线另立方案”，不再引用旧量表作为唯一事实源。

- [ ] **Step 4: Run standards and documentation checks**

Run: `npm run check:standards`

Expected: PASS，且 `rg -n "导演|writer|directorPlan|allowedRevealFactIds" docs/agent/AI文本审计.md` 不出现旧运行链作为当前实现描述。

- [ ] **Step 5: Commit**

```powershell
git add docs/游戏开发规范.md docs/agent/日志与追踪.md docs/策划文档/AI内容质量评估标准.md docs/agent/AI内容质量评估.md docs/agent/AI文本审计.md docs/Agent文档索引.md
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
# 默认已经是 full；只有需要关闭时才设置 $env:AI_TEXT_AUDIT = "off"
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
