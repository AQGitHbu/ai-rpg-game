# MVP Phase 4C：真实 AI 输出可靠性与离线回归设计

> 状态：设计已确认，待实现计划

## 背景

Phase 4B 已让生产开局在有效配置时调用 OpenAI-compatible 服务，并在服务、超时或候选不合约时安全降级到确定性 fallback。真实 smoke 证明“生成或降级后仍可存档与通关”的安全契约成立，但也观察到模型可能超时或输出非法 JSON。

Phase 4C 不扩大 AI 的游戏裁决权。它只提高开局候选的结构化输出可靠性，并让绝大多数开发与验收完全使用预设数据、零真实 API 调用。

## 目标

1. 让已明确支持结构化输出的 provider 优先接收 JSON Schema 或 JSON object 请求约束，减少非法 JSON 和字段漂移。
2. 保留严格的 RPG 候选校验、最多两次 source 尝试、一次机械修复和确定性 fallback；模型输出绝不直接写入存档。
3. 提供版本化离线 fixture，覆盖成功、非法 JSON、schema 违规、超时、限流和服务错误，并驱动完整创建、恢复、行动、战斗与结局回归。
4. 保持普通测试、构建和家族验收零网络、零计费；真实 API 只由显式 opt-in smoke 使用。
5. 让 smoke 和审计只汇总安全质量指标，不记录 prompt、玩家输入、模型原文、URL 或密钥。

## 非目标

- 不实现自由输入、AI 意图识别、NPC 对话、场景流式叙事、SSE、客户端取消或生成进度 UI。
- 不把 RPG schema、prompt、校验、修复、fallback、SQLite 或审计逻辑移入 `@ai-game/ai-transport`。
- 不自动探测或猜测 provider 是否支持某个响应格式；不以一次真实请求作为能力探测。
- 不将真实 smoke 纳入 `npm test`、`test:fast`、build、CI 或 `ready:family`。

## 方案选择

采用“生产结构化输出 + 离线 fixture 默认测试”方案。

- 生产路径通过非敏感配置明确选择 provider 的已知能力，避免把不兼容 provider 的 4xx 响应误判为可安全重试的格式降级。
- 离线路径由受控 fixture source 和 mock transport 模拟所有稳定结果；它是单元、集成和完整游戏回归的默认来源。
- 真实 smoke 只验证真实配置下的端到端安全契约与聚合指标，不要求模型文本恒定，也不作为日常开发门槛。

不采用录制真实响应 replay：它会携带过期的 provider 行为，并增加模型原文、玩家输入或敏感数据进入仓库的风险。也不引入本地模型：运行依赖和行为差异不能为本阶段的结构化契约带来足够价值。

## 架构

### 1. 显式输出格式配置

RPG server-only 运行时配置增加非敏感键 `AI_OUTPUT_FORMAT`，取值严格限定为：

```ts
type AiOutputFormat = "json_schema" | "json_object" | "prompt_only";
```

- `json_schema`：live source 在 chat completion body 中发送严格的 `response_format` JSON Schema，schema 由 RPG 私有候选契约生成或静态定义。
- `json_object`：发送 provider 通用 JSON object 响应格式，仍由 RPG 的完整候选校验裁决字段和引用。
- `prompt_only`：不发送 `response_format`，维持 Phase 4B 的完整 JSON 模板 prompt 与严格解析，用于不支持结构化输出的兼容服务。

缺失时默认 `prompt_only`，以确保已有部署不因升级而改变请求形状。希望提升可靠性的部署必须显式配置已知受支持的模式；无效值产生稳定的 `AI_CONFIG_OUTPUT_FORMAT_INVALID`，生产 composition root 注入 unavailable source，最终仍安全 fallback。配置诊断不得回显实际环境值。

`@ai-game/ai-transport` 仍只接受调用方传入的 `extraBody`，不感知 RPG 输出格式、schema 或环境变量。

### 2. RPG 私有结构化请求与解析

`scenarioPrompt` 继续负责 RPG 文本约束和完整合法候选 JSON 模板；新增纯函数构建三种 `response_format` body。它只使用版本化候选 schema、`ScenarioGenerationRequest` 和游戏类型 profile。

