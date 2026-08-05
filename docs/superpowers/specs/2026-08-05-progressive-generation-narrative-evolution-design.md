# Phase 14：渐进式生成与剧情推演设计 Spec

> 日期：2026-08-05
> 状态：设计已确认，待实现
> 修改仓库：仅 `ai-rpg-game`（`sharedInfrastructureChangeAllowed: false`，零 foundation 改动）

## 背景与动机

当前游戏（截至 Phase 13）存在三个核心问题：

1. **开局一次性预生成完整蓝图**：`createFallbackBlueprint` 写死 5 个地点（`loc_1..loc_4 + loc_hidden`）+ 6 个 NPC + 3 个任务的完整内容文案；AI 候选源也要求产出同形态完整字段。玩家选择无法影响后续生成内容，因为所有内容开局已固定。
2. **NPC 对话层有规则中介**：`dialogue_choice`（greet/ask_main_quest）是规则投影的固定语义选项，玩家点击后只产生 `npc_met` 事件，需再排队 pending 场景 → AI 生成 2 个 `narrative_choice` → 玩家再选才推进剧情。两层中介导致玩家选择对剧情走向影响有限。
3. **结局开局固定**：`endings[]` 在开局蓝图生成时即固定 requirements，无法随剧情推演演化。

用户期望：玩家选择直接影响剧情走向，剧情内容边玩边生成；开局有黑底白字序幕作为引子；小镇只有跟随当前剧情的场景可进入。

## 设计目标

- 开局只生成起始锚点（第一个地点+第一个NPC+开场任务）+ 序幕 + 结局方向骨架
- 后续地点/NPC/任务/物品/敌人/结局由 AI 在运行时按剧情推进生成（受 budgetPolicy 余量约束）
- NPC 对话面板直接显示 AI 生成的情境选项，去掉规则中介层
- 结局由 AI 导演在主线关键节点提议 + 闸门审批后具体化
- 小镇入口由"任务目标+已结识"过滤
- 保留现有核心机制：规则独占写入、CAS 持久化、三角色场景流水线、关系值系统、storyMemory 连续性

## 已确认的核心决策

| 决策点 | 选择 |
|---|---|
| 生成范围 | 折中：开局骨架+起始锚点，运行时按剧情推进生成 |
| 选项来源 | AI 生成情境选项（与之前剧情相关，影响后续） |
| 自由输入 | 保留当前机制（playerNpcChat 喂给导演，导演统一判断） |
| 开局生成 | 最小起始锚点 + 结局方向骨架（不固定具体结局，运行时推演） |
| 小镇入口 | 任务目标+已结识过滤 |
| 序幕来源 | AI 生成·开局一次性（作为 openingScene 的一部分） |

## 架构概览

### 核心数据流

```
[开局]
NewGameInput → AI生成 OpeningBlueprint
  ├─ world（世界设定/类型/风格/世界观/主题）
  ├─ player（玩家角色）
  ├─ openingScene.prologue（黑底白字序幕）
  ├─ openingScene.narration + presentNpcIds（开场旁白与在场NPC，配合startAnchor呈现开场场景）
  ├─ startAnchor（起始地点loc_1 + 第一个NPC + 开场任务stage 1）
  ├─ endingDirection（结局方向骨架，不绑定具体任务ID）
  └─ budgetPolicy（地点/NPC/任务/幕数上限）
→ validate/compile → GameState初始化（只有起始锚点已解锁）

[运行时循环]
玩家进入地点/点击NPC → talk_to_npc intent
→ 排队 pending narrative scene（AI三角色根据剧情/NPC关系/storyMemory生成）
  ├─ 场景含：NPC对白 + 2情境选项（绑定actionKey）+ 自由输入入口
  └─ 首遇NPC时由 performAction 自动写 npc_met 事件
→ 玩家选情境选项 → narrative_choice → performAction 反查actionKey → resolveAction规则裁决
  ├─ 可能触发：推进任务/引入新NPC/新地点/战斗/给物品（经闸门审批追加蓝图）
  └─ 自动排队下一场景 pending
→ 玩家自由输入 → classifyFreeDialogue纯规则分类
  ├─ narrative → 排队 pending 场景（playerNpcChat + triggerContext 喂给导演）
  └─ chat → 确定性闲聊兜底

[结局推演]
主线推进到关键节点（budgetPolicy主线幕数过半/关键事件累积达标）
→ AI导演提议 proposedEnding（具体化结局requirements）
→ approveEndingProposal 闸门审批
→ 写入 blueprint.endings[]
→ resolveEnding 检查 requirements → 触发结局
```

