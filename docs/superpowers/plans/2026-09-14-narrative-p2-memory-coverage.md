# Narrative P2 Memory Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完整小故事的质量门禁通过后，以有限、有具体目的的玩家追问形成自然经历，验证交付前的两批摘要、旧事召回、权限与终局质量。

**Architecture:** 复用正式 create/performTurn/ensure、SQLite、摘要与严格回放；驱动增加有界议题日程和阶段门禁。自由追问不代替正式推进，不通过扩大模型输出 fixture 获得覆盖。

**Tech Stack:** TypeScript、Vitest、Node.js SQLite、现有 P2 register/live/replay 与 UI 入口。

## Global Constraints

- 首要产物是一篇真实生成的三幕小故事及全文质量结论。现有 A 驱动已通过生产链离线验证，收尾当前修改后即可冻结并执行 A；Task 2 的两臂/UI 接续和 Task 3 的紧凑记忆覆盖不再作为 A 的前置条件，仅在 A 质量通过后按收益决定继续。
- 保持 EntityStore3 / World7 / Story12、整场作者、现有单次 reviewer 和生产失败策略。不动 main、staged、`.foundation` 或阶段指针。
- 原 p2-01 产物与协议保持。新行为登记 `narrative-p2/v2`，拒绝用新代码重解释 v1 磁带；需要检查旧证据时使用原冻结实现。
- 摘要阈值 50、每批 10、每 job 最多两批/8 次摘要 HTTP；三版候选与24次叙事 HTTP保持。不能改变有效 History 定义、拆段计数、注入 History、重复问题或强制长回答凑量。
- 保持模型别名 `ai-slg-game-model`、64,000 输入估算上限及原 transport 参数。实际上游 DeepSeek v4.1 Flash/1M 是用户确认的部署信息，不宣称 `/models` 已验证容量。
- 两阶段合计计划两条完整路线，各一次；失败保留分母，不换种子补跑。两臂诊断不计入完整路线。阶段状态与未执行项必须明确。每条路线从首次初始化起使用登记的绝对截止时间；服务/UI 重启和人工等待都继续消耗该路线的 wall-clock 预算，不能暂停、续期或重新起算。A 的全文审阅发生在 B 初始化之前，因此等待 A 审阅时 B 尚未开始计时。

## 规划依据与完成定义

p2-01 短篇10次行动形成32条有效 History；中篇16次行动形成49条，交付前后记录分别仍不足以形成预定两批摘要，详见 [真实验收](../reports/2026-09-14-narrative-p2-acceptance.md)。中篇正式驱动此前只选择最快完成路线，摘要尚未形成就结束；离线 fixture 的158条不能代表真实互动密度。

另一个结构问题是自由文本被转换为 `talk/ask/utterance` 后也消耗两轮对话计数。前置剧情修复将追问和正式回应分开，首次追问仍建立会话以防 `met=true` 绕过任务条件；本页必须用真实生产路径确认该前提，不能靠驱动改 StoryState 暂停换幕。

计数式摘要在常见无长度提前触发路径上需要累计至少60条**可选编**原文，才可能先后形成两个10条批次；这只是路线容量估算，不保证在同一 job 内形成两批。`prepareNarrativeMemory` 每个 observer 在一次 job 准备中最多发布一批，因此 player 的两批必须由至少两个不同 preparation job 分别成功发布；当前 job 受保护原文不计入候选，NPC observer 也不能代替 player 覆盖。70条仅作路线容量估算，实际准入看两个不同 player preparation job 的有效发布、水位和旧来源覆盖。至多15次独立追问若各产生玩家和 NPC 两条有效原文，能增加约30条经历；这个估算不保证模型输出、批次发布或实际覆盖成功。

| 阶段 | 路线与预算 | 目的与门禁 |
| --- | --- | --- |
| A | S-short，3幕，24动作/200 HTTP/90分钟 | 一次完整小故事，正式选项优先；不要求摘要。阅读全文、无事实/权限/行动硬错误，五维均分≥4且单维≥3，严格回放通过。 |
| B | M-medium，5幕，48动作/500 HTTP/180分钟 | 仅在A通过后执行；在既有正式推进间插入下表15个有限议题。交付前形成两批 player 摘要并完成旧事追问，然后唯一真实交付和合法结局；同样阅读全文评分。 |

A 未通过时保留短篇失败与中篇“计划但未执行”，整批不通过。不能把未执行中篇算成成功，也不为缺少记忆覆盖跳过短篇质量问题。

## Task 1：升级协议和议题选择器

**Files:** `src/game/application/testing/narrativeP2Journey.ts`、`scripts/narrativeP2Journey.mjs`、`scripts/narrativeP2Production.mjs`；新增有界议题选择器及各自测试。

