# 较长经历召回与完整中篇 P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有短篇与五幕中篇范围内，验证旧事召回、按视角上下文组装、带来源摘要、正式调用及恢复的工程正确性，为模型提供合法且充分的必要材料。

**Architecture:** 保留 P1 的唯一整场作者、角色判断、现有审阅、场景槽编译及 A/B 提交。先贯通原始证据的可见性与 mandatory 传递，再在独立派生缓存中实现分批摘录摘要/概览；所有消费者使用同一来源可追溯的记忆包，事实与当前状态始终回到 Entity/Event。

**Tech Stack:** TypeScript 5.8、Next.js Node runtime、Node.js ≥24.15.0 内置 SQLite、Vitest 3；复用 RPG 的 AI、审计与严格回放接口，不新增运行时依赖。

## Global Constraints

- 唯一总设计：[架构 Spec](../specs/2026-09-12-narrative-architecture-design.md)。范围及代码核查证据：[P2 范围核查](../reports/2026-09-14-narrative-p2-scope-review.md)。先读上述核查结论和本节，再按当前 Task 阅读对应章节。
- 从 `codex/narrative-architecture` / `.worktrees/narrative-architecture` 的 **dfb567b1** 继续；不重新从 main 建分支，不合并 main，不修改旧 staged，不改变 `current-phase.json`。本 Plan 是独立任务入口。
- P1 已满足收敛后的最小准入；旧保密/核验样本和未执行矩阵保持原结论。不重派 P1 建设任务、不以 P1 旧 Plan 未勾选的历史失败项阻止本 Plan。
- “质量与游戏性优先于 token、调用数和耗时。”摘要减少输入量只是观测指标；P2 工程验收以 Task 7 的规则、来源、上下文和恢复契约为准，剧情评分及模型对材料的发挥另作观察。
- “规则已结算结果不可被后续循环改写”；“原文永不因摘要删除”。摘要不得写 Event、Entity、Thread、Quest、delivery、ending、History 或 gameplay revision。
- 不增加 Action/互动操作/Entity 组件、通用规划器、reviewer、润色器、向量数据库、图数据库、层级 Arc、长篇模式或世界模拟。已支持的五幕中篇不是开放式长篇。
- 权威 schema 保持 **EntityStore3 / World7 / Story12**；摘要缓存使用独立 formatVersion=1。不得把 schema11 文档或旧 P1 初版 schema10 当代码基准。
- 所有原文按 speaker/audience/实际事件权限投影；玩家选项表示所选行动，不自动等于说出口的台词。未选选项、未消费续接及条件结局都不能成为已发生经历。
- P2 只消费 foundation 公开接口；不修改 `.foundation`、公共 package 或 `docs/共同规范/`。新增逻辑均有 RPG 语义。
- Task 1–6 已有代码与离线证据，具体覆盖见 [准入修复验收](../reports/2026-09-14-narrative-p2-readiness-fixes.md)；真实调用与 UI 证据见[三项收尾报告](../reports/2026-09-15-narrative-p2-closeout.md)。当前只执行 Task 7 工程封板；如发现调用链缺陷而需新实跑，必须另行冻结，不替换旧失败样本。

---

## 范围、里程碑与后续归属

| 里程碑 | Task | 独立交付 | gate |
| --- | --- | --- | --- |
| P2-A 旧事真正进入当前互动 | 1–2 | 有权限、有来源、有原话的统一记忆包及作者/NPC 消费接口 | 长间隔、错误指代、未选项、秘密与旧状态覆盖通过真实 prompt 构造断言；生产 generator 装配由 Task 5 验证 |
| P2-B 安全的派生摘要 | 3–5 | 50/10 分批、可重建概览、独立缓存、失败无断档、并发不影响 A/B | 原始来源与覆盖水位可验证；摘要关闭/失败时故事仍可用原文运行 |
| P2-C 正式工程闭环 | 6–7 | 现有离线完整旅程、真实摘要/调用、同源对照和 UI 回想至终局 | 规则、来源、组装、调用与恢复成立；文学评分及模型回答收益不阻塞 |

先完成当前 gate，再进入下一段。若较长经历错误来自检索或权限投影，修对应 Task；若出现新的通用行动/世界模拟需求，记录为 P3，不在 P2 扩充规则来“救”某段文案。

| 原总 Spec 后移事项 | 本 Plan 负责 | 后续归属 |
| --- | --- | --- |
| 较长间隔旧人/原话/承诺 | 来源、召回、当前状态与正式中篇验证；现成承诺的回归 | 新承诺操作、复杂履约玩法交 P3 |
| 保密/引荐/核验六路线 | 保留权限与已有操作回归；不执行旧 failed focused 矩阵 | P3 在实际玩法稳定后登记新综合矩阵 |
| 完整 UI | 仅记忆追问、刷新、继续至终局 | 视觉打磨/综合交互专项 |
| 优于 main | 不作该结论；P2 对照只分析摘要对证据使用的影响 | P2/P3 稳定后的同配置 main 对照，另行 Plan |
| 性能/扩容 | 有限输入、缓存一致性和计数 | 索引服务、事件分段/归档、长篇交 P4 |

## 三份参考的采用与边界

参考文档提供设计原料，不能把其中所有建议作为本期必做事项。下表区分已经由 P1 提供的基础与 P2 需要补齐的路径；“纳入 P2”表示已列入实施与验收，尚不表示代码已完成。

| 参考及章节 | 只采用的高收益部分 | P2 落点及预期收益 |
| --- | --- | --- |
| [SillyTavern 分析](../../设想/SillyTavern_Architecture_Analysis_for_AI_RPG.md) §7–11、§23 | 多来源查询、scope、优先级、业务化 Context Slot；先召回再按预算编译 | Task 1/2/5：复用已有 Context Compiler，补权限先行、必需证据传递和来源 manifest；避免靠扩大整段 prompt 解决遗忘 |
| 同上 §7.2/§7.3、§8 | 查询不只取最后一句；保持当前话题、限制关联扩展 | Task 1/2/5：当前行动、已有 dialogueFocus、活跃 Thread、近期原文及摘要引用参与查询；只做一次有上限的旧事补充，不实现世界书规则引擎 |
| [Entity/WorldState/Memory](../../设想/AI_RPG_Entity_WorldState_Memory_Architecture.md) §10–18 | 当前状态与历史分离；多路 Entity 召回；Entity→模型可见投影 | P1 已有 Entity/History/Thread，P2 Task 1/2/5 按正式 ID 读取当前状态和最小实体卡；回忆“以前给过我信”不能恢复旧持有者或把已离开的 NPC 当作在场 |
| 同上 §21、§24、§33 | 稳定身份、别名消歧、保留历史引用；不把整个 WorldState 交给模型 | Task 1/2：复用现有 ID/alias/lifecycle，不因代词或旧称创建分身；不增加动态组件、实体识别模型或软删除系统 |
| [四类信息维护](../../设想/AI_RPG_information_memory_context_spec.md) §3、§5–7 | 原文保留、50/10 覆盖水位、摘要引用→当前 Entity→有限旧原文 | Task 1–5：明确补齐这条闭环；摘要不是只供阅读的一段概览，压缩掉的具体旧话仍有可达路径 |
| 同上 §9–10；ST §5/§15 | 角色自知与本次披露分开，历史和派生记忆分开，维护不污染正式提交 | Task 2/4/5：各 observer 独立记忆包、摘要缓存独立版本；避免秘密传播和缓存覆盖玩家行动 |

