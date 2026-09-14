# 较长经历召回与完整中篇 P2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在正式短篇与五幕中篇中，让玩家准确回忆旧人旧话、NPC 按自己的经历回应，并验证带来源的摘要能保持连续性而不破坏规则、权限和恢复。

**Architecture:** 保留 P1 的唯一整场作者、角色判断、现有审阅、场景槽编译及 A/B 提交。先贯通原始证据的可见性与 mandatory 传递，再在独立派生缓存中实现分批摘录摘要/概览；所有消费者使用同一来源可追溯的记忆包，事实与当前状态始终回到 Entity/Event。

**Tech Stack:** TypeScript 5.8、Next.js Node runtime、Node.js ≥24.15.0 内置 SQLite、Vitest 3；复用 RPG 的 AI、审计与严格回放接口，不新增运行时依赖。

## Global Constraints

- 唯一总设计：[架构 Spec](../specs/2026-09-12-narrative-architecture-design.md)。范围及代码核查证据：[P2 范围核查](../reports/2026-09-14-narrative-p2-scope-review.md)。先读上述核查结论和本节，再按当前 Task 阅读对应章节。
- 从 `codex/narrative-architecture` / `.worktrees/narrative-architecture` 的 **dfb567b1** 继续；不重新从 main 建分支，不合并 main，不修改旧 staged，不改变 `current-phase.json`。本 Plan 是独立任务入口。
- P1 已满足收敛后的最小准入；旧保密/核验样本和未执行矩阵保持原结论。不重派 P1 建设任务、不以 P1 旧 Plan 未勾选的历史失败项阻止本 Plan。
- “质量与游戏性优先于 token、调用数和耗时。”摘要减少输入量只是观测指标；准确回忆、人物动机、真实后果和完整收束才是验收结果。
- “规则已结算结果不可被后续循环改写”；“原文永不因摘要删除”。摘要不得写 Event、Entity、Thread、Quest、delivery、ending、History 或 gameplay revision。
- 不增加 Action/互动操作/Entity 组件、通用规划器、reviewer、润色器、向量数据库、图数据库、层级 Arc、长篇模式或世界模拟。已支持的五幕中篇不是开放式长篇。
- 权威 schema 保持 **EntityStore3 / World7 / Story12**；摘要缓存使用独立 formatVersion=1。不得把 schema11 文档或旧 P1 初版 schema10 当代码基准。
- 所有原文按 speaker/audience/实际事件权限投影；玩家选项表示所选行动，不自动等于说出口的台词。未选选项、未消费续接及条件结局都不能成为已发生经历。
- P2 只消费 foundation 公开接口；不修改 `.foundation`、公共 package 或 `docs/共同规范/`。新增逻辑均有 RPG 语义。
- 本轮仅编写文档；实施、真实调用与 UI 验收在后续执行各 Task 时进行。真实调用必须先冻结 Task 7 协议，不追加或替换失败样本。

---

## 范围、里程碑与后续归属

| 里程碑 | Task | 独立交付 | gate |
| --- | --- | --- | --- |
| P2-A 旧事真正进入当前互动 | 1–2 | 有权限、有来源、有原话的统一记忆包进入作者与单 NPC 判断 | 长间隔、错误指代、未选项、秘密与旧状态覆盖通过正式请求断言 |
| P2-B 安全的派生摘要 | 3–5 | 50/10 分批、可重建概览、独立缓存、失败无断档、并发不影响 A/B | 原始来源与覆盖水位可验证；摘要关闭/失败时故事仍可用原文运行 |
| P2-C 完整短/中篇验证 | 6–7 | 离线完整中篇、两条新 live 完整路线、同状态摘要对照和实机追问 | 完成性、回忆、权限和全文质量分别通过 |

先完成当前 gate，再进入下一段。若较长经历错误来自检索或权限投影，修对应 Task；若出现新的通用行动/世界模拟需求，记录为 P3，不在 P2 扩充规则来“救”某段文案。

