# AI 驱动 RPG 架构重新梳理设计 Spec

> 文档版本：v1.0
> 日期：2026-08-07
> 定位：重新规划 AI 实时演算 RPG 的整体运行架构，为后续开发建立合理且可演进的目标架构
> 参考文档：`docs/设想/AI实时演算RPG_核心规则与运行架构总纲_v0.1.md`（仅做参考）
> 核心目标：游戏是一个由 AI 驱动、玩家选择决定故事推进、既有规则判断、每个人的游戏世界都是独有的 RPG 游戏

---

## 1. 设计目标与约束

### 1.1 目标

重新规划游戏整体架构，使其满足：

- **AI 驱动故事**：AI 是动态叙事的核心创意来源，但所有世界事实变化必须经规则审批
- **玩家选择真实改变世界**：不同玩家从相同世界设定出发，因行动不同形成不同故事
- **规则独占事实**：AI 可以提议，但规则引擎是唯一的事实裁判和状态写入者
- **可演进**：架构支持从短篇 MVP 到长篇开放世界的逐步扩展

### 1.2 核心设计原则

> **玩家决定意图 → AI 提出推演 → 规则裁定事实 → 状态记录世界 → AI 呈现故事**

五者不可混为一体：

1. **玩家**决定自己想做什么（Interaction）
2. **ActionConverter**将玩家操作转为标准 Action
3. **规则引擎**判断合法性、计算数值、产出确定结果（ResolvedEvent）
4. **规则引擎**审批 AI 的世界扩展提议，决定是否写入状态
5. **AI 叙事层**把已确认的结果表现为场景、对白、选项和资产任务

### 1.3 不应变成什么

- 提前生成整棵剧情树
- 玩家选择看似很多但最终回到同一条固定剧情
- AI 无视数值、物品、地点和人物关系随意编造
- 每个 NPC 知道全世界所有秘密
- AI 负责保存世界事实，出现前后矛盾和"失忆"
- 为了追求自由输入放弃游戏规则和可玩性

---

## 2. 顶层架构：严格流水线

### 2.1 主循环流水线

游戏主循环是一条不变流水线，由七个阶段组成。**World State 和 Story State 只在 StateCommit 阶段被写入**，其余阶段只读。

```
┌────────────┐    ┌────────────────┐    ┌────────────┐    ┌─────────────────┐    ┌────────────┐    ┌────────────────┐    ┌────────┐
│ Interaction │→ │ ActionConverter │→ │ RuleEngine  │→ │ ExpansionProposer│→ │ StateCommit  │→ │ SceneGenerator  │→ │ Client │
└────────────┘    └────────────────┘    └────────────┘    └─────────────────┘    └────────────┘    └────────────────┘    └────────┘
                   ↑ 自由文本经轻量       ↑ 读 World+Story     ↑ 条件触发 AI        ↑ 唯一写入点       ↑ 读 World+Story     ↑ 立即渲染
                   │ 意图解析             │ 规则裁决            │ 规则审批            │ CAS 原子写入      │ 一次 AI 调用        │ 资产异步
```

### 2.2 各阶段职责

| 阶段 | 输入 | 输出 | 职责 |
|---|---|---|---|
| **Interaction** | 玩家原始操作 | `Interaction`（点击或文本） | 接收固定选项点击（已携带 Action）或自由文本输入 |
| **ActionConverter** | `Interaction` + 当前可用行动 | `Action` | 固定选项直接映射；自由文本经轻量意图解析归类到封闭 Action 集合，无法归类降级为 `freeform` |
| **RuleEngine** | `Action` + World State + Story State | `ResolvedEvent` | 裁决合法性、计算数值变化、产出确定结果。不写入状态 |
| **ExpansionProposer** | `ResolvedEvent` + World State + Story State | `ExpansionProposal[]`（已审批） | 条件触发：仅当规则发现"世界不够用"时调用 AI 提议新实体。规则审批后才输出 |
| **StateCommit** | `ResolvedEvent` + `ExpansionProposal[]` | 新 World State + 新 Story State | 唯一的状态写入点。CAS 原子写入 |
| **SceneGenerator** | 新 World State + 新 Story State + `ResolvedEvent` | `ScenePackage` | 一次 AI 调用生成完整场景包。失败时确定性 fallback |
| **Client** | `ScenePackage` | 渲染 | 立即渲染文本和选项；资产生成异步执行 |

