# 运行时 AI 导演与场景表演

## 系统定位

运行时 AI 负责提出下一幕的结构化场景表演（分段旁白、焦点 NPC 台词、目标链接与合法选项）；规则系统负责审批候选、铸造玩家 token、裁决行动、审批世界演化并写入状态。AI 不直接写存档，也不能决定任务、关系、知识、战斗或结局。

真机回合的 live 场景表演调用以 45 秒为单次上限；场景表演和世界演化分别使用 3000/3200 completion tokens，因为 provider 可能仍把 reasoning_content 计入同一预算。当前 new-api → DeepSeek 官方 OpenAI-compatible 链路通过请求体 `thinking: { type: "disabled" }` 关闭默认思考，显式角色策略才发送 `type: "enabled"`。若预算被 reasoning 消耗完，API 可能返回 HTTP 200 但没有可解析的 `message.content`，仍按 AI 提案失败处理。生产配置启用 live 时由单一 `RpgAiClient` 统一执行：timeout、限流、5xx 和网络失败按角色策略重试；AI 已返回但 JSON/场景契约或审批不通过时，同一回合最多再发送一次带失败原因的内容修复请求，修复仍失败就返回稳定 failure。`empty_response` 仍不在客户端重复相同请求，避免再次消耗预算却重复得到空 final content；失败不会被改写成 generated，也不会让玩家永久停留在 `narrativeGeneration.pending`：pending 场景持久化为 failed，玩家可手动重试同一 job。无 AI 配置时生产注入 unavailable source；确定性 source 只由显式离线 fixture 使用。

## 重试分层与修复边界（2026-08-22）

场景/world 的“传输 retry、内容修复、手动 failed-job retry”是三层互相独立的机制，由审计的 `context.retry.{origin,mechanism,attempt,reason}` 区分：

- **传输 retry（transport）**：`RpgAiClient` 在 `maxAttempts`（intent/opening/scene=2、world=3）内对 timeout/网络/限流/5xx 的 provider 级重试。顶层 `ai_call.attempt` 记 2/…，`mechanism=transport`，保留上游传入的 `origin`（`normal`/`manual_failed_job`），**绝不覆盖 origin**。`empty_response` 不重复发送完全相同请求。
- **内容修复（content_repair）**：结构化 JSON/schema/reference 解析失败或审批拒绝时，同一 pending 回合**最多再发送一次**带稳定原因/拒绝码的修复请求；`mechanism=content_repair`、`context.retry.attempt=1`。world 由 `evolveWorld` 两轮循环统一控制（见 `世界动态具象化.md`），scene 沿用 `repairAttempt` 且整个回合最多一次。修复耗尽统一返回稳定 `AI_RESPONSE_INVALID`，不创建 deterministic 成功。
- **手动 failed-job 重试（manual_failed_job）**：只有 `{ "retry": true }` 才以同一 job CAS 将 `failed→pending` 并重跑，`origin=manual_failed_job`（该 job 第一次 AI 请求仍是 `mechanism=initial`，后续内容修复仍保持该 origin）。普通 `/api/game/narrative/ensure` 轮询只观察/恢复 pending、绝不自动重跑 failed job，`origin=normal`。

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
- scene 编译块会投影：规则与题材约束、故事契约、当前剧情状态、玩家安全事实卡、当前可见事实、已结算强制节拍与 `objectiveLink`、当前位置、焦点 NPC 隔离上下文、最近 beats、风格策略、当前回合输入、合法候选动作、上一轮对话、单线预生成目标和 repair 指令。
- scene 编译块明确不投影：完整 `GameRecord`、完整 `eventLedger`、其他 NPC 的私密记忆、焦点 NPC 的私密事实正文、玩家长期自由文本历史、隐藏 registry/effect/debug 结构，以及任何未在 `narrativeReferenceIds`/allowlist 中批准的实体 ID。
- 编译产物的 manifest 只进入审计上下文 `context.narrativeContext` 作为元数据；source 不保存第二份 Prompt 副本，也不把渲染后的 Prompt 文本写入存档或 manifest。

