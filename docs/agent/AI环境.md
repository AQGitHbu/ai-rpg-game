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
- 第四个非敏感可选键 `AI_OUTPUT_FORMAT`（Phase 4C）：严格三值 `json_schema | json_object | prompt_only`，**大小写敏感**（trim 包裹空白后校验），缺失/空白缺省 `prompt_only`（请求形状与 Phase 4B 完全一致，不发送 `response_format`）；无效值 ⇒ 诊断码 `AI_CONFIG_OUTPUT_FORMAT_INVALID`（绝不回显值）⇒ unavailable source ⇒ 玩家稳定走确定性 fallback。`json_object` / `json_schema` 时 live source 经 extraBody 附带 OpenAI-compatible `response_format`（`json_schema` 为 strict 命名 schema，对应候选契约 `phase4b-v1`）；只在 provider 明确支持时设置，不做能力探测。输出格式不进 audit、玩家 API、UI、存档或客户端 bundle。
- `.env.local` 仍只在 RPG 自己的检出里；运行时与测试不读 `../ai-slg-game/.env*`。

### opt-in 真实 smoke（不是 CI、不是质量评分）

```powershell
npm run env:check
$env:RUN_REAL_AI_SMOKE='1'; npm run smoke:ai:phase4b
```

- 必须显式设置 `RUN_REAL_AI_SMOKE=1` 才会执行（真实、可计费的 AI 调用）；缺失时脚本立即退出非零且不发起任何请求。该变量只在 shell 里临时设置，不写入 `.env.local`。
- opt-in 实跑依赖 Node ≥ 22.18（原生 TS type-stripping 直跑 `src/**/*.ts`）；仓库 `engines` 下限更低（>=20.9），操作者运行前须先 `node --version` 确认版本满足。
- smoke 对三组固定合法输入（武侠 / 科幻 / 都市）各创建一局：默认使用 `tmp/` 下的临时 SQLite，跑完显式关闭并删除（Windows 句柄延迟时留待下次运行清扫）。
- 判定标准：结果 `source` 属于 `generated | fallback` 即为成功——真实服务慢、限流或返回非法输出时，可观测地降级到 fallback 也算通过。smoke 不评估生成文本质量，也不依赖固定模型文本。只有本地脚本 / 配置 / 持久化失败或 fallback 违约（存档不可 reload、内容预算 / 双结局不满足）才退出非零。
- 输出白名单：每例只打印 `gameType`、`generated|fallback`、耗时、稳定诊断码与 tokens/cost（如有）；永不输出玩家输入、prompt、模型原文、URL 或 Key。安全门禁由 `npm run test:phase4b-ai-smoke-script`（mock，不触网）强制。
- 汇总行（Phase 4C）：opt-in 实跑结束时输出恰一行 `[phase4b-smoke] summary {...}`，JSON 字段为白名单：`outputFormat`、`cases`、`generated`、`fallback`、`failed`、`fallbackCategories`（按稳定失败码计数）、`totalDurationMs`，以及可选的 `usage`（tokens 合计）与 `estimatedCostUsd`（合计）。`fallbackCategories` 同时汇聚 source audit 与 `createGame` 最终 `falling_back` 事件：后者将候选校验失败收敛为既有稳定类别，避免“attempt_ok 但最终 fallback”遗漏原因。`outputFormat` 是安全标签：合法三值原样、缺失/空白 → `prompt_only`、其余一律 → `invalid`，**绝不回显原值**。汇总只做可观测聚合，通过条件不变（仍是 `generated|fallback` 契约）；无 opt-in 时不输出汇总行、零请求。
- smoke 决不进入 `npm test` / `test:fast` / build / CI；只作为人工外部验收命令。

### audit 字段与错误码

- 脱敏审计（`scenarioGenerationAudit`）每次尝试输出单行 JSON，白名单字段：`traceId`、`attempt`、`outcome`、`category`、`transportCode`、`latencyMs`、`promptTokens` / `completionTokens` / `totalTokens`、`estimatedCostUsd`（配置单价时才有）。即使误传 prompt / 模型原文 / 密钥也不会落日志。
- 配置诊断码（`AI_CONFIG_*`，来自 `parseAiRuntimeConfig`）：`AI_CONFIG_BASE_URL_MISSING|PLACEHOLDER|INVALID`、`AI_CONFIG_MODEL_MISSING|PLACEHOLDER`、`AI_CONFIG_KEY_MISSING|PLACEHOLDER`、`AI_CONFIG_OUTPUT_FORMAT_INVALID`（`AI_OUTPUT_FORMAT` 非法值，Phase 4C）；绝不回显任何值。
- live source 诊断码（`LIVE_*`）：`LIVE_TRANSPORT_<code>`（transport 失败码大写，如 `LIVE_TRANSPORT_TIMEOUT` / `LIVE_TRANSPORT_RATE_LIMITED`）、`LIVE_TRANSPORT_THROW`、`LIVE_EMPTY_RESPONSE`、`LIVE_INVALID_JSON`、`LIVE_SCHEMA_VIOLATION`；失败类别映射到既有 11 个 `ScenarioCandidateFailureCategory`，不新增。
- smoke 自身的稳定码：`SMOKE_OPT_IN_REQUIRED`、`SMOKE_ENV_CHECK_FAILED`、`SMOKE_CASE_CRASHED`、`SMOKE_CASE_VIOLATION`（细分 `CASE_LOCAL_FAILURE` / `SOURCE_OUT_OF_CONTRACT` / `RELOAD_FAILED` / `ENDING_COUNT_MISMATCH` / `CONTENT_BUDGET_VIOLATION`）。

### 回滚方式

真实 AI 出现不可接受行为时，把 `compositionRoot.ts` 的 `scenarioCandidateSource` 改回固定注入 `createUnavailableScenarioCandidateSource([...])`（Phase 4A 形态）即可：玩家创建路径恒为 fallback，API 契约与 fixture regression（`data/fixtures/phase4/`）全部保持不变，无需迁移数据。

## Phase 10：运行时 AI 导演与场景表演（已设计，待实现）

- 复用现有 `AI_API_BASE_URL`、`AI_MODEL`、`AI_API_KEY`、`AI_OUTPUT_FORMAT` 和 `@ai-game/ai-transport@0.1.0` public API，不修改 foundation。
- director、writer、npc 是三次独立 non-stream 请求；共享 transport 不等于共享 prompt 或上下文。
- 日常 fixture 回归零网络零计费；真实最小链路只在 `RUN_REAL_AI_RUNTIME_SMOKE=1` 时运行。
- 新 smoke 目标命令为 `npm run smoke:ai:phase10`，在实现前不得声称可用或已执行。
- audit 只允许 traceId、role、attempt、稳定失败类别、generated/fallback、latency 和 provider 安全 usage；禁止 prompt、响应原文、事实正文、URL、模型原文、Authorization 和 key。
- 回滚时只把 runtime narrative sources 装配为 unavailable，开局蓝图 AI 与既有确定性规则路径保持不变。
