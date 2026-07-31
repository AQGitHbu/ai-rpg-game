# Spec：Phase 11 剧情连续性与结构化记忆（内容推进引擎）

> 日期：2026-07-31 ｜ 状态：planned ｜ 关联 Plan：`docs/superpowers/plans/2026-07-31-mvp-phase-11-story-continuity-memory.md`

## 1. 背景

Phase 10 已把一次场景生成收敛为 director → writer → NPC 的受审批链路，但三角色目前只能看到当前场景和最近五个**事件类型**。它们看不到这些事件涉及的地点、人物、线索或任务，也没有持久化的章节位置与 NPC 交互史。因此每幕虽不会越权，却容易失去承接：模型不知道刚抵达何处、上一场发生了什么、某 NPC 是否已与玩家打过交道，以及主线此刻应处于何种张力。

本阶段建立一个内容推进引擎：规则结算后的追加式事件账本仍是唯一事实源；纯函数把它归约为有界的结构化剧情记忆，再将按角色授权裁剪后的连续性包投影给 AI。AI 仍只生成候选文本和既有行动的表达，不能写记忆、修改任务或创造事实。

## 2. 目标

1. 新局初始化有版本化 `StoryMemoryState`；旧存档缺少该字段时以确定性空记忆读取，下一次正常保存再写入，不提高 SQLite record/schema/state 版本。
2. 每次正式规则状态写入前，纯 reducer 从尚未处理的 `eventLedger` 归约剧情记忆：最近里程碑最多 12 条、每个 NPC 只保留其最近一次结构化接触，不保存 AI 原文。
3. 场景 ready 的 CAS 写入同时追加 `narrative_scene_presented` 事件（场景 ID、地点、焦点 NPC、已向玩家呈现的已发现事实 ID 与节奏标签）；这使“已表演的一幕”成为规则可回放事实，而不是把文案当作记忆。
4. 内容推进器从当前主线任务状态导出受约束的章节/节奏：第一幕只允许 `setup|develop`，第二幕只允许 `develop|turn`，终幕未完成时只允许 `climax`，主线全部完成时只允许 `resolution`。它不改写任务、战斗、结局或行动候选。
5. director 获得章节、未结任务和安全的近期里程碑；writer 获得已批准计划、同一幕的安全承接卡；NPC 仅获得自己的接触史和本次已批准事实卡，绝不获得其他 NPC 的记忆、完整账本、未发现事实、prompt、密钥或数据库信息。
6. director 提出的 `pacing` 必须属于推进器给出的 allowed 值，否则由规则拒绝并触发现有的同角色有界重试 / 整场 fallback。其余 Phase 10 的双选项、知识边界、CAS、异步 pending 与 fallback 语义不变。
7. 玩家在“冒险日志”看到本章进展和最近结构化里程碑的可读投影；不公开内部 ID、NPC 私有记忆、AI 诊断或隐藏事实。
8. 离线回归证明 reload 一致、旧存档兼容、记忆有界、NPC 隔离、节奏拒绝与 fallback、场景提交原子性；日常验收零网络零计费。

## 3. 非目标

- 不实现自由输入、意图识别、关系数值、好感度、日程、死亡/背叛等新规则；已有事件仅按既有含义归约。
- 不允许 AI 生成、总结或直接写入长期记忆；不保存完整对白、完整 narration、原始 provider 输出或 prompt。
- 不扩容蓝图，不运行时创建地点/NPC/任务/物品/敌人/事实；`蓝图动态化` 仍是独立候选阶段。
- 不改变任务图、战斗数值、奖励、结局、地图布局、town 生成契约或 `@ai-game/*` foundation package。
- 不引入 streaming、SSE、向量数据库、外部检索、真实 AI 作为日常测试前提。

## 4. 领域模型与兼容性

在 `src/game/domain/storyMemory.ts` 定义（名称和值为本阶段稳定契约）：

