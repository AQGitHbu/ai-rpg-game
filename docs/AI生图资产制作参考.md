# AI 生图资产制作参考

> 状态：开发前调查与生产规范草案（2026-08-12）  
> 当前事实：正式运行时**没有任何 AI 生图调用**；图片服务不可用时，创建、游玩、保存和结局必须全部可用。

## 1. 当前视觉实现

- 新游戏页使用 `public/assets/genres/` 的 7 张题材封面 JPG。
- 小镇地图复用 `public/assets/town/` 的 8 张静态建筑 WebP；它们来自历史预设图，不是运行时生成。
- 世界地图、地点背景、NPC、事实、物品和敌人主要仍由 `AdventureVisual` 的几何 SVG 占位。
- 玩家没有正式战斗角色图；敌人只有静态占位，战斗没有角色动作序列帧。
- 序幕、幕切换和结局没有专属插图或 CG。

图片永远只属于表现层：地图节点、建筑坐标、NPC、道具、任务、伤害和结局都由结构化状态裁决，不能从图片反推。

## 2. 接入原则

1. 只有已通过规则审批并正式具象化的实体才能请求专属图片，禁止为未来隐藏实体提前生成。
2. 生图失败、超时、排队或旧图过期不得阻塞回合；降级顺序为“专属图 → 同题材模板 → 通用剪影 → 当前 SVG/渐变/文字”。
3. Prompt 只使用玩家已知的公开资料，不包含隐藏事实、NPC 私密记忆、内部 ID、候选事件和玩家自由输入原文。
4. 同一角色、地点或建筑的所有图引用稳定视觉档案；更换 Prompt 或模型只生成新版本，不覆盖旧存档仍在引用的资产。
5. 生图内禁止文字、数字、标志、水印和规则数值；名称、标签和数值始终由 HTML/SVG UI 渲染。
6. 对话、动画播放和玩家输入过程中不热切图片；在场景切换或下次进入时替换。
7. 不使用在世艺术家姓名作为风格 Prompt。

建议资产状态：

```ts
type AssetStatus =
  | "not_requested"
  | "queued"
  | "generating"
  | "ready"
  | "failed"
  | "stale";
```

## 3. 图片需求总表

| 模块 / 资产 | 使用位置与生成时机 | 推荐源规格 | 关键要求 |
|---|---|---|---|
| 题材封面 | 新游戏题材卡；预制 | 1024×576，16:9，不透明 | 单一标志性环境，缩到卡片仍可辨，中心安全区 |
| 玩家头像 / 立绘 | HUD、角色面板、对话、战斗 | 1024×1365，3:4，优先透明 | 面容、体型、服饰、标志道具稳定；圆形裁切仍清晰 |
| NPC 头像 / 立绘 | NPC 热点、90×120 对话立绘、资料 | 1024×1365，3:4，优先透明 | 固定角色档案；表情变化不改身份特征 |
| 世界大地图底图 | 全屏地图装饰；开局世界批准后 | 2048×1152，16:9 | 鸟瞰绘制地图；节点区低细节；不能画未批准地点 |
| 地图节点图标 | 当前、可前往、访问过、锁定地点 | 512×512，透明 | 单体剪影、轮廓明确；地点种类一眼可区分 |
| 地点发现插图 | 新地点首次批准/发现 | 1536×1024，3:2 | 地标明确；不出现未批准 NPC、敌人或建筑 |
| 小镇地形 tile | 草地、森林、水、道路、广场、雾、损毁 | 256/512 方形，透明或无缝 | 垂直正俯视、无透视、边缘连续、可平铺 |
| 小镇建筑屋顶 | 覆盖确定性 footprint | 1024 方形源，运行时 256/512 WebP | 单体、垂直正俯视、透明底优先、无人物文字 |
| 建筑外观 | 建筑选择卡、进入前展示 | 1536×1024，3:2 | 三分之四视角、入口清晰，与屋顶视觉档案一致 |
| 场景内景 / 地点背景 | `LocationSceneScreen` | 1920×1080，16:9 | 中部留叙事区、右侧留 NPC、底部留行动栏 |
| 时间 / 天气 / 损毁变体 | 已发现地点的公开状态改变后 | 与基础背景相同 | 只改变公开状态，不改变固定建筑结构 |
| 道具 / 装备图标 | 地点热点、背包、给予、奖励 | 512 方形，透明 | 单件居中、轮廓完整、64px 仍可辨 |
| 线索 / 事实图标 | 调查热点、日志、发现反馈 | 256 方形，透明 | 抽象符号，不把线索答案直接画出来 |
| 任务 / 技能 / 行动图标 | HUD、任务与已实现技能 | 256 方形，透明 | 统一描边与视角；没有规则能力则不生成死图标 |
| 敌人立绘 | 场景预警、战斗、敌人资料 | 1024×1365 或 1536 方形，透明 | 全身和武器完整；体型匹配结构化威胁等级 |
| 战斗背景 | 战斗视窗 | 1920×1080，16:9 | 侧视舞台、地平线清楚、中部无大型遮挡 |
| 角色 / 敌人动作序列帧 | 战斗表现 | 每帧 512×512，透明 | 固定相机、尺度、脚底线、朝向、服装、武器、光照 |
| 战斗特效序列帧 | 斩击、受击、法术、投射物、状态 | 每帧 256/512，透明 | 无人物肢体和背景；不能决定伤害 |
| 序幕 / 章节插图 | 序幕和幕切换 | 1920×1080，16:9 | 氛围优先；不泄漏未来实体 |
| 结局 CG | 结构化结局写入后 | 1920×1080，16:9 | 只表现已确定结果，不能提前生成另一结局 |
| 加载 / 离线降级图 | 生图排队、失败、离线 | 1024×576 | 明确为通用氛围图，不伪装成专属地点 |
| UI 装饰 | 边框、光标、目标标记、对话提示 | 128–512，透明 | 统一设计系统；禁用生图文字 |

