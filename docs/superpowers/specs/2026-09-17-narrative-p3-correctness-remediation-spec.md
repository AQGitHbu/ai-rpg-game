# P3 规则语义、审阅依据与完整验收修复 Spec

> 文档版本：v1.1
> 日期：2026-09-17  
> 状态：已按本地分支复核并修订，待实施；本文不代表修改已经实施或验收已经通过
> 修改仓库：仅 `ai-rpg-game`，`sharedInfrastructureChangeAllowed: false`  
> 实施分支：现有 `codex/narrative-architecture` 工作区，不修改 `main`、`staged-narrative-generation`  
> 上游架构：[持续局势、完整场景与长期信息架构](2026-09-12-narrative-architecture-design.md)  
> 原阶段范围：[P3 有后果的调查与角色合作 Plan](../plans/2026-09-15-narrative-architecture-p3.md)  
> 实施入口：[本修复 Implementation Plan](../plans/2026-09-17-narrative-p3-correctness-remediation.md)  
> 文档定位：修正 P3 已有实现及完成判定。在本次修复范围内，本 Spec 的明确修订优先；未修改的架构与 P3 C1–C8 要求继续有效。

---

## 1. 文档地位、证据边界与成功定义

### 1.1 为什么需要本次修复

目前已有统一 Action 流水线、A/B 分离、事件账本、当前 token/revision、规则审批、条件续接及 CAS 持久化。这些是需要保留的主干，不是本次重写对象。

源码与 `p3-live-44` 的两份 runtime 表明，问题集中在三类责任错位：编译器为未明确绑定的 NPC 目标补写完成条件；作者可读的历史未完整投影成审阅可引用的依据；审阅响应自身的协议错误被作为作者剧情缺陷重试。验收又将若干事件出现和路线结束，过早等同于原 P3 能力成立。

修复完成必须同时回答：**哪个明确目标发生了合理变化、哪个真实行动因条件不同而改变准入、哪些历史支持了叙述，以及 UI 能否从实际持久化状态继续。** 单独增加成功次数、换模型、扩充 prompt 或补写总结文件，不构成修复。

### 1.2 已核查事实不等于新的验收结果

本文依据用户指定的四份文档、本地 `codex/narrative-architecture` 源码及 `artifacts/narrative-p3/p3-live-44/`、`p3-ui-live-01/` 实际文件复核。HEAD 为 `b93c7542b0aafe2efe290e052d051b01d5c145b0`；核查时生产源码无未提交修改，不代表远端最新版本。定位与命令结果见 [本地复核报告](../reports/2026-09-17-narrative-p3-remediation-review.md)。原分析文件实际路径为 `docs/P3_源码根因分析与修复方案.md`。

历史 runtime 的起始提交为 `f79479a35c81e3bd91633072425e85565d486ad3`，与当前 HEAD 不同。UI 文件本地存在：最后是 revision 23 的 `expected_command(private-action-14)`，没有对应成功提交、刷新证明或 terminal。它证明当时在等操作，不能证明卡在 provider，也不能断言 ensure 缺陷就是该停点原因。原 ZIP 审查所称 12 项复现材料未全部随这四份文档提供，本次不冒称重跑了那 12 项。

本 Spec 和 Plan 是拟实施契约，不沿用旧“12 项复现通过”作为修复通过，不把 JSON 回放、语法检查或 mock 通过当作新真实 API/UI 通过。

### 1.3 UI 范围恢复到原阶段定义

原 P3 C7 是：同一个真实初始化分叉出两条完整路线，**至少一条实际 UI**。本次明确采用 `private = next_ui`、`public = api`；另有两条 API 的工程诊断批次时独立登记，不与 UI 批次拼接。

当前 UI runner 只驱动 private、public 走 API 本身不违反 C7。真正缺口是完整执行、刷新续接、能力覆盖和证据判定。不得未经新决策把“两条都用 UI”升级为本次阻塞条件。

---

## 2. 当前问题与修复编号

下表“已复现”指原源码上的问题或边界被复现，不指修复后的验证结果。

