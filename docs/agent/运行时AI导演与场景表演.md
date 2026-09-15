# 运行时 AI 导演与场景表演

## 职责

运行时 AI 只提出结构化叙事包。应用层编排上下文、提案审批和持久化；玩法层裁决状态变化，领域 helper 提交事件并重建记忆。AI 不直接写存档，也不决定行动合法性、关系数值、知识、战斗或结局立场。

相关边界见 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)、[NPC人格知识与关系图](./NPC人格知识与关系图.md) 和 [世界动态具象化](./世界动态具象化.md)。

## 当前契约

- 正式 trust/doubt 终幕候选在同一 bundle 中携带两条有界 `endingOutcomes`；每条只有主题、玩家选择标签和完整结果场景。两条结果与当前决策场景一同做结构、引用、听众权限和语义审阅，审批后由服务端绑定真实 ending ID，选择前不会发布或写入 History。实际规则结局按 ending ID 消费唯一结果，发布副本的 `turn` 使用实际 Action 提交回合，与 History 和场景事件一致；已审批结果保留生成回合、ID 和原文。缺失、重复或错绑时零写入；显式 offline fixture 可继续使用旧终幕内容。

- 生产 provider 的决策边界包括 `initialization`、`narrative_choice`、`npc_free_text`，以及服务端规则证明的 `investigation_result`、`changed_revisit`。开局由 opening source 直接编译为 ready；正式选择和焦点 NPC 自定义输入进入 pending job；合法调查结果或有可见规则变化的已访问地点回访在没有可消费 bundle 时进入同一 pending job。
- 初始化由唯一的 `buildOpeningNarrativePrompt` 传入完整 `GameSetup`、叙事风格策略和最多三条近期 novelty 摘要；玩家设定优先于 novelty。开局 source 与后续叙事共用生产 `RpgAiClient`、transport 策略和 application 审批；结构预检通过后调用统一候选语义审阅。作者与审阅器共享开局字段语义、事实 key→正式 ID 映射及披露边界，事实目录中存有秘密不等于玩家已获知。递送 verificationFactKeys 可用公开交付约定与知情来源，无需身份谜题或核验状态；持物或受托不足以说明接应职责，保密权限不变。
- 初始化最多三次完整尝试；source、候选校验、场景审批和 novelty 拒绝都通过统一修复反馈传到下一次 opening context。调查方式须符合对象数组契约，陌生人关系仍要求 neutral 且无历史依据；格式或关系失败不靠补造字段放行。
- `NarrativeBundleSource.generate` 一次返回原子提案：可选 `worldDelta`、`currentScene`、`continuationScenes` 和 `terminal`。生产续接图唯一存放在 `storyState.narrative.narrativeBundle`。
- 递送作者/审阅共享绑定、owner、成功事件、完成标志与公开依据。起幕取物、中幕路线、终幕交付；newItem/newEnemy 可 null。终幕持物投影 move → give_item 匹配审批图，交付后开放对话。
- 决策作者使用 `{worldDelta, consequenceBindings?, sceneDrafts:[{slotKey,scene}], interactionProposals?, graph?}`；`projectNarrativeDraft` 为 prompt 和 `compileNarrativeDraft` 提供同一槽投影，程序按明确 key 组装上述内部提案。普通决策、下一幕抵达和退出终局都由当前正式状态决定步骤与终点；可用归还图须显式选择 `graph=return_delivery`。缺失、重复、未知槽或选择数量错误带路径拒绝，不按数组位置猜归属，不补正文或改绑行动。作者省略 npcLine 的 emotion 时编译为 neutral，省略 answeredBeatIds、usedFactIds、usedEventIds 时编译为空数组；这表示未声明相应引用，不授予权限或免除强制节拍校验。显式值（含非法值）保留，正文与 npcId 不补造。旧 DTO 仅能通过显式 `allowLegacyDecisionDto` 历史 fixture 适配，生产不启用；合法 `@current.location` 可解析为当前地点 ID，不按名称猜测。编译后仍执行相同 parser 与审批。
- `generatePendingNarrativeBundle` 每个持久化 epoch 最多三个不可复用的候选版本。后续版本携带稳定解析、引用或审批拒绝原因；仍失败则保留同一 `jobId` 的 `provider_failed`，由显式 `{ "retry": true }` 手动重试。候选版本、候选 hash、lease 和 HTTP 预算均随 pending job 落盘，恢复 worker 先抢 10 分钟 lease；旧 worker 的完整 attempt predicate 不匹配时只能得到 stale。
- 正式手动 retry 在同一次零 revision CAS 中，先从已提交 Quest/Event 重新归约终幕 Thread、`endingAllowed` 与演化状态，再把原 failed job 提升到下一 epoch；不重执行玩家 Action，不改 World/Event ledger，也不直接授予结局。已有两条结局定义时，作者和 world-delta 审批共享的结构演化需求均为 none；终幕回应使用 `worldDelta=null` 的 choice-free ending handoff，规则立场随后由 read model 提供。
- 成功路径是审批生成包、提交场景事件、重建记忆，再调用 `repository.applyState`。世界增量、ready scene、choice registry、bundle 和记忆在同一次 scene CAS 中写回。
- B 先解析并校验 current_scene 的结构化披露与实际听众，再由 `ruleEngine.previewSceneDisclosure` 预览知识和 `reconcileStoryConsequences` 后果；编译槽、任务游标与审阅均使用该版本，最终同次追加事件并 CAS。幕末披露可要求同候选提供下一幕内容，缺少时按原有限候选循环修订，不能 ready 后推进状态。未来续接不进入本场预览，不执行新幕目标或自动选择终局。不得用事后首次绑定追溯完成旧交谈；固定记忆包不改写为候选已经发生，公共上下文不带私密 goal 正文。
- 已审批终局对的正式立场行动若在本次规则提交产生 `ending_reached`，直接原子保存结局与玩家历史，不再创建下一轮 NPC 生成任务；准备终局对仍需 AI，主动退出仍使用 `story_exit` 生成退出场景。
- bundle step 必须由服务端 descriptor 投影；stepKey 唯一、无环、最多 12 步。非终点没有 choices，`next_decision` 终点恰好两个选项，`ending` 终点没有 choices 且没有 continuation scenes。
- 决策 prompt 为每个已有 `candidateId` 同时投影服务端 Action；对话候选包含目标 NPC、dialogueAct 和结构化 topic。新增互动须提交封闭的 `interactionProposals` 并经预览审批，才能绑定相应候选；不能按选项数组位置把一个 label 改绑到另一种 Action，也不能根据裸 candidateId 猜测行动语义或改写 registry。
- 主动调查方法由规则在作者上下文与地点 read model 中共同投影；作者只能引用当前地点已批准的 fact/approach Action，不能自行发明方法、提前披露事实正文或把 `evidenceQuality`/`tensionDelta` 当作玩家可见信息。地点方法与正文 fixed choice 若同时出现，均由同一 Action 准入和 opaque token 铸造，未选择的方法不产生发现或目标后果。
- NPC 的 `offer_condition` 带有已授权互动提案时，作者须在终点提供对应 `interaction:proposalKey` 的真实行动选择，并保留原条款；不得把答应条件写成普通交谈。应用层按候选引用携带原提案并拒绝冲突修改，语义审阅核对台词与行动及条件先后；提案获准不等于条件已经成立。
- 所有决策共用必选的生效时点上下文：`currentScene` 与 `worldDelta.beatSummary` 绑定当前已提交 Action 和玩家地点，摘要只概括当前行动及回应。换幕编号与新实体/任务的创建不代表玩家已抵达、会面或完成任务。续接槽按正式 trigger 投影 `resolution`，正文展示于触发成功之后：move 已抵达、take_item 已归玩家、give_item 已交付、战斗开始与胜利分别承接对应结果。作者、修订与 reviewer 共用这一范围；生成时旧背包/地点快照只是续接起点，未来槽的结果也不能倒灌进当前摘要。条件结局按对应立场行动生效。
- 条件终局槽的标签、正文与 worldDelta.endingPair 共用 endingResolutions：support/challenge 经真实 resolveTurn 预览，投影 Action、玩家与已见/同场 active NPC 的前后地点、规则事件、物品变化及新发现事实 ID。未见异地 NPC、秘密正文与伪造事件 ID 不进入预览。未变的位置不能写成异地到场；待执行前提不能由其他人代办或靠结果正文兑现。同场无关键状态效果的表现仍可创作。新结局对尚未具象化时 resolvedEndingId=null；实际 endingId 决定发布，不能由主题反推玩家已执行的立场，两结果不同时发生。结局依据 ending:trust|doubt 必须匹配候选对应主题的实际数组项；错绑为 uncertain。worldDelta.beatSummary 与 currentScene 属于选择前回应，只能使用已提交依据，不能提前引用条件终局结果。
- 生产移动、探索、取物、给予、战斗开始与胜利交接必须消费匹配的 bundle 步骤；缺失或失效零写入。调查结果和变化回访只有 `ResultBoundaryProof` 证明规则事件、真实地点历史和可见变化后才可沿同一 A/B 链生成；普通移动、首次到访、UI 导航、场景展示和未知秘密都不能触发。新 proof、规则事件、玩家 History 与 pending job 在同一次 CAS 写入，B 失败保留 A 的后果。活跃战斗、战败恢复和终幕立场由规则直接处理，不增加 provider 调用。`PreparedContinuationState` 及其消费函数只供显式离线 fixture；不能据此描述生产续接。
- `mode="ai"` 只投影已审批的 `generated` 场景。缺少正式 NPC focus 台词时投影单一权威 `ask`；失败仍进入同 job 的 failed 状态，不合成 deterministic/default 文案。
- 内容审批同时检查强制节拍、当前地点和焦点 NPC、`objectiveLink`、下一步抵达 NPC、实体引用、题材限制和 NPC speech authority。审批失败不部分写入。
- 决策上下文以 `consumer=author|reviewer` 共用事实、权限、行动及演化依据；作者获得 sceneDrafts 传输契约，审阅器获得实际编译后 NarrativeBundleProposal 契约（含服务端附加的 npcOutwardProposals）。作者修复指令和抵达输出骨架不进入审阅上下文，candidateHash 仍绑定原内部候选；审阅不改写候选、不按作者传输字段误判内部表示。
- 世界增量 schema 按当前结构演化需求提供；无演化的普通对话只允许 `worldDelta=null`，不要求 beatSummary，其结构修复提示也必须要求 null，不能反向要求补摘要。时序块仅在有演化时将摘要列为当前事实字段。
- 审阅缺陷路径相对内部候选；允许明确请求外壳的单层 `proposal.` 或 `$.proposal.` 前缀，校验实际字段后保存候选相对路径。未知字段、错误数组索引、重复包装仍拒绝，不过滤缺陷或转为通过。
- 生产语义审阅的 `ruleBasis` 由服务端投影当前输入、真实 Action 与候选绑定、续接 step、正式物品及事实/权限。阻断缺陷必须带可存在性校验的候选 `path` 和 `evidence={basisKey,impact,detail}`；依据必须存在、影响种类须属于该依据，detail 说明具体规则后果。物品状态影响只能引用具体正式物品或绑定该物品的 take/give 步骤，普通无效果服饰、环境或风格写入 `qualityObservations`，不改变规则 verdict。无依据、空缺陷或混入非法缺陷的 revise 整体成为显式 uncertain，不过滤后冒充 pass。服务端校验依据与路径，不以此替代模型对语义冲突的判断。
- `story:consequences` 是作者与 reviewer 共用的 rule basis，只包含当前 job 已提交 Event、活跃 Thread 和可用互动 ID；goal description、reason、证据质量及隐藏条件仍由规则/私有 deliberation 保持隔离。
- decision 的 pass 必须完整返回 executionChecks 与 progressChecks，按路径、引文、槽依据核查位置、参与者、流转和已完成前提。结构无效的 pass 允许一次同候选响应修复，沿用请求预算与取消控制，计入每 job 的 24 次 HTTP；不重写作者候选。二次仍无效为 uncertain；有效规则缺陷立即交回作者修订，不向审阅器重复求通过。无效 revise、网络失败不走该修复。结构正确不证明语义完整，仍需实跑。
- 作者与审阅共用 narrativeProgressContract：首场说明谁受影响、委托人为何在意与完成/耽搁的后果；中幕主张给出自身利害、依据或能力边界，让玩家比较回应的理由与代价；终幕交代本次后果及未解决问题。同幕回应不强制新剧情，泛泛传言、重复引路/核验不算推进，选项不能承诺 Action 无法兑现的效果。推进不扩大权限，违反有依据的因果要求走 BROKEN_CAUSALITY。
- 事实引用许可与披露正文分别投影：获准 NPC 互动提案里的事实 ID 存在且可用于对应提案，不要求出现在公开正文目录；该许可不授权当前台词说出秘密，也不代表行动已执行。秘密正文继续按 speaker authority 裁剪。
- 动态 `newNpc` 可用 `existingFactIds` 显式声明当前上下文中具有公开初始化来源的既有事实，省略即为空；作者获得相同资格列表和准确 schema。预检物化后，审阅依据按每个候选场景的实际说话人和受众投影，不把当前 focus NPC 权限复用于续接 NPC；同场先前合法披露仍按实际听众顺序生效。
- 每个 opening/decision 候选由服务端计算 `candidateVersion` 与 `candidateHash`，最多初稿加两次修订；结构/规则预检通过后取得一次有效语义审阅结论，无效 pass 的有界响应修复见上。审阅不能修改候选、规则或知识；正文、受众、NPC outward 或 proposal 变化都会使旧 pass 失效。