```ts
export const STORY_MEMORY_VERSION = 1 as const;
export const STORY_MEMORY_RECENT_LIMIT = 12 as const;

export type StoryPacing = "setup" | "develop" | "turn" | "climax" | "resolution";

export type StoryMemoryEntry =
  | { readonly kind: "location"; readonly locationId: LocationId; readonly turn: number }
  | { readonly kind: "npc"; readonly npcId: NpcId; readonly locationId: LocationId; readonly turn: number }
  | { readonly kind: "fact"; readonly factId: FactId; readonly turn: number }
  | { readonly kind: "quest"; readonly questId: QuestId; readonly status: "unlocked" | "completed" | "failed"; readonly turn: number }
  | { readonly kind: "item"; readonly itemId: ItemId; readonly locationId: LocationId; readonly turn: number }
  | { readonly kind: "battle"; readonly enemyId: EnemyId; readonly outcome: "victory" | "defeat" | "withdraw"; readonly turn: number }
  | { readonly kind: "scene"; readonly sceneId: string; readonly locationId: LocationId; readonly focusNpcId: NpcId | null; readonly pacing: StoryPacing; readonly turn: number };

export type NpcContinuityMemory = {
  readonly npcId: NpcId;
  readonly lastContactTurn: number;
  readonly lastLocationId: LocationId;
};

export type StoryMemoryState = {
  readonly version: typeof STORY_MEMORY_VERSION;
  readonly reducedThroughEventCount: number;
  readonly recent: readonly StoryMemoryEntry[];
  readonly npcContacts: readonly NpcContinuityMemory[];
};
```

`GameState.storyMemory?: StoryMemoryState` 保持可选，确保既有 v1 JSON 存档可读。`storyMemoryOf(state)` 对缺省值返回 `createEmptyStoryMemory()`；新游戏必须写入空状态。Reducer 返回的 `reducedThroughEventCount` 必须等于输入 `eventLedger.length`；它只能追加未处理事件的映射并截断到最后 12 条，输入不可变。历史账本出现未知/不需要承接的事件时只推进 cursor，不伪造条目。

新增 `NarrativeScenePresentedEvent`：

```ts
type NarrativeScenePresentedEvent = {
  readonly type: "narrative_scene_presented";
  readonly sceneId: string;
  readonly locationId: LocationId;
  readonly focusNpcId: NpcId | null;
  readonly revealedFactIds: readonly FactId[];
  readonly pacing: StoryPacing;
  readonly occurredAt: string;
};
```

它不携带 narration、NPC 台词、choiceToken、actionKey 或 AI provenance。它只是玩家已经看见一幕及其安全结构索引的审计事实。

## 5. 归约与内容推进

`gameplay/rpg/narrative/reconcileStoryMemory.ts` 是纯函数：`reconcileStoryMemory({ state })`。它依序映射：到访→location、初谈→npc、发现事实→fact、任务解锁/完成/失败→quest、取得物品→item、战斗结束→battle、场景提交→scene；`npc_met` 与 `narrative_scene_presented.focusNpcId` 更新该 NPC 的最后接触。没有发生的规则事件绝不能由 AI 文案补出。

`deriveContentProgression({ blueprint, state })` 同样为 gameplay 纯函数，返回：

```ts
type ContentProgression = {
  readonly mainStage: 1 | 2 | 3 | null;
  readonly allowedPacing: readonly StoryPacing[];
  readonly activeQuestIds: readonly QuestId[];
};
```

- 存在 active 主线任务时取其 `stage`；stage 1 → `["setup", "develop"]`，stage 2 → `["develop", "turn"]`，stage 3 → `["climax"]`。
- 无 active 主线且至少一个主线已完成 → `["resolution"]`；其他合法旧存档状态也回退 `["setup", "develop"]`，不能抛错或阻断流程。
- `activeQuestIds` 只含当前 active 任务，顺序沿用 blueprint。函数不从 narrative prose 推断章节。

`approveDirectorProposal` 接收 `progression` 并要求 proposal.pacing 属于 `allowedPacing`；不满足返回新增稳定类别 `continuity_violation`。拒绝不会改变规则状态，复用既有三次当前角色重试及完整 fallback。