| 编号 | 优先级 | 证据与问题 | 本次要求 |
|---|---|---|---|
| P3R-01 | P0 | `narrativeDraftProjection.ts/p3EvidenceGoalBinding` 按第一个 active 且未绑定目标补 `knows_fact`；原记录分享后完成无关长期目标 | 编译器只保留作者显式绑定，不创造目标含义 |
| P3R-02 | P0 | `narrativeExecutionChecks.ts`、`narrativeReviewRules.ts` 的历史依据主要覆盖物品转移；action 7 核验无法被 action 10 的前提引用 | 建立同源、可见、已提交的历史执行依据投影 |
| P3R-03 | P0 | `participants[].npcId` 接受主角字符串，再按 NPC 位置判剧情错误 | NPC-only 类型契约；审阅协议错误原候选重审，不处罚作者 |
| P3R-04 | P1 | `hasPendingDeliveryEvidenceClosure` 对 share/verify 独立存在性判断，不能证明二者对应同一调查链；这是谓词边界测试，不冒称线上已绕过 | 按同一 fact、发现事件、委托人和严格顺序连接证据 |
| P3R-05 | P0 | `p3RouteSatisfied` 以任意相关 goal event 代替指定目标的正确完成 | 记录明确目标、显式绑定来源及其含义审查 |
| P3R-06 | P0 | 原 live 聚合缺少 C3 跨路线准入对照；保存的配对决定点未展示差异 | 比较同一合作定义的真实规则准入，并追踪后续两次行动 |
| P3R-07 | P0 | 原策略检验 `nextIndex !== index` 接受“先调查、后输入策略” | 策略输入、后续选项和被确认行动按时序及来源绑定 |
| P3R-08 | P1 | `CurrentGameScreen` 在 ensure 确认前记录已派发 job；首次派发未成功时可能只 GET | 确认后记账，有界重派，同 job 幂等，不重做 A |
| P3R-09 | P1 | UI runner 无进程重启续跑；刷新要求中途 ready/未结局；交接说明容易混用 | 固定执行口径、刷新检查点、诊断层次和新 run 策略 |
| P3R-10 | P0 | 路线 completed、严格回放与 C1–C8 混在完成结论中 | 新验收协议、分层状态、缺项不通过、保留失败分母 |
| P3R-11 | P1 | 旧存档可能包含错误绑定的历史后果；版本/依赖不完整会污染验证 | 保留旧文件；新语义只在新初始化证明；维护兼容与回归边界 |
| P3R-12 | P0 | 原修复将 share 接收人当 actor，且合作检查未贯通选择生成 | 尊重 actor/target 契约，生产候选与结算共用准入 |
| P3R-13 | P0 | 原修复只追加开场文字，缺生成前能力说明、批准前覆盖检查和 C3 选择优先级 | 调查绑定发布前闭合目标/合作/回访路径，缺项用原三版预算修订 |
| P3R-14 | P0 | 采集接口不能获取 fork/raw/symbols；只实现 C2–C4 判定；hash 不能证明 passed 字段为真 | 明确采集时点和来源，逐项重算 C1–C8，区分未运行与实际失败 |
| P3R-15 | P1 | UI runner 后台 ensure 掩盖前端故障；刷新未重开仓储；回放证明遗漏共享流 | UI 路由只由页面派发，持久化重开，三条流严格回放 |

---

## 3. 全局约束与非目标

### 3.1 必须保持的约束

1. 仅修改 `ai-rpg-game`；零 foundation 改动，不新增运行时依赖，不修改 `docs/共同规范/`。
2. Node `>=24.15.0`、npm `>=10`；先恢复本仓库声明的 `.foundation` 链接及依赖，再执行工程验证。
3. 保留一个整场作者角色、必要的隔离 NPC 私有判断和现有候选审阅角色；不新增常驻 Agent、额外审批角色或固定多轮生成 DAG。
4. 保留 A 已提交行动与 B 候选发布的分离；B 失败、重审、重新派发不得重做 A。
5. 保留正式事件、EntityStore、revision/job、CAS 和已批准续接权威。读地图、切 UI 面板和 GET 不增加 provider 工作。
6. 内容版本最多 3 个；每 job/epoch 的叙事 HTTP 上限 24，记忆 HTTP 上限 8。二者不得因为合计 32 而互相借用或隐藏。
7. 单路线最多 32 个行动、300 次 HTTP、7,200,000ms；两路线批次最多 600 次 HTTP、10,800,000ms。不得自动重试已耗尽的批次/epoch。
8. 保留 P2 摘要协议 v1、50/10 阈值、24k/6k/64k 的现有预算语义；本次不以删历史或秘密泄露换取审阅通过。
9. 不修改 `docs/agent/current-phase.json`；不 reset/checkout 丢弃已有工作区改动；不覆盖任何旧 run 的 artifacts。
10. 本次不要求变更 EntityStore v4、WorldState v8、StoryState v13、NarrativeBundle v3。审阅投影和验收文件版本可独立变化，不等于存档 schema 升级。

### 3.2 不做什么

本次不引入任意目标 DSL、通用 OR Quest 图、新互动 operation、前端自行裁决合作、确定性生产剧情兜底，也不降低真实交付、实际在场、披露权限或未来事件禁用规则。

不实现跨进程 checkpoint/resume 验收系统：原进程仍活着时可以继续，进程结束后使用新 runId 重新注册；旧目录只保留诊断。游戏本身刷新恢复仍是必须项，两者不能混称。

不把历史 `staged-narrative-generation` 的分阶段固定调用作为当前架构。分阶段生成是否优化成本，属于修复后另行测量的工作。

