# Agent 文档索引

## 使用方式

- 新任务开始时，先按根 `AGENTS.md` 判断是设计、代码还是共享基础设施任务。
- `策划文档/` 记录玩家可见规则；`agent/` 记录实现现状；`superpowers/` 是过程资料。
- 当前生产实现只认无版本后缀的 canonical runtime；dated Spec/Plan 中的版本词是历史定位，不能据此恢复并行接口或兼容层。

## 当前索引

| 系统 | Agent 文档 | 策划参考 | 状态 |
|---|---|---|---|
| 共享基础设施 | `共同规范/共享模块开发流程.md` | `共同规范/共享模块目录.json` | 仅按触发条件读取 |
| 项目脚手架 | `agent/项目脚手架.md` | — | 已建立；提供 `branch:finish` 合并后 worktree/分支收尾入口；SQLite 仓储测试使用每进程独占的 OS 临时目录，兼容 Windows/Git Bash 管道运行 |
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | 2026-08-23 叙事上下文编译器已验收、已合入 main；2026-08-30 复核确认 v7 生产决策链使用 `compileDecisionNarrativeContext` 并附带无正文 manifest。唯一已完成 Plan 仍为 `superpowers/plans/2026-08-23-narrative-context-compiler.md` |
| 生产链边界 | `agent/当前开发阶段.md` | — | 只允许无版本后缀的生产命名；旧 route、旧 application/UI 链、兼容 facade、类型隔离和旧存档迁移均不存在。历史文档只作决策记录 |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | 创建/恢复、选择驱动推进、探索、物品、战斗、分支和多结局可由显式 offline fixture 完整游玩；生产 AI 失败显示 stable failure 并手动重试 |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | 固定 choiceToken 与 NPC 自定义输入统一进入 `performTurn`；Action union 只保留有规则实现的 action，已移除无推进作用的 rest，成功回合单次 StateCommit/CAS |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：移动、事实自动揭示、任务解锁、obtain_item / defeat_enemy objective 与 outcome；调查方式不再投影为玩家入口；移动和战斗边界消费正式 NPC 回合已经审批的 `PreparedContinuationState`，物品交换与回退导航由规则场景完成；缺失/失效 continuation 稳定失败且零写入，离线 fixture 仍可提供 deterministic replay |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；背包界面已重构（2026-07-30）：四分类页签 + 图标网格 + 详情，展示元数据缺省推导；城镇物品按建筑场景单归属投影，无 prepared step 时拾取由 rule-owned scene 在同一次 CAS 写回；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | 已实现规则拥有五项战斗属性、1–2 普通敌人/Boss 遭遇、速度队列、多玩家单位接口、目标绑定 opaque controls、active fast path 与多单位战斗视图；战斗开始/胜利交接消费已审批 prepared continuation，active rounds 纯规则且不创建 provider job；战斗切换独立全屏左右阵营场景，终幕 support/challenge 直接锁定结局方向；HP 为 0 的单位从当前战斗画面移除 |
| 地图与地点冒险 | `agent/地图与地点冒险.md` | `策划文档/AI生成RPG_MVP.md` | Phase 7 地图/地点主循环、Phase 8 非战斗 HUD/视窗/详情/对话层、响应式全屏地图 HUD 细化均已实现；Phase 10 narrative 仅在进入地点后显示，地图始终为入口；town 层已接入主循环（map→town→scene 三层导航，2026-07-31）；序幕阅读期间静默预生成，API/后台编排期间使用全屏模态锁定（2026-08-13）；普通建筑入口只导航、NPC 卡片打开预生成对话，事实目标建筑由服务端下发 arrivalChoiceToken 后在进入时自动规则揭示（2026-08-26），正式 NPC 回合由双选项/自定义输入提交；旁注侧栏点击后才显示建筑/NPC，不再有临时会面开发面板；城镇物品按建筑场景单归属投影，规则动作与 generated/fixture 场景分离；AI failure 锁定当前规则操作并显示重试提示，不自动生成剧情；新地点任务先 visit 再自动确认事实；地点场景不渲染调查按钮或底部行动栏，地图/NPC/热点/战斗面板承载交互；演化实体按释放游标逐步投影，未释放 NPC/物品/敌人不出现在地图或场景；交接场景保留旁注和地图动线（2026-08-25） |
| 运行时 AI 导演与场景表演 | `agent/运行时AI导演与场景表演.md` | `策划文档/AI生成RPG_MVP.md` | v7 生产链由单次 `NarrativeBundleSource` 提案当前 scene、可选 world delta 与 continuation graph；provider 触发白名单仅为 opening 与 NPC fixed/free-text，移动/战斗边界不再调用 provider；规则场景与 bundle 步骤在一次状态 CAS 中消费；runtime state 使用 ready/provider_pending/provider_failed 判别联合，failed 仅同 job 手动 retry；五类 AI 角色统一经 `RpgAiClient`，玩家决策的 `narrative_bundle` Prompt 使用 context compiler 并附带无正文 manifest，显式 fixture 才使用 deterministic source |
| NPC 对话驱动叙事场景触发 | `agent/NPC对话驱动叙事场景触发.md` | `策划文档/AI生成RPG_MVP.md` | 普通焦点 NPC ready scene 提供两个固定选择与一个自定义输入；对话收尾同一次 scene 生成旧 NPC 最后一段直接对白，并把下一步作为服务端批准的 prepared/travel 入口，不生成可重复提交的 handoff action；普通输入统一经 `/api/game/actions` → `performTurn`，浏览器逐次 UUID，均记录回合并创建 pending job；建筑与 talk 入口不提交，只有对话选项/自定义输入提交并立即后台生成（2026-08-13）；提交后保留对话框并显示内联 loading，waiting 使用提交前的本页对话快照；ready 后清理临时快照并显示新台词与下一组选项（2026-08-22）；NPC 回应只保留第一人称直接台词，必须承接当前话语或情境；选项由当前主线、NPC 可说事实卡、结构化对话历史和本轮事实引用驱动，不再按 NPC 角色名或对白关键词分类；pending 上下文保存上一句 NPC 台词、玩家选项和结构化主题，live AI 生成自然措辞但服务端锁定 candidateId/action，连续至少两轮后才完成 `talk_to_npc`；同幕后续 NPC/证物/敌人可以预生成但按释放游标逐步进入场景，抵达 NPC 必须承接已完成的调查事实；幕交接保留原场景与原 NPC 的回应，read model 可修复旧存档的冲突焦点（2026-08-18）；2026-08-18：非目标/交接 NPC 零回合闲聊化，talk 入口仅属权威目标；2026-08-24：同地点 NPC 交接只保留旧 NPC 最后一句并以本地关闭/地图 travel 入口承接，不重复提交回合 |
| NPC 关系与知识演化 | — | `superpowers/specs/2026-07-31-npc-relationship-knowledge-evolution-design.md` | Phase 13 已实现（2026-08-01）：单维度好感度（affinity）、五档关系（hostile/cold/neutral/friendly/trusted）；固定选项经 `resolveAction` 计算关系变化，自由输入经 `classifyDialogueTone` 纯规则语气分类后写入；NPC 演员注入 `relationshipTier`/`relationshipAffinity`/`relationshipSummary` 调整台词；`reconcileStoryMemory` 从 `npc_met.interactionKind` 推导 `lastInteractionSummary`；旧存档零迁移 |
| 剧情连续性与结构化记忆 | `agent/剧情连续性与结构化记忆.md` | `策划文档/AI生成RPG_MVP.md` | 有界规则记忆、最小权限上下文与离线 replay 已实现；中篇新幕中的事实/地点/NPC/物品/敌人按题材剧本与结构变体生成目标链，StoryState 释放游标控制玩家可见节奏；当前 v7 生产决策链通过 `compileDecisionNarrativeContext` 共享 `NarrativeContextBlock` IR、固定 authority/slot 顺序、mandatory 溢出保留与 optional 预算裁剪，但 opening/intent 及 Entity/Episode/Living Outline 仍未迁入；短篇/中篇正式支持，启用长篇/开放式前须另立 segmented ledger Spec/Plan |
| 世界动态具象化 | `agent/世界动态具象化.md` | `策划文档/AI生成RPG_MVP.md` §4–§5 | 开局只生成可完成切片（1 地点/1 NPC/1 主线 + 契约 + 序幕 + 预算），后续实体只经运行时世界演化按需具象化（EvolutionNeed → 提案 → 审批 → 铸 ID → 预览状态）；同幕完整结构可预先持久化，但通过 StoryState.reveal 逐步释放；生产 source 失败零演化写入并进入 failed；live prompt 按需求条件化 `nextMainQuest`/`endingPair` 字段，避免下一幕误带结局对；deterministic 剧本仅供显式 offline fixture；城镇调查点与离镇场景按空间层级区分；动态地点提案以 placement 区分世界地图地点与当前城镇建筑，town_building 复用剧情 slot 不铸造地图节点（2026-08-22）；终幕按 trust/doubt 抽象方向铸造互斥结局对；无预生成蓝图/隐藏任务图；world 演化解析/审批失败自动最多一次内容修复（`evolveWorld` 两轮循环，`WorldEvolutionContentRepair.reason` 四种 + `approvalCode`），新地点与主线目标 NPC 空间一致由审批层硬拒绝（`unreachable_objective/npc_not_at_new_location`，2026-08-22）；2026-08-23 起 world Prompt 统一经 `compileWorldNarrativeContext` 编译，只投影公开事实、过滤后的 recent beats 与已批准实体索引，不投影 eventLedger 或私密事实正文；调查方式 `label/hint` 可复用事实关键词，仅完整复制事实正文算泄漏 |
| 无 AI 试玩验收 | `agent/无AI试玩验收.md` | `superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md` | 已实现：属性/模板叙事、开发环境清档、成功/失败手工试玩路线；开发开局可使用 Phase 10 固定离线旅程基线或 7 题材离线基线（2026-08-04 扩展） |
| AI 环境 | `agent/AI环境.md` | `.env.example` | 独立环境契约已建立；开局由 live source 生成，失败返回 `AI_GENERATION_FAILED + failureKind`；服务端以开局指纹与近期历史做相似度校验并重试；运行时只走开局切片 + 按需世界演化 + 每次场景一次表演调用（非 director/writer/npc 三次管线），并以 smoke 门禁完整真实认证；`GAME_DB_PATH` 仍为 server-only |
| 小镇程序化生成 | `agent/小镇程序化生成.md` | `策划文档/AI生成RPG_MVP.md` §5 | 确定性城镇层已接入主循环（map→town→scene 三层导航）：几何与剧情建筑 slot 开局预分配、运行时 NPC 绑定、开局候选建筑名写入展示名、`TownRuntimeState` seed 确定性重建；`TownView` 只暴露快照与可进入建筑，`isCurrentFocus` 只标记真实主线焦点，满槽目标通过建筑入口可达，不再显示临时会面开发面板（2026-08-13）；无 `/api/game/town/ensure` 路由、无 AI 生图 |
| 视觉资产与 AI 生图参考 | `AI生图资产制作参考.md` | — | 当前运行时无 AI 生图；已盘点大地图、地点、角色、NPC、物品、敌人、战斗序列帧、场景、建筑和结局等图片位，并记录 Prompt、一致性、缓存、切割/atlas 与降级规则；小镇当前只复用静态历史预设图 |
| 日志与追踪 | `agent/日志与追踪.md` | `operations/logging.md` | RPG 保留同步兼容 facade，HTTP/use-case/AI 后台链路统一 trace，通用脱敏/截断/独立 SQLite/查询/JSONL fallback 由 `@ai-game/logging` 提供；默认 `data/logs.db`，提供健康检查、查询和分层保留命令（2026-08-01）；AI 文本审计日志独立于普通诊断日志，AI 文本默认完整记录，游戏 API 由 `GAME_API_AUDIT` 控制并默认轮询 compact，查询使用 `npm run ai-text-audit` CLI（2026-08-20）；审计以 `context.retry.origin/mechanism/attempt/reason` 区分 normal/manual_failed_job 与 initial/transport/content_repair，普通 ensure 与 `{ "retry": true }` 观测分离，历史 `repair` 只读归一为 `legacy_unknown`（2026-08-22） |
| AI 文本审计与质量审核 | `agent/AI文本审计.md` | `operations/logging.md` | AI 文本审计已实现（2026-08-20）：默认完整记录 opening/intent/world/scene provider 调用和最终 story_text；六个 API route 由 `GAME_API_AUDIT` 独立控制，默认轮询 compact、业务 API full；prepared/rule 消费不产生 provider 审计调用；`context.retry.origin/mechanism/attempt/reason` 区分首次/传输/内容修复/手动失败重试，`ai_call.attempt` 与内容修复 attempt 语义分离，历史 `repair` 只读归一为 `legacy_unknown`；2026-08-23 起仅 scene/world 附带 narrative context manifest，且 manifest 只含元数据/预算，不含 Prompt 正文副本 |

