# Phase 14：渐进式生成与剧情推演设计 Spec

> 日期：2026-08-05
> 状态：设计已确认，待实现
> 修改仓库：仅 `ai-rpg-game`（`sharedInfrastructureChangeAllowed: false`，零 foundation 改动）

## 背景与动机

当前游戏（截至 Phase 13）存在三个核心问题：

1. **开局一次性预生成完整蓝图**：`createFallbackBlueprint` 写死 5 个地点（`loc_1..loc_4 + loc_hidden`）+ 4~6 个 NPC + 主线幕数任务（short 3 幕 + 1~2 支线）+ 2 个物品 + 3+1 敌人 + 2 个结局的完整内容文案；AI 候选源也要求产出同形态完整字段。玩家选择无法影响后续生成内容，因为所有内容开局已固定。
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
玩家进入地点/点击NPC → talk intent
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
| 开局蓝图 | 5地点+4~6NPC+主线幕数任务+1~2支线+2物品+3+1敌人+2结局完整预生成 | 起始锚点+结局方向骨架+序幕，其余运行时生成 |
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

保留现有泛型模板 `ScenarioBlueprintShapeOf<I extends IdSet>`（候选/已编译同一模板两次实例化），在 Shape 内新增 `startAnchor`/`endingDirection` 字段，`schemaVersion` 字面量由 1 升至 2。开局只填起始锚点+结局方向，运行时动态追加。

```typescript
// src/game/domain/scenarioBlueprint.ts

type ScenarioBlueprintShapeOf<I extends IdSet> = {
  readonly schemaVersion: 2;  // 从 1 升到 2；旧存档读取经 sqliteGameRepository 版本检查兼容
  readonly generationId: I["generation"];
  readonly seed: string;
  readonly templateVersion: string;
  readonly gameType: GameTypeId;
  readonly inputDigest: string;

  // === 开局生成（不变）===
  readonly world: WorldDefinitionOf<I>;
  readonly player: GeneratedPlayerDefinitionOf<I>;
  readonly openingScene: SceneDefinitionOf<I>;        // 复用现有 SceneDefinition，新增 prologue 字段
  readonly budgetPolicy?: BudgetPolicy;               // 保持可选（旧存档缺省，读取经 budgetPolicyOf）

  // === 起始锚点（开局生成，运行时只读）===
  readonly startAnchor: {
    readonly locationId: I["location"];   // 现有 fallback 为 "loc_1"
    readonly npcId: I["npc"];             // 现有 fallback 为 "npc_1"
    readonly startQuestId: I["quest"];    // 现有 fallback 主线首幕为 "quest_main_1"
  };

  // === 结局方向（开局生成骨架，运行时具体化）===
  readonly endingDirection: EndingDirectionOf<I>;

  // === 运行时动态扩展（开局为空数组或仅起始锚点）===
  readonly locations: readonly LocationDefinitionOf<I>[];   // 开局[1]，运行时追加
  readonly npcs: readonly NpcDefinitionOf<I>[];             // 开局[1]，运行时追加
  readonly quests: readonly QuestDefinitionOf<I>[];         // 开局[1]，运行时追加
  readonly items: readonly ItemDefinitionOf<I>[];           // 开局[]，运行时追加
  readonly enemies: readonly EnemyTemplateOf<I>[];          // 开局[]，运行时追加（Boss 也运行时生成）
  readonly endings: readonly EndingDefinitionOf<I>[];       // 开局[]，运行时 AI 提议+闸门审批后追加
};

// 已编译别名的公开形式（与现有 LocationDefinition 等别名同构）
export type OpeningSceneDefinition = SceneDefinition;
export type ScenarioBlueprint = ScenarioBlueprintShapeOf<CompiledIds> & { readonly [compiledScenarioBlueprintBrand]: true };
export type ScenarioBlueprintCandidate = ScenarioBlueprintShapeOf<CandidateIds>;
```