## 关键流程

```
玩家正式选择 / NPC 自定义输入
  → PendingNarrativeJob
  → claim lease + prepare/recover fixed observer memory
  → focused NPC judgement + authorized outward projection
  → compileDecisionNarrativeContext
  → NarrativeBundleSource
  → approveNarrativeBundle
  → commit events + rebuild memory + one CAS
  → ready scene + opaque choices + narrativeBundle
```

作者与审阅器接收公开规则依据、获准 NPC 对外判断及固定 player 记忆包，包括未覆盖原文、来源概览与召回旧话；选择标签不能冒充口述。完整存档、未投影 ledger、其他 NPC 私密历史、秘密正文和隐藏 registry 不进入作者上下文。权限与来源契约见 [记忆系统](./剧情连续性与结构化记忆.md)；`narrativeContext` 审计只存 block 元数据与预算。

首次固定选择由 `selectedDialogue` 保留 act/topic/label，并从公开 fact 或初始化 thread 找回因果依据，加入一次“开局背景与本次回应”必选块；后续走记忆召回。发送前统一检查完整 messages，包含系统指令、修订稿及 reviewer 候选；超限显式失败，不截断必需原文。默认值与估算口径见 [AI 环境](./AI环境.md)。

需要条件披露、承诺或具体互动判断时，`prepareNpcNarrativeContext` 只为同场焦点 NPC 编译私密输入，判断后经 outward 授权，作者/审阅仅接收获准投影。开局与普通问候不增加角色调用。判断沿用当前候选版本、取消信号和 HTTP 额度，不提前写入知识或互动效果。成功 outward 可在同 worker、同规则快照的候选修订中复用；请求控制仍取当前值，失败不缓存，outward 不跨 job 或进程恢复复用。

