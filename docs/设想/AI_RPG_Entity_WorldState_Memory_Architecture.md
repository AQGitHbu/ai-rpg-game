# AI RPG：Entity、世界状态与记忆系统设计

## 1. 文档目的

本文整理 AI RPG 剧情系统中关于以下几个核心问题的设计结论：

- Entity（实体）是什么，以及应该保存什么
- World State（世界状态）与 Entity 的关系
- Story State（剧情状态 / 剧情概括）解决什么问题
- 最近若干幕、长期记忆与历史记录之间如何分工
- 每一幕生成时，应该把哪些信息注入 Prompt
- 剧情生成后，如何提取并更新 Entity / World State
- 如何兼容 SillyTavern（酒馆）的角色卡与世界书
- 如何避免世界不断增长后 Prompt 无限膨胀

这套设计的目标不是复制 SillyTavern，而是吸收它“按需注入上下文”的思想，构建更适合持续演化世界 + AI 推动剧情的 RPG 架构。

---

# 2. 核心结论

整个系统建议拆成四类长期数据：

1. **Entity**
   - 世界中的可识别对象。
   - 如角色、地点、物品、组织、任务、事件等。

2. **World State**
   - 当前这个时刻，世界“现在是什么样”。
   - Entity 是 World State 的重要组成部分。

3. **Story State**
   - 当前故事“进行到哪里、什么仍然重要”。
   - 是一个持续更新的剧情概括，而不是无限增长的剧情日志。

4. **Story History**
   - 玩家从第一幕到现在实际经历过的完整历史。
   - 用于回顾、追溯、再提取，但默认不会全部进入下一幕 Prompt。

可以简单理解为：

```text
Story History
    = 过去到底发生过什么

Story State
    = 这些过去的事情中，哪些现在仍然影响剧情

World State
    = 此时此刻这个世界实际是什么状态

Entity
    = World State 中具体的人、地点、物品、组织、事件等对象
```

---

# 3. Entity 是什么

Entity 不应该理解成一段给 AI 看的描述文字。

它首先应该是：

> **游戏程序能够长期识别、更新、引用的世界对象。**

例如：

```text
NPC
地点
物品
组织
任务
事件
```

每个 Entity 都应该有一个系统内部的稳定 ID。

例如：

```json
{
  "id": "npc_00142",
  "type": "character",
  "name": "李玄机"
}
```

这样即使这个人物在剧情里先后被称为：

```text
白发老人
老板
老头
李玄机
剑圣
```

程序内部仍然可以最终把这些描述归并到：

```text
npc_00142
```

---

# 4. Entity 的字段应该怎么设计

## 4.1 字段定义由系统控制

现阶段建议：

> **AI 可以填字段、更新字段，但不能自行创造正式 Schema 字段。**

例如角色可以预先定义：

```yaml
identity:
  name:
  aliases:
  age:
  gender:
  occupation:

appearance:
  description:

personality:
  traits:
  speech_style:

world:
  faction:
  location:
  social_status:

state:
  alive:
  health_state:
  emotional_state:

relationships:

background:
  summary:
```

如果后续游戏增加：

```text
战斗
魔法
声望
污染
信仰
```

则由系统增加新的正式 Component，而不是让 AI 在运行过程中任意创造数据库字段。

---

# 5. Entity 使用 Component，而不是所有对象共享全部字段

不同 Entity 不应该强制拥有一套巨大的字段。

更适合的是：

```text
Entity
  ├─ Core
  ├─ Character
  ├─ Combat（可选）
  ├─ Inventory（可选）
  ├─ Relationship（可选）
  └─ ...
```

例如普通酒馆老板：

```text
Character
Location
Relationship
```

即可。

如果后续剧情发现：

> 酒馆老板实际上是隐退剑圣。

此时再给他增加：

```text
CombatComponent
SkillComponent
```

即可。

所以原则是：

> **Entity 稳定，Component 可以动态挂载；Component 类型由系统定义。**

---

# 6. 角色 Entity

角色包括：

- 玩家角色
- NPC
- 敌人
- 临时剧情角色
- 重要历史人物

角色第一次出现时，不需要 AI 一次性补完完整人生。

推荐采用：

> **Minimum Viable Entity（最小可用实体）**

第一次可能只知道：

```yaml
name: 白发老人
aliases:
  - 老人
appearance:
  - 白发
  - 穿灰袍
location: 青石酒馆
background: unknown
```