**Interfaces:** v2 登记输入、代码/配置 hash、阶段顺序、议题表与选择规则、总/分支预算、固定 recall 文本、oracle 选择规则、UI 接续计划。`register` 仍零网络；阶段结果与质量审阅产物需绑定同一协议、磁带和代码 hash。B 读取显式 A 审阅通过证据，不凭一个可随意传入的 `passed:true` 参数执行。运行身份和接续状态只写入现有 v2 journey 输出目录中的 route manifest，不引入通用运行子系统：manifest 至少含协议/代码/输入/来源 hash、不可复用的 routeAttemptId、阶段与生命周期状态、初始化时间和绝对 deadline、已用 action/logical/transport/summary HTTP/批更新计数、tape cursor、revision、pending actionId、审计流和产物 hash。每次动作、HTTP 预留、摘要批更新与状态切换先原子持久化再执行；resume 校验 hash/revision/cursor 和未消费 actionId 后以 CAS 前进，任何缺项、回退、重复初始化、过期 deadline 或已消费 actionId 都 fail closed。

- [x] 分开 A/B 执行入口与结果文件，防止阶段暂停被当作可覆盖既有输出；同一阶段只允许一次初始化。实现 route manifest 的 `registered → running → awaiting_review|awaiting_ui → running → sealed_pass|sealed_fail` 单向转换；A review 等待不启动 B，B 的绝对 deadline 一旦初始化即包含 UI 操作和人工等待。机器门禁读取运行/回放结果，人工质量记录附候选/History引用与分维理由。
- [x] A 审阅产物采用固定 schema：`routeAttemptId`、protocol/code/input hash、terminal state/tape/完整 History hash、审阅者与时间、五个已命名维度分数、每维候选/History ID 引文、确认硬错误列表和 verdict。B 入口重新计算机器结果、严格回放及上述 hash，只接受均分≥4、每维≥3、硬错误为空且 verdict=pass 的未篡改产物；失败审阅封存 A 并保持 B `not_executed`，不能改写审阅或重跑 A 解锁。
- [x] 选择器只读当前 act、合法焦点、公开状态、已提交议题清单；每幕按下表顺序各问一次，在第一次正式推进回应前完成。焦点必须来自当前 view 的 `freeInputEnabled`，不得直接指定未来 NPC ID、隐藏名字或私密信息。

| 幕/议题ID | 固定输入文本 |
| --- | --- |
| 1-reason | 这次递送为什么值得做？你最想解决的具体问题是什么？ |
| 1-cost | 如果信没能送到，具体谁会受到什么影响？你不知道的部分也请直说。 |
| 1-boundary | 我能替你完成的是递送。还有哪些事必须留给接收人决定，不能由我替他答应？ |
| 2-stake | 站在你自己的处境看，这次递送与你有什么关系？ |
| 2-objection | 对这件事，你具体赞成或担心哪一点？理由是什么？ |
| 2-basis | 你的判断有哪些你自己知道的依据，哪些只是推测？ |
| 3-change | 听了你的看法，我对这封信的处置需要重新考虑什么？ |
| 3-alternative | 如果不按你倾向的方式处理，会有什么具体代价？没有别的办法也请说明。 |
| 3-limit | 你能亲自负责哪部分，哪些结果你无法保证？ |
| 4-risk | 接近交付时，有什么实际风险需要我向接收人说明？ |
| 4-evidence | 关于这个风险，有什么可以当面核对的依据？如果没有，请不要替别人作证。 |
| 4-decision | 哪个分歧需要由接收人来回答，而不能仅靠我把信送到就算解决？ |
| 5-response | 在我交付前，你对这次递送的理由有什么具体回应？不知道的请直说。 |
| 5-responsibility | 你收到信后愿意承担哪部分责任？哪些仍需要其他人同意？ |
| 5-unresolved | 即使这次交付完成，我们刚才谈到的问题里还有哪些没有解决？ |

议题不预置冲突答案，不暗示一定有反派、秘密或新事件；NPC 必须可以说明无此风险或不知道。不同意见的实际内容由故事产生，验收人员检查这些回答是否具有新增信息，不能仅按完成15个请求认定玩法改善。