`storyOpening.includes(...)` 的关键词开关确有复用风险。本次将它隔离在现有单一入口并添加边界测试，不悄悄改变其语义。迁移到结构化能力契约涉及旧存档与作者契约，单独立项；本次新 live 输入明确使用已注册契约，不能靠改写中文逃过门禁。

---

## 4. 目标绑定：编译只解释结构，不创造意图

### 4.1 显式来源原则（P3R-01）

删除 `p3EvidenceGoalBinding` 及其在 `compileNarrativeDraft` 中的追加。`worldDelta.consequenceBindings` 和顶层 `consequenceBindings` 只来自本次作者原始提案，沿既有解析/审批/符号解析安装。

编译器仍可补 schema 已规定的无语义默认字段、解析 `@new.*`、组装 current/continuation/ending 槽位；不能按目标顺序、active 状态、是否缺 resolution 或验收是否缺 event 决定新绑定。

不允许补写后再标记“作者生成”。绑定来源记录在当前调用审计与验收材料中，绑定的 `npcRef + goalOrdinal`、原始目标说明、原始条件、编译后的 goalId 和批准候选 hash 应可相互追溯，不新建生产目标状态表。

### 4.2 有限目标与长期目标分开

“收到本次调查报告”可由本人实际获知相应事实的规则完成；核验另由真实 `request_verification` 事件证明，不能用 `knows_fact` 同时宣称已核验；“保住整个渡口的旧泊权”不能只由收到消息完成。目标的说明必须与条件覆盖的有限结果一致。

本次不声称程序可以自动证明任意自然语言目标与条件完全等价。对新 NPC 同包显式目标沿现有整场审阅检查；对已有 NPC 私有目标，不能为了公共作者/审阅便利泄露说明。C2 的最终语义核对由有权限的验收者读取原作者/私有记录与批准绑定，形成独立签核。协议未签核不能标记 C2 完成。

测试样本的有限目标必须由真实作者明确提供；程序不能替它造一个目标、移动到第一个 ordinal 或从长期目标改名。无法生成满足能力的明确目标时记录 `P3_CAPABILITY_COVERAGE_FAILED`。

### 4.3 不让补绑定追溯改写历史

沿用“绑定安装只影响未来实际行动”的原规则。不得对旧 `completed` 目标重置、删除旧事件或重放历史来修饰结果。既有合法绑定不可删除、替换或削弱。

必要回归：未提供绑定时不增加；同包显式绑定保留；目标数组换序、一次/多次编译不增加绑定；长期目标不因收到报告自动完成；重复分享不产生第二次完成事件。

---

## 5. 历史执行依据：统一目录、明确时间与权限

### 5.1 单一派生入口（P3R-02）

新增 `src/game/application/server/ai/narrativeHistoricalEvidence.ts`，提供纯函数 `buildNarrativeHistoricalEvidence(input: NarrativeCandidateReviewInput)`。opening 返回空列表。decision 的输入增加只用于服务端的 `committedState`（world/story），由 `generatePendingNarrativeBundle` 从预审批前仓储 record 明确注入。`generationContract` 是当前披露后的生成契约，其知识权限、目标与任务可能已被预览改变，不能当作已提交状态。缺少 committedState 时在 HTTP 前记录 `HISTORICAL_BASIS_MISSING`、返回 UNCERTAIN，不 fallback 到 preview，也不把完整 record 序列化进 prompt。

先调用现有 `projectObserverEvidence`，observer 为当前审阅的玩家公开场景观察者；再以事件白名单和字段白名单构建依据。此函数返回同一候选内的派生值，不持久化另一份权威历史。

首批历史种类只包含实际需求：`item_given`、`item_obtained`、`fact_discovered`、`story_interaction_resolved`、`location_visited`、`opening_history_established`。成功业务事件优先；`location_visited` 与 `opening_history_established` 的既有 `neutral` 结果分别属于已发生移动与已建立开场历史，不能因统一要求 `success` 再漏掉。明确 `failure` 事件不证明成功前提。未列出的事件不自动开放。

`event:<正式 eventId>` 作为依据 key；输出 sequence、turnNumber、事件类型、实际角色/地点、授权 factIds 与该类型必要 payload。事件可见不等于 payload 任意字段公开：不输出 evidenceQuality、隐藏方法条件、NPC 私有 goal/reason 或完整 entity record；质量留在规则与受限验收材料。payload 内 fact/entity/evidence 引用分别核对授权，不只检查顶层 factIds。新类型加入前补可见性和时序测试。

### 5.2 目录与执行检查一致

`narrativeReviewRules` 的历史 event 条目和 `narrativeExecutionChecks` 的历史 `prerequisiteBasisKeys` 均消费这一函数。原物品持有/转移规则保留：历史转移可证明当前仍持有，不能证明本轮 talk 又交付一次。

