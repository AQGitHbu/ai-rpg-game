# AI 图片生产策略与架构 Spec

> 文档状态：Draft v0.1  
> 用途：指导 AI+RPG 项目后续图片资源系统、素材库、生成服务与运行时资源调度的功能实现  
> 核心原则：**逻辑先行、图片后置；优先复用、按需生成；生成不中断玩法；资源生成后可沉淀复用。**

---

## 1. 背景

AI+RPG 的剧情、人物、地点和事件由 AI 动态驱动，因此游戏过程中会持续出现开发阶段无法完全预知的视觉资源需求，例如：

- 新 NPC
- 新怪物 / Boss
- 新地点
- 新建筑
- 新室内场景
- 新战斗背景
- 人物在不同状态下的视觉版本

如果所有资源都在运行时即时生成，会带来以下问题：

- 生图延迟阻塞游戏流程
- API 成本不可控
- 图片风格不稳定
- 同一人物 / 地点多次生成后外观漂移
- 难以保证地图、建筑和交互逻辑一致
- 大量通用资源被重复生成

因此，图片系统不应被设计为“剧情需要什么，就实时画什么”，而应设计成一个：

**预制资源库 + AI 按需补充 + 异步替换 + 长期沉淀复用**

的资源生产与调度系统。

---

## 2. 设计目标

### 2.1 核心目标

1. 玩家不因为等待图片生成而中断游戏。
2. 优先使用已有图片资源，降低实时生成次数。
3. 对真正独特的剧情内容支持 AI 动态生成。
4. 同一角色、地点、建筑保持长期视觉一致。
5. 支持七种不同 RPG 题材 / 世界风格。
6. 图片生成模型可替换，不与具体模型 API 强绑定。
7. 已生成资源可以自动进入素材库，提升后续复用率。
8. 对特殊地图类型，例如小镇，保证视觉表现与游戏逻辑布局兼容。

---

## 3. 总体设计原则

### 3.1 图片不是世界状态本身

游戏世界的真实状态由结构化数据决定，例如：

- NPC 身份
- NPC 性别
- NPC 职业
- NPC 当前装备
- 地点类型
- 建筑类型
- 地图坐标
- 战斗状态

图片只是这些状态的视觉表现。

因此：

> **不能让图片反向成为游戏逻辑的数据源。**

---

### 3.2 资源优先级

任何视觉资源需求按以下顺序处理：

```text
固定资源
    ↓
已有完全匹配素材
    ↓
已有高相似素材
    ↓
临时占位素材
    ↓
AI 异步生成
    ↓
生成完成后替换
    ↓
进入素材库复用
```

核心原则：

> **能复用就不生成，必须生成也不阻塞游戏。**

---

## 4. 图片资源分类

整个游戏图片资源建议分为四大类。

---

## 4.1 A 类：固定预制资源

完全不需要运行时 AI 生成。

典型资源：

- UI 框架
- 背包界面
- 任务界面
- 对话框
- 按钮
- 通用图标
- 状态图标
- 基础技能图标
- 通用特效
- 操作提示
- 小地图 UI
- 通用光标 / 选中效果

特点：

- 与剧情无关
- 与具体世界生成无关
- 可以提前完整制作
- 所有题材尽可能共用一套基础交互结构

允许：

- 不同题材使用少量 Skin / Theme 替换

不建议：

- 为每个动态世界重新生成 UI

---

## 4.2 B 类：预生成可复用素材

提前通过 AI 或人工方式生产大量素材，并建立资源库。

典型资源：

### 角色

- 普通男性 NPC
- 普通女性 NPC
- 老人
- 商人
- 士兵
- 农民
- 旅店老板
- 铁匠
- 贵族
- 法师
- 强盗
- 守卫

每个角色资源可以包含：

- 角色立绘
- 小镇行走序列帧
- 战斗单位序列帧
- 头像

### 怪物

- 常见野兽
- 骷髅
- 哥布林
- 亡灵
- 强盗
- 普通魔物

### 建筑

- 酒馆
- 铁匠铺
- 民居
- 商店
- 神殿
- 城门
- 仓库
- 农舍