> 注：`openingScene` 复用现有 `SceneDefinition`（含 `id`/`locationId`/`narration`/`presentNpcIds`/`suggestedActions`/`investigableFactIds`），**不得移除 `id`/`locationId`**——现有 `validateIntent`/`projectAvailableActions`/`orchestrateNarrativeScene` 等大量读取 `blueprint.openingScene.locationId`，类型必须保持。`prologue` 作为 `SceneDefinition` 之上的扩展字段处理。

### OpeningSceneDefinition 新增 prologue

```typescript
// src/game/domain/scenarioBlueprint.ts

// openingScene 继续使用现有 SceneDefinition，新增可选 prologue 字段：
export type SceneDefinitionOf<I extends IdSet> = {
  readonly id: I["scene"];
  readonly locationId: I["location"];
  readonly narration: string;
  readonly presentNpcIds: readonly I["npc"][];
  readonly suggestedActions: readonly string[];   // 现有类型为 string[]（actionKey 集合），非独立 ActionSuggestion
  readonly investigableFactIds: readonly I["fact"][];

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

export type EndingTone = "triumph" | "tragedy" | "bittersweet" | "ambiguous";

// 结局方向骨架：泛型模板，与 Shape 共用（已编译别名 EndingDirection）。
// lockedAt 语义：主线幕数阈值（= budgetPolicy.mainActs 的过半值），
// 达此阈值后 AI 可提议具体化。此字段是结局推演阈值的唯一来源
// （GameState.mainStoryProgress 不再存 actThreshold）。
type EndingDirectionOf<I extends IdSet> = {
  readonly theme: string;
  readonly possibleTones: readonly EndingTone[];
  readonly lockedAt: number;   // 主线幕数阈值，由 budgetPolicyOf(blueprint).mainActs 推导
};

// 运行时 AI 提议的结局（经闸门审批后转为 EndingDefinition）
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

// 现有类型名为 NarrativeSceneState，新增字段在其上扩展：
export type NarrativeSceneState = {
  // === 现有字段（保留，与当前代码一致）===
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly usedFactIds: readonly FactId[];
  readonly npcLine: NarrativeNpcLineState | null;   // 现有单焦点 NPC 台词
  readonly choices: readonly [NarrativeChoiceState, NarrativeChoiceState];  // 现有二元组
  readonly source: "generated" | "fallback";        // 现有来源标记（非 "ai" | "fallback"）

  // === 新增：NPC对白（场景内 NPC 的台词，含焦点 NPC）===
  readonly npcDialogues?: readonly NpcDialogueInScene[];
};

export type NpcDialogueInScene = {
  readonly npcId: string;
  readonly npcName: string;
  readonly npcRole: string;
  readonly speechPages: readonly string[];  // 复用现有分页机制
};

export type NarrativeChoiceState = {
  // === 现有字段（保留，与当前代码一致）===
  readonly choiceToken: string;
  readonly label: string;
  readonly actionKey: string;

  // === 新增：情境语义与展示提示 ===
  readonly hint?: string;
  readonly narrativeIntent?: "advance_plot" | "introduce_npc" | "introduce_location" | "combat" | "discover_item";
};
```

### 场景生成触发上下文

```typescript
// src/game/domain/narrative.ts

export type NarrativeTriggerContext =
  | { kind: "talk"; npcId: string; isFirstMeeting: boolean }   // kind 与 intent type 对齐（非 talk_to_npc）
  | { kind: "narrative_choice_followup"; previousChoiceActionKey: string }
  | { kind: "free_input"; npcId: string; playerText: string }
  | { kind: "location_entered"; locationId: string; isFirstVisit: boolean };

// 现有类型名为 NarrativeGenerationState（idle | pending 判别联合）。
// pending 变体新增 triggerContext，playerNpcChat 保留：
export type NarrativeGenerationState =
  | { readonly status: "idle" }
  | {
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
  readonly stateVersion: 1;   // 保持不变：新字段走 withDefaults 兼容，不升记录版本
  // ... 现有字段保留 ...

  // === 新增：序幕已播放标记 ===
  readonly prologueShown: boolean;       // 开局为false，播放后置true

  // === 新增：主线幕数追踪 ===
  readonly mainStoryProgress: {
    readonly currentAct: number;         // 当前主线幕数
    readonly endingProposed: boolean;    // 是否已提议过结局
    // 注意：结局推演阈值不在此重复存储——运行时读 blueprint.endingDirection.lockedAt
    // 单一来源，避免两处阈值漂移（spec 旧述 actThreshold 字段已废弃）。
  };
};
```