对每个合法历史 key：审阅 catalog 中恰好一项；允许引用它的检查能定位该项的实际值；不允许只有字符串引用而没有内容。目录完整性由本地不变量检查，不调用模型“修目录”。

### 5.3 历史、当前、条件未来不混合

历史依据只到 A 的已提交事件序列上界；当前行动可引用 `action:<actionId>`；future continuation 只能在其成功 trigger 后的对应槽范围引用 `step:*`；两种 ending 的条件结果互斥。候选中同包新实体存在不代表玩家已经移动、见面、交付或核验。

补齐历史目录不是把所有 `step:*` 或 ending 预演加入 current 的前提。当前依旧严格拒绝未来事件自证。

### 5.4 缺项与错误的处理

目录自相矛盾、同 key 不同内容、允许键不存在：在请求审阅前记录服务端上下文错误，停止该 B 的错误发布，不消耗作者版本来修服务端目录。

作者引用确实未发生的事件或把已发生核验扩成未发生的现实后果：沿现有候选缺陷修订。模型无法定位依据、但服务器也不能从结构上确定具体 claim：保持 `UNCERTAIN`/不发布，不自动判为事实不存在，不发明 claim 到事件的自然语言匹配器。

原 private action 10 的回归必须同时有正例、删去核验事件的负例，以及“不允许把核验报告扩大为偿债/交付”的负例。

---

## 6. 审阅响应与作者缺陷分流

### 6.1 保留 NPC-only 参与者契约（P3R-03）

当前 pass 继续使用 `playerLocation` 表达主角实际位置；`participants[].npcId` 仅容纳 NPC。提示词明确这一点，结构/类型校验在查 NPC 位置前拒绝 `PLAYER_ENTITY_ID`。

不能静默删除主角 participant 然后直接 pass，也不能把 npcId 换成随便一个同场 NPC。应保持完整候选 hash，要求审阅器修正响应；正文没有变化。

存在但不在场的 NPC 被正文写为在场，仍是实际 `ACTION_MISMATCH`。类型错误、无效 path/quote、重复/缺失检查项、错误 basis 域则属于审阅协议错误。未知 NPC 字符串要结合候选是否实际引用该实体分类，不能一律吞掉真正的虚构到场。

### 6.2 沿用已有返回类型与额度

优先保留 `validateNarrativeExecutionChecks` 的现有语义：`null` 表示审阅协议不完整/不确定；空数组表示这次结构校验一致；非空 `CandidateDefect[]` 表示可定位候选缺陷。空数组不是对所有叙述的形式化真值证明。

沿 `createLiveNarrativeCandidateReview` 已有同 hash 最多两份响应处理。第二份仍不合法则返回现有 `UNCERTAIN`，不发布候选；HTTP 消耗仍计入现有 epoch 上限。不得将错误包装为作者 `approval_rejected` 再耗掉三个作者版本。

真正的候选缺陷依旧进入作者有限修订。网络故障、结构失败和语义缺陷在日志中保留不同类别；不得以总称 `provider_failed` 覆盖根因记录。对外失败视图可以沿现有稳定类型。

### 6.3 必须保留的正确拒绝

未执行核验却描写“两半凭记已经合看成功”、talk 却已经上船/偿债、未到场 NPC 获知事实、当前场景提前消费未选择 ending，仍必须拒绝。修复误报不等于关闭审阅或把所有缺陷归为风格。

---

## 7. 调查—分享—核验的同源链

### 7.1 收敛现有 closure 判断（P3R-04）

在 RPG narrativeBundle 模块新增 `deliveryEvidenceClosure.ts`，经其 `index.ts` 导出 `findDeliveryEvidenceClosure(worldState, storyState)`。调用方 `hasPendingDeliveryEvidenceClosure`、draft projection 与审批相关门禁使用同一结果，不再各自独立搜索 share/verify。

最小闭环是一条实际调查事实的完整链：

```
discovery.factId = share.factId = verification.factId
sequence(discovery) < sequence(share) < sequence(verification)
share.evidenceEventIds 包含 discovery.eventId
verification.evidenceEventIds 包含同一个 discovery.eventId
share.npcId = verification.npcId = delivery.giverNpcId
share.audienceIds = [giverNpcId]
verification.audienceIds = [PLAYER_ENTITY_ID]
```

调查必须是带真实调查方式/quality 的成功 `fact_discovered`，分享与核验必须成功。按 `baseInteractionDraft`，share 的 actor 是玩家、target 是 giver；verification 的 actor 是玩家和 giver、target 是玩家。按 operation 检查角色、payload 和地点，不能要求 share.actorIds 含 giver。合法同场须有生产结算及相应前态；不以 NPC 当前地点否定过去链，不以 UI 面板代替地点。

