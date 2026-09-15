# AI 环境

## 职责

本文件记录 RPG server-only AI 配置、source 装配、失败边界和本地/真实运行入口。密钥、数据库路径和 provider client 不进入客户端 facade、存档或日志。

## 当前契约

- 服务端与验收脚本使用 Node.js ≥24.15.0；SQLite 由 Node 内置 `node:sqlite` 提供，无需安装或自行编译数据库原生驱动。Next.js API 使用 Node runtime。
- `AI_API_BASE_URL`、`AI_MODEL`、`AI_API_KEY` 和 `AI_OUTPUT_FORMAT` 由 `application/server/ai/aiRuntimeConfig.ts` 解析；`GAME_DB_PATH` 只由 `src/game/application/server/persistence/sqliteClient.ts` 读取，缺省为 `db/rpg.sqlite`。
- `AI_RUNTIME_THINKING_ROLES` 控制角色 thinking，未配置时关闭；可用角色及语义以环境示例和 runtime policy 为准。生产生成统一使用 `NarrativeBundleSource`，不能把角色枚举当作独立调用链。
- composition root 在 `src/game/application/server/compositionRoot.ts` 装配 repository、`RpgAiClient`、audit recorder、logger、background ensure coordinator 和 narrative bundle source。AI transport 只在 `application/server/ai/` 使用。
- provider 传输失败、空响应、JSON/schema/reference 失败和审批拒绝都返回稳定 failure。生产 source 不切换 deterministic、fixture 或默认文本；无可用 AI 配置时注入 unavailable source，创建/叙事任务进入明确失败态。
- 传输由 `RpgAiClient` 按角色策略重试；生成包完整尝试与手动重试由 [运行时 AI](运行时AI导演与场景表演.md) 维护，普通轮询不重跑 failed job。
- 确定性 source 只在显式 offline fixture composition 使用，不能标记生产 `generated`。

## 环境变量

常用变量见 [环境示例](../../.env.example)：AI provider 三项、`AI_OUTPUT_FORMAT`、`AI_RUNTIME_THINKING_ROLES`、`AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS`、`GAME_DB_PATH`、日志数据库路径和审计开关。`RUN_REAL_AI_SMOKE=1` 与 `RUN_REAL_AI_JOURNEY=1` 只用于一次真实调用，不能持久化到项目环境。

`AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS` 配置完整叙事请求的输入估算上限，合法正整数覆盖默认 **64,000**。估算按 ASCII 字符 0.25、其余字符 1 计数，完整 messages 的 JSON 包含系统指令、记忆、修订稿和审阅候选；这是发送前的本地输入边界，不等同于 provider tokenizer 或输入加输出总容量。初始化、作者、NPC 判断、审阅和摘要请求共用该边界。超限不发送 HTTP，走显式失败；摘要超限可保留旧概览和完整未覆盖原文，但后续完整请求仍须满足上限。

记忆默认 50/10 调度，原文长度软阈值与批来源上限均为 24,000 estimated tokens，概览来源上限为 6,000；数值由 `narrativeMemoryPolicy.ts` 统一提供。软阈值仅触发可追溯压缩，不授权截断原句或丢弃必需依据。摘要、固定包和游戏仓储必须指向同一 `GAME_DB_PATH`；外部仓储注入不能跳过数据库中的来源与租约校验。

配置写入本仓未提交的 `.env.local`。`npm run env:bootstrap` 可初始化三项 provider 配置；运行时只读取本仓配置，不读取 SLG 文件。`npm run env:check` 校验配置且不回显密钥。调试使用独立 `GAME_DB_PATH`，不清理用户存档。

`AI_OUTPUT_FORMAT` 支持 `prompt_only`（默认）、`json_object`、`json_schema`，不自动探测 provider 能力。真实 smoke 需要支持 `node:module.registerHooks` 与 TypeScript 类型剥离的 Node 运行时。

## 运行与测试入口

