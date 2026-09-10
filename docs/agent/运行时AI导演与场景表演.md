# 运行时 AI 导演与场景表演

## 职责

运行时 AI 只提出结构化叙事包。应用层编排上下文、提案审批和持久化；玩法层裁决状态变化，领域 helper 提交事件并重建记忆。AI 不直接写存档，也不决定行动合法性、关系数值、知识、战斗或结局立场。

相关边界见 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)、[NPC人格知识与关系图](./NPC人格知识与关系图.md) 和 [世界动态具象化](./世界动态具象化.md)。

## 当前契约

生产叙事走**分阶段链路**（planning → narration/character/choices 表达单元）。

- 生产 provider 的叙事触发只有 `initialization`（开局）和 `narrative_choice`（正式选择）两类；`npc_free_text` 仍走既有焦点 NPC 输入路径。两者共用同一套四阶段 source。
- 生产装配点是 `createStageSource`（`src/game/application/server/ai/sourceFactory.ts`）。旧完整包源 `liveNarrativeBundleSource.ts` **已无任何生产调用**，仅保留给显式离线 fixture；不得把它描述为生产路径。
- 一次逻辑任务（job）固定四阶段：`planning` 先产结构骨架（世界/单元/观察/分支），再由 `narration`、`character`、`choices` 三类表达单元按 DAG 依赖顺序产展示文本。规划素材（尤其 `opening.prologue`）**不是最终展示文本**，必须经旁白单元覆盖后才发布。
- 骨架必须先过 `approvePlan`（含 `checkUnitGraph` 图结构校验），再逐单元过 `approveUnit` 与 `collectDisclosures`。任一步失败不部分写入。
- 单元调度用 `readyUnits`：只选依赖已全部通过且自身未完成的单元；每 job 最多 2 个在途 provider 请求。
- `planning` 固定逻辑 key；表达单元的存储 key 由服务端按 point/stage/speaker/ordinal 铸造，模型重命名无效。
- 隐藏事实与私密事实正文绝不进入 prompt。角色 prompt 只接 `SafeContext`：人格仅公开结构化面，可说事实 = 说话人可知 ∩ 对受众可披露。
- **实体 id 由服务端固定分配**，模型不得自造：开局链路 `player_0`、`npc_0`、`loc_0`、`quest_0`，公开事实按数组下标为 `fact_0`、`fact_1`……自造会导致 `unknown_speaker` 等整体失败。
- **观察与单元的归属必须同 `stepKey` 且观察 `order ≤` 单元 `order`**（`observationsForUnit`）。跨 step 引用一律被拒（`observation_without_source`）。choices 单元不得引用观察。
- **观察 certainty 不得升级**：单元输出里某事实的 certainty 不得高于观察声明的 certainty（可降级为 `suspected`，不可把 `suspected` 写成 `known`）。本单元要披露的观察必须写进某个 part 的 `facts`——写进 `beatIds` 或 `evidence` 不算披露。

历史完整包契约（`NarrativeBundleSource.generate` 一次返回原子提案）已不再是生产路径，仅作既有代码与 fixture 的历史背景，不据此描述生产续接。

<!-- 以下为旧完整包契约的历史描述，保留供理解既有代码，不再是生产路径：
- `generatePendingNarrativeBundle` 最多四次完整尝试。后续尝试携带稳定解析、引用或审批拒绝原因；仍失败则保留同一 `jobId` 的 `provider_failed`，由显式 `{ "retry": true }` 手动重试。
- bundle step 必须由服务端 descriptor 投影；stepKey 唯一、无环、最多 12 步。非终点没有 choices，`next_decision` 终点恰好两个选项，`ending` 终点没有 choices 且没有 continuation scenes。
- 生产移动、探索、取物、给予、战斗开始与胜利交接必须消费匹配的 bundle 步骤；缺失或失效零写入。
- 决策 prompt 的唯一合法续接图为每个 `candidateId` 同时投影服务端 Action；对话候选包含目标 NPC、dialogueAct 和结构化 topic。AI 只为该候选写 label，不能根据裸 candidateId 猜测行动语义或改写 registry。
-->

- `mode="ai"` 只投影已审批的 `generated` 场景。缺少正式 NPC focus 台词时投影单一权威 `ask`；失败仍进入同 job 的 failed 状态，不合成 deterministic/default 文案。
- 内容审批同时检查强制节拍、当前地点和焦点 NPC、`objectiveLink`、下一步抵达 NPC、实体引用、题材限制和 NPC speech authority。审批失败不部分写入。

## 关键流程

```
开局创建 / 玩家正式选择
  → initialization_slot / PendingNarrativeJob
  → createStageSource（planning → narration / character / choices）
  → approvePlan（checkUnitGraph）
  → approveUnit + collectDisclosures（逐单元，readyUnits 调度）
  → 整包发布：commit events + rebuild memory + one CAS
  → ready scene + opaque choices
```