### 旧存档迁移（schemaVersion 1→2）

`sqliteGameRepository` 的 `interpretGameRow` 内组合调用的 `with*Defaults` 系列函数（`withNarrativeDefault`/`withTownDefaults`/`withPhase6StateDefaults` 等）升级，新增对应的 `withPrologueDefault`/`withMainStoryProgressDefault`（沿用零迁移模式，**不回写**）：

- `prologueShown`：若 `eventLedger` 含任意非开场事件则置 `true`（已过开场），否则 `false`
- `mainStoryProgress`：根据已完成的主线任务（`quest_main_*`）数推导 `currentAct`；若已有 `endings[]` 则置 `endingProposed: true`
- `startAnchor`：从 `locations[0]`/`npcs[0]`/`quests[0]` 推导（现有 fallback 分别为 `loc_1`/`npc_1`/`quest_main_1`）
- `endingDirection`：`theme` 从 `world.themes` 推导、`possibleTones` 用默认集合、`lockedAt` 从 `budgetPolicyOf(blueprint).mainActs` 推导
- **版本检查同步更新**：`interpretGameRow` 的 `blueprint["schemaVersion"] !== 1` 改为接受 `1` 或 `2`（`stateVersion` 仍为 `1` 不变）；否则新档会被判 `corrupt("VERSION_MISMATCH")`

## 开局生成层变更

### ScenarioBlueprintCandidate 收窄

契约升级 `scenario-dynamic-v2` → `scenario-dynamic-v3`（版本常量定义在 `src/game/application/scenarioGeneration.ts`，非 spec 旧述的 `phase4a-v1`）。开局 AI 候选源（`src/game/application/server/ai/liveScenarioCandidateSource.ts` / `fixtureScenarioCandidateSource.ts`）与 fallback 生成器只产出起始锚点+结局方向+序幕。

```typescript
export type ScenarioBlueprintCandidate = {
  readonly schemaVersion: 2;
  // ... 必产字段 ...

  readonly locations: readonly LocationDefinitionCandidate[];   // 开局长度=1
  readonly npcs: readonly NpcDefinitionCandidate[];             // 开局长度=1
  readonly quests: readonly QuestDefinitionCandidate[];         // 开局长度=1（仅stage 1）
  readonly items: readonly ItemDefinitionCandidate[];           // 开局长度=0
  readonly enemies: readonly EnemyTemplateCandidate[];          // 开局长度=0
  readonly endings: readonly EndingDefinitionCandidate[];       // 开局长度=0
};
```

### validateScenarioBlueprintCandidate 分层校验

现状签名（`src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts`）：

```typescript
export function validateScenarioBlueprintCandidate(
  candidate: ScenarioBlueprintCandidate,
  context: ScenarioValidationContext   // 含 profile 与 policy
): ValidateScenarioBlueprintResult;
```

新增 `phase` 字段到 `ScenarioValidationContext`（默认 `"opening"` 以兼容现有调用点）：

```typescript
export type ScenarioValidationContext = {
  readonly profile: ...;
  readonly policy: BudgetPolicy;
  readonly phase: "opening" | "runtime_expansion";   // 新增
};
```

- `phase: "opening"`：校验起始锚点完整性、`prologue` 必产、`locations/npcs/quests` 各1个、`items/enemies/endings` 为空
- `phase: "runtime_expansion"`：校验新增 location/npc/quest/ending 的 ID 格式与引用完整性
- 注意：现有 `endings` 校验全部委托 `validateQuestGraph`（本文件无直接 endings 校验）。`runtime_expansion` 阶段需在 `validateQuestGraph` 调用前放宽 endings 数量约束（当前要求"恰 2 个可达结局"等预算约束只适用于 `opening` 阶段）