### 与现状的关键差异

| 环节 | 现状 | 方案A |
|---|---|---|
| 开局蓝图 | 5地点+6NPC+3任务+2物品+4敌人+2结局完整预生成 | 起始锚点+结局方向骨架+序幕，其余运行时生成 |
| NPC对话 | dialogue_choice（greet/ask_main_quest）规则投影 + AI narrative_choice 两层 | 统一为 AI 情境选项一层 |
| 结局 | 开局固定 requirements | 运行时 AI 提议 + 闸门审批具体化 |
| 小镇入口 | 所有剧情建筑可进入 | 任务目标+已结识过滤 |
| 序幕 | 无（直接进入地图） | 黑底白字序幕开场 |

### 保留的核心机制

- 规则独占状态写入：AI 只产出候选，必经审批+规则裁决
- CAS 持久化：场景与蓝图扩展同一次原子写入
- 三角色最小权限：导演/编剧/NPC演员各自独立请求
- budgetPolicy 余量约束：运行时扩展受 soft/hard cap 限制
- 关系值系统（Phase 13）
- storyMemory 连续性（Phase 11）
- 确定性 fallback 能力保留：开局 fallback（起始锚点）+ 运行时 fallback（单地点/NPC）

## 数据结构变更

### ScenarioBlueprint 重构（schemaVersion 1→2）

保留单一 `ScenarioBlueprint` 类型，将运行时生成的字段标记为可选。开局只填起始锚点+结局方向，运行时动态追加。

```typescript
// src/game/domain/scenarioBlueprint.ts

export type ScenarioBlueprint = {
  readonly schemaVersion: 2;  // 从1升到2，旧存档需迁移
  readonly generationId: string;
  readonly seed: string;
  readonly templateVersion: string;
  readonly gameType: GameTypeId;
  readonly inputDigest: string;

  // === 开局生成（不变）===
  readonly world: WorldDefinition;
  readonly player: GeneratedPlayerDefinition;
  readonly openingScene: OpeningSceneDefinition;  // 新增 prologue 字段
  readonly budgetPolicy: BudgetPolicy;

  // === 起始锚点（开局生成，运行时只读）===
  readonly startAnchor: {
    readonly locationId: string;       // 固定 "loc_1"
    readonly npcId: string;            // 固定 "npc_1"
    readonly startQuestId: string;     // 固定 "quest_1"
  };

  // === 结局方向（开局生成骨架，运行时具体化）===
  readonly endingDirection: {
    readonly theme: string;            // 结局主题方向，如"反元抉择"
    readonly possibleTones: readonly EndingTone[];  // ["triumph","tragedy","bittersweet"]
    readonly lockedAt: number;         // 主线幕数阈值，达此阈值后AI可提议具体化
  };

  // === 运行时动态扩展（开局为空数组或仅起始锚点）===
  readonly locations: readonly LocationDefinition[];      // 开局[1]，运行时追加
  readonly npcs: readonly NpcDefinition[];                // 开局[1]，运行时追加
  readonly quests: readonly QuestDefinition[];            // 开局[1]，运行时追加
  readonly items: readonly ItemDefinition[];              // 开局[]，运行时追加
  readonly enemies: readonly EnemyTemplate[];             // 开局[]，运行时追加（Boss也运行时生成）
  readonly endings: readonly EndingDefinition[];          // 开局[]，运行时AI提议+闸门审批后追加
};

export type EndingTone = "triumph" | "tragedy" | "bittersweet" | "ambiguous";
```

### OpeningSceneDefinition 新增 prologue

```typescript
// src/game/domain/scenarioBlueprint.ts

export type OpeningSceneDefinition = {
  // === 现有字段（保留）===
  readonly narration: string;
  readonly presentNpcIds: readonly string[];
  readonly suggestedActions: readonly ActionSuggestion[];
  readonly investigableFactIds: readonly string[];

  // === 新增：序幕（黑底白字开场）===
  readonly prologue?: PrologueDefinition;
};

export type PrologueDefinition = {
  readonly text: string;                // 序幕正文
  readonly tone: "serious" | "epic" | "mysterious";  // 影响视觉风格
  readonly durationMs?: number;         // 可选自动播放时长（缺省玩家点击跳过）
};
```