### 2.3 AI 调用次数

| 路径 | AI 调用次数 | 说明 |
|---|---|---|
| 固定选项 + 无需世界扩展 | 1 次（SceneGenerator） | 最常见路径，延迟最低 |
| 固定选项 + 需要世界扩展 | 2 次（ExpansionProposer + SceneGenerator） | 规则发现世界不够用时触发 |
| 自由文本 + 无需世界扩展 | 2 次（ActionConverter + SceneGenerator） | 多一次轻量意图解析 |
| 自由文本 + 需要世界扩展 | 3 次（ActionConverter + ExpansionProposer + SceneGenerator） | 最慢路径，但仍可接受 |

ActionConverter 的意图解析使用更快、更小的模型，严格限制输出长度。

---

## 3. 两个核心状态

### 3.1 World State——所有客观世界事实

World State 是世界中所有客观事实的唯一来源。它同时包含**世界定义**（地点/NPC/物品的结构化定义）和**运行时状态**（已到访/已结识/已发现等）。取消独立的 Blueprint 概念——开局生成的"蓝图"就是初始 World State，之后通过 AI 提议 + 规则审批演化。

```typescript
type WorldState = {
  /** 版本号，用于迁移 */
  readonly version: number;
  /** 生成元数据 */
  readonly generation: GenerationMetadata;

  // ── 玩家状态 ──
  readonly player: PlayerState;

  // ── 地点（定义 + 运行时） ──
  readonly locations: readonly LocationEntry[];
  readonly currentLocationId: LocationId;
  readonly unlockedLocationIds: readonly LocationId[];
  readonly visitedLocationIds: readonly LocationId[];

  // ── NPC（定义 + 运行时 + 记忆） ──
  readonly npcs: readonly NpcEntry[];

  // ── 物品（定义 + 持有状态） ──
  readonly items: readonly ItemEntry[];
  readonly inventory: readonly ItemId[];

  // ── 世界事实（定义 + 发现状态） ──
  readonly worldFacts: readonly WorldFactEntry[];

  // ── 任务（定义 + 进度状态） ──
  readonly quests: readonly QuestEntry[];

  // ── 敌人（定义 + 击败状态） ──
  readonly enemies: readonly EnemyEntry[];
  readonly defeatedEnemyIds: readonly EnemyId[];

  // ── 战斗运行时状态 ──
  readonly battle: BattleState;

  // ── 结局定义 + 抵达状态 ──
  readonly endings: readonly EndingEntry[];
  readonly ending: EndingState | null;

  // ── 阵营关系 ──
  readonly factions: readonly FactionEntry[];

  // ── 小镇规划（按地点懒生成） ──
  readonly towns: readonly TownRuntimeState[];

  // ── 追加式事件账本（世界事实变化的完整审计日志） ──
  readonly eventLedger: readonly GameEvent[];
};
```

**关键设计决策：**

- **地点/NPC/物品/任务/敌人/结局/事实都是"Entry"类型**，包含定义字段和运行时字段。例如 `LocationEntry` 既有 `name`/`description`/`connectedLocationIds`（定义），也通过 `visitedLocationIds` 等集合追踪运行时状态。
- **运行时扩展通过追加实现**：新地点/NPC 通过 AI 提议 + 规则审批后追加到对应数组，已有实体的定义字段不可变（保证世界一致性）。
- **事件账本是世界事实变化的完整记录**，用于审计、回放和 Story State 的派生视图。

### 3.2 Story State——故事节奏与控制

Story State 采用混合策略：**核心指标独立持久化**（由规则根据事件 + AI 提议显式更新），**派生视图从事件账本纯投影**（不独立存储）。