### 场景

- 普通森林
- 山路
- 洞穴
- 酒馆内景
- 民居内景
- 地牢
- 城堡走廊
- 普通广场

资源按以下维度打标签：

```text
题材
类型
性别
年龄
职业
身份
环境
建筑用途
视觉风格
时代
材质
服装
危险等级
稀有程度
```

这一层是整个系统的主要资源来源。

---

## 4.3 C 类：剧情按需生成资源

当素材库找不到足够匹配的资源时，由 AI 动态生成。

典型资源：

- 主线 NPC
- 独特 NPC
- Boss
- 特殊怪物
- 关键剧情地点
- 特殊建筑
- 特殊室内场景
- 剧情道具
- 独特战斗背景

例如剧情创建：

> “被遗忘在山谷中的血月古庙”

如果素材库不存在足够匹配的资源：

1. 先使用“古代神殿 / 废弃寺庙”等相似素材。
2. 玩家继续游戏。
3. 后台提交 AI 生图任务。
4. 新资源生成完成后替换。
5. 新资源进入素材库。

---

## 4.4 D 类：状态 / 变体资源

同一个资源可能存在多个视觉状态。

例如角色：

```text
normal
injured
dead
corrupted
armored
disguised
boss_phase_2
```

地点：

```text
normal
night
burning
destroyed
snow
flooded
occupied
```

建筑：

```text
normal
damaged
destroyed
upgraded
abandoned
```

状态资源必须绑定到同一个逻辑实体，而不是创建新的独立实体。

---

# 5. 资源层级模型

建议所有图片统一抽象为 `VisualAsset`。

示例：

```json
{
  "asset_id": "asset_123",
  "asset_type": "character_portrait",
  "entity_id": "npc_834",
  "theme": "dark_fantasy",
  "tags": [
    "male",
    "middle_age",
    "merchant",
    "poor",
    "human"
  ],
  "state": "normal",
  "source": "generated",
  "quality_level": 2,
  "generation_status": "ready",
  "parent_asset_id": null,
  "version": 1
}
```

---

# 6. 资源来源 Source

建议定义以下来源：

```text
builtin
pre_generated
generated
generated_variant
temporary
```

含义：

### builtin

人工制作的固定资源。

### pre_generated

项目发布前批量生产的 AI 素材。

### generated

运行过程中由 AI 新生成。

### generated_variant

基于已有资源生成的状态或变体。

### temporary

等待正式资源期间使用的临时占位资源。

---

# 7. 图片需求生成

剧情 AI 不直接输出最终 Prompt。

剧情系统只负责生成结构化的视觉需求：

```json
{
  "type": "character",
  "role": "merchant",
  "gender": "male",
  "age": "middle_age",
  "species": "human",
  "theme": "dark_fantasy",
  "importance": "normal",
  "appearance": {
    "clothing": "worn leather coat",
    "hair": "gray",
    "body": "thin"
  }
}
```

然后交给：

```text
Visual Requirement
        ↓
Asset Matcher
        ↓
Prompt Builder
        ↓
Image Model Adapter
```

---

# 8. 为什么禁止剧情 AI 直接写生图 Prompt

如果剧情模型直接生成 Prompt，会出现：

- 风格描述不统一
- Prompt 长短不稳定
- 重要属性遗漏
- 不同模型 Prompt 格式不兼容
- 后期换模型成本高
- 同一角色重新生成时难以保持一致

因此必须加入独立的：

## Prompt Builder

负责把结构化数据转换成具体模型所需 Prompt。

例如：

```text
角色定义
+
题材 Style Profile
+
构图模板
+
模型专用参数
+
Negative Prompt
```

最终生成真正的模型请求。

---

# 9. Style Profile

每个题材建立统一的视觉 Style Profile。

例如：

```json
{
  "theme_id": "dark_fantasy",
  "art_style": "...",
  "lighting": "...",
  "color_language": "...",
  "character_proportion": "...",
  "environment_style": "...",
  "camera_rules": "...",
  "sprite_rules": "..."
}
```

所有：

