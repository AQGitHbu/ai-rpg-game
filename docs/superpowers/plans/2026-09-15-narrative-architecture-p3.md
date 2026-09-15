# 有后果的调查与角色合作 P3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在一个完整短篇里，让玩家主动取得的证据改变 NPC 的目标状态和合作条件，进而改变实际可选行动；经过回访、重载和终局仍能追溯这些后果。

**Architecture:** 复用当前 Entity、四种故事互动、Thread、P2 记忆包、整场作者和 A/B 提交。显式区分自动观察与玩家调查，补齐有证据的目标结算和条件完成；调查结果与变化回访通过原生成链响应，不预建全故事分支图。

**Tech Stack:** TypeScript 5.8、Next.js Node runtime、Node.js ≥24.15.0 内置 SQLite、Vitest 3；消费现有 AI/日志/UI 公共 API，不新增运行时依赖。

## Global Constraints

- 总设计：[架构 Spec](../specs/2026-09-12-narrative-architecture-design.md)。必须先读 [P3 代码与范围核查](../reports/2026-09-15-narrative-p3-scope-review.md)，再读当前 Task 对应系统；本 Plan 不重新派发已完成的 P1/P2 建设任务。
- 在 `codex/narrative-architecture` / `.worktrees/narrative-architecture` 的 **7ccfa57d** 上继续。本轮只写 Plan，不执行代码或 live；后续按 Task 实施。不另建分支，不修改 main/staged，不合并，不改 `current-phase.json`。
- 用户已确认：有后果的选择、主动调查、NPC 目标与合作优先；自由输入继续“提出策略→选项确认→规则结算”；允许调查结果和变化回访进入同一生成链。
- “质量与游戏性优先于 token、调用数和耗时。”“规则已结算结果不可被后续循环改写。”“原文永不因摘要删除。”生产失败显式重试，不以确定性剧情替代。
- 暂缓直接自然语言行动、完整谎言/错误信念、离场 NPC 自主模拟、开放世界、组织经济、交易/装备、通用分支图和层级 Arc。P3 不增加新的互动 operation、reviewer、润色器或常驻调度器。
- 目标的条件和状态归 NPC，调查定义归 Fact，任务完成条件归 Quest；Thread 只引用这些权威对象。Event/History 记录实际经过，不再复制一份 permission、relationship 或 goal 状态。
- 保留已有短篇/中篇；本期主要产品验证为三幕短篇。新字段按需使用，普通 P1/P2 故事仍可使用原自动观察和会话完成模式。未声明可执行条件的目标不得从文案猜出结算规则。
- 初始 schema 为 **EntityStore3 / World7 / Story12 / Bundle2**；Task 1 升 Entity4/World8，Task 4 升 Story13/Bundle3。P2 缓存 formatVersion1、50/10、24,000 摘要源/6,000 概览/64,000 完整请求估算预算保持；新来源参与既有 fingerprint 校验。
- 每 job/epoch 仍为 **3 个候选、24 次叙事 HTTP + 8 次记忆 HTTP**，沿用现有 lease、取消、重试与冻结记忆包。新增触发点不增加每 job 的隐式循环或独立额度。
- application 只从 gameplay `index.ts` 消费；新业务不下沉成公共框架。不修改 foundation 或 `docs/共同规范/`，不为文档规划更改依赖。
- P2 已按工程范围完成；本期以程序正确和可观察玩法分化验收。文学表现阅读全文后单独报告，不以固定分数重启无限修稿，也不把工程通过宣传为优于 main。

---

## 范围与阶段交付

| 里程碑 | Task | 独立交付 | 进入下一段的要求 |
| --- | --- | --- | --- |
| P3-A 规则能表达证据与合作 | 1–3 | 主动调查、目标结算、条件任务及有界具体绑定 | 两种策略产生不同事件/知识/合作可用性，规则有可达后续 |
| P3-B 玩家可以实际操作 | 4–6 | 统一结果生成、变化回访、真实选项/UI、上下文与结局承接 | 通过正式 Action/CAS/provider 装配；无越权、旧稿复用或重复效果 |
| P3-C 完整小故事 | 7–8 | 两路完整离线旅程、有限真实旅程与实际 UI | 证据矩阵全部成立，失败与未覆盖明确记录 |

每个 Task 必须能单独审核与测试。阶段结束写本 Plan 的 gates，不把进度写入 Agent 索引。新机制若需要通用脚本语言、全局 NPC 计划树或另一套生成路径才能工作，停止扩展并重新确认范围。

## 三份参考如何进入 P3

| 有收益的原则 | 现状 | 本 Plan 落点 |
| --- | --- | --- |
| ST：scope、业务 Context Slot、当前状态优先于回忆 | P2 已有 compiler/observer/来源包，不重建 | Task 5/6 把真实调查、合作条件、目标变化及回访原因装入既有槽；隐藏条件不进入玩家 prompt |
| ST：角色静态定义、动态状态、关系、知识分开 | NPC 已有这些组件 | Task 2 把 goals 从展示信息变为规则消费者；Task 6 用原因 Event 表达合作变化 |
| Entity 设想：固定组件、最小实体、出现后有依据地补全 | 已有八类 record、ID、alias、窄 mutation | Task 1/3 仅增加实际调查/目标绑定字段；不增加实体种类，不给每件装饰物建表 |
| Entity 设想：当前局势与完整历史分离 | Entity/Thread/History 已分离 | Task 2/6 当前目标读 Entity，旧承诺/旧调查读 Event/History；回访不恢复旧位置或旧持有人 |
| 四类信息：先有合法行动再表达、规划是暂定方向 | 当前普通选择仍偏 support/challenge | Task 3/5 由真实依赖产生候选，作者选择/表达；玩家换策略后重建当前可行方向 |
| 四类信息：私密判断不等于披露、候选不等于发生 | P1/P2 已建立权限和 A/B | Task 1/2 只允许实际见证/告知推动 NPC；Task 4/6 保持新边界的原子提交与观察者隔离 |

详细出处及未采纳理由见范围核查的“三份参考的取舍”。本期不重做摘要、别名检索、世界书、向量检索或四生成器编排；这些资料中的可选建议不是实施义务。

## 共享设计决定

### 1. 合作是规则可用性，不另建状态表

继续使用 `promise_confidentiality`、`request_introduction`、`request_verification`、`share_known_fact`。NPC 目标满足后，可开放已有互动或其管理材料的调查方法；条件失效则该能力不再可选。模型的 cooperate/refuse/offer_condition 只表达与规则一致的反应，不能单凭一次返回值授予或撤销权限。

