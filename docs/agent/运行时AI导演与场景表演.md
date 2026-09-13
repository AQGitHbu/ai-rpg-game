# 运行时 AI 导演与场景表演

## 职责

运行时 AI 只提出结构化叙事包。应用层编排上下文、提案审批和持久化；玩法层裁决状态变化，领域 helper 提交事件并重建记忆。AI 不直接写存档，也不决定行动合法性、关系数值、知识、战斗或结局立场。

相关边界见 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)、[NPC人格知识与关系图](./NPC人格知识与关系图.md) 和 [世界动态具象化](./世界动态具象化.md)。

## 当前契约

- 生产 provider 只有 `initialization`、`narrative_choice`、`npc_free_text` 三类触发。开局由 opening source 直接编译为 ready；正式选择和焦点 NPC 自定义输入进入 pending job。
- 初始化由唯一的 `buildOpeningNarrativePrompt` 传入完整 `GameSetup`、叙事风格策略和最多三条近期 novelty 摘要；玩家设定优先于 novelty。开局 source 与后续叙事共用生产 `RpgAiClient`、transport 策略和 application 审批；结构预检通过后调用统一候选语义审阅。作者与审阅器共享开局字段语义、事实 key→正式 ID 映射及披露边界，事实目录中存有秘密不等于玩家已获知。递送型开局还须建立具体身份核验依据及知情来源，单纯持有物品或接受委托不构成接应资格证明；允许保密条件暂缓告知，不预写未来核验成功。
- 初始化最多三次完整尝试；source、候选校验、场景审批和 novelty 拒绝都通过统一修复反馈传到下一次 opening context。调查方式须符合对象数组契约，陌生人关系仍要求 neutral 且无历史依据；格式或关系失败不靠补造字段放行。
- `NarrativeBundleSource.generate` 一次返回原子提案：可选 `worldDelta`、`currentScene`、`continuationScenes` 和 `terminal`。生产续接图唯一存放在 `storyState.narrative.narrativeBundle`。
- 决策作者使用 `{worldDelta, sceneDrafts:[{slotKey,scene}], interactionProposals?, graph?}`；`projectNarrativeDraft` 为 prompt 和 `compileNarrativeDraft` 提供同一槽投影，程序按明确 key 组装上述内部提案。普通决策、下一幕抵达和退出终局都由当前正式状态决定步骤与终点；可用归还图须显式选择 `graph=return_delivery`。缺失、重复、未知槽或选择数量错误带路径拒绝，不按数组位置猜归属，不补正文或改绑行动。旧 DTO 仅能通过显式 `allowLegacyDecisionDto` 历史 fixture 适配，生产不启用；合法 `@current.location` 可解析为当前地点 ID，不按名称猜测。编译后仍执行相同 parser 与审批。
- `generatePendingNarrativeBundle` 每个持久化 epoch 最多三个不可复用的候选版本。后续版本携带稳定解析、引用或审批拒绝原因；仍失败则保留同一 `jobId` 的 `provider_failed`，由显式 `{ "retry": true }` 手动重试。候选版本、候选 hash、lease 和 HTTP 预算均随 pending job 落盘，恢复 worker 先抢 10 分钟 lease；旧 worker 的完整 attempt predicate 不匹配时只能得到 stale。
- 成功路径是审批生成包、提交场景事件、重建记忆，再调用 `repository.applyState`。世界增量、ready scene、choice registry、bundle 和记忆在同一次 scene CAS 中写回。
- bundle step 必须由服务端 descriptor 投影；stepKey 唯一、无环、最多 12 步。非终点没有 choices，`next_decision` 终点恰好两个选项，`ending` 终点没有 choices 且没有 continuation scenes。
- 决策 prompt 为每个已有 `candidateId` 同时投影服务端 Action；对话候选包含目标 NPC、dialogueAct 和结构化 topic。新增互动须提交封闭的 `interactionProposals` 并经预览审批，才能绑定相应候选；不能按选项数组位置把一个 label 改绑到另一种 Action，也不能根据裸 candidateId 猜测行动语义或改写 registry。
- NPC 的 `offer_condition` 带有已授权互动提案时，作者须在终点提供对应 `interaction:proposalKey` 的真实行动选择，并保留原条款；不得把答应条件写成普通交谈。应用层按候选引用携带原提案并拒绝冲突修改，语义审阅核对台词与行动及条件先后；提案获准不等于条件已经成立。
- 生产移动、探索、取物、给予、战斗开始与胜利交接必须消费匹配的 bundle 步骤；缺失或失效零写入。活跃战斗、战败恢复和终幕立场由规则直接处理，不增加 provider 调用。`PreparedContinuationState` 及其消费函数只供显式离线 fixture；不能据此描述生产续接。
- `mode="ai"` 只投影已审批的 `generated` 场景。缺少正式 NPC focus 台词时投影单一权威 `ask`；失败仍进入同 job 的 failed 状态，不合成 deterministic/default 文案。
- 内容审批同时检查强制节拍、当前地点和焦点 NPC、`objectiveLink`、下一步抵达 NPC、实体引用、题材限制和 NPC speech authority。审批失败不部分写入。
- 决策上下文以 `consumer=author|reviewer` 共用事实、权限、行动及演化依据；作者获得 sceneDrafts 传输契约，审阅器获得实际编译后 NarrativeBundleProposal 契约（含服务端附加的 npcOutwardProposals）。作者修复指令和抵达输出骨架不进入审阅上下文，candidateHash 仍绑定原内部候选；审阅不改写候选、不按作者传输字段误判内部表示。
- 生产语义审阅的 `ruleBasis` 由服务端投影当前输入、真实 Action 与候选绑定、续接 step、正式物品及事实/权限。阻断缺陷必须带可存在性校验的候选 `path` 和 `evidence={basisKey,impact,detail}`；依据必须存在、影响种类须属于该依据，detail 说明具体规则后果。物品状态影响只能引用具体正式物品，普通无效果服饰、环境或风格写入 `qualityObservations`，不改变规则 verdict。无依据、空缺陷或混入非法缺陷的 revise 整体成为显式 uncertain，不过滤后冒充 pass。服务端校验依据与路径，不以此替代模型对语义冲突的判断。
- 事实引用许可与披露正文分别投影：获准 NPC 互动提案里的事实 ID 存在且可用于对应提案，不要求出现在公开正文目录；该许可不授权当前台词说出秘密，也不代表行动已执行。秘密正文继续按 speaker authority 裁剪。
- 每个完整 opening/decision 候选由服务端计算 `candidateVersion` 与 `candidateHash`，最多保留初稿加两次修订；结构/规则预检通过后只做一次语义审阅。审阅只能返回非空缺陷或明确 provider/uncertain 失败，不能修改候选、规则或知识；正文、受众、NPC outward 依据或 proposal 任一变化都会使旧 pass 失效。

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