### createFallbackBlueprint 拆分

- **开局 fallback**：只生成起始锚点（`loc_1`+`npc_1`+`quest_main_1`）+序幕+结局方向。`FALLBACK_TEMPLATE_VERSION` 升至 `"fallback-8"`
- **运行时 fallback**（新增 `createRuntimeFallbackExpansion`）：AI 场景生成失败时确定性产出最小剧情推进（单地点/NPC），保证游戏不卡死

### 开局 AI Prompt 收窄

`scenarioPrompt.ts`（位于 `src/game/application/server/ai/`）只要求 AI 生成起始锚点+序幕+结局方向，不再要求产出所有地点/NPC/任务/敌人/结局的完整蓝图。

## NPC对话层与场景生成重构

### dialogue_choice 废除

完全删除 `dialogue_choice` intent 及其规则投影路径：

- `src/game/gameplay/rpg/actions/dialogueChoices.ts` — 删除
- `src/game/gameplay/rpg/actions/intents.ts` — 删除 `dialogue_choice` 类型
- `src/game/gameplay/rpg/actions/validateIntent.ts` — 删除校验（`INVALID_DIALOGUE_CHOICE`/`DIALOGUE_CHOICE_UNAVAILABLE`）
- `src/game/gameplay/rpg/actions/resolveAction.ts` — 删除 case
- `src/game/gameplay/rpg/actions/index.ts` — 删除 `dialogueChoices` re-export
- `src/app/api/game/actions/actionHandler.ts` — 删除白名单
- `performAction.ts` 的 `isRepeatGreet` 局部变量（L395-398，const 声明非函数）依赖 `parseDialogueChoiceKind` 判定 `dialogue_choice` + `greet` + 已 met 的重复场景，随 `dialogue_choice` 删除一并移除

### talk intent 升级（复用现有 intent，非新增）

**现状核实：`talk` intent 已存在**（`intents.ts`、`validateIntent.ts`、`resolveAction.ts`、`actionHandler.ts` 白名单、UI `SceneActionPanel.tsx` 全链路已就绪）。其行为与 spec 目标完全一致：首遇写 `met=true` + `npc_met` 事件（含 `interactionKind: "greet"` 与 Phase 13 关系值）。因此**不新增 `talk_to_npc`，升级现有 `talk` intent**：

```typescript
// 现有 intent 保持 type: "talk"（不更名，避免全链路改名成本）：
export type TalkIntent = { readonly type: "talk"; readonly npcId: NpcId };
```

`resolveAction` 的 `talk` case 增强：
- 校验 NPC 在当前地点（现有已校验）
- 首遇时写 `met=true` + `npc_met` 事件（现有已实现，保留 `interactionKind: "greet"`）
- 排队 pending 场景（由 `performAction` 统一排队逻辑处理，携带 `triggerContext: { kind: "talk", npcId, isFirstMeeting }`）

### NPC对话面板统一为 AI 情境选项

`locationAdventureView.projectDialogues`（内部函数，现有名称；spec 旧述 `projectNpcDialogueView` 不存在）改为：
- 若 `narrative.currentScene` 包含此 NPC：显示场景对白（`npcDialogues`/`npcLine`）+ 情境选项（`choices`）
- 否则：显示"点击交谈"提示，点击提交 `talk` intent

### 场景生成扩展

`orchestrateNarrativeScene` 三角色生成（`src/game/application/orchestrateNarrativeScene.ts`）：
1. 导演提议场景结构（含 `focusNpcId`、`proposedNewNpcs/Locations`、新增 `proposedEnding?`）
2. 编剧产出 `narration` + `npcDialogues` + 2个情境选项（每个绑定 actionKey）；`SceneScriptProposal` 新增多 NPC 对白指令（现状仅单 `npcInstruction`）
3. NPC演员产出每个 presentNpc 的对白分页
4. 选项 actionKey 审批（必须映射合法 `PlayerIntent`）
5. 蓝图扩展审批（新地点/NPC/结局）