- 本地离线回归：`npm run journey:foundation`
- P3 同源 UI/API 验收先按 P3 协议 register，再在当前进程设置 `RUN_REAL_AI_JOURNEY=1`，以相同 `--mode=live --run-id --protocol --output` 运行 `npm run journey:narrative:p3:ui -- ...`。执行器在初始化前冻结为 private UI/public API；UI 使用 `http://127.0.0.1:3017`，复用原调用/行动/截止预算和独立路线 SQLite。按 `private.ui.json` 的当前待操作记录通过实际页面提交，中途 ready 刷新并核对状态；终局截图后由验收者在输出目录创建 `private.ui-reviewed` 释放页面。该文件只允许结束取证等待，不覆盖 driver 的规则或刷新判定。规则证据、执行器指纹和浏览器证据均须保留，不把 UI 操作自动称为严格回放通过。
- P2 独立记忆诊断：`node scripts/narrativeP2Memory.mjs register <run-id>` 零网络冻结 v3；同一进程授权 `RUN_REAL_AI_JOURNEY=1` 后用 `live <run-id>`，每次议题暂停需阅读全文并用 `resume <run-id> <议题审阅文件>` 接续。`replay <run-id>` 在独立目录严格回放。复用既有预算与来源记录，满足交付前覆盖时优先执行一次 API 旧事追问；结果始终不代表整体 P2 通过。UI 和两臂仍须独立取得证据，旧 v2 的 A/B 门禁不变。
- P2 v2 登记：`npm run journey:narrative:p2 -- --mode=register --run-id=p2-v2 --protocol=artifacts/narrative-p2/p2-v2/protocol.json --output=artifacts/narrative-p2/p2-v2` 零网络冻结完整协议、代码/配置与 Node 身份；要求模型别名 `ai-slg-game-model`、64,000 输入估算上限，拒绝不可读取的 Git 身份和覆盖登记。v1 产物必须使用原冻结实现，不由 v2 重解释。
- P2 分阶段执行：保留上述 run-id/protocol/output 参数，使用 `--mode=live --stage=A`，当前进程须设置 `RUN_REAL_AI_JOURNEY=1`。A 到终局暂停后，用 `--mode=review --stage=A --review=<审阅文件>` 接收[固定人工审阅](AI文本审计.md#p2-终局审阅)。仅封存通过后，`--mode=live --stage=B` 才会再次核验 A 的实际数据库、产物、审阅和完整严格回放，然后首次初始化 B。每路只有一次初始化和绝对截止时间；审阅等待与重启不续期，失败保留两路分母和 B 的 `not_executed`。
- P2 议题暂停：`--mode=resume --stage=B --review=<议题审阅文件>` 使用同一 output、协议、数据库与原截止时间接续；议题引用与所需 identity 在上次输出的 steps/identity 中。必须提供实际新增 History 引文和已发布候选 ID，不能用通过标记替代。终局等待不能经此入口接续。当前 B 在交付前的 `recall_integration` 保持关闭，召回/UI 与两臂诊断尚未接入 v2，不代表摘要覆盖或整批通过。
- P2 严格回放：保留 run-id/protocol 参数，使用 `--mode=replay --stage=A --replay-source=<原输出目录> --output=<独立空目录>`（B 同理）。全部 segment 按序在同一新 SQLite 中回放；replay/review 使用已登记环境，不读取真实 key、不发送请求。`machineCompleted`、`strictReplayPassed` 和 `sealedPassRoutes` 分别描述规则、回放与人工封存；整批 `passed` 要求两路均封存通过。离线 fixture 仅证明驱动与引用门禁，不证明真实剧情质量。
- 真实 AI smoke：`RUN_REAL_AI_SMOKE=1 npm run smoke:ai:phase4b`；该命令是受门禁的 smoke，不是完整旅程。
- P1 旅程协议：先用 `npm run journey:narrative:p1 -- --mode=register --run-id=<id>` 登记固定输入，再由 `RUN_REAL_AI_JOURNEY=1 npm run journey:narrative:p1 -- --mode=live --run-id=<id>` 执行；`--mode=replay --protocol=<live 协议路径> --replay-source=<live 产物目录> --output=<独立输出目录>` 在新的 SQLite 中消费原始响应磁带，输出写入该目录的 `replay/`，不读取密钥或创建网络 transport。旧产物缺少身份/领域时间磁带时拒绝重放。`--profile=diagnostic` 登记独立的一条完整故事诊断，不改变正式六条矩阵分母。协议和产物规则见 [P1 旅程协议](../superpowers/reports/2026-09-12-narrative-p1-protocol.md)。
- 普通生产主线：登记时传 `--profile=core`，固定普通武侠短篇输入，禁止历史 opening seed；真实创建后执行一条 `S1-complete`，范围为 `production_core_story`。须有规则成功终局事件；若生成交付契约，仍检查正式交付。预算 24 动作、200 HTTP/90 分钟，战斗使用可见合法按钮，replay 同时覆盖开局和后续。
- 固定开局核心诊断：登记时传 `--profile=focused --opening-source=artifacts/narrative-p1/p1-diag-03`；协议冻结源协议、代码、runtime/audit/SQLite 和 opening 语义哈希。每路复制源 SQLite 后由正式仓储核对全状态，原库不打开写连接；先 deliver 成功再 withdraw，预算 200 HTTP/90 分钟。后续 live 全走生产，replay 只重放本批后续响应，旧 opening 仅作为独立来源证据；范围为 `fixed_opening_story`。
- provider：`src/game/application/server/ai/rpgAiClient.ts`、`src/game/application/server/ai/sourceFactory.ts`、`src/game/application/server/ai/aiRuntimeConfig.ts`
- 装配：`src/game/application/server/compositionRoot.ts`
- P2 协议/执行：`src/game/application/testing/narrativeP2Journey.ts`、`scripts/narrativeP2Journey.mjs`、`scripts/narrativeP2Production.mjs`
- 测试：`src/game/application/server/ai/rpgAiClient.test.ts`、`src/game/application/server/ai/worldEvolutionSource.test.ts`、`src/game/application/server/compositionRoot.test.ts`

## 条件关联阅读

修改叙事包契约读 [运行时AI导演与场景表演](./运行时AI导演与场景表演.md)；修改上下文隐私读 [NPC人格知识与关系图](./NPC人格知识与关系图.md)；修改记录开关读 [AI文本审计](./AI文本审计.md) 和 [日志与追踪](./日志与追踪.md)。
