# Phase 10 运行时 AI 导演与场景表演设计

> 状态：已设计（designed），待按对应 Implementation Plan 执行  
> 日期：2026-07-30  
> 范围：单仓 `ai-rpg-game`；复用既有 `@ai-game/ai-transport@0.1.0` public API；不修改 foundation

## 1. 目标

在不引入玩家自由输入、运行时蓝图扩容或 AI 生图的前提下，跑通第一条真实、可恢复、可降级的运行时 AI 剧情闭环：

```text
当前场景与两个固定选项
→ 玩家提交服务端批准的 choiceToken
→ 既有确定性规则裁决
→ 世界导演 AI 提出下一场景计划
→ 规则批准导演提案
→ 剧情编剧 AI 编排下一场戏与两个候选选项
→ 规则批准场景脚本与选项
→ 当前 NPC AI 仅凭自己的知识生成台词
→ 单次 CAS 保存规则结果与下一场景
→ UI 展示下一段剧情与两个固定选项
```

本阶段首先检验三种 AI 分工是否合理：

- 世界导演是否能在完整剧情约束与内容预算内决定“接下来发生什么”；
- 剧情编剧是否能把已批准计划编排为可玩的场景和两种不同策略；
- NPC 表演是否能在没有未知事实正文的上下文中稳定保持角色知识边界。

## 2. 产品原则

### 2.1 逻辑角色不等于共享上下文

三个角色使用独立 AI 请求和独立结构化契约。即使底层使用同一模型和 transport，也不得复用一份包含所有信息的 prompt。

### 2.2 一个请求只有一个知识权限范围

- 导演拥有全局剧情权限，但只获得与当前局、当前任务和剩余内容预算有关的数据。
- 编剧拥有接近导演的剧情权限，获得已批准计划、相关真相、角色真实动机和可用行动候选；不获得战斗公式、数据库、provider 配置或无关章节原文。
- NPC 只获得自己的公开档案、`knownFactIds` 对应事实、允许的表演指令、与玩家关系和最近安全对话；未知事实正文、其他 NPC 私密知识、完整任务图和导演内部计划不得进入请求。

### 2.3 AI 只提出内容，规则独占正式状态

AI 不能直接写入：

- `GameState`；
- 属性、生命、伤害、经验、金币或奖励；
- 任务状态；
- 地图解锁；
- 背包；
- NPC 是否已结识；
- 战斗胜负；
- 结局；
- SQLite；
- revision。

两个剧情选项必须引用服务器当前投影出的合法 `AvailableAction`。AI 只改写选项标签和戏剧策略，不能创造新的行动语义。

### 2.4 玩家眼中的“新内容”不等于运行时创建实体

Phase 10 只允许导演和编剧引入本局开局蓝图中已经存在、但玩家尚未见到或尚未公开的：

- NPC；
- 地点；
- 物品；
- 敌人；
- 世界事实；
- 任务阶段。

本阶段不向已编译 `ScenarioBlueprint` 追加新 ID，不重编译任务图，不增加内容预算。运行时创建全新 NPC、地点、物品和任务属于后续独立阶段。

## 3. 首版玩家体验

### 3.1 初始场景

新游戏蓝图成功编译并初始化规则状态后，运行时剧情编排器为开场生成一份 `NarrativeSceneState`。场景包含：

- 一段玩家可见场景叙事；
- 零或一名当前在场 NPC 的台词；
- 恰好两个不同 `actionKey` 的固定选项；
- 不向客户端暴露的 `choiceToken → actionKey` 映射；
- 生成来源 `generated | fallback`，只供服务端诊断和离线回归。

当当前规则状态无法投影至少两个合法、非战斗行动时，不生成 AI 场景，UI 继续使用既有确定性地图、热点或战斗入口。

### 3.2 选择与推进

客户端只提交：

```json
{
  "intent": {
    "type": "narrative_choice",
    "choiceToken": "scene-4:choice-a"
  },
  "revision": 7
}
```

客户端不能提交 `actionKey`、NPC ID、事实 ID、奖励、状态或自由文本。服务端必须用当前 revision 的持久化场景查找 token，再把对应 `actionKey` 解析为当前仍合法的既有行动。

### 3.3 两个选项

每个 AI 场景必须有两个选项，并满足：

- 引用两个不同的当前合法行动；
- 标签分别代表不同策略，不能只是同义改写；
- 每个标签不超过 40 个 Unicode code point；
- 不泄露未发现事实、隐藏地点真实名称或未公开 NPC；
- 不声明行动已经成功；
- 不包含数值奖励或状态修改承诺。

如果 AI 未能产出两个合法选项，整份场景脚本被拒绝并使用确定性 fallback；不做字段级拼接修复。

## 4. 运行时数据契约

### 4.1 持久化场景