- NPC
- 建筑
- 场景
- 怪物
- 战斗背景
- 小镇

都引用同一个 Style Profile。

这样可以减少同一个世界中出现明显的视觉割裂。

---

# 10. 素材匹配系统 Asset Matcher

当剧情产生一个视觉需求时，系统首先搜索素材库。

推荐匹配维度：

```text
Theme
Asset Type
Entity Type
Gender
Age
Species
Profession
Environment
Building Type
State
Importance
```

可以计算一个匹配分：

```text
match_score =
theme_weight
+ type_weight
+ semantic_weight
+ appearance_weight
+ state_weight
```

例如：

剧情需求：

```text
男性
中年
贫穷商人
黑暗奇幻
```

已有素材：

```text
男性
中年
普通商人
黑暗奇幻
```

可能达到 90% 匹配度，可以直接使用。

---

# 11. 匹配等级

建议划分：

### Level 0 — 完全匹配

直接使用。

不生成新图片。

### Level 1 — 高度匹配

直接使用。

通常不需要生成。

### Level 2 — 可接受匹配

先使用。

根据资源重要度决定是否后台生成。

### Level 3 — 低匹配

作为临时占位。

后台生成正式资源。

### Level 4 — 无匹配

使用通用占位图。

立即进入生成队列。

---

# 12. 资源重要度

不同剧情资源不应该拥有相同生成优先级。

建议：

```text
critical
important
normal
ambient
```

### critical

- 主线 Boss
- 主线 NPC
- 核心剧情地点

必须生成独特资源。

### important

- 支线核心人物
- 特殊建筑
- 特殊怪物

优先生成。

### normal

普通 NPC / 场景。

优先复用素材。

### ambient

纯装饰性内容。

原则上禁止实时生成。

---

# 13. 异步生成流程

完整流程：

```text
剧情生成实体
      ↓
产生 Visual Requirement
      ↓
查询 Asset Library
      ↓
计算 Match Score
      ↓
 ┌───────────────┐
 │ 有合适资源？   │
 └───────┬───────┘
         │
    Yes  │  No
         │
         ↓
 直接绑定资源     使用临时资源
                    ↓
              创建 Generation Job
                    ↓
               后台 AI 生图
                    ↓
                Quality Check
                    ↓
                资源入库
                    ↓
               更新 Entity Asset
                    ↓
                 前端替换
```

关键要求：

> 图片生成失败不能阻塞剧情。

---

# 14. Generation Job

建议生成任务结构：

```json
{
  "job_id": "gen_234",
  "entity_id": "npc_834",
  "asset_type": "character_portrait",
  "priority": 80,
  "visual_requirement_id": "vr_123",
  "status": "queued",
  "retry_count": 0,
  "created_at": 0
}
```

状态：

```text
queued
generating
reviewing
ready
failed
cancelled
```

---

# 15. 生成优先级队列

建议优先级：

```text
玩家当前正在观看的资源
>
主线资源
>
当前地图资源
>
重要 NPC
>
支线资源
>
环境补充资源
```

例如：

玩家正在进入：

> 血月古庙

则古庙场景生成优先级高于：

> 20 分钟后可能遇见的 NPC。

---

# 16. 人物图片架构

角色建议拥有统一的视觉身份 `CharacterVisualProfile`。

例如：

```json
{
  "character_id": "npc_102",
  "theme": "dark_fantasy",
  "gender": "male",
  "age": 42,
  "body": "thin",
  "hair": "gray short hair",
  "face": "long face",
  "clothing": "brown leather coat",
  "signature_features": [
    "scar on left cheek"
  ]
}
```

所有人物图片必须引用这个 Profile。

然后派生：

```text
Portrait
Town Sprite
Battle Sprite
Dialogue Avatar
State Variant
```

而不是分别重新描述人物。

这样可以最大程度保证：

> “同一个人看起来始终是同一个人。”

---

# 17. 人物预生成策略

七种题材分别建立人物基础库。

建议每个题材至少覆盖：

```text
性别
年龄层
职业
社会阶层
战斗职业
普通 NPC
```

例如：