| 原总 Spec 后移事项 | 本 Plan 负责 | 后续归属 |
| --- | --- | --- |
| 较长间隔旧人/原话/承诺 | 来源、召回、当前状态与正式中篇验证；现成承诺的回归 | 新承诺操作、复杂履约玩法交 P3 |
| 保密/引荐/核验六路线 | 保留权限与已有操作回归；不执行旧 failed focused 矩阵 | P3 在实际玩法稳定后登记新综合矩阵 |
| 完整 UI | 仅记忆追问、刷新、继续至终局 | 视觉打磨/综合交互专项 |
| 优于 main | 不作该结论；P2 对照只分析摘要对证据使用的影响 | P2/P3 稳定后的同配置 main 对照，另行 Plan |
| 性能/扩容 | 有限输入、缓存一致性和计数 | 索引服务、事件分段/归档、长篇交 P4 |

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

**Interfaces:** 保留 `EvidenceQuery` 和 `EvidenceSelection` 的公开用途，增加可选的 `visibleEvidence` 参数，使同一请求复用一次投影。新函数：

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
- Modify: `src/game/gameplay/rpg/narrativeMemory/index.ts`、`src/game/application/projectNpcDeliberation.ts`、`src/game/application/narrativeBundleSource.ts`。
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
  ambiguousEntityIds: readonly EntityId[];
  manifest: readonly { ref: string; reason: string; mandatory: boolean }[];
}>;
```

Task 2 的 `coveredThroughSequence=-1`、overviewHistoryIds/overviewEventIds 为空；Task 3–5 接入后由有效缓存决定。新 `buildNarrativeMemoryContext(input: { evidence: ObserverEvidence; selection: EvidenceSelection; coveredThroughSequence: number; overviewHistoryIds: readonly string[]; overviewEventIds: readonly EventId[] }): NarrativeMemoryContext` 验证所有引用属于 evidence，按 sequence 去重排序；它不调用模型、不写状态。overviewEventIds 单独渲染为带原事件时间的概要，不冒充本回合 requiredEvents。

- [ ] 写 RED：作者收到玩家可见的旧 NPC 原句；NPC 自知包只收到自己听见/说过的旧表达；另一 NPC 不知。玩家选择 label 被保留为 action expression，不能以 NPC 亲闻原话的身份跨回合传入。当前 `currentNpcPlayerExpressions` 的本轮特例保持明确。
- [ ] 用完整 `projectNpcDeliberation` 与真实 bundle prompt 构造测试检查实际输入；不能仅断言 build helper 返回字符串。运行上述 integration、projectNpcDeliberation、bundle context tests。
- [ ] 实现同一记忆包的两个 observer 投影；作者用 player，单 NPC 用自身。所有未覆盖、已提交且可见原文都进入 uncovered，不以“近期四场结构卡”替代。回忆条目标记原 speaker/kind/turn，旧物品归属或旧承诺状态标为当时记录，当前状态仍由 Entity 单独注入。
- [ ] 接入 NarrativeBundleSourceContext 的 `memoryContext?: NarrativeMemoryContext` 和 NPC projection 的同名可选输入；Task 5 完成装配后生产必须传入，现有纯 fixture 可显式使用源状态构造。reviewer 看同版作者包及自己的规则投影，不能从别的 observer 私密记忆推断可公开内容。
- [ ] 将 manifest 的 mandatory 映射为独立 ContextBlock；所有 uncovered 为 mandatory，recalled 依据来源区分；有歧义时给候选及证据，不自动把当前焦点作为过去行为人。旧原话进入 NPC 私密判断并不扩大 `npcSpeechAuthority` 的 outward 授权集合。
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
- Modify: `src/game/application/generatePendingNarrativeBundle.ts`、`projectNpcDeliberation.ts`、`narrativeBundleSource.ts`、`src/game/application/server/compositionRoot.ts`。
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`、`liveNarrativeBundleSource.ts`、`liveNarrativeCandidateReview.ts`、`liveNpcDeliberationSource.ts`、`narrativeRequestClient.ts` 与相应测试。
- Modify: `.env.example`（本 Task 的非秘密配置说明）；Docs: 连续性与记忆、运行时 AI、AI 环境、AI 文本审计。

