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
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | Phase 10 进行中：真实 director / writer / NPC 链路、固定选择、同角色重试、规则开战路由和 record/replay 完整旅程已实现；唯一阶段 Plan：`superpowers/plans/2026-07-30-mvp-phase-10-runtime-ai-director.md` |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | Phase 4C 已实现：创建、恢复、固定行动、探索、物品、战斗与双结局 + 真实 AI 动态开局（`AI_OUTPUT_FORMAT` 结构化输出，失败安全 fallback，phase4c 离线 fixture 集为主回归） |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：observe / talk / investigate / move / take_item / battle intents |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：移动、任务解锁、obtain_item / defeat_enemy objective 与 outcome |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现确定性 boss 回合战与双结局；Phase 9 已实现：场景化战斗视窗（BattleArena + BattleActionRail），不改规则或 AI |
| 地图与地点冒险 | `agent/地图与地点冒险.md` | `策划文档/AI生成RPG_MVP.md` | Phase 7 地图/地点主循环、Phase 8 非战斗 HUD/视窗/行动栏/详情/对话层、响应式全屏地图 HUD 细化均已实现；不改战斗或 AI |
| 运行时 AI 导演与场景表演 | `agent/运行时AI导演与场景表演.md` | `策划文档/AI生成RPG_MVP.md` | Phase 10 已实现真实三请求最小权限链路、两个服务端批准选项、三次同角色有界尝试、机械 schema/引用收敛、完整 fallback 和双模式完整旅程；无自由输入、运行时蓝图扩容或生图 |
| 无 AI 试玩验收 | `agent/无AI试玩验收.md` | `superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md` | 已实现：属性/模板叙事、开发环境清档、成功/失败手工试玩路线 |
| AI 环境 | `agent/AI环境.md` | `.env.example` | 独立环境契约已建立；Phase 4B/4C 已实现开局 AI；Phase 10 已复用同一 transport/config，以 prompt-only JSON 运行 director / writer / npc 三个独立请求，并以 `RUN_REAL_AI_JOURNEY=1` 门禁完整真实认证；`GAME_DB_PATH` 仍为 server-only |

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