```text
Male / Female

Child
Young
Middle Age
Old

Merchant
Farmer
Guard
Soldier
Blacksmith
Priest
Noble
Bandit
Mage
Hunter
Innkeeper
```

同一人物模板可包含：

```text
Portrait
Town Idle
Town Walk
Battle Idle
Battle Attack
Battle Hurt
Battle Death
```

第一阶段不需要覆盖所有组合，可以从高频组合开始。

---

# 18. 场景图片策略

普通场景可以直接按描述生成，例如：

```text
森林
洞穴
房间
酒馆
地牢
神殿
城堡
```

场景通常不要求像小镇一样保持严格的空间逻辑。

因此可以采用：

```text
结构化地点描述
    ↓
查找场景素材
    ↓
相似素材临时使用
    ↓
必要时生成新图
```

---

# 19. 地点视觉对象

一个逻辑地点不应该只对应一张图片。

例如：

```text
Ancient Temple
```

可以拥有：

```text
Location Icon
Exterior Scene
Interior Scene
Battle Background
Destroyed Version
Night Version
```

因此建议：

```text
Location
   ↓
VisualAssetGroup
   ├─ icon
   ├─ exterior
   ├─ interior
   ├─ battle_background
   └─ variants
```

---

# 20. 小镇属于特殊资源类型

小镇与普通场景最大的区别是：

> **小镇本身具有真实可交互空间结构。**

它包含：

- 格子地图
- 道路
- 广场
- 建筑位置
- 建筑入口
- 装饰
- 行走路径
- NPC 活动区域

因此不适合完全由 AI 直接生成整张地图。

---

# 21. 小镇最终建议方案

第一阶段建议：

## “离线程序化生成 + 预制布局库 + 动态建筑替换”

而不是：

## “每次游戏运行实时程序化生成完整小镇”

---

# 22. 小镇布局库

开发阶段使用程序生成器批量生成小镇布局。

例如：

```text
Town Layout 001
Town Layout 002
Town Layout 003
...
Town Layout 050
```

每个布局固定：

```text
道路
广场
河流
绿化
装饰区域
建筑插槽
入口
边界
```

保存为结构化地图。

例如：

```json
{
  "layout_id": "town_018",
  "size": [50, 50],
  "roads": [],
  "plazas": [],
  "decorations": [],
  "building_slots": []
}
```

---

# 23. 七种题材 × 小镇布局

不一定需要：

```text
50 Layout × 7 Theme = 350 个完全不同地图
```

更好的方式是：

```text
Geometry Layout
+
Theme Skin
```

即：

```text
同一个几何布局
↓
不同题材视觉资源
```

例如：

Town Layout 018 可以表现成：

```text
中世纪小镇
东方武侠城镇
废土聚居地
蒸汽朋克城市
黑暗奇幻村镇
```

地图逻辑结构不变。

---

# 24. 小镇建筑采用插槽系统

布局只定义：

```text
building_slot_01
building_slot_02
building_slot_03
```

每个 Slot 保存：

```text
位置
尺寸
入口
朝向
允许建筑类型
```

剧情决定：

```text
building_slot_03 = blacksmith
```

系统再从素材库查找对应建筑。

---

# 25. 小镇建筑生成策略

例如剧情要求：

> 炼金术师商店

处理顺序：

```text
查找已有炼金术商店
↓
没有
↓
查找尺寸 / 风格相近商店
↓
临时展示
↓
后台生成新建筑
↓
替换
```

必须保证：

```text
建筑视觉尺寸
≈
建筑 Slot 尺寸
```

否则会破坏地图布局。

---

# 26. 小镇装饰

街道、广场、树木、路灯、摊位、围栏等装饰：

**原则上不实时 AI 生成。**

原因：

- 数量大
- 复用率高
- 对剧情唯一性要求低
- 容易造成风格和尺寸不一致

建议使用：

```text
Theme Decoration Kit
```

例如：

```text
dark_fantasy/
  road/
  lamp/
  tree/
  bench/
  fence/
  cart/
  stall/
```

由程序按布局摆放。

---

# 27. 是否使用“整张小镇 AI 图生图”