第一次固定选择生成续接时，`selectedDialogue` 保留 act、topic 和 label。决策上下文通过所选公开 fact 或初始化 thread 找回因果事件，并加入一次性的“开局背景与本次回应”必选块；正文只含公开历史、公开问题和焦点 NPC 当前允许的目标与关系。叙事包生产路径不再以本地 8,000 estimated tokens 闸门拒绝请求；保留编译来源与权限裁剪，由 provider 报告实际上下文限制，失败走统一协议。首次调用以后不再强制注入该块，后续走记忆召回。

需要条件披露、承诺或具体互动判断时，`prepareNpcNarrativeContext` 只为当前同场焦点 NPC 编译私密输入，调用独立判断 source 后再做 outward 授权；作者与审阅器只接收获准的对外投影。开局与普通问候不因此增加角色调用。角色判断使用该次生成的候选版本、取消信号和 HTTP 预算，不提前写入知识或互动效果。同一 worker 的固定规则快照内，成功且已授权的 outward 在作者候选修订中复用；仅复用 outward，作者与审阅仍使用当前 job、候选版本、修复反馈和预算回调。失败与取消不缓存，不跨 job、worker 或进程恢复复用，不新增持久化字段。

每个逻辑 pending job 的一个 epoch 最多执行三次完整的 source 生成加审批尝试；后续完整尝试携带稳定拒绝原因。每个 epoch 最多 24 次 HTTP（候选版本、作者/NPC 判断、审阅与各自最多两次 transport retry 的总预算），请求前预留且崩溃后不退回。每次完整尝试内部仍可由 `RpgAiClient` 执行 transport retry；顶层 `ai_call.attempt` 是 transport 序号，`context.retry.attempt` 是重试机制内序号，两者不能混用。空响应不重复发送同一请求。

