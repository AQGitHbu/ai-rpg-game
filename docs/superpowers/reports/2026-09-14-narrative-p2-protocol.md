# Narrative P2 验证协议

## 执行契约

协议版本为 `narrative-p2/v1`。唯一协议及路线定义在 `src/game/application/testing/narrativeP2Journey.ts`，CLI `scripts/narrativeP2Journey.mjs` 调用同一实现，生产适配器为 `scripts/narrativeP2Production.mjs`。register 零网络冻结实际模型、服务地址、代码指纹、输入、长度政策及传输参数；不能覆盖已登记协议。live 必须匹配冻结配置并设置 `RUN_REAL_AI_JOURNEY=1`。

| 范围 | 动作/生成上限 | HTTP 上限 | 时限 |
| --- | --- | --- | --- |
| S-short，三幕新故事 | 24 个动作 | 200 | 90 分钟 |
| M-medium，五幕新故事 | 48 个动作 | 500 | 180 分钟 |
| 同 ready 存档摘要开/关诊断，各臂 | 1 个生成 job | 50 | 45 分钟 |

初始化、摘要、角色判断、作者、审阅及传输重试均计数；单 epoch 为 24 次叙事 HTTP、8 次摘要 HTTP、最多 2 批摘要维护、3 版候选。耗尽后显式失败，不自动执行人工 retry。两臂单列，不增加正式路线的完成分母。

实际操作入口和完整命令维护在 [AI 环境](../../agent/AI环境.md)。实跑使用新批次目录；replay 通过 `--replay-source` 指定录制目录，并使用另一个输出目录。长度估算并非模型 tokenizer，实跑前仍需核对冻结模型的实际输入能力。

## 正式执行与产物

路线从正式 composition 创建新游戏，按真实 read model/token 选择合法行动，经 performTurn、ensure、审批和 SQLite 提交完成递送。driver 不注入 History、不修改结局、不关闭仓储来源或租约校验。读状态使用同一 SQLite 文件的独立 reader。

中篇在第三幕或以后、尚未交付且 player 已有两批摘要时，执行预登记旧话追问；距离开局须满足两幕或八个有效动作。原句 oracle 来自实际开局可见 NPC 台词，不写入玩家追问。未达到条件记 coverage failure，即使已通关也不能报告记忆覆盖通过。

追问前关闭连接并 checkpoint SQLite，以同一 ready 源创建摘要开/关两臂；各臂通过同一合法追问产生自己的 job。保存每次正式状态、摘要来源与水位、attempt 计数、固定包及 preparedHash、完整 transport/identity/domainTime 磁带和专用文本审计。磁带含原文与 observer 私密输入，按专用审计产物管理。

## 严格回放

replay 重新执行正式路线并匹配请求及 prompt、响应消费、身份与逻辑时间、游戏状态、缓存及固定包。只沿用 P1 对临时租约标识/到期时间的比较投影；不忽略原文、来源指纹、水位、预算计数或 preparedHash。真实 HTTP 为零，逻辑请求次数单独比较。缺磁带、伪造 completed、来源状态变化或请求不匹配均失败。

P1 helper 仅调整 TypeScript 扩展名补全，使 `.testutil.ts` 可加载；P1 协议和严格匹配语义保持。新生产 prompt 不承诺兼容旧版本 live 磁带。

## 离线证据与待验收边界

完整生产 fake transport 测试通过五幕、16 个合法动作、至少 70 条有效 History、两批以上摘要、真实作者请求原话命中和合法终局；主路线与两臂均严格零网络回放。P1/P2 driver 及 seed 的 Node 测试共 25 项、P2 协议 Vitest 4 项通过。另一个 application 层五幕旅程覆盖 enabled/disabled/摘要失败，详见 [修复验收报告](2026-09-14-narrative-p2-readiness-fixes.md)。这些测试只替换模型响应，证明执行及回放链路，不能证明生成文本质量。

driver 生成合法 ready 的 UI checkpoint、来源 hash、输入及操作 manifest，状态明确为 `not_executed`。当前没有真实浏览器验收；后续 UI 操作必须接入同一登记 runtime、剩余额度和磁带，或另行明确登记 UI 批，不能加载 checkpoint 后隐形调用 API。真实 S-short/M-medium、全文阅读评分及 UI 追问→刷新→终局仍由 [P2 Task 7](../plans/2026-09-14-narrative-architecture-p2.md) 执行。