live source 按配置把对应 body 传给 shared transport。无论模式为何，响应仍只能是完整 JSON 或单一 `json` fenced block，随后经过 root-shape 检查、既有 `validateScenarioBlueprintCandidate`、机械修复和 `compileScenarioBlueprint`。结构化 provider 返回的内容不是可信数据；它同样可能触发 `invalid_json`、`schema_violation` 或 fallback。

AI 输出格式不会出现在玩家 API、UI、存档、客户端 bundle 或 audit 中。玩家继续只看到安全的 `generationSource: "generated" | "fallback"`。

### 3. 离线 fixture 与完整游戏回归

在现有 Phase 4 fixture 契约旁新增 Phase 4C 版本化 manifest。每个 fixture 只保存最小、审查过的结构化候选或稳定失败类别；绝不保存真实 prompt、玩家原文、URL、密钥、provider response body 或录制文本。

fixture 集合至少包括：

| 类别 | 离线数据 | 断言 |
|---|---|---|
| 三类型结构化成功 | 武侠、科幻、都市的有效候选 | `generated`，可 reload，预算与双结局成立 |
| 格式失败 | 非 JSON、多个 fence、错误根形状 | 仅稳定失败类别，最终 fallback |
| 候选违规 | 未知引用、超预算、可机械修复字段 | 既有修复/重试/fallback 契约不变 |
| transport 失败 | timeout、rate_limited、service_error | 不触网，映射既有类别并最终 fallback |

完整离线回归用 fixture source 创建游戏后，沿既有三类型试玩路线执行移动、取得物品、战斗、成功/失败结局并 reload。它验证“AI 候选只生成世界，规则系统仍裁决游戏状态”。

### 4. 真实 smoke 与安全质量报告

`RUN_REAL_AI_SMOKE=1` 仍是唯一允许真实调用的开关。smoke 使用 `.env.local` 的 RPG 配置，并对三个固定合法输入运行生产等价开局；每例仍以 `generated | fallback`、可 reload、预算和双结局为功能通过条件。

在不改变通过条件的前提下，smoke 增加安全汇总：按输出格式统计 generated/fallback 数量、稳定 fallback 类别、延迟和 provider 返回的 token/估算成本（如有）。不得输出单例输入、prompt、原始响应、完整模型名、URL、Authorization 或 key。

真实 smoke 不规定最小 generated 比例：provider 行为和可用性是外部变量。质量趋势由人工比较多次安全汇总，而非让不稳定网络测试阻断开发。

## 错误处理与回滚

- 无 AI 配置、无效 `AI_OUTPUT_FORMAT`、transport 失败或候选验证失败，都沿既有失败类别、两次尝试与确定性 fallback 处理。
- provider 明确不支持已配置格式时，运维人员将 `AI_OUTPUT_FORMAT` 改为已知受支持的 `json_object` 或 `prompt_only`；代码不进行隐式探测性二次收费请求。
- 如结构化请求造成异常，可将配置切回 `prompt_only`，或让 composition root 固定注入 unavailable source（Phase 4A 形态）；无需迁移数据。

## 测试与验收

1. `parseAiRuntimeConfig` 对三个合法格式、缺失默认值和无效值的测试全离线运行。
2. prompt/schema builder 与 live source 的单元测试 mock transport，断言每种格式的请求 body、脱敏边界和失败映射。
3. Phase 4C fixture contract 与三类型完整游戏回归不读取 `.env.local`，不发起 fetch。
4. `npm test`、`npm run test:fast`、`npm run build`、`npm run ready:family` 保持无网络；安全门禁测试证明 smoke 缺少 opt-in 时不发请求。
5. 仅在操作者显式授权且本机配置可用时运行真实 smoke；输出只含白名单汇总，结果满足 `generated | fallback` 安全契约。

## 文档事实

Phase 4B 的真实 smoke 已在本机使用 RPG `.env.local` 执行过，三例均满足 `generated | fallback` 契约。Phase 4C 实施时应将这一已发生事实写回 `当前开发阶段.md`、`AI环境.md` 和索引，同时不得记录 URL、模型原文或密钥。
