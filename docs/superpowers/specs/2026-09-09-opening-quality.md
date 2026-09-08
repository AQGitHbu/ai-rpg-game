# 初始化剧情质量设计

## 目标与范围

本设计落实本次讨论：初始化生成“初始历史＋当前局面＋首个决策点”，优先让开场贴合玩家设定、NPC 有自身诉求、首个选择有具体意图，并把这些材料交给第一次玩家选择后的 API 调用。本文的“下一幕”指下一个玩家选择触发的生成节点，不指 `currentAct` 加一。

交付边界为创建游戏、持久化、首次选择和下一次生成上下文。此次只写设计与 Plan，不执行实现或真实 AI 调用。后续实施不得把本设计理解为已经实现的能力。

保留一个起始地点、一个焦点 NPC、一个内部主线任务、现有短篇/中篇预算和 NPC 决策入口。可呈现不同处境，但不承诺无 NPC 开场、初始多人场景或任意物理动作。保留 `town` 空间契约，地点描述应贴合设定，不将所有题材写成古镇客栈。`talk_to_opening_npc` 暂作规则承接目标，任务名称和描述表达眼前待解决问题；本轮不重构任务完成判定。

保留 `trust/doubt` 终幕规则与 3/5 幕预算；初始化只生成开放的价值主题，不把它写成已决定的结局或整局路线。本轮不建设通用导演、全局线程生命周期、动态任务图、计时器和第二个质量评审 provider。

## 已核实的问题

- `src/game/application/server/ai/liveNarrativeBundleSource.ts` 是生产初始化 prompt，遗漏 `characterProfile`、`personalityTags`、`narrativeStyle`、`contentIntensity` 和 `novelty`；旧 `openingGenerationSource.ts` 中的相关指令不能证明生产已接入。
- `src/game/application/createGame.ts` 的 `compileOpeningNarrative` 硬性要求 support/challenge，并按 candidateId 二选一转换 Action。
- Action 已支持 ask/support/challenge/threaten/deceive/offer/refuse/reassure；首轮可以复用这八种行为，不能新增没有规则实现的“治疗”“搜查”“交易”按钮。
- 固定选项 label、dialogueAct、topic 已经能进入 `PendingNarrativeJob.selectedDialogue`。应复用这条通道；不要再建一份自由文本意图存档。
- 开局编译固定 NPC 陌生、中性关系；现有 `INITIAL_RELATIONSHIP_SEED_POLICY` 已有受控姿态与规则值，可复用。
- 初始化事件只记录生成元数据。已有记忆渲染主要输出事件引用与当前状态，不等于模型能读到初始历史的实际含义。
- 当前 `unresolvedThreads` 是既有节奏用 ID 列表，不是真实线程生命周期。不能把新背景问题塞进去便声称完成线程系统。

## 数据归属

1. 人物、地点、事实继续进入 EntityStore；人格、知识、目标、关系继续归原组件。
2. 初始历史以 `opening_history_established` 事件保存，事件只引用事实 ID，不重复保存自由文本历史。历史内容的唯一正文是 fact 实体。
3. 未解决矛盾以 `opening_thread_established` 事件保存稳定 thread ID、公开问题事实、相关事实和参与者。这是初始化的线程种子，不伪造完整运行时生命周期。
4. 当前局面从当前 EntityStore、上述事件和相关记忆投影；不持久化另一篇权威摘要。
5. 首轮选择的语义用现有 DialogueAct＋结构化主题表示。首轮候选的局部 key 经服务端解析为 Action，客户端仍只收到 opaque token 和 label。
6. 线程种子不进入旧 `unresolvedThreads` 节奏列表，不驱动终幕条件。首轮 handoff 通过所选 thread topic 关联历史；之后历史可正常召回，但不得把初始问题描述当作永远有效的当前状态。首次以后不强制注入初始局面块。

## 初始化候选新增契约

新文件 `src/game/domain/openingSituation.ts` 定义下列类型；`OpeningGenerationCandidate.opening.situation` 为必填。字段为本设计拟新增，不是既有 API。

