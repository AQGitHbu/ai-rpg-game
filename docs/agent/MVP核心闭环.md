# MVP 核心闭环

## 职责

本页只给出各系统的整体运行图和文档路由，不重复模块细节。生产链负责开局、规则回合、分阶段叙事生成与审批、持久化和 read model；offline fixture 只用于无 AI 试玩与自动回归。

## 当前契约

- 开局只生成可完成的切片：故事契约、世界前提、玩家、序幕、一个起始地点、一个 NPC、一条活动主线和起始事实；后续实体按需具象化。
- 玩家固定选择和焦点 NPC 自定义输入都经 `/api/game/actions` 进入 `performTurn`；服务端规则拥有 Action、任务、关系、知识、物品、战斗、事件和结局。
- 生产 provider 触发点只有 `initialization`、`narrative_choice`、`npc_free_text`；叙事 provider、审批和失败重试边界见 [运行时 AI 导演与场景表演](./运行时AI导演与场景表演.md)。
- `PreparedContinuationState` 仅为 offline fixture 的续接状态；生产续接唯一使用分阶段链路（planning → narration/character/choices 的整包发布）。
- 地图、城镇、建筑是空间 read model；物品、战斗和规则移动消费已发布场景步骤或规则 scene，不在动作路径额外调用 provider。
- 生产失败保留 `provider_failed` 和同一 job，用户显式重试；失败状态不会被改写为成功场景。
- 当前正式支持短篇和中篇；持久化为 SQLite 的游戏记录与 current-game 指针，使用单一 revision CAS。

## 必要流程

```text
创建参数
  → createGame / initialization job（planning → 表达单元）
  → WorldState + StoryState + EntityStore
  → GameSessionView
  → fixed_choice 或 focus NPC free_text
  → /api/game/actions → performTurn → 一次规则 CAS
  → 允许的 provider trigger / 规则场景
  → GameSessionView
  → 地图 / 城镇 / 建筑 / 物品 / 战斗消费已批准内容
  → endingDecision / resolveEnding
```

## 主要源码和验证

- API：`src/app/api/game/` 下的 game、current、actions、narrative/ensure、prologue/ack、dev/current routes
- application：`src/game/application/createGame.ts`、`src/game/application/performTurn.ts`、`src/game/application/gameSessionView.ts`
- domain：`src/game/domain/worldState.ts`、`src/game/domain/storyState.ts`、`src/game/domain/entity/entityStore.ts`、`src/game/domain/narrative.ts`、`src/game/domain/pendingNarrativeJob.ts`
- gameplay：`src/game/gameplay/rpg/openingGeneration/index.ts`、`src/game/gameplay/rpg/worldEvolution/index.ts`、`src/game/gameplay/rpg/ruleEngine/index.ts`、`src/game/gameplay/rpg/narrativePlanning/index.ts`、`src/game/gameplay/rpg/town/index.ts`
- server：`src/game/application/server/compositionRoot.ts`、`src/game/application/server/persistence/gameRepository.ts`、`src/game/application/server/persistence/sqliteGameRepository.ts`
- 端到端规则验证：`src/game/application/testing/foundationJourney.test.ts`、`src/game/application/testing/dynamicMaterializationJourney.test.ts`、`src/game/application/testing/narrativeGroundingJourney.test.ts`、`src/game/application/testing/storyDivergenceJourney.test.ts`、`src/game/application/testing/npcContinuityJourney.test.ts`

## 按条件关联文档

- 行动和 CAS 见 [行动裁决](./行动裁决.md)。
- 任务与事实见 [探索与任务推进](./探索与任务推进.md)；地图与城镇见 [地图与地点冒险](./地图与地点冒险.md) 和 [小镇程序化生成](./小镇程序化生成.md)。
- NPC 叙事包见 [NPC 对话驱动叙事场景触发](./NPC对话驱动叙事场景触发.md)。
- 物品、战斗和终局分别见 [物品与任务奖励](./物品与任务奖励.md)、[战斗与结局](./战斗与结局.md)。