```typescript
type StoryState = {
  // ── 独立持久化的核心指标 ──
  readonly version: number;

  /** 当前幕数（1 基） */
  readonly currentAct: number;
  /** 预计总幕数（由游戏长度决定） */
  readonly targetActs: number;
  /** 故事进度 0-100 */
  readonly storyProgress: number;
  /** 当前张力值 0-100 */
  readonly tension: number;
  /** 当前节奏需要：下一幕应该做什么 */
  readonly nextPacingNeed: PacingNeed;
  /** 剧情预算余量 */
  readonly budget: StoryBudget;
  /** 未回收的伏笔列表 */
  readonly unresolvedThreads: readonly ThreadId[];
  /** 结局锁定状态 */
  readonly endingAllowed: boolean;
  /** 结局已提议 */
  readonly endingProposed: boolean;
  /** 叙事运行时状态（当前场景 + 生成状态） */
  readonly narrative: NarrativeRuntimeState;
  /** 序幕已播放 */
  readonly prologueShown: boolean;

  // ── 派生视图（从 World State 的事件账本投影，不独立存储） ──
  // recentBeats: 从 eventLedger 投影最近 N 条关键事件
  // npcContacts: 从 eventLedger 投影各 NPC 最近接触记录
};
```

**核心指标说明：**

| 指标 | 范围 | 更新方式 | 说明 |
|---|---|---|---|
| `currentAct` | 1 ~ targetActs | 规则根据任务完成数推导 | 当前处于(第几幕)，由主线任务进度决定 |
| `tension` | 0-100 | 规则根据事件类型显式更新 | 战斗+、发现关键线索+、闲聊-、休息-。AI 不直接设值，但可以通过提议事件间接影响 |
| `nextPacingNeed` | 枚举 | 规则根据张力+幕数+进度推导 | `reveal`/`complicate`/`escalate`/`climax`/`resolve`。指导 AI 生成场景的方向 |
| `budget` | 见下文 | 规则在扩展时扣减 | 已用/最大值对，控制世界扩张上限 |
| `unresolvedThreads` | ThreadId[] | 规则在事件发生时追加/回收 | 追踪未闭合的剧情线 |
| `endingAllowed` | boolean | 规则根据进度+伏笔+幕数推导 | 是否允许进入结局 |

**派生视图（不持久化，每次从事件账本投影）：**

- `recentBeats`：从 `eventLedger` 取最近 N 条关键事件（任务完成、事实发现、NPC 初遇、战斗结果等），供 AI 场景生成使用
- `npcContacts`：从 `eventLedger` 投影各 NPC 的最近接触记录（回合、地点、交互类型），用于 NPC 记忆的连续性

### 3.3 Story Budget

```typescript
type StoryBudget = {
  /** 已使用 / 上限 */
  readonly locations: { readonly used: number; readonly max: number };
  readonly npcs: { readonly used: number; readonly max: number };
  readonly quests: { readonly used: number; readonly max: number };
  readonly events: { readonly used: number; readonly max: number };
  /** 硬上限（安全阀，任何情况下不可超过） */
  readonly hardLimit: { readonly locations: number; readonly npcs: number };
};
```

预算由游戏长度档位决定（短篇/中篇/长篇/开放）。`max` 为软上限——达到后 ExpansionProposer 优先复用已有实体而非新建。`hardLimit` 为不可逾越的安全阀。

---

## 4. Action 与 Interaction 模型

### 4.1 Interaction——玩家原始操作

Interaction 是玩家在客户端做出的原始操作，分为两类：

```typescript
type Interaction =
  | { readonly kind: "fixed_choice"; readonly choiceToken: string }
  | { readonly kind: "free_text"; readonly text: string; readonly targetNpcId?: NpcId };
```

- **fixed_choice**：点击固定选项，`choiceToken` 在服务端映射到已批准的 Action
- **free_text**：自由文本输入，可选 `targetNpcId` 表示对某 NPC 说话

### 4.2 Action——标准行动（封闭集合 + freeform 兜底）

```typescript
type Action =
  | { readonly type: "talk"; readonly npcId: NpcId }
  | { readonly type: "move"; readonly locationId: LocationId }
  | { readonly type: "explore" }
  | { readonly type: "investigate"; readonly factId: FactId }
  | { readonly type: "take_item"; readonly itemId: ItemId }
  | { readonly type: "use_item"; readonly itemId: ItemId; readonly targetId?: string }
  | { readonly type: "give_item"; readonly itemId: ItemId; readonly targetNpcId: NpcId }
  | { readonly type: "attack"; readonly enemyId: EnemyId }
  | { readonly type: "battle_action"; readonly action: "attack" | "guard" | "flee" }
  | { readonly type: "interact"; readonly targetId: string }
  | { readonly type: "rest" }
  | { readonly type: "accept_quest"; readonly questId: QuestId }
  | { readonly type: "narrative_choice"; readonly choiceToken: string }
  | { readonly type: "ack_prologue" }
  | { readonly type: "freeform"; readonly intent: string; readonly rawText: string };
```

