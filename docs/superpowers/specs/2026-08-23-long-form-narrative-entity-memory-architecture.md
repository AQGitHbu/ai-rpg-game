# AI RPG 长篇剧情、实体世界与记忆架构总设计

**状态：** 已确认的目标架构，按阶段实施  
**日期：** 2026-08-23  
**适用范围：** `ai-rpg-game` 的剧情生成、世界状态、NPC 连续性、长期记忆、故事结构与长局运行时  
**首个实施计划：** `docs/superpowers/plans/2026-08-23-narrative-context-compiler.md`

---

## 1. 目的

本设计把当前 AI RPG 从“把若干状态拼进 Prompt、逐幕生成剧情”逐步演进为一个可支持十小时以上游戏的叙事运行时：

- 每次玩家选择或自定义输入只决定下一幕；规则先结算，AI 一次生成该幕，客户端逐步消费。
- 人物、地点、物品等拥有稳定身份和受控状态，NPC 的人格、知识、目标、关系不会因上下文缺失而漂移。
- 已发生事件形成可追溯历史；短期场景、章节经历和长期因果分别保存、压缩与检索。
- 故事长期维持可修订的大纲和未决剧情线，但不提前锁死玩家选择。
- 三幕式是可选且可嵌套的结构策略之一；系统支持大篇章、章节、任务链和单幕拥有各自的起承转合。
- 战斗是叙事节拍和剧情转折的重要来源；战斗失败仍按现有设计恢复到战斗前状态，不引入复杂失败世界线。
- 每个重构阶段结束后，短篇和中篇都必须能从新游戏完整玩到结局；长篇能力在基础层稳定后开放。

本文是目标架构和分期边界，不把参考文档中的设想当作当前实现事实。当前实现事实仍以代码、测试和 `docs/agent/` 为准。

---

## 2. 设计依据与取舍

### 2.1 事实依据

设计以以下现有实现为基线：

- `WorldState` 已保存地点、NPC、物品、事实、任务、敌人、阵营、战斗和事件账本。
- `StoryState` 已保存幕、进度、张力、节奏需求、预算、未决线索 ID、故事契约和近期节拍。
- `SceneGenerationContext` 已按最小权限投影当前地点、在场 NPC、焦点 NPC、规则节拍、目标转换、合法行动和部分近期信息。
- 场景流程已经是“行动解析与规则结算 → 必须表现的节拍 → AI 场景提案 → 审批 → 写入”；AI 不是规则裁判。
- 世界演化已经是“AI 提案 → 引用校验与审批 → 服务端铸造 ID → 写入状态”。
- 战斗状态已保存战前快照，并在失败时恢复；该语义保持不变。

### 2.2 参考资料中值得吸收的思想

`docs/设想/AI_RPG_Entity_WorldState_Memory_Architecture.md` 和 `docs/设想/SillyTavern_Architecture_Analysis_for_AI_RPG.md` 只作为设计输入，值得吸收的是：

- 将角色卡、世界书、聊天历史拆成不同权威级别和注入位置，而不是合并成一段无结构文本。
- 世界信息按触发条件和相关性选入上下文，不把整个世界状态塞给模型。
- 固定人格、动态状态、关系、记忆分层保存，避免用一段可被覆盖的角色描述承担全部职责。
- 保留最近原文，同时将较早历史摘要化；长局采用分层记忆而不是无限增长上下文。
- Prompt 组织应具有顺序、优先级、预算、冲突策略和可观察性。
- 扩展点应由稳定接口承载，不能让任意脚本或任意 AI 输出直接改写权威状态。

尤其是 SillyTavern 的角色卡、World Info/Lorebook、聊天摘要和 Prompt 排序思路，可以借鉴为“上下文块 + 条件检索 + 确定性编译”。但本项目不能照搬其“聊天记录即主要事实源”的假设：这是规则驱动游戏，权威事实必须来自服务端状态和已提交事件，AI 文本只能作为表现结果或待审批提案。

### 2.3 明确不采纳的做法

- 不把整份存档、完整事件账本或所有 NPC 私密知识直接序列化进 Prompt。
- 不让 AI 返回任意 JSON Patch，也不允许 AI 直接更新数据库字段。
- 不把 Event、人物、地点、物品强行塞进一个包含大量可空字段的万能 Entity 表。
- 不维护一份从开局到结局不可修改的逐幕剧本。
- 不仅靠向量相似度判断哪些历史重要；权威引用、因果关系、剧情线程和近期性必须先参与筛选。
- 不用无限聊天摘要替代结构化状态。
- 不因长篇目标提前改变短篇/中篇的正常完成路径。

