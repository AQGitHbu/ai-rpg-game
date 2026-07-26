# AI 生成 RPG MVP 开发 Spec

> 日期：2026-07-26
> 状态：可进入 Plan/开发
> 产品规则源：`docs/策划文档/AI生成RPG_MVP.md`
> 原始设想：`docs/设想/AI驱动RPG_MVP开发Spec_v0.1.md`（参考，不再覆盖本 Spec 的已确认决策）

## 1. 交付目标

交付一个可以从玩家输入动态生成、规则可验证、能保存并走到至少两个结局的单人叙事 RPG MVP。开局输入包括预设游戏类型、角色名字、角色基础信息、世界观背景、故事开端、叙事风格与内容强度。具体剧情、角色和场景不是预写固定内容。

开发必须保持：AI 生成候选，规则编译与裁决，应用层编排，UI 只消费 read model。无 AI 时使用确定性模板仍可完整通关。

## 2. MVP 边界

### 包含

- 七种配置化游戏类型及其 AI/绘图风格边界；
- 新游戏输入与本局世界蓝图生成；
- 4 个主要地点、最多 1 个隐藏地点；
- 4–6 名核心 NPC、最多 1 名同伴；
- 三阶段主线、最多 2 条短支线、2 个结局；
- 地点探索、NPC 交谈、调查、物品、移动与轻量回合制战斗；
- 固定选项和自然语言输入；
- NPC 知识、关系、事件和分层记忆；
- 单机 SQLite 存档、结构化日志、固定 seed 回归；
- AI 文本调用和模板降级；图片只做异步接口与默认素材降级。

### 不包含

- 无限开放世界、无上限生成、多人、云存档、多账户；
- 实时动作战斗、复杂技能树、经济模拟、建造；
- AI 自创数值规则、技能机制或任意装备词条；
- 运行时必须成功的图片/语音生成；
- 向量数据库；MVP 先用结构化事实与摘要；
- 把 SLG GameState、回合引擎、地图或业务 UI 复制进来。

## 3. 输入与配置契约

```ts
export type GameTypeId =
  | "wuxia"
  | "xianxia"
  | "fantasy"
  | "science_fiction"
  | "urban"
  | "alternate_history"
  | "post_apocalypse";

export type NarrativeStyle = "concise" | "novel" | "cinematic";
export type ContentIntensity = "normal" | "dark";

export type NewGameInput = {
  gameType: GameTypeId;
  characterName: string;
  characterIdentity: string;
  characterProfile?: string;
  personalityTags: string[];
  worldPremise: string;
  storyOpening: string;
  narrativeStyle: NarrativeStyle;
  contentIntensity: ContentIntensity;
};
```

字段长度和标签数量必须在客户端与服务端共同校验；服务端是最终边界。输入中的数值、物品、身份权力和事件结果只作为生成上下文，不直接成为 GameState。

`data/base/gameTypeProfiles.json` 保存七种类型配置，至少包含 `id/label/worldConstraints/allowedTags/forbiddenTags/namingGuide/artStyleProfileId`。`data/base/artStyleProfiles.json` 保存绘图 prompt 前缀、色彩、材质、构图和 negative prompt。配置加载器必须验证 ID 唯一与引用完整性。

## 4. 核心数据契约

```ts
type ScenarioBlueprint = {
  schemaVersion: 1;
  generationId: string;
  seed: string;
  gameType: GameTypeId;
  inputDigest: string;
  world: WorldDefinition;
  player: GeneratedPlayerDefinition;
  locations: LocationDefinition[];
  npcs: NpcDefinition[];
  quests: QuestDefinition[];
  enemies: EnemyTemplate[];
  items: ItemDefinition[];
  endings: EndingDefinition[];
  openingScene: SceneDefinition;
  contentBudget: ContentBudget;
};

type ContentBudget = {
  mainLocations: 4;
  hiddenLocationsMax: 1;
  coreNpcsMin: 4;
  coreNpcsMax: 6;
  companionsMax: 1;
  sideQuestsMax: 2;
  endings: 2;
};
```

具体子类型在 `src/game/domain/` 中定义，并通过 facade 导出。所有定义使用稳定 ID；文本名称不能作为引用键。任务 objective 只能使用规则系统已实现的类型。任务图必须有唯一当前主线阶段、可达结局和明确关闭方式。

运行时状态至少包括：玩家状态、当前位置与已解锁地点、NPC 状态与知识、任务状态、背包/装备、战斗状态、结构化世界事实、事件账本、对话摘要、生成元数据和版本。`ScenarioBlueprint` 是初始化定义，不是可被运行时覆写的状态来源。

## 5. 世界生成流水线

