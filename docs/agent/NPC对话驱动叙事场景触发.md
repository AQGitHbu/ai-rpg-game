# NPC 对话驱动叙事场景触发

## 系统定位

NPC 对话是持续推进故事的主要入口。每个 ready 的焦点 NPC 场景必须给玩家两个语义不同的固定对白选择和一个自定义输入；两种输入共享一条 application/API/CAS 链，不能有“闲聊不记回合”或独立 dialogue use case 旁路。

## 玩家可见规则

- 普通 ready 场景只有一个焦点 NPC；其面板显示恰好两个固定选择和一个自定义输入。对话会话完成且权威目标已推进时，收尾 scene 由同一次生成返回旧 NPC 的最后一句台词和恰好一个 handoff 选择；该收尾选择不是第二个分支，也不是“知道了”。
- 两个固定选择必须是当前 NPC 台词的直接回应；每次选择只消耗一轮，不代表对话立即结束。默认对话会话至少连续两轮，第一轮后保留同一 NPC 与话题，第二轮收束后才允许 `talk_to_npc` 目标完成。
- 任务面板中的 `talk_to_npc` 完成标记与两轮会话状态一致；NPC 的世界事实 `met` 只能表示已经接触过，不能提前把未完成的对白会话显示为完成。
- 运行时目标判定必须同时匹配 `dialogueSession.npcId` 与当前 `talk_to_npc.npcId`，并要求该会话 `completed=true`；权威 `ask` 入口只初始化该 NPC 的零轮未完成会话，随后两次正式回应才完成目标。旧 NPC 的已完成会话、或新 NPC 本回合刚写入的 `met=true`，都不能跳过新 NPC 的正式回应。完整会话完成时规则层写入 `npc_dialogue_completed`；切换到后续 NPC 后只以该结构化历史事件识别前一段已完成对话，不再从 `met` 推断。
- 普通小镇建筑只负责进入建筑场景，不提交回合；若当前 discover_fact 的下一目标是该建筑 NPC，入口例外消费服务端下发的规则型 `arrivalChoiceToken`，不调用 provider。地点行动栏中的明确 talk 行动只打开当前读模型。行动栏与 `talkChoice` 只为当前权威 talk 目标铸造。若新 talk 目标尚无 ready focus dialogue scene，读模型不展示 NPC 台词、固定回应或自由输入，只投影一个服务端铸造的权威 `ask` 作为 `startChoice`；点击 NPC 即提交该入口并请求 provider scene。已有 ready 焦点对话必须展示两个固定选择和一个自定义输入；点击非目标 NPC 资料卡仍只查看其零回合闲聊，observe 场景中的 NPC 旁白不构成焦点对话。
- 固定选择由服务器批准并以 opaque `choiceToken` 下发；客户端只显示 label/hint，不知道 Action 或 `actionKey`。
- 自定义输入必须绑定当前焦点 NPC。每次提交生成新的浏览器 UUID，即使连续对同一 NPC 输入也分别计为独立回合；即便原文包含地点或物品动作词，在该对话上下文中也必须作为对焦点 NPC 的 utterance 解析，不能切换为移动、取物或探索 Action。
- 玩家输入表达意图，不声明事实。服务端意图解析器只能转换成当前受支持 Action；越权声明不能直接改变任务、知识、关系、物品、战斗或结局。
- 每个成功输入都会推进 `turnNumber`、更新结构化 NPC 记忆/关系，并产生一个白名单内的 `PendingNarrativeJob`；服务端在规则写入成功后立即后台排队下一幕，不等待玩家再次点击或客户端 ensure 才开始生成。
- 生产 provider 触发只允许开局 `opening` 与焦点 NPC 的正式 `npc_fixed_choice` / `npc_free_text` 分支。一次正式 NPC proposal 通过审批时，同时写入当前 scene 与到下一处正式 NPC 决策前的 `PreparedContinuationState`；移动、调查、物品、战斗边界和回退导航不得再调用 provider。
- 当一次对话完成当前幕并具象化出下一任务时，新场景是任务交接场景：旧焦点 NPC 必须在本次生成的 `npcLine` 中说完承接新目标的最后一句；下一步由服务端批准的 prepared continuation 或地图 travel 入口承接，不再把 handoff 做成可重复提交的 action。收尾 scene 不生成“知道了”或泛化的“继续调查” choice；新出现的 NPC 不会被界面自动打开。
- 交接离开当前建筑/地点时，旧焦点对话框由本地 acknowledgement 关闭；该动作没有 choiceToken、不创建 action、不改变 revision/turn/location，也不显示等待 NPC 状态。玩家回到地图/小镇进入新目标后，才由新 NPC 提供正式对白，避免旧 NPC 的双选项伪装成新主线。
- 交接/非目标 NPC 点击后是零回合闲聊弹窗（由同一次 live scene API 的 `npcDialogues` 同步生成 + “知道了”关闭），不提交回合、不创建 pending、不推进剧情。每条新持久化 NPC 台词显式记录 `speechPurpose=focus|ambient`；`speechSource=generated` 只说明文本来源，不能证明它是正式任务回应。正式对话只能经当前权威 talk 目标入口开启；新目标即使已在旧场景中获得 generated ambient 台词，正式 scene ready 前对白页仍为空，只显示单一 `startChoice`。旧存档没有 purpose 时，仅与 `scene.npcLine.npcId` 相同的台词兼容推断为 focus，其余一律按 ambient 处理。
- 若权威当前目标已经切换为调查、移动、取物或战斗，上一轮 NPC 的回应仍可展示，但旧的 dialogue focus、自由输入和 support/challenge 选项必须降级/关闭；不能因为旧 token 仍能通过机械合法性检查，就把玩家留在上一轮对话里。只有当前目标仍是该 NPC 的交谈，或明确进入结局抉择时，才保留焦点对话。
- 若对话收束后权威当前目标切换为同一地点另一名 NPC 的 `talk_to_npc`，旧 NPC 的最后一句仍保留在原对话框中，并显示本地“与下一位 NPC 交谈”关闭入口；该入口不带 choiceToken、不提交回合。进入目标 NPC 所在建筑后，再打开其已准备好的正式双选项对话。
- 若对话收束后权威当前目标切换为地点、物品或调查，旧 NPC 的最后一句同样保留在原对话框中；地点目标由权威 `travelChoice` 承接，物品/调查目标由 prepared step 或规则场景承接，不把本地关闭动作伪装成新的 action。只有非焦点零回合闲聊仍使用“知道了”关闭。
- 新地点刚被编排出来时，场景事件可能仍是 travel/observe；当前主线目标锁定该地点的焦点 NPC 后，read model 只从权威目标铸造单一 opaque `ask` 入口，在该 NPC 的 ready scene 写回前不生成角色台词、support/challenge 回应或自定义对白，不能把交接提示误报成 NPC 已回应。若当前目标是已批准 continuation 的移动/调查/战斗节点，则先消费该节点，再在 post-commit revision 上铸造正式选择 token。
- 同一幕可以在 prepared continuation 中审批后续 NPC、证物和敌人，但只有当前 active step 对应的实体进入场景与 NPC 上下文。前置调查未完成时不展示远端 NPC；玩家抵达新地点后，NPC 首句必须承接已完成的调查事实与到达过程，不能默认双方已经交换过密信、腰牌或完整案情。调查方式和战斗结果等兄弟 step 共用消费组，消费一个分支会裁剪未选分支。
- 正式对白提交后保留原 NPC 对话模态；选中的固定回应或自定义回应的本地临时展示保留在当前模态中，并在其后显示等待 NPC 回应的内联 loading。等待态从提交前捕获的本页临时对话快照渲染，不能依赖 pending `GameSessionView` 继续提供 choices；因此固定选项、已选态、spinner 与给予道具选项在 pending 快照清空 choices 时仍可见。自定义输入只保留在当前页面临时状态，不写入对话记录。对话选项、输入、关闭和其它游戏入口全部锁定。ready 写回后清理临时快照，直接显示同一 NPC 的新台词和下一组选项，不增加继续按钮。场景生成 failed 时只弹出失败重试模态；行动尚未提交的 AI 失败重试原 interaction，规则已提交的场景失败复用同一 narrative job。若目标变化，HUD/任务面板显示权威下一步，旧焦点对白按交接规则关闭。
- 已生成但尚未消费的抵达对白与已审批 talk action 会写入 ready narrative 的 `dialogueResume`；玩家离开后再返回目标地点时，read model 按当前 revision 重铸 opaque token，恢复原 NPC 台词和选项。旧存档若只剩 rule-owned travel scene，则目标 NPC 点击直接补发一次权威 `ask` 回合生成正式对白，不展示空白气泡或伪造的默认 support/challenge 选项。
- 玩家原文不写入长期记忆、事件账本或日志；长期记录只保存规则归一化的 dialogue act、topic summary 和 fact IDs。
- `npcLine.text` 是直接展示给玩家的 NPC 第一人称台词正文，不得包含 NPC 名称、角色动作或“说道/答道”等叙述性前缀；点击 NPC 时 UI 已经单独展示名称。
- NPC 回应必须承接当前玩家话语或当前交谈情境；“我知道了”“好的”“嗯”等无对象确认句，以及“你想问哪一段 / 你还想了解什么”这类只把责任推回玩家的空泛追问，都不是合法的上下文回应，live source 会先带失败原因重试一次，仍不合格就返回 `AI_RESPONSE_INVALID`，场景进入 failed 并等待手动重试。
- pending 场景上下文必须携带上一句 NPC 原话、玩家上一轮固定选项/自定义回应、`dialogueAct` 与结构化 `topic`；这组历史用于生成本轮 NPC 回应和下一组选项。普通 ready 场景的 `candidateId/action` 仍由服务端锁定，live AI 只能从合法候选中选两个；收尾 handoff 场景只能选一个，并且必须是沿 `objectiveLink` 推进的具体玩家回应/动作。live prompt 不下发离线 fixture 的自然语言 label，只下发动作语义，避免模型照抄上一轮模板。
- talk 选项的“锚定”来自结构化剧情上下文，而不是扫描对白关键词：当前主线摘要、目标、NPC 可说事实卡、本轮 NPC 使用的 `usedFactIds`、上一轮 `dialogueAct/topic` 与当前 NPC 台词共同提供语义约束。NPC 台词只作为当前回合的叙事承接输入，不再被正则分类为“问路/消息/证物”等固定主题，也不得把原句或机械截取的句尾重新放进玩家选项。
- 玩家选项直接呈现主角要说的话或要做的动作：对白不添加“回应某人/追问某人”前缀；动作使用全角括号（例如“（拔出兵器，向黑衣人发起攻击）”）。动作必须绑定服务端合法 `Action`，攻击选项只在敌人已释放且当前位置合法时出现，提交后进入既有战斗规则，不能只生成一段没有规则效果的动作描写。
- “承接”不等于复读玩家原文。NPC 必须以角色自身的第一人称口吻给出回答、可核对的线索、保留或下一步；禁止以“你刚才问的……”加引号复述长句来充当回复。
- 焦点 NPC 的 ready 台词至少包含两句直接对白：第一句回应当前问题或线索，第二句继续补充、追问或给出下一步；审批器会拒绝焦点开场、正式回应或终局追问中的单句台词，内容修复仍失败时返回 `AI_RESPONSE_INVALID`，不改写为生产 deterministic 成功。
- 对话生成只使用 live source 的结构化上下文和服务端候选；显式 offline fixture 才按当前主线目标与结构化对话状态生成可重放台词。NPC 可说事实卡由 live performer 按 `usedFactIds` 约束使用，越权引用或审批拒绝均进入失败态。
- 真机 AI 验收只接受持久化 `narrative.currentScene.source = generated` 的回合；AI 失败必须暴露稳定 `failureKind`，点击“重试”后复用同一 job，不计为 deterministic 通关。