### 7.2 范围不无端扩大

保留现有“一条完整调查证据链即可满足该递送前置”的最低语义，但该链必须属于当前递送所关联的已批准调查目标/绑定，不得由无关支线凑数。不新增“所有本局新事实都核验”的要求。

不把 giver 任意 goal、blockWhen 或 allowedFactIds 的并集当作递送关联。用已批准主线 Quest 的 discover_fact objective 引用确定候选，与 giver 显式目标/合作引用取交集；读取保留的主线历史 objective，不因游标越过调查而丢失关联。v2 切片冻结唯一主线调查 fact，缺失或多义在发布调查绑定前失败，不按数组首项选择。额外支线事实不成为门槛或替代证据；不新增存档字段或通用 Quest DSL。多条主线调查前置的产品语义另行设计。

### 7.3 生成与审批必须能够产出这条链（P3R-13）

删除自动目标绑定后，不能只靠 runner 最后报缺项。v2 默认采用作者在同包可完整看到的新现场 NPC 有限目标（如完成本次现场见证）作为 C2 目标，并显式绑定见证条件和合作定义。原 giver 只需显式 `request_verification` 合作定义，以其 `knows_fact(giver, fact)` 为前提；此引用也支持调查后回访，两路真实分享后均可核验。**不要求把原 giver 不可见含义的旧目标绑定到新 fact，也不为通过 C2 泄露其私有目标正文。** 若作者另有明确语义和权限来源的 giver 目标，可保留，但不作为默认必需条件。

`approveNarrativeBundle` 物化并安装 consequenceBindings 后、发布前检查：唯一主线调查事实、可达方法、同包现场目标/合作、giver 核验及可供回访的条件引用。调查前 giver 不得预知结果。缺项返回带字段定位的 `p3_capability_*` 拒绝，用当前三版候选预算修订；不补目标、不重抽开局。普通故事不增加 P3 门槛。

共同 fork 检查在 `prepareNarrativeP3SharedSnapshot` 的 investigation-fork 执行，不在 town 开局要求未来 scene fact 已存在。只读检查并冻结 ID，失败保留批次。先用受控离线样本证明两条完整路径；live 仍由真实作者生成，不能注入 fixture binding。

此修复是对已发现谓词缺口的防御性收紧；不能把人工构造的跨 fact 负例叙述为历史 UI 中已经发生的绕过。

---

## 8. 完整验收必须证明能力，不只证明通关

### 8.1 新验收协议（P3R-10）

新建批次使用 `narrative-p3/v2`，验收证据 schema 为 `narrative-p3-acceptance/v1`。保留 v1 原文件、原 hash 和原结论作为历史，不就地升级，不伪称按新代码严格回放了旧记录。

v2 注册先冻结 input、源码指纹、共享包版本、运行环境/模型有效配置、预算、路线执行器、策略意图、C1–C8 证据要求及人工签核项。密钥不得进入协议。正式工作区须为可追溯提交；有未提交补丁时先保存差异，不能只写 SHA。

注册不调用 provider；live/replay 不篡改冻结文件。新开局因缺能力失败也计入原批次 plannedRoutes 分母，不循环抽到满足为止。

### 8.2 三类结果分离

`routes[].completed` 只说明该路线的完整业务流程与本路线必要检查完成；`strictReplayPassed` 只说明该冻结批次的离线严格重放；`acceptance.status` 才说明 C1–C8 的综合证据。

状态统一为 `passed | failed | not_run`，未执行、资料缺失、签核缺失或环境不满足均不得默认为 passed。最终 `passed` 必须是两条路线都 completed、所需严格回放已完成、C1–C8 全通过且实际 UI 证据完成。

如果 workflow 先 live 后 replay，live 输出应保留“路线已完成、验收待回放”的状态；不能先写 passed=true，随后再补回放。可用独立只读 `acceptance` 汇总命令在新文件中签封最后结论，不重写已封存 runtime。

### 8.3 指定目标与含义签核（P3R-05）

记录目标 NPC/goalId、批准候选 hash、作者原始绑定位置、条件内容、变更前后状态、触发事件和事实。禁止以任意一个 goal event 代替目标事件。

机器检查来源、实际条件和幂等；有权限验收者检查目标说明是否真被这些条件完成。签核记录检查人、绑定 hash、判定和具体理由；不能填写空说明或由测试程序自动生成“语义正确”。没有人工权限/记录时 C2 仍 not_run。

### 8.4 同源分叉与 C3（P3R-06）

两路必须来自同一真实已批准共享快照；分叉点包含同一调查 fact 的 2–3 条已批准方法，至少一条无额外见证，一条有实际同场见证。合作定义及对应目标条件也须显式存在，不能在 fork 后由 runner 补写。