---

## 3. 不可违反的产品与架构原则

### 3.1 单回合生成与逐步消费

每次玩家行动只提交一个权威 Action。服务端先完成规则结算，再根据结算结果和当前叙事状态生成一幕完整 `ScenePerformanceProposal`。客户端可以分段播放旁白、对白、镜头和选项，但播放过程不再次调用 AI 改写这一幕。

因此：

- 一幕内的事实、奖励、伤害、目标推进必须在生成前确定。
- 流式展示不等于流式决定世界状态。
- 下一次 AI 生成只能发生在玩家作出下一项选择或提交自定义输入之后，预生成的线性行动叙事除外；预生成结果仍需绑定权威行动与状态版本。

### 3.2 权威状态优先

信息权威顺序固定为：

1. 规则与安全约束；
2. 当前已提交状态；
3. 已提交事件；
4. 已批准的故事计划与线程；
5. 经验证的记忆摘要；
6. 静态世界背景与风格资料；
7. AI 当前提案。

发生冲突时，高权威信息覆盖低权威信息。AI 提案永远不能覆盖规则结算、存档状态或已发生事件。

### 3.3 稳定身份与有限可变状态

人物、地点、物品、敌人、组织、任务、事实均使用稳定 ID。展示名称不是引用键。实体的固定字段和可变组件由代码定义，AI 只能提出有限命令，规则层负责验证、规范化和应用。

### 3.4 玩家能改变计划，但不能改写过去

Living Outline 可以因玩家行为改写未来节点、改变路径、延迟或取消伏笔，但已提交 Event 不可被普通剧情生成覆盖。需要回滚时必须由明确的游戏机制完成；当前战斗失败回滚是其中一个受控机制。

### 3.5 每阶段保持完整可玩

Plan 1–7 不把当前已有的 `long/open` 枚举视为已达到十小时长篇验收，也不扩大或宣传其能力；现有输入兼容行为不在中途破坏。每个 Plan 的合并门槛包括：

- 新游戏可创建；
- 选择和自定义输入可推进；
- 移动、探索、对话、调查、物品、任务、战斗均不退化；
- 短篇和中篇可到达结局；
- 战斗失败可回到战前状态；
- 旧的 AI 不可用/非法响应行为保持为已有 typed failure 或既定回退语义；
- 存档版本变化时有明确的兼容或拒绝策略。

---

## 4. 目标运行时总览

```text
玩家选择 / 自定义输入
          │
          ▼
   Intent 与合法 Action
          │
          ▼
  规则结算 + 权威 State/Event
          │
          ├──────────────► Entity/Component 投影
          ├──────────────► Event/Episode 检索
          ├──────────────► Relationship/Knowledge 投影
          └──────────────► Living Outline / Active Arc
                                  │
                                  ▼
                        Narrative Context Compiler
                   选择、冲突消解、预算、顺序、审计清单
                                  │
                                  ▼
                         Scene / World AI 提案
                                  │
                                  ▼
                       Schema + 引用 + 语义审批
                                  │
                                  ▼
                       写入状态与场景消费队列
```

上下文编译器不是新的事实库。它只从各个权威投影读取当前任务需要的信息，生成有来源、有优先级、有预算的 Prompt。

---

## 5. Entity 与 Component 模型

### 5.1 Entity 范围

下列对象采用稳定 Entity 身份：

- Character：玩家、NPC、同伴；
- Location：世界节点、城镇容器、场景地点；
- Item：装备、消耗品、材料、任务物品；
- Enemy/Encounter Actor：战斗中的敌对单位；
- Faction/Organization：组织及其立场；
- Quest：任务及目标链；
- Fact/Clue：可发现、可知晓、可隐瞒的事实。

Event 不作为普通可变 Entity。Event 是带稳定事件 ID 的追加记录，可引用任意 Entity，并可被归入 Episode。

### 5.2 固定核心与可变组件

每类 Entity 由固定核心加类型化组件构成：