**Interfaces:** `prepareNarrativeMemory(input: { record:GameRecord; observerId:EntityId; job:PendingNarrativeJob; source:NarrativeMemorySummarySource; repository:NarrativeMemorySummaryRepository; policy:NarrativeMemoryPolicy; summaries:"enabled"|"disabled"; signal:AbortSignal; reserveSummaryHttpAttempt:()=>Promise<boolean> }): Promise<{ok:true;context:NarrativeMemoryContext}|{ok:false;code:"MEMORY_CONTEXT_OVERFLOW"|"CANCELLED"}>`。`NarrativeMemoryPolicy` 类型在 `domain/narrativeMemoryContext.ts` 增加，字段为 `threshold`、`batchSize`、`rawSoftEstimatedTokens`、`summarySourceMaxEstimatedTokens`、`overviewMaxEstimatedTokens`、`promptMaxEstimatedTokens`，均为 number；server policy 文件负责默认值、环境校验与注入，application 不反向 import server。

长度政策导出 `NarrativeMemoryPolicy`，初始值固定：阈值50/批10、旧原文软阈值 **24000 estimated tokens**、summary 单次源输入最多 **24000**、概览渲染最多 **6000**、完整 provider 请求硬阈值 **64000**。统一使用现有 `estimateNarrativeTokens`；硬阈值包括系统规则、修订前稿及 reviewer 的候选正文。`AI_NARRATIVE_INPUT_MAX_ESTIMATED_TOKENS` 可覆盖硬阈值为正整数；其他初值通过 server policy 注入。register 必须冻结值及模型已知输入能力，估算不是 provider 精确 tokenizer 或输出容量保证，不沿用 P1 的无限值，也不恢复未经验证的 8000 限制。

- [ ] 写 RED：摘要超时/非法引用/概览失败时水位不动，全部未覆盖可见原文仍在请求里；50条后失败，到61条不得只发最后50条。超过硬预算时零 author HTTP、明确失败，A 的行动不重复结算。
- [ ] 写 preparation 与真实 requestClient/generator 集成测试：同一 job 三版候选使用同一记忆快照；角色 outward 成功缓存仍复用，不因摘要修订重复判断。另一个 observer 的维护结果不能进入作者包。
- [ ] 在取得既有 narrative job 租约后、角色判断和候选循环前准备一次；P2 采用请求内有界维护，不新建后台常驻服务或额外 gameplay provider 触发点。未触发生成的移动/物品消费不为摘要调用网络；下次合法生成入口再追赶。进程恢复可重建，缓存以来源和策略版本校验。compositionRoot 的测试/实验 options 增加 `memorySummaries?:"enabled"|"disabled"`、`memoryPolicy?:NarrativeMemoryPolicy`，生产默认 enabled；disabled 不读/写/生成摘要，读取全部可见原文，仍保留相同检索/权限与长度检查，不成为另一个生成实现。
- [ ] 每 job/epoch 给所有 observer 合计最多 **8 次摘要 HTTP**，最多准备 **2 个批次更新**（每次叶+概览、每请求最多2次传输）；先 player，再当前需要判断的 NPC。其余保留原文，不延迟到无上限队列。原 author/NPC/review **24 HTTP/epoch、3候选**保持，P2 总上限明确为 **32 HTTP/epoch**；所有用途还共同受实验批预算。Task 4 的缓存端口/适配器在本 Task 增加 `reserveHttpAttempt(input:{gameId:GameId;generationId:GenerationId;jobId:NarrativeJobId;epoch:number}):Promise<boolean>`，使用独立 `narrative_memory_attempts` 表按这些键原子计数并在发送前预留；崩溃不退额度。不能挪用叙事额度后声称24次包含全部调用。计数表与缓存一起遵循清档/关闭策略，测试并发上限和重启保持。
- [ ] preparation 超时/额度耗尽后若原文可装入完整预算，继续用旧有效概览+全部 uncovered；这是读取真实来源，不是确定性剧情回退。若仍装不入，沿同一 job 显式失败，允许用户重试，不能切掉 mandatory：

```ts
const uncovered = evidence.history.filter(entry =>
  entry.sequence > validSummary.coveredThroughSequence);
expect(uncovered.map(entry => entry.id)).toEqual(allUncoveredVisibleIds);
expect(recordAfter.storyState.history).toEqual(recordBefore.storyState.history);
```