## 单一路径

```text
NpcDialogue（两个固定选择 + 一个自定义输入）
  → gameActionRequest（每次新 UUID）
  → POST /api/game/actions
  → requestParser（discriminated union + 字段白名单）
  → compositionRoot.performTurn
  → performTurn
  → GameRepository.applyState（一次规则 CAS）
  → PendingNarrativeJob
  → 后台生成协调器（gameId + jobId 去重）
```

请求合同：

```ts
type ActionRequest = {
  actionId: string;
  interaction:
    | { kind: "fixed_choice"; choiceToken: string }
    | { kind: "free_text"; text: string; targetNpcId: string };
  expectedRevision: number;
};
```

不存在独立 NPC dialogue route、独立对话 use case 或固定 `input_<npc>` action ID。

## 场景选择安全

- SceneSource 只提出 `ChoiceProposal`；审批器根据当前 NPC、当前 revision 和当前合法 Action 逐字段重建 `ApprovedChoice`。
- ready scene、choice registry 和候选事件池由一次 scene write-back CAS 持久化。
- 固定 token 只在其场景和 revision 有效；tampered、stale 或重复消费均零写入。
- 自定义输入也必须经过当前 NPC 在场、焦点匹配、文本长度和规则合法性检查。

## Prepared continuation 边界