```ts
type EntityCore<Id extends string, Kind extends string> = Readonly<{
  id: Id;
  kind: Kind;
  name: string;
  createdAtTurn: number;
  lifecycle: "active" | "inactive" | "resolved" | "destroyed";
}>;
```

建议的组件边界：

- `IdentityComponent`：角色不可轻易漂移的身份、角色定位、外观锚点、说话风格、价值观和禁区。
- `LocationComponent`：空间归属、连通、场景尺度、环境标签、可进入条件。
- `PositionComponent`：当前所在地点及状态版本。
- `GoalComponent`：短期目标、长期目标、优先级、状态和原因。
- `KnowledgeComponent`：已知 Fact ID、私密 Fact ID、来源和可信度。
- `RelationshipComponent`：有向关系边的信任、亲近、恐惧、敌意、债务、承诺与阶段。
- `PossessionComponent`：所有者、容器和数量。
- `QuestComponent`：目标图、当前游标、状态、成功/失败结果。
- `FactionMembershipComponent`：成员身份、职位、忠诚与公开性。
- `NarrativeRoleComponent`：当前 Arc 中的功能角色，不等于永久人格。

组件字段必须由领域代码定义。允许版本演进，但不允许 AI 临时创造字段。

### 5.3 AI 更新协议

AI 不返回通用 Patch，而是返回受限命令，例如：

```ts
type ProposedEntityCommand =
  | { kind: "set_goal_status"; entityId: string; goalId: string; status: "active" | "blocked" | "completed" }
  | { kind: "record_knowledge"; npcId: string; factId: string; sourceEventId: string }
  | { kind: "propose_relationship_signal"; fromId: string; toId: string; signal: "helped" | "betrayed" | "threatened"; sourceEventId: string }
  | { kind: "move_entity"; entityId: string; toLocationId: string; reasonEventId: string };
```

每个命令必须经过：schema 校验、引用校验、权限校验、前置条件、数值边界、因果来源和幂等检查。真正的关系数值变化、知识获取和状态转换由规则映射决定。

### 5.4 Entity 检索不是“提及后再盲搜”

Prompt 中的 Entity 选择采用两阶段：

1. 规则闭包：当前地点、在场角色、当前目标、行动目标、规则结果、显式引用的所有实体必须进入候选集。
2. 相关扩展：沿关系边、事件参与者、剧情线程成员和记忆索引扩展少量候选，再按预算裁剪。

不能先让 AI 随意提及未知名字，再尝试为它寻找实体。正文只能引用已批准候选 ID；确需新实体时由世界演化先提案和审批。

---

## 6. Event、Episode 与长期记忆

### 6.1 Event 是不可变因果记录

Event 记录“发生了什么”，最小结构应包含：

```ts
type NarrativeEvent = Readonly<{
  eventId: string;
  turnNumber: number;
  kind: string;
  actorIds: readonly string[];
  targetIds: readonly string[];
  locationId: string;
  causeEventIds: readonly string[];
  factIds: readonly string[];
  questIds: readonly string[];
  outcome: "success" | "failure" | "mixed" | "neutral";
  salience: number;
  committedAt: string;
}>;
```

玩家原始自由输入不进入长期 Event 正文。它先转为结构化 Action 和已结算结果；只有必要的安全摘要或精确玩家台词节拍进入当回合场景上下文。

### 6.2 Episode 是事件的叙事索引

Episode 不是第二套事实源，而是对一段事件的可重建摘要：

- 时间范围与地点范围；
- 参与实体；
- 起因、关键变化、结果；
- 关系变化依据；
- 新增/揭示事实；
- 未解决问题；
- 关联 Arc/Thread；
- 来源 Event ID 列表；
- 摘要版本和覆盖到的账本位置。

摘要可以重算，Event 不可被摘要替代或删除。

### 6.3 四层记忆

1. Working Context：当前行动、当前规则结果、上一轮对话和当前场景。
2. Recent Scene Memory：最近若干幕的结构化节拍与必要原文。
3. Episodic Memory：按任务、地点、人物关系和章节聚合的 Episode。
4. Canonical State：Entity/Component、Story Thread、承诺、已知事实等长期权威状态。

长局检索先做硬条件过滤，再做相关性排序：

```text
权威引用 > 当前任务/线程关联 > 同一实体或关系边 > 因果邻接 > 显著度 > 近期性 > 语义相似度
```

向量索引可以成为最后一级召回手段，但不能成为权威判断器。

---