随着剧情推进，逐渐补充：

```yaml
real_name: 李玄机
occupation: 前御剑司统领
combat_class: 剑圣
relationship_to_player: 暗中观察
```

因此角色不是“一次创建完成”，而是：

```text
首次出现 → 创建
再次出现 → 补充
发生变化 → 更新
身份揭露 → 合并/修正
```

---

# 7. 地点为什么也应该是 Entity

例如：

```text
青石酒馆
```

如果只放在世界书中：

```text
青石酒馆是镇上最大的酒馆……
```

AI 可以读懂它。

但程序无法可靠知道：

```text
酒馆是否被烧毁
目前由谁控制
里面有哪些物品
现在是否开放
发生过哪些关键事件
```

如果作为 Entity：

```yaml
id: location_001
name: 青石酒馆
type: tavern

state:
  destroyed: true
  owner: npc_003

contains:
  - item_017

description:
  original: 镇上最大的酒馆
```

那么“青石酒馆已经被烧毁”就不是一句文学描述，而是一个正式世界状态变化。

---

# 8. 物品为什么应该是 Entity

重要道具通常同时具有：

- 当前持有人
- 所在地点
- 属性
- 使用状态
- 剧情意义

例如：

```yaml
id: item_018
name: 赤霄剑
owner: player
location: player_inventory
state:
  broken: false
story_tags:
  - royal_secret
```

因此重要物品适合 Entity 化。

普通无意义装饰物则没有必要全部建立 Entity。

---

# 9. Event 为什么也可以结构化

事件看起来比人物、地点更“文本化”，但仍然可以拥有一个结构化骨架。

例如：

```yaml
id: event_009
type: assassination

title: 王城刺杀事件

participants:
  - npc_001
  - npc_017

location:
  - location_002

result:
  king_status: injured

story_description:
  夜宴期间刺客从东侧长廊潜入……
```

即：

> **结构化骨架 + 自由文本描述**

程序使用骨架，AI 使用骨架和 description。

---

# 10. World State 是什么

World State 不应该是一篇不断增长的文字 Prompt。

它应该理解为：

> **当前时间点整个游戏世界的结构化事实集合。**

例如：

```text
World State
│
├─ Characters
├─ Locations
├─ Items
├─ Organizations
├─ Quests
├─ Events
└─ Global Variables
```

World State 回答的问题是：

```text
谁还活着？
谁在哪里？
什么东西属于谁？
哪个组织控制哪个地方？
当前任务进行到哪里？
某个地点有没有被毁掉？
```

所以：

> **Entity 是 World State 的组成部分。**

---

# 11. Story State 为什么必须独立存在

如果只有 World State，会出现一个严重问题：

世界越来越大，但 AI 不知道：

> 哪些东西现在仍然是故事重点？

例如 20 幕之前：

```text
国王正在秘密寻找圣剑。
```

之后玩家在村庄连续调查十几幕。

如果下一幕生成只看：

```text
最近 3 幕
当前地点
当前 NPC
```

那么 AI 很可能永远不会主动让“国王”重新进入剧情。

所以需要一个长期保持剧情方向的：

# Story State

例如：

```yaml
main_goal:
  找到圣剑

current_phase:
  在北方边境调查圣剑踪迹

active_threads:
  - 王室也正在寻找圣剑
  - 黑骑士正在追踪玩家

unresolved_mysteries:
  - 圣剑真正的主人是谁
  - 李玄机为何隐瞒身份

current_conflicts:
  - 王室
  - 黑骑士
  - 玩家
```

这就是长期剧情“不会忘”的关键。

---

# 12. Story State 不是无限增长的剧情大纲

这里必须区分两个东西。

## Story History

完整历史：

```text
第一幕发生了……
第二幕发生了……
第三幕发生了……
第四幕发生了……
……
```

它会持续增加。

但默认不全部发送给 AI。

## Story State

它是不断更新的“当前剧情摘要”。

例如原来：

```text
玩家开始寻找圣剑。
```

后来更新成：

```text
玩家得知圣剑最后出现在北方森林。
```

再后来：

```text
玩家确认圣剑可能藏在黑山遗迹，
同时发现王室和黑骑士都在寻找它。
```

所以 Story State 应该：

> **更新，而不是无限 append。**

---

# 13. 短期记忆

除了 Story State，还需要短期剧情上下文。