- [x] 每次正式 `performTurn` 成功后登记 `(act, topicId, actionId, npcId)`，reload 从已提交步骤恢复；失败不把议题标为已完成，也不生成新 actionId 隐形重试。每幕至多按表中顺序问三次、全程至多15个不同议题，问完再使用原正式选项策略；不因 History 少而追加第4次问题或替换已跳过的问题。
- [x] 每个回答由登记路线的人工质量审阅记录 story-grounded 引文和判断，不增加 provider/judge 调用，也不使用关键词或长度规则。若回答与已问内容实质重复、没有故事依据或该故事确实无可回答内容，则停止该幕剩余议题并记录适用性/质量失败；剩余议题不替换、不挪到别幕，路线继续原正式选择至有限终局并保留失败分母。
- [x] 议题前后验证 currentAct、当前任务与 dialogueSession：追问可以写真实交互，但不会独自完成 talk 目标；两个正式回应仍可换幕。缺少合法焦点或必需议题窗口直接报告路线适用性/覆盖失败，禁止构造 token、回滚剧情或修改计数。
- [x] 选择器不向模型提交完成位和计数提示，不要求指定字数、段数或引用早话；步骤证据单独记录有效 History 增量、摘要水位、候选次数和所有用途 HTTP。

## Task 2：有界追问、同源诊断和 UI 接续

**Files:** `scripts/narrativeP2Production.mjs`、P2覆盖/回放 helper及测试、现有 UI 调用的验收 adapter。

- [ ] 开局后固定 oracle 为第一条玩家可见的开场 NPC History，保存其 ID、speaker/audience、原文 hash、turn/act。不后选更容易命中的句子；若该条没有可评估的信息则记录样本限制，不改 oracle 或再抽开局。
- [ ] 完成本幕预登记议题后，第一次满足以下全部条件的合法 ready 才触发一次 recall：act≥3，未交付；至少两个不同 preparation job 已分别为 player 发布有效摘要批；oracle.sequence≤coveredThroughSequence；距开局≥2幕或≥8次实际行动；当前焦点 `freeInputEnabled=true`；该次新 job 在预算和绝对 deadline 内。保存两个 preparation job ID、覆盖批 ID/水位/来源指纹，不仅检查缓存行存在。p2-01 M-medium 的只读投影已验证 act5 的 `ready:12` 在交付前仍有 `npc_dyn_4.freeInputEnabled=true`，即使 `currentScene.choices=0`；因此最终幕问题只依赖真实 free-input 权限，问完后再使用既有 give choice，不额外要求两条正式 talk choice。
- [ ] 固定 recall 文本沿用“最初委托人对这封信说过什么？我想先回想原话，再决定是否交付。”不将 oracle 正文、答案、隐藏事实或旧 speaker 的知识注入输入。核查实际作者请求原话命中与输出中动机/条件保真，当前 NPC 可以承认未亲历。
- [ ] 达到第5幕最后可用的交付前窗口仍不满足时，以 `P2_MEMORY_COVERAGE_FAILED` 记录失败；继续既有正式选择至有限预算内的终局以收集质量，不追加问题或扩大预算。不能把结局之后产生的摘要用于证明交付前覆盖。
- [ ] 从同一 ready SQLite/source hash 复制两臂，各最多1 job/50 HTTP/45分钟，唯一变量 summary enabled/disabled；真实请求需包含相同旧事输入，保持规则、原始来源、检索与权限相同。每臂固定记录 prepared history/event ID 与 source kind、oracle 进入作者请求的路径（raw/overview/recall/mandatory/absent）、回答中的 claim 与所引 evidence ID、动机/条件保真判断、权限错误及请求长度。两臂真实且无权限错误是正确性门槛；enabled 臂另须证明已覆盖来源可恢复且回答保真，长度只作测量、不能抵消内容损害。不能只比较字符串出现即宣布效果通过，也不能要求 disabled 臂失败来制造收益。
- [ ] 记录 oracle 是否被 overview 省略。若没有省略，这次实跑只能证明跨摘要覆盖的旧话可用；“概览省略仍能召回”的必要性由已有明确省略的离线回归证明，不能事后改概览或换 oracle 冒充实跑证据。
- [ ] 主路线在 checkpoint 写盘后立即进入 `awaiting_ui` 并停止，不能在 driver/API 代交 recall；两臂只读同一 checkpoint 的独立副本，不能改变主库或主路线 tape cursor。真实 UI 独占主路线的旧事输入、刷新和继续至终局：首个 UI 命令必须匹配预登记的 actionId、revision、targetNpcId 与 recall 文本 hash，resume 读取已记录 UI/API 命令后继续。接续须校验协议、数据库/source hash、revision、tape cursor、未消费 actionId、累计计数和绝对 deadline；服务重启及人工等待不得重置或暂停预算。重复提交、driver 替代提交、过期接续或缺失证据均封存失败；没有该能力就保持 UI 项未执行，不能另跑未登记路线或重复计算已提交行动。
- [ ] 两臂使用独立副本，不能污染主路线；主路线提交与消费各一次。记录 UI 事件、正式API命令、刷新前后状态和终局，截图只是辅助。route manifest 同时记录实际运行与人工等待区间，但两者都计入从 B 初始化时间起的同一个绝对 deadline；不能冻结时暂停、实跑中延长或重启后重算。

