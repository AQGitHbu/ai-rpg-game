# Agent 文档索引

## 使用方式

- 新任务开始时，先按根 `AGENTS.md` 判断是设计、代码还是共享基础设施任务。
- `策划文档/` 记录玩家可见规则；`agent/` 记录实现现状；`superpowers/` 是过程资料。
- 当前索引尚未包含玩法系统；第一个 RPG Spec 确认后，先创建对应最小 agent 文档再实现。

## 当前索引

| 系统 | Agent 文档 | 策划参考 | 状态 |
|---|---|---|---|
| 共享基础设施 | `共同规范/共享模块开发流程.md` | `共同规范/共享模块目录.json` | 仅按触发条件读取 |
| 项目脚手架 | `agent/项目脚手架.md` | — | 已建立 |
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | Phase 13 已实现（implemented）：NPC 关系与知识演化（好感度、语气分类、交互记忆）；唯一阶段 Plan：`superpowers/plans/2026-07-31-mvp-phase-13-npc-relationship-knowledge-evolution.md` |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | Phase 4C 已实现：创建、恢复、固定行动、探索、物品、战斗与双结局 + 真实 AI 动态开局（`AI_OUTPUT_FORMAT` 结构化输出，失败安全 fallback，phase4c 离线 fixture 集为主回归） |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：observe / talk / investigate / move / take_item / battle intents |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：移动、任务解锁、obtain_item / defeat_enemy objective 与 outcome |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；背包界面已重构（2026-07-30）：四分类页签 + 图标网格 + 详情，展示元数据缺省推导；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现确定性 boss 回合战与双结局；Phase 9 已实现：场景化战斗视窗（BattleArena + BattleActionRail），不改规则或 AI |
| 地图与地点冒险 | `agent/地图与地点冒险.md` | `策划文档/AI生成RPG_MVP.md` | Phase 7 地图/地点主循环、Phase 8 非战斗 HUD/视窗/行动栏/详情/对话层、响应式全屏地图 HUD 细化均已实现；Phase 10 narrative 仅在进入地点后显示，地图始终为入口；town 层已接入主循环（map→town→scene 三层导航，2026-07-31）；叙事生成 pending 时以模态覆盖当前界面（2026-08-06）；序幕 ack 不受初始 narrative pending 阻塞（2026-08-06）；ready 对话仍需地图→地点→NPC 热点，fallback 对话投影固定双选项（2026-08-06） |
| 运行时 AI 导演与场景表演 | `agent/运行时AI导演与场景表演.md` | `策划文档/AI生成RPG_MVP.md` | Phase 14 P0 已实现：单场景单原子事件、对白回应 choice、对白分支预生成后即时消费、场景独占展示；调查/物品/战斗事件级懒生成；契约 `runtime-narrative-v3`；异常任务收敛 fallback/idle，初始场景 30 秒快速失败、stale 有界重试、pending UI 显示 3 阶段进度，fallback 对话绑定焦点 NPC 并提供双选项（2026-08-06）；无生图 |
| NPC 对话驱动叙事场景触发 | `agent/NPC对话驱动叙事场景触发.md` | `策划文档/AI生成RPG_MVP.md` | Phase 14 已实现：固定玩家口吻双选项、对白分支即时消费、无预生成分支时写入 `narrative_dialogue_choice` 并进入下一次原子生成；自由输入仍经纯规则分类与闲聊降级 |
| NPC 关系与知识演化 | — | `superpowers/specs/2026-07-31-npc-relationship-knowledge-evolution-design.md` | Phase 13 已实现（2026-08-01）：单维度好感度（affinity）、五档关系（hostile/cold/neutral/friendly/trusted）；固定选项经 `resolveAction` 计算关系变化，自由输入经 `classifyDialogueTone` 纯规则语气分类后写入；NPC 演员注入 `relationshipTier`/`relationshipAffinity`/`relationshipSummary` 调整台词；`reconcileStoryMemory` 从 `npc_met.interactionKind` 推导 `lastInteractionSummary`；旧存档零迁移 |
| 剧情连续性与结构化记忆 | `agent/剧情连续性与结构化记忆.md` | `策划文档/AI生成RPG_MVP.md` | Phase 11 已实现：规则事件归约有界记忆、主线节奏约束、最小权限连续性上下文与离线 replay；2026-07-31 审计修复后真实 15 调用 journey（一次可恢复 writer 重试）与即时 replay 均通过 |
| 蓝图动态化 | `agent/蓝图动态化.md` | `策划文档/AI生成RPG_MVP.md` §4 | BudgetPolicy 时长档位驱动、主线幕数可变、运行时导演提议地点/NPC/事件级事实物品敌人，经闸门审批后 CAS 持久化；契约 scenario-dynamic-v2 / runtime-narrative-v3 |
| 无 AI 试玩验收 | `agent/无AI试玩验收.md` | `superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md` | 已实现：属性/模板叙事、开发环境清档、成功/失败手工试玩路线；开发开局可使用 Phase 10 固定离线旅程基线或 7 题材离线基线（2026-08-04 扩展） |
| AI 环境 | `agent/AI环境.md` | `.env.example` | 独立环境契约已建立；Phase 4B/4C 已实现开局 AI；Phase 10 已复用同一 transport/config，以 prompt-only JSON 运行 director / writer / npc 三个独立请求，并以 `RUN_REAL_AI_JOURNEY=1` 门禁完整真实认证；`GAME_DB_PATH` 仍为 server-only |
| 小镇程序化生成 | `agent/小镇程序化生成.md`、`agent/小镇生成Demo记录.md` | `设想/AI驱动RPG_大地图-小镇地图-场景与小镇生成方案_v0.1.md` | 确定性生成器 + /town-demo SVG 演示 + 生成质量修复 + AI 俯视贴图试验（spike）已实现；town 层已接入游戏主循环（S1–S8，2026-07-31）：地点分级、懒生成（离线同步/AI ensure）、plan+seed 存档与 read model 重建、`town-plan-v1` AI 契约、语义句子入叙事上下文；正式生图管线未实现 |
| 日志与追踪 | `agent/日志与追踪.md` | `operations/logging.md` | RPG 保留同步兼容 facade，HTTP/use-case/AI 后台链路统一 trace，通用脱敏/截断/独立 SQLite/查询/JSONL fallback 由 `@ai-game/logging` 提供；默认 `data/logs.db`，提供健康检查、查询和分层保留命令（2026-08-01） |
| AI 内容质量评估 | `agent/AI内容质量评估.md` | `策划文档/AI内容质量评估标准.md` | Task 8–11 已实现（2026-08-01）：三采集点采集通道（STORY_EVAL_CAPTURE 装配）、长故事评估旅程、离线 analyze 与三段 judge 脚本；量表 v2 与实现事实文档已落盘；v2 case/strategy 矩阵接线由 Task 13 完成；2026-08-05 增加 matrix/scene checkpoint、judge 增量缓存与分层验证入口 |

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