```ts
export type OpeningParticipantRef = "player" | "opening_npc";
export type OpeningHistoryProposal = Readonly<{
  key: string;
  factKeys: readonly string[];
  participantRefs: readonly OpeningParticipantRef[];
  causeHistoryKeys: readonly string[];
}>;
export type OpeningThreadProposal = Readonly<{
  key: string;
  questionFactKey: string;
  supportingFactKeys: readonly string[];
  participantRefs: readonly OpeningParticipantRef[];
  causeHistoryKeys: readonly string[];
}>;
export type OpeningResponseProposal = Readonly<{
  key: string;
  dialogueAct: import("./action").DialogueAct;
  topic: Readonly<{ kind: "fact" | "thread"; key: string }>;
}>;
export type OpeningSituationProposal = Readonly<{
  history: readonly OpeningHistoryProposal[];
  threads: readonly OpeningThreadProposal[];
  npcConnection: Readonly<{
    familiarity: "stranger" | "known";
    stance: "neutral" | import("./entity").NpcRelationshipSeedStance;
    basisHistoryKeys: readonly string[];
  }>;
  responses: readonly [OpeningResponseProposal, OpeningResponseProposal];
}>;
```

数量和字符串上限是本期上下文预算，不是故事模板：history 0–4 条，threads 1–3 条，responses 恰好 2 条；局部 key 为 1–40 字符 `[a-z][a-z0-9_]*`；每条 fact refs 为 1–4 个，thread supporting refs 为 0–4 个；participants 为 1–2 个去重引用；因果 key 数量 0–4。世界事实、正文长度与 NPC goals 继续受既有 validator 上限约束，不强制制造四段过去或三个冲突。

历史因果只能引用同批更早 history key；所有 key 在各自命名空间唯一。玩家提供明确既有经历时要求保留其含义；没有既有经历可生成与开端相符的世界背景，不能替玩家补写尚未作出的承诺、立场或完成行动。是否忠于自然语言设定由内容评审验证，机械解析不能证明。

历史 factKeys 可引用已存在的私密或未向焦点 NPC 披露的事实；保存引用不改变 discovered 或任何人物的知识权限。公开历史视图只渲染当前权限允许的事实，关系依据仍须公开。事实已知/秘密沿用 knownFactKeys/privateFactKeys；thread 的 questionFactKey 及每个 response 的目标必须是玩家可见问题。秘密 supporting facts 可入存档，但不能在首屏、选项、历史记忆卡或 handoff 正文中泄露。known/private 交集必须拒绝，不能依赖 discovered 标志误放行秘密。

`currentScene.choices[].candidateId` 必须与 responses.key 一一对应。两项解析后的 `semanticSummaryOf(action)` 必须不同；同一 dialogueAct 可以针对不同事实/线程。不能只靠 key 或 label 不同通过去重。选项只能表达 NPC 对话意图；offer 不等于转移物品，deceive 不等于欺骗成功，refuse 不等于自动离开。

## 权威编译与关系

使用 `init:<generationId>` 作为既有初始化 TurnId，沿 canonical commit helper 扩展同一 initialization episode：先 game_initialized，再按顺序 history，最后 thread。history eventKey 为 `history_<key>`，thread eventKey 为 `thread_<key>`；threadId 为 `thread_init_<key>`。时间戳表示写入时间，turnNumber=0 表示背景在开局确立，不伪造负回合或玩家行动事件。

新增 payload：

```ts
export type OpeningHistoryEstablishedPayload = Readonly<{
  type: "opening_history_established";
  factIds: readonly import("./worldEntity").FactId[];
}>;
export type OpeningThreadEstablishedPayload = Readonly<{
  type: "opening_thread_established";
  threadId: string;
  questionFactId: import("./worldEntity").FactId;
  supportingFactIds: readonly import("./worldEntity").FactId[];
}>;
```

参与者、地点、因果引用归事件 envelope。新增事件必须纳入 payload exact-key、事件类型白名单、ledger 引用验证、episode 分类与存档校验。纯记忆从 ledger 重建，不追加另一份手写历史。

known 关系要求至少一个公开的 basisHistoryKeys；stranger 只允许 neutral 且无关系依据。neutral/known 采用现有零维度与 acquainted stage；neutral/stranger 保持 unknown。其他姿态复用 `INITIAL_RELATIONSHIP_SEED_POLICY`，目标固定 PLAYER_ENTITY_ID，来源 initial_world，reasonKey 引用背景 key；不伪造 action evidence、债务、已兑现承诺或双向关系。NPC `met` 与 familiarity 一致，emotion 从已审批首句情绪初始化。高信任不能来自任意数字提案。

