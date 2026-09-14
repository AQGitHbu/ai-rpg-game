# P2 Plan 独立审阅与修订

## 范围与结论

审阅对象为 [P2 Plan](../plans/2026-09-14-narrative-architecture-p2.md)，初审基准为 `codex/narrative-architecture` 的 `7f46362f`。按用户要求，由一个独立子智能体对照总 Spec、范围核查和实际代码审阅，主智能体核实并修订，随后交回同一个子智能体复核。

本次仅修改规划文档，不实施 P2 生产代码、不运行真实模型调用、不改阶段指针。七个 Task 和三个里程碑保持不变；总 Spec 已有的固定记忆、观察者隔离和恢复约束不变，修订补齐其实施接口。

## 发现与处理

初审行号均指上述基准，修订后的契约以 Plan 对应 Task 为准。

| 编号 / 严重性 | 问题及代码依据 | 修订落点 |
| --- | --- | --- |
| R1 / 高 | 原 Plan 297–300 行要求同一 job 固定记忆，却允许恢复后重新准备。`generatePendingNarrativeBundle.ts` 的局部缓存只属于一次 worker 调用；持续推进的 observer 缓存不能保证同 epoch 接管后的候选使用同包 | Task 5 在既有拟新增 attempts 表固定完整 player/NPC 包和哈希，首次候选预留前冻结；恢复直接加载，源失效或已有候选却缺包时显式失败。增加首版后崩溃、SQLite 重开、第二版包哈希一致的验收；Task 6 / M7 记录固定包回放 |
| R2 / 中 | 原 Plan 300 行摘要预留只有 game/generation/job/epoch。`sqliteGameRepository.ts` 接管时保留 epoch、更换 leaseId，既有叙事预留会校验完整 pending-job 谓词；原新接口不能拒绝旧 worker | Task 5 的预留和冻结校验真实租约、有效期及完整谓词；HTTP 和批次额度持久保存。旧租约预留失败不得发送或增加计数；observer 缓存发布仍保持独立来源/CAS 契约 |
| R3 / 中 | 原 Plan 130–132、157、287–300 行未列出实际 NPC 桥接契约。生产经 generator → `prepareNpcNarrativeContext` → projection，只有公共 context 字段不足以安全传递 NPC 包 | Task 2 / 5 增加共用 NPC selector 和桥接私密第三参；公共 context 只含 player 包，NPC 包只到对应 projection，作者仍只收到授权 outward。增加真实 generator 最终 NPC/author 请求隔离断言 |
| R4 / 中，复核发现 | 第一轮修订要求区分预算耗尽与失去租约，但 repository 预留仍只返回 boolean，不能支撑不同失败路径 | 改为含 BUDGET_EXHAUSTED / STALE_ATTEMPT / UNAVAILABLE 的结构化结果；应用层记录失败原因，再适配 source 的 boolean callback。仅额度耗尽可继续读原文，其他两类取消尝试，并要求分支集成测试 |

同时明确 P2-A 交付消费接口与真实 prompt 构造验证，完整生产 generator 装配在 Task 5 验收，避免将后续任务误作为前一里程碑的前置。

## 复核与验证

- 独立子智能体最终复核通过：R1–R4 均已解决，本次限定复核未发现剩余阻断性问题。
- `npm run check:docs`：34 份当前文档，0 错误、0 提醒。该检查未覆盖全部 superpowers 文档；另查本次 3 份文档的 22 个相对链接，0 失效。
- `git diff --check` 通过。新增行为测试仍是 P2 的待实施验收，不能将本次文档审阅视为恢复、权限或剧情质量已通过验证。