缓存不存在/失效时 `validSummary.coveredThroughSequence=-1`。当前输入、活跃 Thread/Promise 证据、精确追问来源即使已被摘要覆盖仍作为原始引用补回；不存在 source 的概要不得参与构造。
- [ ] 完整 prompt 编译后检查 overflow 并在 provider 请求前拒绝；compiler 原有“保留 mandatory”的语义不改，optional 可按既有次序移除且记录 manifest。如果只一条原文就过长，不自动截断/续写，返回明确长度错误。
- [ ] 扩展 source/review 的审计上下文记录 source 指纹、overview/批 ID、覆盖水位、raw/recall 数量、估计长度与失败原因；原文进入专用审计，不写普通日志。transport 磁带同时包含摘要用途，请求顺序受 preparation 冻结，replay 不启动隐形后台维护。
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
- [ ] 注册两条新生产路线 **S-short、M-medium**，分别三幕/五幕，都是有公开依据的递送，不强制秘密或新增操作。固定 characterName=沈行、identity=受托递送书信的旅人、profile=愿意听取不同意见并记住先前约定、tags=[谨慎,守信]、gameType=wuxia、style=novel、intensity=normal；premise=“沿途数个聚落之间往来书信，人物各有立场，委托可由实际交付完成。”；opening=“我接受一封公开书信的递送委托。请明确委托人的理由与接收约定，沿途人物的不同意见应围绕这次递送；我会在后段回想早先的话，再决定完成交付。” 两路仅 gameLength 不同，不读历史开局 seed。
- [ ] 选择政策复用合法 Action/目标推进，不以 label 关键词猜 ID。中篇在第三幕或之后、仍未交付且已产生两次摘要时的首个合法 NPC 决策输入：“最初委托人对这封信说过什么？我想先回想原话，再决定是否交付。” 查询是谁、原话是什么以真实开局 History 为 oracle；不把期望原句注入玩家输入。触发条件始终没满足则记 coverage failure，不能为通过临时降低阈值或追加无意义动作。
- [ ] 预登记 **短篇24动作/200 HTTP/90分钟，中篇48动作/500 HTTP/180分钟**；包括初始化、摘要、角色、作者、review及所有传输尝试。每 epoch 24叙事+8摘要，三候选，正式批不自动执行耗尽后的手动 retry。失败保留分母，不另抽成功开局。两个模型及所有参数沿同一实际配置冻结，记录代码/配置/策略/输入/来源 hash。
- [ ] summary 摘录覆盖完成后、旧事追问前复制同一 ready SQLite 建立有/无摘要两臂诊断，均经正式动作输入同一追问；只改变 summary enabled/disabled，两臂规则、检索和权限相同。各最多一个生成 job、50 HTTP/45分钟，无后续循环采样；该诊断不增加“完成路线”分母，不称完整文本质量 A/B 结论。
- [ ] 新磁带记录缓存初态/发布结果、所有 memory/author/NPC/review 请求、identity/domainTime、每次正式状态。replay 检查 prompt 哈希、响应完全消费、game状态及cache指纹/水位一致；重放逻辑尝试计数应一致，真实 HTTP 为零，两者分栏。不能删除摘要请求使磁带“匹配”。抽取 helper 的兼容验证用 P1 协议/磁带单元契约，保持其严格匹配规则。P2 已有意改变生产 prompt，不能要求旧 P1 live 磁带在新 prompt 下通过；完整旧故事回放只能在其对应冻结实现下进行，本 Plan 不另开该项实跑。
- [ ] 运行 node 脚本测试、离线P2旅程及 P1 协议/回放测试、typecheck/boundaries；更新协议并提交 `test: cover complete medium stories and traceable memory experiments`。

## Task 7：冻结、实跑、全文阅读与 P2 判定

**Files:** Create: `docs/superpowers/reports/2026-09-14-narrative-p2-acceptance.md`；Modify: 本 Plan gates、需要纠正的实际系统事实。原始产物使用 `artifacts/narrative-p2/<runId>/` 独立目录，不编辑旧P1产物。

**Interfaces:** 消费 Task 6 协议与正式 driver，输出完成性/回忆/权限/质量四类结论；不新增生产接口。

- [ ] 先完成一次完整验收：lint、typecheck、boundaries、`npm test -- --minWorkers=1 --maxWorkers=2`、check:docs；涉及 production build 的本 Plan 再执行 `npm run build`。不能用P1旧成绩替代本版本结果。冻结代码与协议后运行：