## 4. 触发与优先级

```text
开局切片审批完成
  → 玩家立绘、起始地点、开场 NPC、大地图装饰

世界演化提案审批并写回
  → 新地点 / NPC / 道具 / 敌人进入资产队列

玩家即将进入地点或建筑
  → 当前背景、关键 NPC、建筑外观提升优先级

战斗即将开始
  → 战斗背景和双方最低动作集提升为 P0

结构化结局已写入
  → 结局文本立即显示，结局 CG 异步生成
```

| 优先级 | 资产 |
|---|---|
| P0 | 当前背景、当前核心 NPC、当前战斗双方最低动作集 |
| P1 | 当前任务建筑、可取得道具、当前地点关键人物 |
| P2 | 大地图/小镇增强、新装备图标、表情和天气变体 |
| P3 | 尚未进入的内景、非核心 NPC |
| P4 | 泛化建筑、章节装饰、非交互环境细节 |

建议预取窗口只覆盖“当前场景 + 已解锁且一步可达地点”，避免为玩家未选择的分支付费。

## 5. Prompt 模板

### 5.1 通用正向模板

```text
资产类型：{assetKind}。
题材视觉档案：{genreStyleProfile}。
对象公开视觉档案：{immutableVisualProfile}。
当前已批准状态：{publicStateVariant}。
构图和安全区：{compositionAndSafeArea}。
镜头：{cameraAndPerspective}。
光照和色板：{lightingAndPalette}。
输出：{width}×{height}，{backgroundMode}，主体完整，无文字、标志和水印。
保持与参考图的面容、体型、服装结构、材质、主色和标志性道具一致。
```

### 5.2 通用负向建议

```text
文字，汉字，字母，数字，字幕，签名，水印，logo，UI 边框；
未经批准的角色、地点、建筑、敌人、神器或结局；
重复主体，多余肢体，错误手指，武器断裂，左右手变化；
主体裁切，脚底离画布，镜头漂移，比例变化，透视变化；
发型、年龄、肤色、服装主色、标志物漂移；
跨题材现代物件，照片与绘画风混合，低清晰度，JPEG 毛边；
过度血腥、色情和仇恨符号。
```

### 5.3 七题材风格锚点

| 题材 | 建议锚点 |
|---|---|
| 武侠 | 国风半写实，写意山水，历史服饰与木构，克制电影光影 |
| 仙侠 | 东方幻想，云海仙山，玉石与灵光，华丽但轮廓清楚 |
| 奇幻 | 西方幻想概念艺术，半写实油画材质，中世纪建筑与魔法光 |
| 科幻 | 科幻概念设计，工业结构，冷暖霓虹，清晰机械材质 |
| 都市 | 当代电影感，可信街景，自然灯光或悬疑夜景 |
| 历史架空 | 历史电影概念艺术，可信服饰建筑，不出现真实历史人物肖像 |
| 末日 | 废土概念艺术，风化材质，低饱和光影，资源匮乏感 |

### 5.4 专项 Prompt 补充

小镇建筑屋顶：

```text
一栋{buildingType}，垂直正上方 90 度俯视，2D 游戏地图屋顶贴图；
主体居中并尽量满幅，完整外轮廓，固定北向，柔和均匀漫射光；
透明背景，不含道路、人物、招牌文字、阴影地面和透视立面。
```

场景背景：

```text
宽银幕环境概念图，镜头高度与地平线固定；
中部低对比留给叙事文本，右侧留出角色立绘安全区，底部留行动栏；
只出现已批准的地标和公开状态，不出现可误认成按钮的发光物件。
```