## 2026-08-20 调查选择场景 canonical 更新

- 探索与任务推进：有 2–3 个已审批 `investigationApproaches` 时只为当前 `discover_fact` 目标投影独立 opaque token；无方式事实在移动抵达或 NPC 交接的规则边界自动写入一次 `fact_discovered`，调查结果记录 evidence quality 与额外 tension；相关 canonical 文件为 `src/game/application/buildChoiceMap.ts`、`src/game/application/gameSessionView.ts`、`src/game/gameplay/rpg/ruleEngine/` 和 `src/game/application/testing/investigationChoiceJourney.test.ts`。
- 地图与地点冒险：当前 read model 不再投影调查方式或底部行动栏；历史 investigate 只保留规则兼容，事实由规则边界自动确认。相关 canonical 文件为 `src/components/LocationSceneScreen.tsx`、`src/game/application/buildChoiceMap.ts` 和 `src/game/application/testing/investigationChoiceJourney.test.ts`。

## 2026-08-20 剧情文本来源标记

- `GameSessionView` 只投影 `generated` 场景正文；AI 失败不生成场景正文，而是投影 `narrativeGeneration = { status: "failed", jobKey, failureKind }`。显式 offline fixture 的 deterministic 文本不代表生产 AI 成功。

## 2026-08-22 NPC 交接对白与底部入口收口