可以作为：

- 世界地图展示图
- 进入小镇时的过场图
- 氛围图
- Loading Illustration

但不建议把 AI 生成的整张图直接作为实际交互地图。

原因：

- AI 很难严格保持道路坐标
- 建筑位置容易偏移
- 入口位置无法保证
- 后期建筑动态变化难修改
- 无法可靠映射碰撞和导航

因此：

```text
Playable Town Map = 程序资源
Cinematic Town View = AI 图片
```

两者可以共享同一布局作为参考。

---

# 28. 内景生成

室内场景不需要小镇级别的复杂布局控制。

第一阶段建议直接：

```text
地点结构化描述
+
题材 Style Profile
+
场景类型
+
关键物件
↓
AI Scene Generation
```

例如：

```json
{
  "scene": "tavern_interior",
  "theme": "dark_fantasy",
  "quality": "poor",
  "time": "night",
  "features": [
    "large fireplace",
    "wooden tables",
    "few customers"
  ]
}
```

---

# 29. 资源绑定

生成成功的资源必须绑定逻辑实体。

例如：

```text
npc_134
→ portrait_asset_782
```

后续再次加载 NPC：

不能重新搜索素材。

必须优先读取绑定关系。

否则角色外观会发生变化。

---

# 30. Resource Lock

对于已经正式确定外观的实体：

```text
visual_locked = true
```

例如：

- 玩家角色
- 主线 NPC
- Boss
- 核心地点

锁定后禁止系统自动换成其他素材。

只有：

- 玩家主动重新生成
- 剧情状态发生变化
- 开发者更新

才能替换。

---

# 31. 玩家主动重新生成

即使系统已经匹配到一个高质量预制素材，也可以允许玩家：

```text
重新生成
```

流程：

```text
Existing Asset
↓
User Regenerate
↓
Create Generation Job
↓
Generate Candidate
↓
Preview
↓
Confirm
↓
Replace
```

建议旧资源不要立即删除，便于：

```text
Undo
```

---

# 32. 图片版本管理

建议：

```text
asset_v1
asset_v2
asset_v3
```

结构：

```json
{
  "asset_id": "portrait_102_v3",
  "entity_id": "npc_84",
  "version": 3,
  "previous_version": "portrait_102_v2"
}
```

---

# 33. AI 模型适配层

不能让业务直接调用具体生图模型。

应增加：

```text
ImageGenerationProvider
```

接口示例：

```text
generate_character()
generate_scene()
generate_building()
generate_variant()
generate_sprite()
```

底层可以替换：

```text
Provider A
Provider B
Local Model
Cloud API
```

业务层不需要修改。

---

# 34. 推荐模块划分

```text
Visual Requirement Service
        │
        ▼
Asset Matching Service
        │
        ├── Asset Library
        │
        ▼
Generation Orchestrator
        │
        ▼
Prompt Builder
        │
        ▼
Image Model Adapter
        │
        ▼
Quality Validator
        │
        ▼
Asset Storage
        │
        ▼
Entity Asset Binding
```

---

# 35. Asset Library

职责：

- 图片存储
- Tag 存储
- 相似度搜索
- Theme 分类
- 类型分类
- 版本管理
- 使用次数统计
- 资源质量评分

未来可以增加：

```text
Embedding Search
```

用于视觉 / 语义相似度匹配。

---

# 36. Quality Validator

生成完成后不一定立即投入使用。

至少检查：

```text
尺寸
透明背景
文件格式
主题一致性
角色数量
构图
明显畸形
内容安全
```

对于序列帧还需要检查：

```text
帧数
角色尺寸
角色位置
背景透明
动作连续性
```

---

# 37. 生成预算控制

生成系统需要预算限制。

可以按：

```text
Session
Chapter
Player
World
Day
```

设置生成额度。

例如：

```text
主线资源：不限 / 高预算
普通 NPC：优先素材库
环境装饰：禁止实时生成
```

避免 AI 剧情无限创建视觉对象导致成本爆炸。

---

# 38. 去重机制

生成之前再次检查：

