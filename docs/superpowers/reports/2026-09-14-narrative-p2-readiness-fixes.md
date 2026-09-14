# P2 准入缺口修复与离线验收

## 范围与结论

基于 `a1109902`，在 `codex/narrative-architecture` 修复上次代码核查的 R1–R6；执行组织见 [修复 Plan](../plans/2026-09-14-narrative-p2-readiness-fixes.md)，功能范围仍以 [P2 Plan](../plans/2026-09-14-narrative-architecture-p2.md) 为准。工程与离线准入通过，可以进入 Task 7 的冻结与真实 API 验收。本轮未调用真实 API，未修改 main、staged 分支、权威 schema 或 foundation。

## 缺口闭环

| 核查问题 | 修复与实际证据 |
| --- | --- |
| R1：live 驱动缺失，replay 仅信 completed | CLI 接入真实生产创建/行动/ensure/SQLite；单一冻结协议。完整五幕、两臂诊断、全部 transport 与记忆状态严格录制回放；伪造 completed/缺磁带明确失败。 |
| R2：准备包忽略 job，摘要遗漏原话后无法召回 | observer 投影后由当前行动、有效概览和未覆盖原文引用发起一次检索；Event 反查 History；mandatory 保留，optional 按每实体和总体限额补充。真实作者读取被概览省略的旧话，角色按自身权限读取。 |
| R3：缓存/固定包仅检查自身，源变化和回滚处理错误 | SQLite load/publish/freeze 读取同库真实源和权限；摘要只绑定有效前缀及明确关联 Event，固定包绑定 job 完整语义来源。失效 cache 保留表头 revision 并允许 CAS 重建较短水位；同 epoch 来源变化拒绝旧包，合法租约接管恢复原包。12 项真实 SQLite 测试覆盖上述反例。 |
| R4：多个 Event 按对象字符串去重后只剩一个 | 统一按 eventId 去重；概览事件完整内容进入作者/NPC，选择源包含事件内容与结果。回归断言多个必需 Event 同时保留。 |
| R5：丢失预留失败原因、过期 guard、NPC 选择不一致 | generator 用最新 durableRecord/时钟预留和冻结；只有额度耗尽允许原文路径，STALE/UNAVAILABLE 取消，不冻结、不发送作者请求。生产准备复用角色选择器；外部 repository 不再关闭同库来源/租约校验。作者/角色/审阅/摘要完整 messages 统一检查硬预算，溢出在预留和 HTTP 前拒绝。 |
| R6：长度提前压缩可能压掉当前输入 | 50/10 与长度分支统一排除当前 job/action；软预算仅统计有效概览与未覆盖来源，已覆盖旧长文不会持续触发重复维护。 |

独立复核另发现 reviewer 构造 auditLink 时遗漏固定包 memory 元数据，已补齐透传并在完整旅程验证作者/reviewer 同包哈希、NPC observer 和摘要来源标识。普通错误只保留稳定原因。

## 完整故事证据

`narrativeP2Journey.integration.test.ts` 经正式 createGame、performTurn、generator、真实响应解析、角色/摘要 source 和 SQLite 执行，fake 只供模型响应，不注入 History 或结局。

| 模式 | 有效 History / 动作 | 摘要水位 | 结果 |
| --- | --- | --- | --- |
| enabled | 158 / 17 | 11、23、35、45、59、69，共6次发布 | 五幕终局，唯一 item_given，读档一致；turn0旧话在turn10追问的实际作者请求出现，已覆盖且被概览省略；未授知 NPC 不泄漏。 |
| disabled | 158 / 17 | 无，0次摘要请求 | 同样完成五幕、唯一交付、读档及原话/权限断言。 |
| fail | 158 / 17 | 无，6次摘要失败后水位不动 | 全部原文继续可用，故事完成且交付/读档/权限断言通过。 |

有效计数排除 shown_choice，History sequence 不等于有效计数，因此水位并非每次加10。关闭/失败故事是回归变体，不冒充同状态对照。

独立 production driver 的 Node 测试覆盖五幕16动作、至少70有效History、两批以上摘要、真实作者原话命中、主线及同 ready 两臂严格零网络回放。该驱动使用 composition 自己的仓储与发送计数；正式产物含游戏、缓存、固定包和所有请求，两臂不增加路线分母。协议见 [P2 验证协议](2026-09-14-narrative-p2-protocol.md)。

## 工程检查

| 检查 | 本轮结果 |
| --- | --- |
| 完整 Vitest，`--minWorkers=1 --maxWorkers=2` | 229 文件、2919 项通过；1 个 live 测试跳过。 |
| P1/P2 driver 及 seed Node 回归 | 25 项通过，含完整五幕主线/两臂录制回放。 |
| `npm run lint` | 0 错误、49 条既有 warning。 |
| `npm run test:fast` | 通过，包含 typecheck、131 项 boundaries、文档/标准/环境/共享边界等检查。 |
| `npm run build` | 通过，Next.js 编译、类型与页面生成完成。 |
| `npm run check:docs` / `git diff --check` | 通过；文档 0 错误、0 提醒，相关链接人工复核。 |

首轮全量测试暴露旧 `narrativeReplay.integration.test.ts` 给游戏仓储注入临时库、却未给 composition 指定同一 `GAME_DB_PATH`；本次来源校验正确拒绝该装配。已修正测试的同库配置，聚焦回放及完整回归通过，未恢复校验绕过。完整 Vitest 与 fast 日志保留在 `artifacts/narrative-p2/review-a1109902/repair-vitest.log`、`repair-fast.log`。离线测试不需要真实 provider，live 测试保持显式关闭。

## 准入边界

本轮修复以完整离线故事和可追溯生产执行为准。真实 S-short/M-medium、模型输入能力核对、全文评分，以及 UI 旧话追问→刷新→继续终局仍未执行。UI checkpoint 只是后续输入材料，不是 UI 验收记录；必须接登记预算和磁带。

P2-C/整体 P2 质量不得因离线通过而判定通过，也不能据此声称叙事优于 main。后续按 P2 Task 7 冻结新批，保留失败分母，再判断叙事质量与游戏性。