**不照搬的部分：** ST 的概率激活、任意 depth/脚本、完整 Lorebook/Data Bank/角色卡导入和向量库；Entity 设想的任意字段/组件扩展、生成后再提取并改写已展示事实；四类信息设想的固定四次生成、自由输入必经额外意图模型和生产文本回退。P2 保留现有整场作者、规则与审批边界，不增加这些系统。

**明确的取舍：** 借用“滚动摘要的覆盖与恢复”语义，首版采用带来源的完整摘录选编，不照搬“上一版自由摘要再压缩”的实现；借用“持续激活”语义，只复用 dialogueFocus/活跃 Thread，不另建 sticky/cooldown/delay 计时器。只有 Task 6/7 证明回忆、动机衔接或完整故事有收益，才算本期借鉴有效。

## 共享契约与实现布局

代码路径均相对仓库根；新增文件在所属 Task 创建。domain 只放纯类型/解析；application 调 gameplay 只走各子系统 `index.ts`。新增函数的输入不读取全局环境、时间或随机数；hash/IO/时钟在 server 注入。每个 Task 完成相关测试、typecheck、boundaries 与一次限定文件提交。

| 责任 | 新增位置 | 复用位置 |
| --- | --- | --- |
| observer 来源投影与检索 | `src/game/gameplay/rpg/narrativeMemory/projectObserverEvidence.ts` | `retrieveStoryEvidence.ts`、`retrieveNarrativeMemory.ts`、`renderNarrativeMemory.ts` |
| 记忆包 | `src/game/domain/narrativeMemoryContext.ts`、`src/game/gameplay/rpg/narrativeMemory/buildNarrativeMemoryContext.ts` | bundle context、NPC projection、现有 Context Compiler |
| 摘要格式与纯调度 | `src/game/domain/narrativeMemorySummary.ts`、`src/game/gameplay/rpg/narrativeMemory/planMemorySummary.ts` | History sequence/segment 与现有 Event |
| 摘录选择 source | `src/game/application/narrativeMemorySummarySource.ts`、`src/game/application/server/ai/liveNarrativeMemorySummarySource.ts` | NarrativeRequestClient、AI 失败/审计接口 |
| 缓存端口/适配器 | `src/game/application/narrativeMemorySummaryRepository.ts`、`src/game/application/server/persistence/sqliteNarrativeMemorySummaryRepository.ts` | 现有 SqliteClient，独立表 |
| 准备与统一装配 | `src/game/application/prepareNarrativeMemory.ts` | generatePendingNarrativeBundle、compositionRoot、existing sources/reviewer |
| 验证驱动 | `src/game/application/testing/narrativeP2Journey.ts`、`scripts/narrativeP2Journey.mjs` | P1 传输磁带、identity/domainTime、真实 read model 选择 |

## Task 1：修正召回入口与必需证据传递

**阅读：** 总 Spec §4–5；[连续性与记忆](../../agent/剧情连续性与结构化记忆.md)、[NPC 系统](../../agent/NPC人格知识与关系图.md)、[开发规范](../../游戏开发规范.md)。

**Files:**

- Create: `src/game/gameplay/rpg/narrativeMemory/projectObserverEvidence.ts`、对应 `.test.ts`。
- Modify: `src/game/gameplay/rpg/narrativeMemory/retrieveStoryEvidence.ts`、`retrieveNarrativeMemory.ts`、`renderNarrativeMemory.ts`、`index.ts` 及各自测试。
- Modify: `src/game/application/entityContextProjection.ts`、对应测试；Docs: 连续性与记忆。

**Interfaces:** 保留 `EvidenceQuery` 和 `EvidenceSelection` 的公开用途，增加可选的 `visibleEvidence: ObserverEvidence` 参数，使同一请求复用一次投影；另加 `contextEntityIds?: readonly EntityId[]`、`contextEventIds?: readonly EventId[]`，接收有来源的摘要/近期上下文线索，以及 `presentHistoryIds?: readonly string[]`，供可选补充排除当前包已有原文。它们与 actionEntityIds 的当前规则硬引用分开；出现于摘要不代表当前相关，更不代表授知。presentHistoryIds 只影响可选名额/去重，不能删除显式追问或承诺所需来源及其 mandatory 理由。新函数：

```ts
type ObserverEvidence = Readonly<{
  observerId: EntityId;
  history: readonly HistoryEntry[];
  events: readonly CommittedNarrativeEvent[];
  knownEntityIds: readonly EntityId[];
}>;
function projectObserverEvidence(input: {
  worldState: WorldState; storyState: StoryState; observerId: EntityId;
}): ObserverEvidence;
```

以上类型导出于新 gameplay 文件，经 facade 消费；现有 domain 类型分别从 entity、narrativeHistory、events、worldState、storyState 导入。`ObserverEvidence.events` 是历史证据投影，不等于该 NPC 的 outward allowedEventIds。当前动作规则闭包仍独立传递，不能因历史不可见删除合法当前规则。

- [ ] 在既有测试工厂基础上写 RED：未选 `shown_choice` 独有的人名/事件不影响候选；未知 NPC 的 core.name 和私密 alias 不向 observer 返回；同名候选不合并；只有当前交谈 NPC 并不足以消除问题中旧人的歧义。
- [ ] 写长间隔 RED：目标旧事件后再加入 12 个不同已提交 episode，maxEpisodes=0；活跃 Thread/Promise 或明确旧人追问所需 event 和对应 npc_line 仍在 required 输出。比较当前代码的缺失行为，不把手填 historyIds 当召回完成。
- [ ] 运行 `npx vitest run src/game/gameplay/rpg/narrativeMemory --minWorkers=1 --maxWorkers=2`，确认新增断言因旧逻辑失败。
- [ ] 实现投影先于匹配：可见原文限实际 audience/speaker，并排除 shown_choice；实体名字只在已观察/交互、可知事实或已授权历史中有依据时成为名称入口。事件含秘密事实时按 observer 当前知识和实际来源筛选；不能安全呈现的整个事件不进入历史原文包，当前规则仍可另给获准结构投影，不能以“该事件有一条可见旁白”直接授权全部 payload。名称防撞表仍仅用于创建约束，不能成为记忆知识源。
- [ ] 对显式旧事、活跃承诺、持续焦点建立 event→History 反向索引；优先精确问句匹配和相关证据，不把某 NPC 最后八条事件当全部历史。可选补充默认每实体 3 条、合计 10 条，相关实体/因果最多一跳；mandatory 不受这些数量上限裁掉。
- [ ] contextEntityIds/contextEventIds 经同一 observer 来源校验后作为低于显式问题和活跃 Thread 的候选；按实体轮流填充可选旧记录，排除已在 uncovered/概览中的原文，防止高频地点占满十条。关联索引复用已存在的 History.entityIds、Event.actorIds/targetIds/locationId，不额外调模型识别人名或关系。补充结果中的新实体只附最小当前卡片，不再触发下一轮旧史搜索。
- [ ] `retrieveNarrativeMemory` 显式合并 manifest 中必需的 event，不再只作为 cause 参与 episode 排序：

