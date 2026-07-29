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
| 当前开发阶段 | `agent/当前开发阶段.md` | `agent/current-phase.json` | Phase 4A：AI 契约模拟与生成体验已完成；唯一 Plan：`superpowers/plans/2026-07-28-mvp-phase-4a-ai-contract-simulation.md` |
| MVP 核心闭环 | `agent/MVP核心闭环.md` | `策划文档/AI生成RPG_MVP.md` | Phase 4A 已完成：创建、恢复、固定行动、探索、物品、战斗与双结局 + AI 契约模拟（fixture source、一次修复/重试、fallback、`generationSource`）；真实 AI 调用未实现 |
| 行动裁决 | `agent/行动裁决.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：observe / talk / investigate / move / take_item / battle intents |
| 探索与任务推进 | `agent/探索与任务推进.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：移动、任务解锁、obtain_item / defeat_enemy objective 与 outcome |
| 物品与任务奖励 | `agent/物品与任务奖励.md` | `策划文档/AI生成RPG_MVP.md` | Phase 5 已实现：地点预置物品、take_item 取得和 obtain_item objective；不含物品使用/奖励数值 |
| 战斗与结局 | `agent/战斗与结局.md` | `策划文档/AI生成RPG_MVP.md` | Phase 6 已实现：boss 轻量回合战、任务成功/失败 outcome 与双结局 |
| 无 AI 试玩验收 | `agent/无AI试玩验收.md` | `superpowers/plans/2026-07-28-mvp-no-ai-playable-vertical-slice.md` | 已实现：属性/模板叙事、开发环境清档、成功/失败手工试玩路线 |
| AI 环境 | `agent/AI环境.md` | `.env.example` | 独立环境契约已建立；Phase 4A 已实现 AI 契约模拟（fixture source + 确定性 fallback，不读 AI env 键）；真实 AI 调用与 shared transport 尚未实现（Phase 4B）；`GAME_DB_PATH` 为 server-only 持久化配置 |
| 小镇程序化生成 | `agent/小镇程序化生成.md`、`agent/小镇生成Demo记录.md` | `设想/AI驱动RPG_大地图-小镇地图-场景与小镇生成方案_v0.1.md` | Demo 已实现：确定性生成器 + /town-demo SVG 演示 + 生成质量修复 + AI 俯视贴图试验（spike）；正式生图管线与游戏主循环接入未实现 |

## 维护规则

- 玩法事实变化时同步更新策划文档。
- 实现事实变化时同步更新 agent 文档和本索引。
- 新系统先从 `agent/template.md` 创建最小文档。