## 统一重试反馈

`src/game/application/aiGenerationRetry.ts` 是 RPG 生成层的公共反馈契约，覆盖 opening、intent、scene、world 和 narrative bundle。各 source 使用 `createAiSourceFailure` 构造失败；bundle、scene、world 端口直接复用 `AiSourceFailure`，intent 结果与旧开局异常端口只作既有边界格式转换。业务校验只提供稳定 `repairReason`、`repairDetail`，审批使用统一 `rejectionCode`。`repairFromSourceFailure` 负责缺失原因的统一分类：调用失败为 `provider_failure`，结构失败为 `invalid_schema`，不能把网络失败或空响应冒充 `invalid_json`。

内容修复使用 `AiContentRepair`（attempt、reason、可选 rejectionCode/detail）；prompt 由 `renderAiRepairFeedback` 渲染公共反馈段，业务可以追加针对性说明。同一运行中的下一版同时接收上一完整候选及累计缺陷，二者仅是待修订材料，不进入实际 History，也不能改写已提交的玩家行动与状态。反馈留在上下文必选块中；`aiRepairAuditContext` 统一投影审计原因和来源，自动修复序号逐次递增。各用例仍负责各自的次数上限及哪些业务拒绝允许修复。

`RpgAiClient` 在每次预留请求后独立限制整个 transport 等待（含排队和响应体），不只依赖底层遵守 AbortSignal；外部取消和硬超时都隔离迟到结果，禁止其进入正文审批或写回。取消是本地等待及写回边界，不代表 provider 已停止计费。批次取消信号经 composition 传入开局与 pending 生成。

传输层只重发网络、超时、限流和服务错误请求，沿用相同 messages，在审计中记录上一 transport 失败码；它不理解 JSON schema、实体引用或审批。后续叙事失败保留实际 `AI_CALL_FAILED`/`AI_RESPONSE_INVALID` 分类，并通过已有 failure.reason 保存有界稳定原因码；手动重试消费同 job 的 retryContext。实体名称等自由文本细节只用于当次自动修复，不写入持久化 reason。

## 代码与测试入口

- 编排：`src/game/application/generatePendingNarrativeBundle.ts`、`src/game/application/narrativeBundleSource.ts`、`src/game/application/approveNarrativeBundle.ts`
- 统一反馈：`src/game/application/aiGenerationRetry.ts`、`src/game/application/aiGenerationRetry.test.ts`
- 领域契约：`src/game/domain/narrativeBundle.ts`、`src/game/domain/narrative.ts`、`src/game/domain/pendingNarrativeJob.ts`
- 规则审阅：`src/game/application/server/ai/liveNarrativeCandidateReview.ts`、`src/game/application/server/ai/narrativeReviewRules.ts`；测试包含已保存换幕候选的服饰观察、事实引用权限与阻断依据。
- 生产 source 与 prompt：`src/game/application/server/ai/liveNarrativeBundleSource.ts`、`src/game/application/server/ai/openingNarrativePrompt.ts`、`src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`
- 消费与规则：`src/game/application/consumeNarrativeBundle.ts`、`src/game/gameplay/rpg/narrativeBundle/`
- 测试：`src/game/application/generatePendingNarrativeBundle.test.ts`、`src/game/application/approveNarrativeBundle.test.ts`、`src/game/application/server/ai/liveNarrativeBundleSource.test.ts`

定向检查可运行 `npx vitest run src/game/application/generatePendingNarrativeBundle.test.ts src/game/application/approveNarrativeBundle.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts`；完整边界和类型检查见 [游戏开发规范](../游戏开发规范.md)。

## 条件关联阅读

需要修改叙事上下文或隐私时，先读 [NPC人格知识与关系图](./NPC人格知识与关系图.md)；需要修改事件、记忆或回滚时，先读 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)；需要修改新实体、地点或预算审批时，先读 [世界动态具象化](./世界动态具象化.md) 与 [实体与组件世界状态](./实体与组件世界状态.md)；需要修改开关、provider 或失败分类时，先读 [AI环境](./AI环境.md) 与 [AI文本审计](./AI文本审计.md)。