```ts
const mandatoryRefs = new Set(storyEvidence.manifest
  .filter(ref => ref.mandatory).map(ref => ref.ref));
const requiredEventIds = [...new Set([
  ...(query.requiredEventIds ?? []),
  ...storyEvidence.eventIds.filter(id => mandatoryRefs.has(String(id))),
])];
```

实际实现位于既有函数，不能新增第二套检索入口；补回相关原话时继续检查 observer，不能直接展开事件的所有听众记录。render 的 manifest 只包含实际渲染项，shown_choice 不残留在 refs 中。
- [ ] 运行 memory、entityContextProjection 测试、typecheck/boundaries；文档仅更新实际生效的检索契约；提交 `fix: preserve authorized historical evidence through retrieval`。

**验收：** 相关旧事件及原话不再因 episode 上限丢失；名字、摘要或未选项不能产生知识授权。

## Task 2：统一作者与 NPC 的历史记忆包

**阅读：** 总 Spec §5、§7；[运行时 AI](../../agent/运行时AI导演与场景表演.md)、NPC 系统。

**Files:**

- Create: `src/game/domain/narrativeMemoryContext.ts`；`src/game/gameplay/rpg/narrativeMemory/buildNarrativeMemoryContext.ts`、对应 `.test.ts`。
- Modify: `src/game/gameplay/rpg/narrativeMemory/index.ts`、`src/game/application/projectNpcDeliberation.ts`、`src/game/application/prepareNpcNarrativeContext.ts` 及其测试、`src/game/application/narrativeBundleSource.ts`。
- Modify: `src/game/application/entityContextProjection.ts` 及其测试，接入已验证的记忆实体引用。
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`、`src/game/application/server/ai/liveNarrativeCandidateReview.ts` 及上述相关测试。
- Create: `src/game/application/testing/narrativeMemoryContext.integration.test.ts`；Docs: 连续性与记忆、NPC 系统。

**Interfaces:** 新 domain 文件定义只读数据，源内容仍带类型和身份，不能转为无归属的字符串池：

```ts
type NarrativeMemoryContext = Readonly<{
  observerId: EntityId;
  coveredThroughSequence: number; // 无有效概览时为 -1，使用 History 游标
  overviewHistoryIds: readonly string[];
  overviewEventIds: readonly EventId[];
  uncovered: readonly HistoryEntry[];
  recalled: readonly HistoryEntry[];
  requiredEvents: readonly CommittedNarrativeEvent[];
  referencedEntityIds: readonly EntityId[];
  ambiguousEntityIds: readonly EntityId[];
  manifest: readonly { ref: string; reason: string; mandatory: boolean }[];
}>;
```

Task 2 的 `coveredThroughSequence=-1`、overviewHistoryIds/overviewEventIds 为空；Task 3–5 接入后由有效缓存决定。新 `buildNarrativeMemoryContext(input: { evidence: ObserverEvidence; selection: EvidenceSelection; coveredThroughSequence: number; overviewHistoryIds: readonly string[]; overviewEventIds: readonly EventId[] }): NarrativeMemoryContext` 验证所有引用属于 evidence，按 sequence 去重排序；它不调用模型、不写状态。overviewEventIds 单独渲染为带原事件时间的概要，不冒充本回合 requiredEvents。referencedEntityIds 从实际使用的原文/事件引用派生，与 observer.knownEntityIds 取交集；不能从自由摘要文本重新猜 ID。

- [ ] 写 RED：作者收到玩家可见的旧 NPC 原句；NPC 自知包只收到自己听见/说过的旧表达；另一 NPC 不知。玩家选择 label 被保留为 action expression，不能以 NPC 亲闻原话的身份跨回合传入。当前 `currentNpcPlayerExpressions` 的本轮特例保持明确。
- [ ] 用完整 `projectNpcDeliberation` 与真实 bundle prompt 构造测试检查实际输入；不能仅断言 build helper 返回字符串。运行上述 integration、projectNpcDeliberation、bundle context tests。
- [ ] 实现同一记忆包的两个 observer 投影；作者用 player，单 NPC 用自身。所有未覆盖、已提交且可见原文都进入 uncovered，不以“近期四场结构卡”替代。回忆条目标记原 speaker/kind/turn，旧物品归属或旧承诺状态标为当时记录，当前状态仍由 Entity 单独注入。
- [ ] 接入 NarrativeBundleSourceContext 的 `memoryContext?: NarrativeMemoryContext`，此字段只允许 player 包；NPC projection 的同名可选输入只允许对应 npcId 的包。扩展 `prepareNpcNarrativeContext(context, source, privateMemory?: NarrativeMemoryContext)`，第三参由应用编排局部持有，只传给 `projectNpcDeliberation`，不得展开进返回的公共 context；返回作者的仍只有经既有授权校验的 npcOutward。observer 不匹配时明确拒绝，不能退回公共包。Task 5 完成装配后生产必须传入，现有纯 fixture 可显式使用源状态构造。reviewer 看同版作者包及自己的规则投影，不能从别的 observer 私密记忆推断可公开内容。
- [ ] 在 `prepareNpcNarrativeContext.ts` 抽取共用纯函数 `selectNpcDeliberationTarget(context: NarrativeBundleSourceContext): EntityId | undefined`，原样复用现有 decision/focus/在场/active/greetingOnly/needsJudgment 条件，给 Task 5 的私密记忆准备和本函数使用。最多仍判断一个 NPC，不复制两套选择条件，不借记忆接入扩大判断触发范围。
- [ ] 将 manifest 的 mandatory 映射为独立 ContextBlock；所有 uncovered 为 mandatory，recalled 依据来源区分；有歧义时给候选及证据，不自动把当前焦点作为过去行为人。旧原话进入 NPC 私密判断并不扩大 `npcSpeechAuthority` 的 outward 授权集合。
- [ ] `buildEntityContextProjection` 增加 `memoryEntityIds?: readonly EntityId[]`，消费上述已验证引用，按当前 EntityStore 生成最小相关卡片；复用既有字段可见性和可选实体上限，不把整份 NPC knowledge/JSON 注入作者。旧回忆中的位置、owner、承诺状态仍是历史，当前卡片才说明现在状态；停用/离场实体可被回忆，不自动获得在场或可交互资格。
- [ ] 检验来源状态在构造前后完全不变：

```ts
expect(packet.uncovered.map(entry => entry.id)).toEqual(visibleSourceIds);
expect(npcPacket.uncovered.some(entry => entry.id === playerOnlyHistoryId)).toBe(false);
expect(after.worldState).toEqual(before.worldState);
expect(after.storyState).toEqual(before.storyState);
```

`before/after` 为 integration 工厂中同一实际 GameRecord 的输入/返回快照，两个 ID 来自 fixture 实际 History。把同一用例做 SQLite 关闭重开后再次构造，不能仅比较进程缓存。
- [ ] 通过相关测试、typecheck/boundaries；更新文档并提交 `feat: provide source-linked memory to scene and npc contexts`。

**P2-A gate：** 已有能力可准确使用旧原话；没有摘要也能完成正式短故事的上下文构造。若原文误授知或 mandatory 丢失，不能进入摘要建设。

## Task 3：50/10 分批摘要与从原始来源重建的概览

**阅读：** 总 Spec §5.5；[四类信息设想](../../设想/AI_RPG_information_memory_context_spec.md)的覆盖水位/失败语义；共享模块流程只按 AI 公开 API 消费。

**Files:**

- Create: `src/game/domain/narrativeMemorySummary.ts`、对应 `.test.ts`；`src/game/gameplay/rpg/narrativeMemory/planMemorySummary.ts`、对应 `.test.ts`。
- Create: `src/game/application/narrativeMemorySummarySource.ts`、`src/game/application/server/ai/liveNarrativeMemorySummarySource.ts`、对应 `.test.ts`。
- Modify: `src/game/gameplay/rpg/narrativeMemory/index.ts`、`src/game/application/server/ai/narrativeRequestClient.ts`、`textAuditTypes.ts` 与相关请求/审计测试。
- Docs: 连续性与记忆；本 Task 只实现纯调度与 source，Task 4 才持久化。

**明确的摘要定义：** P2 首版为“模型选编、服务端取原文”的摘录摘要，不让模型改写历史。叶摘要选完整 HistoryEntry/已有 Event 引用；概览从所有当前有效叶摘要的原始来源重新选编，不能反复压缩上一版概览。可以遗失非关键细节，不能伪造句子、删去一句内部的否定或把计划转为事实；需要细节时仍检索完整原文。此取舍已在总 Spec §5.5 固定。

```ts
type MemorySummarySelection = Readonly<{
  historyIds: readonly string[];
  eventIds: readonly EventId[];
}>;
type MemorySummaryBatch = Readonly<{
  id: string;
  fromSequence: number;
  throughSequence: number;
  sourceHistoryIds: readonly string[];
  sourceFingerprint: string;
  selection: MemorySummarySelection;
}>;
type MemorySummaryState = Readonly<{
  formatVersion: 1;
  observerId: EntityId;
  policyVersion: "memory-p2/1";
  summaryRevision: number;
  coveredThroughSequence: number;
  coveredSourceFingerprint: string;
  batches: readonly MemorySummaryBatch[];
  overview: MemorySummarySelection;
}>;
```

类型位于新 domain 文件；`parseMemorySummaryState(value: unknown)` 返回 `{ok:true,value:MemorySummaryState}|{ok:false,code:string,path:string}`。完整 selection ID 集合经源校验，缓存不保存模型杜撰的正文；提到的 Entity 引用从实际选中 History/Event 中派生，不能沿用旧概览全部实体。

**Interfaces:** `planMemorySummary(input: { evidence: ObserverEvidence; previous: MemorySummaryState | null; forceForLength: boolean }): { kind:"none" } | { kind:"batch"; sourceHistoryIds:readonly string[]; throughSequence:number }`。`NarrativeMemorySummarySource.select(input: { kind:"batch"|"overview"; observerId:EntityId; history:readonly HistoryEntry[]; events:readonly CommittedNarrativeEvent[]; signal:AbortSignal; reserveHttpAttempt:()=>Promise<boolean> }): Promise<{ok:true;selection:MemorySummarySelection}|AiSourceFailure>`，失败复用 application 的 AiSourceFailure，不创建另一套无限修复机制。

- [ ] 写 RED：可见且非 shown_choice 的未覆盖原文数量 49 不触发、50 选最早 10、下一条不再触发、到 60 再选 10。History 从 sequence=0 开始，所以连续样例第一次水位是 **9**，不是 10；与 Event sequence/turn/revision 无关。
- [ ] 补不同 observer、隐藏条目/展示选项造成非连续 sequence、A 已提交 B pending、战斗回滚、重复 ID、不同文本同 ID 的拒绝/失效测试。阈值数的是可见有效 History 条目，不能用全局序号差代替数量。当前 job 新输入始终保留原文，不放入本次待压缩的旧批。
- [ ] 运行 summary domain、planner、source tests RED。实现 planner：未覆盖 ≥50 选最早 10；forceForLength 时仅在至少有 10 条可压缩旧原文时提前选一批。输出水位为该批最后一条实际 History.sequence，跳过的不可见/展示记录不进入模型。
- [ ] live source 使用已有 narrative_bundle role，RPG purpose 增加 `memory_summary`；每批最多一次选择请求，每个概览最多一次请求，各最多 2 次传输。沿现有 thinking=on、reasoningEffort=low、timeout=240000、prompt_only、无 maxTokens 的策略；预算另由 Task 5 限制，不设额外 reviewer。
- [ ] 叶摘要最多选择 **4 条完整原文、4 个相关事件**；概览最多 **8 条完整原文、8 个事件**。selection 不接受 text、状态 delta 或新 ID：

```ts
expect(parseSelection({ historyIds: ["invented"], eventIds: [] }, sources).ok).toBe(false);
expect(parseSelection({ historyIds: [knownId], eventIds: [], text: "已经交付" }, sources).ok).toBe(false);
expect(renderedSelectedText).toBe(sourceEntry.text);
```

`parseSelection(value: unknown, sources: {history:readonly HistoryEntry[];events:readonly CommittedNarrativeEvent[]}): {ok:true,selection:MemorySummarySelection}|{ok:false,code:string,path:string}` 由同一 domain 文件提供；至少一个合法引用，去重、数量和 source 范围严格检查。原句过长不能截去条件，把该摘要判为长度不合格并保留原文读取。
- [ ] 概览输入来自全部有效叶 selection 对应的原始完整记录，而非上次概览；新增批摘要与新概览都通过源/长度校验才一起成为新的有效 state。概览失败则保留旧水位；本次不做内容自动修订，也不把新批标已覆盖。下次合法准备可重新选择，但仍受 Task 5 的同 job/epoch 持久预算限制。概览源超出单请求长度上限时同样失败保留原文，不偷偷递归压缩到丢失来源。
- [ ] 通过 summary/request/audit 测试、typecheck/boundaries；更新文档并提交 `feat: select traceable batch summaries without rewriting history`。

**验收：** 摘录内容可逐字追溯；50/10 与失败水位明确，原文未删除，旧世界状态不升级为当前事实。

## Task 4：独立缓存的原子发布、竞争与失效

**阅读：** 总 Spec §8；[实体状态](../../agent/实体与组件世界状态.md)、开发规范的 SQLite/CAS 契约。

**Files:**

- Create: `src/game/application/narrativeMemorySummaryRepository.ts`、`src/game/application/server/persistence/sqliteNarrativeMemorySummaryRepository.ts`、对应 `.test.ts`。
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts` 的初始化/清档部分及测试；`src/game/application/server/compositionRoot.ts` 的 cache 注入与 close 生命周期。
- Docs: 连续性与记忆、实体状态（派生缓存与正式存档边界）。

