# 运行时 AI 导演与场景表演

## 系统定位

运行时 AI 负责提出下一幕的结构化场景表演（分段旁白、焦点 NPC 台词、目标链接与合法选项）；规则系统负责审批候选、铸造玩家 token、裁决行动、审批世界演化并写入状态。AI 不直接写存档，也不能决定任务、关系、知识、战斗或结局。

真机回合的 live 场景表演调用以 45 秒为单次上限；场景表演和世界演化分别使用 3000/3200 completion tokens，因为 provider 可能仍把 reasoning_content 计入同一预算。当前 new-api → DeepSeek 官方 OpenAI-compatible 链路通过请求体 `thinking: { type: "disabled" }` 关闭默认思考，显式角色策略才发送 `type: "enabled"`。若预算被 reasoning 消耗完，API 可能返回 HTTP 200 但没有可解析的 `message.content`，仍按 AI 提案失败处理。生产配置启用 live 时由单一 `RpgAiClient` 统一执行：timeout、限流、5xx 和网络失败按角色策略重试；AI 已返回但 JSON/场景契约或审批不通过时，同一回合最多再发送一次带稳定字段级失败原因的内容修复请求，修复仍失败就返回稳定 failure。`empty_response` 仍不在客户端重复相同请求，避免再次消耗预算却重复得到空 final content；失败不会被改写成 generated，也不会让玩家永久停留在 `provider_pending`：provider job 持久化为 `provider_failed`，玩家可手动重试同一 job。无 AI 配置时生产注入 unavailable source；确定性 source 只由显式离线 fixture 使用。

## 重试分层与修复边界（2026-08-22）

场景/world 的“传输 retry、内容修复、手动 failed-job retry”是三层互相独立的机制，由审计的 `context.retry.{origin,mechanism,attempt,reason}` 区分：

- **传输 retry（transport）**：`RpgAiClient` 在 `maxAttempts`（intent/opening/scene=2、world=3）内对 timeout/网络/限流/5xx 的 provider 级重试。顶层 `ai_call.attempt` 记 2/…，`mechanism=transport`，保留上游传入的 `origin`（`normal`/`manual_failed_job`），**绝不覆盖 origin**。`empty_response` 不重复发送完全相同请求。
- **内容修复（content_repair）**：结构化 JSON/schema/reference 解析失败或审批拒绝时，同一 pending 回合**最多再发送一次**带稳定字段级原因/拒绝码的修复请求；`mechanism=content_repair`、`context.retry.attempt=1`。场景解析器会保留 `segment_unknown_beat`、`segments_empty`、`choices_stale_template` 等原因码，prompt 会把原因展开成对应字段的修复指令；world 由 `evolveWorld` 两轮循环统一控制（见 `世界动态具象化.md`），scene 沿用 `repairAttempt` 且整个回合最多一次。修复耗尽统一返回稳定 `AI_RESPONSE_INVALID`，不创建 deterministic 成功。
- **手动 failed-job 重试（manual_failed_job）**：只有 `{ "retry": true }` 才以同一 job CAS 将 `failed→pending` 并重跑；failed 状态中的稳定 `failure.reason` 会写入 pending 的内部 `retryContext`，因此该次重跑的首个 AI 请求已经是 `mechanism=content_repair`、`attempt=1`，并保留 `origin=manual_failed_job`。如果该请求再次返回可修复失败，当前生成预算仍可再执行一次内容修复。普通 `/api/game/narrative/ensure` 轮询只观察/恢复 pending、绝不自动重跑 failed job，`origin=normal`。

`attempt` 语义：顶层 `ai_call.attempt` 是 provider transport 序号（初始 1）；`context.retry.attempt` 是重试分类内的逻辑序号（`initial=0`、`content_repair=1`、`transport` 为 provider attempt 值），两者不可混淆。

一旦 pending job 已由规则结果完全确定，服务器立即在后台生成，不等待“开始冒险”、继续、确认或下一次客户端 ensure。创建新局与成功回合返回前只完成快速排队，不等待 AI；协调器以 `gameId + jobId` 去重，客户端 ensure/polling 只负责崩溃恢复和结果观测。

