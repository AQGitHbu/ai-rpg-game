# MVP 核心闭环

## 系统定位

玩家选择题材和短篇/中篇长度创建一局游戏；系统只生成一个可完成的开局切片（故事契约 + 世界前提 + 玩家 + 序幕 + 1 地点/1 NPC/1 主线 + 预算），后续实体由可选的运行时世界演化按需具象化。玩家通过服务器批准的固定选择或焦点 NPC 自定义输入持续推进，规则结果进入结构化状态，场景表演据此准备下一幕，直到抵达结局。

## 当前闭环

```text
题材 + 时长 + seed
  → createGame
  → opening-generation proposal → validate/compile（只铸造 loc_0 / npc_0 / quest_0 + 开场事实）
  → WorldState + StoryState（StoryContract + StoryEvolutionState）
  → GameSessionView
  → fixed_choice | free_text
  → performTurn → TurnResolution → 单次规则 CAS（派生 ObjectiveTransition + 强制节拍 ≤8）
  → PendingNarrativeJob
  → generatePendingScene
       └（可选）world-evolution：EvolutionNeed → proposal → 审批 → 铸 ID → 预览状态
       → scene-performance proposal（分段旁白 / objectiveLink / 焦点 NPC 台词 / 合法选项）
       → approveAndWriteScene
  → 单次 scene CAS（原子写回已批准世界演化 + ready scene + choice registry + 候选事件）
  → 下一次 GameSessionView
  → … → battle / ending
```

## 已实现能力

- 七种预设题材；产品 UI 只开放短篇和中篇。
- **开局切片**：恰一个起始地点、一个开场 NPC、一条活动主线与开场目标所需事实；不生成未来实体名。
- **运行时世界演化**：幕推进（`needs_next_act`）、节奏（`pacing`）、终局（`needs_ending_pair`）触发；AI 提案 → 规则审批 → 服务端铸 ID → 具象化到预算边界。
- 焦点 NPC 两个固定对白选择和一个自定义输入；两者走同一 `/api/game/actions` 与 `performTurn`。
- **场景表演**：每个 ready 场景一次调用，分段旁白逐段对应强制节拍，`objectiveLink` 与 HUD 当前目标一致，焦点 NPC 收到隔离记忆与关系政策。
- 探索、调查、移动、拾取、NPC 关系/记忆、候选事件、确定性战斗与结局。
- AI/fixture 只生成 proposal；规则审批、Action、任务、知识、关系、战斗、预算和结局独占正式状态。
- SQLite `game_records + current_game`、单一 revision CAS、刷新恢复、开发环境安全清档。
- live AI 不可用时使用同轨确定性 fallback，仍可离线完成一局。

## 每局不同与可完成性

- 不同 seed 进入 live/fallback 的生成上下文；候选生成抽象结构标签并提取开局指纹，服务端与近期同题材历史做相似度校验，过于雷同就重试；API 自由决定地点、NPC、建筑和任务名称，服务端不做实体名覆盖。
- 同 seed 下不同玩家选择会改变 NPC affinity/emotion/history、候选事件、路线状态和结局方向（trust/doubt 由规则要求按关键 NPC 亲和度裁决）。
- 开局小、随游玩增长：首次对话后下一次写回会具象化新 NPC 与地点/物品，下一场景必须提及已批准名称。
- 完整旅程门禁覆盖 15+ 成功回合、多次 reload、固定选择、自定义输入、旅行、地图→城镇→建筑场景、物品、探索、战斗和结局。
- 每条选择分支可以确定性 replay；分化有结构化证据而非仅文案差异。

## 唯一生产边界

- API：`/api/game`、`/api/game/current`、`/api/game/actions`、`/api/game/narrative/ensure`、`/api/game/prologue/ack`、`/api/game/dev/current`。
- Application：`createGame`、`performTurn`、`generatePendingScene`、`evolveWorld`、`projectGameSessionView`。
- Server：`compositionRoot`、`GameRepository`、`createSqliteGameRepository`。
- UI：`CurrentGameScreen`、`AdventureGameShell`、`TownLayerScreen`、`gameActionRequest`。
- 不存在版本化 route、兼容 facade、并行旧链或 typecheck quarantine；不存在 `town ensure` 生产路由（城镇层为确定性 application/gameplay 工作）。

## 主要文件

- `src/game/domain/worldState.ts` / `storyState.ts` / `action.ts` / `pendingNarrativeJob.ts` / `storyContract.ts` / `worldDelta.ts` / `narrativeBeat.ts` / `townState.ts`。
- `src/game/gameplay/rpg/openingGeneration/` / `worldEvolution/` / `narrativeContext/` / `town/` / `ruleEngine/` / `dialogue/`。
- `src/game/application/createGame.ts` / `performTurn.ts` / `evolveWorld.ts` / `generatePendingScene.ts` / `sceneGenerationContext.ts` / `focusNpcContext.ts` / `gameSessionView.ts` / `townView.ts`。
- `src/game/application/server/compositionRoot.ts`。
- `src/game/application/server/persistence/gameRepository.ts` / `sqliteGameRepository.ts`。
- `src/components/CurrentGameScreen.tsx` / `AdventureGameShell.tsx` / `TownLayerScreen.tsx`。

## 主要验收

- 分层：`test:game-domain`、`test:game-gameplay`、`test:game-application`、`test:components`、`test:app`。
- 架构：`test:boundaries`、`typecheck`、`lint`、`build`。
- 完整旅程：`test:foundation-journey`、`journey:foundation`。
- 动态具象化与叙事落点：`dynamicMaterializationJourney.test.ts`、`narrativeGroundingJourney.test.ts`、`storyDivergenceJourney.test.ts`。
- 全量：`npm test`。

## 容量与兼容边界

- 开发期破坏性重建：旧路由、旧存储和旧本地存档不迁移；升级后清档重开。
- 当前单 record JSON 持久化只正式支持短篇/中篇。
- 长篇/开放式必须先完成 segmented ledger Spec/Plan，不能宣传无限时长或无限记忆。