例如，核实材料的目标完成后允许引荐；公开调查使另一个“保护当事人”的目标 blocked，则关闭私下引荐，保留已声明的公开核验路径。变化的权威证据是目标/知识/互动 Event 和合法 Action 集合，不增加“私下路线=true”字段。

### 2. 新调查显式选择，自动观察继续存在

事实是否需要调查由明确 `discoveryMode` 决定，不再猜测“有 approaches 就一定需要点”。P3 调查每处提供 2–3 个已批准方法，可有不同前提、见证者及 clean/noisy 证据来源。quality 表示取得方式的规则类别，不表示内容一会儿真、一会儿假；本期不实现错误信念。

调查中的动作是真实世界行为。未选方法、不在场的听众、未来场景和作者声称“已经查看”均不产生发现。一次事实发现只结算一次；不通过重复查同一条线索刷关系或目标事件。

### 3. 不把所有任务强制改成新模型

需要合作判断的 `talk_to_npc` 可带非空 `completionConditions`；其完成由实际状态和本轮交互证明，不再由两次态度回应替代。未带该字段的旧模式保留现有会话规则。主线仍是有界目标序列，分化体现在可选方法、合作条件、补充证据和后果；不增加通用 OR Quest 图。

### 4. 当前规则先结算，结果正文后发布

调查/变化回访若有仍有效的已批准步骤，先消费；否则满足服务端证明的新边界时，A 提交行动、事件、状态、玩家表达和 pending job，B 生成与发布结果。读地图、换 UI 标签、普通移动、未变化回访都不因这个机制增加 provider。缺少普通动作所需续接仍沿原错误契约，不扩大为“任何缺稿都生成”。

### 5. 完整短篇样本的玩法结构

验证故事采用“旧契与证人”：玩家受托递送一份文书；途中需要查看材料，保管人既想核实依据，也想控制披露范围。私下核对与公开询问都能取得真实信息，但见证人、可用引荐/核验和后续回应不同；玩家必须实际选择并最终交付或主动退出。

这是一份验证输入结构，不是生产固定剧情。开局/中途角色、文字、材料内容由真实作者生成并审批。最多三个主场所、四个 NPC、一件中心交付物、两处主动调查；需要第二个同场 NPC 时允许在既有地点按原 worldDelta 具象化，不强迫每幕增加一个地点。有效动作目标 10–24，单路线硬上限 32；不凑回合。至少一条路径含带新证据回访，回访不自动给旧 NPC 授知，仍需实际交流。

## 实现布局与公共类型

代码路径相对仓库根，所有新文件由对应 Task 创建。Files 行内省略目录的文件与该行前一完整路径同目录，“对应 .test.ts”指同目录同名测试。已有 `WorldState`、`StoryState`、`Action`、`NpcId`、`FactId`、`LocationId`、`EntityId`、`EventId`、`TurnId`、`NarrativeEventDraft`、`CommittedNarrativeEvent` 从现有 domain 文件导入；新类型经所属 facade 导出。下面代码是必须落实的接口/关键断言，不是已完成代码。

| 新单元 | 职责 | 不负责 |
| --- | --- | --- |
| `domain/investigation.ts`；`gameplay/rpg/investigation/index.ts` | 调查准入、见证者和合法方法投影 | 自由文本意图解析、编造事实 |
| `domain/npcGoalResolution.ts`；`gameplay/rpg/npcGoals/index.ts` | 有证据的目标状态转换和原因 Event | 离场 AI 模拟、全局 NPC 计划 |
| `domain/storyConsequenceBindings.ts`；`application/approveStoryConsequenceBindings.ts` | 新旧实体的有限规则绑定 | 任意 patch、重写已发生事实 |
| `gameplay/rpg/narrativeBundle/resultBoundary.ts` | 新边界的纯规则证明 | provider/数据库或新的调度服务 |
| `application/storyConsequenceContext.ts` | 同源行动后果与公开投影 | 第二份世界状态 |
| `application/testing/narrativeP3Journey.testutil.ts` | 正式规则/仓储/生成装配的旅程驱动 | 手改状态推进 |

## P3-A：规则闭环

### Task 1：让主动调查与自动观察真正分开

**阅读：** 总 Spec §4–6、§8；[开发规范](../../游戏开发规范.md)、[探索与任务推进](../../agent/探索与任务推进.md)、[实体状态](../../agent/实体与组件世界状态.md)。

**Files:**