### 运行时结局提议类型

```typescript
// src/game/domain/scenarioBlueprint.ts

export type EndingDirection = {
  readonly theme: string;
  readonly possibleTones: readonly EndingTone[];
  readonly lockedAt: number;
};

// 运行时AI提议的结局（经闸门审批后转为 EndingDefinition）
export type ProposedEnding = {
  readonly name: string;
  readonly description: string;
  readonly tone: EndingTone;
  readonly requirements: readonly EndingRequirement[];
  readonly reason: string;              // AI解释为何此结局合适
};
```

### NarrativeScene 扩展

```typescript
// src/game/domain/narrative.ts

export type NarrativeScene = {
  // === 现有字段（保留）===
  readonly sceneId: string;
  readonly locationId: string;
  readonly narration: string;
  readonly presentNpcIds: readonly string[];
  readonly choices: readonly NarrativeChoice[];
  readonly generationSource: "ai" | "fallback";

  // === 新增：NPC对白（场景内NPC的台词）===
  readonly npcDialogues?: readonly NpcDialogueInScene[];
};

export type NpcDialogueInScene = {
  readonly npcId: string;
  readonly npcName: string;
  readonly npcRole: string;
  readonly speechPages: readonly string[];  // 复用现有分页机制
};

export type NarrativeChoice = {
  // === 现有字段（保留）===
  readonly choiceToken: string;
  readonly actionKey: string;
  readonly label: string;
  readonly hint?: string;

  // === 新增：情境语义 ===
  readonly narrativeIntent?: "advance_plot" | "introduce_npc" | "introduce_location" | "combat" | "discover_item";
};
```

### 场景生成触发上下文

```typescript
// src/game/domain/narrative.ts

export type NarrativeTriggerContext =
  | { kind: "talk_to_npc"; npcId: string; isFirstMeeting: boolean }
  | { kind: "narrative_choice_followup"; previousChoiceActionKey: string }
  | { kind: "free_input"; npcId: string; playerText: string }
  | { kind: "location_entered"; locationId: string; isFirstVisit: boolean };

export type NarrativeGeneration = {
  readonly status: "pending";
  readonly requestedAt: string;
  readonly triggerContext?: NarrativeTriggerContext;   // 新增
  readonly playerNpcChat?: PlayerNpcChatState;          // 保留
};
```

### GameState 变更

```typescript
// src/game/domain/gameState.ts

export type GameState = {
  // ... 现有字段保留 ...

  // === 新增：序幕已播放标记 ===
  readonly prologueShown: boolean;       // 开局为false，播放后置true

  // === 新增：主线幕数追踪 ===
  readonly mainStoryProgress: {
    readonly currentAct: number;         // 当前主线幕数
    readonly actThreshold: number;       // 结局推演触发阈值
    readonly endingProposed: boolean;    // 是否已提议过结局
  };
};
```

### 旧存档迁移（schemaVersion 1→2）

`sqliteGameRepository` 的 `withDefaults` 兼容函数升级：

- `prologueShown`：若 `eventLedger` 含任意非开场事件则置 `true`（已过开场），否则 `false`
- `mainStoryProgress`：根据已完成的 `quest_completed` 事件数量推导 `currentAct`；若已有 `endings[]` 则置 `endingProposed: true`
- `startAnchor`：从 `locations[0]`/`npcs[0]`/`quests[0]` 推导
- `endingDirection`：若已有 `endings[]` 则置 `lockedAt=0`（已锁定）
- 不升 schema 版本号（沿用 withDefaults 模式），不回写

## 开局生成层变更

### ScenarioBlueprintCandidate 收窄

契约升级 `phase4a-v1` → `phase4d-v1`。开局 AI 候选源与 fallback 生成器只产出起始锚点+结局方向+序幕。

