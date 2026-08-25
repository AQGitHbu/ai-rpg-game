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
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | 2026-08-23 叙事上下文编译器已实现、待验收；唯一 Plan 仍为 `superpowers/plans/2026-08-23-narrative-context-compiler.md`，目标分支 `codex/narrative-context-compiler`，worktree `narrative-context-compiler` |
| 生产链边界 | `agent/当前开发阶段.md` | — | 只允许无版本后缀的生产命名；旧 route、旧 application/UI 链、兼容 facade、类型隔离和旧存档迁移均不存在。历史文档只作决策记录 |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | 创建/恢复、选择驱动推进、探索、物品、战斗、分支和多结局可由显式 offline fixture 完整游玩；生产 AI 失败显示 stable failure 并手动重试 |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | 固定 choiceToken 与 NPC 自定义输入统一进入 `performTurn`；Action union 只保留有规则实现的 action，已移除无推进作用的 rest，成功回合单次 StateCommit/CAS |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：移动、事实自动揭示、任务解锁、obtain_item / defeat_enemy objective 与 outcome；调查方式不再投影为玩家入口；移动和战斗边界消费正式 NPC 回合已经审批的 `PreparedContinuationState`，物品交换与回退导航由规则场景完成；缺失/失效 continuation 稳定失败且零写入，离线 fixture 仍可提供 deterministic replay |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；背包界面已重构（2026-07-30）：四分类页签 + 图标网格 + 详情，展示元数据缺省推导；城镇物品按建筑场景单归属投影，无 prepared step 时拾取由 rule-owned scene 在同一次 CAS 写回；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | 已实现规则拥有五项战斗属性、1–2 普通敌人/Boss 遭遇、速度队列、多玩家单位接口、目标绑定 opaque controls、active fast path 与多单位战斗视图；战斗开始/胜利交接消费已审批 prepared continuation，active rounds 纯规则且不创建 provider job；战斗切换独立全屏左右阵营场景，终幕 support/challenge 直接锁定结局方向；HP 为 0 的单位从当前战斗画面移除 |
| 地图与地点冒险 | `agent/地图与地点冒险.md` | `策划文档/AI生成RPG_MVP.md` | Phase 7 地图/地点主循环、Phase 8 非战斗 HUD/视窗/详情/对话层、响应式全屏地图 HUD 细化均已实现；Phase 10 narrative 仅在进入地点后显示，地图始终为入口；town 层已接入主循环（map→town→scene 三层导航，2026-07-31）；序幕阅读期间静默预生成，API/后台编排期间使用全屏模态锁定（2026-08-13）；建筑入口只导航、NPC 卡片打开预生成对话，正式回合由双选项/自定义输入提交（2026-08-13）；旁注侧栏点击后才显示建筑/NPC，不再有临时会面开发面板；城镇物品按建筑场景单归属投影，规则动作与 generated/fixture 场景分离；AI failure 锁定当前规则操作并显示重试提示，不自动生成剧情；新地点任务先 visit 再自动确认事实；地点场景不渲染调查按钮或底部行动栏，地图/NPC/热点/战斗面板承载交互；演化实体按释放游标逐步投影，未释放 NPC/物品/敌人不出现在地图或场景；交接场景保留旁注和地图动线（2026-08-25） |
| 运行时 AI 导演与场景表演 | `agent/运行时AI导演与场景表演.md` | `策划文档/AI生成RPG_MVP.md` | SceneSource 只提案；生产 provider 触发白名单仅为 opening 与 NPC fixed/free-text；同一次正式 NPC 生成原子审批当前 scene 与 server-authored `PreparedContinuationState`，移动/战斗边界不再调用 provider，事实由规则自动确认；规则场景与 prepared 场景在一次状态 CAS 中完成；runtime state 使用 ready/provider_pending/provider_failed 判别联合，客户端对新 job 一次 ensure 后只 GET 观测，failed 仅同 job 手动 retry；四类 AI transport/内容修复审计仍统一经 `RpgAiClient`，2026-08-23 起 scene/world Prompt 使用 context compiler，显式 fixture 才使用 deterministic source |
| NPC 对话驱动叙事场景触发 | `agent/NPC对话驱动叙事场景触发.md` | `策划文档/AI生成RPG_MVP.md` | 普通焦点 NPC ready scene 提供两个固定选择与一个自定义输入；对话收尾同一次 scene 生成旧 NPC 最后一段直接对白，并把下一步作为服务端批准的 prepared/travel 入口，不生成可重复提交的 handoff action；普通输入统一经 `/api/game/actions` → `performTurn`，浏览器逐次 UUID，均记录回合并创建 pending job；建筑与 talk 入口不提交，只有对话选项/自定义输入提交并立即后台生成（2026-08-13）；提交后保留对话框并显示内联 loading，waiting 使用提交前的本页对话快照；ready 后清理临时快照并显示新台词与下一组选项（2026-08-22）；NPC 回应只保留第一人称直接台词，必须承接当前话语或情境；选项由当前主线、NPC 可说事实卡、结构化对话历史和本轮事实引用驱动，不再按 NPC 角色名或对白关键词分类；pending 上下文保存上一句 NPC 台词、玩家选项和结构化主题，live AI 生成自然措辞但服务端锁定 candidateId/action，连续至少两轮后才完成 `talk_to_npc`；同幕后续 NPC/证物/敌人可以预生成但按释放游标逐步进入场景，抵达 NPC 必须承接已完成的调查事实；幕交接保留原场景与原 NPC 的回应，read model 可修复旧存档的冲突焦点（2026-08-18）；2026-08-18：非目标/交接 NPC 零回合闲聊化，talk 入口仅属权威目标；2026-08-24：同地点 NPC 交接只保留旧 NPC 最后一句并以本地关闭/地图 travel 入口承接，不重复提交回合 |
| NPC 关系与知识演化 | — | `superpowers/specs/2026-07-31-npc-relationship-knowledge-evolution-design.md` | Phase 13 已实现（2026-08-01）：单维度好感度（affinity）、五档关系（hostile/cold/neutral/friendly/trusted）；固定选项经 `resolveAction` 计算关系变化，自由输入经 `classifyDialogueTone` 纯规则语气分类后写入；NPC 演员注入 `relationshipTier`/`relationshipAffinity`/`relationshipSummary` 调整台词；`reconcileStoryMemory` 从 `npc_met.interactionKind` 推导 `lastInteractionSummary`；旧存档零迁移 |
| 剧情连续性与结构化记忆 | `agent/剧情连续性与结构化记忆.md` | `策划文档/AI生成RPG_MVP.md` | 有界规则记忆、最小权限上下文与离线 replay 已实现；中篇新幕中的事实/地点/NPC/物品/敌人按题材剧本与结构变体生成目标链，StoryState 释放游标控制玩家可见节奏；2026-08-23 起 scene/world 共享 `NarrativeContextBlock` IR、固定 authority/slot 顺序、mandatory 溢出保留与 optional 预算裁剪，但 opening/intent 及 Entity/Episode/Living Outline 仍未迁入；短篇/中篇正式支持，启用长篇/开放式前须另立 segmented ledger Spec/Plan（题材化 deterministic fixture 剧本库、目标链结构变体、结局锚点池化） |
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

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