- Create: `src/game/domain/investigation.ts`、`src/game/domain/investigation.test.ts`；`src/game/gameplay/rpg/investigation/index.ts`、`investigation.ts`、`investigation.test.ts`。
- Modify: `src/game/domain/entity/entityComponents.ts`、`entityStore.ts`、`entityProjection.ts`、`src/game/domain/worldEntries.ts`、`src/game/domain/worldState.ts`、`src/game/domain/events.ts`、`eventPayloadValidation.ts`。
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`、`src/game/gameplay/rpg/ruleEngine/resolveByType.ts`、`validateAction.ts`、`index.ts`；更新 `src/dependencyBoundaries.test.ts` 的新 facade 清单。
- Test: `src/game/domain/entity/entityStore.test.ts`、`src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`、`index.test.ts`、`src/game/application/server/persistence/worldStatePersistenceValidation.test.ts`、`sqliteGameRepository.test.ts`。
- Docs: 探索与任务推进、实体状态中的已实现规则；UI 尚未接入时明确这一边界。

**Interfaces:** FactComponent/WorldFactEntry 加 `discoveryMode: "automatic" | "investigation"`；构造新普通事实默认 automatic。显式调查需要非空安全 label、locationId、合法 2–3 approaches。既有 InvestigationApproach 加可选 `requirements: readonly StoryCondition[]`、`witnessNpcIds: readonly NpcId[]`；缺省分别为空，不改变现有 quality/tensionDelta 语义。新增：

```ts
type InvestigationOpportunity = Readonly<{
  factId: FactId;
  approachId: string;
  label: string;
  hint?: string;
  action: Extract<Action, { type: "investigate" }>;
}>;
function availableInvestigations(input: {
  worldState: WorldState; storyState: StoryState;
}): readonly InvestigationOpportunity[];
```

此函数只返回已释放、当前真实场所、未发现且前提满足的方法，不带隐藏事实正文。它供 Task 4/5 的注册/展示共用，不能 UI 再实现一套过滤。

- [ ] RED：主动调查目标在 move、ask 和自动确认边界均不发现；automatic 仍照旧发现；未知 approach/异地/重复/未释放均零变化。见证 NPC 必须 active 且处在该实际场所，不能把同镇不同建筑当作同场。

```ts
const result = autoResolveCurrentInvestigation(worldWithInvestigation, story);
expect(result.drafts).toHaveLength(0);
expect(result.nextWorldState.worldFacts.find(f => f.factId === factId)?.discovered).toBe(false);
```

`worldWithInvestigation/story/factId` 在本 Task 测试内用既有 `createWorldStateFixture` 和 Story constructor 建立，不以强制类型转换绕过 Entity 解析。

- [ ] 运行 `npx vitest run src/game/gameplay/rpg/investigation src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts --minWorkers=1 --maxWorkers=2`，确认新断言因旧自动行为失败。
- [ ] 实现 mode 分流，`automatic` 是唯一允许零行动发现的路径。方法无效时不得降为 automatic；worldDelta/开局的 provider 解析适配在 Task 3 完成，当前规则构造器已必须严格校验。

```ts
if (fact.discoveryMode === "investigation") return noOp;
// 自动分支继续调用现有 resolveFactDiscovery；不再根据 approaches 缺失猜模式。
```

- [ ] 复用现有 fact_discovered payload 的 approachId/quality/witnessNpcIds；给真实见证者写同一事件来源知识，玩家私下取得证据不自动广播。requirements 每次执行重查；全部校验成功后才批量 mutation，不先发现再拒绝见证者。
- [ ] 升 EntityStore4/World8，更新 constructor/projection/parser/fixtures 和已知旧版分类；不迁移、不清除已有用户存档。测试主动事实的隐藏正文和 mode 在 SQLite 重开后保持，战斗快照同步使用 Entity4。
- [ ] 相关 tests、`npm run typecheck`、`npm run test:boundaries` 通过；更新系统文档，限定文件提交 `feat: distinguish explicit investigation from automatic observation`。

**验收：** 玩家不选方法就得不到主动证据；先有实际方法和听众，才有发现与来源。

### Task 2：NPC 目标按其证据改变，并影响任务/合作

**阅读：** 总 Spec §4、§6；[NPC 系统](../../agent/NPC人格知识与关系图.md)、任务推进；Task 1 的事件契约。

**Files:**

- Create: `src/game/domain/npcGoalResolution.ts`、对应 `.test.ts`；`src/game/gameplay/rpg/npcGoals/index.ts`、`reconcileNpcGoals.ts`、对应 `.test.ts`。
- Modify: `src/game/domain/entity/npcComponents.ts`、`entityStore.ts`、`src/game/domain/storyInteraction.ts`、`worldEntries.ts`、`events.ts`、`eventPayloadValidation.ts`；`src/dependencyBoundaries.test.ts`。
- Modify: `src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.ts`、`src/game/gameplay/rpg/entityWorld/entityMutation.ts`、`src/game/gameplay/rpg/ruleEngine/index.ts`、`reconcileQuests.ts`、`src/game/gameplay/rpg/narrativeContext/objectiveRules.ts`、`deriveObjectiveTransition.ts`；目标 selector、会话 gate 和 Quest reconciliation 使用相同条件判定。
- Test: `src/game/domain/entity/npcComponents.test.ts`、`src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.test.ts`、`src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts`、`src/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition.test.ts`、`src/game/application/server/persistence/sqliteGameRepository.test.ts`；Docs: NPC 系统、任务推进。

**Interfaces:** 既有 `NpcGoal` 增加可选 `resolution`，没有条款的目标保持叙事指导。新增条件只表达实际调查来源：

```ts
type NpcGoalResolution = Readonly<{
  completeWhen: readonly StoryCondition[];
  blockWhen: readonly StoryCondition[];
}>;
// 加入现有 StoryCondition union，不另建条件语言。
type ObservedInvestigationCondition = Readonly<{
  kind: "investigation_observed";
  npcId: NpcId;
  factId: FactId;
  evidenceQuality: "clean" | "noisy";
}>;
function reconcileNpcGoals(input: {
  worldState: WorldState;
  triggerEvents: readonly CommittedNarrativeEvent[];
  actionId: string; turnId: TurnId; turnNumber: number;
}): { worldState: WorldState; drafts: readonly NarrativeEventDraft[] };
```

每个 completeWhen/blockWhen 最多四个条件，非空集合全部满足才触发。completed/abandoned 保持既有终态；非终态按 complete→block→active 顺序计算，空集合不等于 true。仅处理收到新相关、本人可观察证据的 NPC；不能因为全局某处改变就让所有 NPC 立刻知情。

目标条款可用本人 knows_fact、本人承诺状态、本人持有物品或 investigation_observed；禁止读取他人私密知识和引用其他 goal_status，避免目标递归依赖。调查 observed 只接受本人实际 witness，或本人收到成功 share_known_fact 且其合法 evidenceEventIds 明确包含该调查事件；分享必须实际传达这个来源，不能只凭全局 eventId 存在授知。带调查来源引用的分享操作明确同时告知 fact 与取得方式，label/正文按这个已批准行动审阅；没有来源引用的普通分享不自动传递 clean/noisy。被分享来源须为玩家实际知晓且可公开给该听众的来源，不能借一个合法 fact 把整段私密经历一起转授。

- [ ] 写 RED：私下查阅后 NPC 仍不知；明确分享后核实目标 completed；公开方法使实际见证 NPC 的保护目标 blocked；另一 NPC 不变。相同事件再次消费不重复发 goal 变化。

```ts
expect(goalStatus(afterPrivate, keeperId, verificationGoalId)).toBe("active");
expect(goalStatus(afterShare, keeperId, verificationGoalId)).toBe("completed");
expect(goalStatus(afterPublic, keeperId, privacyGoalId)).toBe("blocked");
```

本 Task 测试私有 `goalStatus(world: WorldState, npcId: NpcId, goalId: string)` 只通过 Entity lookup 返回状态；三份 after 均由真实规则 Action 生成，不能测试直接设置预期状态。

- [ ] 运行 `npx vitest run src/game/gameplay/rpg/npcGoals src/game/gameplay/rpg/storyInteraction --minWorkers=1 --maxWorkers=2` RED。
- [ ] 复用 `set_npc_goal_status`，追加 `npc_goal_status_changed` payload `{npcId,goalId,from,to,evidenceEventIds}`，causes 指向实际调查/告知/履约。规则内构建同一 action 的有序事件预览，知识→目标→Quest/Thread；最后随原 commit 一次写入。不得增加第二个数据库提交，不从生成正文抽取完成状态。
- [ ] `talk_to_npc` 增加可选、非空 `completionConditions`，只允许已绑定目标/事实/承诺。带条件时需 met、条件满足及实际交谈来源；普通 support/challenge 的计数不能越过它。`isObjectiveSatisfied`、`isObjectiveSatisfiedInStory`、`reconcileQuests` 都委托同一判定；满足新条件后也不能反过来被旧 dialogueSession 的两轮计数卡住。未带条件时保留旧会话完成规则；相关 NPC 对话不满足条件时不得自动换幕或消失。
- [ ] 互动过滤和调查 requirements 复用同一 evaluateStoryCondition，目标改变后重算可用项；模型 outward 不得绕开条件。保留当前四种 operation 及原保密规则，公开调查不被硬塞进“玩家分享才算违约”的旧保密条款。
- [ ] 回归终态不反转、无新证据不重复、错误来源/越权/条件环拒绝、普通旧目标不变、reload 和 battle rollback；相关 tests/typecheck/boundaries 后更新文档并提交 `feat: resolve npc goals from observed evidence and gate cooperation`。

**验收：** 至少一项目标变化能改变后续合法 Action，而不仅改变 context 中的一行状态。

### Task 3：在实际具象化时绑定规则，保持主线可完成

**阅读：** 总 Spec §4、§6、§8；[世界具象化](../../agent/世界动态具象化.md)、Task 1/2、现有 opening/worldDelta/draft 编译器。

**Files:**

- Create: `src/game/domain/storyConsequenceBindings.ts`、对应 `.test.ts`；`src/game/application/approveStoryConsequenceBindings.ts`、对应 `.test.ts`。
- Modify: `src/game/domain/openingGenerationCandidate.ts`、`worldDelta.ts`、`narrativeBundle.ts`；`src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`、`validateOpeningGenerationCandidate.ts`。
- Modify: `src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts`、`materializeWorldDelta.ts`、`src/game/application/approveNarrativeBundle.ts`、`src/game/application/server/ai/liveWorldEvolutionSource.ts`、`openingNarrativePrompt.ts`、`narrativeDraftProjection.ts`。
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts`，只增加三个下文定义的绑定 mutation，不直接修改投影数组。
- Test: `src/game/application/approveNarrativeBundle.test.ts`、`src/game/application/server/ai/openingGenerationSource.test.ts`、`narrativeDraftProjection.test.ts`、`src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts` 及新增绑定单元测试；Docs: 世界具象化、NPC 系统、实体状态。