```typescript
export type ScenarioBlueprintCandidate = {
  readonly schemaVersion: 2;
  // ... 必产字段 ...

  readonly locations: readonly LocationDefinition[];   // 开局长度=1
  readonly npcs: readonly NpcDefinition[];             // 开局长度=1
  readonly quests: readonly QuestDefinition[];         // 开局长度=1（仅stage 1）
  readonly items: readonly ItemDefinition[];           // 开局长度=0
  readonly enemies: readonly EnemyTemplate[];          // 开局长度=0
  readonly endings: readonly EndingDefinition[];       // 开局长度=0
};
```

### validateScenarioBlueprint 分层校验

```typescript
export function validateScenarioBlueprint(
  candidate: ScenarioBlueprintCandidate,
  phase: "opening" | "runtime_expansion"
): ValidationResult;
```

- `phase: "opening"`：校验起始锚点完整性、`prologue` 必产、`locations/npcs/quests` 各1个、`items/enemies/endings` 为空
- `phase: "runtime_expansion"`：校验新增 location/npc/quest/ending 的 ID 格式与引用完整性

### createFallbackBlueprint 拆分

- **开局 fallback**：只生成起始锚点+序幕+结局方向。`FALLBACK_TEMPLATE_VERSION` 升至 `"fallback-8"`
- **运行时 fallback**（新增 `createRuntimeFallbackExpansion`）：AI 场景生成失败时确定性产出最小剧情推进（单地点/NPC），保证游戏不卡死

### 开局 AI Prompt 收窄

`scenarioPrompt.ts` 只要求 AI 生成起始锚点+序幕+结局方向，不再要求产出所有地点/NPC/任务/敌人/结局的完整蓝图。

## NPC对话层与场景生成重构

### dialogue_choice 废除

完全删除 `dialogue_choice` intent 及其规则投影路径：

- `src/game/gameplay/rpg/actions/dialogueChoices.ts` — 删除
- `src/game/gameplay/rpg/actions/intents.ts` — 删除 `dialogue_choice` 类型
- `src/game/gameplay/rpg/actions/validateIntent.ts` — 删除校验
- `src/game/gameplay/rpg/actions/resolveAction.ts` — 删除 case
- `src/app/api/game/actions/actionHandler.ts` — 删除白名单

### talk_to_npc intent 新增

```typescript
// 新增 intent：玩家点击 NPC 触发场景生成
export type TalkToNpcIntent = {
  readonly type: "talk_to_npc";
  readonly npcId: string;
};
```

`resolveAction` 处理 `talk_to_npc`：
- 校验 NPC 在当前地点
- 首遇时写 `met=true` + `npc_met` 事件（替代旧版 greet）
- 排队 pending 场景（携带 `triggerContext: { kind: "talk_to_npc", npcId, isFirstMeeting }`）

### NPC对话面板统一为 AI 情境选项

`locationAdventureView.projectNpcDialogueView` 改为：
- 若 `narrative.currentScene` 包含此 NPC：显示场景对白 + 情境选项
- 否则：显示"点击交谈"提示，点击触发 `talk_to_npc`

### 场景生成扩展

`orchestrateNarrativeScene` 三角色生成：
1. 导演提议场景结构（含 `presentNpcIds`、`proposedNewNpcs/Locations`、`proposedEnding`）
2. 编剧产出 `narration` + `npcDialogues` + 2个情境选项（每个绑定 actionKey）
3. NPC演员产出每个 presentNpc 的对白分页
4. 选项 actionKey 审批（必须映射合法 `PlayerIntent`）
5. 蓝图扩展审批（新地点/NPC/结局）

### narrative_choice 自动排队下一场景

`narrative_choice` 成功裁决后自动排队下一个 pending 场景（携带 `triggerContext: { kind: "narrative_choice_followup", previousChoiceActionKey }`），玩家选择直接驱动后续剧情生成。

### 自由输入处理（保留 Phase 12 机制）

- `classifyFreeDialogue` 纯规则分类（零 AI、零 IO、零随机）
- `narrative`：排队 pending 场景，`playerNpcChat` + `triggerContext` 喂给导演
- `chat`：确定性闲聊兜底
- 关系值 ±3（Phase 13 机制保留）

## 结局推演机制

### 主线幕数追踪

```typescript
// src/game/gameplay/rpg/story/storyProgression.ts（新增）

export function reconcileMainStoryProgress(
  blueprint: ScenarioBlueprint,
  state: GameState,
  questDeps: QuestDeps
): { currentAct: number; shouldProposeEnding: boolean };
```

