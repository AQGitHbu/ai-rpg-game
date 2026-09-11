# 运行时 AI 导演与场景表演

## 职责

运行时 AI 只提出结构化叙事包。应用层编排上下文、提案审批和持久化；玩法层裁决状态变化，领域 helper 提交事件并重建记忆。AI 不直接写存档，也不决定行动合法性、关系数值、知识、战斗或结局立场。

相关边界见 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)、[NPC人格知识与关系图](./NPC人格知识与关系图.md) 和 [世界动态具象化](./世界动态具象化.md)。

## 当前契约

生产叙事走**分阶段链路**（planning → narration/character/choices 表达单元）。

- 生产 provider 的叙事触发只有 `initialization`（开局）和 `narrative_choice`（正式选择）两类；`npc_free_text` 仍走既有焦点 NPC 输入路径。两者共用同一套四阶段 source。
- 生产装配点是 `createStageSource`（`src/game/application/server/ai/sourceFactory.ts`）。旧完整包源 `liveNarrativeBundleSource.ts` **已无任何生产调用**，仅保留给显式离线 fixture；不得把它描述为生产路径。
- 一次逻辑任务（job）分为四类职责，并非固定四次 API 调用：`planning` 决定事件、世界变化提案、NPC 表达内容与玩家回应语义，再由 `narration`、`character`、`choices` 三类表达单元按 DAG 依赖顺序产展示文本。规划素材（尤其 `opening.prologue`）**不是最终展示文本**，必须经旁白单元覆盖后才发布。
- 骨架先经 `approvePlanningContext` 预览世界增量、核对服务端场景图，再经 `approvePlan` 与 `approvePlanDecision` 检查图结构和候选语义；表达逐单元经过 `approveUnit` 与 `collectDisclosures`，发布时再次通过同一 `approvePlanningContext` 预览并重放审批，不能退回增量前世界审批终幕。任一步失败不部分写入。
- 当前规则要求的必选节拍（除可选 atmosphere）须按原 beatId/kind 各分配给唯一的 current 旁白单元；当前旁白不得增加服务端未要求的节拍（额外氛围只用固定键 atmosphere）。NPC 可另行回答，但不能替代旁白覆盖，也不能用未来场景提前代偿。分配不符以 `plan_mandatory_beat_mismatch` 在表达请求前退回规划，反馈携带所需节拍与场景契约；不复制 NPC 正文、不扩大知识权限。恢复旧缓存时，若骨架违反此契约，撤销该骨架及全部依赖表达后有界重新规划；已用请求和尝试次数保留，成功后移除新骨架不再引用的旧表达缓存。
- 普通对话候选允许 `target/deferredLocation=null`，只绑定已批准的 `dialogueAct/topic`，两个候选不能是同一语义。不为选项创建地点或改写任务；不同走向不等于不同地点。实际选择及当回合已提交结果进入下一次规划。
- 当前场景不能被未来场景替代。已有存档中的非空路线目标继续按旧规则审批、持久化和消费，返程仍遵守在场性；这只是兼容能力，不是每个新决策的必需结构。
- 下一幕需要世界增量时，首次规划不把增量前的临时终点当作下一幕图；规则预览增量后核对 steps/terminal。场景契约 `sceneContract` 明确当前回应 NPC、各场景是否允许 choices、下一决策的 stepKey/NPC/候选 ID；有已批准图的重试以该图替换原待生成图，完整反馈放在提示末尾，沿用已批准增量重新规划意图，不静默搬移选项或更换 NPC。`graphStatus=approved` 仅表示图已编译，不表示整包已获批；所有审批仍执行，仍失败则显式重试。终幕提案 `decision=null`，规则从已具象化结局对派生 trust/support、doubt/challenge，choices 表达只写立场对白，装配为 `endingLabels`，不放进普通 choices。
- `sceneSnapshot` 仅沿当前节点的唯一祖先路径预览触发结果。`approvePlanningContext` 核对提案后附加规则 `ruleSceneGraph`；快照按各步 `absorbedObjectiveIndexes` 预览规则会自动确认的连续事实目标，限对应地点，城镇容器移动不等于进入建筑。它不来自模型声明，不授予无关事实或 NPC 私密知识，也不写入真实 ledger。获批上游实际披露与受众范围仍单独决定条件认知。
- 新生产片段保存 premises：消费时复核地点、在场说话人、带账本序号下界的跨场景观察回执，以及可选 `discoveredFactIds` 中的预期规则发现是否已在实际行动后成立；缺失事实时拒绝片段、零写入。旧包缺省该数组不增加隐式前提，同名旧观察回执不能复用。观察兑现还复核来源当前知识、披露权限和 certainty。
- job 协调器每 10 秒为 30 秒租约续租，续租与 save/publish 共用串行队列；续租失败取消在途请求，最终停止 timer 并释放 fence。规划审批失败有界重试，基础请求预算按获批表达单元数量派生。
- 单元调度用 `readyUnits`：只选依赖已全部通过且自身未完成的单元；每 job 最多 2 个在途 provider 请求。
- `planning` 固定逻辑 key；表达单元的存储 key 由服务端按 point/stage/speaker/ordinal 铸造，模型重命名无效。
- `beat_authority_conflict` 表示规划任务要求了该视角不可知/不可披露的事实或证据，不等于应给角色补知识。没有条件观察的计划在表达调用前预检；有观察依赖时等待实际获批上游，再按真实投影检查。反馈定位单元、视角、不可用引用和允许的事实 ID，并保留已批准世界增量与场景契约；由规划器在原请求/尝试预算内重做，撤销旧骨架依赖表达，不绕过权限或伪造回执。
- 全局规划可以读取私密事实，但表达 prompt 不接收全局规划上下文。角色 prompt 只接 `SafeContext`：可说事实 = 说话人可知 ∩ 对受众可披露。未有公开来源的人格锚点/目标正文不转发，保留公开身份、情绪、关系档位和受控行为。
- **实体 id 由服务端固定分配**，模型不得自造：开局链路 `player_0`、`npc_0`、`loc_0`、`quest_0`，公开事实按数组下标为 `fact_0`、`fact_1`……自造会导致 `unknown_speaker` 等整体失败。
- **观察与单元的归属必须同 `stepKey` 且观察 `order ≤` 单元 `order`**（`observationsForUnit`）。跨 step 引用一律被拒（`observation_without_source`）。choices 单元不得引用观察。
- **观察 certainty 不得升级**：单元输出里某事实的 certainty 不得高于观察声明的 certainty（可降级为 `suspected`，不可把 `suspected` 写成 `known`）。本单元要披露的观察必须写进某个 part 的 `facts`——写进 `beatIds` 或 `evidence` 不算披露。

