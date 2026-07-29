# MVP Phase 4B：真实 AI 动态开局 Implementation Plan

> 状态：待执行
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不破坏 Phase 4A fixture 回归、确定性 fallback 或可通关性的前提下，抽取两个产品共用的 `@ai-game/ai-transport`，让 RPG 的生产 server composition root 能安全调用真实 OpenAI-compatible 服务生成开局候选。

**Architecture:** foundation 提供无产品语义的 HTTP transport；SLG 迁移现有 transport 并保持其模块级 prompt、重试和日志职责；RPG 保持自己的 prompt、候选 schema、validate/compile、机械修复和 SQLite 事务。RPG live source 只把 provider 文本转换为 `ScenarioCandidateSource` attempt；`createGame` 继续是唯一能写入存档的编排者。

**Tech Stack:** TypeScript strict、Node/Fetch/AbortController、Next.js App Router、Vitest、SQLite/libSQL、`@ai-game/ai-transport` local file dependency、foundation project-family scripts。

## Global Constraints

- 这是跨仓原子工作包：`ai-game-foundation`、`ai-slg-game`、`ai-rpg-game` 必须使用同名 worktree `mvp-phase-4b-real-ai-dynamic-opening` 和同名分支 `codex/mvp-phase-4b-real-ai-dynamic-opening`；不得混用任一 main。
- worktree 含 `.foundation` junction 时，清理只能从各消费者 main 运行 `node ../ai-game-foundation/scripts/cleanupConsumerWorktree.mjs --repository . --worktree-name mvp-phase-4b-real-ai-dynamic-opening`；不得直接 `git worktree remove`，不得删除或重建 `../ai-game-foundation`。
- 共享 package 只能含 OpenAI-compatible 请求、超时、取消、并发、stream 和稳定脱敏错误；绝不读取 `process.env`，不含任一游戏的 prompt、schema、日志、重试策略、业务 fallback 或账号配置。
- API key、完整 prompt、完整玩家原文、原始模型响应、HTTP 响应体都不得写日志、诊断、fixture、API 响应或测试快照。日志只记录 traceId、稳定码、耗时、模型名的安全标识、请求/响应 token（provider 返回时）和成本估算。
- `ScenarioBlueprintCandidate` 仍必须在 RPG 通过 `validateScenarioBlueprintCandidate` 和 `compileScenarioBlueprint` 后，才可经 `createInitialGame` 原子写入。真实模型永不拥有 repository 或 GameState 写权限。
- 普通 `npm test`、`test:fast`、build 和 CI 不访问网络；真实 AI 验证只能由独立、显式 opt-in 的 smoke 命令运行。
- 不实现玩家可见 streaming、SSE、轮询、取消 UI、自由输入、NPC 对话、叙事、图像或语音。transport 的取消/stream 是 SLG 已有真实消费者的通用能力，不改变本次 RPG 单 POST 等待态。

## File Structure

| 仓库 | 路径 | 职责 |
|---|---|---|
| foundation | `packages/ai-transport/src/index.ts` | public types、factory、非流式/流式请求和稳定错误映射。 |
| foundation | `packages/ai-transport/src/index.test.ts` | fetch/超时/取消/队列/stream/脱敏契约。 |
| foundation | `project-family.json`、`package.json` | 纳入 package build、pack 与家族验收。 |
| SLG | `src/game/core/ai/aiTransport.ts`、`types.ts`、`index.ts` | 改为从 public package 适配，保留 SLG 兼容 facade。 |
| RPG | `src/game/application/server/ai/liveScenarioCandidateSource.ts` | server-only prompt 调用、严格 JSON 解析与 attempt 映射。 |
| RPG | `src/game/application/server/ai/scenarioPrompt.ts` | RPG 私有 prompt 与候选输出指令。 |
| RPG | `src/game/application/server/ai/scenarioGenerationAudit.ts` | 脱敏审计 port / 默认结构化 logger。 |
| RPG | `src/game/application/server/ai/aiRuntimeConfig.ts` | 仅在 server composition root 解析本项目 AI 环境。 |
| RPG | `scripts/phase4bAiSmoke.mjs` | opt-in 真实服务 smoke，不加入 Vitest。 |