**设计原则：**

- Action 是**固定的封闭枚举**（除 `freeform`），因为游戏玩法的表现形式是固定的
- `freeform` 是兜底类型：规则只记录玩家意图，**不执行任何实质世界变化**；AI 可以让 NPC 做出反应（疑惑、追问、闲聊），但不改变 World State 或 Story State
- 玩家输入"我的武功突然升到一百级" → 解析为 `freeform` → 规则不改变等级 → AI 让 NPC 表示疑惑

### 4.3 ActionConverter 转换逻辑

```
fixed_choice → 查表映射到对应 Action（已由服务端预批准）
free_text → 轻量意图解析（小模型）→ 尝试归类到封闭 Action 集合
           ├─ 归类成功 → 输出对应 Action
           └─ 无法归类 → 输出 freeform Action
```

**防声明结果**：玩家输入表达的是**意图**，不代表事实已发生。`freeform` 的 `intent` 字段只是语义标签，规则引擎不接受任何 `freeform` 请求的世界变化效果。

---

## 5. 规则引擎

### 5.1 职责

规则引擎是唯一的事实裁判，负责：

- 验证行动是否合法（目标存在、玩家有权限、条件满足）
- 检查玩家是否拥有所需能力、物品、位置或权限
- 计算战斗、伤害、命中、资源消耗和奖励
- 计算探索、调查、交涉、欺骗等行为的成功与失败
- 更新玩家属性、背包、任务、关系和阵营状态
- 判断事件触发条件是否满足
- 检查 AI 提议的新内容是否违反世界观、预算或已有事实
- 产出一份不可歧义的 `ResolvedEvent`

### 5.2 ResolvedEvent——规则层的确定结果

```typescript
type ResolvedEvent = {
  readonly actionId: string;
  readonly status: "success" | "partial_success" | "failure" | "blocked" | "invalid";
  readonly eventKind: NarrativeEventKind;
  readonly facts: readonly FactChange[];
  readonly stateChanges: readonly StateChange[];
  readonly costs: readonly Cost[];
  readonly rewards: readonly Reward[];
  readonly triggeredEvents: readonly string[];
  readonly rejectedEffects: readonly RejectedEffect[];
  readonly stateVersion: number;
};
```

**状态支持多种结果**，不是只有成功/失败：

- `success`：行动完全成功
- `partial_success`：部分成功（如威胁老板：老板承认见过商队，但好感下降、卫兵警觉）
- `failure`：行动失败，有后果
- `blocked`：行动被阻止（如战斗中试图移动）
- `invalid`：行动不合法（如目标不存在）

AI 根据 `ResolvedEvent` 写叙事，但**不能把 `partial_success` 擅自写成彻底成功**。

### 5.3 规则引擎内部结构

规则引擎按 Action 类型路由到对应的纯函数 resolver：

```
RuleEngine(action, worldState, storyState)
  → validateAction(action, worldState)     // 合法性检查
  → resolveByType(action, worldState)      // 数值计算 + 状态变更指令
  → reconcileQuests(worldState)            // 任务进度推进
  → resolveEnding(worldState, storyState)  // 结局条件检查
  → updateStoryMetrics(storyState, events) // 张力/进度/节奏更新
  → ResolvedEvent
```

每个子步骤都是纯函数，不写入状态，只产出计算结果。

### 5.4 规则与 AI 的职责边界

| 方面 | 规则负责 | AI 负责 |
|---|---|---|
| NPC 对话 | NPC 是否在场、是否愿意交流、知道哪些信息、关系变化 | NPC 的具体说法、语气、情绪、潜台词 |
| 探索 | 可探索内容、隐藏物是否存在、调查能力判定、发现什么 | 环境描写、发现过程、线索联系、气氛悬念 |
| 战斗 | 回合顺序、命中伤害、技能消耗、敌人死亡、战利品 | 动作表现、敌人语言情绪、战斗节奏描述 |
| 物品 | 道具是否存在可拾取、背包容量、所有权、数量变化 | 发现过程、外观叙事意义、NPC 反应 |
| 移动 | 地点是否存在、是否知道、路径可达、进入条件 | 移动过程、转场描述、抵达后场景表现 |

---

## 6. 世界扩展提议机制