**Interfaces:** 当前已支持的 `NarrativeSymbolRef` 继续负责 @new.*；新增类型只描述本期绑定，所有正式 ID 由 compiler 分配。`StoryConsequenceBindingsProposal` 为最多八项的数组，每项为下面三个封闭变体之一：

```ts
type StoryConsequenceBindingProposal =
  | { kind: "bind_goal_resolution"; npcRef: string; goalOrdinal: number;
      resolution: NpcGoalResolution }
  | { kind: "bind_investigation"; factRef: string;
      discoveryMode: "investigation"; approaches: readonly InvestigationApproach[] }
  | { kind: "bind_talk_completion"; questRef: string; npcRef: string;
      conditions: readonly StoryCondition[] };
type StoryConsequenceBindingsProposal = readonly StoryConsequenceBindingProposal[];
```

`string` 只允许已存在的可引用 ID、现有 @new.* 符号，开局则使用该 candidate 已有局部 fact key；不能任意新造符号。条件中的类型品牌在 provider JSON 阶段由 parser 解析，应用编译映射为正式 ID 后再运行 domain/实体校验。goalOrdinal 是当前 NPC goals 的实际创建序号，0 起、不换序，编译后仅持久真实 goalId；不允许模型指定任意正式 goalId。

`approveStoryConsequenceBindings(input: { proposal: StoryConsequenceBindingsProposal; worldState: WorldState; storyState: StoryState; symbols: ReadonlyMap<string, EntityId> }): {ok:true; worldState:WorldState; storyState:StoryState} | {ok:false; code:string; path:string}`。应用审批只做引用/一致性核对，规则合法性委托 Task 1/2 的 gameplay facade，不自行写规则数值。

对应 `EntityMutation` 增加 `bind_npc_goal_resolution {npcId,goalId,resolution}`、`bind_fact_investigation {factId,approaches}`、`bind_quest_talk_completion {questId,npcId,conditions}` 三个封闭变体。调查 mode 随 bind_fact_investigation 固定为 investigation；首个绑定以原子候选的 blueprint_expanded 或开局来源记录角色/事实/任务引用，不生成虚假的玩家 Action。既有定义不得覆盖，完全相同的同候选重入幂等。mutation 只装配条款，不把条件已满足解释为玩家已经执行调查/合作。

调查绑定只接受玩家尚未知晓且有安全 label/明确地点的 Fact，不能把已发现事实改成未发现。talk 绑定在该 Quest 中必须恰好定位一个对应 NPC 的 talk objective；缺失或重复均拒绝，不默取第一项。开局的公开可披露事实不等于玩家初始已知；作为主动调查的 fact key 不得同时进入玩家初始 knownFactIds。NPC 可以依自己的合法初始来源知晓同一事实，不受玩家调查状态替代。

- [ ] RED：同批新 Fact 可以绑定既有 NPC 尚无条款的目标；正式 ID 解析后不创建第二个 NPC。未知 key、越界 ordinal、重复绑定、尝试改写已有条款、跨私密角色条件、无地点调查和循环依赖均拒绝；同时覆盖开局调查被提前授知、已发现事实重新绑定和同 Quest 重复 NPC 目标的拒绝。
- [ ] 运行 `npx vitest run src/game/application/approveStoryConsequenceBindings.test.ts src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts --minWorkers=1 --maxWorkers=2` RED。
- [ ] 在 opening 和 decision bundle 增加可选 consequenceBindings；先原有实体预览/ID 铸造，再绑定并完整校验，再生成供 approval/review 共用的规则投影。只有完整候选获批才 B 提交。目标已有非空条款、已 completed/abandoned 或相关选择已被消费时不可重新绑定，不能临时改门槛使旧选择失效。
- [ ] 绑定范围限当前可交互切片和已进入故事的关联人物；未来角色未物化不保存悬空 ID。开局核心目标依旧先用已有切片，后续新证据出现时补具体条件，而不改初始身份、价值观和世界设定。
- [ ] 将主动调查从 `deriveActObjectives` 的零行动折叠和随机形状删减中排除；当存在本期绑定时，按声明的实际依赖生成顺序。检查调查方法 requirements→必要证据/目标→任务条件不存在闭环；拒绝“必须完成目标才能取证，而目标又要求该证据”的切片。
- [ ] 当前展示的主动调查至少有一个可执行方法；尚需先合作的调查必须能从本切片已有合法行动取得前提，满足前提后才展示。关闭一种合作后必须仍有本切片已批准的推进或合法退出，不能依靠作者承诺“下一幕再找办法”通过。只检查有限本切片依赖，不建全局路径求解器。
- [ ] 提供一个与递送无关的离线编译例“向匠人出示修理记录再查旧账”，验证同一绑定无需故事名/固定 NPC ID 分支。相关 tests/typecheck/boundaries 后更新文档并提交 `feat: bind materialized evidence to bounded story consequences`。