- bundle step 由服务端 descriptor 投影；stepKey 唯一、无环、最多 12 步。非终点没有 choices，`next_decision` 终点恰好两个选项，`ending` 终点没有普通 choices 且没有 continuation scenes。
- 生产移动、探索、取物、给予、战斗开始与胜利交接继续消费匹配的 bundle 步骤；缺失或失效零写入。表达器不能改变行动、目标 NPC、dialogueAct、topic 或 registry。

- `mode="ai"` 只投影已审批的 `generated` 场景。缺少正式 NPC focus 台词时投影单一权威 `ask`；失败仍进入同 job 的 failed 状态，不合成 deterministic/default 文案。
- 内容审批同时检查强制节拍、当前地点和焦点 NPC、`objectiveLink`、下一步抵达 NPC、实体引用、题材限制和 NPC speech authority。审批失败不部分写入。

## 关键流程

```
开局创建 / 玩家正式选择
  → initialization_slot / PendingNarrativeJob
  → createStageSource（planning → narration / character / choices）
  → approvePlan（checkUnitGraph）
  → approveUnit + collectDisclosures（逐单元，readyUnits 调度）
  → 新知识对白：disclosure_review 通过才批准，下游再读取
  → 整包发布：commit events + rebuild memory + one CAS
  → ready scene + opaque choices
```

Prompt 只接收编译后的公开事实、当前位置、焦点 NPC 的有限结构化交互、强制节拍、实体索引、持有状态、上一场景和有界 memory cards。不向表达 prompt 传完整 `GameRecord`、event ledger、其他 NPC 历史、secret fact 正文、玩家长期原文或隐藏 registry。全局 planning prompt 接收预算、公开与私密分区、已选 branch、当前 job 的 `selectedDialogue` 与 `domainEventIds` 对应的已提交结果，以及开局 situation/history/novelty；表达 prompt 只接收 `SafeContext`。审计中的 `narrativeContext` 只是 block 元数据与预算，不是 prompt 正文副本。

各 stage 使用独立 messages，不共享会话。本场公开定位由步骤快照投影地点 ID/名称、玩家名称与本场参与说话人名称，不携带地点背景或 NPC 隐藏动机。当前任务的实际选择 label（自由输入则为本次 utterance）作为待回应话语绑定到 current 旁白、选项和当前焦点 NPC；不转发给未来场景或其他 NPC。话语单独标记为非指令、非已核实事实，不扩大事实引用权限。