### 6.1 触发条件（条件触发式）

ExpansionProposer **不是每回合都调用 AI**。仅当规则引擎发现以下条件之一时才触发：

1. **玩家行动明确需要不存在的实体**：如玩家说"去少林寺"但当前世界无此地点
2. **当前世界没有可复用实体**：如主线需要一个知道森林情况的人，但所有现有 NPC 都不适合
3. **主线或支线需要新冲突**：Story State 的 `nextPacingNeed` 要求引入新冲突，但当前无可用敌对势力
4. **Story State 要求引入变化**：张力持续偏低需要新事件刺激

### 6.2 优先复用，后生成

生成前按以下顺序检查：

1. 是否已有适合的 NPC / 地点 / 物品可以复用
2. 是否可以修改现有实体承担新功能
3. 是否确实必须新建

例如需要一个知道森林情况的人，应优先使用已存在的猎人，而不是立即生成第二个功能相同的 NPC。

### 6.3 提议与审批流程

```
ExpansionProposer 触发
  → AI 返回 ExpansionProposal[]（新地点/NPC/物品/事件/敌人的提案）
  → 逐个审批：
      ├─ 检查预算余量（soft max / hard limit）
      ├─ 检查世界观一致性
      ├─ 检查与已有事实不冲突
      ├─ 检查 ID 唯一性
      └─ 通过 → 加入已审批提案列表；不通过 → 丢弃
  → 输出已审批的 ExpansionProposal[]
```

审批通过的提案在 StateCommit 阶段追加到 World State。审批拒绝的提案只记录日志，不影响游戏流程。

### 6.4 预算耗尽时的行为

当预算达到 soft max 时：

- ExpansionProposer 不再生成新实体，改为优先复用
- Story State 的 `nextPacingNeed` 倾向于 `climax`/`resolve`
- 优先回收伏笔、合并支线、推动关键人物行动、进入高潮或结局

---

## 7. 叙事场景生成

### 7.1 SceneGenerator 输入

AI 只接收最小必要上下文，不接收整个状态：

- 当前玩家状态摘要
- 当前地点状态
- 当前在场 NPC 及其可知信息
- 当前 Story State 核心指标（幕、张力、节奏需要、预算余量）
- 本次 ResolvedEvent
- 最近少量关键事件（派生视图 recentBeats）
- 世界观硬约束
- 输出 JSON Schema

### 7.2 NPC 知识隔离

当酒馆老板说话时，不把其他 NPC 的私人秘密放进他的可见上下文。上下文分层：

- `publicWorldFacts`：公开世界事实
- `sceneVisibleFacts`：当前场景可见事实
- `npcKnownFacts`：该 NPC 已知事实（从 NPC 记忆中读取）
- `npcBeliefs`：该 NPC 的信念和误解
- `npcHiddenMotives`：该 NPC 的隐藏动机
- `forbiddenKnowledge`：该 NPC 不应知道的信息

NPC 是否泄密取决于输入上下文和规则约束，而不是是否为每个 NPC 单独创建 AI Agent。

### 7.3 ScenePackage 输出

一次 AI 调用返回完整结构化场景包：

```typescript
type ScenePackage = {
  readonly sceneId: string;
  readonly presentation: {
    readonly narration: string;
    readonly dialogue: readonly NpcDialogueLine[];
  };
  readonly choices: readonly [ActionChoice, ActionChoice];
  readonly proposals: {
    readonly newEvents: readonly EventProposal[];
  };
  readonly assetRequests: readonly AssetRequest[];
  readonly source: "generated" | "fallback";
};
```

### 7.4 两种提议的区分

系统中存在两种不同层级的 AI 提议，不应混淆：

| 提议来源 | 提议内容 | 触发时机 | 审批方 |
|---|---|---|---|
| **ExpansionProposer** | 新世界**实体**（地点、NPC、物品、敌人） | 规则引擎发现"世界不够用"时条件触发 | 规则引擎（预算、世界观一致性、ID唯一性） |
| **SceneGenerator.proposals** | 新叙事**事件**（如"有人跟踪玩家"、"NPC 暴露背叛"） | 每次场景生成时随场景包返回 | 规则引擎在下一回合 StateCommit 前审批 |