---

### Task 1: 建立跨仓交接入口与同名 worktree

**Files:**

- Modify: `ai-rpg-game/docs/agent/current-phase.json`
- Modify: `ai-rpg-game/docs/agent/当前开发阶段.md`
- Modify: `ai-rpg-game/docs/Agent文档索引.md`
- Modify: `ai-rpg-game/scripts/checkHandoff.mjs`
- Modify: `ai-game-foundation/project-family.json`

- [ ] **Step 1: 先确认三个 main 可安全开工**

在三个主工作区分别运行 `git status --short` 与 `git worktree list`。任一 main 有未提交改动、已有同名 worktree，或 `.foundation` / foundation 健康检查异常时停止；不要借由删除 junction 解决问题。

- [ ] **Step 2: 写入 Phase 4B 元数据并让交接检查识别跨仓阶段**

将 RPG `current-phase.json` 设为 `planned / not_started`，并固定：

```json
{
  "phase": "mvp-phase-4b-real-ai-dynamic-opening",
  "targetBranch": "codex/mvp-phase-4b-real-ai-dynamic-opening",
  "worktreeName": "mvp-phase-4b-real-ai-dynamic-opening",
  "repositories": ["ai-game-foundation", "ai-slg-game", "ai-rpg-game"],
  "plan": "docs/superpowers/plans/2026-07-29-mvp-phase-4b-real-ai-dynamic-opening.md",
  "sharedInfrastructureChangeAllowed": true,
  "startCommand": "manual coordinated worktree setup (see Phase 4B Plan Task 1)"
}
```

保留完整 `entryDocs`（RPG 设计/开发/AI 环境、共享流程、spec、本 Plan）和三个仓的验收命令。修改 `checkHandoff.mjs`：单仓旧阶段维持原有严格要求；只有上述精确三仓且 `sharedInfrastructureChangeAllowed: true` 时允许此 startCommand，并验证 Plan 含三个仓与 `ready:family`。`phase:start` 保持拒绝跨仓，不得伪装为可用入口。

把 foundation `project-family.json` 中 RPG 的长期验收从 `npm run handoff:check:docs` 改为 `npm run phase:status`：前者只适用于待启动阶段，而 `ready:family` 在实施完成后必须允许 `completed / implemented`。

- [ ] **Step 3: 手动创建并初始化三个同名 worktree**

从各 main 创建相同名称/分支的 worktree；foundation worktree 先完成 `npm ci` 与 package build，随后 SLG/RPG 各运行自己的 `npm run setup`，使消费者的 `.foundation` 都指向 foundation 的同名 worktree。不要在消费者 setup 中对 foundation 运行 install/build。

- [ ] **Step 4: 验证原子集合**

在 RPG worktree 运行 `npm run handoff:check`；在 foundation worktree 运行：

    npm run validate:family
    npm run ready:family -- --dry-run

Expected: 三个路径的 source 都是 `matching-worktree`，dry-run 不出现 main 或 `--allow-main-fallback`。

- [ ] **Step 5: Commit metadata**

分别提交本任务涉及的 RPG/foundation 文档和脚本调整；提交不包含任何 secret、`.env.local`、`node_modules` 或 junction。

### Task 2: 在 foundation 实现版本化、脱敏的公共 transport

**Files:**

- Create: `ai-game-foundation/packages/ai-transport/package.json`
- Create: `ai-game-foundation/packages/ai-transport/tsconfig.json`
- Create: `ai-game-foundation/packages/ai-transport/src/index.ts`
- Create: `ai-game-foundation/packages/ai-transport/src/index.test.ts`
- Create: `ai-game-foundation/packages/ai-transport/README.md`
- Modify: `ai-game-foundation/package.json`
- Modify: `ai-game-foundation/project-family.json`
- Modify: `ai-game-foundation/packages/standards/docs/共享模块目录.json` and generated consumer copies