`GameState` 增加具备旧存档默认值的 narrative runtime：

```ts
export type NarrativeChoiceState = {
  readonly choiceToken: string;
  readonly label: string;
  readonly actionKey: string;
};

export type NarrativeNpcLineState = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly emotion: "neutral" | "warm" | "guarded" | "afraid" | "angry" | "sad";
  readonly usedFactIds: readonly FactId[];
};

export type NarrativeSceneState = {
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly usedFactIds: readonly FactId[];
  readonly npcLine: NarrativeNpcLineState | null;
  readonly choices: readonly [NarrativeChoiceState, NarrativeChoiceState];
  readonly source: "generated" | "fallback";
};

export type NarrativeRuntimeState = {
  readonly currentScene: NarrativeSceneState | null;
};
```

只持久化已经批准的玩家可见内容和隐藏的 `actionKey` 映射。原始 prompt、原始响应、未批准导演提案、未批准剧本、API 配置和秘密全文不得写入存档。

### 4.2 玩家 read model

`GameSessionView` 只增加安全投影：

```ts
export type NarrativeSceneView = {
  readonly narration: string;
  readonly npcLine: {
    readonly npcId: string;
    readonly name: string;
    readonly text: string;
    readonly emotion: NarrativeEmotion;
  } | null;
  readonly choices: readonly [
    { readonly choiceToken: string; readonly label: string },
    { readonly choiceToken: string; readonly label: string }
  ];
};
```

不得投影：

- `actionKey`；
- `usedFactIds`；
- 生成来源；
- 导演目标；
- 隐藏事实；
- AI diagnostics；
- prompt 或响应原文。

## 5. AI 角色与最小上下文

### 5.1 世界导演

接口：

```ts
export interface WorldDirectorSource {
  propose(request: WorldDirectorRequest): Promise<WorldDirectorAttempt>;
}
```

`WorldDirectorRequest` 只包含：

- `traceId`、契约版本和当前 narrative turn；
- 世界类型、世界摘要、tone、themes；
- 当前地点及其连接关系；
- 当前玩家已发现和未发现事实的结构化列表；
- NPC 的 ID、身份、位置、是否已结识、`knownFactIds`，但不包含生成台词；
- 当前任务状态、目标和结局可达性摘要；
- 背包、可取得物品、当前敌人和战斗状态摘要；
- 最近最多 12 个结构化领域事件；
- 当前合法行动候选；
- 固定的原始 `contentBudget` 与已使用数量。

导演输出：

```ts
export type DirectorProposal = {
  readonly sceneGoal: string;
  readonly tensionLevel: 1 | 2 | 3 | 4 | 5;
  readonly focusNpcId: string | null;
  readonly relevantFactIds: readonly string[];
  readonly allowedRevealFactIds: readonly string[];
  readonly suggestedActionKeys: readonly [string, string];
  readonly introducedEntities: readonly {
    readonly kind: "npc" | "location" | "item" | "enemy" | "fact";
    readonly id: string;
  }[];
  readonly pacing: "setup" | "develop" | "turn" | "climax" | "resolution";
};
```

### 5.2 导演批准

纯规则 `approveDirectorProposal` 必须验证：

- 所有 ID 存在于当前已编译蓝图；
- `focusNpcId` 为 null 或当前地点在场 NPC；
- `allowedRevealFactIds` 都已经由规则标记为 `discovered`；
- `relevantFactIds` 只引用本局事实；
- 两个 action key 不同且都来自当前 `AvailableAction`；
- introduced NPC 当前在场，introduced item 当前可取得或已持有，introduced location 已解锁，introduced enemy 当前可见，introduced fact 已发现；
- 战斗中或结局后不得批准普通叙事场景；
- 字段长度和数组数量在固定上限内。

批准结果 `ApprovedDirectorPlan` 由服务器重新投影，不保留 AI 提供的未知字段。

### 5.3 剧情编剧

接口：

```ts
export interface SceneWriterSource {
  write(request: SceneWriterRequest): Promise<SceneWriterAttempt>;
}
```

编剧获得：

- `ApprovedDirectorPlan`；
- 当前场景的相关真相和角色真实动机；
- 当前地点的公开与内部描述；
- 最近结构化事件摘要；
- 当前任务的相关阶段；
- 两个已批准 action key 及其安全动作摘要；
- 允许公开的事实正文；
- 必须避免公开的事实 ID，但不重复无关事实正文。

编剧输出：

```ts
export type SceneScriptProposal = {
  readonly narration: string;
  readonly usedFactIds: readonly string[];
  readonly npcInstruction: {
    readonly npcId: string;
    readonly speechAct: "inform" | "ask" | "evade" | "deny" | "warn" | "encourage";
    readonly emotion: NarrativeEmotion;
    readonly allowedFactIds: readonly string[];
    readonly mayLie: boolean;
  } | null;
  readonly choices: readonly [
    { readonly actionKey: string; readonly label: string; readonly strategy: string },
    { readonly actionKey: string; readonly label: string; readonly strategy: string }
  ];
};
```