最简单的方式是：

```text
最近 N 幕
```

例如最近 3～5 幕，包含：

- AI 生成的剧情
- NPC 对白
- 玩家选择
- 玩家自由输入
- 最近发生的关键结果

短期上下文解决的是：

> 刚刚发生了什么。

Story State 解决的是：

> 很久以前发生、但现在仍然重要的是什么。

World State 解决的是：

> 现在世界到底是什么样。

三者不能互相替代。

---

# 14. 推荐的记忆分层

建议最终形成四层：

```text
┌──────────────────────┐
│ Recent Context       │
│ 最近 N 幕            │
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ Story State          │
│ 当前剧情状态         │
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ World State          │
│ Entity / 世界事实    │
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ Story History        │
│ 完整历史档案         │
└──────────────────────┘
```

| 层 | 作用 | 是否每次进入 Prompt |
|---|---|---|
| Recent Context | 保证最近剧情连续 | 是 |
| Story State | 保证长期剧情线不断 | 是 |
| World State | 当前事实 | 按需 |
| Story History | 完整历史档案 | 否 |

---

# 15. 每一幕生成时到底给 AI 什么

不要把所有 World State 塞进去。

否则随着 NPC、地点、事件、物品不断增加，Prompt 会无限变长。

建议下一幕的生成上下文由以下组成：

```text
System Rules
Initial World Setting
Story State
Recent N Scenes
Player Current Input / Choice
Relevant World State / Entities
```

---

# 16. Relevant Entity 怎么找

这是整个系统最难的部分之一。

不能把所有 Entity 发给 AI 再判断，也不能只看当前地点。

推荐采用多路召回。

## 16.1 Recent Entity

最近 N 幕生成完成后，就已经进行 Entity Extraction。

例如：

```yaml
scene_31:
  referenced_entities:
    - npc_002
    - location_003
    - item_009
```

生成 scene_34 时，scene_31～33 出现过的 Entity 可以组成短期候选集。

## 16.2 Story State Entity

例如 Story State 中存在：

```text
王室正在寻找圣剑
黑骑士正在追踪玩家
```

则王室、圣剑、黑骑士、玩家对应的 Entity 都属于长期候选。

这就解决了：

> 为什么 10 幕以前的人还可能重新出现？

因为虽然他没出现在最近 N 幕，但他仍然存在于 Story State 的 active thread 中。

## 16.3 Player Input

如果玩家突然输入：

> 我回去找那个白发老人。

那么即使这个人 30 幕没出现，也可以通过 alias、name、description、embedding 重新找到对应 Entity。

## 16.4 语义检索

不能只靠关键词。

因为“李玄机 / 白发老人 / 那个老头 / 剑圣 / 老板”都可能指向同一个 Entity。

因此 Entity 可以维护 aliases，同时为 Entity Summary 建 Embedding。

推荐召回流程：

```text
关键词匹配
    ↓
Alias 匹配
    ↓
全文检索
    ↓
向量语义检索
```

最后只选 Top K 个 Entity。

---

# 17. 不要让召回直接等于注入

检索到的 Entity 可能很多。

应该进行：

```text
Recall → Ranking → Budget → Prompt
```

例如召回 30 个 Entity，最终按：

- 当前相关度
- 近期出现
- Story State 权重
- 玩家显式提及
- 剧情重要度
- Token Cost

选出 5～10 个。

这一步可以叫：

> **Context Retrieval / Context Compilation**

---

# 18. Prompt 中不要直接塞数据库 JSON

Entity 是给程序用的，Prompt 是给模型看的。

所以中间应该有一层：

> **Entity → Prompt Projection**

例如数据库：

```json
{
  "id": "npc_001",
  "aliases": ["老板", "老王"],
  "occupation": "酒馆老板",
  "alive": true,
  "relationship": {
    "player": 35
  }
}
```

转换成 AI 容易理解的文本：

```text
【酒馆老板·老王】
身份：青石酒馆老板
目前状态：存活
与玩家关系：较熟悉
已知事实：
- 曾向玩家透露黑山商路的消息
- 对王城商会抱有戒心
```

Prompt 只看这个 projection。

---

# 19. 一幕生成后的更新流程

推荐流程：

```text
玩家选择
    ↓
Scene Generator
    ↓
返回新一幕剧情
    ↓
立即展示给玩家
    ↓
后台异步处理
```

后台：