## 6. 最小权限连续性上下文

所有 context 均由 application 的纯投影器创建，source/prompt 只接收最终 JSON：

| 角色 | 可读取的连续性信息 | 明确不可读取 |
| --- | --- | --- |
| director | `progression`、active quest 卡、最近 12 条已发生的命名里程碑、当前地点、现有 action candidates | 完整 GameState/蓝图、未发现事实文本、其他服务端配置 |
| writer | 已批准 plan、progression、最近 6 条玩家可见里程碑、当前场景的 NPC profile、已批准 fact cards | director 未批准的事实、完整 eventLedger、NPC 私有历史 |
| NPC | 自己的 `NpcContinuityMemory`（只含上次接触回合/地点）和本次 `factCards` | 其他 NPC memory、其他 NPC 对话、完整任务/事件账本、未知事实 |

连续性卡的展示文本必须由 blueprint 已有名称/已发现事实或既有 `StoryEventView` 映射产生；不发送 raw ID-only 没有意义的事件类型，也不把玩家输入全文、隐藏地点/事实或 AI 原文加入 context。原有 `townSpatial` 语义保持不变。

`NARRATIVE_CONTRACT_VERSION` 升为 `runtime-narrative-v2`。录制回放继续对最终 context 做稳定 hash，因此 v1 fixture 不可冒充 v2；日常新增 Phase 11 fixture 必须离线重放，真实录制依旧只可由显式 `RUN_REAL_AI_JOURNEY=1` 触发。

## 7. 写入顺序与失败语义

```text
规则 action / quest / battle / ending
  → append existing GameEvent
  → reconcileStoryMemory
  → 同一次 applyResolvedAction CAS

pending scene → director / writer / NPC approval
  → append narrative_scene_presented
  → reconcileStoryMemory
  → 同一次 applyResolvedAction CAS 写入 scene + memory
```

`generatePendingNarrativeScene` 取得 `now()` 注入，确保 event 时间可测且不在 gameplay/domain 读取时钟。CAS stale 时丢弃生成结果、不能重放 AI；任何 source 或 approval 失败仍保存现有 fallback scene，并以同一原子写入追加 fallback 场景的结构事件和记忆。pending/清除、battle/ending 旁路与 offline 模式不变。

## 8. 玩家可见投影

`GameSessionView` 新增：

```ts
type StoryContinuityView = {
  readonly chapterLabel: string;
  readonly milestones: readonly { readonly text: string }[];
};
```

它只投影最近至多 6 个 `StoryMemoryEntry` 为已知名称的简短文本；没有可投影条目时显示“故事刚刚开始”。“冒险日志”在开场叙事下显示“本章进展”和此列表。该视图不得暴露 stage 数字、ID、NPC 私有接触记录、未发现事实或生成诊断。

## 9. 验收标准

1. 新局持久化 `storyMemory` 空状态；旧 state 缺少字段时读写、行动与结局均正常，首个成功写入得到 v1 memory。
2. reducer 对同一输入深度相等、绝不变异输入、只处理 cursor 之后事件、recent 恒不超过 12；NPC A 的 history 不含 NPC B 接触。
3. 正常行动和场景保存分别把事件与 memory 在一次 CAS 中持久化；stale 零部分写入。
4. stage 1/2/3/主线完成分别产生指定 pacing 集；不允许的 director pacing 被 `continuity_violation` 拒绝，仍有 fallback scene。
5. director/writer 得到命名的连续性卡；NPC request 只含自身联系史和已批准 fact cards。测试断言不存在其他 NPC 名称、未知事实正文、完整账本和 AI 配置字段。
6. `narrative_scene_presented` 不含 AI 文案/token，且其结构事实能在 reload 后承接至下一幕。
7. journal 展示安全的本章进展与最多 6 条里程碑。
8. `npm run lint`、`npm run typecheck`、`npm test`、`npm run test:fast`、`npm run build`、`npm run journey:phase11` 与 `npm run phase:status` 均离线通过；真实认证仍仅为 opt-in smoke。