## 7. NPC 人格、知识和关系连续性

### 7.1 人格分层

NPC 信息分为：

- Identity Anchors：身份、价值观、表达习惯、能力边界、长期禁区；默认不可由普通场景更新。
- Current State：位置、情绪、短期目标、健康/战斗状态；可由规则事件更新。
- Knowledge：知道什么、不知道什么、信息来源和是否允许披露。
- Relationship：NPC 到玩家、NPC 到 NPC 的有向关系边。
- Episodic References：影响当前回应的关键经历。
- Arc Role：在当前篇章中的功能角色；Arc 结束后可以变化，不反向修改人格锚点。

### 7.2 关系变化必须有证据和速度限制

关系不是单一好感值，也不能从一次普通对话直接跳到“生死之交”或“宿敌”。目标模型至少支持：

- affinity / trust / fear / hostility；
- debt 与 promise；
- relationship stage；
- lastChangedAtTurn；
- supportingEventIds。

规则层根据事件信号改变有限幅度；跨阶段变化需要阈值、关键事件或累计证据。Prompt 使用关系档位、趋势、承诺和少量依据，不直接要求 AI 自行解释裸数值。

### 7.3 知识隔离

每个 NPC 的 Prompt 只获得：自身公开档案、允许披露的事实、当前可见事实、与本次回应有关的私密事实 ID/扣留策略、自己的交互历史和必要的关系边。不得注入其他 NPC 的私密记忆正文。

NPC 台词输出必须回传所使用的 Fact ID 和 Interaction/Event ID，审批器验证引用归属。

---

## 8. Living Outline、Story Thread 与嵌套叙事结构

### 8.1 大纲是动态约束，不是未来事实

长期维护的不是完整剧本，而是三种不同层次：

- Story Contract：题材、主题、中心冲突、体验承诺、允许的结局方向；稳定、低频变化。
- Living Outline：当前大篇章和近中期路线；可因玩家选择修订。
- Story Threads：具体未决问题、伏笔、承诺、威胁和关系冲突；由事件推进。

未来节点不能引用尚未审批创建的实体 ID。可以使用角色需求或实体槽位，待世界演化时再绑定到真实 Entity。

### 8.2 嵌套 Arc

统一使用可嵌套 Arc，而不是把“三幕式”写死为全局唯一结构：

```ts
type StoryArc = Readonly<{
  arcId: string;
  parentArcId: string | null;
  scope: "campaign" | "chapter" | "quest" | "scene_sequence";
  structure: "three_act" | "five_act" | "mystery" | "quest" | "custom";
  premise: string;
  dramaticQuestion: string;
  phase: string;
  status: "planned" | "active" | "resolved" | "abandoned";
  threadIds: readonly string[];
  milestoneIds: readonly string[];
  revision: number;
}>;
```

一个 campaign 三幕结构可以包含多个 chapter 三幕结构；任务链也可采用谜题、追逐、复仇、调查或自定义节拍。结构模板只定义张力功能和推进条件，不规定唯一剧情内容。

### 8.3 滚动规划窗口

为避免长篇僵化，Living Outline 分为：

- 已提交历史：不可改写；
- 当前 Arc：节点较具体，绑定真实 Entity 和 Thread；
- 下一 Arc：保留目标、障碍、转折功能和实体槽位；
- 远期方向：只保存主题、冲突升级方向和结局条件。

每次关键事件、Arc 结束、玩家严重偏航或世界演化时，可生成大纲修订提案。审批规则保证：不改写历史、不凭空关闭线程、不跳过必要铺垫、不让关系无依据跃迁。

### 8.4 节奏与高潮

导演决策同时考虑：

- 当前 Arc 的结构阶段；
- 当前/目标张力；
- 未解决线程的年龄和优先级；
- 最近重复的场景类型；
- 玩家近期选择风格；
- 战斗、调查、社交和探索的节奏轮换；
- 篇幅预算和预计剩余时长。

高潮不是单靠高 `tension` 数值触发。它需要此前铺垫、明确赌注、对核心线程的影响和可感知的结果。转折必须由已经存在的事实、人物动机或可追溯事件支撑。

---

## 9. 战斗的叙事职责

战斗保持现有规则权威和失败回滚语义，同时进入叙事结构：