- `PreparedContinuationState` 是服务端维护的有向无环图，不是客户端可读的队列。step 的 trigger、消费组、后继和 active membership 均由服务端审批；AI 只提供 scene seed 的文案、事件和合法 choice seed。
- 移动、调查、battle start/resolution 的规则结果、prepared scene 物化、choice token 铸造、continuation 消费和 revision 递增在同一次 repository CAS 中完成。active battle round、无 prepared step 的物品交换和回退导航直接使用 `source="rule"` 场景。
- 找不到当前 trigger 的 active step 返回 `NARRATIVE_CONTINUATION_MISSING`；图或权威事件不匹配返回 `NARRATIVE_CONTINUATION_INVALID`。两者都不调用 provider 且零状态写入。
- `GameSessionView.narrativeGeneration` 只投影 `idle`、`pending(jobKey)` 或 `failed(jobKey, failureKind)`；客户端对新 job 只发起一次 ensure，后续仅 GET 观测，failed 不因轮询自动恢复。

## 主要文件

- `src/components/AdventureGameShell.tsx` — 两个固定选择和一个自定义输入。
- `src/components/gameActionRequest.ts` — 统一请求与浏览器 action ID。
- `src/app/api/game/actions/route.ts` — 唯一行动 HTTP adapter。
- `src/game/application/requestParser.ts` — 请求白名单与 discriminated union 解析。
- `src/game/application/performTurn.ts` — 统一回合编排。
- `src/game/application/actionConverter.ts` — token/free text 到 Action 的服务端转换。
- `src/game/application/gameSessionView.ts` — 焦点 NPC 对话 read model。
- `src/game/domain/npcSpeech.ts` — 直接台词归一化、通用确认句识别和无场景问候兜底。
- `src/game/application/sceneGenerationContext.ts` — 从当前场景与 pending job 投影上一轮 NPC 台词/玩家选项，供 live 与 deterministic source 共用。
- `src/game/application/server/ai/liveScenePerformanceSource.ts` — 生成并解析焦点 NPC 台词、handoff 交接和同次 API 的非焦点 NPC 闲聊。
- `src/game/domain/approvedChoice.ts` — 保留 talk 的 `dialogueAct/topic`，并将主题纳入语义去重与 opaque token 派生。