比较的是同一 NPC、同一合作 operation、相同 fact/audience 范围、同一批准合作定义的准入。固定同一个逻辑检查点，例如两路在调查结果 B ready 后、尚未向对比 NPC 补告知前；不能单按 action 数字、中文名字或新生成 NPC ordinal 强行配对。

提取 `checkNpcCooperation`，生产 resolver、当前候选构建与验收共用。`descriptors.ts/preparedNpcContext` 当前仅检查 interaction.condition，须追加合作 gate；`storyConsequenceContext` 的可用互动也同源。未来到达槽使用对应 trigger 预演的位置，不能因玩家尚未到达而误删未来合法选项。批准 choice、registry、UI 与实际 resolver 须有集成一致性测试。undefined 定义保留旧行为，但不能成为 C3 显式合作证明。

允许路还须存在对应的当前已批准可见 Action，并由该路实际提交成功、产生对应业务事件；拒绝路记录同一冻结定义的真实规则拒绝及 UI/Action 投影不暴露。不得伪造另一条路的 token 提交，不得将“缺提案/不在同一地点/生成了另一个 NPC”算成合作分化。

两路各再执行两次真实合法行动：拒绝路从检查点后计数，允许路从合作成功后计数，不计早先动作或重复 actionId。核对目标/知识值与 provenance、合作效果；只检查 append-only ledger 仍含旧 eventId 不够。后续合法分享可以使权限收敛，但必须有新事件解释。

路线策略在调查结果 B ready 后先采集 C3，允许路优先选择该定义/范围对应合作，再返回 giver。不能沿用“调查后先离场”的旧优先级跳过检查点。拒绝路按已批准合法路径继续，不伪造 token。

### 8.5 自由策略 C4（P3R-07）

本次 v2 默认在 private **已经分享、尚未核验**时输入：“请先对刚才取得的这份证据当面核验，再决定怎么交付。”预期 operation 是 `request_verification`，目标为实际委托人和已分享的该事实，具体 ID 在共享/当前批准状态中绑定。

这是修正验收动作顺序，不改变生产自由输入语义，也不重新调查已发现 fact。策略原话、提交 actionId、生成 job、候选 hash、下一场真实曝光的 choiceToken/operation 和随后点击行动必须串联。

策略输入的 A 不得包含本意图的调查/核验/交付执行事件；普通 talk 的其他既有后果可发生。若核验选项在输入前已合法存在，B 可以保留，但必须在本次回应后仍真实可见且指向同一意图。玩家随后确认，才允许对应正式结果事件。

用严格步骤索引及 event sequence 证明 `输入 < 曝光 < 点击 < 结果`；只检查“不在同一步”、任意后续调查或同局存在自由文本均不满足。

### 8.6 C1–C8 完成矩阵

| 能力 | 本次证据要求 | 不能替代它的材料 |
|---|---|---|
| C1 主动调查 | 选择前未知、合法方法、选择后一次发现；未选方法/离场见证无效果；automatic 回归 | 描述中写了查验方法 |
| C2 角色目标 | 指定显式目标、自己的知识/见证/分享来源、真实变更、语义签核；重复零新增 | 任意相关目标 completed |
| C3 合作分化 | 同源定义准入不同、允许路真实执行、拒绝路规则拒绝、两次后续可追溯 | 张力、措辞、不同 NPC、不同 token |
| C4 策略时序 | 输入不代执行，之后匹配选项与真实选择结果 | 先调查后输入、仅做索引不等判断 |
| C5 回访记忆 | 原委托人事前未知，真实告知后已知；旧事来源进入实际请求；隐私不越界 | prompt 提过人物名字 |
| C6 恢复并发 | A 已提交，B 失败/ensure 重派/reload 不重复；CAS、取消、陈旧与战败回归 | mock 只返回 success |
| C7 完整路线/UI | 两路同真实初始化；至少 private 实际 UI，中途 ready 刷新后再实际行动，合法终局 | API 路线、勾选 reviewed、结束后孤立截图 |
| C8 有界复用 | 原预算、边界、非 P3 普通流程与另一题材离线复用通过 | 只通过指定中文短篇 |

---

### 8.7 来源重算与缺项状态（P3R-14）

每个 C 项都有独立 evaluator 和来源类型，不只实现 C2/C3/C4。C1/C5/C7 从本批状态、请求及 UI 事件重算；C6/C8 引用同源码指纹的离线工程测试报告和具体断言。汇总器解析 EvidenceRef 的值并重新推导判定，hash/存在性检查本身不证明结论；不采信外部传入的 actualConditionSatisfied/allowed/status 布尔值。采集和重算复用纯函数。

未启动或未到达检查点为 not_run；到达后无分化、实际失败、预算耗尽为 failed。路线保留 routeId 和 completed/blocked/not_run，不先转成布尔值。已有 failed 优先，否则有缺项为 not_run，全部满足才 passed。