### 5.4 剧本批准

纯规则 `approveSceneScript` 必须验证：

- narration 长度为 1–600 code points；
- narration 的 `usedFactIds` 是导演允许公开事实的子集；
- NPC 指令只引用导演批准的 focus NPC；
- NPC `allowedFactIds` 是该 NPC `knownFactIds` 的子集；
- 两个 choice 的 action key 与导演批准的两个 key 精确相等，顺序可变但不得新增；
- choice label 为 1–40 code points，strategy 为 1–80 code points；
- 输出不包含数值状态、奖励字段或客户端不应获得的 ID。

自然语言仍存在无法由 ID 校验完全覆盖的语义泄漏风险。Phase 10 用恶意 fixture、真实 smoke 人工审阅和后续可观测数据检验是否需要把玩家可见旁白拆成独立低权限调用；不能把 prompt 指令当作唯一安全边界。

### 5.5 NPC 表演

接口：

```ts
export interface NpcPerformerSource {
  perform(request: NpcPerformanceRequest): Promise<NpcPerformanceAttempt>;
}
```

NPC 请求只包含：

- NPC ID、name、role、description、tags；
- 当前地点的公开名称与公开描述；
- 剧本批准后的 `speechAct`、emotion、mayLie；
- `allowedFactIds` 对应的事实正文；
- NPC 已知且已获允许的信念/事实；
- 是否已结识；
- 最近最多 6 句该 NPC 自己的已批准台词。

NPC 请求明确不包含：

- 其他未知事实正文；
- 其他 NPC 的 `knownFactIds` 或秘密；
- 完整世界事实；
- 完整任务图；
- 结局条件；
- 导演的 sceneGoal；
- 编剧的相关真相；
- 玩家属性和战斗数值。

NPC 输出：

```ts
export type NpcPerformanceProposal = {
  readonly text: string;
  readonly usedFactIds: readonly string[];
  readonly emotion: NarrativeEmotion;
};
```

批准规则要求 text 为 1–240 code points，事实引用属于请求 allowlist，emotion 与批准指令一致。失败时使用只消费批准指令和公开信息的确定性 NPC 模板。

## 6. 编排、原子性与失败语义

### 6.1 初始场景

`createGame` 在蓝图 compile 和 `GameState` 初始化之后、首次 SQLite 写入之前调用 narrative orchestrator。AI 全部失败时仍生成确定性场景或 `currentScene: null`，然后只执行一次 `createInitialGame`。

### 6.2 后续选择

`performAction` 收到 `narrative_choice` 后：

1. 加载当前 record；
2. 检查 revision；
3. 以 choiceToken 查找当前场景的隐藏 action key；
4. 从当前 `AvailableAction` 重建合法行动；找不到则安全拒绝、零写入；
5. 使用既有纯 resolver、quest reconciliation 和 ending resolver 计算规则状态；
6. 若进入战斗或结局，清空 narrative scene，不调用普通叙事 AI；
7. 否则基于规则结果调用 director → approval → writer → approval → NPC；
8. 任一阶段失败后生成完整确定性 fallback scene，不拼接部分 AI 输出；
9. 用原 expected revision 单次 `applyResolvedAction` 保存规则状态与新场景；
10. CAS 冲突时丢弃本次 AI 结果，返回最新 view，不重复收费请求。

AI 调用期间不持有 SQLite 写事务。AI 失败不能回滚已经计算出的合法规则结果，但在 CAS 成功前不会留下部分存档。

### 6.3 稳定失败类别

每个角色共享下列业务级失败类别，但保留角色名：

```ts
type RuntimeNarrativeFailureCategory =
  | "unavailable"
  | "timeout"
  | "rate_limited"
  | "service_error"
  | "invalid_json"
  | "schema_violation"
  | "reference_broken"
  | "knowledge_scope_violation"
  | "choice_not_legal"
  | "empty_response";
```

玩家 API 不返回失败类别。服务端 audit 只记录：

- traceId；
- role：director / writer / npc；
- attempt；
- category；
- generated / fallback；
- latency；
- provider usage（如果 transport 安全提供）。

不得记录 prompt、玩家原始输入、完整响应、事实正文、URL、模型原文、Authorization 或 key。

## 7. 真实 AI 与配置