- 战前：明确赌注、对手目标、地点和参战原因。
- 战中：每轮只表现已结算行动、伤害、状态与战术变化。
- 战后胜利/撤退：生成结构化 Event，推进任务、关系、事实或 Arc 节拍。
- 战斗失败：恢复战前世界与玩家状态；失败尝试不写入长期世界因果，不消耗一次永久剧情分支。
- 允许保留非权威的本地体验反馈，例如 UI 提示，但它不进入 NPC 知识、关系和长期大纲。

世界演化和 Arc 规划可以提出“需要一次战斗/追逐/对峙”的叙事功能，但敌人、地点和奖励仍需先创建并审批，不能由场景表演 Prompt 临时捏造。

---

## 10. Narrative Context Compiler

### 10.1 职责

编译器接收结构化 `NarrativeContextBlock[]`，完成：

1. 去除空块和重复块；
2. 按 `conflictKey` 和权威级别消解冲突；
3. 强制保留规则、当前结算、玩家行动和输出契约；
4. 按任务相关性、优先级和预算选择可选块；
5. 以稳定顺序渲染 Prompt；
6. 生成不含正文的 selected/dropped 审计清单。

### 10.2 上下文块契约

```ts
type NarrativeContextBlock = Readonly<{
  id: string;
  slot:
    | "system_rules"
    | "world_canon"
    | "story_contract"
    | "current_state"
    | "current_resolution"
    | "current_location"
    | "focus_character"
    | "relationships"
    | "relevant_events"
    | "recent_scenes"
    | "director_guidance"
    | "player_action"
    | "legal_actions"
    | "output_contract";
  title: string;
  content: string;
  authority: "rule" | "state" | "event" | "plan" | "memory" | "lore";
  retention: "mandatory" | "optional";
  priority: number;
  conflictKey?: string;
  source: Readonly<{ kind: string; refs: readonly string[] }>;
}>;
```

编译器不访问数据库、不调用 AI、不决定业务事实，也不做向量检索。各 projection builder 负责把 Scene、World、NPC、Arc 和 Memory 数据变成安全上下文块。

### 10.3 预算与降级

Plan 1 使用确定性的保守 token 估算，不引入 provider 专属 tokenizer。预算不足时：

- mandatory 块永不丢弃；mandatory 已超预算则标记 overflow，但继续渲染，以免丢失规则或已结算事实。
- optional 块按优先级、权威级别和稳定 ID 选择。
- 先缩短/丢弃较旧的场景和低相关 lore，再处理 Episode；当前实体与当前线程优先。
- 审计记录块 ID、slot、来源类型、估算 token 和丢弃原因，不记录额外私密正文。

### 10.4 AI 角色视图

不同 AI 角色使用同一编译协议，但投影不同：

- intent：只看当前输入、当前可执行语义和必要对话上下文。
- opening：看创建参数、题材规则和开局输出契约。
- scene：看当前结算、地点、焦点角色、相关事件、当前 Arc/任务和合法候选。
- world：看演化需求、Story Contract、当前 Arc、未决线程、相关实体摘要和输出契约。
- future outline/memory summarizer：只看其明确输入和来源 ID，不能通过内部调用获得完整存档。

Plan 1 先迁移 scene 与 world，因为它们直接决定逐幕连贯性和新实体一致性；opening 与 intent 保持现状，后续按同一协议迁移。

---

## 11. 生成、审批与写入边界

### 11.1 Scene

```text
权威 Action
  → 规则结算
  → ObjectiveTransition + MandatoryBeats
  → Scene Context Blocks
  → 编译并一次生成 Scene Proposal
  → schema/beat/entity/knowledge/choice 审批
  → 场景队列逐段消费
```

AI 负责文字表演、镜头和在边界内的措辞选择；它不能决定行动是否成功、奖励、伤害、关系数值、事实是否发现、任务是否完成。

### 11.2 World Evolution

```text
规则或导演产生 EvolutionNeed
  → World Context Blocks
  → AI 生成受限 WorldDeltaProposal
  → schema/题材/空间/引用/可达性/预算审批
  → 服务端铸造 ID
  → 预览状态供同一幕使用
  → 审批通过后提交
```

所有 `WorldDeltaProposal` 可选分支都必须出现在输出契约中；契约根据 need 精确限制允许和必需的字段，避免解析器支持而 Prompt 未声明。

### 11.3 Outline 与记忆更新