- 地图与地点冒险：NPC 交接到移动目标时，旧 NPC 对话框展示当前权威 travel choice 的玩家文案作为最后一句对白，不再显示误导性的“知道了”；地点场景不渲染底部行动栏，地图/NPC 卡片/场景热点/战斗面板分别承载入口。canonical 文件为 `src/components/LocationSceneScreen.tsx` 与 `src/components/AdventureGameShell.test.tsx`。

## 2026-08-24 prepared continuation 架构收口

- provider 触发白名单收口为 `opening`、`npc_fixed_choice`、`npc_free_text`；移动、调查、物品、回退导航、battle start/resolution 和 active battle 不得由生产编排重新调用 scene/world/intent provider。
- 正式 NPC 场景的 accepted proposal 同时审批当前 scene 与 `PreparedContinuationState`。该状态是服务端维护的有向无环图，战斗结果等兄弟分支通过消费组互斥；调查方式不再生成新分支，旧调查 step 仅兼容历史状态。
- ready runtime 只有 `currentScene`、opaque choice registry 和可选 prepared continuation；pending/failed 只持有白名单 provider job。旧 v5 存档按 `UNSUPPORTED_RECORD` 处理，开发环境需清档重开。

## 2026-08-26 NPC 抵达对白恢复

- NPC 对话驱动叙事场景触发：未消费的 AI 抵达对白与批准动作由 ready narrative 的 `dialogueResume` 跨 rule-owned travel 保留，返回目标地点时按当前 revision 恢复；旧存档缺少该缓存时，点击目标 NPC 直接补发权威 `ask` 生成，不显示空白对白或默认 support/challenge 选项。移动回合触发自动调查并推进目标时，若没有精确 prepared continuation，则保留规则场景继续推进，不返回 continuation missing。
- 地图与地点冒险：`town_building` 复用城镇 `currentLocationId`，不能依赖 visit/move 抵达来触发事实自动揭示；当前 discover_fact 的下一步若是建筑 NPC，服务端为目标建筑投影 opaque `arrivalChoiceToken`，进入时提交一次规则型 explore，揭示事实后再按释放游标显示 NPC；普通建筑入口保持纯 UI 导航。
- 运行时 AI 导演与场景表演：跨幕 prepared continuation 递归进入下一主线任务后，descriptor 的任务身份、目标序号、消费组和抵达 NPC 均以 `activeQuest` 为准，避免 AI 返回成功但审批因 `invalid_prepared_continuation` 将 NPC 回合标为失败。
- 世界动态具象化：满槽城镇的建筑容量与 `town_building`/`world` 选择、同批新 NPC 的 `locationRef` 约束已进入 world prompt，避免连续审批拒绝后错误显示通用 NPC AI 失败（2026-08-26）。
- 探索与任务推进：移动回合先推进故事揭示游标，再自动确认下一事实，避免访问地点后没有可操作项（2026-08-26）。
- 世界动态具象化：下一幕主线世界地点必须从玩家当前地点接入，避免新地点虽已物化却只能回退绕行才能抵达（2026-08-26）。
- 世界动态具象化：下一幕主线物品/敌人也必须与新地点共址，避免任务目标实体留在上一地点而场景无操作项（2026-08-26）。

