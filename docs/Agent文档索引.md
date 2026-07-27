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
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | Phase 6 已规划：确定性轻量战斗与双结局 |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已完成：创建、恢复、固定行动、移动、物品取得与 stage 1-2 任务闭环 |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：observe / talk / investigate / move / take_item；Phase 6 计划新增战斗 intent |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：移动、visit/talk/discover/obtain_item objective 与解锁；Phase 6 计划支持 defeat_enemy |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已规划：boss 轻量回合战、任务成功/失败 outcome 与双结局 |
| AI 环境 | `agent/AI环境.md` | `.env.example` | 独立环境契约已建立；真实 AI 调用尚未实现；`GAME_DB_PATH` 为 server-only 持久化配置 |

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