```text
validate NewGameInput
→ load GameTypeProfile + rule catalogs
→ build generation prompt
→ AI 返回 ScenarioBlueprintCandidate
→ schema validation
→ 游戏类型/内容预算/ID/引用/任务图/数值越权校验
→ compileScenarioBlueprint
→ initializeGameState
→ transactional save
→ return opening read model
```

校验失败：同一候选执行一次确定性修复；仍失败则重新调用一次；再次失败调用 `createFallbackBlueprint(input, seed)`。任何失败都不得留下半初始化存档。

开局应一次生成“可完成骨架”，但不必一次生成所有长对白、场景正文和图片。运行中按当前场景生成表现层内容；新增定义受剩余预算和任务图合法性限制。

## 6. 行动与规则流水线

```ts
type PlayerIntent = {
  type: "talk" | "observe" | "investigate" | "move" | "use_item" |
    "give_item" | "trade" | "attack" | "battle_action" | "rest" | "leave";
  targetId?: string;
  itemId?: string;
  approach?: "friendly" | "direct" | "deceptive" | "threatening" | "careful";
  freeText?: string;
};
```

固定选项直接产生 `PlayerIntent`；自由输入由 AI 解析为同一结构。`validateIntent` 检查当前状态，resolver 输出 `RuleResolution` 和结构化事件；只有 resolver 可以修改状态。AI 获得裁决结果与允许事实后生成 `NarrativeOutput`，其任何 `stateChangeCandidates` 必须再次走规则命令，不能直接 merge。

失败结果必须包含机器码和玩家可读参数，例如 `TARGET_NOT_PRESENT`、`LOCATION_LOCKED`、`ITEM_MISSING`、`NPC_REFUSES`。叙事层只能解释真实失败原因。

## 7. AI 模块

首批模块：

1. `scenario-generation`：生成世界蓝图候选；
2. `intent-classification`：自由文本转 `PlayerIntent`；
3. `npc-dialogue`：基于 NPC 可知事实和裁决结果生成对白/选项；
4. `scene-narration`：表现已确认场景与事件；
5. `memory-summary`：把对话/场景压缩为结构化摘要。

所有模块定义版本化 input/output schema、超时、重试次数、最大上下文、温度和 fallback。prompt 不得包含 API Key；日志默认记录模块、模型、耗时、token/成本估算、校验结果和 traceId，不记录密钥，玩家原文按日志规范截断/脱敏。

RPG 独立拥有以下环境变量：

```dotenv
AI_API_BASE_URL=...
AI_MODEL=...
AI_API_KEY=...
```

真实值放 RPG 仓库自己的 `.env.local` 或部署 secret，不得提交。为减少本地重复配置，`npm run env:bootstrap` 可以把 RPG 主工作区或 sibling SLG 本地 env 中这三个键的当前值一次性复制到 RPG 当前工作区；它不复制其他变量、不输出值，也不建立运行时跨仓读取。初始化后两个项目的 URL、模型和 Key 可以独立变化。

RPG 应用运行时只能解析自身进程环境，禁止读取 `../ai-slg-game/.env*`。第一版不搬运 SLG 的账户级 Provider、密钥加密和多账户设置。

## 8. 共享 package 计划

### `@ai-game/ui`

开始 RPG 产品 UI 前先写单独 public API Spec，只抽取 RPG 首批界面真实使用且 SLG 已有稳定实现的最小集合。首批候选为 `InlineButton`、`Panel`、`Tag`；只有 RPG 实际需要时才加入 `TabBar` 或通用 Surface/focus/portal。共享 package 不包含对白 UI、SLG HUD、地图、产品主题或业务状态。

迁移顺序：foundation package/test → SLG adapter/consumer contract → RPG consumer contract → 两边主题验证。发布前本地联调使用 worktree-aware `.foundation` 链接和 `file:.foundation/packages/ui`；registry 发布后改为精确版本。

### `@ai-game/ai-transport`

RPG 首次接入 AI 前，从 SLG `src/game/core/ai/` 比较并抽取 OpenAI-compatible transport、并发、超时、取消、流式和错误契约。公共层不读取 env，不包含账户配置、prompt 或任何游戏 schema。必须先保证 SLG 原测试/消费者契约通过，再接入 RPG。

## 9. 代码位置

```text
src/game/domain/                         # 稳定类型、ID、事件、纯 helper
src/game/gameplay/rpg/scenario/          # 蓝图校验、编译、fallback 生成
src/game/gameplay/rpg/actions/           # intent 校验与 resolver
src/game/gameplay/rpg/quests/            # 任务图与推进
src/game/gameplay/rpg/npc/               # 知识、关系、记忆规则
src/game/gameplay/rpg/battle/            # 轻量回合制战斗
src/game/application/                    # createGame/performAction/read models
src/game/application/server/ai/          # prompt、schema adapter、AI orchestration
src/game/application/server/persistence/ # repository 组合与 SQLite adapter
src/app/api/game/                        # 薄 route adapter
src/components/                          # RPG 页面和业务组件
src/store/                               # 只调用 application/request adapter
data/base/                               # 游戏类型、艺术风格和规则 catalog
data/fixtures/                           # 固定输入、蓝图和回归数据
```

