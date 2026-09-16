# P3 真实旅程协议

本报告冻结 P3 Task 8 的协议与执行边界。协议实现为 `narrative-p3/v1`，只登记非秘密环境快照、固定输入、代码指纹、两条路线及预算；API key、Authorization、provider 原文和完整 prompt 不写入协议或普通日志。真实 provider/UI 结果必须以同一 `runId` 的 `artifacts/narrative-p3/<runId>/` 产物补充，不能用离线 fixture 替代。

## 固定范围

- `plannedRoutes=2`，路线顺序固定为 `private`、`public`；初始化场景 ID 固定为 `shared-three-act-opening`，共同前缀推进至同一事实的两种合法调查方法已展示的 ready 点，再复制为两路独立 SQLite。
- 输入是“旧契与证人”三幕短篇：玩家沈砚，受托保管旧契；正式路线动作只能从当前 read model 暴露的 opaque choice token 选择。
- `private` 选择无额外见证的方法；`public` 选择有明确现场 NPC 见证的方法，方法 ID 可以不同。选择器读取正式 Action 与已批准方法的见证者，不读取 label 猜测后果；缺少对应方法返回 `P3_CAPABILITY_COVERAGE_FAILED`，不补抽样本、不改世界状态。
- 私下路线在调查前实际提出一次策略，调查后重载，并优先从已展示移动选项中选择携带该调查来源证明的回访；预测仅用于选路，验收必须记录真实成功 Action 与结果边界。回访不替代实际告知。当前测试输入明确要求原委托人批准条款引用调查证据，后续合作及交付仍须正常审批与执行。
- 每路最多 32 次有效动作、300 次 HTTP、120 分钟；批次最多 600 次 HTTP、180 分钟；每个 job 仍最多 3 个候选和 32 次 HTTP。分母不会因开局、路线或 provider 失败缩小。

## 模式契约

`register` 只校验输入、环境 URL（不含凭据）、代码指纹和协议哈希，并以独占写创建 `protocol.json`，零 provider transport。`live` 要求 `RUN_REAL_AI_JOURNEY=1`，读取已登记协议，使用正式 SQLite/production composition 和 P1 replay tape 基础写入 opening、路线数据库、Action/History/Event、审阅/审计及 route manifest。`replay` 读取原始 route manifest，在独立输出目录逐路线调用零 HTTP replay runner，比较路线状态、动作数和失败码；缺 manifest、哈希、路线分母或语义不一致均拒绝。

live/replay 的 route 状态只能是 `completed`、`blocked`、`not_run`。`blocked` 和 `not_run` 都保留在结果分母中；只有两路均 `completed` 才返回 `passed=true`。旧 P1/P2 CLI 和其 `passed` 语义未修改。

## 测试证据

- `src/game/application/testing/narrativeP3LiveJourney.test.ts` 覆盖协议固定输入/分母/预算和 opaque Action 选择。
- `scripts/narrativeP3Journey.node-test.mjs` 覆盖参数校验、register 零 transport、API key 不泄漏、live completed/blocked 分母、replay 零 HTTP 及伪造 completed manifest 拒绝。
- `npm run test:narrative-p3-script`、Task 8 Vitest 和 `npm run typecheck` 均须通过后才允许登记真实批次。

本报告冻结的是执行协议，不把协议创建或离线 runner 测试称为真实剧情完成。真实登记的 `runId`、protocolHash、模型别名和实际策略应写入验收报告；密钥永不写入报告。

## 实际登记与首批结果

真实登记 `p3-01` 已使用当时冻结提交 `146c08c4` 完成，协议为 `narrative-p3/v1`，`protocolHash=a3dd04b0b519e1c3bfe8136af107c0b3074e1cf077824ea20d4dea4e9074234d`，`inputHash=63c982c91b80f626142fe092f94d0979fd806d77f4858afd7c89bfbc7f358d37`。配置存在性由 `env:check` 验证；模型名、provider URL 和 key 不在本报告输出。

同一次 live 真实创建了共同 opening SQLite/runtime 和两份独立 `private.sqlite` / `public.sqlite`。两路均在正式生产循环中保留了实际 History/Action/响应 tape，但都在形成完整 P3 方法路径前以 `ROUTE_POLICY_UNSUPPORTED` blocked：private 7 个有效动作，public 11 个有效动作；分母仍为两路，`completedRoutes=0`。本批没有达到调查方法、合作分化、交付/终局或 UI 证据，不能把部分 route tape 当作故事通过。

对同一 live 产物执行独立输出目录 replay，返回两路相同 blocked 状态、相同动作数/失败码，`strictReplayPassed=true`、replay HTTP=0。live route manifest 的旧 adapter 计数曾把 HTTP 记为 0，尽管 tape 有 provider calls；随后已修正预算回调绑定与计数取值，后续登记必须使用修正后的 runner，不把旧计数字段解释为真实 HTTP 统计。