## 当前生产闭环

```text
成功玩家回合
  → PendingNarrativeJob（含 ObjectiveTransition + 强制节拍 ≤8）
  → generatePendingScene
  →（可选）world-evolution：EvolutionNeed → proposal → 审批 → 铸 ID → 预览状态
  → SceneGenerationContext（最小权限、当前合法候选、焦点 NPC 隔离上下文）
  → SceneSource proposal（live；显式 offline fixture 才是 deterministic）
  → approveScenePerformance
  → 单次 scene CAS 原子写回：已批准世界演化 + ready scene + choice registry + candidate events
  → GameSessionView
```

## Scene Prompt 编译器（2026-08-23）

- `liveScenePerformanceSource` 现在只通过 `compileSceneNarrativeContext(context, selectable)` 生成 Prompt；scene Prompt 的唯一 schema/块定义来源是 `src/game/application/server/ai/narrativeContext/contextBlock.ts`、`sceneNarrativeContext.ts` 与 `renderNarrativeContext.ts`，不再在 source 内额外拼接第二份 schema。
- scene 编译块会投影：规则与题材约束、故事契约、当前剧情状态、玩家安全事实卡、当前可见事实、已结算强制节拍与 `objectiveLink`、当前位置、焦点 NPC 隔离上下文、最近 beats、风格策略、当前回合输入、合法候选动作、上一轮对话、prepared continuation descriptors 和 repair 指令。
- scene 编译块明确不投影：完整 `GameRecord`、完整 `eventLedger`、其他 NPC 的私密记忆、焦点 NPC 的私密事实正文、玩家长期自由文本历史、隐藏 registry/effect/debug 结构，以及任何未在 `narrativeReferenceIds`/allowlist 中批准的实体 ID。
- 编译产物的 manifest 只进入审计上下文 `context.narrativeContext` 作为元数据；source 不保存第二份 Prompt 副本，也不把渲染后的 Prompt 文本写入存档或 manifest。

## 已冻结约束