**Interfaces:** 新端口以既有 GameId/GenerationId 和 observerId 定位独立缓存：

```ts
type MemorySummaryKey = Readonly<{
  gameId: GameId; generationId: GenerationId; observerId: EntityId;
}>;
interface NarrativeMemorySummaryRepository {
  load(key: MemorySummaryKey): Promise<{
    state: MemorySummaryState | null; summaryRevision: number;
  }>;
  publish(input: { key:MemorySummaryKey; expectedSummaryRevision:number;
    next:MemorySummaryState }): Promise<
      {ok:true} | {ok:false;code:"STALE_SUMMARY"|"SOURCE_CHANGED"|"UNAVAILABLE"}
    >;
}
```

GameId 来自既有 repository 端口，GenerationId 来自 domain/worldEntity；`expectedSummaryRevision=0` 表示期望无缓存。load 即使返回 state=null 也保留独立表头的真实 revision，避免损坏缓存一直插入冲突而无法重建。有效 state 的 summaryRevision 必须与表头一致。hash 是 server 对排序稳定的原始来源/权限策略计算的 SHA-256，不能对概览文本单独哈希。publish 在同一短 transaction 内读取当前真实游戏、重建 observer 的已覆盖来源，校验指纹与 summaryRevision，再写缓存。

- [ ] 写 RED：摘要写入不变更 GameRecord/revision/choice token；两个 writer 仅一个成功；摘要计算期间 B 新增尾部原文不妨碍仍有效的旧前缀发布；回滚/换局/源指纹变化拒绝写入。
- [ ] 运行新 SQLite 测试。实现独立 `narrative_memory_summaries` 表，键为 `(game_id,generation_id,observer_id,policy_version)`，存 format_version、summary_revision、covered_through_sequence、source_fingerprint、state_json。SQL 只通过现有 SqliteClient，禁止新增 node:sqlite 直连或原生驱动。
- [ ] 不用 `GameRepository.applyState({...旧 WorldState,...旧 StoryState})` 保存缓存，不靠保持 revision 的整份状态覆盖：