**P3-A gate：** 自动/主动调查区分明确；目标推进有来源；合作约束实际进入可用动作；有限切片不存在已知必经死锁。还没有 UI/live 证据时不称为可玩完成。

## P3-B：实际交互与整场生成

### Task 4：调查结果与变化回访使用原 A/B 生成链

**阅读：** 总 Spec §8；[行动裁决](../../agent/行动裁决.md)、[运行时 AI](../../agent/运行时AI导演与场景表演.md)、Task 1–3。

**Files:**

- Create: `src/game/gameplay/rpg/narrativeBundle/resultBoundary.ts`、对应 `.test.ts`。
- Modify: `src/game/domain/pendingNarrativeJob.ts`、`narrativeBundle.ts`、`storyState.ts`；`src/game/gameplay/rpg/narrativeBundle/index.ts`、`descriptors.ts`。
- Modify: `src/game/gameplay/rpg/worldEvolution/storyReveal.ts` 及对应测试，适配主动调查选择边界；回访保持已访问地点及已释放 NPC 的现有规则，不放开尚未出场角色。
- Modify: `src/game/application/performTurn.ts`、`consumeNarrativeBundle.ts`、`generatePendingNarrativeBundle.ts`、`src/game/application/server/ai/narrativeDraftProjection.ts`、`src/game/application/server/persistence/storyStatePersistenceValidation.ts`。
- Test: `src/game/application/testing/providerTriggerMatrix.test.ts`、`src/game/application/server/providerTriggerBoundary.test.ts`、`src/game/application/testing/narrativeRecoveryJourney.test.ts` 及现有 job/performTurn/SQLite/generator tests。
- Docs: 核心闭环、行动裁决、运行时 AI、设计原则、地图与地点冒险中的生成边界。

**Interfaces:** 新 `ResultBoundaryProof` 只由服务端规则生成，客户端无法提交：

```ts
type ResultBoundaryProof =
  | { kind: "investigation_result"; factId: FactId; approachId: string;
      sourceEventIds: readonly EventId[] }
  | { kind: "changed_revisit"; locationId: LocationId;
      previousSceneEventId: EventId; sourceEventIds: readonly EventId[] };
function proveResultBoundary(input: {
  beforeWorld: WorldState; beforeStory: StoryState;
  afterWorld: WorldState; afterStory: StoryState;
  action: Action; newEvents: readonly CommittedNarrativeEvent[];
}): ResultBoundaryProof | null;
```

给 `DecisionBoundaryKind`、`ProviderGenerationKind`、`NarrativeSceneRequestKind` 同步增加上述两种值及合法配对，PendingJob 保存可选 resultBoundaryProof；parser/日志/触发矩阵使用唯一表，不仅改 classify 而漏掉实际 source 路由。

- [ ] 写 RED：成功调查且没有有效续接可进入 pending；非法方法/未释放/无发现事件不能触发。回访须是真实 move 到已访问地点，且该地上一次 narrative_scene_presented 后出现相关可见规则变化；UI 导航和普通首次移动均不触发。
- [ ] 回访变化集合限目标/承诺/知识/物品归属/当前相关任务的实际变化 Event，与地点、在场 NPC、活跃 Thread/任务实体相交；排除场景展示、普通查询、纯 revision/lease/摘要变化及玩家旅行本身。不允许未知秘密成为回访触发的可见提示。没有上次真实场景证据不伪造 changed_revisit。
- [ ] 运行 `npx vitest run src/game/gameplay/rpg/narrativeBundle/resultBoundary.test.ts src/game/application/testing/providerTriggerMatrix.test.ts src/game/application/performTurn.test.ts --minWorkers=1 --maxWorkers=2` RED；实现优先消费有效 bundle，否则新边界 A→pending。新 proof 和当前行动、事件、目标、History 同一次 CAS；B 失败后 A 仍成立。

```ts
expect(afterA.worldState.worldFacts.find(f => f.factId === factId)?.discovered).toBe(true);
expect(afterA.storyState.narrative.status).toBe("provider_pending");
expect(afterRetry.worldState.eventLedger.filter(e =>
  e.kind === "fact_discovered" && e.factIds.includes(factId))).toHaveLength(1);
```

`afterA/afterRetry` 来自正式仓储+失败 source 测试，不用直接赋值构造成功。

- [ ] result boundary 的 draft 可以是无 NPC 的调查结果 currentScene，也可以是回访后的焦点场景；不能因为旧逻辑只认 talk 就补一次无意义 ask。其 terminal 仍用现有 current_scene/continuation_step/ending，必要固定选择引用当前合法 investigate/talk；已经结算的调查不出现在下一步待消费队列。
- [ ] descriptors 对主动调查停在真实选择前，不提前展开尚不确定的方法后果；未选方式不 materialize 发现/见证知识。旧已批准 continuation 只有在动作参数和当前规则依据仍有效时可消费；不能拿干净方法的预稿响应公开方法。
- [ ] 正式回访测试必须覆盖：旧 NPC 不再是当前主线目标但仍已释放、同场且有相关活跃目标/Thread；read model 保留合法 ask/互动，生成目标选择不能总是跳到新主线 NPC。尚未释放角色不可借回访露出。普通未变化回访若已有合法内容按原步骤消费；没有步骤也没有新边界证明时，继续显式拒绝，不临时扩大生成范围。
- [ ] Story13/Bundle3 同步更新创建/解析/fixture/已知旧版拒绝；不另建任务表或缓存。新边界依旧先固定 P2 player/必要 NPC 记忆包，再进行作者/审阅；lease 接管、缺包、过期 review、预算与取消沿原实现。
- [ ] 写正式 SQLite 的 A 成功 B 失败/reload/重试、旧 worker、并发 ensure、重复调查、变化回访只响应一次、普通缺步骤仍零写入回归；tests/typecheck/boundaries 后更新文档并提交 `feat: generate committed investigation and changed revisit results`。

**验收：** 新边界由实际规则结果证明；没有万能“缺稿就生成”分支，也不重执行调查或移动。

### Task 5：把合法调查与合作变成玩家看得见的选择

**阅读：** Task 1–4；[地图与地点冒险](../../agent/地图与地点冒险.md)、[NPC 对话驱动](../../agent/NPC对话驱动叙事场景触发.md)、对应策划的普通两选项与自由输入规则。

**Files:**