- [ ] **Step 1: 先写 public API 的失败测试**

测试只 mock `fetch` 和 clock/timer。要求 package 根导出：

```ts
type AiMessage = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;
type AiTransportConfig = Readonly<{ baseUrl: string; apiKey: string; model: string }>;
type AiRequestOptions = Readonly<{ timeoutMs?: number; temperature?: number; signal?: AbortSignal; extraBody?: Record<string, unknown> }>;
type AiTransportFailureCode =
  | "invalid_config" | "aborted" | "timeout" | "rate_limited"
  | "http_error" | "service_error" | "network_error" | "invalid_response" | "empty_response";
type AiCompletionResult =
  | Readonly<{ ok: true; content: string; latencyMs: number; usage?: Readonly<{ promptTokens?: number; completionTokens?: number; totalTokens?: number }> }>
  | Readonly<{ ok: false; code: AiTransportFailureCode; retryable: boolean; latencyMs: number }>;
```

`createOpenAiCompatibleTransport({ fetchImpl?, concurrency? })` 返回 `complete(config, messages, options)` 与 `stream(config, messages, options)`；两者都返回上述稳定成功/失败 union（stream 成功额外带 reader）。测试 200 content、200 空 content、无效 JSON、400、429、5xx、网络错、内部超时、已取消/中途取消、baseUrl 末尾 `/`、`extraBody` 合并、并发上限 3、stream body 缺失和 stream cancel。断言结果与 thrown error 永不包含 apiKey、Authorization、HTTP body 或 provider 原文。

Run:

    npm test --workspace @ai-game/ai-transport

Expected: FAIL（package 不存在）。

- [ ] **Step 2: 最小实现 transport**

使用 package 内 queue；queue 只限制 non-stream completion，stream 连接不占 completion 槽。每次调用创建内部 AbortController，桥接外部 signal；明确区分外部 abort（`aborted / retryable:false`）与内部 timeout（`timeout / retryable:true`）。规范化 URL 后只调用 `${baseUrl}/chat/completions`，不记录 request/response body。429 是 `rate_limited / true`，5xx 是 `service_error / true`，其他非 2xx 是 `http_error / false`；JSON 与 choices 结构错误是 `invalid_response / false`，空字符串是 `empty_response / false`。

`package.json` 使用 `private: true`、`type: module`、root export 指向已提交 `dist/`；`tsconfig` 生成 declaration。根 `build`、`test`、`verify`/`pack` 脚本与 family 配置要同时覆盖 ui 与 ai-transport，不能继续只硬编码 ui。

- [ ] **Step 3: 加 package consumer contract 入口**

foundation 不 import 游戏代码。新增 `test:ai-transport`（或并入 `test`）和 `pack:ai-transport -- --dry-run`；更新 `internal:check` 的 package 清单。`README` 说明配置由调用方传入、错误码含义、无环境读取、无产品语义和 rollback（消费者可退回上一 package commit）。

- [ ] **Step 4: 验证并提交 foundation**

    npm test --workspace @ai-game/ai-transport
    npm run build
    npm test
    npm run verify:ui-dist
    npm run pack:ai-transport -- --dry-run
    git diff --exit-code -- packages/ai-transport/dist

Commit:

    git commit -m "feat: add shared AI transport"

Expected: `dist/` 与 source 一起被提交，package 不读取环境变量，测试没有真实网络。

### Task 3: 迁移 SLG 作为第二个真实消费者（不改变产品行为）

**Files:**

- Modify: `ai-slg-game/package.json` and lockfile
- Modify: `ai-slg-game/src/game/core/ai/aiTransport.ts`
- Modify: `ai-slg-game/src/game/core/ai/types.ts`
- Modify: `ai-slg-game/src/game/core/ai/index.ts`
- Modify: `ai-slg-game/src/game/core/ai/aiTransport.test.ts`
- Modify: imports/tests that mock `requestAiCompletion` or `requestAiCompletionStream`
- Modify: `ai-slg-game/src/game/core/dependencyBoundaries.test.ts` (or its existing equivalent)