## 2026-08-26 NPC 台词用途与对话完成事实收口

- NPC 对话驱动叙事场景触发：场景中的 NPC 台词新增 `speechPurpose=focus|ambient`；API 生成来源与台词用途不再混为一谈。新目标若只有上一场景的 generated ambient 闲聊，读模型不展示该台词或默认 support/challenge，只下发单一权威 `ask`，点击后等待正式 provider 场景。旧存档缺字段时，仅 `scene.npcLine.npcId` 兼容推断为 focus，无需清档。
- 剧情连续性与结构化记忆：权威 `ask` 初始化目标 NPC 的零轮未完成会话，两次正式回应后才完成 `talk_to_npc` 并写入 `npc_dialogue_completed`。规则推进始终携带当前会话，`met` 仅代表接触事实，旧 NPC 已完成会话和新 NPC 刚写入的 `met` 都不能让下一段对话跳步。

## 2026-08-26 真实游戏禁止 fallback

- 游戏设计原则/运行时 AI：生产环境由 AI 承担的剧情、旁白、NPC 台词和选项只接受已审批 `generated`；传输、解析或审批失败进入 `provider_failed` 并重试同一 job，禁止 deterministic/fixture/default 文案接管。`mode="ai"` 的 read model 拒绝 fixture scene，也不再即时合成 NPC 问候或目标提醒；规则型移动、物品和战斗反馈仍可为 `source="rule"`，但不能冒充 AI 剧情。

