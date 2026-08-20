# AI 环境

## 定位

`ai-rpg-game` 拥有自己的 AI 环境变量和 `.env.local`。初始开发时允许从 RPG 主工作区或 sibling `ai-slg-game` 的本地 env 复制同名键值，但这只是一次性本地初始化，不是运行时依赖。

运行时、测试和部署不得读取 `../ai-slg-game/.env*`。两个项目之后可以独立更换 URL、模型或 Key。

## 契约

必需键：

```dotenv
AI_API_BASE_URL=...
AI_MODEL=...
AI_API_KEY=...
```

- 实际值只放 RPG 自己的 `.env.local`、部署环境或 secret store，不提交。
- `AI_API_BASE_URL` 必须是 HTTP(S) URL。
- 脚本、日志、错误和测试不得输出任何值。
- `AI_GAME_ENV_SOURCE` 只用于本地 bootstrap 指定来源路径，不是应用运行时配置，也不能提交到配置文件。

## 持久化环境变量（Phase 2）

```dotenv
GAME_DB_PATH=./db/rpg.sqlite
```

- 仅 server 运行时读取：全库只有 `src/game/application/server/persistence/sqliteClient.ts` 解析该键（经 composition root 注入的 env 记录）；客户端 bundle、domain/gameplay 与 application 本体均不感知，边界由 `src/dependencyBoundaries.test.ts` 静态守卫强制。
- 未设置或空白时回退默认 `db/rpg.sqlite`（`db/` 目录已被 `.gitignore` 忽略，不提交数据库文件）。
- 测试不读全局配置：一律显式注入 `tmp/` 下的临时路径，用完自清理。
- `.env.example` 已含该键示例；`GAME_PERSISTENCE_BACKEND` 目前仅为声明性占位，代码未读取（Phase 2 只支持 sqlite）。

## 本地操作

```powershell
npm run env:bootstrap
npm run env:check
```

`env:bootstrap` 的来源优先级为：

1. 当前进程显式设置的 `AI_GAME_ENV_SOURCE`；
2. RPG 主工作区自己的 `.env.local`（用于给 RPG worktree 初始化）；
3. sibling SLG 主工作区的 `.env.local`；
4. sibling SLG 主工作区的 `.env`。

脚本只复制上述三个键，不复制 SLG 其他配置，不覆盖已有且有效的 RPG `.env.local`；需要覆盖时显式运行 `npm run env:bootstrap -- --force`。

## 阶段边界

Phase 1/Phase 2 不发起 AI 调用（Phase 2 仅确定性 fallback 生成），因此缺少真实 AI 值不会阻止 `setup` 或 `doctor`；开始真实 AI 阶段前，`npm run env:check` 必须成为该阶段验收命令。Provider transport 仍需按共享候选流程判断，不在环境脚本中实现。

## Phase 4A：AI 契约模拟（已实现，无真实 AI 调用）

- Phase 4A 不读取 `AI_API_BASE_URL` / `AI_MODEL` / `AI_API_KEY`，不发起任何外网 AI 请求；真实 AI 接入与 shared `@ai-game/ai-transport` 留给 Phase 4B。
- 生成链路经纯 `ScenarioCandidateSource` port（契约 `phase4a-v1`）：开发/测试用 server-only fixture source（`src/game/application/server/ai/fixtureScenarioCandidateSource.ts` + `data/fixtures/phase4/`）驱动合法/可修复/超时/不可修复候选；编排层提供一次机械确定性修复 + 一次重试，全部失败稳定走确定性 fallback。
- 生产 composition root 固定注入 `createUnavailableScenarioCandidateSource()`：玩家创建路径恒为 fallback，`POST /api/game` 仅返回安全的 `generationSource: "generated" | "fallback"`；生成阶段事件仅供内部 contract test 与结构化日志，不进玩家 API。
- fixture 与契约回归不依赖任何 env 键；`env:check` 自 Phase 4B 起进入真实 AI 阶段的验收命令。

## Phase 4B：真实 AI 接入与 opt-in smoke（已实现）

代码与门禁已全部落地（live source、配置解析、audit、smoke 脚本与安全门禁）；**真实计费 smoke 已于本机以 RPG 自己的 `.env.local` 执行**，三例（武侠 / 科幻 / 都市）均满足 `generated | fallback` 契约。本文档不记录 URL、模型原文、密钥或任何 env 值。

### 运行时配置

