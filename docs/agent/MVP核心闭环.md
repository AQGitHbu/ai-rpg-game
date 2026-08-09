# MVP 核心闭环

## 系统定位

玩家选择题材和短篇/中篇长度创建一局游戏；系统根据 seed 生成受约束且可完成的世界。玩家通过服务器批准的固定选择或焦点 NPC 自定义输入持续推进，规则结果进入结构化状态，叙事生成据此准备下一幕，直到抵达结局。

## 当前闭环

```text
题材 + 时长 + seed
  → createGame
  → world-generation proposal → validate/compile
  → WorldState + StoryState
  → GameSessionView
  → fixed_choice | free_text
  → performTurn → TurnResolution → 单次规则 CAS
  → PendingNarrativeJob
  → generatePendingScene → proposal/approval → scene CAS
  → 下一次 GameSessionView
  → … → battle / ending
```

## 已实现能力

- 七种预设题材；产品 UI 只开放短篇和中篇。
- seed 相关的世界、地点、NPC、任务、物品、敌人和至少两个结局；相同 seed 可 replay，不同 seed 结构不同。
- 焦点 NPC 两个固定对白选择和一个自定义输入；两者走同一 `/api/game/actions` 与 `performTurn`。
- 探索、调查、移动、拾取、休息、NPC 关系/记忆、候选事件、确定性战斗与结局。
- AI/fixture 只生成 proposal；规则审批、Action、任务、知识、关系、战斗、预算和结局独占正式状态。
- SQLite `game_records + current_game`、单一 revision CAS、刷新恢复、开发环境安全清档。
- live AI 不可用时使用同轨确定性 fallback，仍可离线完成一局。

## 每局不同与可完成性

- 不同 seed 至少改变世界名、地点或 NPC 的结构化组合；不是只替换 narration。
- 同 seed 下不同玩家选择会改变 NPC affinity/emotion/history、候选事件、路线状态和 ending ID。
- 完整旅程门禁覆盖 15+ 成功回合、多次 reload、固定选择、自定义输入、旅行、物品、探索、战斗和结局。
- 每条选择分支可以确定性 replay；分化有结构化证据而非仅文案差异。

## 唯一生产边界

- API：`/api/game`、`/api/game/current`、`/api/game/actions`、`/api/game/narrative/ensure`、`/api/game/prologue/ack`、`/api/game/dev/current`。
- Application：`createGame`、`performTurn`、`generatePendingScene`、`projectGameSessionView`。
- Server：`compositionRoot`、`GameRepository`、`createSqliteGameRepository`。
- UI：`CurrentGameScreen`、`AdventureGameShell`、`gameActionRequest`。
- 不存在版本化 route、兼容 facade、并行旧链或 typecheck quarantine。

## 主要文件

- `src/game/domain/worldState.ts` / `storyState.ts` / `action.ts` / `pendingNarrativeJob.ts`。
- `src/game/gameplay/rpg/worldGeneration/` / `ruleEngine/` / `dialogue/` / `expansion/`。
- `src/game/application/createGame.ts` / `performTurn.ts` / `generatePendingScene.ts` / `gameSessionView.ts`。
- `src/game/application/server/compositionRoot.ts`。
- `src/game/application/server/persistence/gameRepository.ts` / `sqliteGameRepository.ts`。
- `src/components/CurrentGameScreen.tsx` / `AdventureGameShell.tsx`。

## 主要验收

- 分层：`test:game-domain`、`test:game-gameplay`、`test:game-application`、`test:components`、`test:app`。
- 架构：`test:boundaries`、`typecheck`、`lint`、`build`。
- 完整旅程：`test:foundation-journey`、`journey:foundation`。
- 全量：`npm test`。

## 容量与兼容边界

- 开发期破坏性重建：旧路由、旧存储和旧本地存档不迁移；升级后清档重开。
- 当前单 record JSON 持久化只正式支持短篇/中篇。
- 长篇/开放式必须先完成 segmented ledger Spec/Plan，不能宣传无限时长或无限记忆。