UI/API/store 不得直接导入 gameplay；server-only 模块不得进入客户端。每个目录通过 facade 暴露 public API，并由 boundary tests 守卫。

## 10. UI 里程碑

MVP 必做界面按开发顺序为：

1. 新游戏创建页：类型卡、角色资料、世界观、开端、叙事风格；
2. 世界生成进度/失败降级页；
3. 游戏 Shell：当前场景、地点摘要、状态入口；
4. 场景交互区：叙事、NPC、固定选项、自由输入；
5. 地图/移动面板；
6. 战斗面板；
7. 角色/背包/任务/日志面板；
8. 保存/读取与结局页。

对白页面是 RPG 业务组件：组合共享按钮/Panel/Tag/Surface，但角色立绘布局、历史、输入、选项与 streaming 状态留在 RPG。

## 11. 开发阶段与门槛

### Phase 0：公共基础准备

- 同步共同规范到 SLG/RPG；
- 完成 `@ai-game/ui` 最小 API Spec 与首批抽取；
- 为 RPG 配置 `.env.local`，但不在此阶段发起 AI 调用。

门槛：foundation package 测试和 SLG/RPG consumer contract 通过。

### Phase 1：领域契约与确定性生成

- 实现输入、类型 profile、蓝图、任务图、GameState 和事件类型；
- 实现配置加载/引用校验、蓝图校验/编译；
- 实现基于 input + seed 的 fallback 蓝图。

门槛：无需 UI/DB/AI，测试能生成三种类型世界并证明两个结局可达。

### Phase 2：创建游戏与存档

- 实现 `createGame` use case、SQLite repository 和事务初始化；
- 完成新游戏 UI、生成状态和开场场景；
- 先使用 fallback generator。

门槛：刷新页面后能恢复存档，失败不留下半存档。

### Phase 3：确定性可玩闭环

- 实现移动、交谈、调查、物品、任务推进、关系和事件账本；
- 实现轻量战斗和失败推进；
- 用模板对白/叙事完成一局。

门槛：固定 seed 自动通关测试覆盖两个结局；无 AI 可玩。

### Phase 4：共享 AI transport 与动态开局

- 抽取并接入 `@ai-game/ai-transport`；
- 实现 scenario-generation prompt/schema/validator/retry/fallback；
- 接入真实 API 和成本/错误日志。

门槛：至少三种游戏类型的 contract fixture 通过；恶意/越权生成无法进入存档。

### Phase 5：动态交互和记忆

- 接入意图识别、NPC 对话、场景叙事和摘要；
- 实现 NPC 知识裁剪、streaming UI、取消和降级；
- 固定选项继续可用且与自由输入走同一规则。

门槛：对抗测试中 AI 不能泄密、改数值、跳任务或生成非法物品。

### Phase 6：内容、表现与验收

- 扩到正式内容预算；
- 接入类型化默认素材和可选异步图片 adapter；
- 完成存档兼容、性能、成本、可访问性和完整回归。

门槛：满足产品规则文档第 10 节全部验收项。

每个 Phase 开始前建立 `docs/superpowers/plans/` 执行计划；完成后更新 `docs/agent/MVP核心闭环.md` 的实现现状、主要文件和测试。不得把本 Spec 当成已实现事实。

## 12. 测试矩阵

- Schema：边界长度、未知枚举、重复 ID、悬空引用、超预算；
- 任务图：不可达目标、无关闭方式、结局不可达、无限循环；
- 类型一致性：武侠不无故出现星舰，科幻不无故出现修仙宗门；兼容跨类型输入有明确解释；
- 规则：非法移动、未知目标、缺物品、关系门槛、任务推进、战斗和奖励守恒；
- NPC：未知事实、谎言来源、死亡角色、关系与记忆；
- AI：无效 JSON、超时、429/5xx、空响应、提示注入、越权金币/属性/任务；
- Persistence：事务失败、保存恢复、版本字段、固定 seed；
- UI：表单、键盘操作、loading/cancel/retry/fallback、streaming、错误反馈；
- 端到端：无 AI 两结局、真实 AI smoke、七类型至少三类动态开局。

## 13. 完成定义

- `npm run lint`、`typecheck`、全部测试、boundary tests 和 build 通过；
- 两个固定 seed 从创建到结局可自动运行；
- AI 不可用时仍能通关；
- 动态世界能追溯玩家输入和 GameTypeProfile；
- 规则事实只来自经过验证的 blueprint/resolution；
- 公共 UI/AI package 通过 foundation 与两个消费者测试；
- 玩法事实、agent 实现现状、决策和运维说明已同步更新。
