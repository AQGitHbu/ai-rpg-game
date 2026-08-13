# 运行时 AI 导演与场景表演

## 系统定位

运行时 AI 负责提出下一幕的结构化场景表演（分段旁白、焦点 NPC 台词、目标链接与合法选项）；规则系统负责审批候选、铸造玩家 token、裁决行动、审批世界演化并写入状态。AI 不直接写存档，也不能决定任务、关系、知识、战斗或结局。

真机回合的 live 场景表演调用以 30 秒为上限；超时、服务失败或非法响应立即回退同轨确定性 source，不能让存档长期停在 `narrativeGeneration.pending`。

一旦 pending job 已由规则结果完全确定，服务器立即在后台生成，不等待“开始冒险”、继续、确认或下一次客户端 ensure。创建新局与成功回合返回前只完成快速排队，不等待 AI；协调器以 `gameId + jobId` 去重，客户端 ensure/polling 只负责崩溃恢复和结果观测。

## 当前生产闭环

```text
成功玩家回合
  → PendingNarrativeJob（含 ObjectiveTransition + 强制节拍 ≤8）
  → generatePendingScene
  →（可选）world-evolution：EvolutionNeed → proposal → 审批 → 铸 ID → 预览状态
  → SceneGenerationContext（最小权限、当前合法候选、焦点 NPC 隔离上下文）
  → SceneSource proposal（live 或 deterministic fallback）
  → approveScenePerformance
  → 单次 scene CAS 原子写回：已批准世界演化 + ready scene + choice registry + candidate events
  → GameSessionView
```

## 已冻结约束

- SceneSource 只返回表演 proposal，不能返回可直接落库的 ready state。
- **一次场景表演调用**：每个 ready 场景只调用一次 live 场景表演源；不再有 director/writer/npc 三次独立请求管线。
- **世界演化是按需的可选调用**：仅当 `EvolutionNeed.kind !== "none"`（幕推进/节奏/终局对）才触发；正常对话回合不调用演化源。
- **候选不足恢复**：若真实可执行候选少于两个，生成编排可额外申请 `scene_candidate_shortage` 节奏演化；已有交谈/移动入口时只补探索钩子，完全无入口时才在预算/可达性边界内补 NPC，并按需补地点，然后重建上下文。仍不足则返回 unavailable，不把无内容的 explore 当作合法候选。
- 对话场景绑定一个在场焦点 NPC，并提出两个语义不同的 TalkAction；其他场景从服务端给出的合法候选 ID 中选择两个不同 Action。
- `ObjectiveTransition.mode === advanced_act` 时叙事事件仍记录为非对话的任务交接；上一轮带 `player_utterance` 时焦点保持在原 NPC，由其先回应本轮话语，新目标只作为权威行动入口出现。进入地点或点击 talk 只打开 ready 对话，不再为首次交谈额外提交一次 `ask` API。玩家主动点击旁 NPC 时仍保持普通 `ask` 语义。
- 已由一键 `move` 唯一确定的目的地走确定性即时落点场景，不等待 live source 或 live 世界演化；在 action 响应前仍用移动后的权威地点、目标、候选和同一审批/CAS 同步写回，避免非决策等待。
- 两个已批准选择若都指向同一在场 NPC 的 TalkAction，即使触发事件是 travel/battle，也投影为该 NPC 的焦点对白；底栏只保留一个“与 NPC 交谈”主线入口，回答分支只在对话框显示。
- live source 只能选择服务端候选 ID，不能发明任意 `actionKey`、实体 ID、事实 ID 或规则结果。
- 审批器逐字段重建 scene/event/choice；生成对象原引用不能直接持久化。
- 服务器根据 post-writeback revision 铸造 opaque `choiceToken`；客户端场景不含 `actionKey`、registry、候选 effect、隐藏事实或 AI diagnostics。
- ready scene、choice registry、candidate event pool 与已批准世界演化同一次 scene CAS 写回；行动消费时再次验证当前 scene、revision 与规则合法性。
- scene CAS 与序幕确认并发时，repository 单调保留已确认的 `prologueShown=true`；确认接口对 stale revision 读取新快照后有限重试。
- AI/fixture 失败使用确定性 fallback，fallback 也经过同一 proposal → approval → write-back 链。
- active battle、ending 或候选不足时不伪造普通场景选择。
- active battle 采用规则 fast path：不创建 pending 场景、不调用 scene source；只有 battle_resolved 等终结事件进入叙事场景编排。