- Modify: `src/game/application/buildChoiceMap.ts`、`gameSessionView.ts`、`sceneChoiceCandidates.ts`、`approveNarrativeBundle.ts`、`src/game/gameplay/rpg/narrativeBundle/descriptors.ts`。
- Modify: `src/game/application/server/ai/narrativeDraftProjection.ts`、`narrativeContext/narrativeBundleContext.ts`、`storyInteractionPrompt.ts`、`liveNarrativeBundleSource.ts`。
- Modify: `src/components/LocationSceneScreen.tsx`、对应 `.test.tsx`；`src/game/application/index.ts` 只转发安全 view 类型。
- Test: `src/game/application/buildChoiceMap.test.ts`、`gameSessionView.test.ts`、`sceneChoiceCandidates.test.ts`、`approveNarrativeBundle.test.ts`、`src/game/application/server/ai/liveNarrativeBundleSource.test.ts`、`src/game/application/testing/investigationChoiceJourney.test.ts`（增加独立 production case，不冒充原 offline fixture）、`src/app/api/game/routeContract.test.ts`。
- Docs: 地图与地点冒险、行动裁决、运行时 AI 和 [MVP 玩家规则](../../策划文档/AI生成RPG_MVP.md)。

**Interfaces:** `availableInvestigations` 的 action 仅留服务端；read model 增加 `currentLocation.investigations`：

```ts
type InvestigationChoiceView = Readonly<{
  label: string; hint?: string; choiceToken: string;
}>;
type InvestigationView = Readonly<{
  label: string; choices: readonly InvestigationChoiceView[];
}>;
```

玩家看到已获批的目标 label/method label，不看到 factId、未发现正文、内部条件、私密 goal、质量枚举或数值 delta。pending/failed/battle/ending 不提供可提交调查；旧 token 仍在服务端拒绝。

- [ ] RED：真实 read model 显示两种合法方法且 token 对应不同 approachId；锁定方法不能经手造/旧 token 提交；两个普通支持回答不能完成带合作条件的 objective。React 点击走现有请求链，不能直接传 Action。
- [ ] 运行 `npx vitest run src/game/application/buildChoiceMap.test.ts src/game/application/gameSessionView.test.ts src/components/LocationSceneScreen.test.tsx src/app/api/game/routeContract.test.ts --minWorkers=1 --maxWorkers=2` RED。
- [ ] 来源唯一化：地图/地点行动栏和正文 fixed choice 都引用服务端相同 Action 身份；复用当前 deriveRuntimeChoiceToken/ApprovedChoice，不建立独立的调查 API。地点栏提供调查方法，NPC 场景仍保留两项表达；作者可以在合法 candidate 集合里选用相关调查或互动，不被固定 support/challenge 模板锁死。
- [ ] 准入投影由规则提供支持集合与原因引用；作者不能以漂亮 label 声称调用不受支持的能力。合作条件未满足时，给有依据的补证/已有替代方法，不能仅重复“我支持/我质疑”。没有足够合法选项时按现有生成错误修订，不能复制同一 Action 凑两个 token。
- [ ] 自由输入原样经中性 talk，后续作者从完整合法集合中选出符合策略、此前未展示的现成方法或互动；不新增 intent 模型，不直接发现、交付、移动或承诺。超出当前规则能力的策略可被 NPC 解释或转为已有合法提案，不把自由文本编译成新 effect。

```ts
expect(afterFreeText.worldState.worldFacts.find(f => f.factId === factId)?.discovered).toBe(false);
expect(proposedActions.some(a => a.type === "investigate" && a.factId === factId)).toBe(true);
// 点击该获批 token 后，再由 Task 4 的 A/B 链观察真实发现。
```

该测试中 `proposedActions` 由 B 后正式 `buildChoiceMap` 按已展示 token 反查，不能从 provider 原始候选直接取值。

- [ ] 新调查 label/hint 经当前候选审批/审阅检查泄露和行动对应；不新增一轮审阅器。规则条件/见证者若修订，正文与 choices 同版重新审批，不能复用旧候选 pass。
- [ ] 运行相关 UI/application/source tests、typecheck/boundaries；实际行为归属文档原位更新，提交 `feat: expose evidence driven choices through the production UI`。

**验收：** 玩家能实际选择不同方法，提出策略后有真正可点击的下一步；所有效果仍由规则结算。

### Task 6：让新后果持续进入角色、作者和终局

**阅读：** Task 2/4/5；[连续性与记忆](../../agent/剧情连续性与结构化记忆.md)、NPC 系统、[战斗与结局](../../agent/战斗与结局.md)。

**Files:**