Outline 修订、Episode 总结和 Entity 更新均是独立的受限提案，不与玩家可见场景 JSON 混成一个无限 schema。它们可以在回合提交后的后台阶段运行，但任何下一幕依赖的更新必须在下一次上下文投影前完成或明确使用旧版本；不得出现半提交状态。

---

## 12. 十小时以上长局的存储与运行

### 12.1 存储分层

- 热状态：当前 World/Story/Arc 游标、活动任务、在场实体和最近场景。
- 事件分段：按 gameId + sequence 追加，支持范围读取和幂等提交。
- Episode 索引：按实体、线程、地点、Arc、时间范围和显著度查询。
- 快照：在固定回合数、Arc 边界、重大世界演化和结局前创建。
- 冷摘要：已结束 Arc 的层级摘要，可从 Event 重建。

### 12.2 一致性

每个玩家回合使用同一个 `expectedRevision` 和 `turnId`：

- Action 结算、Event 追加、Entity 投影游标、Arc 进度和场景 job 之间必须可关联。
- 重试必须幂等；同一 job 不能重复推进关系或任务。
- 场景预生成携带 `basedOnRevision` 与上下文指纹，状态变化后自动作废。
- 快照只用于加速恢复，不是独立真相源。

### 12.3 长局性能目标

长局 Prompt 大小和检索时间不能随总事件数线性增长。目标是：

- 常规场景只读取热状态、少量最近场景和有限 Episode。
- 事件账本增长不导致每回合完整扫描。
- 当前地点/角色/任务的结构化索引可直接定位。
- 任意摘要都有来源范围和版本，可检测过期并重建。

现有领域类型已经接受 `long/open`，但这不等于具备十小时长期记忆与运行保障；例如当前 `StoryState.targetActs` 可取 8，而 `StoryContract.targetActs` 仍只有 3/5 两档。只有 Plan 8 的十小时 journey、恢复测试和内容质量门槛通过后，才把长篇作为正式受支持能力。

---

## 13. 可观察性与质量评估

每次 AI 调用至少可关联：gameId、turnNumber、revision、jobId、role、retry、上下文编译版本和块清单。

长期增加以下离线指标：

- Persona contradiction：人格锚点冲突率。
- Knowledge leak：NPC 使用未授权 Fact 的比例。
- Relationship jump：无足够事件证据的关系阶段跃迁。
- Location contradiction：实体位置、连通和文本描述冲突。
- Event recall precision：召回历史是否与当前任务相关。
- Thread continuity：长期未决线程被遗忘或无依据关闭的比例。
- Arc pacing：铺垫、升级、转折、高潮和收束是否有结构依据。
- Combat narrative relevance：战斗是否改变任务、关系、事实或 Arc，而不是孤立随机遭遇。
- Context efficiency：selected/dropped 块、估算 token、实际输出质量和失败率。

质量评估失败不直接改写玩家存档；它用于回归、调参和阻止不合格架构阶段发布。

---

## 14. 八个实施 Plan 及边界

### Plan 1：Narrative Context Compiler

建立上下文块 IR、权威级别、预算、冲突消解、稳定渲染和审计清单；迁移 scene/world Prompt，补齐当前 Story Contract、节奏、近期节拍、焦点 NPC 五条交互和全部 WorldDelta schema。无存档迁移、无新 AI 调用。

完成标准：短/中篇全流程不变；Prompt 由可测试编译器生成；场景和世界演化不再遗漏当前已有的关键叙事字段。

### Plan 2：Entity/Component 基础与投影

为人物、地点、物品、敌人、组织、任务、事实建立稳定 Entity Core 与类型化组件；现有数组逐步成为兼容投影；建立受限 Entity Command 和审批器。

完成标准：现有玩法通过兼容层完整运行；AI 不直接更新任意字段；实体引用与位置冲突有统一校验。

### Plan 3：NPC 人格、知识与关系图

拆分人格锚点、动态状态、知识来源、有向关系边和承诺；建立关系变化速度限制、证据引用和 NPC-to-NPC 关系。

完成标准：对话、调查、任务和战斗均使用同一 NPC 投影；人格、知识与关系一致性 journey 通过。

### Plan 4：结构化 Event 与 Episodic Memory

扩展稳定事件 ID、参与者、因果和显著度；建立 Episode 聚合、来源范围、结构化检索和摘要重建。