## 9. UI 派发、刷新与 runner 生命周期

### 9.1 ensure 只重派 B，不重做 A（P3R-08）

原 `observedPendingJobKey` 的“已确认”语义由独立派发控制器接管，仅在 `ensureNarrative()` 返回明确 `ok: true` 且页面仍处理同一个 job 时记录成功。网络拒绝/异常不标记成功，响应过期不覆盖新 job 的标记。

单 mounted job 一轮连接最多 3 次派发尝试：立即、前一次失败后 1,000ms、再失败后 2,000ms；收到确认后仅 GET。普通观察保持 750ms；连接异常可退避至 5,000ms。确保同 job 同时最多一个前端派发请求。

ensure 与 pending GET 每个客户端请求连同响应体解析最多 15,000ms，超时中止本地等待并按连接失败处理，否则永久 pending 的 fetch 会使“三次重试”永远停在第一次。中止请求不等于停止服务端 B；收到迟到响应按 ticket/job 隔离，服务端重复 ensure 仍须幂等。

三次未确认后显示可理解的连接失败提示与“重新连接生成请求”；这只启动同一 job 的幂等 ensure，不调用业务 `performTurn`，也不调用重置 epoch 的 `retryNarrative`。用户仍可通过 GET 观察到已经完成的 B；一旦 ready/failed/ending 或 job 更换，旧计时器和旧回调停止。

服务端已收到但响应丢失时，重复 ensure 必须复用现有 coordinator/lease；回归证明只启动一个 worker、A 事件只一次。真正 `provider_failed` 仍走既有显式重试界面，不被连接轮询自动解锁额度。

### 9.2 真实刷新检查点（P3R-09）

private 在一次成功 browser_action 后、B ready、尚未 ending 的节点执行真实浏览器 reload；记录刷新前状态 hash/revision、刷新后 GET 的同一状态和之后至少一次真实 browser_action。只重建服务端 entry 不算浏览器刷新。

UI 接管后的 pending 等待只 GET；ensure 必须由真实页面发起。原 `waitForNarrativeP1Generation` 会后台 ensure，不能直接沿用并声称验证了 UI 活性。shared prefix 和 API/replay 路线仍可使用原等待器；增加“UI 不派发时后台不会推进 B”的负例。

该 ready 刷新检查点还须关闭并重开本路线 entry/repository，再由浏览器导航后 GET 读取同一 SQLite，验证语义状态和 revision；以 generationId/revision 关联随后真实操作。单纯 GET 同一内存 entry 不证明持久化恢复。

若刷新时 pending、没有实际导航、hash 变化或之后未能操作，该项 failed/not_run，不由截图或 sentinel 补造。结束页重新加载可作为额外恢复证据，但不能替代中途刷新续接。

UI gate 继续校验 exact expectedRevision 和 interaction。为验收拒绝增加 `layer: acceptance` 与稳定 reason（如 `UI_COMMAND_MISMATCH`），不改变生产 API 对外 code 联合类型；生产 token/revision/规则拒绝分别标识。当前另一个合法选择与路线策略不匹配，不能误记为生产系统 token 失效。

### 9.3 续跑边界

原 runner 进程存活且 gate 尚未结束，可继续当前步骤。进程退出或 batch 信号耗尽，不能再次使用同一输出目录冒充断点续跑。新注册 run 使用新 directory，从同一规则版本的新真实初始化开始，旧部分证据完整保留。

`private.ui-reviewed` 只代表人工检查结束，不能自行让缺失的 browser_action/refresh/terminal 变为通过。public API 路线无需伪造 `.ui.json`。

---

## 10. 数据兼容、失败保留与可观测性

### 10.1 旧记录不修饰（P3R-11）

本次改变规则的解释及投影，不以改版本字段伪装迁移。旧 schema 合法存档可按原加载器读取，但包含原自动目标绑定的 run 不作为新完成依据；新语义完整验收必须新初始化。

不自动推断哪些 `completed` 是错误后回退；没有来源足以安全逆转时保持原始历史，标记历史诊断用途。用户主动需要修复业务存档时另立迁移方案。

### 10.2 文件与计数

新批次保存协议、原始作者/审阅调用、实际预算消耗、逐步 Action 与 A/B 结果、共同初态指纹、每路线 SQLite/runtime/steps、UI 导航/操作/刷新、能力证据与独立签核、严格回放 `replay.json` 和最终汇总。完整大文件留 artifacts，自动化单测只纳入必要、经审批的脱敏切片与原文件 hash。

网络错误应保留，即使随后恢复。不能因 `routes.completed=true` 把失败调用从统计删掉；共享开场计入批次一次，两路文件的调用和不一定等于含共享开场的总调用。