## 强制节拍与目标链接

- 每个 ready 场景以**分段旁白**呈现；每一段必须对应服务端下发的强制节拍 ID（`player_utterance` / `item_obtained` / `fact_discovered` / `quest_progress` / `quest_advanced` / `battle_started` / `battle_round` / `battle_resolved` / `entity_introduced`），数量 ≤8，可另附一个 `atmosphere` 段且必须置于最后。
- `objectiveLink` 必须与权威 `ObjectiveTransition.after` 一致（无 after 目标时为 null）；目标在本回合推进时，必须产出 `quest_advanced` 段命名新目标相关的已批准实体。
- 当玩家对焦点 NPC 提交话语（`job.utterance`）时，表演契约必须返回该 NPC 的台词并列出它应答的 `player_utterance` 节拍；缺失应答使提案非法并触发确定性 fallback。玩家界面保留该 NPC 的会话焦点：pending 时短暂遮蔽，ready 后先显示这句回应，不会直接把玩家抛回场景。
- `npcLine.text` 的输出边界是 NPC 第一人称直接台词：不得带 NPC 名称、动作或“说道/答道”等叙述性包装。审批写回和 read model 会再次归一化，以兼容历史场景。
- 确定性 fallback 会读取 `job.utterance`、焦点 NPC 关系档位和当前目标，生成带具体承接对象的回应；通用“我知道了/好的/嗯”会被 live source 判为无上下文并回退。
- 承接玩家原话时，NPC 以自己的口吻概括并回答，不得把整段玩家输入包进“你刚才问的‘……’”再反问。确定性 fallback 必须输出角色相关的可核对线索或明确下一步。
- 焦点 NPC 的开场、正式回应与终局追问至少两句：先回应，再补充线索、保留或下一步。该质量门槛由审批器执行；live source 即使返回单句，也会整场回退为角色化的确定性表演。

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
- `src/game/application/sceneGenerationContext.ts` — 最小权限上下文与合法候选、强制节拍、目标链接实体。
- `src/game/application/focusNpcContext.ts` — 焦点 NPC 隔离记忆与关系政策投影。
- `src/game/application/deterministicSceneSource.ts` — 离线 fallback proposal。
- `src/game/application/gameSessionView.ts` — 投影焦点能力，并修复旧存档中与权威 talk 目标冲突的过期焦点。
- `src/game/application/approveAndWriteScene.ts` — 场景表演审批与写回。
- `src/game/application/generatePendingScene.ts` — 生成编排与原子 write-back。
- `src/game/application/evolveWorld.ts` / `worldEvolutionSource.ts` — 可选世界演化编排与 port。
- `src/game/gameplay/rpg/narrativeContext/` — `buildOutcomeBeats` / `deriveObjectiveTransition` / `npcResponsePolicy`。
- `src/game/application/server/ai/liveScenePerformanceSource.ts` / `liveWorldEvolutionSource.ts` / `sourceFactory.ts`。

## 验收重点

- generated/fallback 场景各有两个 proposal、两个不同 token，scene JSON 无 `actionKey`。
- 分段旁白逐段命中强制节拍 ID；`objectiveLink` 与 HUD 当前目标一致；焦点 NPC 台词应答当前 `player_utterance`。
- NPC 台词只保留直接对白正文，不能以“邵叔如实答道：……”形式把舞台说明混入气泡；旧存档投影也必须满足同一断言。
- registry 的 `basedOnRevision` 等于 scene 写回后的 revision。
- tampered、stale、重复 token 零写入。
- live source 越权引用或失败不会绕过审批，也不会阻塞可完成的离线旅程。

## 历史说明

早期 dated 文档中的三角色 pipeline、版本化接口名和旧 scene adapter 只作历史记录。当前生产事实以本页列出的 neutral application/server 文件为准。