- 复用现有 `AI_API_BASE_URL`、`AI_MODEL`、`AI_API_KEY`、`AI_OUTPUT_FORMAT`。
- 复用 `@ai-game/ai-transport@0.1.0`，不得 deep import，不修改 foundation。
- 三个角色为三次独立 non-stream 请求；同一 transport 可以复用，但 request body 必须分别构造。
- 日常测试全部使用 fixture source，零网络、零计费。
- 新增显式 opt-in smoke；只有 `RUN_REAL_AI_RUNTIME_SMOKE=1` 时允许真实调用。
- smoke 至少完成“初始场景 → 选择一项 → 下一场景”，并打印脱敏的逐角色 generated/fallback 汇总。
- `AI_OUTPUT_FORMAT` 仍使用 json_schema / json_object / prompt_only 三值；无效配置稳定 unavailable → fallback。

## 8. UI

- 非战斗、非结局且 `view.narrativeScene !== null` 时，地点主视窗显示场景叙事、NPC 台词和恰好两个选项。
- 点击选项只提交 choiceToken 与 revision。
- busy 时两个选项同时禁用。
- 成功返回后使用服务端最新 view 替换场景。
- stale 时沿用现有 current-game reload。
- fallback 不显示 provider、模型或失败细节；可显示中性提示“故事以基础叙事继续”。
- battle 和 ending 根路由优先级保持不变。
- 当 narrative scene 为 null 时，完整保留现有地图、热点和固定对话作为确定性降级路径。

## 9. 美术接口预留

Phase 10 不调用图片模型、不生成视觉描述、不新增未使用的 production port。现有七题材 SVG 继续作为唯一视觉。

后续运行时实体扩容阶段采用以下业务接口方向，但不在本阶段实现：

```ts
interface VisualAssetPort {
  ensureNpcPortrait(request: NpcPortraitRequest): Promise<VisualAssetResult>;
  ensureLocationBackground(request: LocationBackgroundRequest): Promise<VisualAssetResult>;
  ensureItemIcon(request: ItemIconRequest): Promise<VisualAssetResult>;
}
```

新实体在规则批准创建时必须先持久化稳定 `visualIdentity`，生图只消费该档案并按 entityId + visualVersion 缓存。图片失败永远不阻塞剧情。

## 10. 明确不做

- 玩家自由输入与意图解析 AI；
- streaming、SSE 和 token 逐字输出；
- 运行时新增蓝图实体或修改任务图；
- AI 修改数值、规则、任务、战斗、奖励或存档；
- 多 NPC 同场分别表演；
- NPC 长期关系数值、信念演化、谣言传播和自主日程；
- 自动语义事实抽取；
- AI 图片、语音和视觉描述生成；
- 普通敌人、随机战斗、经验、装备效果、掉落和商店；
- 修改 `@ai-game/ai-transport` 或任何 foundation package。

## 11. 验收

### 11.1 契约与权限

- director、writer、npc 为三个独立 source 和三份不同 request type；
- 记录型 fixture 能证明 NPC 请求中不存在任一未知事实正文；
- NPC 请求中不存在其他 NPC 的私密知识；
- writer 请求不包含 provider 配置、数据库信息或无关战斗数值；
- API/read model 不泄漏 actionKey、fact IDs、导演计划、生成来源或 diagnostics；
- AI 输出无法直接产生 GameState、任务、数值、奖励或结局写入。

### 11.2 规则与存档

- 两个选项均映射到当前合法 `AvailableAction`；
- 篡改、过期或重复使用 choiceToken 安全拒绝且 revision 不变；
- 成功选择只执行一次既有规则效果并只增加一次 revision；
- AI 失败使用完整 fallback，规则结果不变；
- CAS 冲突不保存 AI 结果；
- reload 恢复完全相同的场景、NPC 台词和两个选项；
- battle / ending 不调用普通叙事 AI。

### 11.3 真实最小链路

在显式 opt-in smoke 中：

1. 使用真实 AI 创建一局或使用合法 fixture 蓝图；
2. director、writer、npc 各完成一次独立调用或稳定 fallback；
3. 初始场景得到两个规则批准选项；
4. 提交其中一个 choiceToken；
5. 规则裁决成功；
6. 再次完成 director、writer、npc 调用或稳定 fallback；
7. 得到可 reload 的下一场景；
8. 脱敏审计能区分每个角色的结果；
9. 人工检查 NPC 台词没有引用其未知事实。

## 12. 成功后的架构判断

Phase 10 完成后根据真实数据决定下一步，而不是预设更多 Agent：

- 如果导演与编剧输出高度重复，评估合并其模型调用，但仍保留独立契约和权限投影；
- 如果编剧频繁泄漏未公开真相，拆出低权限玩家旁白表现调用；
- 如果 NPC 在最小上下文下缺乏连贯性，优先增加其结构化记忆，不扩大到完整世界上下文；
- 如果三个角色的失败率或延迟不可接受，先优化触发频率和 fallback，不允许绕过规则批准；
- 运行时创建全新实体和美术资产作为后续独立 Spec。