```text
是否已经存在近似资源？
```

例如已经拥有：

```text
dark_fantasy_abandoned_temple_03
```

剧情再次创建：

```text
abandoned ancient shrine
```

如果匹配度足够高：

不生成。

---

# 39. 素材库自增长

运行时生成的新素材经过验证后可以加入公共素材池。

系统长期运行后：

```text
已有素材数量 ↑
实时生成比例 ↓
生成成本 ↓
资源匹配速度 ↑
```

形成：

> AI 生成 → 素材沉淀 → 后续复用

的循环。

---

# 40. 缓存策略

建议分：

### Global Asset Cache

所有世界可复用。

例如：

```text
普通村民
普通树木
普通房屋
```

### Theme Asset Cache

同题材复用。

例如：

```text
Dark Fantasy Tavern
```

### World Asset Cache

只属于当前世界。

例如：

```text
Blood Moon Temple
```

### Entity Asset

绑定具体实体。

例如：

```text
NPC Marcus Portrait
```

---

# 41. 玩家体验原则

图片生成的存在应该尽量对玩家透明。

不要频繁展示：

```text
AI 正在生成……
```

推荐：

玩家先看到可用素材。

生成完成后：

```text
无感替换
```

只有玩家主动点击：

```text
重新生成
```

时才需要明确展示生成过程。

---

# 42. MVP 范围

第一阶段不需要解决所有图片问题。

建议 MVP：

### 固定资源

- 完整 UI
- 通用 Icon

### 七题材基础资源库

每个题材：

- 角色基础模板
- 常见 NPC
- 常见怪物
- 常见建筑
- 常见场景

### 小镇

- 20～50 套几何布局
- Theme Decoration Kit
- Building Slot
- 预制建筑库

### 动态生成

支持：

- NPC 立绘
- 关键场景
- 特殊建筑
- Boss

### 暂不优先

- 高复杂度 AI 动画
- 任意动作实时生成
- AI 实时生成完整可交互地图

---

# 43. MVP 推荐开发顺序

```text
1. Visual Asset 数据结构
2. Asset Library
3. Tag 系统
4. Asset Matcher
5. Entity Asset Binding
6. Style Profile
7. Prompt Builder
8. Image Generation Provider
9. Generation Queue
10. Async Replace
11. Town Layout Library
12. Building Slot System
13. Variant System
14. Player Regenerate
```

---

# 44. 关键验收标准

系统满足以下条件，可以认为第一版架构成立：

### 资源复用

普通 NPC 不需要每次生成图片。

### 非阻塞

生成图片失败或延迟不会阻止玩家继续游戏。

### 一致性

同一个 NPC 多次出现时视觉保持一致。

### 题材一致

同一世界的角色、建筑、场景符合统一 Style Profile。

### 小镇可控

AI 图片不会破坏小镇真实的格子、道路和建筑布局。

### 可扩展

更换底层生图模型不需要修改剧情系统。

### 可沉淀

运行时生成的新资源可以进入素材库。

---

# 45. 最终架构总结

整个图片系统不是：

```text
剧情
↓
AI 生图
↓
展示
```

而是：

```text
                 ┌──────────────┐
                 │  剧情 AI      │
                 └──────┬───────┘
                        │
                        ▼
                Visual Requirement
                        │
                        ▼
                 Asset Matcher
                   /          \
              命中资源        无资源
                │              │
                ▼              ▼
             直接使用       临时资源
                               │
                               ▼
                       Generation Queue
                               │
                               ▼
                        Prompt Builder
                               │
                               ▼
                       Image Provider
                               │
                               ▼
                      Quality Validator
                               │
                               ▼
                         Asset Library
                               │
                               ▼
                         Entity Binding
                               │
                               ▼
                          前端自动替换
```

核心思想可以概括为一句话：

> **AI 不是每次重新绘制世界，而是在游戏运行过程中持续补全和扩充一个可复用的视觉资产库。**

这样可以同时兼顾：

- AI 世界的开放性
- 游戏响应速度
- 图片质量
- 风格一致性
- API 成本
- 工程可控性
- 长期资产积累
