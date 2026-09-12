# 运行时 AI 导演与场景表演

## 职责

运行时 AI 只提出结构化叙事包。应用层编排上下文、提案审批和持久化；玩法层裁决状态变化，领域 helper 提交事件并重建记忆。AI 不直接写存档，也不决定行动合法性、关系数值、知识、战斗或结局立场。

相关边界见 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)、[NPC人格知识与关系图](./NPC人格知识与关系图.md) 和 [世界动态具象化](./世界动态具象化.md)。

## 当前契约

生产叙事走**分阶段链路**（planning → narration/character/choices 表达单元）。

- 生产 provider 的叙事触发只有 `initialization`（开局）和 `narrative_choice`（正式选择）两类；`npc_free_text` 仍走既有焦点 NPC 输入路径。两者共用同一套四阶段 source。
- 生产装配点是 `createStageSource`（`src/game/application/server/ai/sourceFactory.ts`）。旧完整包源 `liveNarrativeBundleSource.ts` **已无任何生产调用**，仅保留给显式离线 fixture；不得把它描述为生产路径。
- 一次逻辑任务（job）分为四类生成职责，并非固定四次 API 调用：`planning` 在一次调用中决定事件、世界变化和 narration/character/choices 的完整初稿；三类表达单元沿 DAG 依赖只润色各自初稿。结构和权限批准后，整包经 `dialogue_consistency_review` 检查初稿保真与授权事实。规划素材（尤其 `opening.prologue`）不是最终展示文本，必须经旁白单元覆盖后才发布。
- 骨架先经 `approvePlanningContext` 预览世界增量、核对服务端场景图，再经 `approvePlan` 与 `approvePlanDecision` 检查图结构和候选语义；表达逐单元经过 `approveUnit` 与 `collectDisclosures`，发布时再次通过同一 `approvePlanningContext` 预览并重放审批，不能退回增量前世界审批终幕。任一步失败不部分写入。
- 当前规则要求的必选节拍（除可选 atmosphere）须按原 beatId/kind 各分配给唯一的 current 旁白单元；当前旁白不得增加服务端未要求的节拍（额外氛围只用固定键 atmosphere）。NPC 可另行回答，但不能替代旁白覆盖，也不能用未来场景提前代偿。分配不符以 `plan_mandatory_beat_mismatch` 在表达请求前退回规划，反馈携带所需节拍与场景契约；不复制 NPC 正文、不扩大知识权限。只有初次未批准提案可结构修复；完整初稿规划已接受后不因表达失败重新规划。旧无初稿缓存失效时保留已用请求和尝试次数。
- 普通对话候选允许 `target/deferredLocation=null`，只绑定已批准的 `dialogueAct/topic`，两个候选不能是同一语义。不为选项创建地点或改写任务；不同走向不等于不同地点。实际选择及当回合已提交结果进入下一次规划。新普通选项保存实际 label 与 dialogueAct/topic；规划器在同一次规划内写出 NPC 回答和后续两个回应初稿，见 [NPC 对话](NPC对话驱动叙事场景触发.md)。
- 当前场景不能被未来场景替代。已有存档中的非空路线目标继续按旧规则审批、持久化和消费，返程仍遵守在场性；这只是兼容能力，不是每个新决策的必需结构。
- 下一幕需要世界增量时，首次规划不把增量前的临时终点当作下一幕图；规则预览增量后核对 steps/terminal。场景契约 `sceneContract` 明确当前回应 NPC、各场景是否允许 choices、下一决策的 stepKey/NPC/候选 ID；有已批准图的重试以该图替换原待生成图，完整反馈放在提示末尾，在尚未接受完整规划时沿用该图修复结构，不静默搬移选项或更换 NPC。`graphStatus=approved` 仅表示图已编译，不表示整包已获批；所有审批仍执行，仍失败则显式重试。终幕提案 `decision=null`，规则从已具象化结局对派生 trust/support、doubt/challenge，choices 表达只写立场对白，装配为 `endingLabels`，不放进普通 choices。
- `sceneSnapshot` 仅沿当前节点的唯一祖先路径预览触发结果。`approvePlanningContext` 核对提案后附加规则 `ruleSceneGraph`；快照按各步 `absorbedObjectiveIndexes` 预览规则会自动确认的连续事实目标，限对应地点，城镇容器移动不等于进入建筑。它不来自模型声明，不授予无关事实或 NPC 私密知识，也不写入真实 ledger。获批上游实际披露与受众范围仍单独决定条件认知。
- 新生产片段保存 premises：消费时复核地点、在场说话人、带账本序号下界的跨场景观察回执，以及可选 `discoveredFactIds` 中的预期规则发现是否已在实际行动后成立；缺失事实时拒绝片段、零写入。旧包缺省该数组不增加隐式前提，同名旧观察回执不能复用。观察兑现还复核来源当前知识、披露权限和 certainty。
- job 协调器每 10 秒为 30 秒租约续租，续租与 save/publish 共用串行队列；续租失败取消在途请求，最终停止 timer 并释放 fence。规划审批失败有界重试，基础请求预算按获批表达单元数量派生。
- 单元调度用 `readyUnits`：只选依赖已全部通过且自身未完成的单元；每 job 最多 2 个在途 provider 请求。
- `planning` 固定逻辑 key；表达单元的存储 key 由服务端按 point/stage/speaker/ordinal 铸造，模型重命名无效。
- `beat_authority_conflict` 表示规划任务要求了该视角不可知/不可披露的事实或证据，不等于应给角色补知识。没有条件观察的计划在表达调用前预检；有观察依赖时等待实际获批上游，再按真实投影检查。反馈定位单元、视角、不可用引用和允许的事实 ID。规划接受前可沿原预算修复；接受后显式失败，不绕过权限、伪造回执或重做世界。
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
  → 适用对白：dialogue_consistency_review 通过才允许整包发布
  → 整包发布：commit events + rebuild memory + one CAS
  → ready scene + opaque choices