`currentAct` 由 `reconcileQuests` 在 `quest_completed` 事件后增量更新。达 `actThreshold` 且未提议过结局 → `shouldProposeEnding = true`。

### 导演提议结局

`DirectorProposal` 新增 `proposedEnding?: ProposedEnding`。`orchestrateNarrativeScene` 在 `shouldProposeEnding` 时允许导演提议结局。

### approveEndingProposal 闸门审批（8步）

```typescript
// src/game/gameplay/rpg/narrative/approveEndingProposal.ts（新增）

export function approveEndingProposal(args: {
  blueprint: ScenarioBlueprint;
  state: GameState;
  proposed: ProposedEnding;
}): EndingApprovalDecision;
```

8步闸门：
1. `none_proposed`：未提议
2. `invalid_payload`：字段缺失或长度非法
3. `not_locked`：未达 `endingDirection.lockedAt` 阈值
4. `already_proposed`：已提议过（防重复）
5. `tone_mismatch`：基调不在 `possibleTones` 内
6. `requirements_invalid`：requirements 引用的 questId 不存在
7. `requirements_unsatisfiable`：所有 requirements 当前均不可达成
8. `theme_alignment`：通过 prompt 约束 + 闸门信任

### applyEndingToBlueprint

```typescript
// src/game/gameplay/rpg/narrative/applyEndingToBlueprint.ts（新增）

export function applyEndingToBlueprint(
  blueprint: ScenarioBlueprint,
  approvedEnding: EndingDefinition
): ScenarioBlueprint;
```

### resolveEnding 调整

- `endings[]` 为空时返回 `null`（不触发结局，继续推进）
- 其余逻辑保留：检查 `quest_completed`/`quest_failed` requirements 是否满足

### 导演 Prompt 扩展

`directorPrompt.ts` 在 `endingProposalAllowed === true` 时扩展 prompt，允许导演提议结局。

### 结局 fallback

若 AI 始终未提议结局（`currentAct` 达 `actThreshold + 1` 时仍无提议），运行时 fallback 产出确定性结局（基于已完成任务）。

## 序幕UI与小镇入口过滤

### PrologueScreen 组件

新增 `src/components/PrologueScreen.tsx`：
- 黑底白字全屏展示序幕文本
- 逐字/逐句淡入动画（`tone` 影响速度：epic 80ms/字，其他 50ms/字）
- 点击或按任意键跳过（先显示全文，再次点击进入游戏）
- 播放完毕触发 `onComplete` 回调

### 序幕播放流程

`CurrentGameScreen` 根协调器：
- `prologueShown === false && openingScene.prologue` → 显示 `PrologueScreen`
- `onComplete` → `POST /api/game/prologue/ack`（CAS 写 `prologueShown=true`）
- `prologueShown === true` → 正常游戏界面

### ack_prologue 内部 intent

新增 `ack_prologue` 内部 intent（幂等写 `prologueShown=true`）。

### 小镇入口过滤

`townRuntimeView.projectTownLayerView` 修改 `interactiveBuildings` 投影：

判定逻辑（新增两层过滤）：
1. NPC 已被玩家结识（`npcState.met === true`）
2. 或 NPC 被 active quest 的 `talk_to_npc` objective 指向

不满足两条件的建筑：占位图，不可点击，无"进入"按钮。

`TownLayerView` 新增 `allBuildings` 字段（所有建筑，含不可进入，用于渲染占位图）。

## 测试与验收策略

### 测试分层