- Create: `src/game/application/storyConsequenceContext.ts`、对应 `.test.ts`。
- Modify: `src/game/application/projectNpcDeliberation.ts`、`prepareNpcNarrativeContext.ts`、`entityContextProjection.ts`、`prepareNarrativeMemory.ts`、`approveNarrativeBundle.ts`、`generatePendingNarrativeBundle.ts`。
- Modify: `src/game/gameplay/rpg/narrativeMemory/projectObserverEvidence.ts`、`retrieveStoryEvidence.ts`、`src/game/gameplay/rpg/storyThreads/advanceStoryThreads.ts`。
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`、`narrativeReviewRules.ts`、`liveNarrativeCandidateReview.ts`、`src/game/gameplay/rpg/narrativeBundle/endingDecision.ts`（仅后果依据投影需要时，不替换主题裁决）。
- Test: `src/game/application/prepareNarrativeMemory.test.ts`、`prepareNpcNarrativeContext.test.ts`、`projectNpcDeliberation.test.ts`、`src/game/application/server/ai/liveNarrativeBundleSource.test.ts`、`liveNarrativeCandidateReview.test.ts`、`src/game/application/testing/narrativeP2Journey.integration.test.ts`、`narrativeRecoveryJourney.test.ts`；Docs: 连续性与记忆、NPC 系统、运行时 AI、战斗与结局。

**Interfaces:** `projectStoryConsequences(input: {worldState:WorldState;storyState:StoryState;observerId:EntityId;eventIds:readonly EventId[]}): StoryConsequenceContext`，输出只读来源引用：

```ts
type StoryConsequenceContext = Readonly<{
  observerId: EntityId;
  requiredEventIds: readonly EventId[];
  currentGoalRefs: readonly { npcId: NpcId; goalId: string }[];
  activeThreadIds: readonly string[];
  availableInteractionIds: readonly string[];
}>;
```

该对象是当前请求投影，不持久化第二份状态。公开作者只能得到已经公开的角色条件/反应依据；私密 NPC 目标全文仍只入本人的 deliberation。控制隐蔽条件的规则检查看当前 Entity，但不把秘密原因通过 manifest 或 choice hint 泄露。

- [ ] RED：旧账原话离开近期窗口后，回访与合作条件仍将所需实际 Event/原话带入最终作者请求；私密查阅未告知 NPC 时，其 privateMemory 与 outward 都不声称亲见。只测 helper 返回值不算完成。
- [ ] 用生产 prepare→NPC→author→review 装配捕获 requests；运行 `npx vitest run src/game/application/storyConsequenceContext.test.ts src/game/application/prepareNpcNarrativeContext.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/testing/narrativeP2Journey.integration.test.ts --minWorkers=1 --maxWorkers=2` RED。
- [ ] 将新目标变化及调查/告知来源作为现有 mandatory/contextEntityIds/contextEventIds 的输入，继续 P2 单轮有限检索。当前 goal/owner/knowledge 状态优先，旧摘要中“愿意引荐”不能恢复已失效许可；缺少 mandatory 或超64,000则显式失败，不另加摘要层。
- [ ] 更新 observer 对新 Event 的判定，只有实际角色可见来源才能进入其包。goal Event 的 evidenceEventIds 不自动授权整个因果链；分享某一来源只开放已明确告知的证据，不能把原事件所有私密听众/附带事实一并展开。
- [ ] A 的调查/分享使用 Task 2 结算；B 若产生本场实际成立的 NPC 知识变化，也使用同一纯规则结算器。审批预览中先核对实际披露和受众，再结算目标并重建本场合法选择投影，作者/审阅针对同一预览；只有 B 成功才一并提交。未来续接和未选分支不提前结算；不得在 ready 发布后另补目标状态而使刚展示的 token 失效。测试 B 失败零新增目标变化、成功后选择准入与目标一致、同 job 重试不重复。
- [ ] fixed-memory 来源 fingerprint 纳入影响当前权限/准入的新增条款与状态；同 job 内固定，下一实际行动产生新包。摘要缓存仍派生；新增 goal Event 不计为 History 文字条目，不调低50/10阈值，不补对白凑数量。
- [ ] 作者/现有审阅获得同一“已结算后果+当前可做事情+仍未解决条件”投影。NPC 私密判断可以解释取舍，但其 cooperate/refuse 不替代规则 gate；新目标条款/实际 goal 变化应触发当前焦点判断，保留最多一个角色，不增离场判断。
- [ ] 终局沿原 endingOutcomes 发布；至少引用本路线已提交的调查方式、知情范围、合作变化或承诺后果，不能把最后 support 当作取消先前代价。Task 7 断言状态，真实文本由 Task 8 阅读；不另加评价器保证文学质量。
- [ ] 回归新事件来源被摘要省略后的恢复、相同 sequence 不同来源失效、A/B 故障、战斗回滚、结束重载；相关 tests/typecheck/boundaries 后更新文档并提交 `feat: carry investigation consequences into memory and narrative outcomes`。

**P3-B gate：** 正式 UI/规则/生成源装配完成；新后果可持续影响选项与终局依据，权限和恢复保持 P2 契约。

## P3-C：完整故事与收益验证

### Task 7：正式离线旅程证明两种策略都可走通

**Files:**

- Create: `src/game/application/testing/narrativeP3Journey.testutil.ts`、`narrativeP3Journey.test.ts`。
- Test: 复用 `narrativeRecoveryJourney.test.ts`、`narrativeP2Journey.integration.test.ts`、现有 provider trigger 和 UI tests，不重写 P2 验收框架。
- Docs: 本 Plan P3-A/P3-B gates；有问题只回到对应 Task 修复。

**Interfaces:** testutil 导出 `runOfflineP3Story(input: {route:"private"|"public";reloadAtRevisit:boolean}):Promise<P3StoryEvidence>`；内部创建独立 SQLite，经正式 createGame/read model/performTurn/ensure 到终局。

```ts
type P3StoryEvidence = Readonly<{
  completed: boolean;
  actionCount: number;
  investigationEventIds: readonly EventId[];
  goalChangeEventIds: readonly EventId[];
  availableActionsBeforeEvidence: readonly Action[];
  availableActionsAfterEvidence: readonly Action[];
  publicWitnessFactIds: readonly FactId[];
  recalledEvidenceInAuthorRequest: boolean;
  privateEvidenceLeaked: boolean;
  itemGivenEventCount: number;
  reloadEqual: boolean;
}>;
```

- [ ] 先写两路完整失败测试；数据来自同一获批初态，仅玩家方法/合法后续策略不同：

```ts
const privateRoute = await runOfflineP3Story({route:"private",reloadAtRevisit:true});
const publicRoute = await runOfflineP3Story({route:"public",reloadAtRevisit:true});
for (const route of [privateRoute, publicRoute]) {
  expect(route.completed).toBe(true);
  expect(route.itemGivenEventCount).toBe(1);
  expect(route.privateEvidenceLeaked).toBe(false);
  expect(route.reloadEqual).toBe(true);
  expect(route.availableActionsAfterEvidence).not.toEqual(route.availableActionsBeforeEvidence);
}
expect(privateRoute.publicWitnessFactIds).not.toEqual(publicRoute.publicWitnessFactIds);
```

- [ ] 运行 `npx vitest run src/game/application/testing/narrativeP3Journey.test.ts --minWorkers=1 --maxWorkers=2` RED；实现双场景 fixture source 同时覆盖 opening/decision。source 可以提供确定性 AI 内容，不能 runner 写入 History、goal、Quest 或 owner 来推进。
- [ ] 私下路线：方法前提→真实查阅→回访→实际告知→目标/合作改变→合法引荐/核验→显式交付。公开路线：真实见证→不同目标/合作可用性→已声明替代方法→显式交付。不得通过直接跳终幕或自由输入宣称成功缩短路径。
- [ ] 在条件变化后读取同一 NPC 的正式候选，证明两路至少有一项可用/不可用 Action 不同，并继续两次有效行动验证后果仍存在。不同张力数字或一句不同 label 单独不足以证明合作分化。
- [ ] 另用 Task 3 匠人材料场景跑最小“查证→告知→开放另一方法”片段，防止依赖递送、人名或道具名硬编码。主动退出、死锁拒绝、未选方法零影响、重复 ensure/调查、旧 token、回访故障、NPC 无来源不可反应均覆盖。
- [ ] 不重复建设旧 P2 集成；在既有测试上确保新增 schema/事件不会破坏 memory 固定包和权限；运行相关 tests/typecheck/boundaries 后提交 `test: complete divergent evidence and cooperation journeys`。

**验收：** 两路不仅能 ending，还能从事件、真实 Action 集合、知识与原话解释为什么过程不同。

### Task 8：有限真实调用与实机故事验收

**阅读：** [AI 环境](../../agent/AI环境.md)、现有 P1/P2 driver 的 register/live/replay；先阅读当前正式配置，不能把旧模型假设或密钥写入文档。

**Files:**

- Create: `src/game/application/testing/narrativeP3LiveJourney.ts`、对应 `.test.ts`；`scripts/narrativeP3Journey.mjs`、`scripts/narrativeP3Journey.node-test.mjs`。
- Modify: `package.json` 仅添加 `journey:narrative:p3` / `test:narrative-p3-script`；复用 `scripts/narrativeP1Replay.mjs`、`scripts/narrativeP2SegmentRuntime.mjs` 的基础传输/SQLite 装配，不改变旧冻结协议。
- Create: `docs/superpowers/reports/2026-09-15-narrative-p3-protocol.md`、`2026-09-15-narrative-p3-acceptance.md`（实施本 Task 时写真实登记与结果）；更新本 Plan gates。

**Interfaces:** thin runner 支持 register/live/replay；register 零网络，live 需要既有显式环境门禁。新协议 `narrative-p3/v1`，plannedRoutes 固定 2，返回每条 completed/blocked/not_run，未执行保留分母；不得修改 P1/P2 CLI 的旧 passed 语义。

- [ ] 先写脚本/runner 参数、冻结输入、分母、预算和零网络 replay 测试；runner 使用实际 read model action refs 选路，不能按 label 关键词猜 ID，不能直接提交未展示 token。
- [ ] 固定一次真实三幕初始化，输入为本 Plan 的“旧契与证人”结构；玩家名/身份、模型别名与实际策略从现有合法配置登记完整 JSON。不得注入旧获批开局冒充新生产创建。第一次出现两种调查方法的 ready 点冻结真实来源，分别复制到 private/public 独立数据库；共同开局与前缀只计一次实际 HTTP。
- [ ] route private 优先无额外见证的方法，route public 优先明确现场见证的方法；路径只依服务端已批准 Action/方法规则选择。需要合作时从合法引荐/核验/分享中选择对应项；“先查看原始记录，再决定怎么交付”在一条路线只输入一次，通过新获批选项继续。没有两种合法方法或没有可执行替代路径就报告能力覆盖失败，不补抽开局或修改世界。
- [ ] 每条最多32有效动作、300 HTTP、120分钟；共同初始化加两路整批最多600 HTTP、180分钟。每 job 仍3候选/32总HTTP，正式批不自动点耗尽后的手动 retry。失败保存来源与原始响应；代码有确认根因变更时结束旧批，重新冻结须明确新范围，不能无限采样。
- [ ] 运行一次 `npm test -- --minWorkers=1 --maxWorkers=2`、typecheck、lint、P3脚本与相关旧协议 tests、check:docs；全量已含 boundaries 不重复。UI/bundle consumer 改变需一次 production build。冻结待测 commit、diff/config/input/策略哈希及模型能力；不输出 API key。

```powershell
npm run journey:narrative:p3 -- --mode=register --run-id=p3-01 --output=artifacts/narrative-p3/p3-01
# live 使用 register 生成的协议；显式 RUN_REAL_AI_JOURNEY 门禁沿现有脚本。
npm run journey:narrative:p3 -- --mode=live --protocol=artifacts/narrative-p3/p3-01/protocol.json
```

- [ ] 至少一条以实际 UI 完成调查选择、自由策略确认、回访、中途刷新和合法终局；保留实际输入/响应/前后数据库。复用已有捕获方式，不为本期另建 UI transport 录制平台。能用现有 tape 严格回放的 API 流执行一次零网络回放；不能回放的 UI 部分标记实际证据，不冒充严格回放通过。
- [ ] 产物保存到 `artifacts/narrative-p3/<runId>/`：初始化/分叉初态、所有实际行动与选项、每版 draft/审批/缺陷、实际 provider 请求、History/Event、目标/知识/合作前后差异、A/B重试、HTTP/耗时、终局和 UI/重载证据。旧报告不改为通过。
- [ ] 按下表 C1–C8 判程序与玩法结果；阅读全文独立观察重复、动机、因果、选择代价和收束，指出是否实际用上新能力。文学发挥不足如实记录，不用不断修改提示词换取分数；真实越权、未结算行动被接受或缺失必要上下文仍是必须修复的程序问题。
- [ ] 运行 docs/diff/链接复核，更新 gates 与验收报告，限定文件提交 `docs: record P3 evidence driven story acceptance`。不合并 main、不声称已替代 main、不自动进入 P4。

## P3 完成矩阵

| 编号 | 必须成立 | 主要证据 |
| --- | --- | --- |
| C1 主动调查 | 玩家选择前未知，选择后唯一发现；普通自动观察保持 | Task 1/4/5/7 的正式规则、UI、实际 Event |
| C2 角色因果 | NPC 仅按本人已知/见证/被告知证据改变目标；越权和重复零效果 | Task 2/6/7，真实知识与目标变化来源 |
| C3 合作分化 | 两路至少一项后续实际 Action 的准入不同，继续两次行动后仍有可追溯后果 | Task 5/7 的完整状态和 Task 8 对照 |
| C4 自由策略 | 输入本身不调查/交付；随后出现对应合法选项，选中才结算 | Task 5/7/8 |
| C5 回访和记忆 | 带证据回访触发受控结果；旧人不失忆也不全知；必要旧话进入最终请求 | Task 4/6/7，现有 P2 来源及冻结包断言 |
| C6 恢复 | A成功B失败/reload/retry 不重做动作；并发、过期、取消、未选方法、战斗回滚不污染 | Task 4/6/7 SQLite 与装配回归 |
| C7 完成性 | 同一真实初始化分叉两条完整路线，至少一条 UI；调查与合作实际发生，真实交付/退出及终局 ready | Task 8，所有失败和未执行保留分母 |
| C8 可维护性 | 新切片依赖有界、无已知必经死锁；另一题材复用；不新增框架或破坏 P1/P2 公共契约 | Task 3/7、完整回归和文档事实核对 |

只有 C1–C8 均有明确证据、相关检查通过且无已知阻断工程缺陷，才标 P3 完成。C7 某路线失败时保留未完成；不以增加模型调用直到出现一条好稿补齐。可先报告 P3-A/P3-B 工程完成，不能据此声称整个 P3 完成或优于 main。

## 执行记录

- **范围确认：** 用户已确认本 Plan 的玩法范围、自由输入方式、两类生成边界和验收口径，详见“Global Constraints”与范围核查；其余均是待实现契约。
- **P3-A：** 未执行。
- **P3-B：** 未执行。
- **P3-C：** 未执行。
- **P3 总结论：** 本轮仅完成范围规划与 Plan，尚未实现或调用真实 API。

后续若发现缺口属于直接意图解析、错误信念、离场行为或更复杂世界系统，记录新的具体用例再与用户确认，不以“总 Spec 的 P3 曾提到”自动扩大本 Plan。