## 主要验收

- `AdventureGameShell.test.tsx`：焦点 NPC 两个固定选择、一个自定义输入，同一请求 helper。
- `gameActionRequest.test.ts` 与 action route tests：两种输入同一端点、每次 UUID、字段白名单和错误映射。
- `performTurn.test.ts`：连续自定义输入拥有不同 action/turn ID、两次记忆、两次 pending、两次 CAS。
- `foundationJourney.test.ts` 与 `storyDivergenceJourney.test.ts`：固定选择和自定义输入可持续推进 15+ 回合并形成不同结局。

## 修改注意事项

- UI 不得制造 token、解析 token 或回退到业务 action key。
- 闲聊是只读展示、零写入、不创建回合；“成功输入就是正式玩家回合”仅约束可提交输入。
- 规则裁决和 NPC 知识边界不能交给 AI；AI 只负责 proposal 与表达。
- `src/game/gameplay/rpg/ruleEngine/index.ts` — 维护最少两轮的 dialogue session，防止首次回应直接完成交谈目标。
- 场景生成、审批写回和 read model 投影都执行台词归一化，因此旧存档中已保存的“NPC 名称 + 动作 + 台词”包装不会继续出现在对话框。
- read model 会兼容旧交接存档：当已保存的 dialogue focus 与当前在场 talk 目标不一致时，丢弃过期的焦点选项并把旧 NPC 降为零回合闲聊（“知道了”关闭）；新记录按 `speechPurpose` 决定台词用途，旧记录按 `scene.npcLine.npcId` 推断，绝不以 `speechSource` 替代用途判定。当前目标切换后的 provider pending 期间，HUD 显示稳定的“正在编排下一幕……”状态，不把尚未物化的任务显示为“暂无线索”；failed 期间显示可重试的生成失败状态。
- 非终幕目标完成但下一幕尚未编排时，规则状态会暂存 `evolution.status=needs_next_act`；当前地点投影一次“继续追查下一幕线索”服务器行动，提交后进入既有世界演化/场景编排链，避免 HUD 暂无线索时无法继续。结局对物化且 `endingAllowed=true` 后，HUD/读模型改投影“选择结局方向”，地点入口显示“面对最终抉择”，不再回退为“暂无线索”；玩家提交最终 NPC 的 support/challenge 后才结算结局。终幕 `ready_for_ending` 仍沿用匹配完成会话的收尾判定。
- 旧场景中可能持久化的 `smallTalk` 数据不再投影到客户端；非焦点 NPC 只显示零回合闲聊（`choices: []`），`ask` 入口仅由当前权威 talk 目标投影。新的 `npcDialogues` 台词由场景 API 同步生成并随 scene 写回。
- 任何新输入形态必须先扩展 `Interaction` union，并继续通过 `/api/game/actions` 与 `performTurn`，不能新增并行入口。

## 历史说明

2026-08-09 之前的 dated Spec/Plan 曾描述并行版本路由、独立 dialogue use case 和旧 GameState 链；这些内容仅保留为历史决策记录，已被当前单一路径取代。
