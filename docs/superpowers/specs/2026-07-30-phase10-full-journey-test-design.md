# Phase 10 双模式完整剧情旅程测试设计

## 目标

建立一个可持续扩展的“剧情旅程测试框架”，用同一套旅程断言覆盖两种运行方式：

- `record`：真实调用 director、writer、NPC AI，并把可回放数据写入本地测试产物；
- `replay`：不访问网络，从已确认的本地 fixture 回放相同 AI 输出，仍经过全部本地审批和游戏规则。

测试必须在内容预算和回合预算内，从开局场景推进到成功结局，并至少覆盖：

1. 真实或回放的场景叙述；
2. 两个固定选项及选择后继续生成；
3. 至少一次 NPC 对话；
4. 一个此前未登场地点进入流程；
5. 一个此前未登场 NPC 进入流程；
6. 一个道具进入背包或产生受规则控制的消耗；
7. 一场战斗及其规则裁决；
8. 主线任务完成和成功结局；
9. 关键步骤存档重载一致；
10. 全程不泄漏 `actionKey`、隐藏事实或 provider 配置。

## 当前边界

Phase 10 不允许运行时修改蓝图。因此第一版中的“新地点、新角色、新道具”严格表示：

- 它们已经存在于受内容预算约束的 blueprint 中；
- 测试开始时尚未拜访、尚未登场或尚未获得；
- AI 可以规划其登场和表现，但是否解锁、获得或可交互由游戏规则决定。

AI 动态创建新的 NPC、地点、物品、任务或数值，属于后续“受审批的蓝图扩展”阶段，不在本测试框架中暗中实现。

## 双模式契约

### Record 模式

- 必须显式设置 `RUN_REAL_AI_JOURNEY=1`，否则在任何网络调用前失败；
- 使用生产等价的 runtime source、审批器、规则用例和 SQLite repository；
- 只记录已经解析成领域类型的 director/writer/NPC 候选输出、稳定诊断码、调用序号和安全上下文指纹；
- 不记录原始 prompt、模型原文、API URL、API Key、完整隐藏世界状态；
- 默认写入 `artifacts/phase10-journey/<run-id>/`，不得自动覆盖仓库中的 golden fixture；
- 只有显式执行 fixture 提升动作，且离线回放通过后，才能更新 `data/fixtures/phase10-journey/`。

### Replay 模式

- 网络调用数必须为零；
- fixture source 实现与真实 source 相同的三个 port；
- 每个 fixture 条目必须匹配角色、调用序号、契约版本和安全上下文指纹；
- 回放值不得绕过 `approveDirectorProposal`、`approveSceneScript`、`approveNpcPerformance`；
- fixture 缺失、顺序错误、指纹漂移或审批失败都必须硬失败，不能静默退回通用 fallback。

## 旅程稳定性

真实 AI 不能保证每次主动选择测试所需的动作。测试框架使用显式的 `coverageTarget` 作为“导演测试委托”，它只从当前合法 `AvailableAction` 中选一个目标，不能创建动作、改变规则或指定结果。

每个场景仍由 director 提案、规则批准、writer 表现和可选 NPC 表演组成。旅程 runner 只在两个已批准选项中选择与当前覆盖目标对应的 token；若 AI 未提供目标选项，本轮记录为未命中并在预算内继续。超过回合或 AI 调用预算即失败。

## Fixture 结构

一个 fixture set 包含：

```text
data/fixtures/phase10-journey/<fixture-id>/
  manifest.json
  calls.jsonl
  expected-summary.json
```

`manifest.json` 固定：

- fixture schema version；
- runtime narrative contract version；
- blueprint fixture id 和内容 hash；
- 来源 `recorded` 或 `curated`；
- provider/model 只保留非敏感的可选标签；
- 录制时间；
- 最大回合、最大 AI 调用数；
- calls 文件 hash。

`calls.jsonl` 每行固定：

- sequence；
- role；
- attempt；
- request fingerprint；
- parsed proposal；
- source outcome；
- duration/tokens 的可选白名单摘要。

`expected-summary.json` 只保存覆盖计数、终局类型、最终 revision、回合数和规则状态摘要，不保存隐藏正文。

## 分层执行

- `npm run test:phase10-journey`：日常离线 golden 回放，零网络，必须稳定；
- `npm run test:phase10-journey-script`：CLI 安全门禁和 fixture 违约测试；
- `RUN_REAL_AI_JOURNEY=1 npm run smoke:ai:phase10-journey`：人工显式真实认证并生成候选录制产物；
- 普通 `npm test` 可以包含离线旅程，但绝不包含真实 AI。

## 通过标准

离线和真实模式共享同一个 `JourneyReport` 校验器。以下任一情况都失败：

- 未到成功结局；
- 未覆盖 NPC、地点、道具或战斗；
- 没有任何生成的 NPC 台词；
- 使用了 fallback 完成必需的 AI 场景；
- 超过回合、调用或内容预算；
- 选项无法映射到当前合法动作；
- reload 不一致；
- fixture 漂移；
- 网络、秘密或内部动作标识泄漏。