## 已冻结约束

- SceneSource 只返回表演 proposal，不能返回可直接落库的 ready state。
- **一次场景表演调用**：每个 ready 场景只调用一次 live 场景表演源；不再有 director/writer/npc 三次独立请求管线。
- **世界演化是按需的可选调用**：仅当 `EvolutionNeed.kind !== "none"`（幕推进/节奏/终局对）才触发；正常对话回合不调用演化源。
- **候选不足处理**：若真实可执行候选少于两个，生产编排将 `scene_candidate_shortage` 视为 AI/审批失败，持久化 failed，不把无内容的 explore 当作合法候选。离线 journey 可显式注入 deterministic evolution fixture 补齐候选，但不代表生产 AI 失败时的行为。
- 对话场景绑定一个在场焦点 NPC，并提出两个语义不同的 TalkAction；其他场景从服务端给出的合法候选 ID 中选择两个不同 Action。
- `ObjectiveTransition.mode === advanced_act` 时叙事事件仍记录为非对话的任务交接；上一轮带 `player_utterance` 时焦点保持在原 NPC，由其先回应本轮话语，新目标只作为权威行动入口出现。进入地点或点击 talk 只打开 ready 对话，不再为首次交谈额外提交一次 `ask` API。玩家主动点击旁 NPC 时仍保持普通 `ask` 语义。目标身份由服务端锁定的 `objectiveLink` 和实体 ID 决定，旁白不要求逐字复述目标标签。
- 已由一键 `move` / `investigate` / `take_item` 唯一确定结果的单动作仍可即时完成规则结算；命中已审批的 `linearNarrativeQueue` 时复用 generated 叙事，未命中时在 AI mode 调用注入的 live scene source，失败就持久化 failed，不在编排层创建 deterministic scene。离线 fixture 才能注入确定性即时 source。幕推进/结局对挂起（`evolution.status === needs_next_act / needs_ending_pair`）时不被即时路径短路，保留完整世界演化编排。
- 两个已批准选择若都指向同一在场 NPC 的 TalkAction，即使触发事件是 travel/battle，也投影为该 NPC 的焦点对白；底栏只保留一个“与 NPC 交谈”主线入口，回答分支只在对话框显示。
- live source 只能选择服务端候选 ID，不能发明任意 `actionKey`、实体 ID、事实 ID 或规则结果。
- 审批器逐字段重建 scene/event/choice；生成对象原引用不能直接持久化。
- 服务器根据 post-writeback revision 铸造 opaque `choiceToken`；客户端场景不含 `actionKey`、registry、候选 effect、隐藏事实或 AI diagnostics。
- ready scene、choice registry、candidate event pool 与已批准世界演化同一次 scene CAS 写回；行动消费时再次验证当前 scene、revision 与规则合法性。
- scene CAS 与序幕确认并发时，repository 单调保留已确认的 `prologueShown=true`；确认接口对 stale revision 读取新快照后有限重试。
- 离线 fixture 可使用 deterministic source，并经过同一 proposal → approval → write-back 链；生产成功的 live proposal 才能标记 `source=generated`。API 失败或内容修复/审批重试仍拒绝时不写确定性剧情，而是保存稳定 failure 和原 job。场景核心审批与 `linearActionNarratives` 审批相互独立：核心失败时，已通过权威实体链校验的线性队列仍随同一次 CAS 写回。
- active battle、ending 或候选不足时不伪造普通场景选择。
- 移动/拾取/调查是规则结果已完全确定的单动作（`immediateAction`）；pending 场景同步完成审批/写回。**队列命中优先于候选不足/world 演化**：`move/investigate`（且 `evolution.status` 非 `needs_next_act/needs_ending_pair`）在 `derivedNeed` 计算、初始 `evolveWorld` 与 `scene_candidate_shortage` 的 `evolveWorld` 之前，直接从当前权威 `linearNarrativeQueue` 精确匹配（actionKind+entityId）消费对话回合 AI 预生成的叙事（source=generated，零 scene/world AI 调用、消费即除）；`take_item` 不参与队列匹配（仍保留规则 CAS 和结构化 `item_obtained` 节拍）。队列命中仍走同一场景审批/CAS：`buildQueuedGeneratedSceneProposal` 用当前合法候选构造两个 choice；若命中但合法候选不足两个，在无任何 AI 调用下返回稳定 `AI_RESPONSE_INVALID`（phase=scene），且 server logger 记 `world_state_inconsistent`。只有未命中才沿 `immediateAction`/`deriveEvolutionNeed` 逻辑，AI mode 调用 live scene source，失败持久化 failed 并等待手动重试。`NarrativeGenerationPath`（`pre_generated_queue`/`live_scene`）只是 server logger 结构化字段，不持久化到 StoryState/GameSessionView。显式 offline fixture 才提供 deterministic 即时 source；幕推进/结局对挂起时不被 fast path 短路。
- active battle 采用规则 fast path：不创建 pending 场景、不调用 scene source；界面只提供攻击/防守，撤退不再作为可执行选项。战斗开始时保存玩家属性、已击败敌人和事件账本快照；失败只恢复快照并可重新挑战，不推进剧情。
- 战斗胜利的 `battle_resolved` 场景可以在战斗开始时预热 live proposal；预热失败不使用 deterministic prewarm，最后一击后的正常 pending coordinator 继续调用 live source，仍失败就持久化 failed 并等待手动重试。战斗失败沿用战斗开始前快照恢复世界、属性和事件账本，回到可重新挑战状态，不推进剧情。
- 武侠世界的世界演化审批与 live 提示词共同执行题材边界，拒绝骑士、灵魂、祭坛、圣光等跨题材实体或结局意象，避免 AI 合法 JSON 造成世界观漂移。

