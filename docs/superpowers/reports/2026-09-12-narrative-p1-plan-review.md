# P1 实施 Plan 审查与修正

## 范围

审查对象为 `24c2fd93` 中的 [P1 Plan](../plans/2026-09-12-narrative-architecture-p1.md)，依据 [总 Spec](../specs/2026-09-12-narrative-architecture-design.md) 和 main 基准的实际代码。按用户要求使用一个子智能体只读审查，主智能体核对证据并原位修正文档；未实施生产代码、未执行真实 API。

## 发现与处置

优先级 P1/P2 在本表表示审查问题严重程度，与实施阶段 P1/P2 无关。

| 编号 | 级别 | 原问题与代码依据 | 文档修正 |
| --- | --- | --- | --- |
| R1 | P1 | `narrativeBundle/descriptors.ts` 仍只提供 support/challenge，`approveNarrativeBundle.ts` 从 descriptor 重建 Action；只改 token 不能生成新互动，Task 4 依赖了尚未实施的 Task 6/7 | Task 2 提前接通 opening/局部互动提案、校验编译、descriptor、批准选项及消费；Task 6/7 仅增加 AI 提议和审阅。增加正式 source→registry→performTurn 集成测试 |
| R2 | P1 | `domain/action.ts` 与四个新增互动 operation 均无放弃动作，普通 move 又不能等同退出 | Task 3 定义 abandon_quest 正式 Action/Event/候选链；归还先 give_item，再显式放弃；带物退出单独验证。Task 4 改为五条离线路线，明确普通离场和自由文本不自动退出 |
| R3 | P1 | 互动 resolver 只返回 worldState，丢失 `resolveByType.ts` 的 drafts/stateChanges/facts 契约 | Task 2 复用现有 ResolveDeps/ResolveResult，明确稳定事件键、效果因果、知识/承诺来源及整体失败；要求状态和事件对应、重载引用可解析 |
| R4 | P1 | History 要求受众与顺序，但既有 bundle 的独立正文数组没有统一顺序/受众字段 | Task 1 提前 Bundle2 有序 expressions，逐段校验和传播，History 与展示来自同一批准结果；Task 2 显式行动受众。覆盖同场第三人未听私聊和对白不能提前知道后段信息 |
| R5 | P2 | 崩溃恢复可重用 candidateVersion 重新创作，HTTP 上限不能保证三版上限 | Task 7 加服务端 candidateHash；Task 8 在新候选工作前 CAS 预留版本，崩溃不退回额度，同号不重新创作；B 核对 epoch/lease/version/hash，增加作者后和审阅后的崩溃测试 |
| R6 | P1 | 同一子智能体复核发现新增 abandon_quest 仍会被 `performTurn.ts` 的 talk-only 生成边界排除 | Task 3 明确当前 registry 证明的退出动作进入统一 pending/source，补 job 类型、无焦点场景、A 成功/B 失败重试测试；总 Spec §8.2 同步有限退出入口 |

主智能体另补齐 Spec 阅读章节定位、完整固定 NewGameInput、本地 thinking=`on` 与 wire=`enabled` 的区别，以及同一传输 role 下不同 purpose 的超时和每次 HTTP 计数入口。零网络 register 只验证本地配置，不宣称实测 provider 兼容。保留 descriptor 必需的最小 continuation，移除“live 默认只产 currentScene”，防止在仍沿用 main 消费边界时让移动/交付缺少可消费内容。

## 结论边界

同一子智能体完成最终复核，确认上述问题在文档契约与任务依赖层面均已闭合，没有剩余阻塞。

本报告记录的是计划的可执行性修正，不能作为 P1 功能或剧情质量已通过的证据。P1-A/P1-B/P1-C 均保持未执行；总 Spec 的目标、六条 live 样本和质量门槛不变。