- 生产 composition root（`src/game/application/server/compositionRoot.ts`）经 `parseAiRuntimeConfig(env)` 解析 `AI_API_BASE_URL` / `AI_MODEL` / `AI_API_KEY`：三键有效 ⇒ 注入 live source（shared `@ai-game/ai-transport`）；无效 ⇒ 注入 unavailable source，玩家创建路径稳定走 fallback，API 契约不变。
- 第四个非敏感可选键 `AI_OUTPUT_FORMAT`（Phase 4C）：严格三值 `json_schema | json_object | prompt_only`，**大小写敏感**（trim 包裹空白后校验），缺失/空白缺省 `prompt_only`（请求形状与 Phase 4B 完全一致，不发送 `response_format`）；无效值 ⇒ 诊断码 `AI_CONFIG_OUTPUT_FORMAT_INVALID`（绝不回显值）⇒ unavailable source ⇒ 玩家稳定走确定性 fallback。经本 provider 的兼容性验证，只有 `json_object` 会由 live source 经 extraBody 附带 OpenAI-compatible `response_format`；`json_schema` 目前仍接受配置但按 `prompt_only` 请求，避免未支持的 schema 参数伪造成可用能力。输出格式不进 audit、玩家 API、UI、存档或客户端 bundle。
- 生产 AI 请求由一个 server composition root 级别的 `RpgAiClient` 统一发出；`intent`、`opening`、`scene`、`world` 四个角色各自拥有 timeout、`max_tokens`、JSON mode、retry 上限和 `thinking` 策略。当前链路是 new-api → DeepSeek 官方 OpenAI-compatible API：默认所有角色 `thinking=off` 时发送 `extraBody.thinking = { type: "disabled" }`，只有显式设置 `AI_RUNTIME_THINKING_ROLES` 中的角色才发送 `{ type: "enabled" }`；它与评估专用的 `AI_THINKING_ROLES` 完全隔离。
- DeepSeek 官方以 `thinking.type` 作为思考模式开关；不要用 Qwen/SGLang 专用的 `chat_template_kwargs.enable_thinking` 替代它。shared transport 会保留安全的 `finishReason`、`usage.reasoningTokens`、`hasReasoningContent` 元数据；如果 provider 仍输出 reasoning 但没有最终 `message.content`，RPG client 记录 `rpg_ai_provider_reasoning_observed` / `rpg_ai_provider_empty_final_content`，不再用相同请求盲目重试。
- 2026-08-14 真实 RPG scene/world 验证：两次请求均发送 `thinking.type=disabled` 且不带旧字段，均返回 `finish_reason=stop`、可解析 JSON、`scene=generated` / `world=proposal`，provider 未返回 reasoning token 或 reasoning_content。
- `.env.local` 仍只在 RPG 自己的检出里；运行时与测试不读 `../ai-slg-game/.env*`。

### opt-in 真实 smoke（不是 CI、不是质量评分）

```powershell
npm run env:check
$env:RUN_REAL_AI_SMOKE='1'; npm run smoke:ai:phase4b
```

- 必须显式设置 `RUN_REAL_AI_SMOKE=1` 才会执行（真实、可计费的 AI 调用）；缺失时脚本立即退出非零且不发起任何请求。该变量只在 shell 里临时设置，不写入 `.env.local`。
- opt-in 实跑依赖 Node ≥ 22.18（原生 TS type-stripping 直跑 `src/**/*.ts`）；仓库 `engines` 下限更低（>=20.9），操作者运行前须先 `node --version` 确认版本满足。
- smoke 对三组固定合法输入（武侠 / 科幻 / 都市）各创建一局：默认使用 `tmp/` 下的临时 SQLite，跑完显式关闭并删除（Windows 句柄延迟时留待下次运行清扫）。
- 判定标准：真实 AI smoke 的每例必须为 `source=generated`；模型超时、限流、空响应或非法输出而降级到 `fallback` 时，流程仍可恢复，但该例必须以 `AI_FALLBACK_USED` 退出非零，绝不算作 AI 调用成功。smoke 不依赖固定模型文本；本地脚本、配置、持久化、reload 或开局运行时预算违约同样失败。当前存档只持久化开局地点/NPC/主任务，未来实体与结局由运行时演化，因此 smoke 复查的是持久化的开局状态，不会读取不存在的 blueprint/结局字段伪造通过。
- 输出白名单：每例只打印 `gameType`、`generated|fallback`、耗时、稳定诊断码与 tokens/cost（如有）；永不输出玩家输入、prompt、模型原文、URL 或 Key。安全门禁由 `npm run test:phase4b-ai-smoke-script`（mock，不触网）强制。
- 汇总行（Phase 4C）：opt-in 实跑结束时输出恰一行 `[phase4b-smoke] summary {...}`，JSON 字段为白名单：`outputFormat`、`cases`、`generated`、`fallback`、`failed`、`fallbackCategories`（按稳定失败码计数）、`totalDurationMs`，以及可选的 `usage`（tokens 合计）与 `estimatedCostUsd`（合计）。`fallbackCategories` 同时汇聚 source audit 与 `createGame` 最终 `falling_back` 事件：后者将候选校验失败收敛为既有稳定类别，避免“attempt_ok 但最终 fallback”遗漏原因。`outputFormat` 是安全标签：合法三值原样、缺失/空白 → `prompt_only`、其余一律 → `invalid`，**绝不回显原值**。汇总只做可观测聚合；任一 fallback 都使真实 AI smoke 失败。无 opt-in 时不输出汇总行、零请求。
- smoke 决不进入 `npm test` / `test:fast` / build / CI；只作为人工外部验收命令。