- SceneSource 只返回表演 proposal，不能返回可直接落库的 ready state。
- **一次场景表演调用**：每个 ready 场景只调用一次 live 场景表演源；不再有 director/writer/npc 三次独立请求管线。
- **provider 触发白名单**：生产 provider job 只允许 `opening`、`npc_fixed_choice`、`npc_free_text`。正式 NPC job 内可按 `EvolutionNeed` 完成所需 world evolution；移动、调查、物品、战斗和回退导航不能在动作路径新增 provider 调用。
- **候选不足处理**：普通 ready 场景若真实可执行候选少于两个，生产编排将 `scene_candidate_shortage` 视为 AI/审批失败，持久化 failed，不把无内容的 explore 当作合法候选；只有 `dialogueSession.completed=true` 且目标已推进的收尾 handoff scene 允许一个候选。离线 journey 可显式注入 deterministic evolution fixture 补齐候选，但不代表生产 AI 失败时的行为。
- 普通对话场景绑定一个在场焦点 NPC，并提出两个语义不同的 TalkAction；收尾场景由同一次生成返回旧 NPC 的最后一句和一个绑定下一任务/地点/人物的 handoff Action。其他场景从服务端给出的合法候选 ID 中选择两个不同 Action。
- `ObjectiveTransition.mode === advanced_act` 时叙事事件仍记录为非对话的任务交接；上一轮带 `player_utterance` 时焦点保持在原 NPC，由其先回应本轮话语，新目标只作为权威行动入口出现。新 talk 目标还没有 ready scene 时，read model 只能提供两项 handoff 回应入口，不能合成角色 fallback 台词或开放自由输入；正式选择提交后才创建 provider job。进入地点或点击 talk 本身不额外提交一次 `ask` API。玩家主动点击旁 NPC 时仍保持普通 `ask` 语义。目标身份由服务端锁定的 `objectiveLink` 和实体 ID 决定，旁白不要求逐字复述目标标签。
- `move` / battle start-resolve 命中已审批的 `PreparedContinuationState` 时，规则结果、prepared scene 物化、choice token 铸造、continuation 消费和 revision 递增共用一次 CAS，零 live/world/intent provider 调用。`discover_fact` 在规则边界自动确认；历史 investigate step 仅兼容旧状态。无 prepared step 的 `take_item` / `give_item`、回退导航和 active battle round 直接产生 `source="rule"` 场景。
- 两个已批准选择若都指向同一在场 NPC 的 TalkAction，即使触发事件是 travel/battle，也投影为该 NPC 的焦点对白；回答分支只在对话框显示，地点页不再渲染底部行动栏。
- live source 只能选择服务端候选 ID，不能发明任意 `actionKey`、实体 ID、事实 ID 或规则结果。
- 审批器逐字段重建 scene/event/choice；生成对象原引用不能直接持久化。
- 服务器根据 post-writeback revision 铸造 opaque `choiceToken`；客户端场景不含 `actionKey`、registry、候选 effect、隐藏事实或 AI diagnostics。
- ready scene、choice registry、candidate event pool 与已批准世界演化同一次 scene CAS 写回；行动消费时再次验证当前 scene、revision 与规则合法性。
- scene CAS 与序幕确认并发时，repository 单调保留已确认的 `prologueShown=true`；确认接口对 stale revision 读取新快照后有限重试。
- 离线 fixture 可使用 deterministic source，并经过同一 proposal → approval → write-back 链；生产成功的 live proposal 才能标记 `source=generated`。API 失败或内容修复/审批重试仍拒绝时不写确定性剧情，而是保存稳定 failure 和原 job。场景核心与 prepared continuation 必须来自同一次 accepted attempt，不能从被拒绝的 proposal 拆取未来内容。
- active battle、ending 或候选不足时不伪造普通场景选择。
- `PreparedContinuationState` 是服务端维护的有向无环图，不是客户端可读的扁平队列。每个 step 带有 server-authored trigger、消费组和后继；战斗结果等 sibling step 共享消费组，消费后只激活声明的 successor 并裁剪未选分支。历史调查 step 仅兼容旧状态；step 不保存 minted token，只有物化为当前 scene 后才按 post-commit revision 铸造 token。
- active battle 采用规则 fast path：不创建 pending 场景、不调用 scene source；界面只提供攻击/防守，撤退不再作为可执行选项。战斗开始时保存玩家属性、已击败敌人和事件账本快照；失败只恢复快照并可重新挑战，不推进剧情。
- 战斗胜利的 `battle_resolved` scene 只能消费已审批 prepared step；不执行战斗预热，不在最后一击后创建 provider job。战斗失败沿用战斗开始前快照恢复世界、属性和事件账本，回到可重新挑战状态，不推进剧情。
- 武侠世界的世界演化审批与 live 提示词共同执行题材边界，拒绝骑士、灵魂、祭坛、圣光等跨题材实体或结局意象，避免 AI 合法 JSON 造成世界观漂移。

## Prepared continuation 消费（2026-08-24）

- **生成点**：开局或正式 NPC fixed/free-text 的一次 accepted scene proposal 可携带完整的 `preparedContinuations` scene seed。服务端根据候选 projection 重建 step ID、trigger、消费组、后继与 active membership；AI 不提交图元数据，也不能决定未来实体的释放顺序。
- **图与分支**：图必须 step ID/后继唯一、无环、每条 active 路径最终抵达下一处正式 NPC 决策边界。调查 approaches、battle outcomes 等兄弟分支共享消费组；消费一个 step 会裁剪同组未选分支，只激活 server-authored successors。
- **消费语义**：`move`、`battle_started`、`battle_resolved` 先由规则核对权威实体/敌人与 trigger，再在同一次 CAS 中应用规则结果、物化 prepared scene、按 post-commit revision 铸造 choices、消费当前 group 并递增 revision；事实发现由规则边界自动完成。
- **错误边界**：没有 active matching step 返回 `NARRATIVE_CONTINUATION_MISSING`；图结构、权威事件或实体不一致返回 `NARRATIVE_CONTINUATION_INVALID`。两者都不调用 provider 且零状态写入，不回退为 live 或 deterministic 生产场景。