| 层级 | 范围 | 关键测试用例 |
|---|---|---|
| domain 单测 | 类型契约、纯函数 | schemaVersion=2 字段契约；`PrologueDefinition` 必填；`NarrativeTriggerContext` 联合类型穷举；`ProposedEnding` 结构校验；`reconcileMainStoryProgress` 纯函数 |
| gameplay 单测 | 规则、分类器、审批闸门 | `validateScenarioBlueprint("opening")` 拒绝空 prologue/多地点开局；`approveEndingProposal` 8步闸门全路径；`createFallbackBlueprint` 仅产1地点1NPC1任务；`createRuntimeFallbackExpansion` 确定性产出 |
| application 集成 | use case + SQLite | `createGame` 开局只落起始锚点；`performAction(talk_to_npc)` 首遇写 `npc_met` + 排队 pending；`narrative_choice` 自动排队下一场景；结局提议 + 蓝图扩展同一次 CAS |
| API 契约 | HTTP adapter | `POST /api/game/prologue/ack` 幂等性；`talk_to_npc` 白名单；旧 `dialogue_choice` 返回 400 |
| UI 组件 | React 渲染与交互 | `PrologueScreen` 动画 + 跳过；`NpcDialoguePanel` 统一渲染；`TownLayerScreen` 非可进入建筑无进入按钮；`CurrentGameScreen` 序幕优先级 |
| 边界守卫 | `dependencyBoundaries.test.ts` | `dialogueChoices` 删除后守卫清理；新增模块 deep-import 守卫 |
| 回归 | 三题材完整旅程 | 离线模式：开局 fallback + 运行时 fallback 推进至结局；AI 模式：fixture 回放完整旅程 |

### 关键回归测试

```typescript
// src/game/application/phase14ProgressiveGenerationRegression.test.ts（新增）

describe("Phase 14 渐进式生成与剧情推演", () => {
  test("开局蓝图只含起始锚点");
  test("序幕播放后 prologueShown=true");
  test("talk_to_npc 首遇写 npc_met 并排队 pending");
  test("narrative_choice 自动排队下一场景");
  test("自由输入 narrative 路径携带 triggerContext");
  test("主线达 lockedAt 阈值时导演提议结局");
  test("结局闸门拒绝未达阈值/重复提议/基调不匹配");
  test("小镇入口任务目标+已结识过滤");
  test("旧存档 schemaVersion 1→2 迁移");
});
```

### AI 旅程录制/回放

- `scripts/phase14Journey.mjs`（新增，镜像 `phase10Journey.mjs`）
- `data/fixtures/phase14-journey/v1/`（三题材 golden fixture）
- CLI: `npm run journey:phase14` / `npm run smoke:ai:phase14-journey`

### 离线验收命令

```bash
npm run lint
npm run typecheck
npm run test
npm run test:fast
npm run build
npm run journey:phase14
```

### 验收重点

1. 开局蓝图收窄：`createFallbackBlueprint` 只产 1 地点+1NPC+1任务+序幕+结局方向
2. `dialogue_choice` 完全废除：API/UI/resolveAction 无残留路径
3. NPC 对话统一：`NpcDialoguePanel` 直接渲染 `narrative.currentScene` 的对白+情境选项
4. 序幕播放：首次进入显示黑底白字序幕，播放后 CAS 标记，刷新不重复
5. 结局推演：主线达阈值时 AI 提议 + 闸门审批，`resolveEnding` 在 `endings[]` 填充后触发
6. 小镇入口过滤：未结识且非 talk 目标的建筑不可进入
7. 旧存档兼容：schemaVersion 1→2 迁移零破坏
8. AI/离线双模式：fixture 回放零网络，真实 AI 旅程可选 opt-in

## 文件变更摘要

### 新增文件

| 文件 | 用途 |
|---|---|
| `src/game/gameplay/rpg/story/storyProgression.ts` | 主线幕数追踪 |
| `src/game/gameplay/rpg/narrative/approveEndingProposal.ts` | 结局提议闸门审批 |
| `src/game/gameplay/rpg/narrative/applyEndingToBlueprint.ts` | 结局追加到蓝图 |
| `src/game/gameplay/rpg/scenario/createRuntimeFallbackExpansion.ts` | 运行时 fallback |
| `src/components/PrologueScreen.tsx` | 序幕组件 |
| `src/app/api/game/prologue/ack/route.ts` | 序幕确认 API |
| `src/game/application/phase14ProgressiveGenerationRegression.test.ts` | 回归测试 |
| `scripts/phase14Journey.mjs` | AI 旅程录制/回放 |
| `data/fixtures/phase14-journey/v1/` | golden fixture |

### 修改文件

