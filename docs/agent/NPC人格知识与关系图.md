# NPC 人格、知识与关系图

## 职责

NPC 的人格锚点、动态目标、知识、关系、承诺与结构化交互属于实体组件；规则层产生关系变化和接触事实，NPC speech authority 决定当前 speaker 能引用什么。AI 只能在 authority 和审批契约允许的范围内表达。

## 当前契约

- `EntityStore` 的 NPC record 必须包含 `identity`、`position`、`dynamicState`、`knowledge`、`relationships`、`history` 六类组件。组件 exact-key、值域、实体 ID、生命周期和事件 provenance 均在解析期校验。
- 人格 `identity.anchors` 包含 self concept、values、speech style、capability boundaries 和 taboos；goalId、关系 commitment ID 等由服务端按实体和序号铸造，AI 不能自定义权威 ID 或完成状态。
- knowledge 按 FactId 去重，记录 certainty、disclosure 与 initial_world 或真实 Event 来源；关系边有方向，记录 affinity/trust/fear/hostility、stage/trend、evidence 和 commitments。封闭 signal 表与限速规则决定关系变化和相邻 stage 迁移；事实仅向显式 audience 传播，关系不自动反向成立。AI 不提交数值 delta 或任意 patch。
- `NpcSpeechAuthority` 从 speaker components、当前 scene-visible facts、目标和该 NPC history 计算 allowed/withheld facts、allowed Event 引用、anchors 和 evidence。secret fact 不因 NPC 已知就自动可说；conditional fact 需要关系条件。
- 每条 NPC line/dialogue 必须提供 `usedFactIds` 与 `usedEventIds`；缺失、重复、非 speaker 所有或不在 allowlist 的引用会拒绝整包。
- prompt 不带其他 NPC 私密正文、其他 NPC history、玩家自由文本历史或裸关系数字。focus context 只投影最近五条结构化交互、active goals、关系 stage/trend/open commitments 和有限 evidence。
- 新 NPC 的正式 focus scene 未准备好时，read model 只开放单一 `ask`；不合成问候、不开放自由输入、不投影默认 support/challenge。
- 开场 NPC 的 `npcConnection` 可审批为 stranger/neutral，或依据至少一条公开初始化历史建立 known 关系。known 会同步初始化 `met`；known/neutral 使用 acquainted stage，非 neutral 姿态使用 `INITIAL_RELATIONSHIP_SEED_POLICY` 对应的 stage 与受限维度。公开历史只作为关系的 initial-world origin/basis，所有初始 evidence 数组保持为空，不伪造行动证据；关系方向仍指向玩家，AI 不提交任意数值，也不能用秘密历史作为玩家可见的关系依据。

## 关键流程

```
EntityStore components + committed events
  → NpcSpeechAuthority
  → SafeContext 投影（人格公开面 + 可说事实）
  → character prompt proposals
  → validateNpcSpeechReferences
  → approveUnit + collectDisclosures
  → dialogue resolution writes structured interaction and evidence
```

NPC history 只保存结构化交互、主题和事件引用。玩家原话若需影响回应，作为当前 job 输入并受审计策略约束，不写成长期 NPC 私密历史。

分阶段链路下，角色单元还有一条**观察披露**约束：单元通过 `SafeContext.requiredObservations` 收到本单元必须披露的观察（`key` / `factId` / `certainty` 安全投影），必须写进某个 part 的 `facts`——写进 `beatIds` 或 `evidence` 不算披露。输出 certainty 不得高于观察声明的 certainty（标 `known` 可降级为 `suspected`，标 `suspected` 绝不可写成 `known`）。观察与单元的归属必须同 `stepKey` 且观察 `order ≤` 单元 `order`，跨 step 引用一律被拒。

## 代码与测试入口

- 组件与校验：`src/game/domain/entity/npcComponents.ts`、`src/game/domain/entity/entityStore.ts`、`src/game/domain/entity/npcProjection.ts`
- 权限与审批：`src/game/application/npcSpeechAuthority.ts`、`src/game/domain/npcSpeechReferences.ts`、`src/game/application/narrativeGeneration/approveUnit.ts`
- 观察归属与披露：`src/game/gameplay/rpg/narrativePlanning/observations.ts`、`src/game/application/narrativeGeneration/perspectiveContext.ts`（`requiredObservations`）
- 规则：`src/game/gameplay/rpg/npcMemory/`、`src/game/gameplay/rpg/dialogue/`
- 测试：`src/game/application/npcSpeechAuthority.test.ts`、`src/game/domain/entity/*test.ts`、`src/game/domain/npcSpeech.test.ts`、`src/game/gameplay/rpg/narrativePlanning/observations.test.ts`、`src/game/application/narrativeGeneration/approveUnit.test.ts`

旧完整包 provider 源不再用于生产；`approveNarrativeBundle.ts` 仍承担四模块装配后的整包发布审批。生成与权限冲突的恢复见 [运行时 AI 导演与场景表演](./运行时AI导演与场景表演.md)。

## 条件关联阅读

涉及事件来源和记忆召回时读 [剧情连续性与结构化记忆](./剧情连续性与结构化记忆.md)；涉及实体解析和兼容投影时读 [实体与组件世界状态](./实体与组件世界状态.md)；涉及 prompt 或审计正文时读 [运行时AI导演与场景表演](./运行时AI导演与场景表演.md) 与 [AI文本审计](./AI文本审计.md)。