每个 job/epoch 最多三版候选，作者/NPC/审阅合计 24 次 HTTP，摘要另有跨 observer 共用的 8 次 HTTP、2 次批更新；均计入验收总预算并在请求前持久预留，崩溃不退回。每请求最多两次传输，空响应不重发。`ai_call.attempt` 是传输序号，`context.retry.attempt` 是对应重试机制内序号。

记忆在租约内、首候选前准备并固定，修订与进程恢复复用同一 job/epoch 包。缺包或来源变化显式失败；每次预留/冻结核对当前时间和同库真实租约，外部仓储不能绕过。摘要额度耗尽可保留旧概览与完整未覆盖原文；租约失效或仓储不可用则取消准备。固定包与摘要细节见 [记忆系统](./剧情连续性与结构化记忆.md)。

## 统一重试反馈

`src/game/application/aiGenerationRetry.ts` 是 RPG 生成层的公共反馈契约，覆盖 opening、intent、scene、world 和 narrative bundle。各 source 使用 `createAiSourceFailure` 构造失败；bundle、scene、world 端口直接复用 `AiSourceFailure`，intent 结果与旧开局异常端口只作既有边界格式转换。业务校验只提供稳定 `repairReason`、`repairDetail`，审批使用统一 `rejectionCode`。`repairFromSourceFailure` 负责缺失原因的统一分类：调用失败为 `provider_failure`，结构失败为 `invalid_schema`，不能把网络失败或空响应冒充 `invalid_json`。

