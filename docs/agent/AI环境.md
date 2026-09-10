# AI 环境

## 职责

本文件记录 RPG server-only AI 配置、source 装配、失败边界和本地/真实运行入口。密钥、数据库路径和 provider client 不进入客户端 facade、存档或日志。

## 当前契约

- `AI_API_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 和 `AI_OUTPUT_FORMAT` 由 `application/server/ai/aiRuntimeConfig.ts` 解析；`GAME_DB_PATH` 只由 `src/game/application/server/persistence/sqliteClient.ts` 读取，缺省为 `db/rpg.sqlite`。
- `AI_RUNTIME_THINKING_ROLES` 控制角色 thinking，未配置时关闭；可用角色及语义以环境示例和 runtime policy 为准。生产叙事生成走分阶段链路（planning → narration / character / choices），统一由 `createStageSource` 装配；不能把角色枚举当作独立调用链，也不能把旧 `NarrativeBundleSource` 描述为生产路径。
- composition root 在 `src/game/application/server/compositionRoot.ts` 装配 repository、`RpgAiClient`、audit recorder、logger、background ensure coordinator 和 stage source。AI transport 只在 `application/server/ai/` 使用。
- provider 传输失败、空响应、JSON/schema/reference 失败和审批拒绝都返回稳定 failure。生产 source 不切换 deterministic、fixture 或默认文本；无可用 AI 配置时注入 unavailable source，创建/叙事任务进入明确失败态。
- 传输由 `RpgAiClient` 按角色策略重试；逐单元生成尝试与手动重试由 [运行时 AI](运行时AI导演与场景表演.md) 维护，普通轮询不重跑 failed job。
- 确定性 source 只在显式 offline fixture composition 使用，不能标记生产 `generated`。

## 环境变量

常用变量见 [环境示例](../../.env.example)：AI provider 三项、`AI_OUTPUT_FORMAT`、`AI_RUNTIME_THINKING_ROLES`、`GAME_DB_PATH`、日志数据库路径和审计开关。`RUN_REAL_AI_SMOKE=1` 只用于一次真实 smoke，不能持久化到项目环境。

配置写入本仓未提交的 `.env.local`。`npm run env:bootstrap` 可初始化三项 provider 配置；运行时只读取本仓配置，不读取 SLG 文件。`npm run env:check` 校验配置且不回显密钥。调试使用独立 `GAME_DB_PATH`，不清理用户存档。

`AI_OUTPUT_FORMAT` 支持 `prompt_only`（默认）、`json_object`、`json_schema`，不自动探测 provider 能力。真实 smoke 需要支持 `node:module.registerHooks` 与 TypeScript 类型剥离的 Node 运行时。

## 运行与测试入口

- 本地离线回归：`npm run journey:foundation`
- 真实 AI smoke：`RUN_REAL_AI_SMOKE=1 npm run smoke:ai:staged`（分阶段叙事链路）；`RUN_REAL_AI_SMOKE=1 npm run smoke:ai:phase4b`（旧链路对照）。两者都是受门禁的 smoke，不是完整旅程。
- provider：`src/game/application/server/ai/rpgAiClient.ts`、`src/game/application/server/ai/sourceFactory.ts`、`src/game/application/server/ai/aiRuntimeConfig.ts`
- 装配：`src/game/application/server/compositionRoot.ts`
- 测试：`src/game/application/server/ai/rpgAiClient.test.ts`、`src/game/application/server/ai/sourceFactory.test.ts`、`src/game/application/server/compositionRoot.test.ts`

## 条件关联阅读

修改叙事包契约读 [运行时AI导演与场景表演](./运行时AI导演与场景表演.md)；修改上下文隐私读 [NPC人格知识与关系图](./NPC人格知识与关系图.md)；修改记录开关读 [AI文本审计](./AI文本审计.md) 和 [日志与追踪](./日志与追踪.md)。