### audit 字段与错误码

- 脱敏审计（`scenarioGenerationAudit`）每次尝试输出单行 JSON，白名单字段：`traceId`、`attempt`、`outcome`、`category`、`transportCode`、`latencyMs`、`promptTokens` / `completionTokens` / `totalTokens`、`estimatedCostUsd`（配置单价时才有）。即使误传 prompt / 模型原文 / 密钥也不会落日志。
- 配置诊断码（`AI_CONFIG_*`，来自 `parseAiRuntimeConfig`）：`AI_CONFIG_BASE_URL_MISSING|PLACEHOLDER|INVALID`、`AI_CONFIG_MODEL_MISSING|PLACEHOLDER`、`AI_CONFIG_KEY_MISSING|PLACEHOLDER`、`AI_CONFIG_OUTPUT_FORMAT_INVALID`（`AI_OUTPUT_FORMAT` 非法值，Phase 4C）；绝不回显任何值。
- live source 诊断码（`LIVE_*`）与 RPG client 诊断事件共同使用稳定 transport code；client 额外记录 `rpg_ai_request_retry`、`rpg_ai_provider_reasoning_observed`、`rpg_ai_provider_empty_final_content`。只记录角色、失败码、finish reason、latency 和 token 计数，不记录 prompt、响应原文、reasoning 原文、密钥或 Authorization。
- smoke 自身的稳定码：`SMOKE_OPT_IN_REQUIRED`、`SMOKE_ENV_CHECK_FAILED`、`SMOKE_CASE_CRASHED`、`SMOKE_CASE_VIOLATION`（细分 `CASE_LOCAL_FAILURE` / `SOURCE_OUT_OF_CONTRACT` / `RELOAD_FAILED` / `ENDING_COUNT_MISMATCH` / `CONTENT_BUDGET_VIOLATION`）。

### 回滚方式

真实 AI 出现不可接受行为时，把 `compositionRoot.ts` 的 `scenarioCandidateSource` 改回固定注入 `createUnavailableScenarioCandidateSource([...])`（Phase 4A 形态）即可：玩家创建路径恒为 fallback，API 契约与 fixture regression（`data/fixtures/phase4/`）全部保持不变，无需迁移数据。

## 运行时 AI 导演与场景表演

- 复用现有 `AI_API_BASE_URL`、`AI_MODEL`、`AI_API_KEY`、`AI_OUTPUT_FORMAT`、`AI_RUNTIME_THINKING_ROLES` 和 `@ai-game/ai-transport@0.1.1` public API；RPG 的 provider 角色策略位于 `RpgAiClient`，shared package 只提供通用 transport 与安全响应元数据。
- 运行时只走两类可选调用：开局生成（opening slice）与逐次世界演化（仅 `EvolutionNeed !== none` 时）；每个 ready 场景由一次场景表演调用产出（`liveScenePerformanceSource`），不再有 director/writer/npc 三次独立调用管线。开局由 live API/fallback 自由生成实体与文本，并返回抽象结构标签；服务端持久化开局指纹，按近期同题材历史执行相似度校验，过于雷同就带着差异上下文重试，不对 AI 候选做实体名覆盖。开发清档不删除开局历史，因此连续新局仍有去重依据。
- 日常 fixture 回归零网络零计费；完整离线回放命令为 `npm run journey:phase10` 与 `npm run journey:foundation`。
- 真实完整旅程只在 `RUN_REAL_AI_JOURNEY=1 npm run smoke:ai:phase10-journey` 时运行；该命令不是 CI，也不替代离线回放。
- audit 只允许 traceId、role、attempt、稳定失败类别、generated/fallback、latency 和 provider 安全 usage；禁止 prompt、响应原文、事实正文、URL、模型原文、Authorization 和 key。
- AI 文本审计日志（`AI_TEXT_AUDIT_*`）独立于普通诊断日志，默认开启（`AI_TEXT_AUDIT=full`，只有显式 `AI_TEXT_AUDIT=off` 才关闭 AI 文本事件）。审计日志保存完整 prompt、模型正文、玩家语义输入和最终文本；游戏 API 由独立的 `GAME_API_AUDIT` 控制，默认 `compact`，轮询只保留摘要，`full` 才保存完整 API body，`off` 不记录 API 事件。日志落到 `logs/ai-text-audit/<runId>/events.jsonl`，不经过普通日志的脱敏和截断。唯一安全排除项是 API key、Authorization、cookie 和完整 URL。查询使用 `npm run ai-text-audit -- list|query|verify|export`。
- 回滚时只把 runtime narrative sources 装配为 unavailable，开局生成 AI 与既有确定性规则路径保持不变。
