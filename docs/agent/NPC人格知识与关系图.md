# NPC 人格、知识与关系图

## 职责

NPC 的人格锚点、动态目标、知识、关系、承诺与结构化交互属于实体组件；规则层产生关系变化和接触事实，NPC speech authority 决定当前 speaker 能引用什么。AI 只能在 authority 和审批契约允许的范围内表达。私下判断与场景作者是两个边界：`projectNpcDeliberation` 只给单个 NPC 自知、目标和当前证据，不能把其 `privateContext` 作为公共叙事上下文。

## 当前契约

- `EntityStore` 的 NPC record 必须包含 `identity`、`position`、`dynamicState`、`knowledge`、`relationships`、`history` 六类组件，并可带服务端安装的 `interactions` 定义。组件 exact-key、值域、实体 ID、生命周期和事件 provenance 均在解析期校验。
- 人格 `identity.anchors` 包含 self concept、values、speech style、capability boundaries 和 taboos；goalId、关系 commitment ID 等由服务端按实体和序号铸造，AI 不能自定义权威 ID 或完成状态。
- knowledge 按 FactId 去重，记录 certainty、disclosure 与 initial_world 或真实 Event 来源；关系边有方向，记录 affinity/trust/fear/hostility、stage/trend、evidence 和 commitments。封闭 signal 表与限速规则决定关系变化和相邻 stage 迁移；事实仅向显式 audience 传播，关系不自动反向成立。AI 不提交数值 delta 或任意 patch。NPC 故事互动由四种封闭 operation 与四类条件组成，缺少来源、依据、实际听众或条件不满足时不结算；目标状态只能由窄 mutation 改写。
- `promise_confidentiality` 必须携带 `confidentiality`：非空 `protectedFactIds`、非空 `allowedAudienceIds` 和 `fulfillment: { kind: "story_delivery" }`。引用经审批绑定到已有事实与听众，条款随 promise 持久化；未来接应人由故事递送绑定按需确定，不提前建立 NPC。许诺只开启承诺；换取引荐必须再选择 `request_introduction`，其 `promise_status` 条件引用真实已成立的 open promise。
- 保密保护期自玩家成功许诺到本故事物品正式递送完成。规则仅消费此期间玩家成功执行 `share_known_fact` 的已提交事件：保护事实向允许名单之外的实际听众披露才成为 broken；过去知情、NPC 自主披露、私下引荐、失败行动和未选提案不算玩家违约。通用 kept_promise/broke_promise 等关系信号不结算这些条款；无违约且真实 give_item 送到绑定接应人才 fulfilled，broken 不随之后交付或立场改变恢复。
- `share_known_fact` 表示玩家明确向当前目标 NPC 及显式同场 NPC 分享玩家已知事实，写入 player_told 来源知识；目标无需预先知情，不能指定远程听众或玩家自己。引荐/核验仍由 NPC 说话并受 NPC 对各听众的披露权限约束。
- `NpcSpeechAuthority` 从 speaker components、当前 scene-visible facts、目标和该 NPC history 计算 allowed/withheld facts、allowed Event 引用、anchors 和 evidence。secret fact 不因 NPC 已知就自动可说；conditional fact 需要关系条件。
- `projectNpcDeliberation` 的私密关系上下文只读取本人 outgoing edges；openCommitments 与 resolvedCommitments 均保留 status 和 confidentiality 条款，供本人判断持续义务及已发生违约，不把其他 NPC 私密关系或该私密 envelope 传给作者。`NpcDeliberationSource` 的 proposal 只允许返回 response、目标引用、依据事件、事实披露引用和结构化互动提议；live source 复用 `narrative_bundle` AI role，但审计 purpose 单独记为 `npc_deliberation`。服务端再按实际 audience 运行 authority，拒绝秘密、失效依据、非当前目标和越权互动。
- 生产 `prepareNpcNarrativeContext` 只在当前同场焦点需要条件/承诺/互动判断时调用该 source；开局和普通问候跳过。私密输入不进入作者上下文，获准 outward 投影进入同版作者与审阅，HTTP 使用同一 job 的预算与取消信号。
- 每条 NPC line/dialogue 必须提供 `usedFactIds` 与 `usedEventIds`；缺失、重复、非 speaker 所有或不在 allowlist 的引用会拒绝整包。
- 私下判断 prompt 不带其他 NPC 私密正文、其他 NPC history、无关玩家自由文本历史或裸关系数字；本轮选择/发言只从当前 actionId、player speaker 与焦点匹配的正式 History 读取，并保留 label 与 spoken 的表达类型。focus context 投影最近五条结构化交互、active goals、关系 stage/trend/open commitments 和有限 evidence。当前 job 的已提交事件须经过 ledger 存在性与 NPC 参与校验；私下判断、outward、作者和当前/预备场景审批使用一致的明确允许 Event ID 集合，不以缺少兼容 history 行拒绝真实核验事件。
- 新 NPC 的正式 focus scene 未准备好时，read model 只开放单一 `ask`；不合成问候、不开放自由输入、不投影默认 support/challenge。
- 开场 NPC 的 `npcConnection` 可审批为 stranger/neutral，或依据至少一条公开初始化历史建立 known 关系。known 会同步初始化 `met`；known/neutral 使用 acquainted stage，非 neutral 姿态使用 `INITIAL_RELATIONSHIP_SEED_POLICY` 对应的 stage 与受限维度。公开历史只作为关系的 initial-world origin/basis，所有初始 evidence 数组保持为空，不伪造行动证据；关系方向仍指向玩家，AI 不提交任意数值，也不能用秘密历史作为玩家可见的关系依据。

## 关键流程

```
EntityStore components + committed events
  → NpcSpeechAuthority
  → NPC-private deliberation (one NPC)
  → outward authority / proposal references
  → validateNpcSpeechReferences
  → approveNarrativeBundle
  → dialogue resolution writes structured interaction and evidence
```

NPC history 只保存结构化交互、主题和事件引用。玩家原话若需影响回应，作为当前 job 输入并受审计策略约束，不写成长期 NPC 私密历史。
NPC 的秘密可以影响拒绝、追问或条件，但不会因模型“打算告知”而传播；只有规则结算的实际 `audienceIds` 会写入玩家发现或另一 NPC 的 `action` 来源知识。

## 代码与测试入口

- 组件与校验：`src/game/domain/entity/npcComponents.ts`、`src/game/domain/entity/entityStore.ts`、`src/game/domain/entity/npcProjection.ts`
- 权限与审批：`src/game/application/npcSpeechAuthority.ts`、`src/game/domain/npcSpeechReferences.ts`、`src/game/application/approveNarrativeBundle.ts`
- 私下判断：`src/game/application/prepareNpcNarrativeContext.ts`、`src/game/application/projectNpcDeliberation.ts`、`src/game/application/npcDeliberationSource.ts`、`src/game/application/server/ai/liveNpcDeliberationSource.ts`
- 规则：`src/game/gameplay/rpg/npcMemory/`、`src/game/gameplay/rpg/dialogue/`
- 测试：`src/game/application/npcSpeechAuthority.test.ts`、`src/game/domain/entity/*test.ts`、`src/game/domain/npcSpeech.test.ts`、`src/game/application/approveNarrativeBundle.test.ts`

## 条件关联阅读

涉及事件来源和记忆召回时读 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)；涉及实体解析和兼容投影时读 [实体与组件世界状态](./实体与组件世界状态.md)；涉及 prompt 或审计正文时读 [运行时AI导演与场景表演](./运行时AI导演与场景表演.md) 与 [AI文本审计](./AI文本审计.md)。