- [ ] **Step 1: 添加依赖并先让适配测试变红**

添加固定本地依赖 `"@ai-game/ai-transport": "file:.foundation/packages/ai-transport"`。保留 SLG 的 `requestAiCompletion` / `requestAiCompletionStream` facade 和 `AiTransportConfig` / `AiRequestOptions` 名称，避免一次性改写产品模块；facade 仅把 shared code 映射回现有 SLG 结果形状。

测试新增：429/5xx/timeout/abort 的旧 `retryable` 语义保持；失败 `reason` 只能由本地稳定中文文案根据 shared `code` 映射，绝不拼接共享层或 provider 的响应体；stream 失败仍以明确 `Error` 拒绝，但 message 只来自该映射。所有 mock 导入保持可测。

- [ ] **Step 2: 实现薄适配并移除重复 transport 实现**

在 SLG core 创建单例 `createOpenAiCompatibleTransport()`，并通过 package root import 调用。删除本地 `ConcurrencyQueue`、fetch、timeout、Authorization 拼接和 raw error-body 读取；保留 `executeAiModule` 的产品级 prompt、指数退避、redaction 与 fallback。stream facade 从 shared stream result 解包 reader，失败使用本地 `transportFailureMessage(code)` 抛出安全错误。

- [ ] **Step 3: 补 consumer contract 与边界**

SLG contract test 从 package 根导入，断言不会 deep import、不会由 package 读取 SLG env/logging。现有 `test:fast`、`test:shared-ui`、build 继续通过；如有静态边界表，允许 `core/ai/aiTransport.ts` 导入 package，但不允许 gameplay/UI import provider package。

- [ ] **Step 4: 验证并提交 SLG**

    npm run lint
    npm run test:fast
    npm run test:shared-ui
    npm run build
    git commit -m "refactor: use shared AI transport"

Expected: SLG 的真实调用语义不回退，所有错误文本脱敏。

### Task 4: 在 RPG 建立 live source、私有 prompt 与脱敏审计

**Files:**

- Modify: `ai-rpg-game/package.json` and lockfile
- Modify: `ai-rpg-game/src/game/application/scenarioGeneration.ts`
- Modify: `ai-rpg-game/src/game/application/server/ai/fixtureScenarioCandidateSource.ts`
- Modify: `ai-rpg-game/data/fixtures/phase4/manifest.json`
- Create: `ai-rpg-game/src/game/application/server/ai/aiRuntimeConfig.ts`
- Create: `ai-rpg-game/src/game/application/server/ai/scenarioPrompt.ts`
- Create: `ai-rpg-game/src/game/application/server/ai/liveScenarioCandidateSource.ts`
- Create: `ai-rpg-game/src/game/application/server/ai/scenarioGenerationAudit.ts`
- Create: tests alongside each new module
- Modify: `ai-rpg-game/src/game/application/server/compositionRoot.ts`
- Modify: `ai-rpg-game/src/dependencyBoundaries.test.ts`

- [ ] **Step 1: 升级 4A 内部 source contract 的失败测试**

把 `SCENARIO_CANDIDATE_CONTRACT_VERSION` 升至 `phase4b-v1`，成功 attempt 的 `origin` 扩展为 `"fixture" | "live"`，失败 attempt 扩展为 `"fixture" | "live" | "unavailable"`。更新 fixture manifest 与专用临时 fixture 的版本断言；API/UI 的 `generationSource` 仍严格只有 `generated | fallback`，不得暴露 origin。

为 live source 先写测试：有效 fenced JSON → `ok/live`；空内容 → `empty_response`；不可解析 JSON → `invalid_json`；root 结构错误 → `schema_violation`；shared `timeout/rate_limited/service_error` 正确映射；诊断不包含模型原文或输入；source 不 import repository/persistence。`createGame` 现有两次 source 调用与一次机械修复必须无需行为改变地继续工作。

- [ ] **Step 2: 实现 server-only runtime config**