```powershell
npm run journey:narrative:p2 -- --mode=register --run-id=p2-01 --protocol=artifacts/narrative-p2/p2-01/protocol.json --output=artifacts/narrative-p2/p2-01
$env:RUN_REAL_AI_JOURNEY='1'
npm run journey:narrative:p2 -- --mode=live --run-id=p2-01 --protocol=artifacts/narrative-p2/p2-01/protocol.json --output=artifacts/narrative-p2/p2-01
```

`journey:narrative:p2` 在 Task 6 定义为 `node scripts/narrativeP2Journey.mjs`。模型值必须来自实际可用配置，register 不生成正文、不检查/输出 key；输入长度上限需与所用模型配置的能力核对后再实跑。

- [ ] 两条路线都必须全新正式创建并到合法成功终局/ready，中途关闭重开并比较状态；中篇必须实际有两次摘要与满足间隔的回忆触发，缺失则报告“通关但P2覆盖未通过”。初次失败、有限修订成功与任何显式人工重试分栏，不能混成连续成功。
- [ ] 两条新流分别严格零网络 replay，所有原文/状态与摘要维护一致。读取逐步完整 History、有效 summary、recalled source 和所有未通过候选，确认原文保留、无条件/否定改写、未知角色不冒领经历、旧状态未覆盖当前 owner/承诺。
- [ ] 执行两臂诊断，记录原文覆盖、精确旧话命中、歧义/拒答、事实错误、请求长度与调用数。摘要臂至少不丢失指定必需来源且无新增硬错误；若无摘要更完整而摘要遗漏核心动机，P2摘要效果不通过，不能以省token抵消。
- [ ] 在真实 UI 使用本次一条 live 的合法存档，执行旧事追问→刷新→继续至终局；记录实际输入、响应与reload状态。该操作可以承担预定路线的对应段，必须归入同一协议/产物，不能另外隐形计费或只展示已录制结局截图。
- [ ] 人工阅读全文，按局部衔接、人物动机、因果/悬念、选择后果可感知、结局收束各1–5分：**每条均分≥4、单维≥3、没有确认事实/权限/行动硬错误**。分别说明哪次旧事真正影响后续问答或决策；模型重复旧句但无关当前问题，不算回忆收益。
- [ ] 失败仅按检索、权限投影、摘要选编/覆盖、规则可完成性、创作/审阅、运行层归因，封存原批；有新实现再开新冻结批需单独明确范围。不得按失败句子增设规则、reviewer或继续重采到通过。
- [ ] 完成 `npm run check:docs`、新增文档链接人工核查、`git diff --check`，提交 `docs: record P2 memory and complete-story acceptance`；P2通过不自动合并 main，也不宣称本分支整体叙事优于 main。

## 验收矩阵与执行记录

| 编号 | 必须成立 | 负责 Task |
| --- | --- | --- |
| M1 | 较早NPC/事件/原话可双向找到，mandatory贯穿真实请求 | 1、2、6 |
| M2 | 显示选项、隐藏名字、私密听众、代词歧义不制造错误知识 | 1、2、6 |
| M3 | 50/10以有效History计数；source/sequence与Event/turn分离 | 3 |
| M4 | 概览从原始叶来源重建，文字逐字对应、当前状态仍读Entity | 3、5 |
| M5 | 摘要失败水位不动、所有未覆盖原文可读，溢出明确失败 | 3、5 |
| M6 | cache写入不改变游戏revision/token，竞争/重载/回滚不串史 | 4–6 |
| M7 | 同一job候选共享记忆快照，所有HTTP/缓存结果严格回放 | 5–7 |
| M8 | 新短篇与五幕中篇均完成，中篇真实触发摘要/较长间隔回忆 | 6、7 |
| M9 | 两臂诊断来源不回退，全文质量及实机流程通过 | 7 |

执行各 gate 时原位替换下列结论并链接验收报告，不往系统索引追加成绩：

- **P2-A：** 未执行。
- **P2-B：** 未执行。
- **P2-C：** 未执行。
- **P2 总结论：** 待实施；当前仅完成范围规划与文档编写。