```

Prompt 只接收编译后的公开事实、当前位置、焦点 NPC 的有限结构化交互、强制节拍、实体索引、持有状态、上一场景和有界 memory cards。不向表达 prompt 传完整 `GameRecord`、event ledger、其他 NPC 历史、secret fact 正文、玩家长期原文或隐藏 registry。全局 planning prompt 接收预算、公开与私密分区、已选 branch、当前 job 的 `selectedDialogue` 与 `domainEventIds` 对应的已提交结果，以及开局 situation/history/novelty；表达 prompt 只接收 `SafeContext`。统一规划器还接收同一焦点 NPC 上一轮实际展示的旁白、对白及两个选项，并只读查询该游戏、该 NPC、当前 revision 之前最多六个已发布 decision 任务，投影当时的 NPC 回答、候选和实际选择的结构化任务。历史总量最多 12,000 字符，按整项取舍，不含 token、旧玩家自由输入或其他 NPC 历史；仅在本次执行使用，不另建持久化记忆。历史表达只用于承接，不能作为补造事实的依据。审计中的 `narrativeContext` 只是 block 元数据与预算，不是 prompt 正文副本。

各 stage 使用独立 messages，不共享会话。跨场景依赖仅表示执行顺序，旧场景的对白原文不进入下一场景表达；跨场景认知仍由事实和观察回执投影。选项前文标记旁白/说话人，只保留本场旁白与当前对话对象；NPC 不接收玩家候选，也不继承其他 NPC 的私聊。本场公开定位由步骤快照投影地点 ID/名称、玩家名称与本场参与说话人名称，不携带地点背景或 NPC 隐藏动机。当前任务的实际选择 label（自由输入则为本次 utterance）作为待回应话语绑定到 current 旁白、选项和当前焦点 NPC；不转发给未来场景或其他 NPC。话语单独标记为非指令、非已核实事实，不扩大事实引用权限。

各 stage 的展示职责保持分离。规划一次写出互补的完整初稿：旁白交代可观察变化，NPC 回答并表达态度，choices 给出两个玩家第一人称回应。同一事实在双方重复须有明确作用，理解背景不自动成为正文。无新状态时旁白只做极短衔接。`unit.draft` 带完整 parts/labels 和引用；旁白/NPC 润色只返回同序同数量的 texts，选项只返回同序 candidateId/label。程序保留事实、证据、节拍、说话人、情绪和动作，不重新分段或从事实表补内容。

实际上一轮对白先按焦点 npcId 对齐，再投影到当前场景；未来场景和其他 NPC 不继承。`previousReply` 仅在其事实引用全部属于该视角允许范围时保留，避免混淆上一句属于谁。这些历史文字不是新知识来源。`SafeContext.stylePolicy` 由已存 setup 的受控人格标签、concise/novel/cinematic 与 normal/dark 构建，进入缓存摘要；玩家人格只进入玩家选项 prompt，旁白与 NPC 只接收相关叙述风格，只影响措辞，不扩大事实权限。主角人格只用于玩家刻画；NPC 使用公开身份及受控 delivery，无公开锚点时不据职业猜测经历、能力、隐藏目标或承诺。各类表达角色的内容边界仍优先于风格。

旁白每个 `part` 最多引用一个节拍，无节拍的氛围段使用空数组；全部段落必须覆盖必选节拍，事实和证据保持逐段归属。当前决策旁白的 `narrationLayout` 要求同一节拍连续，独立氛围只允许在最后一个当前旁白单元末尾。开局与未来场景不套用当前回合布局。初稿先按独立 SafeContext 通过 `approveUnit`；归属观察（含同序隐式 witness/self-speech）的事实引用与 certainty 在等待上游之前机械检查，缺项或升级均退回尚未接受的规划，不能靠后续纯文本润色补元数据。requiredObservationKeys 表示本单元的呈现/披露责任，不是前文输入依赖；不依赖实际观察的非法引用、节拍、动作或布局在规划接受前拒绝。依赖披露的初稿等实际上游获批后再投影，不伪造观察回执。获批规划后的权限或润色失败保留规划、请求及尝试次数，不重做世界。

新 live 规划以每个 `unit.draft` 为唯一正文来源，不生成 task、brief、inquiries、answers 或 taskFactIds。普通候选的 `publicIntent` 仅包含 facts/evidence/beatIds；机械适配器从唯一匹配的初稿 label 派生内部 text，从段落引用派生 taskFactIds，再交给原有领域解析器。图、必选节拍、观察和动作仍独立声明与批准，不能从初稿反推授权。开局必须显式声明 player.knownFactKeys。开局 response 的 fact topic 与 thread 的 questionFactKey 可取 NPC 公开已知或玩家显式已知的现有事实，并排除 NPC 私密事实；这是选题资格，NPC 知识和熟人关系依据仍只取 NPC 自身已知，玩家选项需通过实际披露后的独立权限。旧字段只用于历史解析；未完成的旧无初稿缓存撤销规划与依赖表达，沿原请求和尝试预算重新规划，不把旧 brief 转成初稿。已发布旧数据保持可读。

安全编译先隐藏原始初稿，按角色、时点和真实知识/披露状态构建 SafeContext，再用 `approveUnit` 核验初稿引用。只有成功后才附上该单元的初稿。初稿不授予额外知识，候选的 publicIntent 引用也须通过独立玩家权限。润色输出仍经过原有引用、行动、节拍与披露门禁；引用合法不证明任意自然语言安全，最终复核还检查无权主张，即使该主张来自初稿且被忠实照抄。

前文先按该视角完整权限投影，再将本轮事实收窄到初稿、必选节拍与本单元观察的引用。含不可见事实的一次表达整体不传，不留下失去指代的尾句；跨场景、跨 NPC 与私聊隔离保持。普通选项事实范围收窄到其获批引用；终幕无候选事实声明，保留该时点玩家已知事实供初稿核对，不从正文反推引用。公开对话身份包含听者职业；动作只投影同 step 且不晚于本单元的获批动作。

同一步骤同一 NPC 只规划一个完整回应单元，初稿自然包含全部回答、未知说明及转话题内容，可分段；一次 character 调用润色所有段落。同 NPC 拆分单元以 `plan_character_response_split` 在接受前退回规划，编译器不合并或改写文本。

节拍证据通常只允许本视角知识条目的实际来源。唯一规则结果例外是 current 旁白的强制 `quest_progress/quest_advanced`：服务端确认事件已提交、属于当前 job 且对应本次完成目标后，允许引用该 `quest_completed` 证明任务完成；它不授予事实知识，不适用于 NPC 或未来旁白。拒绝反馈逐节拍列出非法与允许的事件 ID，无需要时可用空证据。合法 ID 不证明任意原文安全，仍需检查真实文本是否编造或隐含泄漏。

每个逻辑 job 的 provider 请求数受预算约束（`jobBudget` 固定决策表）；planning 与每个表达单元各最多 4 次生成尝试（含首次，planning 的结构修复也计入其中）。每次 transport retry 由 `RpgAiClient` 执行；顶层 `ai_call.attempt` 是 transport 序号，`context.retry.attempt` 是重试机制内序号，两者不能混用。空响应不重复发送同一请求。

## 统一重试反馈

选项的 `SafeContext.dialogue` 绑定玩家与批准的对话对象（包括终幕），不从前文猜身份。`approveUnit` 以 `unit_output_self_address` 拒绝明确自称呼语，保留自我介绍；不保证识别所有语言形式。

规划器读取玩家实际选中的 label 或本次自由输入，以及同一 NPC 的有界已展示历史；不读取旧 selectedDialogue.task 或把历史抽象维度翻译成新问题。新路径不按维度强制补问、检查答案覆盖或裁决历史合同，仅保留实际已选 label 的精确重复检查。

三个表达角色共用 `polishPrompt` 和严格的 `applyPolish` 适配器。只允许改变句式、口吻与停顿，保留问题、回答、未知/拒答范围、条件、角色与事实确定程度；不新增见闻、设备、原因、经历或承诺。原文已经合适时允许不改。

初始化 requestId 的摘要只绑定用户配置与替换目标，不绑定服务端随机 gameId、seed 或 generationId；同请求复用首次 envelope。pending/failed 初始化槽不能由新请求覆盖，需先显式取消；发布事务再次验证槽归属。查询 pending 任务通过现有 coordinator 恢复调度，不刷新预算；客户端不将无本次请求标记的历史 published 任务视为本次开局完成。

每个执行作用域使用唯一租约 owner，竞争或失租不得把其他 worker 的任务写成 provider_failed。生成作用域按 job 绝对截止时间取消，响应后与发布前复核；runJob 给 planning 的外层窗口最多 240 秒，并在每次调用前取该窗口与 job 剩余时间的较小值。`RpgAiClient` 再按实际角色策略截断单次 transport：planning 开启 thinking 为 240 秒，关闭 thinking 为 90 秒；transport 重试共用同一调用的剩余 timeout，不重新获得完整时长。90 秒超时只表示本地等待边界到期，不足以判断 provider、网络或排队中的远端原因。截止失败保留为显式重试状态。

新增知识传播的 NPC 对白使用独立审核角色，契约见 [Spec 的角色审批](../superpowers/specs/2026-09-09-staged-narrative-generation-design.md#6-角色表现与认知隔离)。审核只读本次授权事实和实际对白；拒绝、不可判定或服务失败不批准下游认知。服务端保存绑定输出的摘要凭据，恢复时缺失/不匹配会撤销该单元及传递依赖，发布时再验；每次审核先持久扣除额外请求额度。四类生成职责不变。

整包保真审核独立于披露审核，覆盖每个旁白、NPC 输出与每个候选。请求只含 `items`：服务端 ID、stage、原 draft 文本、实际 text、授权 facts，以及有界场景/说话人/实际已选原句。可选 authority 只补充安全投影的说话人公开职业、带身份的听者职业、初稿选中的获批表演动作，以及当前旁白已核实的 quest_completed 目标完成；事件须同时绑定当前 job、currentBeatEvidence 与服务端目标转移，不把模型节拍 instruction 当作证据，不转发完整账本或私密人格。模型只返回 `{verdict,failedIds}`；pass/uncertain 的 ID 数组必须为空，reject 必须含已知且不重复的失败 ID。没有问题维度、违规分类、scope 或规划检查地址。输入最多 24,000 Unicode 码点，超限失败而非截断。

新执行链不调用规划语义预审，不生成 planningDialogueReviews 或 planningSemanticRepair。初次未批准提案仍可按既有上限做结构修复；接受完整规划后，任何润色、保真或权限失败都不能重做 opening、NPC、场景图或 worldDelta。历史审核结构仅保留存储读取兼容，不能作为当前发布凭据。

每周期整包复核共用一个 attempts 计数，最多两次请求：第一次协议错误可用第二次纠正协议；或第一次合法 reject 撤销失败单元和传递依赖，保留有效上游，局部重新润色后用第二次复核。两者共享额度，不能先纠正再获得额外内容复核。第二次仍失败即显式失败。协议反馈仅在协议错误后发送；内容复核不冒充格式错误。provider 失败、uncertain 和中断均不触发规划重做。

基础 source 请求数为 `1 + plan.units.length + 1次最终整包复核`；单旁白、单 NPC 和一处决策的无重试路径为 5 次，披露审核另计。每 job 在基础额度外最多 12 次额外 source 请求，规划与表达单元每周期各最多 4 次生成尝试。复核请求每次最多 30 秒、transport 内部最多 1 次；所有 source 请求在发送前持久扣费。审核同样受 lease/fence、取消信号和 job 截止时间约束。

整包复核凭据在发送前持久保存尝试计数和运行状态。同周期重启、输入摘要变化或缓存失效不重置已用请求及复核次数；仅显式手动重试进入新周期。通过凭据绑定版本、cycle、输入摘要、完整初稿、批准投影及每个最终存储单元的 key/inputDigest/value；即使正文相同，引用、分段或元数据变化也不能复用。恢复与 SQLite 发布事务均重新验证，缺失、过期或不匹配时拒绝发布且无部分写入。

在线审核只能降低初稿偏离与未授权主张风险，不保证任意自然语言绝对安全或忠实；串台、隐含补造与风格仍需要保留真实样本的人工验收。

`DIALOGUE_REVIEW_POLICY_REVISION` 独立于存储 schema 版本，审核规则/prompt 变更必须更新该政策版本并纳入凭据摘要；旧 job 保持可读，但旧政策 pass 不可复用为新政策结论，同周期重审保留已用请求和审核次数。同序的隐式 speech/witness 观察与显式 requiredObservationKeys 共用 `observationsForUnit` 归属投影，进入表达前再次验证事实属于该 SafeContext 可见范围；不靠添加隐藏事实补齐观察。表达 prompt、certainty 审批及最终披露据此使用同一上限。

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