### narrative_choice 自动排队下一场景

**现状核实：`performAction` 末尾统一排队逻辑已对所有非 offline intent 生效**（`narrative_choice` 成功后经 `canQueueRuntimeNarrativeScene` 自动排队下一 pending 场景）。本次仅补充：

- 排队时携带 `triggerContext: { kind: "narrative_choice_followup", previousChoiceActionKey }`（现状 pending 无 triggerContext）
- 玩家选择直接驱动后续剧情生成（排队语义本身保留现状）

### 自由输入处理（保留 Phase 12 机制）

- `classifyFreeDialogue` 纯规则分类（零 AI、零 IO、零随机）
- `narrative`：排队 pending 场景，`playerNpcChat` + `triggerContext` 喂给导演
- `chat`：确定性闲聊兜底（`composeNpcCasualReply`）
- 关系值 ±3（Phase 13 机制保留）

## 结局推演机制

### 主线幕数追踪

```typescript
// src/game/gameplay/rpg/quests/storyProgression.ts（新增，与 reconcileQuests/resolveEnding 同目录；
// 原计划 story/ 新目录不必要，避免零语义新目录）

export function reconcileMainStoryProgress(
  blueprint: ScenarioBlueprint,
  state: GameState,
  deps: ReconcileQuestsDependencies   // 复用 reconcileQuests 的依赖类型（代码现状即此名，非 QuestDeps）
): { currentAct: number; shouldProposeEnding: boolean };
```

`currentAct` 派生：统计 `state.quests` 中已完成/关闭的 `kind === "main"` 任务数量。**调用时机**：在 `reconcileQuests` 之后由 `performAction` 调用（`reconcileQuests` 现状不更新 `mainStoryProgress`，需在 `performAction` 编排中显式调用 `reconcileMainStoryProgress` 并写回 `state.mainStoryProgress.currentAct`）。`currentAct >= endingDirection.lockedAt` 且未提议过结局 → `shouldProposeEnding = true`。

### 导演提议结局

`DirectorProposal`（`src/game/gameplay/rpg/narrative/types.ts`）新增 `proposedEnding?: ProposedEnding`。`orchestrateNarrativeScene` 在 `shouldProposeEnding` 时允许导演提议结局。

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
4. `already_proposed`：已提议过（防重复，读 `mainStoryProgress.endingProposed`）
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

**现状核实：`resolveEnding` 对 `endings[]` 为空已是安全行为**——for 循环不执行，直接返回 `{ state, events: [] }`（`ResolveEndingResult`），不触发结局、正常推进。因此**不改变返回类型为 `null`**（会破坏 `performAction` 中 `endingResult.state` 解构）。本次调整仅：

- 保持现有安全语义不变（`endings[]` 为空 → 无结局触发）
- 运行时追加 `endings[]` 后，现有 requirements 检查（`quest_completed`/`quest_failed`/`fact_discovered`）自动生效，无需改动

### 导演 Prompt 扩展

导演 prompt 构造位于 `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`（spec 旧述 `directorPrompt.ts` 不存在）。在 `endingProposalAllowed === true` 时扩展 director prompt，允许导演提议结局。

### 结局 fallback

若 AI 始终未提议结局（`currentAct` 达 `endingDirection.lockedAt + 1` 时仍无提议），运行时 fallback 产出确定性结局（基于已完成任务）。

## 序幕UI与小镇入口过滤

### PrologueScreen 组件

新增 `src/components/PrologueScreen.tsx`：
- 黑底白字全屏展示序幕文本
- 逐字/逐句淡入动画（`tone` 影响速度：epic 80ms/字，其他 50ms/字）
- 点击或按任意键跳过（先显示全文，再次点击进入游戏）
- 播放完毕触发 `onComplete` 回调

### 序幕播放流程

`CurrentGameScreen` 根协调器（数据经 `gameSessionView` 投影 `prologue`/`prologueShown`）：
- `prologueShown === false && openingScene.prologue` → 显示 `PrologueScreen`
- `onComplete` → `POST /api/game/prologue/ack`（CAS 写 `prologueShown=true`）
- `prologueShown === true` → 正常游戏界面