道具图标：

```text
单件{itemKind}，正交产品展示视角，完整外轮廓，中心构图；
透明背景，统一左上柔光，不出现手、场景、文字、数量和稀有度边框。
```

## 6. 角色与建筑一致性

首次批准角色时建立不可随意变化的视觉档案：

```json
{
  "profileVersion": 1,
  "ageBand": "adult",
  "bodyType": "lean",
  "face": "oval face, narrow eyes, short scar above left eyebrow",
  "hair": "black, tied high",
  "costume": "dark indigo travel robe",
  "palette": ["#20283a", "#6f5842", "#b89b62"],
  "signatureProps": ["single straight sword", "brown shoulder satchel"],
  "forbiddenChanges": ["hair color", "weapon type", "scar side"]
}
```

- 头像、半身、全身、表情、战斗帧和结局图都引用同一档案及参考图。
- 表情/姿势/光照可作为 variant；面容、体型、服装结构和标志物不可漂移。
- 装备变化只能来自已提交的结构化装备事实。
- NPC 表情建议最小集：`neutral / friendly / angry / worried / injured`；关系数值不直接写进 Prompt。
- 建筑发现后锁定位置与基础外观；夜景、封闭和损毁属于派生 variant。屋顶、外观、内景引用同一 `BuildingVisualProfile`。

## 7. 战斗动作序列帧

### 7.1 动作与帧数

当前规则只正式支持基础攻击和敌方反击，因此最低 P0 集合为：

| 动作 | 帧数 | 播放速度 | 循环 / 命中点 |
|---|---:|---:|---|
| `idle` | 8 | 8 fps | 循环 |
| `basic_attack` | 8 | 12–16 fps | 不循环，第 5 帧为视觉命中点 |
| `hit` | 4 | 14 fps | 不循环，不改变规则站位 |
| `death` | 8 | 10 fps | 不循环，保持最后一帧 |
| `victory` | 8 | 8–10 fps | 不循环，可保持最后一帧 |
| `battle_enter` | 8 | 12 fps | P1，可延后 |

只有规则行动实际落地后才可增加：`heavy_attack` 12 帧、`cast_or_skill` 12 帧、`guard` 4 帧、`dodge` 8 帧、`walk/run` 8 帧、`spawn/summon` 8 或 12 帧。动画事件只触发声音、闪光、震屏与伤害数字，实际伤害必须先由规则结算。

### 7.2 Sheet 排列

- 单帧固定 `512×512`；一个动作一张 sheet，不混合多个动作。
- 固定 4 列，按从左到右、从上到下的时间顺序：

```text
4 帧  = 2048×512  （4×1）
8 帧  = 2048×1024 （4×2）
12 帧 = 2048×1536 （4×3）
```

- 每格脚底 pivot 固定为 `(256, 448)`，即 `(0.5, 0.875)`；主体安全区 `x=32..480, y=24..472`。
- 默认源图朝右。只有完全对称或可安全镜像的角色设置 `mirrorSafe: true`。
- 文字徽记、机械义肢、固定左右手武器、单侧伤疤等角色要分别生成左右朝向。
- 相机、角色高度、地面线、光照、影子和武器长度在所有动作中固定。
- 无法直接产透明底时，用不与角色色板重合的纯色色键底，禁止复杂场景。

序列帧 Prompt 附加：

```text
exact 4-column sprite sheet, row-major chronological frames,
one identical character only in every cell,
fixed orthographic side-view camera, fixed scale and ground baseline,
complete body and weapon visible in every frame,
smooth readable key poses, transparent or uniform chroma background,
no panel borders, labels, frame numbers, perspective or lighting change
```

### 7.3 切割、去底与合并规则

1. 校验源图宽高能被 512 整除、列数为 4、总格数与动作合同一致。
2. 先对整张 sheet 统一去底与去色溢，再按固定网格切割；禁止目标检测猜格子。
3. 每帧保留 512×512 画布，不单帧自动居中，否则会造成角色抖动。
4. 校正公共脚底 pivot；主体上下漂移建议不超过 4px。
5. 自动检查重复帧、顺序、角色数量、服饰/武器连续性和 alpha 白边。
6. atlas 可裁透明边，但 metadata 必须保存 `sourceSize`、`spriteSourceSize` 和 pivot 偏移。
7. atlas 禁止旋转，建议 padding 4px、extrusion 2px，避免纹理采样串色。
8. GIF/WebP 动画只作 QA 预览，不作运行时资源；源 sheet、切片帧、atlas、metadata 分目录保存。

建议 metadata：

