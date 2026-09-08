# 运行时 AI 导演与场景表演

## 职责

运行时 AI 只提出结构化叙事包。应用层编排上下文、提案审批和持久化；玩法层裁决状态变化，领域 helper 提交事件并重建记忆。AI 不直接写存档，也不决定行动合法性、关系数值、知识、战斗或结局立场。

相关边界见 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)、[NPC人格知识与关系图](./NPC人格知识与关系图.md) 和 [世界动态具象化](./世界动态具象化.md)。

## 当前契约

- 生产 provider 只有 `initialization`、`narrative_choice`、`npc_free_text` 三类触发。开局由 opening source 直接编译为 ready；正式选择和焦点 NPC 自定义输入进入 pending job。
- `NarrativeBundleSource.generate` 一次返回原子提案：可选 `worldDelta`、`currentScene`、`continuationScenes` 和 `terminal`。生产续接图唯一存放在 `storyState.narrative.narrativeBundle`。
- `generatePendingNarrativeBundle` 最多四次完整尝试。后续尝试携带稳定解析、引用或审批拒绝原因；仍失败则保留同一 `jobId` 的 `provider_failed`，由显式 `{ "retry": true }` 手动重试。
- 成功路径是审批生成包、提交场景事件、重建记忆，再调用 `repository.applyState`。世界增量、ready scene、choice registry、bundle 和记忆在同一次 scene CAS 中写回。
- bundle step 必须由服务端 descriptor 投影；stepKey 唯一、无环、最多 12 步。非终点没有 choices，`next_decision` 终点恰好两个选项，`ending` 终点没有 choices 且没有 continuation scenes。
- 生产移动、探索、取物、给予、战斗开始与胜利交接必须消费匹配的 bundle 步骤；缺失或失效零写入。活跃战斗、战败恢复和终幕立场由规则直接处理，不增加 provider 调用。`PreparedContinuationState` 及其消费函数只供显式离线 fixture；不能据此描述生产续接。
- `mode="ai"` 只投影已审批的 `generated` 场景。缺少正式 NPC focus 台词时投影单一权威 `ask`；失败仍进入同 job 的 failed 状态，不合成 deterministic/default 文案。
- 内容审批同时检查强制节拍、当前地点和焦点 NPC、`objectiveLink`、下一步抵达 NPC、实体引用、题材限制和 NPC speech authority。审批失败不部分写入。

## 关键流程

```
玩家正式选择 / NPC 自定义输入
  → PendingNarrativeJob
  → compileDecisionNarrativeContext
  → NarrativeBundleSource
  → approveNarrativeBundle
  → commit events + rebuild memory + one CAS
  → ready scene + opaque choices + narrativeBundle
```

Prompt 只接收编译后的公开事实、当前位置、焦点 NPC 的有限结构化交互、强制节拍、实体索引、持有状态、上一场景和有界 memory cards。完整 `GameRecord`、event ledger、其他 NPC 历史、secret fact 正文、玩家长期原文和隐藏 registry 不进入 prompt。审计中的 `narrativeContext` 只是 block 元数据与预算，不是 prompt 正文副本。

每个逻辑 pending job 最多执行四次完整的 source 生成加审批尝试；后续完整尝试携带稳定拒绝原因。每次完整尝试内部仍可由 `RpgAiClient` 执行 transport retry；顶层 `ai_call.attempt` 是 transport 序号，`context.retry.attempt` 是重试机制内序号，两者不能混用。空响应不重复发送同一请求。

## 代码与测试入口

- 编排：`src/game/application/generatePendingNarrativeBundle.ts`、`src/game/application/narrativeBundleSource.ts`、`src/game/application/approveNarrativeBundle.ts`
- 领域契约：`src/game/domain/narrativeBundle.ts`、`src/game/domain/narrative.ts`、`src/game/domain/pendingNarrativeJob.ts`
- 生产 source 与 prompt：`src/game/application/server/ai/liveNarrativeBundleSource.ts`、`src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- 消费与规则：`src/game/application/consumeNarrativeBundle.ts`、`src/game/gameplay/rpg/narrativeBundle/`
- 测试：`src/game/application/generatePendingNarrativeBundle.test.ts`、`src/game/application/approveNarrativeBundle.test.ts`、`src/game/application/server/ai/liveNarrativeBundleSource.test.ts`

定向检查可运行 `npx vitest run src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts`；完整边界和类型检查见 [游戏开发规范](../游戏开发规范.md)。

## 条件关联阅读

需要修改叙事上下文或隐私时，先读 [NPC人格知识与关系图](./NPC人格知识与关系图.md)；需要修改事件、记忆或回滚时，先读 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)；需要修改新实体、地点或预算审批时，先读 [世界动态具象化](./世界动态具象化.md) 与 [实体与组件世界状态](./实体与组件世界状态.md)；需要修改开关、provider 或失败分类时，先读 [AI环境](./AI环境.md) 与 [AI文本审计](./AI文本审计.md)。