### ack_prologue 与 API 的关系（单一入口，经 performAction 但跳过排队）

**方案：`ack_prologue` 作为内部 intent，经现有 `performAction` 统一入口 + CAS 幂等写 `prologueShown=true`**。`POST /api/game/prologue/ack` route 只是 HTTP 适配，内部调用 `performAction`（复用 revision 检查与 CAS 语义），避免出现第二条绕过规则写入的路径。

**关键**：`performAction` 末尾的统一排队逻辑（`canQueueRuntimeNarrativeScene`，L385-405）对所有非 offline intent 生效。`ack_prologue` 是纯幂等标记，**不得触发 pending 场景排队**。因此必须在排队逻辑中显式排除 `ack_prologue`（intent 类型过滤），或在 `ack_prologue` case 提前 return 跳过末尾排队。

```typescript
// intents.ts 新增（仅服务器内部使用；actionHandler 白名单一并放行）：
export type AckPrologueIntent = { readonly type: "ack_prologue" };
```

`validateIntent`/`resolveAction` 各新增 `ack_prologue` case（纯幂等：置 `prologueShown=true`，零事件）。`performAction` 排队逻辑新增 `ack_prologue` 到跳过列表。

> 注：原 spec 同时新增 route 与 intent 两条写入路径，存在重复入口风险；实现时必须收敛为单一入口（route 委托 performAction），不可两边直接写库。

### 小镇入口过滤

`townRuntimeView.projectTownLayerView` 修改签名——**现状签名 `(blueprint, town)` 不含 state，无法读取 `npcState.met`**。新增 `state: GameState` 参数（调用点 `locationAdventureView.ts` 同步传入）：

```typescript
export function projectTownLayerView(
  blueprint: ScenarioBlueprint,
  town: TownRuntimeState,
  state: GameState      // 新增：读取 npcState.met 与 active quest 的 talk_to_npc objective
): TownLayerView;
```

`interactiveBuildings` 投影判定逻辑（新增两层过滤）：
1. NPC 已被玩家结识（`npcState.met === true`）
2. 或 NPC 被 active quest 的 `talk_to_npc` objective 指向

不满足两条件的建筑：占位图，不可点击，无"进入"按钮。

`TownLayerView` 新增 `allBuildings` 字段（所有建筑，含不可进入，用于渲染占位图）。

## 测试与验收策略

### 测试分层

| 层级 | 范围 | 关键测试用例 |
|---|---|---|
| domain 单测 | 类型契约、纯函数 | schemaVersion=2 字段契约；`PrologueDefinition` 字段必填（`text`/`tone` 非空，`prologue?` 本身可选以兼容旧档）；`NarrativeTriggerContext` 联合类型穷举；`ProposedEnding` 结构校验；`reconcileMainStoryProgress` 纯函数 |
| gameplay 单测 | 规则、分类器、审批闸门 | `validateScenarioBlueprint("opening")` 拒绝空 prologue/多地点开局；`approveEndingProposal` 8步闸门全路径；`createFallbackBlueprint` 仅产1地点1NPC1任务；`createRuntimeFallbackExpansion` 确定性产出 |
| application 集成 | use case + SQLite | `createGame` 开局只落起始锚点；`performAction(talk)` 首遇写 `npc_met` + 排队 pending（携带 triggerContext）；`narrative_choice` 排队补充 triggerContext；结局提议 + 蓝图扩展同一次 CAS |
| API 契约 | HTTP adapter | `POST /api/game/prologue/ack` 幂等性；`talk` 白名单保留；旧 `dialogue_choice` 返回 400 |
| UI 组件 | React 渲染与交互 | `PrologueScreen` 动画 + 跳过；`NpcDialoguePanel` 统一渲染；`TownLayerScreen` 非可进入建筑无进入按钮；`CurrentGameScreen` 序幕优先级 |
| 边界守卫 | `dependencyBoundaries.test.ts` | `dialogueChoices` 删除后守卫清理；新增模块 deep-import 守卫 |
| 回归 | 三题材完整旅程 | 离线模式：开局 fallback + 运行时 fallback 推进至结局；AI 模式：fixture 回放完整旅程 |