## Task 3：稀疏自然回应的离线准入

**Files:** `src/game/application/testing/narrativeP2Journey.integration.test.ts` / `narrativeP2Journey.testutil.ts`、`scripts/narrativeP2Journey.node-test.mjs`，相关规则/回放测试。

- [ ] 新建紧凑响应 fixture：每次仅生成契约必要的玩家回应、NPC直接答复和必要叙述；每个议题答案不同且有原因/边界，不复制长段正文扩增 History。既有158条 fixture 保留为检索回归，不能用它充当新覆盖可行性证据。
- [ ] 用正式 create→追问→正式选项→摘要→recall→give_item→ending，验证至多15个不同议题各不超过一次、追问不耗尽正式会话、至少两个不同 preparation job 在交付前分别发布 player 批次并覆盖 oracle，源与实际请求一致。fixture 的正常路径让15题都有不同且有依据的回答；另覆盖人工引文判定早停后的未问议题不替换、路线保留失败。若最小响应路径达不到覆盖，先承认方案失败并修订玩法日程设计，不修改计数阈值救测试。
- [ ] 覆盖焦点缺失、仅一个 player preparation job、已交付才达水位、摘要失败、绝对 deadline 在 UI 等待中耗尽、计数/cursor 回退、重复恢复/执行、A质量未过或审阅 hash/引文不匹配、不同代码/协议、缺审阅证据、driver 代交 recall、未执行UI等拒绝用例；确认终局合法不掩盖覆盖失败。
- [ ] 完整严格 replay 必须消费全部响应且验证正式状态、cache水位与preparedHash；UI暂停与两臂流同样纳入记录。篡改议题顺序、oracle、文本、当前状态或预算恢复不得通过。
- [ ] 执行受影响测试、typecheck、P2脚本测试、check:docs、生产 build；协议和报告明确技术回归与语义质量的证明边界。

## Task 4：新冻结批次与 P2 判定

**Files:** 新批次的协议/磁带/报告，原 P2 Plan 的验收 gate。

执行证据见 [p2-02 短篇实跑](../reports/2026-09-14-narrative-p2-short-story.md)：A 在第二次行动后的生成失败，未形成完整故事、未完成严格回放；B 未执行。下列完整验收项保持未完成。当前先处理真实文本暴露的当前事实与未来续接边界，Task 2/3 暂缓。

### 当前聚焦修正：同包内容的生效时点

只修改 `narrativeContext/narrativeBundleContext.ts` 的共享上下文与 `narrativeExecutionChecks.test.ts`，在运行时 AI 系统文档维护契约。已有 `compileDecisionNarrativeContext` 为 author/reviewer 提供同一 mandatory 时序块：当前 Action/地点约束 currentScene 和 beatSummary；续接正文仅在对应 trigger 成功后成立；条件结局仅在对应立场行动后成立。不改 DTO、存档、候选预算或校验门禁。

- [x] 回归普通换幕（没有 endingResolutions）也向 author/reviewer 提供相同的当前行动与摘要范围；同一未来抵达抽取在续接槽通过、在摘要处被拒绝。
- [x] 实现上述共享时序块，并删除条件结局块中重复的摘要规则；运行相关测试、typecheck、boundaries 和 docs 检查。
- [x] 冻结新批次，执行一次 A，读取实际全文；失败保留原始证据，不推进 B。只有完整故事成立才恢复记忆任务。见 [p2-03 时序修正实跑](../reports/2026-09-14-narrative-p2-temporal-scope.md)：越过换幕，第四次行动后的审阅失败，完整故事仍未成立。

- [ ] 固定同一代码、模型/配置、A/B输入及议题、oracle规则、预算、route manifest schema、绝对 deadline 和 UI 接续口径，优先运行A并严格回放、按固定 hash-bound schema 独立阅读全文；A 不等待完整中篇、两臂或 UI 接续实现；不通过则封存，B保持未执行且尚未启动 deadline。
- [ ] A通过后按登记执行B、两臂与UI，不修改配置或追加议题；按完整History核查明确利害、具体分歧、选择回应与有限收束。游戏通关与未解决的社会问题分别记录。
- [ ] 报告分别给出运行正确性、故事质量、记忆覆盖/准确性、UI完成性：每条质量均分≥4、单维≥3且无确认硬错误；摘要臂保留必需来源、无新增事实/权限错误，不能用省token抵消损害。
- [ ] 描述哪次早期经历实际帮助理解人物或决定如何交付；仅复述正确原句不能单独证明游戏性提升。未覆盖项与失败留在结果中，不宣称已经优于main或自动合并。