```sql
UPDATE narrative_memory_summaries
SET summary_revision = ?, covered_through_sequence = ?, source_fingerprint = ?, state_json = ?
WHERE game_id = ? AND generation_id = ? AND observer_id = ?
  AND policy_version = ? AND summary_revision = ?
```

首次插入依赖唯一键并按冲突返回 STALE_SUMMARY；源校验与这条 SQL 在同一个 transaction。锁内不能调用 AI。缓存 revision 只能 +1。有效同源缓存的水位只能推进；旧缓存已因回滚或损坏失效时，可按当前来源重建较短覆盖，但仍以旧表头 revision 做 CAS，不能让晚到 writer 覆盖重建结果。
- [ ] 缓存读到 format 不支持、源不匹配或损坏 JSON 时返回 cache miss 并记录稳定原因，不能令合法正式存档 corrupt。读取前重新投影权限，旧 observer 缓存不得借改 key 给另一 NPC。BattleStartSnapshot 不新增 cache：恢复后以当前来源指纹失效；序号相同而内容不同也必须失效。
- [ ] 清档/重新创建只清对应 game 的派生缓存；不可删除数据库/其他存档。正式 Story12 读写与 P1 磁带语义不变。cache missing 允许重建，不允许伪造覆盖水位。
- [ ] 测试 SQLite 重开、原子发布失败、并发 A/B 与缓存、旧分支回滚、清档后新 generation；typecheck/boundaries 通过后更新文档并提交 `feat: persist narrative summaries outside gameplay revisions`。

**验收：** 摘要完成不会让屏幕上的按钮过期，也不能覆盖玩家已经执行的动作。

## Task 5：统一准备、长度边界与摘要失败无断档

**阅读：** 总 Spec §5.5/§8；运行时 AI、[AI 环境](../../agent/AI环境.md)、[AI 文本审计](../../agent/AI文本审计.md)。

**Files:**

- Create: `src/game/application/prepareNarrativeMemory.ts`、对应 `.test.ts`；`src/game/application/server/ai/narrativeMemoryPolicy.ts`、对应 `.test.ts`。
- Modify: `src/game/application/generatePendingNarrativeBundle.ts`、`prepareNpcNarrativeContext.ts`、`projectNpcDeliberation.ts`、`narrativeBundleSource.ts` 及相关测试、`src/game/application/server/compositionRoot.ts`。
- Modify: Task 4 的 `narrativeMemorySummaryRepository.ts`、`sqliteNarrativeMemorySummaryRepository.ts` 及 SQLite 初始化/清档和相关测试，保存本 Task 的尝试预算及固定准备结果。
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`、`liveNarrativeBundleSource.ts`、`liveNarrativeCandidateReview.ts`、`liveNpcDeliberationSource.ts`、`narrativeRequestClient.ts` 与相应测试。
- Modify: `.env.example`（本 Task 的非秘密配置说明）；Docs: 连续性与记忆、运行时 AI、AI 环境、AI 文本审计。

**Interfaces:** `prepareNarrativeMemory(input: { record:GameRecord; observerId:EntityId; job:PendingNarrativeJob; source:NarrativeMemorySummarySource; repository:NarrativeMemorySummaryRepository; policy:NarrativeMemoryPolicy; summaries:"enabled"|"disabled"; signal:AbortSignal; reserveBatchUpdate:()=>Promise<boolean>; reserveSummaryHttpAttempt:()=>Promise<boolean> }): Promise<{ok:true;context:NarrativeMemoryContext}|{ok:false;code:"MEMORY_CONTEXT_OVERFLOW"|"CANCELLED"}>`。这是单 observer 的构造函数；跨 observer 的固定与恢复由 generator 编排负责。`NarrativeMemoryPolicy` 类型在 `domain/narrativeMemoryContext.ts` 增加，字段为 `threshold`、`batchSize`、`rawSoftEstimatedTokens`、`summarySourceMaxEstimatedTokens`、`overviewMaxEstimatedTokens`、`promptMaxEstimatedTokens`，均为 number；server policy 文件负责默认值、环境校验与注入，application 不反向 import server。

**尝试持久契约：** 在 Task 4 的同一端口增加下列类型/方法；`NarrativeJobAttemptPredicate` 复用现有 repository 类型，避免另造一套租约状态。固定包是生成尝试的派生输入，不是新的剧情事实表：

```ts
type MemoryAttemptKey = Readonly<{
  gameId: GameId; generationId: GenerationId;
  jobId: NarrativeJobId; epoch: number;
}>;
type MemoryAttemptGuard = Readonly<{
  key: MemoryAttemptKey; expectedRevision: number;
  expectedNarrativeJob: NarrativeJobAttemptPredicate; now: string;
}>;
type PreparedNarrativeMemory = Readonly<{
  formatVersion: 1; policyVersion: "memory-p2/1";
  sourceFingerprint: string; policy: NarrativeMemoryPolicy;
  summaries: "enabled" | "disabled";
  player: NarrativeMemoryContext; npc?: NarrativeMemoryContext;
}>;
// NarrativeMemorySummaryRepository 的新增方法：
loadPrepared(key: MemoryAttemptKey): Promise<
  {ok:true; prepared:PreparedNarrativeMemory|null; preparedHash:string|null}
  | {ok:false; code:"MEMORY_PREPARATION_INVALID"|"UNAVAILABLE"}