### 关键回归测试

```typescript
// src/game/application/phase14ProgressiveGenerationRegression.test.ts（新增）

describe("Phase 14 渐进式生成与剧情推演", () => {
  test("开局蓝图只含起始锚点");
  test("序幕播放后 prologueShown=true");
  test("talk 首遇写 npc_met 并排队 pending");
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
| `src/game/gameplay/rpg/quests/storyProgression.ts` | 主线幕数追踪（与 reconcileQuests 同目录） |
| `src/game/gameplay/rpg/narrative/approveEndingProposal.ts` | 结局提议闸门审批 |
| `src/game/gameplay/rpg/narrative/applyEndingToBlueprint.ts` | 结局追加到蓝图 |
| `src/game/gameplay/rpg/scenario/createRuntimeFallbackExpansion.ts` | 运行时 fallback |
| `src/components/PrologueScreen.tsx` | 序幕组件 |
| `src/app/api/game/prologue/ack/route.ts` | 序幕确认 API（委托 performAction） |
| `src/game/application/phase14ProgressiveGenerationRegression.test.ts` | 回归测试 |
| `scripts/phase14Journey.mjs` | AI 旅程录制/回放（镜像 `phase10Journey.mjs`） |
| `data/fixtures/phase14-journey/v1/` | golden fixture |

### 修改文件

| 文件 | 变更 |
|---|---|
| `src/game/domain/scenarioBlueprint.ts` | schemaVersion 2；Shape 新增 `startAnchor`/`endingDirection`；`SceneDefinition` 新增 `prologue?`；新增 `EndingTone`/`ProposedEnding`（泛型模板 `EndingDirectionOf`） |
| `src/game/domain/narrative.ts` | `NarrativeSceneState` 新增 `npcDialogues?`；`NarrativeChoiceState` 新增 `hint?`/`narrativeIntent?`；`NarrativeGenerationState.pending` 新增 `triggerContext`；新增 `NarrativeTriggerContext`/`NpcDialogueInScene` |
| `src/game/domain/gameState.ts` | 新增 `prologueShown`/`mainStoryProgress`（`stateVersion` 保持 1） |
| `src/game/application/scenarioGeneration.ts` | `SCENARIO_CANDIDATE_CONTRACT_VERSION` 升级 `scenario-dynamic-v3` |
| `src/game/application/server/ai/liveScenarioCandidateSource.ts` | 候选源适配新契约（起始锚点+结局方向） |
| `src/game/application/server/ai/fixtureScenarioCandidateSource.ts` | fixture 适配新契约（`data/base` 与 manifest 同步） |
| `src/game/application/server/ai/scenarioResponseFormat.ts` | JSON Schema 收窄（仅起始锚点+结局方向+序幕） |
| `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts` | 函数 `validateScenarioBlueprintCandidate`（非 `validateScenarioBlueprint`）的 `ScenarioValidationContext` 新增 `phase: "opening" \| "runtime_expansion"` 字段；`runtime_expansion` 阶段放宽 `validateQuestGraph` 的 endings 数量约束 |
| `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts` | 拆分为开局 fallback（`FALLBACK_TEMPLATE_VERSION` → `fallback-8`） |
| `src/game/application/server/ai/scenarioPrompt.ts` | 开局 prompt 收窄 |
| `src/game/gameplay/rpg/actions/dialogueChoices.ts` | **删除** |
| `src/game/gameplay/rpg/actions/intents.ts` | 删除 `dialogue_choice`；`talk` 保留（升级语义）；新增 `ack_prologue` |
| `src/game/gameplay/rpg/actions/index.ts` | 删除 `dialogueChoices` re-export；保留 `talk`/`npcSpeech`/`classifyFreeDialogue` |
| `src/game/gameplay/rpg/actions/validateIntent.ts` | 删除 `dialogue_choice` 校验；`talk` 校验保留；新增 `ack_prologue` |
| `src/game/gameplay/rpg/actions/resolveAction.ts` | 删除 `dialogue_choice` case；`talk` case 保留；新增 `ack_prologue` |
| `src/app/api/game/actions/actionHandler.ts` | 删除 `dialogue_choice` 白名单；`talk` 白名单保留；新增 `ack_prologue` |
| `src/game/application/locationAdventureView.ts` | `projectDialogues` 从 `narrative.currentScene` 读取；`projectTownLayerView` 调用传 `state` |
| `src/game/application/orchestrateNarrativeScene.ts` | 编剧产出 `npcDialogues`；NPC演员产出对白分页；结局提议审批 |
| `src/game/application/performAction.ts` | 删除 `isRepeatGreet`（依赖 `parseDialogueChoiceKind`）；`talk` 排队携带 `triggerContext`；`narrative_choice` 排队补充 `triggerContext`（排队语义现状已有） |
| `src/game/application/handleNpcDialogue.ts` | 触发 pending 时携带 `triggerContext.free_input` |
| `src/game/gameplay/rpg/narrative/types.ts` | `DirectorProposal` 新增 `proposedEnding?`；`SceneScriptProposal` 扩展多 NPC 对白指令 |
| `src/game/gameplay/rpg/quests/resolveEnding.ts` | 无签名变更（空 `endings[]` 现状已安全，仅补注释/测试） |
| `src/game/application/server/ai/liveRuntimeNarrativeSources.ts` | director prompt 在 `endingProposalAllowed` 时扩展 |
| `src/game/application/townRuntimeView.ts` | `projectTownLayerView` 新增 `state` 参数；`interactiveBuildings` 加过滤；新增 `allBuildings` |
| `src/game/application/gameSessionView.ts` | 投影 `prologue`/`prologueShown` 给 UI；`NarrativeSceneView` 扩展 `npcDialogues`（多 NPC 对白） |
| `src/components/CurrentGameScreen.tsx` | 序幕优先级 |
| `src/components/AdventureGameShell.tsx` | `handleDialogueChoice`（提交 `dialogue_choice`）改为提交 `talk`/渲染新对话视图 |
| `src/components/NpcDialoguePanel.tsx` | 统一渲染场景对白+情境选项 |
| `src/components/TownLayerScreen.tsx` | 非可进入建筑无进入按钮 |
| `src/game/application/server/persistence/sqliteGameRepository.ts` | `interpretGameRow` 版本检查接受 schemaVersion 1/2；新增 `withPrologueDefault`/`withMainStoryProgressDefault` 加入 `with*Defaults` 组合链推导新字段（沿用零迁移模式） |
| `src/app/globals.css` | `.prologue-screen` 样式 |

## 兼容性

- **旧存档**：`with*Defaults` 组合链（新增 `withPrologueDefault`/`withMainStoryProgressDefault`）推导 `prologueShown`/`mainStoryProgress`/`startAnchor`/`endingDirection`，不回写；`interpretGameRow` 版本检查放宽为接受 `schemaVersion` 1 或 2
- **旧 `dialogue_choice` 历史事件**：保留只读，不影响新逻辑
- **旧存档 `npcs[].met`**：新逻辑首次点击 `talk` 会写 `npc_met`，行为等价
- **`talk` intent**：现有全链路（intents/validateIntent/resolveAction/actionHandler/UI）保留并升级，无破坏性变更
- **`narrative_choice` 路径**：完全保留，新增自动排队下一场景
- **Phase 10 离线模式**：保留，开局 fallback 使用固定起始锚点
- **Phase 11 storyMemory**：保留
- **Phase 13 关系值系统**：保留

## Phase 划分

建议拆分为 **Phase 14**（渐进式生成与剧情推演），下属子任务：

1. 数据结构变更（schemaVersion 2 + 迁移）
2. 开局生成层收窄（fallback 拆分 + AI prompt + validate 分层）
3. `dialogue_choice` 废除 + `talk` 升级（复用现有 intent）
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