内容修复使用 `AiContentRepair`（attempt、reason、可选 rejectionCode/detail）；prompt 由 `renderAiRepairFeedback` 渲染公共反馈段，业务可以追加针对性说明。同一运行中的下一版同时接收上一完整候选及累计缺陷，二者仅是待修订材料，不进入实际 History，也不能改写已提交的玩家行动与状态。反馈留在上下文必选块中；`aiRepairAuditContext` 统一投影审计原因和来源，自动修复序号逐次递增。各用例仍负责各自的次数上限及哪些业务拒绝允许修复。

决策作者的 JSON 已成为对象、但在严格结构解析或编译中失败时，同一 job/epoch 的下一版还接收该次作者原始 draft 和结构诊断；未知 `worldDelta` 顶层字段会给出精确路径。原稿只用于修订输入，未经编译、审批或授权；其中合法的 `existingFactIds` 等显式字段逐字保留，但服务端不替下一版自动回填。raw draft 与已编译候选修订材料互斥，provider/transport 异常、source 抛错、未知 source kind 或缺少原稿时立即清除；不进入普通诊断日志、审计 metadata、存档、失败 reason 或跨 job 缓存，AI 文本审计仍按既有契约保存实际请求 messages。下一版仍须完整通过同一严格 parser、规则审批和语义审阅。

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