>;
freezePrepared(input: MemoryAttemptGuard & {next:PreparedNarrativeMemory}): Promise<
  {ok:true; prepared:PreparedNarrativeMemory; preparedHash:string}
  | {ok:false; code:"STALE_ATTEMPT"|"MEMORY_PREPARATION_INVALID"|"UNAVAILABLE"}
>;
reserveBatchUpdate(input: MemoryAttemptGuard): Promise<MemoryReservationResult>;
reserveHttpAttempt(input: MemoryAttemptGuard): Promise<MemoryReservationResult>;
type MemoryReservationResult =
  | {ok:true}
  | {ok:false; code:"BUDGET_EXHAUSTED"|"STALE_ATTEMPT"|"UNAVAILABLE"};
```

`preparedHash` 为 server 对完整固定包稳定序列化计算的 SHA-256。`sourceFingerprint` 覆盖该 job 的行动输入及构造所依赖的原文、事件、实体当前状态/权限、活跃 Thread；不包含会随候选、HTTP、续租变化的 attempt 字段或可独立推进的摘要缓存版本。load/freeze 均读真实源校验引用/正文/权限与指纹。freeze 在校验当前租约的短事务内首次写入，已固定则返回原包，不能覆盖；调用方必须使用返回包。来源改变、包损坏或策略不兼容均显式终止本次尝试，不准换包继续。

长度政策导出 `NarrativeMemoryPolicy`，初始值固定：阈值50/批10、旧原文软阈值 **24000 estimated tokens**、summary 单次源输入最多 **24000**、概览渲染最多 **6000**、完整 provider 请求硬阈值 **64000**。统一使用现有 `estimateNarrativeTokens`；硬阈值包括系统规则、修订前稿及 reviewer 的候选正文。`AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS` 可覆盖硬阈值为正整数；其他初值通过 server policy 注入。register 必须冻结值及模型已知输入能力，估算不是 provider 精确 tokenizer 或输出容量保证，不沿用 P1 的无限值，也不恢复未经验证的 8000 限制。

- [ ] 写 RED：摘要超时/非法引用/概览失败时水位不动，全部未覆盖可见原文仍在请求里；50条后失败，到61条不得只发最后50条。超过硬预算时零 author HTTP、明确失败，A 的行动不重复结算。
- [ ] 写 preparation 与真实 requestClient/generator 集成测试：同一 job 三版候选使用同一记忆快照；首版后崩溃→SQLite 重开→同 epoch 新租约继续第二版时 preparedHash、player/NPC 包均不变，即使 observer 摘要缓存已推进也不再准备。同一 worker 的角色 outward 成功缓存仍复用，不因摘要修订重复判断；跨 worker 仍沿既有角色判断恢复语义，不在 P2 另造 outward 持久缓存。
- [ ] 从真实 `generatePendingNarrativeBundle` 入口捕获 NPC 与 author 的最终请求：玩家可见旧话进入作者，对应 NPC 私密旧话进入其判断，私密包不进入作者/reviewer，也不传给另一 NPC。仅测 projection helper 不足以通过本项。generator 通过 Task 2 共用 selector 确定 NPC，局部持有并以第三参传入桥接；公共 context.memoryContext 始终为固定 player 包。
- [ ] 在取得既有 narrative job 租约后、角色判断和候选预留/循环前，先 loadPrepared；有合法固定包则直接恢复，不再推进摘要。无固定包且该 epoch 尚未预留任何候选时才依次准备 player/所需 NPC，再一次性 freezePrepared，成功后才允许角色/作者请求；准备中崩溃可在持久预算剩余额度内重建。已有候选但固定包丢失、源失效或冻结失败时显式失败，不改用最新缓存，A 不重复结算。既有续租心跳/AbortSignal 覆盖整个准备与冻结过程；guard 从最新 durableRecord 构造，不能使用已过期的候选谓词。
- [ ] P2 采用请求内有界维护，不新建后台常驻服务或额外 gameplay provider 触发点。未触发生成的移动/物品消费不为摘要调用网络；下次合法生成入口再追赶。compositionRoot 的测试/实验 options 增加 `memorySummaries?:"enabled"|"disabled"`、`memoryPolicy?:NarrativeMemoryPolicy`，生产默认 enabled；disabled 不读/写/生成 observer 摘要，读取全部可见原文，仍使用同一尝试冻结、检索/权限与长度检查，不成为另一个生成实现。同 epoch 不切换模式或政策；实验两臂从 ready 状态经新行动创建各自 job。
- [ ] 准备顺序固定为：observer 来源投影→校验/有界更新摘要→取得有效概览及 uncovered→收集这些记录已有 Entity/Event ID、当前行动/地点/焦点、活跃任务/Thread 引用→一次 retrieveStoryEvidence→当前实体卡与记忆包。全部可见 uncovered 引用可进入候选，近两场引用仅作排序加权；只有实际选中概览的引用参与，不累积被概览遗弃的旧 ID。软候选沿 Task 1 数量/长度约束进入上下文，不能一律标 mandatory 或递归膨胀。
- [ ] 每 job/epoch 给所有 observer 合计最多 **8 次摘要 HTTP**，最多尝试 **2 个批次更新**（每次叶+概览、每请求最多2次传输）；先 player，再当前需要判断的 NPC。其余保留原文，不延迟到无上限队列。原 author/NPC/review **24 HTTP/epoch、3候选**保持，P2 总上限明确为 **32 HTTP/epoch**；所有用途还共同受实验批预算。独立 `narrative_memory_attempts` 表以 MemoryAttemptKey 为键保存 http_attempts、batch_updates、prepared_json、prepared_hash；批开始前和每次 HTTP 发送前分别原子预留，失败或崩溃不退额度，接管不得重置。不能挪用叙事额度后声称24次包含全部调用。
- [ ] 预留/冻结事务读取真实 game_records，核对 generation、revision、provider_pending、job/epoch、非空 leaseId、完整 expectedNarrativeJob 与未过期租约；检查成功才改独立行，已固定时拒绝新的摘要维护预留。接管旧 worker 即使 epoch 相同也必须返回 STALE_ATTEMPT，零后续 HTTP、计数不增长。repository 保留结构化失败原因，generator 适配为 source 所需 boolean callback：仅 BUDGET_EXHAUSTED 可返回 false 后继续真实原文路径；STALE_ATTEMPT/UNAVAILABLE 在局部记录原因并 abort 当前尝试，再返回 false，不能作为可继续的摘要失败。freeze 错误同样映射现有生成失败出口并保留稳定原因，不能重跑 A。补三种拒绝原因的集成断言；派生 observer 缓存的 publish 仍按 Task 4 的源/CAS 校验，不能把它与发送授权混成同一条件。
- [ ] 固定包与计数一起遵循清档/换 generation/关闭策略，保存于正式数据库但不进入权威 Story schema、BattleStartSnapshot 或普通日志。测试并发额度、同 epoch 接管、冻结前后崩溃、固定记录损坏/丢失、来源变化、SQLite 重开与换局隔离；尝试数据丢失不能被解释为恢复候选时可以重置预算。
- [ ] preparation 超时/额度耗尽后若原文可装入完整预算，继续用旧有效概览+全部 uncovered；这是读取真实来源，不是确定性剧情回退。若仍装不入，沿同一 job 显式失败，允许用户重试，不能切掉 mandatory：

```ts
const uncovered = evidence.history.filter(entry =>
  entry.sequence > validSummary.coveredThroughSequence);