完成标准：较早事件可在相关场景中被精确召回，不需要把完整账本放入 Prompt；摘要不成为第二真相源。

### Plan 5：层级 Living Outline 与 Story Thread

实现 Story Contract、嵌套 Arc、Milestone、Thread、实体槽位、滚动规划和受控修订。

完成标准：玩家偏航可修订未来而不改写过去；大 Arc 可包含章节/任务子 Arc；短中篇结构继续闭合。

### Plan 6：Arc-aware Scene Planning 与世界演化

在规则结算和表演生成之间加入确定性的 scene intent/director decision；按 Arc 功能安排揭示、升级、转折、高潮、收束及有叙事目的的战斗。

完成标准：高潮和转折有前置依据；战斗能推进线程；失败仍恢复战前状态；场景仍一次生成、逐步消费。

### Plan 7：长会话存储、快照与索引

实现事件分段、快照、Episode/Entity/Thread 索引、上下文指纹和预生成失效；控制加载与 Prompt 成本。

完成标准：大量历史下的回合成本不线性增长；崩溃恢复、幂等重试和快照重放通过。

### Plan 8：十小时 Campaign Runtime

把现有 `long/open` 兼容档位提升为正式支持，加入章节生命周期、长期预算、休整/旅行节奏、长局内容密度、十小时自动 journey 和人工质量门槛。

完成标准：十小时以上测试局能创建、暂停、恢复、推进和结束；记忆、关系、位置、线程、Arc 与战斗连续性达到发布指标。

---

## 15. 需求追踪

| ID | 需求 | 首次落实 Plan |
|---|---|---:|
| NAR-01 | 玩家行动后一次生成下一幕并逐步消费 | 现状保持 / 1 回归 |
| NAR-02 | 规则状态高于 AI 文本 | 现状保持 / 1 固化 |
| NAR-03 | Prompt 有块、权威、预算、冲突和审计 | 1 |
| NAR-04 | Entity 稳定 ID 与固定组件 | 2 |
| NAR-05 | AI 只提交受限状态命令 | 2 |
| NAR-06 | NPC 人格不漂移、知识不泄漏 | 3 |
| NAR-07 | 人际关系不无依据跳跃 | 3 |
| NAR-08 | Event 不可变、Episode 可重建 | 4 |
| NAR-09 | 长期相关事件按结构化条件检索 | 4 |
| NAR-10 | 长期维护可修订大纲 | 5 |
| NAR-11 | 支持嵌套、多种叙事结构 | 5 |
| NAR-12 | 有铺垫的高潮、转折和收束 | 6 |
| NAR-13 | 战斗是剧情推进环节 | 6 |
| NAR-14 | 战斗失败恢复战前状态 | 全阶段保持 |
| NAR-15 | 长局成本不随历史线性增长 | 7 |
| NAR-16 | 支持十小时以上完整游戏 | 8 |
| NAR-17 | 每个 Plan 后短/中篇完整可玩 | 每个 Plan |

---

## 16. 全局非目标

- 不在本轮重构中制作自由多人联机、多个并发玩家时间线或无限开放世界。
- 不承诺任意模型都能达到同等文学质量；协议保证的是事实边界、可验证性与可替换性。
- 不以保存全部 AI 思维过程作为记忆或审计手段。
- 不让长期大纲替玩家预选结局。
- 不把战斗失败改为永久分支或复杂惩罚。
- 不为了未来长篇一次性重写所有现有领域对象；各 Plan 使用兼容投影迁移，并保留可玩闭环。

---

## 17. 总体验收定义

八个 Plan 全部完成后，系统应能证明：

1. 任意场景中的人、地点、物、任务和事实均可追溯到稳定 ID 与权威状态。
2. NPC 的台词可解释为人格、知识、关系、当前目标和相关经历的组合，且引用可审批。
3. 十小时后仍可召回早期关键事件，同时不会把无关历史塞入 Prompt。
4. Living Outline 能记住中心冲突与未决线程，也能因玩家选择修订未来。
5. campaign、chapter、quest 和 scene sequence 可以使用不同或嵌套的叙事结构。
6. 高潮、转折和战斗有前置依据并产生可见后果。
7. 每幕仍由玩家选择触发、一次生成并逐步消费；规则结果不会被 AI 改写。
8. 短篇、中篇和长篇均能从新游戏走到结局，存档恢复与重试不造成重复推进。