严格回放包含共享 initialization/prefix、private、public 三条 runtime 流及 audit/hash/全部调用和语义状态，不能只封存两路。live 的 private=next_ui；replay 可用记录的实际命令离线驱动生产链，不再启动浏览器，C7 仍验证原 UI 材料。回放不复刻 GET/ensure 壁钟调度，不删业务语义字段掩盖不一致。A 边界从真实成功 CAS 的只读观察获取，不能用与 B 竞争的一次 GET 冒充 A 快照。

日志记录阶段、job/epoch、actionId、candidateHash/version、审阅响应序号、失败归属、已用/剩余额度。模型配置按原运行实际保留；不得将延迟改善承诺成确定收益。

### 10.3 文档职责

实施后将事实更新至 `运行时AI导演与场景表演.md`、`NPC人格知识与关系图.md`、`探索与任务推进.md`、`MVP核心闭环.md`、`日志与追踪.md` 和相关系统文件的原位章节。历史交接文件补充明确的勘误/后续报告链接，不改旧产物。

新报告保存在 `docs/superpowers/reports/`；索引只加必要导航，不堆砌测试成绩或阶段完成状态。

---

## 11. 实施分组与完成门槛

### 11.1 分组

A 组：编译显式绑定、历史依据和审阅分流；B 组：同源 closure、能力证据、真实准入及策略时序；C 组：UI 派发、刷新、协议与完整验收。各组可独立 code review，但最终验收依赖全部组完成，不用多组间互相等待掩盖未覆盖项。

### 11.2 门槛

| 门槛 | 放行条件 |
|---|---|
| G0 可执行基线 | 实际分支/工作区已记录；Node/npm、foundation、本地依赖有效；原测试失败如实保留 |
| G1 规则与审阅 | P3R-01–04 红绿回归通过，真实非空响应切片验证；A/B、权限、未来事件负例通过 |
| G2 验收器可信 | C2 指定目标、C3 同源准入、C4 顺序、缺项状态的独立正负例通过；旧 runtime 不能被升级为新通过 |
| G3 UI 活性与边界 | ensure 未确认重派、确认后仅 GET、失效回调、同 job 单 worker和中途刷新测试通过 |
| G4 工程回归 | typecheck、lint、全量 Vitest、Node journey tests、依赖边界、build 和文档检查完成；环境不足不得替代为语法通过 |
| G5 P3 完整验收 | 新冻结 v2 两路完成、至少一条实际 UI、C1–C8 逐项通过、来源与人工签核齐全、严格回放零新增真实 HTTP |

修复提交完成与 G5 完成分开报告。G4 已完成但尚未获准运行真实 API 时标记“工程修复完成，P3 live/UI 未执行”，不宣称 P3 通过。

---

## 12. 关键源码索引与本次取舍

行号仅是当前基线定位参考；实施时以函数与测试名定位，并记录新提交范围。

| 当前实现入口 | 参考位置/职责 | 对应修复 |
|---|---|---|
| `src/game/application/server/ai/narrativeDraftProjection.ts` | `p3EvidenceGoalBinding` 131–162、编译追加 299–306 | P3R-01 |
| `src/game/application/server/ai/narrativeExecutionChecks.ts` | 历史转移与 prerequisites 37–48；participants 校验 | P3R-02/03 |
| `src/game/application/server/ai/narrativeReviewRules.ts` | `buildNarrativeReviewRules` 历史 item 目录 | P3R-02 |
| `src/game/application/server/ai/liveNarrativeCandidateReview.ts` | `parseReviewVerdict` 与两次 response loop | P3R-03 |
| `src/game/application/generatePendingNarrativeBundle.ts` | 候选修订、失败归属、发布 | P3R-03/11 |
| `src/game/gameplay/rpg/narrativeBundle/descriptors.ts` | `hasPendingDeliveryEvidenceClosure`、`isP3EvidenceClosureContract` | P3R-04 |
| `src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.ts` | 真实合作、知识、披露与证据准入 | P3R-06 |
| `scripts/narrativeP3Journey.mjs` | `p3RouteSatisfied` 311–339、路线策略/共同初态 | P3R-05/06/07 |
| `scripts/narrativeP1Journey.mjs` | 实际 A 步骤、状态读取、证据钩子、收尾 | P3R-06/07/10 |
| `src/game/application/testing/narrativeP3LiveJourney.ts` | 注册、预算、路线汇总、严格回放 | P3R-10 |
| `src/components/CurrentGameScreen.tsx` | pending effect 149–185 | P3R-08 |
| `scripts/narrativeP3UiJourney.mjs` | gate、refresh、finish、进程生命周期 | P3R-09 |

本 Spec 选择修确定性错误和验收遗漏，不扩大剧情质量要求；选择最小改动保留已有架构，不以“重构成多阶段”回避已确认缺陷；选择新语义新批次，不用迁移或重抽删掉失败记录。