```text
Scene
  ↓
Fact / Entity Extractor
  ↓
Entity Resolution
  ↓
World State Update
  ↓
Story State Update
  ↓
Scene Memory Index
```

---

# 20. 为什么生成和提取必须分开

不要让 Scene Generator 同时承担：

```text
写剧情
识别实体
判断 Entity ID
更新数据库
总结剧情
```

更好的职责拆分：

## Scene Generator

只负责下一幕好不好玩、自然不自然、是否符合世界状态。

## Extractor

负责这一幕产生了哪些事实和实体变化。

## Entity Resolver

负责这是已有实体还是新实体。

## State Updater

负责 World State 应该怎么变化。

## Story State Updater

负责哪些剧情线现在仍然重要。

---

# 21. Entity Resolution：已有还是新增

例如：

```text
scene 1:
一个白发老人坐在角落。

scene 4:
老人向你招手。

scene 8:
李玄机说道：“你终于来了。”
```

系统应该最终判断：

```text
白发老人
老人
李玄机
```

可能是同一个：

```text
npc_017
```

推荐采取：

```text
1. exact alias match
2. recent scene references
3. structured clues
4. semantic similarity
5. AI disambiguation
6. create new entity if uncertain
```

AI 只作为最后一级，而不是第一步。

---

# 22. 新 Entity 第一次出现

如果确定是新对象，就创建最小字段。

例如：

```yaml
id: npc_021
name: 白发老人
aliases:
  - 老人
appearance:
  hair: white
location: 青石酒馆
```

不要为了“完善角色卡”让 AI 当场凭空写完整人生。

原则：

> **没有发生过、没有被设定过的信息，不要因为数据库有字段就强行生成。**

---

# 23. Entity 更新

后续剧情可能产生：

```text
新增事实
状态变化
别名变化
关系变化
身份揭露
位置变化
物品转移
```

例如：

```text
李玄机承认自己是前御剑司统领。
```

则更新已有 Entity，而不是新建一个人物。

---

# 24. 删除 Entity 吗？

一般不建议物理删除。

角色死亡：

```yaml
alive: false
```

酒馆被毁：

```yaml
destroyed: true
```

组织解散：

```yaml
active: false
```

物品损毁：

```yaml
status: destroyed
```

因为“已经不存在”本身也是世界历史的一部分。

---

# 25. Entity 是否等于世界书

不是。

## Entity

是程序世界模型。

## 世界书

是给 AI 使用的背景知识表示。

因此我们的系统中更适合：

```text
Entity / World State
        ↓
Context Compiler
        ↓
Prompt Knowledge
```

也就是说，可以在运行时从 Entity / World State 生成“类似世界书”的上下文。

这样就不需要把同一条动态事实同时维护在数据库和世界书文本里。

---

# 26. 世界书在我们的系统里应该放什么

如果已经有结构化 Entity，则尽量不要重复。

世界书更适合：

```text
国家历史
宗教体系
魔法规则
社会习俗
世界宇宙观
种族背景
语言规则
时代背景
通用法律
文化常识
```

它们的共同特点是：

```text
相对稳定
不是某个具体对象当前的状态
通常作为背景知识存在
```

---

# 27. 角色卡在我们的系统里应该是什么

酒馆角色卡本质上是一种 Prompt 数据。

我们的角色 Entity 则应该更强。

推荐：

```text
Character Entity
       ↓
Character Prompt Projection
       ↓
相当于运行时角色卡
```

因此我们不需要强行维护一份独立的、永久文本角色卡，可以动态生成当前这一幕需要的角色上下文。

---

# 28. 兼容 SillyTavern 角色卡

可以兼容。

导入时：

```text
SillyTavern Character Card
        ↓
Import Adapter
        ↓
Character Entity
```

例如：

```text
description
personality
scenario
first_mes
example_dialogue
```

可以映射到：

```text
identity
personality
background
speech_style
initial_scene
few_shot_dialogue
```

无法结构化的部分保留到：

```text
raw_prompt_text
```

即可。

---

# 29. 兼容 SillyTavern 世界书

也可以兼容，但不建议强制全部转成 Entity。

导入时可以分类：

```text
World Book Entry
      ↓
Classifier
```

如果是：

```text
具体人物
具体地点
具体物品
具体组织
```

则可以转为 Entity。

如果是：

```text
魔法规则
国家历史
文化背景
宗教知识
```