ExpansionProposer 在状态写入**前**运行，审批通过的实体在当前回合就可用。SceneGenerator 的事件提议在状态写入**后**返回，只在下一回合被规则引擎考虑——它不改变当前已提交的状态，而是影响后续的节奏和事件触发。

### 7.5 输出处理

| 字段 | 处理方式 |
|---|---|
| 旁白、对白、情绪标签 | 直接展示 |
| 选项文案 | 直接展示，但 `actionKey` 必须映射到当前合法行动 |
| 新事件提案（SceneGenerator） | 记入 Story State 的候选事件池，下一回合由规则引擎审批 |
| 资产请求 | 异步队列，不阻塞主流程 |

### 7.6 失败降级

- AI 返回非法 JSON：自动一次格式修复；修复仍失败时使用安全降级模板
- AI 叙事与规则冲突：以规则结果为准，丢弃冲突文本，不修改 World State
- 角色失败有界重试后整场确定性 fallback

---

## 8. NPC 记忆系统

### 8.1 每个 NPC 的记忆结构

```typescript
type NpcMemory = {
  readonly npcId: NpcId;

  // ── 已知事实集（从世界事实中分配，不可变追加） ──
  readonly knownFactIds: readonly FactId[];

  // ── 隐藏事实/秘密（该 NPC 知道但不公开的） ──
  readonly hiddenFactIds: readonly FactId[];

  // ── 与玩家的交互历史（有界列表） ──
  readonly interactionHistory: readonly NpcInteraction[];

  // ── 关系状态 ──
  readonly relationship: RelationshipValue;

  // ── 当前情绪/态度 ──
  readonly emotion: NarrativeEmotion;

  // ── NPC 的目标/动机 ──
  readonly goals: readonly string[];
};
```

### 8.2 交互历史条目

```typescript
type NpcInteraction = {
  readonly turn: number;
  readonly locationId: LocationId;
  readonly actionType: string;
  readonly outcome: "positive" | "negative" | "neutral";
  readonly relationshipDelta: number;
  readonly summary: string;  // 规则生成的结构化摘要，非 AI 文本
};
```

### 8.3 裁剪策略

| 内容 | 裁剪规则 |
|---|---|
| `knownFactIds` | **永不裁剪**——世界真相不可丢失 |
| `hiddenFactIds` | **永不裁剪**——秘密是 NPC 身份的一部分 |
| `interactionHistory` | 保留最近 **N 条**（如 N=10），超出截断 |
| `relationship` | 不裁剪，持续演化 |
| `emotion` | 每次交互后由规则更新 |
| `goals` | 由规则在特定事件触发时更新 |

**不需要 AI 生成摘要**——交互历史的 `summary` 字段由规则从行动类型和结果纯函数生成（如"首次见面，好感+5"），保证可重现且不依赖模型。

### 8.4 NPC 记忆如何参与场景生成

SceneGenerator 读取 NPC 记忆时：

- `knownFactIds` → 作为该 NPC 可引用的事实卡
- `interactionHistory` → 最近几条用于对话连续性（"上次你提到…"）
- `relationship` → 决定 NPC 语气和态度（hostile/cold/neutral/friendly/trusted 五档）
- `emotion` → 当前场景的初始情绪基线
- `goals` → 影响 NPC 的对话倾向和提议

---

## 9. 开局初始化

### 9.1 流程

```
NewGameInput
  → validate（世界观、玩家名、身份、长度等字段校验）
  → AI 世界初始化（一次调用，生成完整初始世界）
  → 规则校验（结构完整性、任务可达性、预算合规、双结局存在）
  → 通过 → 初始 World State + 初始 Story State
  → 不通过 → 修复尝试（最多1次）→ 仍失败 → 确定性 fallback 世界
  → 持久化
  → 生成序幕场景
  → 进入主循环
```

### 9.2 初始 World State

AI 生成：

- 世界定义（summary、tone、themes、facts）
- 玩家定义（name、identity、startingLocation、startingItems、baseStats）
- 初始地点（3-5个主地点 + 0-1个隐藏地点，按预算）
- 初始 NPC（4-6个核心 NPC + 0-1个同伴）
- 初始任务（主线3幕骨架 + 0-2个支线）
- 初始敌人、物品、结局（2个）
- 开场场景
- 起始锚点（起始地点、起始 NPC、起始任务）
- 结局方向骨架

### 9.3 初始 Story State