## 线性调查叙事队列（2026-08-19）

- **生成点**：对话回合（唯一实时 AI 生成点）的场景表演提案可携带 `linearActionNarratives`（`investigate`→factId / `move`→locationId + narration）。若移动地点的下一目标是同地点 NPC，`move` 还必须携带 `arrivalNpcLine`（目标 NPC ID、两句直接对白、可说事实引用）；这段对白随移动预生成，不创建回合、不生成选项。live prompt 在 `SceneGenerationContext.upcomingLinearObjectives` 非空时要求生成；约束：只演绎服务端下发权威事实（factText）、必须解释为何前往下一地点、不得捏造新事实/实体/时间、无系统元话术。分段旁白可选 `referencedEntityIds` 表达 grounding，旁白正文保持自然语言，不承担实体身份判定。
- **投影语义**：`upcomingLinearObjectives` 是从当前权威目标开始的连续单线前缀（discover_fact / visit_location；遇 talk_to_npc / defeat_enemy 等分支点立即停止）；visit_location 若紧邻 talk_to_npc 且 NPC 已由世界演化同步生成，则附带该 NPC 的最小权限对白上下文。当前目标即分支点或无单线链时为空。
- **审批与持久化**：live parser 先按 `SceneGenerationContext.narrativeReferenceIds` allowlist 去重并过滤未知 `referencedEntityIds`；`approveScenePerformance` 对 `objectiveLink`、节拍、NPC、选项等结构做硬校验，对幕交接缺少目标引用只产出 `SceneQualityWarningCode`（`missing_objective_reference` / `invalid_objective_reference` / `missing_objective_surface`），不再用旁白 `includes(entityName)` 拒绝整场。带目标 NPC 的移动缺少 `arrivalNpcLine` 视为整场内容契约失败，自动内容修复一次，仍失败则保存 failed 等待手动重试；不生成 deterministic/fallback 场景。通过后随同一次场景 CAS 写回覆盖式持久化到 `storyState.narrative.linearNarrativeQueue`（`LinearActionNarrativeState`，source 恒为 "generated"）。场景核心失败时仍保留原 proposal 中已通过独立审批的队列；旧存档缺失视为空，零迁移。
- **fast path 消费**：调查/移动走 `immediateAction` 时从 `linearNarrativeQueue` 精确匹配（actionKind+entityId）消费，消费即除、零 live 调用；调查场景重建时保留尚未消费的后续队列条目，避免丢失抵达对白。未命中或命中不完整旧队列时在 AI mode 进入 live source，失败为 failed + stable failureKind。显式 offline fixture 才使用 deterministic source；幕推进/结局对挂起时保留完整世界演化编排。
- **离线动线 fixture**：deterministic investigate fixture 可在权威事实文本后追加结构化下一目标动线提示；该文案只用于离线旅程和规则回放，不代表生产 AI 失败时的用户体验。

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
- 绝不包含其他 NPC 的记忆条目；绝不包含玩家原文；未获披露批准的私密事实只下发 ID + 扣留指示（`responsePolicy.privateKnowledgeIds`），正文永不出现。
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
- `src/game/application/sceneGenerationContext.ts` — 最小权限上下文与合法候选、强制节拍、目标链接实体、`upcomingLinearObjectives` 单线前缀投影。
- `src/game/application/deterministicEvolutionBeats.ts` — 离线 fixture 节拍与"线索→新地点"动线因果。
- `src/game/application/focusNpcContext.ts` — 焦点 NPC 隔离记忆与关系政策投影。
- `src/game/application/deterministicSceneSource.ts` — 显式离线 fixture proposal。
- `src/game/application/gameSessionView.ts` — 投影焦点能力，并修复旧存档中与权威目标冲突的过期焦点；调查/移动/取物/战斗目标出现时会关闭上一轮 NPC 的双选项焦点。
- `src/game/application/approveAndWriteScene.ts` — 场景表演审批与写回。
- `src/game/application/generatePendingScene.ts` — 生成编排与原子 write-back。
- `src/game/application/markNarrativeGenerationFailed.ts` / `retryNarrativeGeneration.ts` — failed 持久化与同 job CAS 手动重试。
- `src/game/application/evolveWorld.ts` / `worldEvolutionSource.ts` — 可选世界演化编排与 port。
- `src/game/gameplay/rpg/narrativeContext/` — `buildOutcomeBeats` / `deriveObjectiveTransition` / `npcResponsePolicy`。
- `src/game/application/server/ai/liveScenePerformanceSource.ts` / `liveWorldEvolutionSource.ts` / `sourceFactory.ts`。
- `src/game/application/server/ai/narrativeContext/contextBlock.ts` / `compileNarrativeContext.ts` / `sceneNarrativeContext.ts` / `renderNarrativeContext.ts`。
- `src/game/application/server/ai/rpgAiClient.ts` — 唯一 server-side transport facade；按 `intent/opening/scene/world` 独立控制 thinking、预算、超时、JSON mode 和 transient retry。

## 验收重点

- generated 场景各有两个 proposal、两个不同 token，scene JSON 无 `actionKey`；AI 失败只产生 stable failed 状态。
- 分段旁白逐段命中强制节拍 ID；`objectiveLink` 与 HUD 当前目标一致；焦点 NPC 台词应答当前 `player_utterance`。
- NPC 台词只保留直接对白正文，不能以“邵叔如实答道：……”形式把舞台说明混入气泡；旧存档投影也必须满足同一断言。
- registry 的 `basedOnRevision` 等于 scene 写回后的 revision。
- tampered、stale、重复 token 零写入。
- live source 越权引用或失败不会绕过审批；失败保留规则已提交状态并等待手动重试。离线旅程通过显式 fixture source 完成，不代表生产 AI 失败时仍可通关。

## 历史说明

早期 dated 文档中的三角色 pipeline、版本化接口名和旧 scene adapter 只作历史记录。当前生产事实以本页列出的 neutral application/server 文件为准。