## 叙事边界编排（2026-08-25）

- 非对白行动完成当前幕最后一个主线目标后，若 `evolution.status=needs_next_act` 或 `needs_ending_pair`，read model 会投影一次“继续追查下一幕线索”探索入口；该入口只负责提交边界编排请求，不把无目标地点伪装成普通探索。结局对物化且 `endingAllowed=true` 后，read model 继续投影“选择结局方向”目标和“面对最终抉择”入口，直到玩家提交最后的 support/challenge 立场。
- `performTurn` 对边界请求复用已批准的 provider 世界/场景编排链；新幕或结局写回前保持 pending 锁定。终幕最后一轮 `talk_to_npc` 即使目标转换模式为 `ready_for_ending`，也必须依据匹配且已完成的 `dialogueSession` 选择 `npc_handoff`，不能退回普通双选项场景。最终 support/challenge 一旦由规则层写入 `ending`，直接 CAS 保存结局并停止 provider scene job，避免后台失败遮蔽结局页。

## 强制节拍与目标链接

- 每个 ready 场景以**分段旁白**呈现；每一段必须对应服务端下发的强制节拍 ID（`player_utterance` / `item_obtained` / `fact_discovered` / `quest_progress` / `quest_advanced` / `battle_started` / `battle_round` / `battle_resolved` / `entity_introduced`），数量 ≤8，可另附一个 `atmosphere` 段且必须置于最后。
- `objectiveLink` 必须与权威 `ObjectiveTransition.after` 一致（无 after 目标时为 null）；目标在本回合推进时，必须产出 `quest_advanced` 段命名新目标相关的已批准实体。
- 当玩家对焦点 NPC 提交话语（`job.utterance`）时，表演契约必须返回该 NPC 的台词并列出它应答的 `player_utterance` 节拍；缺失应答使提案进入一次内容修复，修复仍缺失就返回 `AI_RESPONSE_INVALID`，不写 deterministic scene。玩家界面保留该 NPC 的会话焦点：pending 时短暂遮蔽，ready 后先显示这句回应，failed 时显示重试提示。
- `npcLine.text` 的输出边界是 NPC 第一人称直接台词：不得带 NPC 名称、动作或“说道/答道”等叙述性包装。审批写回和 read model 会再次归一化，以兼容历史场景。
- 对话上下文、选项和直接台词都由 live source 生成并经结构化审批；失败只返回 stable failure。显式 offline fixture 才可读取 `job.utterance`、关系档位和当前目标生成可重放回应。
- 承接玩家原话时，NPC 以自己的口吻概括并回答，不得把整段玩家输入包进“你刚才问的‘……’”再反问。该质量门槛不通过时归类为 `AI_RESPONSE_INVALID`，不改写为生产 deterministic 成功。
- 焦点 NPC 的开场、正式回应与终局追问至少两句：第一句回应，第二句补充线索、保留或下一步。质量门槛失败经过一次内容修复仍不通过时，场景进入 failed；live prompt 同时禁止把系统元话术写进玩家可见旁白。

## 焦点 NPC 隔离上下文

- 场景表演只收到**一名焦点 NPC** 的隔离记忆：`focusNpcContext` 只含该 NPC 的公开档案、关系回应政策、可披露事实卡（`speakableFactCards`）、最近 5 条结构化交互（`recentInteractions`，仅 actionId + dialogueAct + topicSummary + outcome + summary）、目标与回合后情绪。
- 绝不包含其他 NPC 的记忆条目；绝不包含玩家原文；未获披露批准的私密事实只下发不含 ID 的扣留指示，正文永不出现。
- 关系以"回合后档位（tier）+ 情绪 + 本轮 relationshipDelta/outcome"承载，绝不裸给数字。
- 玩家自由文本只供当前回合意图解析；原文只存在于 `PendingNarrativeJob.utterance`，不进入长期记忆、事件账本、prompt replay 或日志。
- AI narration 与 NPC 台词不是规则事实。事实、任务、关系与结局只能来自已提交的结构化事件。

## 连续性与分化