## 2026-08-28 决策边界叙事生成包架构

- 运行时 AI 导演与场景表演：AI 触发点严格收口为 `initialization`（开局）、`narrative_choice`（正式剧情选项）和 `npc_free_text`（焦点 NPC 自定义输入）。一次逻辑调用通过 `NarrativeBundleSource.generate` 返回原子生成包提案（`worldDelta` + `currentScene` + `continuationScenes` + `terminal`），经 `approveNarrativeBundle` 原子审批后单次 CAS 写回。
- 运行时 AI 导演与场景表演：开局初始化（Task 6）直接编译为 `ready` 叙事 bundle，不再创建 `provider_pending` 场景和后续 `ensure` 调用。`OpeningGenerationCandidate` 可选携带 `firstScene`（焦点 NPC 台词、旁白、恰好两个候选选项），编译时直接生成 `ready` 的 `NarrativeRuntimeState`。
- 运行时 AI 导演与场景表演：`generatePendingNarrativeBundle`（Task 7）是 pending job 的原子生成编排器，调用 `NarrativeBundleSource` 一次 → `approveNarrativeBundle` 一次 → 单次 CAS 提交世界增量+场景+选项注册表+bundle。审批失败时不进行部分写入，记录 `provider_failed` 并保留同一 `jobId`。`runBoundedAttempts` 最多 4 次；后续尝试携带 `contentRepair` 的稳定拒绝码与细分原因，覆盖同包多个实体逐个改名的修复链。
- 运行时 AI 导演与场景表演：composition root 已切换到统一 `NarrativeBundleSource`，不再为 `ensure` 路径注入独立的 scene/world/intent source。
- 剧情连续性与结构化记忆：`narrativeBundleTriggerKey` 使用闭包语法（`move:<locId>` 等），描述符图最多 12 步、必须无环、所有可达叶必须终止于恰好两个选项的 `next_decision` 或 `ending`。

## 2026-08-29 v7 决策边界叙事捆绑包真机中篇回归