expect(uncovered.map(entry => entry.id)).toEqual(allUncoveredVisibleIds);
expect(recordAfter.storyState.history).toEqual(recordBefore.storyState.history);
```

缓存不存在/失效时 `validSummary.coveredThroughSequence=-1`。当前输入、活跃 Thread/Promise 证据、精确追问来源即使已被摘要覆盖仍作为原始引用补回；不存在 source 的概要不得参与构造。
- [ ] 完整 prompt 编译后检查 overflow 并在 provider 请求前拒绝；compiler 原有“保留 mandatory”的语义不改，optional 可按既有次序移除且记录 manifest。如果只一条原文就过长，不自动截断/续写，返回明确长度错误。
- [ ] 扩展 source/review 的审计上下文记录 source 指纹、preparedHash、overview/批 ID、覆盖水位、raw/recall 数量、估计长度与失败原因；原文进入专用审计，不写普通日志。transport 磁带同时包含摘要用途，请求顺序受 preparation 冻结，replay 不启动隐形后台维护。
- [ ] 运行 preparation、generator、NPC、review、composition/SQLite/request tests、typecheck/boundaries；更新系统文档和环境说明，提交 `feat: prepare bounded narrative memory without history gaps`。

**P2-B gate：** 摘要成功、失败、关闭、缓存丢失、并发和重启均可解释；没有合法来源被静默漏掉，所有维护请求可计数回放。

## Task 6：正式中篇离线旅程与新的验证协议

**阅读：** 总 Spec §9–11；[无 AI 验收](../../agent/无AI试玩验收.md)、P1 最新恢复/退出协议。fixture 只证明链路，不证明 live 质量。

**Files:**

- Create: `src/game/application/testing/narrativeP2Journey.ts`、`narrativeP2Journey.test.ts`、`narrativeP2Journey.testutil.ts`。
- Create: `scripts/narrativeP2Journey.mjs`、`scripts/narrativeP2Journey.node-test.mjs`。
- Modify: `package.json`；可从 `scripts/narrativeP1Journey.mjs` 抽出不改变 P1 行为的正式驱动 helper，复用 `narrativeP1Replay.mjs` 的底层 transport tape，不复制一套审批/规则。
- Create: `docs/superpowers/reports/2026-09-14-narrative-p2-protocol.md`（实施本 Task 时生成）；Docs: AI 环境新增 P2 入口。

**Interfaces:** `runNarrativeP2Journey(input: { mode:"register"|"live"|"replay"; runId:string; protocolPath:string; outputDirectory:string }): Promise<{plannedRoutes:2;completedRoutes:number;passed:boolean}>`。CLI 支持上述 mode/run-id/protocol/output、`--replay-source`；register 零网络、live 要求 `RUN_REAL_AI_JOURNEY=1`、replay 无 key 且零网络。P1 的 v3 协议及历史比较器保持原语义，P2 使用 `narrative-p2/v1`。

- [ ] 建立有界五幕递送 fixture source：正式 createGame→实际 read model/token→performTurn→ensure→SQLite；有效旧原文至少 **70 条**，目标引用至少落后当前 **两幕或8次有效动作**；至少两次50/10水位推进。通过有内容的合法互动达到，不重复空句或直接注入 History 过阈值。
- [ ] 在实际较后决策前输入对旧人的追问，确认旧原句在作者请求、所属 NPC 自知请求按权限出现；不同 NPC 不假称亲历。随后显式交付/终局，断言唯一 item_given、合法 owner、ending/ready 和终局正文；保留旧承诺已履行/已违背时当前状态不被旧句覆盖。
- [ ] 用记录的状态引用建立断言，不只写 helper 返回值：

```ts
const result = await runOfflineP2Story({ gameLength: "medium", summaries: "enabled" });
expect(result.completed).toBe(true);
expect(result.publishedSummaryRevisions).toBeGreaterThanOrEqual(2);
expect(result.oldQuoteInActualAuthorRequest).toBe(true);
expect(result.oldQuoteLeakedToUninformedNpc).toBe(false);
expect(result.itemGivenEventCount).toBe(1);
```

`runOfflineP2Story(input:{gameLength:"short"|"medium";summaries:"enabled"|"disabled"|"fail"})` 由新 testutil 导出，其 result 精确含上述五字段以及 `reloadEqual:boolean`；内部只走正式 API，可注入模型响应但不能为结局修改状态。
- [ ] 写摘要失败/缓存损坏/并发 late writer、回滚后相同 sequence 不同 source、reload/重复 ensure 的旅程变体。跨幕回忆覆盖与旧 `storyEvidenceJourney` 的单条手造原文测试分别报告。
- [ ] 增加“摘要保留地点引用但省去旧话”的低成本离线用例：当前输入仅为“接下来怎么办”，没有旧人姓名；有效概览引用既有破庙，按该 ID 召回已覆盖且被概览省去的相关原话，并读取破庙/说话人的当前卡片。该地点符合条件的旧记录不超过每实体上限，用来验证入口闭环，不声称任意细节必被想起。断言同一 History 不因概览、近期原文和召回多路命中重复出现；检索只一轮，未知人物/秘密不随引用自动授予。用真实 prepare→作者请求检查，不只断言构造了候选 ID。
- [ ] 注册两条新生产路线 **S-short、M-medium**，分别三幕/五幕，都是有公开依据的递送，不强制秘密或新增操作。固定 characterName=沈行、identity=受托递送书信的旅人、profile=愿意听取不同意见并记住先前约定、tags=[谨慎,守信]、gameType=wuxia、style=novel、intensity=normal；premise=“沿途数个聚落之间往来书信，人物各有立场，委托可由实际交付完成。”；opening=“我接受一封公开书信的递送委托。请明确委托人的理由与接收约定，沿途人物的不同意见应围绕这次递送；我会在后段回想早先的话，再决定完成交付。” 两路仅 gameLength 不同，不读历史开局 seed。
- [ ] 选择政策复用合法 Action/目标推进，不以 label 关键词猜 ID。中篇在第三幕或之后、仍未交付且已产生两次摘要时的首个合法 NPC 决策输入：“最初委托人对这封信说过什么？我想先回想原话，再决定是否交付。” 查询是谁、原话是什么以真实开局 History 为 oracle；不把期望原句注入玩家输入。触发条件始终没满足则记 coverage failure，不能为通过临时降低阈值或追加无意义动作。
- [ ] 预登记 **短篇24动作/200 HTTP/90分钟，中篇48动作/500 HTTP/180分钟**；包括初始化、摘要、角色、作者、review及所有传输尝试。每 epoch 24叙事+8摘要，三候选，正式批不自动执行耗尽后的手动 retry。失败保留分母，不另抽成功开局。两个模型及所有参数沿同一实际配置冻结，记录代码/配置/策略/输入/来源 hash。
- [ ] summary 摘录覆盖完成后、旧事追问前复制同一 ready SQLite 建立有/无摘要两臂诊断，均经正式动作输入同一追问；只改变 summary enabled/disabled，两臂规则、检索和权限相同。各最多一个生成 job、50 HTTP/45分钟，无后续循环采样；该诊断不增加“完成路线”分母，不称完整文本质量 A/B 结论。
- [ ] 新磁带记录缓存初态/发布结果、attempt 计数与固定包/哈希、所有 memory/author/NPC/review 请求、identity/domainTime、每次正式状态。replay 检查 prompt 哈希、响应完全消费、game状态、cache指纹/水位及 preparedHash 一致；重放逻辑尝试计数应一致，真实 HTTP 为零，两者分栏。恢复场景必须复现已固定包，不能再次请求摘要；包含原文的固定包按专用审计权限保存。不能删除摘要请求使磁带“匹配”。抽取 helper 的兼容验证用 P1 协议/磁带单元契约，保持其严格匹配规则。P2 已有意改变生产 prompt，不能要求旧 P1 live 磁带在新 prompt 下通过；完整旧故事回放只能在其对应冻结实现下进行，本 Plan 不另开该项实跑。
- [ ] 运行 node 脚本测试、离线P2旅程及 P1 协议/回放测试、typecheck/boundaries；更新协议并提交 `test: cover complete medium stories and traceable memory experiments`。

## Task 7：工程封板与 P2 判定（当前执行入口）

**Goal:** 按用户确认的工程范围，验证规则约束、正常召回、实际调用与上下文组装；不再以剧情评分、摘要使回答更精彩或与 main 的叙事比较阻塞 P2。

**Files:** 本 Plan、[记忆覆盖计划](2026-09-14-narrative-p2-memory-coverage.md)、总 Spec §11.3，以及 `docs/superpowers/reports/2026-09-15-narrative-p2-engineering-acceptance.md`。仅在发现程序缺陷时修改对应实现和同目录回归，不预设新增生产功能。

**Interfaces:** 消费现有 production request、SQLite、固定包、预算、来源投影与正式旅程测试；输出工程验收矩阵和验证结果，不新增 adapter、角色或运行平台。

### 验收边界

- 剧情五维评分、措辞、重复表达、模型是否充分发挥所给材料作为观察，不作为工程通过门槛。
- 漏送必需来源、错误知识投影、静默截断必要上下文、接受非法引用、重复结算、状态污染、过期写入和无界调用仍是程序缺陷，必须修复。
- 模型非法 ID 被拒绝、旧缓存与原文路径保留，属于正常失败处理；不要求模型永不犯错。
- 确定性离线 fixture 可以证明概览省略后召回和实际请求组装；真实调用证明正式适配与持久化可用。两类证据分别标注，不把 fixture 答复算作真实模型表现。
- 沿用真实摘要连续发布、两臂回放、实际 UI 回想/刷新/唯一交付/终局证据。不要求重新创建两条故事、严格逐字两臂因果实验或补建 UI transport 回放作为封板前置。
- 旧 v1/v2/v3 协议与失败记录保持原结论；新的工程范围完成不解锁旧质量 gate，也不改变旧 CLI 的冻结协议语义。
- 不修改 main、旧 staged、共享模块或 `current-phase.json`；本独立任务的工程结论不替换仓库另一条已配置阶段。

### 执行步骤

- [x] 原位更新本 Plan、覆盖计划和总 Spec 的 P2 工程边界，旧实验成绩保留在原报告。
- [x] 核查下表 M1–M7 的实现与测试断言，重点确认最终请求而非仅检索中间结果；未发现新增阻断缺陷，无需修改生产代码或新增测试。
- [x] 运行 `npm test -- --minWorkers=1 --maxWorkers=2`、`npm run typecheck`、`npm run lint`、`npm run test:narrative-p2-script`、`npm run check:docs`、`git diff --check`。全量 Vitest 已包含 boundaries，不重复跑同一套；无 production build 变更不额外 build。调用链未变，沿用已有真实调用证据。
- [x] 在[工程验收报告](../reports/2026-09-15-narrative-p2-engineering-acceptance.md)记录逐项证据与限制，工程范围满足完成定义；本轮只提交文档，不制造功能修改。

## 工程验收矩阵

| 编号 | 必须成立 | 主要代码/测试入口 |
| --- | --- | --- |
| M1 召回 | 人物/别名/事件描述/对话指代可找正确来源；概览省略的旧话进入最终作者请求 | `gameplay/rpg/narrativeMemory`、`narrativeP2Journey.integration.test.ts` |
| M2 权限 | 隐藏名字、私密听众、未选选项、未来续接不制造知识；当前 Entity 状态不被旧史覆盖 | `projectObserverEvidence`、`retrieveStoryEvidence`、`buildNarrativeMemoryContext` 及其测试 |
| M3 摘要 | 50/10有效记录；叶与概览同批发布；来源可追溯；失败旧水位和未覆盖原文保留 | `narrativeMemorySummary`、`prepareNarrativeMemory`、`liveNarrativeMemorySummarySource` |
| M4 请求 | 当前行动/约束/必要证据贯穿完整请求；optional 有界裁剪，mandatory 溢出在 HTTP 前明确失败 | `narrativeContext`、`narrativeRequestClient`、live source/review 测试 |
| M5 持久化 | 缓存独立于 gameplay revision；损坏/回滚/换局/并发不串史；过期 writer 不能发布 | `sqliteNarrativeMemorySummaryRepository.test.ts`、恢复回归 |
| M6 调用恢复 | 同 job/epoch 固定包；持久额度不重置；失效或缺包显式失败；A 不重复结算 | `generatePendingNarrativeBundle.test.ts`、SQLite attempt 测试、正式旅程 |
| M7 正式闭环 | 真实维护与调用可用；实际 UI 回想、刷新、正式唯一交付到合法终局 | [三项收尾报告](../reports/2026-09-15-narrative-p2-closeout.md)及其原始产物 |

代码路径均相对 `src/game/`，除已链接报告。M1–M6 的确定性回归与 M7 的真实证据组合验收，不要求单个随机故事证明所有边界。

**完成定义：** M1–M7 均有可重复的代码/测试或实跑证据，相关检查通过，没有已知阻断工程缺陷，即可认定 P2 工程完成。模型文学质量、回答充分性及收益比较留作观察，不宣称整个叙事架构已经优于 main。

**当前结论：P2 工程验收通过。** M1–M7 核查无已知阻断缺陷；2,956项Vitest及31项P2脚本测试通过，typecheck、lint、docs与diff检查通过，详见[工程验收报告](../reports/2026-09-15-narrative-p2-engineering-acceptance.md)。本次没有生产代码或调用链变化。历史 Task 1–6 的未勾选组合清单用于追溯原规划，不再单独驱动新的任务；旧质量分数与批次失败保持原结论，不代表模型文学质量或优于main已经通过。