则保存为 Static Lore / World Knowledge。

所以：

```text
酒馆世界书
≠
全部转 Entity
```

而是：

```text
Entity Knowledge
+
Static Lore
```

---

# 30. 两种游戏开始方式

## AI 原生生成

```text
用户输入世界设定
      ↓
AI 生成序幕
      ↓
剧情过程中逐渐产生 Entity
```

## SillyTavern Import

```text
角色卡
世界书
      ↓
导入
      ↓
初始化 World State + Static Lore
      ↓
AI 在既有世界中推进剧情
```

两种模式最终进入同一套运行时架构。

---

# 31. 推荐的下一幕生成完整流程

```text
┌─────────────────────┐
│ 玩家选择 / 自由输入 │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Recent Context      │
│ 最近 N 幕           │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Story State         │
│ 当前长期剧情状态    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Context Retrieval   │
│ 召回相关 Entity     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Prompt Projection   │
│ Entity → AI Context │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Scene Generator     │
│ 生成下一幕          │
└──────────┬──────────┘
           │
           ├──────────────► 玩家立刻看到
           │
           ▼
┌─────────────────────┐
│ Background Extract  │
│ 提取事实 / Entity   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Entity Resolution   │
│ 新建 / 更新 / 合并  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ World State Update  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Story State Update  │
└─────────────────────┘
```

---

# 32. Prompt 的推荐结构

```text
[SYSTEM]
你是这个 RPG 世界的剧情生成器。
必须遵守已确认世界事实，不可无故修改已有事实。

[WORLD RULES]
静态世界规则 / Lore

[STORY STATE]
当前主线：
当前阶段：
未解决事件：
活跃伏笔：
长期冲突：

[RECENT HISTORY]
最近 3～5 幕摘要 / 原文

[RELEVANT ENTITIES]

角色：李玄机
- 前御剑司统领
- 当前隐藏身份
- 与玩家关系：谨慎观察
- 当前地点：青石酒馆

地点：青石酒馆
- 当前状态：部分烧毁
- 老板：王守义

物品：赤霄剑
- 当前持有人：玩家

[PLAYER ACTION]
玩家选择：询问李玄机关于王城刺杀案。

[TASK]
生成下一幕。
```

---

# 33. 不应该做的事情

## 不要把完整 World State 发给 AI

否则世界越大，Prompt 越大，成本越高，注意力越分散。

## 不要只有 Recent N Scenes

否则长期剧情线会自然死亡，必须有 Story State。

## 不要让 AI 任意改数据库

正确流程：

```text
AI 提议变化
→ Resolver
→ Validator
→ Database Update
```

## 不要把数据库和 Prompt 数据混为一谈

数据库需要：

```text
稳定
结构化
可查询
可校验
```

Prompt 需要：

```text
简洁
相关
自然语言友好
Token 可控
```

所以必须有转换层。

---

# 34. 当前建议的最小架构

MVP 建议先实现：

```text
Entity
World State
Story State
Recent N Scenes
Entity Extractor
Entity Resolver
Context Retrieval
Scene Generator
```

Entity 类型先只做：

```text
Character
Location
Item
Organization
Quest
Event
```

检索先做：

```text
Recent Entity
+
Story State Entity
+
Player Input keyword / alias
+
简单 Embedding Top-K
```

这已经足够形成一个明显优于“把所有历史塞给 AI”的系统。

---

# 35. 与 SillyTavern 最大的区别

SillyTavern 主要解决：

> **聊天模型如何在有限上下文里表现得像“记得很多东西”。**

我们的 AI RPG 要解决的是：

> **一个世界如何在几百幕甚至几千幕剧情之后仍然保持可持续演化、一致、可检索、可更新。**

因此不能停留在：

```text
角色卡 + 世界书 + 聊天历史
```

而应该进一步发展成：

```text
Structured World Model
        +
Story State
        +
Memory Retrieval
        +
Prompt Projection
        +
AI Scene Generation
```

---

# 36. 一句话总结

> **World State 负责“世界现在是什么样”，Story State 负责“故事现在进行到哪里”，Recent Context 负责“刚刚发生了什么”，Story History 负责“过去完整发生过什么”，Context Retrieval 则负责从这些信息中挑出这一幕真正需要知道的内容，再交给 Scene Generator 生成下一幕。**

而 Entity，是整个 World State 能够被程序长期理解、更新和引用的基础单元。