- 运行时 AI 导演与场景表演：`narrativeBundle` 是 v7 唯一生产续接图，`PreparedContinuationState` 退为离线 fixture 专用。提案拒绝原因与规则引擎 `detail` 现在回传给后续内容修复；同次世界增量的全部撞名会聚合进一个 detail。prompt 下发「已占用实体名称」、物品持有/地点状态，并要求 `continuationScenes` 与投影步骤一一对应；结局包会把 provider 多余的 terminal target、choices 和 continuation canonicalize 为规则唯一的 ending 形状，避免格式兼容问题卡住 `provider_failed`。
- 战斗与结局：终幕 support/challenge 立场改由 `src/game/gameplay/rpg/narrativeBundle/endingDecision.ts` 按 World/Story 状态铸造，经焦点 NPC 对话框下发；只要立场可提交，就算还有残留线索/候选事件也撤下必然零写入失败的「面对最终抉择」探索入口，结局对话不开放自由输入。
- 探索与任务推进：`give_item` 与移动/战斗一样必须消费 bundle 步骤，缺步零写入，读模型只在活跃 `give_item` 步骤存在时投影给予按钮；任务链空窗改为投影桥接目标（在场 NPC → 未到访地点 → 可探索内容）并同步下发可执行 token，HUD 不再出现「暂无线索」断档。
- 观感收口：地点旁注与地点描述不再复述同一氛围——展示层按小句比对字符重合度剔除旁注已表达的部分（`src/components/displayText.ts` 的 `removeCoveredClauses`），整段被覆盖时隐藏 caption。
- 观感收口：NPC 台词归一化新增剥掉台词前的整段括号舞台说明、整段 `‘…’` 单弯引号与对话分页残留的单侧引号（`src/game/domain/npcSpeech.ts`），成对句内引用不受影响；`mode="ai"` 读模型投影与审批写回共用同一函数。
- 验收事实：`codex/decision-boundary-narrative-bundle` 分支完成 Chrome 真实 AI 链路中篇通关（5 幕、第 26 回合、revision 57 达成结局「信任」）；审计中的 44 次 AI 调用全部归因于 initialization、玩家正式选择或 NPC 自定义输入，移动、拾取、战斗和结局展示没有触发调用。

## 2026-08-30 v7 捆绑包回合情境与内容闸门回归

- 运行时 AI 导演与场景表演：真机回归发现决策 prompt 只给世界快照（无当前位置/焦点 NPC/所选选项/上一场景/节拍清单），且审批只查结构不查内容，导致正式对话回合生成并持久化脱离情境的场景（旁白回到旧地点、`npcLine` 缺失、自创 `reflection` 节拍、选项与当前状态矛盾）。修复：决策情境现由 `compileDecisionNarrativeContext` 投影（含固定选项原文、逐字 `objectiveLink` 期望值、下一幕抵达场景骨架）；`approveNarrativeBundle` 新增当前场景内容闸门——强制节拍全覆盖（顺序不限、禁自创、至多一个置尾 atmosphere）、`player_utterance` 必须由焦点 NPC 应答、当前决策点与终点抵达步骤缺焦点/抵达 NPC 台词即拒（`dialogue_focus_line_missing`）、`objectiveLink` 必须镜像权威转换（`objective_link_mismatch`），拒因进入修复重试；节拍顺序不再作为拒因。
- 地图与地点冒险：NPC 对话收场改为引导下一动作的单选项。read model 在收场场景缺显式 `handoffAcknowledgement` 时确定性投影「告辞，{下一目标}」，任何存档不再渲染「知道了」纯确认按钮。曾尝试把该字段做成审批硬门，真机验证 provider 会把字段放错层级（根级 `unknown_keys`）或省略，硬门会耗尽 4 次尝试卡死玩家回合（`provider_failed`），故回退为读模型兜底、绝不阻塞主线。
- 验收事实：同分支浏览器中篇二次通关（5 幕、第 21 回合达成结局「承志而行」）；本轮 14 次 AI 调用全部归因于 initialization（1）、`narrative_choice`（11）或 `npc_free_text`（2），content_repair 为 0；移动、拾取、战斗、序幕确认与结局立场结算均未触发 provider。修复前的失败态（4 次尝试耗尽 → 「重试生成回应」）亦在真机出现过并被同一手动重试入口覆盖。
- 验收事实（收场修复后第三局）：又一中篇 5 幕通关至分歧结局「疑心自守」（第 25 回合、质疑线）；含战败→检查点恢复→重赛获胜的完整战斗回归。卡死的 `provider_failed` 回合经「重试生成回应」（同 jobId 的 manual_failed_job 重试）在新代码下救回，此后所有收场均渲染引导性单选项，全程无「知道了」。

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