```json
{
  "schemaVersion": "combat-sprite-v1",
  "assetId": "npc_0.combat.default.v1",
  "image": "npc_0.combat.default.v1.png",
  "sourceFrameSize": { "width": 512, "height": 512 },
  "pivot": { "x": 0.5, "y": 0.875 },
  "facing": "right",
  "mirrorSafe": false,
  "atlas": { "rotationAllowed": false, "padding": 4, "extrude": 2 },
  "animations": {
    "idle": { "loop": true, "frames": [{ "frame": "idle_00", "durationMs": 125 }] },
    "basic_attack": {
      "loop": false,
      "frames": [{ "frame": "attack_00", "durationMs": 75 }],
      "events": [{ "frameIndex": 4, "type": "impact_visual" }]
    },
    "death": {
      "loop": false,
      "holdLastFrame": true,
      "frames": [{ "frame": "death_00", "durationMs": 100 }]
    }
  }
}
```

### 7.4 序列帧 QA

- 帧数、顺序、尺寸和动作名精确匹配合同；每格只有一个角色。
- 不出现额外肢体、重复头部、第二把武器；脸、身高、服装主色、武器长度、光照稳定。
- 首尾可与 idle 顺接；命中帧轮廓清楚但不承担规则伤害。
- 头、脚和武器完整处于安全区；alpha 无色键残留、白边和相邻格污染。
- 缩到 64/96px 后仍能分辨动作。
- metadata frame rect 全在图集范围内，名称不重复，命中事件索引合法。

## 8. 小镇图片专项

- 确定性网格仍是权威地图；图片是 `pointer-events: none` 的装饰层，点击和键盘入口继续来自结构化建筑矩形。
- 最低覆盖：`tavern / blacksmith / house / shop / workshop / warehouse / well / gatehouse`。
- 当前 8 张历史预设为中式古镇风，只适合武侠、仙侠和部分历史架空；未来正式资产应做 `genre × buildingType` 映射或清楚的同题材 fallback。
- 未探索剧情建筑不得请求或加载精确类型图片，只显示通用未知屋顶/遮罩，避免视觉和 DOM 泄漏。
- 当前历史素材存在部分轻微斜视角，正式生成应统一为严格垂直俯视、透明底和固定北向。

## 9. 命名、缓存与版本

```text
public/assets/static/genres/
public/assets/static/fallbacks/
generated/{gameId}/{assetKind}/{entityId}/{variant}/
source-sheets/{actorId}/{skin}/{action}/{direction}/
atlases/{actorId}/{skin}/
```

文件名：

```text
{entityId}.{assetKind}.{variant}.v{profileVersion}.{ext}
npc_0.portrait.neutral.v1.webp
loc_0.scene.day-clear.v1.webp
enemy_2.combat.default.v2.png
```

生成缓存键至少包含：

```text
assetKind + entityId + visualProfileVersion + stateVariant
+ genreStyleVersion + promptTemplateVersion + modelId/modelVersion
+ outputSize + referenceAssetHash
```

对规范化 JSON 计算 SHA-256 作为 `generationKey`。相同 key 不重复计费生成；Prompt、模型、尺寸或视觉档案变化后标记旧图 `stale`，旧图仍可作 fallback。

## 10. 安全与合规

- 生图请求和日志不记录 API key、完整 Prompt、玩家原文、隐藏剧情或私密 NPC 记忆。
- 参考图来源、许可、模型条款、商用权限和人物肖像权需要随资产记录审计字段。
- 真实人物、商标、受保护角色和仿冒 UI 不进入 Prompt；用户上传参考图需要明确授权和删除策略。
- 内容强度只影响公开且已批准的表现，不允许生图绕过产品的色情、极端血腥、仇恨或未成年人安全规则。

## 11. 完成门禁与建议顺序

验收：

- 生图失败或离线时，短篇仍能抵达并恢复结局。
- 图片不泄漏未发现地点、未绑定建筑、隐藏 NPC 或另一结局。
- 同一角色跨头像、场景和战斗可识别；不同 NPC 不串脸。
- 40px 头像、64px 道具和缩小建筑仍可辨；桌面/窄屏裁切保留主体和操作区。
- 不出现文字、水印、跨题材物件和明显生成伪影。
- 序列帧通过尺寸、锚点、alpha、顺序和 metadata 自动校验。

建议实施顺序：

1. 先维护当前静态小镇建筑图和各题材 fallback，不接运行时生图。
2. 建立 `VisualProfile`、资产状态、缓存 key、版本和审计契约。
3. 接地点背景、核心 NPC、道具与敌人静态图，并验证离线降级。
4. 实现玩家/敌人 P0 动作集、自动切割/图集/QA 工具。
5. 最后接天气变体、小镇增强、章节插图与结局 CG。
