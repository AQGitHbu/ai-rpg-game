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
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | 动态具象化 MVP 已实现并收口：开局切片 + 可选世界演化 + 一次场景表演调用、类型化强制节拍与目标链接、确定性城镇层；六个 `/api/game/**` route、单次 `performTurn`/规则 CAS 与独立 scene CAS；无需玩家决策的 pending 立即后台排队且序幕静默预生成（2026-08-13）；短篇/中篇正式支持；当前 Plan：`superpowers/plans/2026-08-11-dynamic-story-materialization-and-contextual-narrative.md` |
| 生产链边界 | `agent/当前开发阶段.md` | — | 只允许无版本后缀的生产命名；旧 route、旧 application/UI 链、兼容 facade、类型隔离和旧存档迁移均不存在。历史文档只作决策记录 |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | 创建/恢复、选择驱动推进、探索、物品、战斗、分支和多结局可完整离线游玩；AI 失败走确定性 fallback |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | 固定 choiceToken 与 NPC 自定义输入统一进入 `performTurn`；Action union 只保留有规则实现的 action，已移除无推进作用的 rest，成功回合单次 StateCommit/CAS |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：移动、调查、任务解锁、obtain_item / defeat_enemy objective 与 outcome；探索/调查入口按当前地点事实与实体投影（`hasExplorableContent`，2026-08-12） |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；背包界面已重构（2026-07-30）：四分类页签 + 图标网格 + 详情，展示元数据缺省推导；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | 已实现规则拥有五项战斗属性、1–2 普通敌人/Boss 遭遇、速度队列、多玩家单位接口、目标绑定 opaque controls、active fast path 与多单位战斗视图 |
| 地图与地点冒险 | `agent/地图与地点冒险.md` | `策划文档/AI生成RPG_MVP.md` | Phase 7 地图/地点主循环、Phase 8 非战斗 HUD/视窗/行动栏/详情/对话层、响应式全屏地图 HUD 细化均已实现；Phase 10 narrative 仅在进入地点后显示，地图始终为入口；town 层已接入主循环（map→town→scene 三层导航，2026-07-31）；序幕阅读期间静默预生成且确认不再启动 AI，普通 pending 不以全屏模态打断（2026-08-13）；TownView 对旧存档的在场 NPC/slot 失同步提供只读补偿（2026-08-12）；明确 talk 行动首击即提交，NPC 卡片保持只查看（2026-08-13）；fallback 对话投影固定双选项；无真实行动时显示异常恢复提示（2026-08-13） |
| 运行时 AI 导演与场景表演 | `agent/运行时AI导演与场景表演.md` | `策划文档/AI生成RPG_MVP.md` | SceneSource 只提案；每次 ready 场景一次场景表演调用，分段旁白逐段对应强制节拍、`objectiveLink` 与 HUD 目标一致、焦点 NPC 只收隔离记忆；pending 写入后立即后台去重排队，客户端 ensure 只作恢复；候选不足先受控演化；审批后同一次叙事 CAS 原子持久化世界演化、ready scene、ApprovedChoice registry 与候选池，并单调保留序幕确认（2026-08-13） |
| NPC 对话驱动叙事场景触发 | `agent/NPC对话驱动叙事场景触发.md` | `策划文档/AI生成RPG_MVP.md` | 焦点 NPC 始终提供两个固定选择与一个自定义输入；两者统一经 `/api/game/actions` → `performTurn`，浏览器逐次 UUID，均记录回合并创建 pending job；未 ready 的明确 talk 行动首击即提交并立即后台生成（2026-08-13） |
| NPC 关系与知识演化 | — | `superpowers/specs/2026-07-31-npc-relationship-knowledge-evolution-design.md` | Phase 13 已实现（2026-08-01）：单维度好感度（affinity）、五档关系（hostile/cold/neutral/friendly/trusted）；固定选项经 `resolveAction` 计算关系变化，自由输入经 `classifyDialogueTone` 纯规则语气分类后写入；NPC 演员注入 `relationshipTier`/`relationshipAffinity`/`relationshipSummary` 调整台词；`reconcileStoryMemory` 从 `npc_met.interactionKind` 推导 `lastInteractionSummary`；旧存档零迁移 |
| 剧情连续性与结构化记忆 | `agent/剧情连续性与结构化记忆.md` | `策划文档/AI生成RPG_MVP.md` | 有界规则记忆、最小权限上下文与离线 replay 已实现；短篇/中篇正式支持，启用长篇/开放式前须另立 segmented ledger Spec/Plan |
| 世界动态具象化 | `agent/世界动态具象化.md` | `策划文档/AI生成RPG_MVP.md` §4–§5 | 开局只生成可完成切片（1 地点/1 NPC/1 主线 + 契约 + 序幕 + 预算），后续实体只经运行时世界演化按需具象化（EvolutionNeed → 提案 → 审批 → 铸 ID → 预览状态）；终幕按 trust/doubt 抽象方向铸造互斥结局对；无预生成蓝图/隐藏任务图 |
| 无 AI 试玩验收 | `agent/无AI试玩验收.md` | `superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md` | 已实现：属性/模板叙事、开发环境清档、成功/失败手工试玩路线；开发开局可使用 Phase 10 固定离线旅程基线或 7 题材离线基线（2026-08-04 扩展） |
| AI 环境 | `agent/AI环境.md` | `.env.example` | 独立环境契约已建立；Phase 4B/4C 已实现开局 AI；运行时只走开局切片 + 按需世界演化 + 每次场景一次表演调用（非 director/writer/npc 三次管线），并以 `RUN_REAL_AI_JOURNEY=1` 门禁完整真实认证；`GAME_DB_PATH` 仍为 server-only |
| 小镇程序化生成 | `agent/小镇程序化生成.md` | `策划文档/AI生成RPG_MVP.md` §5 | 确定性城镇层已接入主循环（map→town→scene 三层导航）：几何与剧情建筑 slot 开局预分配、运行时 NPC 绑定、`TownRuntimeState` seed 确定性重建；`TownView` 只暴露快照与已绑定建筑，无 `/api/game/town/ensure` 路由、无 AI 生图 |
| 视觉资产与 AI 生图参考 | `AI生图资产制作参考.md` | — | 当前运行时无 AI 生图；已盘点大地图、地点、角色、NPC、物品、敌人、战斗序列帧、场景、建筑和结局等图片位，并记录 Prompt、一致性、缓存、切割/atlas 与降级规则；小镇当前只复用静态历史预设图 |
| 日志与追踪 | `agent/日志与追踪.md` | `operations/logging.md` | RPG 保留同步兼容 facade，HTTP/use-case/AI 后台链路统一 trace，通用脱敏/截断/独立 SQLite/查询/JSONL fallback 由 `@ai-game/logging` 提供；默认 `data/logs.db`，提供健康检查、查询和分层保留命令（2026-08-01） |
| AI 内容质量评估 | `agent/AI内容质量评估.md` | `策划文档/AI内容质量评估标准.md` | Task 8–11 已实现（2026-08-01）：三采集点采集通道（STORY_EVAL_CAPTURE 装配）、长故事评估旅程、离线 analyze 与三段 judge 脚本；量表 v2 与实现事实文档已落盘；v2 case/strategy 矩阵接线由 Task 13 完成；2026-08-05 增加 matrix/scene checkpoint、judge 增量缓存与分层验证入口 |

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