- `currentAct = 1`
- `tension = 起始值`（如 30）
- `storyProgress = 0`
- `nextPacingNeed = "reveal"`（第一幕需要建立目标和冲突）
- `budget` = 满预算（已用 = 初始实体数，max = 按长度档位）
- `unresolvedThreads = [主线thread]`
- `endingAllowed = false`

---

## 10. 节奏与结局控制

### 10.1 节奏不是固定剧本

三幕结构只约束故事节奏，不固定玩家必须做什么：

- **第一幕**：建立目标、人物和初始冲突
- **第二幕**：因玩家行动产生复杂化、代价和新发现
- **第三幕**：收束主要矛盾，根据玩家造成的世界状态形成结局

### 10.2 张力值更新规则

| 事件 | 张力变化 |
|---|---|
| 战斗开始/胜利 | +15 ~ +25 |
| 发现关键线索 | +10 ~ +15 |
| 任务完成 | +5 ~ +10 |
| NPC 首次交谈 | +3 |
| 闲聊/自由输入 | -2 ~ +2 |
| 休息 | -10 |
| 战斗失败/撤退 | -5 ~ -15 |

张力值 clamp 到 [0, 100]。AI 不直接设张力值，但可以通过提议事件间接影响。

### 10.3 节奏需要推导

```typescript
function derivePacingNeed(storyState: StoryState): PacingNeed {
  // 第一幕：建立
  if (currentAct === 1) return "reveal";
  // 张力过低需要新冲突
  if (tension < 30 && currentAct >= 2) return "complicate";
  // 接近高潮
  if (storyProgress > 70 && !endingAllowed) return "escalate";
  // 允许结局且伏笔已回收
  if (endingAllowed && unresolvedThreads.length === 0) return "resolve";
  // 默认推进
  return "develop";
}
```

### 10.4 结局条件

结局不是"走到第 N 个场景"自动发生，需同时考虑：

- 主要冲突已解决或不可逆
- 核心秘密已揭示到足够程度
- 玩家做出关键立场选择
- Story State 允许收束（`endingAllowed = true`）
- 无必须处理的强制事件
- 达到长度上限或预算上限

---

## 11. 持久化与并发

### 11.1 原子写入

StateCommit 使用 compare-and-swap (CAS) 原子写入：

```
applyResolvedAction(gameId, expectedRevision, nextWorldState, nextStoryState)
  → 检查 revision === expectedRevision
  → 通过 → 写入新状态，revision + 1
  → 不通过 → 返回 STALE_GAME_REVISION，客户端刷新后重试
```

### 11.2 幂等性

每个 Action 必须包含唯一 `actionId`。规则层使用幂等机制：

- 同一 Action 不能重复扣除物品
- 不能重复发放奖励
- 不能重复推进任务

### 11.3 状态版本

每次 StateCommit 生成新的 `stateVersion`。SceneGenerator 的输出必须标记基于哪个状态版本。如果玩家已进入新状态，旧生成结果不得覆盖新内容。

### 11.4 pending 场景边界

叙事场景生成是异步的（pending → ensure → CAS 写回）。pending 期间：

- 不允许玩家再次推进世界（安全拒绝"正在编排下一幕，请稍候"）
- `ack_prologue` 例外（纯幂等标记，不推进规则世界）

---

## 12. 与现有架构的差异映射

| 维度 | 现有架构 | 目标架构 | 变化性质 |
|---|---|---|---|
| 状态模型 | `ScenarioBlueprint`（可变）+ `GameState`（单体） | `WorldState`（含定义+运行时）+ `StoryState`（混合） | 合并 Blueprint 进 World State；拆分 Story State |
| AI 提议时机 | 叙事生成阶段（规则裁决后） | 规则引擎阶段（条件触发，写入前） | 提议提前到状态写入前 |
| 张力/节奏 | 无显式 tension；pacing 仅在 storyMemory 派生 | Story State 独立持久化 tension + nextPacingNeed | 新增独立指标 |
| NPC 记忆 | lastContactTurn + lastLocationId + lastInteractionSummary | knownFactIds + interactionHistory(有界) + relationship + emotion + goals | 大幅增强 |
| Action 集合 | PlayerIntent union（无 use_item/give_item/flee/interact/rest） | 扩展封闭集合 + freeform 兜底 | 扩展 + 兜底 |
| 事件结果 | success/failure 二元为主 | success/partial_success/failure/blocked/invalid | 细化结果类型 |
| 世界扩展 | 导演提议 → approveBlueprintExpansion | ExpansionProposer 条件触发 → 规则审批 → StateCommit | 独立阶段，条件触发 |
| Blueprint 扩展 | 运行时追加到 Blueprint（边界模糊） | 追加到 World State（定义不可变，只追加新实体） | 消除 Blueprint 概念 |