为了扩大 ledger payload 的正式存档契约，WorldState schema 5→6，已知旧版本显式 UNSUPPORTED_RECORD；不迁移、不清档。StoryState shape 和 EpisodicMemory shape 不变，分别继续 8 和 1；无需为了版本对齐而升级。修正说明中的硬编码 v5 假设，所有当前版本测试依赖常量。若实施发现实际必须新增持久化字段，先更新本 Spec/Plan 的唯一契约，再写实现。

## 生成 prompt 与下一次调用

生产初始化 prompt 单独抽为 `buildOpeningNarrativePrompt`，接入完整 setup、现有 buildStylePolicy 和最多最近 3 条 novelty 摘要。玩家输入优先于 novelty，重复角色名不是错误；玩家坚持同一开端时优先改变具体交锋、人物诉求和取舍，不换掉前提。

prompt 要求自然地呈现主角卷入原因、NPC 诉求、眼前待回应问题；prologue 简短解释背景，currentScene 承担现场表演。不得规定“每局都危机倒计时”“每局都隐藏阴谋”；问题也可以是协商、日常责任或资源取舍。JSON 示例只示范结构，不写可被复制的完整故事模板。允许已有情绪枚举，禁止用示例 guarded 强迫全部 NPC 警惕。

真实初始化及第一次选择各只有既有一次逻辑生成请求，保持现有 transport/content retry 上限，不新增评审调用。

第一次固定选择后：job.selectedDialogue 保留 act/topic/label；thread topic 引用本局已批准 threadId，fact topic 只引用可见 fact；通过 topic 定位 thread 事件与背景因果链，作为 required memory refs。首轮 handoff 增加“开局背景与本次回应”块，仅渲染公开历史正文、公开问题及现有 NPC 目标/关系。标注背景时间；任何直接后果以当前规则状态为准。整个决策上下文仍受现有 8,000 estimated tokens 上限约束，强制信息不能静默裁掉。

自由输入维持 talk/ask 与原文通道；未选固定 topic 时按焦点 NPC 召回开局公开材料。首次回合的识别采用 `job.turnNumber === 1` 并验证初始化事件存在，不以当前地点、旧 quest 是否完成判断。首次调用失败重试同 job 使用相同输入，不新增背景事件。之后不再强制注入开局块；普通召回仍可使用初始历史。

## 质量与验收

自动校验负责：schema、引用、可见性、两项 Action 语义差异、原子写入、reload、首轮 handoff、配置完整传入。自动化不能证明“有趣”或 label 与意图完全一致，不以关键词黑名单或 AI 自评分冒充审批。

离线验收必需：同一开局分别选择不同的合法 act/topic；比较 registry、提交事件、NPC 历史、pending job 和下一次实际 source 输入。差异至少体现在 act/topic 及因果召回，存在关系 signal 差异的样本同时验证规则后果；不要求每组都立刻改路线。测试必须包括同 act 不同 topic 和非 support/challenge 组合。

真实评审样本为 6 组×2 个 seed，共 12 次创建；选其中 3 组从隔离的同一批准状态分别执行两种选择，共 6 次续接。所有请求都走生产 source＋审批，不调用离线候选冒充样本，不改用户 current slot。两轮 seed 共享各自独立 novelty history 以验证重试上下文。报告记录所有失败与重试，不挑选成功样本冒充成功率。

评审维度每项 0/1/2：设定承接、人物诉求、局面清晰、选项取舍、事实一致性。每个成功开局至少 8/10，设定承接和事实一致性必须 2/2；12 次创建至少 10 次在既有重试上限内成功。跨样本人工归类，不能超过半数回到“陌生人递线索→接下一站任务”的同一结构。续接 6/6 应明确承接各自选择且不伪造未选承诺。结构测试通过但真实评审没运行时，只报告工程通过，质量验收未完成。

样本固定内容见 Plan；真实调用只在后续实施阶段使用已配置环境执行，缺失环境记录阻塞，不在写 Plan 阶段发起。