| 文件 | 变更 |
|---|---|
| `src/game/domain/scenarioBlueprint.ts` | schemaVersion 2；新增 `startAnchor`/`endingDirection`/`PrologueDefinition`/`ProposedEnding`；`OpeningSceneDefinition` 新增 `prologue?` |
| `src/game/domain/narrative.ts` | `NarrativeScene` 新增 `npcDialogues?`；`NarrativeChoice` 新增 `narrativeIntent?`；`NarrativeGeneration` 新增 `triggerContext` |
| `src/game/domain/gameState.ts` | 新增 `prologueShown`/`mainStoryProgress` |
| `src/game/gameplay/rpg/scenario/scenarioCandidateSource.ts` | 契约升级 phase4d-v1 |
| `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts` | 分层校验 |
| `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts` | 拆分为开局 fallback |
| `src/game/application/server/ai/scenarioPrompt.ts` | 开局 prompt 收窄 |
| `src/game/gameplay/rpg/actions/dialogueChoices.ts` | **删除** |
| `src/game/gameplay/rpg/actions/intents.ts` | 删除 `dialogue_choice`；新增 `talk_to_npc`/`ack_prologue` |
| `src/game/gameplay/rpg/actions/validateIntent.ts` | 删除 `dialogue_choice` 校验；新增 `talk_to_npc`/`ack_prologue` 校验 |
| `src/game/gameplay/rpg/actions/resolveAction.ts` | 删除 `dialogue_choice` case；新增 `talk_to_npc`/`ack_prologue` case |
| `src/app/api/game/actions/actionHandler.ts` | 删除 `dialogue_choice` 白名单；新增 `talk_to_npc` 白名单 |
| `src/game/application/locationAdventureView.ts` | `projectNpcDialogueView` 从 `narrative.currentScene` 读取 |
| `src/game/application/orchestrateNarrativeScene.ts` | 编剧产出 `npcDialogues`；NPC演员产出对白分页；结局提议审批 |
| `src/game/application/performAction.ts` | `talk_to_npc` case；`narrative_choice` 自动排队下一场景 |
| `src/game/application/handleNpcDialogue.ts` | `triggerContext` 携带 `playerNpcChat` |
| `src/game/gameplay/rpg/narrative/types.ts` | `DirectorProposal` 新增 `proposedEnding?` |
| `src/game/gameplay/rpg/quests/resolveEnding.ts` | `endings[]` 为空时返回 null |
| `src/game/application/server/ai/directorPrompt.ts` | 达阈值时扩展 prompt |
| `src/game/application/townRuntimeView.ts` | `interactiveBuildings` 加过滤；新增 `allBuildings` |
| `src/components/CurrentGameScreen.tsx` | 序幕优先级 |
| `src/components/NpcDialoguePanel.tsx` | 统一渲染场景对白+情境选项 |
| `src/components/TownLayerScreen.tsx` | 非可进入建筑无进入按钮 |
| `src/game/application/server/persistence/sqliteGameRepository.ts` | `withDefaults` 升级 schemaVersion 1→2 迁移 |
| `src/app/globals.css` | `.prologue-screen` 样式 |

## 兼容性

- **旧存档**：`withDefaults` 推导 `prologueShown`/`mainStoryProgress`/`startAnchor`/`endingDirection`，不回写
- **旧 `dialogue_choice` 历史事件**：保留只读，不影响新逻辑
- **旧存档 `npcs[].met`**：新逻辑首次点击会写 `npc_met`，行为等价
- **`narrative_choice` 路径**：完全保留，无破坏性变更
- **Phase 10 离线模式**：保留，开局 fallback 使用固定起始锚点
- **Phase 11 storyMemory**：保留
- **Phase 13 关系值系统**：保留

## Phase 划分

建议拆分为 **Phase 14**（渐进式生成与剧情推演），下属子任务：

1. 数据结构变更（schemaVersion 2 + 迁移）
2. 开局生成层收窄（fallback 拆分 + AI prompt + validate 分层）
3. `dialogue_choice` 废除 + `talk_to_npc` 新增
4. NPC对话层统一（场景对白+情境选项）
5. 序幕UI与 API
6. 小镇入口过滤
7. 结局推演机制（主线追踪+闸门审批+resolveEnding调整）
8. 测试与验收（单元+集成+回归+AI旅程fixture）

## 明确不做

- 自由输入意图解析 AI（分类器永为纯规则）
- 闲聊内容写入记忆/eventLedger/storyMemory
- AI 生图接入（建筑插图仍为 SVG 占位）
- 多维度关系（仅保留 Phase 13 单维度 affinity）
- streaming、语音、视觉描述生成
- foundation / 共享模块修改