各 stage 的展示职责保持分离。开局规划里 `opening.prologue` 与描述是内容素材，最终序幕由 narration 单元覆盖后才发布；不能直接展示 planner 的 `prologue`。旁白 prompt 不含 NPC 台词输出字段；choice prompt 只返回两条 id/label，禁止前缀、效果与 Action。

旁白每个 `part` 最多引用一个节拍，无节拍的氛围段使用空数组；全部段落仍须覆盖全部必选节拍，事实和证据保持逐段归属。多节拍合段由 `approveUnit` 以 `unit_output_beat_ambiguous` 拒绝并在该表达单元内有界重试，装配保留防御性校验，不丢弃节拍或复制正文补覆盖。此限制不套用于 NPC 回答。当前决策旁白通过 `narrationLayout` 只接收排版约束：同一节拍只能构成连续段，独立氛围只允许在最后一个当前旁白单元末尾；先前单元须承接必选节拍。违规以 `unit_output_beat_layout` 在表达阶段退回修复，反馈明确允许的节拍 ID 与氛围权限，不重排获批正文。开局与未来场景不套用当前回合布局。恢复旧任务时，若已批准缓存仍含多节拍合段或布局违规旁白，先撤销该单元及其传递依赖的表达缓存，再按原 DAG 重新生成；规划、无关单元、已扣请求和尝试次数保留。

规划器的 `publicIntent.text` 与 `requiredBeats.instruction` 是规划备注，不直接传给表达器，也不能作为未编码内容的隐式指令。新 live 规划必须给 narration/character 单元及两个普通候选提供 `ExpressionTask`：`intent` 指定受控目的，`focusFactIds` 指定具体内容，`prerequisiteFactIds` 指定先求证再回应的已知说法；缺失以 `plan_task_missing` 拒绝。条件仅表达先后与不无条件承诺，不是交易、调查成功或新增规则动作。旧缓存/离线 fixture 的可选字段保留兼容。

安全编译将任务里的每个事实引用与该时点的可知、可披露事实求交核验；缺一即退回规划，不静默删除条件或转发全局原文。新任务的旁白/NPC 事实范围收窄到任务、必选节拍与本单元观察的引用；动作只投影同 step 且不晚于本单元的获批动作。编译后的 `taskInstruction` 保留目的、具体事实及先求证顺序。旁白/NPC 输出必须覆盖任务事实引用，否则以 `unit_output_task_missing` 拒绝；选项只能返回忠于获批意图的两条纯对白。任意自然语言条件不在这份小契约的表达能力内，不能靠备注交给表达器补写；事实引用覆盖也不等于自然语言语义证明。三个表达 prompt 明确禁止补造玩家经历、往日对白、目击细节和现场证据；旁白不能把口述改成脚印等物证，NPC 不知道时不能编理由或改成失忆，两个候选的条件与承诺不能互相复制。

节拍证据通常只允许本视角知识条目的实际来源。唯一规则结果例外是 current 旁白的强制 `quest_progress/quest_advanced`：服务端确认事件已提交、属于当前 job 且对应本次完成目标后，允许引用该 `quest_completed` 证明任务完成；它不授予事实知识，不适用于 NPC 或未来旁白。拒绝反馈逐节拍列出非法与允许的事件 ID，无需要时可用空证据。合法 ID 不证明任意原文安全，仍需检查真实文本是否编造或隐含泄漏。

每个逻辑 job 的 provider 请求数受预算约束（`jobBudget` 固定决策表）；表达单元的重试上限为 4 次尝试（含首次）。每次 transport retry 由 `RpgAiClient` 执行；顶层 `ai_call.attempt` 是 transport 序号，`context.retry.attempt` 是重试机制内序号，两者不能混用。空响应不重复发送同一请求。

## 统一重试反馈

初始化 requestId 的摘要只绑定用户配置与替换目标，不绑定服务端随机 gameId、seed 或 generationId；同请求复用首次 envelope。pending/failed 初始化槽不能由新请求覆盖，需先显式取消；发布事务再次验证槽归属。查询 pending 任务通过现有 coordinator 恢复调度，不刷新预算；客户端不将无本次请求标记的历史 published 任务视为本次开局完成。

每个执行作用域使用唯一租约 owner，竞争或失租不得把其他 worker 的任务写成 provider_failed。生成作用域按 job 绝对截止时间取消，响应后与发布前复核；传输重试共用剩余 timeout，不重新获得完整时长。截止失败保留为显式重试状态。