- 每个成功玩家回合都排队下一幕，选择结果进入结构化状态和有界记忆，下一次生成读取这些已批准结果；对话目标的下一幕焦点在 ready 场景生成时确定，避免把“打开对话”误当成新的剧情回合。
- 相同 seed 与相同输入/选择序列可确定性 replay；不同 seed 改变初始世界结构。
- 同 seed 下"支持/质疑"选择会改变 NPC affinity/emotion/history、候选事件和结局方向（trust/doubt 由规则要求按关键 NPC 亲和度裁决），不只是改写叙事文案。
- 开局小、随游玩增长：下一次世界演化批准的新 NPC/地点/物品会进入场景上下文，并要求场景提及该实体。

## 主要文件

- `src/game/application/sceneSource.ts` — scene-performance proposal 契约。
- `src/game/application/sceneGenerationContext.ts` — 最小权限上下文、合法候选、强制节拍、目标链接实体和 prepared continuation descriptors 投影。
- `src/game/application/deterministicEvolutionBeats.ts` — 离线 fixture 节拍与"线索→新地点"动线因果。
- `src/game/application/focusNpcContext.ts` — 焦点 NPC 隔离记忆与关系政策投影。
- `src/game/application/deterministicSceneSource.ts` — 显式离线 fixture proposal。
- `src/game/application/gameSessionView.ts` — 投影焦点能力，并修复旧存档中与权威目标冲突的过期焦点；调查/移动/取物/战斗目标出现时会关闭上一轮 NPC 的双选项焦点；新 talk 目标在 scene 未 ready 前不投影 fallback 台词或自由输入；终幕结局对就绪后投影稳定的结局决策目标。
- `src/game/application/approveAndWriteScene.ts` — 场景表演审批与写回。
- `src/game/application/generatePendingScene.ts` — 生成编排与原子 write-back。
- `src/game/application/markNarrativeGenerationFailed.ts` / `retryNarrativeGeneration.ts` — failed 持久化与同 job CAS 手动重试。
- `src/game/application/evolveWorld.ts` / `worldEvolutionSource.ts` — 可选世界演化编排与 port。
- `src/game/gameplay/rpg/narrativeContext/` — `buildOutcomeBeats` / `deriveObjectiveTransition` / `npcResponsePolicy`。
- `src/game/application/server/ai/liveScenePerformanceSource.ts` / `liveWorldEvolutionSource.ts` / `sourceFactory.ts`。
- `src/game/application/server/ai/narrativeContext/contextBlock.ts` / `compileNarrativeContext.ts` / `sceneNarrativeContext.ts` / `renderNarrativeContext.ts`。
- `src/game/application/server/ai/rpgAiClient.ts` — 唯一 server-side transport facade；按 `intent/opening/scene/world` 独立控制 thinking、预算、超时、JSON mode 和 transient retry。

## 验收重点

- 普通 generated 场景有两个不同 token；对话收尾 generated scene 有一个绑定下一步的 handoff token；scene JSON 无 `actionKey`；AI 失败只产生 stable failed 状态。
- 分段旁白逐段命中强制节拍 ID；`objectiveLink` 与 HUD 当前目标一致；焦点 NPC 台词应答当前 `player_utterance`。
- NPC 台词只保留直接对白正文，不能以“邵叔如实答道：……”形式把舞台说明混入气泡；旧存档投影也必须满足同一断言。
- 新 talk 目标的交接提示不是 NPC 台词：在 `event.kind` 不是 dialogue 且没有可用 `npcLine`/dialogue pages 时，read model 保留两项 handoff 入口但对白页为空；生产 live/generated scene 不得用 deterministic fallback 冒充成功。
- registry 的 `basedOnRevision` 等于 scene 写回后的 revision。
- tampered、stale、重复 token 零写入。
- live source 越权引用或失败不会绕过审批；失败保留规则已提交状态并等待手动重试。离线旅程通过显式 fixture source 完成，不代表生产 AI 失败时仍可通关。

## 历史说明

早期 dated 文档中的三角色 pipeline、版本化接口名和旧 scene adapter 只作历史记录。当前生产事实以本页列出的 neutral application/server 文件为准。