`parseAiRuntimeConfig(env)` 只接收 `Record<string, string | undefined>`，复用 AI 环境的同一三键规则：base URL 必须 HTTP(S)，model/key trim 后非空。返回 `available(config)` 或带稳定 `AI_CONFIG_*` 诊断的 unavailable；不抛出、不得回显任何值。`compositionRoot.ts` 是唯一从 `process.env` 传入该 helper 的生产点；测试明确注入 env。现有 `env:check` 仍是部署前检查，绝不在普通测试读取 `.env.local`。

- [ ] **Step 3: 实现 prompt、解析和 audit**

`scenarioPrompt.ts` 仅使用 `ScenarioGenerationRequest` 和已加载 RPG profile 构造 `AiMessage[]`：要求只输出 JSON、精确字段、输入 seed、所选 gameType 范围、内容预算和双结局可达性；不接受模型对规则/系统指令的覆盖。prompt 不导出到 client、fixture 或日志。

`liveScenarioCandidateSource.ts` 接收注入的 shared transport、有效 config、prompt builder 和 `ScenarioGenerationAudit`。只允许完整 JSON 或单一 ```json code fence；不使用贪婪正则从任意 prose 提取对象。先做与 fixture source 同级的 root-shape 检查，再返回 live attempt。provider failure 映射为已有 11 个 `ScenarioCandidateFailureCategory`；新增类别先修改 spec、fixture、port version 和回归，不能随意增加 string。

audit 只接受：`traceId`、`attempt`、`outcome`、failure category/transport code、`latencyMs`、usage tokens、基于本地可配置单价计算的估算成本（缺单价时 `undefined`）。默认 logger 结构化输出这些字段，且测试以含假 key/prompt/response 的输入证明输出未泄漏。

- [ ] **Step 4: 装配 live / unavailable source**

production composition root：配置有效时注入 `createLiveScenarioCandidateSource`；无效或缺失时注入 unavailable source，其诊断为稳定 `AI_CONFIG_*` 而非 Phase 4A 文案。fixture source 只能由显式测试/开发依赖注入，绝不按环境变量切入生产。仍不向 POST 返回 trace、provider、origin、diagnostics、usage 或成本。

- [ ] **Step 5: 加固边界并验证**

在 `dependencyBoundaries.test.ts` 追加 synthetic violations：domain/gameplay/UI/API 不能 import `@ai-game/ai-transport`、live source、prompt、audit 或 runtime config；只有 `application/server/ai` 可 import package，只有 composition root 可读取 `process.env`。fixture source 继续不能 import persistence。

    npx vitest run src/game/application/scenarioGeneration.test.ts src/game/application/server/ai
    npx vitest run src/game/application/createGame.test.ts src/game/application/phase4aScenarioGenerationRegression.test.ts
    npx vitest run src/dependencyBoundaries.test.ts

Commit:

    git commit -m "feat: generate RPG openings with live AI source"

Expected: 没有 env/网络时仍得到确定性 fallback；所有 fixture 回归维持离线确定性。

### Task 5: 加入独立真实 AI smoke 与可观测降级验证

**Files:**

- Create: `ai-rpg-game/scripts/phase4bAiSmoke.mjs`
- Create: `ai-rpg-game/scripts/phase4bAiSmoke.node-test.mjs`
- Modify: `ai-rpg-game/package.json`
- Modify: `ai-rpg-game/docs/agent/AI环境.md`
- Modify: `ai-rpg-game/.env.example`

- [ ] **Step 1: 写 smoke 安全门禁测试**

新增 `test:phase4b-ai-smoke-script`，断言脚本在缺少 `RUN_REAL_AI_SMOKE=1` 时退出非零且不发送 fetch；运行前调用 `npm run env:check`，但 stdout/stderr 不打印键值；三组固定合法输入（武侠、科幻、都市）只验证结果属于 `generated` 或 `fallback`，且成功存档可 reload、预算/双结局仍满足。测试 mock live source/transport，不访问网络。

- [ ] **Step 2: 实现 opt-in command**

新增：

    npm run smoke:ai:phase4b

命令必须要求 `RUN_REAL_AI_SMOKE=1`，默认使用临时 SQLite 和显式关闭/删除临时文件；调用 production-equivalent live source 三次。每例输出仅 `gameType`、`generated|fallback`、耗时、稳定错误码/诊断码和 tokens/cost（如有），永不输出输入、prompt、raw response、URL、key。任一真实服务慢、限流或非法输出时，测试记录可观测 fallback 后整体成功；只有本地脚本/配置/持久化或 fallback 违约才失败。

- [ ] **Step 3: 更新运维文档**

说明 `.env.local` 仍只在 RPG；先运行 `npm run env:check`，再显式设置 opt-in 环境变量执行 smoke。说明 smoke 不是 CI、不是质量评分，不能依赖固定模型文本；解释 audit 字段、错误码、回滚方式（RPG composition root 回到 unavailable source + 保持 fixture regression）。

- [ ] **Step 4: 验证 offline 与 opt-in 路径**

    npm run test:phase4b-ai-smoke-script
    npm run env:check
    $env:RUN_REAL_AI_SMOKE='1'; npm run smoke:ai:phase4b

最后一条只在操作者已配置可计费 provider 时运行；若无授权，不得伪造成功，记录为待人工 smoke 的外部验收项。

### Task 6: 三仓家族验收、事实文档与安全合并

**Files:**

- Modify: `ai-rpg-game/docs/agent/current-phase.json`
- Modify: `ai-rpg-game/docs/agent/当前开发阶段.md`
- Modify: `ai-rpg-game/docs/agent/MVP核心闭环.md`
- Modify: `ai-rpg-game/docs/agent/AI环境.md`
- Modify: `ai-rpg-game/docs/Agent文档索引.md`
- Modify: foundation standards source and regenerated `docs/共同规范/共享模块目录.json` in both consumers

- [ ] **Step 1: 完成代码审查前的全量验收**

在 foundation worktree 运行：

    npm run ready:family

Expected: foundation build/test/pack，SLG lint/fast/shared-ui/build，RPG lint/test/fast/build/phase status 都通过，且 project-family 输出三者均为同名 worktree。再独立运行 RPG `npm run env:check`；真实 smoke 按 Task 5 的授权条件另计，绝不能加入 `ready:family`。

- [ ] **Step 2: 更新实施事实，不伪造 smoke**

只有所有离线门禁成功后，将 RPG phase 标为 `completed / implemented`。当前阶段、MVP 核心闭环、AI 环境和索引说明：生产会在有效本项目配置时使用 live source；配置/服务/候选失败会在最多两次尝试与机械修复后安全 fallback；fixture 测试仍为主回归；真实 smoke 的实际执行日期/结果只在已真的运行后记录。将共享目录的 `ai-transport` 从 candidate-confirmed 更新为 shared，并写入版本/public responsibility。

- [ ] **Step 3: 分仓提交、合并与清理**

按 foundation → SLG → RPG 顺序独立提交、复核 `git status --short` 后 fast-forward 合并到各自 main。每次合并后重新确认 consumer `.foundation` 与 foundation main 健康。确认三仓 main 都含提交且不再需要 worktree 后，按本 Plan Global Constraints 的受保护清理命令逐个清除 worktree；仅在 `git branch -d` 成功时删除已合并分支。

## 明确边界

- 不把 RPG `ScenarioBlueprintCandidate`、prompt、repair、validator/compiler、fallback、SQLite、trace/audit 业务语义放进 `@ai-game/ai-transport`。
- 不迁移 SLG 的 `executeAiModule`、日志 port、账号解析、季度/战略 prompt 或产品级重试到 foundation。
- 不让模型的原始输出绕过 RPG 既有 validate/compile；不把 `live`、provider、trace、tokens 或成本暴露给玩家 API/UI。
- 不把真实 AI smoke 纳入 `npm test`、`test:fast`、build 或 `ready:family`；无有效授权时保留 smoke 为人工外部验收，而非伪造绿灯。
- 不添加客户端取消或生成进度流；本阶段仍是一条诚实等待态的 `POST /api/game`。