新增知识传播的 NPC 对白使用独立审核角色，契约见 [Spec 的角色审批](../superpowers/specs/2026-09-09-staged-narrative-generation-design.md#6-角色表现与认知隔离)。审核只读本次授权事实和实际对白；拒绝、不可判定或服务失败不批准下游认知。服务端保存绑定输出的摘要凭据，恢复时缺失/不匹配会撤销该单元及传递依赖，发布时再验；每次审核先持久扣除额外请求额度。四类生成职责不变。

`src/game/application/aiGenerationRetry.ts` 是 RPG 生成层的公共反馈契约，覆盖 opening、intent、scene、world 和叙事生成。各 source 使用 `createAiSourceFailure` 构造失败；scene、world 端口直接复用 `AiSourceFailure`，intent 结果与旧开局异常端口只作既有边界格式转换。业务校验只提供稳定 `repairReason`、`repairDetail`，审批使用统一 `rejectionCode`。`repairFromSourceFailure` 负责缺失原因的统一分类：调用失败为 `provider_failure`，结构失败为 `invalid_schema`，不能把网络失败或空响应冒充 `invalid_json`。

内容修复使用 `AiContentRepair`（attempt、reason、可选 rejectionCode/detail）；prompt 由 `renderAiRepairFeedback` 渲染公共反馈段，业务可以追加针对性说明。反馈留在各上下文编译器的必选块内并计入预算；`aiRepairAuditContext` 统一投影审计原因和来源，自动修复序号逐次递增。各用例仍负责各自的次数上限及哪些业务拒绝允许修复。

传输层只重发网络、超时、限流和服务错误请求，沿用相同 messages，在审计中记录上一 transport 失败码；它不理解 JSON schema、实体引用或审批。后续叙事失败保留实际 `AI_CALL_FAILED`/`AI_RESPONSE_INVALID` 分类，并通过已有 failure.reason 保存有界稳定原因码；手动重试消费同 job 的 retryContext；游戏侧 failed→pending 后，`generatePendingNarrativeBundle` 通过既有 `jobs.control(retry)` 同步恢复 durable failed 任务的周期和预算，再进入 claim/fence。普通 ensure 不重置失败周期，重试不改变玩家进度或创建新游戏。实体名称等自由文本细节只用于当次自动修复，不写入持久化 reason。

## 代码与测试入口

分阶段链路（生产路径）：

- 装配：`src/game/application/server/ai/sourceFactory.ts`（`createStageSource`）、`compositionRoot.ts`
- 编排：`src/game/application/narrativeGeneration/runJob.ts`（`MAX_IN_FLIGHT=2`、`readyUnits` 调度）、`stageSource.ts`、`initializationJob.ts`、`decisionJob.ts`、`jobBudget.ts`
- 审批：`src/game/application/narrativeGeneration/approveUnit.ts`、`assembleBundle.ts`、`publishJob.ts`、`realizeObservations.ts`
- 安全上下文投影：`src/game/application/narrativeGeneration/perspectiveContext.ts`（`SafeContext`、`requiredObservations`）、`src/game/application/narrativeGeneration/expressionTask.ts`（具体任务安全编译）
- 生产 prompt：`src/game/application/server/ai/staged/planningPrompt.ts`、`narrationPrompt.ts`、`characterPrompt.ts`、`choicePrompt.ts`、`liveStageSource.ts`
- 规划契约与图校验：`src/game/gameplay/rpg/narrativePlanning/`（`approvePlan.ts`、`unitGraph.ts`、`observations.ts`、`branches.ts`、`sceneSnapshot.ts`）
- 统一反馈：`src/game/application/aiGenerationRetry.ts`
- 领域契约：`src/game/domain/narrative.ts`、`src/game/domain/pendingNarrativeJob.ts`

旧完整包 provider 源 `liveNarrativeBundleSource.ts` 不再用于生产。生产仍通过 `generatePendingNarrativeBundle.ts` 委托分阶段 job，使用 `approveNarrativeBundle.ts` 审批装配结果、`gameplay/rpg/narrativeBundle/` 构建规则场景图，并由 `consumeNarrativeBundle.ts` 在真实行动后消费已准备片段。

定向检查可运行 `npx vitest run src/game/application/narrativeGeneration/ src/game/gameplay/rpg/narrativePlanning/ src/game/application/server/ai/staged/`；完整边界和类型检查见 [游戏开发规范](../游戏开发规范.md)。

## 条件关联阅读

需要修改叙事上下文或隐私时，先读 [NPC人格知识与关系图](./NPC人格知识与关系图.md)；需要修改事件、记忆或回滚时，先读 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)；需要修改新实体、地点或预算审批时，先读 [世界动态具象化](./世界动态具象化.md) 与 [实体与组件世界状态](./实体与组件世界状态.md)；需要修改开关、provider 或失败分类时，先读 [AI环境](./AI环境.md) 与 [AI文本审计](./AI文本审计.md)。