---

## 13. 分层与模块边界

```
src/game/
  domain/          # 纯类型与纯函数（零 IO、零 AI、零 DB）
    worldState.ts  # World State 类型与纯函数
    storyState.ts  # Story State 类型与纯函数
    action.ts      # Action / Interaction 类型
    events.ts      # GameEvent 类型
    budget.ts      # 预算策略
    npc.ts         # NPC 记忆类型与纯函数
    relationship.ts
  gameplay/        # 规则逻辑（纯函数，不写状态）
    ruleEngine/    # 规则引擎：validateAction + resolveByType + reconcileQuests + resolveEnding + updateStoryMetrics
    expansion/     # 扩展提议审批规则
    actions/       # 各 Action 类型的 resolver
    battle/        # 战斗规则
    quests/        # 任务推进规则
  application/     # Use case 编排（流水线串联）
    performAction.ts      # 主循环编排
    actionConverter.ts    # Interaction → Action
    expansionProposer.ts  # 条件触发 AI 提议
    sceneGenerator.ts     # 叙事场景生成编排
    stateCommit.ts        # 唯一状态写入点
    createGame.ts         # 开局初始化
    gameSessionView.ts    # Read model 投影
  server/          # 持久化与 AI 适配器
    persistence/   # SQLite adapter, CAS
    ai/            # AI source 适配器
```

### 依赖方向

```
UI/API → application → gameplay → domain
                      ↘ server（仅 application/server/ 组合根）
```

- UI/API 只调用 application facade
- gameplay 不 import application/server
- domain 不 import 任何上层
- server 只在组合根注入

---

## 14. MVP 边界

### 14.1 必须具备

- World State + Story State 双状态模型
- 严格流水线（Interaction → Action → Rule → [Expansion] → Commit → Scene → Client）
- 封闭 Action 集合 + freeform 兜底
- 规则引擎产出 ResolvedEvent（含 partial_success）
- 条件触发的世界扩展提议
- NPC 结构化记忆（已知事实 + 有界交互历史）
- 预算控制（soft max + hard limit）
- 张力/节奏追踪
- 一次 AI 调用的场景生成
- 短篇三幕故事 + 多结局
- 确定性 fallback

### 14.2 暂不追求

- 无限开放世界
- 数百 NPC 同时长期自治
- 复杂经济系统
- 多玩家共享世界
- AI 生成的 NPC 记忆摘要
- 每回合多 Agent 协商
- 预生成多层剧情树

---

## 15. 架构结论

最终运行逻辑可压缩为这条主链：

```
玩家操作（Interaction）
→ 转换为标准 Action
→ 规则验证并裁定（ResolvedEvent）
→ [条件触发] AI 提议世界扩展 → 规则审批
→ 原子写入 World State / Story State（唯一写入点）
→ AI 读取状态 + 变化，生成场景包（旁白、对白、选项、资产任务）
→ 客户端立即渲染，资产异步生成
→ 玩家再次行动
```

必须坚持的规则：

1. **玩家的选择必须真实改变状态**
2. **固定选项和自由输入最终都要转换为 Action**
3. **AI 可以创造和推动故事，但不能绕过规则提交世界事实**
4. **规则引擎负责合法性、数值和状态提交**
5. **AI 负责开放性推演、人物反应、剧情连接和叙事表达**
6. **Story State 控制长度、预算和节奏，但不固定玩家路线**
7. **NPC 的信息边界通过上下文裁剪和知识状态控制**
8. **主要场景尽量一次 AI 调用输出完整 JSON**
9. **图片和重资产异步生成，不阻塞玩家主操作链路**
10. **不预生成完整剧情树，只生成当前一步并维护持续演化的状态**
11. **故事不是预先写出来的，而是玩家行动、规则结果和 AI 推演共同产生的**
12. **每个 NPC 有自己的结构化记忆，交互历史有界裁剪，事实永不裁剪**