Prompt 只接收编译后的公开事实、当前位置、焦点 NPC 的有限结构化交互、强制节拍、实体索引、持有状态、上一场景和有界 memory cards。完整 `GameRecord`、event ledger、其他 NPC 历史、secret fact 正文、玩家长期原文和隐藏 registry 不进入 prompt。分阶段链路的 planning prompt 额外接收预算、公开与私密分区、已选 branch、开局 situation/history/novelty；表达 prompt 只接收 `SafeContext`。审计中的 `narrativeContext` 只是 block 元数据与预算，不是 prompt 正文副本。

各 stage 使用独立 messages，不共享会话。开局规划里 `opening.prologue` 与描述是内容素材，最终序幕由 narration 单元覆盖后才发布；不能直接展示 planner 的 `prologue`。旁白 prompt 不含 NPC 台词输出字段；choice prompt 只返回两条 id/label，禁止前缀、效果与 Action。

每个逻辑 job 的 provider 请求数受预算约束（`jobBudget` 固定决策表）；表达单元的重试上限为 4 次尝试（含首次）。每次 transport retry 由 `RpgAiClient` 执行；顶层 `ai_call.attempt` 是 transport 序号，`context.retry.attempt` 是重试机制内序号，两者不能混用。空响应不重复发送同一请求。

## 统一重试反馈

`src/game/application/aiGenerationRetry.ts` 是 RPG 生成层的公共反馈契约，覆盖 opening、intent、scene、world 和叙事生成。各 source 使用 `createAiSourceFailure` 构造失败；scene、world 端口直接复用 `AiSourceFailure`，intent 结果与旧开局异常端口只作既有边界格式转换。业务校验只提供稳定 `repairReason`、`repairDetail`，审批使用统一 `rejectionCode`。`repairFromSourceFailure` 负责缺失原因的统一分类：调用失败为 `provider_failure`，结构失败为 `invalid_schema`，不能把网络失败或空响应冒充 `invalid_json`。

内容修复使用 `AiContentRepair`（attempt、reason、可选 rejectionCode/detail）；prompt 由 `renderAiRepairFeedback` 渲染公共反馈段，业务可以追加针对性说明。反馈留在各上下文编译器的必选块内并计入预算；`aiRepairAuditContext` 统一投影审计原因和来源，自动修复序号逐次递增。各用例仍负责各自的次数上限及哪些业务拒绝允许修复。

传输层只重发网络、超时、限流和服务错误请求，沿用相同 messages，在审计中记录上一 transport 失败码；它不理解 JSON schema、实体引用或审批。后续叙事失败保留实际 `AI_CALL_FAILED`/`AI_RESPONSE_INVALID` 分类，并通过已有 failure.reason 保存有界稳定原因码；手动重试消费同 job 的 retryContext。实体名称等自由文本细节只用于当次自动修复，不写入持久化 reason。

## 代码与测试入口

分阶段链路（生产路径）：

- 装配：`src/game/application/server/ai/sourceFactory.ts`（`createStageSource`）、`compositionRoot.ts`
- 编排：`src/game/application/narrativeGeneration/runJob.ts`（`MAX_IN_FLIGHT=2`、`readyUnits` 调度）、`stageSource.ts`、`initializationJob.ts`、`decisionJob.ts`、`jobBudget.ts`
- 审批：`src/game/application/narrativeGeneration/approveUnit.ts`、`assembleBundle.ts`、`publishJob.ts`、`realizeObservations.ts`
- 安全上下文投影：`src/game/application/narrativeGeneration/perspectiveContext.ts`（`SafeContext`、`requiredObservations`）
- 生产 prompt：`src/game/application/server/ai/staged/planningPrompt.ts`、`narrationPrompt.ts`、`characterPrompt.ts`、`choicePrompt.ts`、`liveStageSource.ts`
- 规划契约与图校验：`src/game/gameplay/rpg/narrativePlanning/`（`approvePlan.ts`、`unitGraph.ts`、`observations.ts`、`branches.ts`、`sceneSnapshot.ts`）
- 统一反馈：`src/game/application/aiGenerationRetry.ts`
- 领域契约：`src/game/domain/narrative.ts`、`src/game/domain/pendingNarrativeJob.ts`

旧完整包入口（`generatePendingNarrativeBundle.ts`、`narrativeBundleSource.ts`、`approveNarrativeBundle.ts`、`liveNarrativeBundleSource.ts`、`consumeNarrativeBundle.ts`、`gameplay/rpg/narrativeBundle/`）已无生产调用，仅在既有测试与显式 fixture 中保留。

定向检查可运行 `npx vitest run src/game/application/narrativeGeneration/ src/game/gameplay/rpg/narrativePlanning/ src/game/application/server/ai/staged/`；完整边界和类型检查见 [游戏开发规范](../游戏开发规范.md)。

## 条件关联阅读

需要修改叙事上下文或隐私时，先读 [NPC人格知识与关系图](./NPC人格知识与关系图.md)；需要修改事件、记忆或回滚时，先读 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)；需要修改新实体、地点或预算审批时，先读 [世界动态具象化](./世界动态具象化.md) 与 [实体与组件世界状态](./实体与组件世界状态.md)；需要修改开关、provider 或失败分类时，先读 [AI环境](./AI环境.md) 与 [AI文本审计](./AI文本审计.md)。
