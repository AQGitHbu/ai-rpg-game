# Agent 文档索引

## 使用方式

- 新任务开始时，先按根 `AGENTS.md` 判断是设计、代码还是共享基础设施任务。
- `策划文档/` 记录玩家可见规则；`agent/` 记录实现现状；`superpowers/` 是过程资料。
- 当前生产实现只认无版本后缀的 canonical runtime；dated Spec/Plan 中的版本词是历史定位，不能据此恢复并行接口或兼容层。

## 当前索引

| 系统 | Agent 文档 | 策划参考 | 状态 |
|---|---|---|---|
| 共享基础设施 | `共同规范/共享模块开发流程.md` | `共同规范/共享模块目录.json` | 仅按触发条件读取 |
| 项目脚手架 | `agent/项目脚手架.md` | — | 已建立；提供 `branch:finish` 合并后 worktree/分支收尾入口 |
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | 单一选择驱动运行时已实现：六个 `/api/game/**` route、一个 `performTurn`、一个 composition root/repository/read model/UI root；短篇/中篇正式支持；当前 Plan：`superpowers/plans/2026-08-09-ai-rpg-canonical-runtime-completion.md` |
| 生产链边界 | `agent/当前开发阶段.md` | — | 只允许无版本后缀的生产命名；旧 route、旧 application/UI 链、兼容 facade、类型隔离和旧存档迁移均不存在。历史文档只作决策记录 |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | 创建/恢复、选择驱动推进、探索、物品、战斗、分支和多结局可完整离线游玩；AI 失败走确定性 fallback |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | 固定 choiceToken 与 NPC 自定义输入统一进入 `performTurn`；Action union 只保留有规则实现的 action，已移除无推进作用的 rest，成功回合单次 StateCommit/CAS |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：移动、任务解锁、obtain_item / defeat_enemy objective 与 outcome；探索入口按可探索内容投影（`hasExplorableContent`，2026-08-10） |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；背包界面已重构（2026-07-30）：四分类页签 + 图标网格 + 详情，展示元数据缺省推导；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现确定性 boss 回合战与双结局；Phase 9 已实现：场景化战斗视窗（BattleArena + BattleActionRail），不改规则或 AI |
| 地图与地点冒险 | `agent/地图与地点冒险.md` | `策划文档/AI生成RPG_MVP.md` | Phase 7 地图/地点主循环、Phase 8 非战斗 HUD/视窗/行动栏/详情/对话层、响应式全屏地图 HUD 细化均已实现；Phase 10 narrative 仅在进入地点后显示，地图始终为入口；town 层已接入主循环（map→town→scene 三层导航，2026-07-31）；叙事生成 pending 时以模态覆盖当前界面（2026-08-06）；序幕 ack 不受初始 narrative pending 阻塞（2026-08-06）；ready 对话仍需地图→地点→NPC 热点，fallback 对话投影固定双选项（2026-08-06） |
| 运行时 AI 导演与场景表演 | `agent/运行时AI导演与场景表演.md` | `策划文档/AI生成RPG_MVP.md` | SceneSource 只提案；审批后同一次叙事 CAS 持久化 ready scene、post-writeback revision 的 ApprovedChoice registry 与候选池。客户端不接收 actionKey；live source 只选服务端候选 ID |
| NPC 对话驱动叙事场景触发 | `agent/NPC对话驱动叙事场景触发.md` | `策划文档/AI生成RPG_MVP.md` | 焦点 NPC 始终提供两个固定选择与一个自定义输入；两者统一经 `/api/game/actions` → `performTurn`，浏览器逐次 UUID，均记录回合并创建 pending job |
| NPC 关系与知识演化 | — | `superpowers/specs/2026-07-31-npc-relationship-knowledge-evolution-design.md` | Phase 13 已实现（2026-08-01）：单维度好感度（affinity）、五档关系（hostile/cold/neutral/friendly/trusted）；固定选项经 `resolveAction` 计算关系变化，自由输入经 `classifyDialogueTone` 纯规则语气分类后写入；NPC 演员注入 `relationshipTier`/`relationshipAffinity`/`relationshipSummary` 调整台词；`reconcileStoryMemory` 从 `npc_met.interactionKind` 推导 `lastInteractionSummary`；旧存档零迁移 |
| 剧情连续性与结构化记忆 | `agent/剧情连续性与结构化记忆.md` | `策划文档/AI生成RPG_MVP.md` | 有界规则记忆、最小权限上下文与离线 replay 已实现；短篇/中篇正式支持，启用长篇/开放式前须另立 segmented ledger Spec/Plan |
| 蓝图动态化 | `agent/蓝图动态化.md` | `策划文档/AI生成RPG_MVP.md` §4 | seed 影响初始结构；导演可提议地点/NPC/事件级事实、物品、敌人，经纯规则审批后 CAS 持久化。达到收束或预算边界时停止扩张 |
| 无 AI 试玩验收 | `agent/无AI试玩验收.md` | `superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md` | 已实现：属性/模板叙事、开发环境清档、成功/失败手工试玩路线；开发开局可使用 Phase 10 固定离线旅程基线或 7 题材离线基线（2026-08-04 扩展） |
| AI 环境 | `agent/AI环境.md` | `.env.example` | 独立环境契约已建立；Phase 4B/4C 已实现开局 AI；Phase 10 已复用同一 transport/config，以 prompt-only JSON 运行 director / writer / npc 三个独立请求，并以 `RUN_REAL_AI_JOURNEY=1` 门禁完整真实认证；`GAME_DB_PATH` 仍为 server-only |
| 小镇程序化生成 | `agent/小镇程序化生成.md`、`agent/小镇生成Demo记录.md` | `设想/AI驱动RPG_大地图-小镇地图-场景与小镇生成方案_v0.1.md` | 确定性生成器 + /town-demo SVG 演示 + 生成质量修复 + AI 俯视贴图试验（spike）已实现；town 层已接入游戏主循环（S1–S8，2026-07-31）：地点分级、懒生成（离线同步/AI ensure）、plan+seed 存档与 read model 重建、`town-plan-v1` AI 契约、语义句子入叙事上下文；正式生图管线未实现 |
| 日志与追踪 | `agent/日志与追踪.md` | `operations/logging.md` | RPG 保留同步兼容 facade，HTTP/use-case/AI 后台链路统一 trace，通用脱敏/截断/独立 SQLite/查询/JSONL fallback 由 `@ai-game/logging` 提供；默认 `data/logs.db`，提供健康检查、查询和分层保留命令（2026-08-01） |
| AI 内容质量评估 | `agent/AI内容质量评估.md` | `策划文档/AI内容质量评估标准.md` | Task 8–11 已实现（2026-08-01）：三采集点采集通道（STORY_EVAL_CAPTURE 装配）、长故事评估旅程、离线 analyze 与三段 judge 脚本；量表 v2 与实现事实文档已落盘；v2 case/strategy 矩阵接线由 Task 13 完成；2026-08-05 增加 matrix/scene checkpoint、judge 增量缓存与分层验证入口 |

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
