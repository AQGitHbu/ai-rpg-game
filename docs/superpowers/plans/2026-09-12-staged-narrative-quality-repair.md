# 分阶段剧情生成质量修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 定位并修复 choices 首次请求失败，保留可操作的修复反馈，使最终选项、结构化问题和 NPC 回答一致，并安全传递叙事风格。

**Architecture:** 保留 planning → narration / character / choices 的职责分工与事实权限边界；修复现有重试链和安全 DTO。增加决策点发布前的受限对白一致性审核，检查实际文字而非生成器自报的维度。HTTP 根因先通过受控诊断确定，再修改已证明有问题的请求构造层。

**Tech Stack:** TypeScript、Vitest、现有持久化 DAG 调度器、`@ai-game/ai-transport` 公开接口、现有 staged smoke runner。

## Global Constraints

- 本文是独立修复计划；实施已获用户授权，由 subagent 开发、主 agent code review；不修改当前阶段指针，不自动合并分支。
- 实施基线：`staged-narrative-generation`，审阅时 HEAD 为 `82f10a5ad3813bb0f3a3f7c265b4ab3e218327a1`。不改 main 的一次性生成流程。
- 以[设计 Spec](../specs/2026-09-09-staged-narrative-generation-design.md)、[设计原则](../../游戏设计原则.md)和[开发规范](../../游戏开发规范.md)为约束。任务 4 明确扩展原 Spec 的常态请求数量，实施时同步修订 Spec；不得把计划当作已实现事实。
- 不放宽事实权限、JSON schema、选项 80 Unicode 码点限制或 disclosure review；不以确定性剧情、截断问题、删除失败选项、虚构回答代替生成失败。
- 不改 `.foundation` 或受保护 sibling。通用 transport 缺陷按[共享流程](../../共同规范/共享模块开发流程.md)另开 foundation 协同任务；本计划只消费公开接口，不复制 HTTP/重试实现。
- 所有新增 source 调用先扣作业预算再发送；现有 usedRequests 统计 source 调用，底层 HTTP（含 transport 重试）由 client 审计单独计数，验收请求上限在 fetch 入口发送前强制扣减。新增审核角色不启用内部重试，受现有 lease、fence、deadline、取消信号约束；恢复不得抹掉已消耗请求。语义审核不是新的剧情规划器。
- 诊断不记录密钥、请求头、完整 URL、provider 原始错误正文或隐藏世界正文。玩家错误只显示稳定分类和操作建议；内部修复信息只发送给有权看到该上下文的生成器。

## 证据与验收目标

前次真实调用的九组配对样本：main 发布 9/9，staged 发布 8/9；staged 九次首次 choices 请求均为 `http_error`，审计中缺少 HTTP status/body，不能据此认定 token 上限是根因。一次失败样本随后出现错误 discriminator 和超长标签。以下最小复现是本计划的独立测试输入，不依赖本机临时评估目录。

| 问题 | 已观察证据 | 完成条件 |
| --- | --- | --- |
| choices 请求 | 首次参数为 timeout 45000、temperature 0.2、maxTokens 600、json_object、thinking off；同参数后续请求可成功 | 给出可归因的诊断证据、相应层的回归测试及真实复测；未复现只能标记未解决，不能归因为随机波动 |
| 反馈丢失 | `runJob.ts` 只保留 failure.kind；重试审计仍为 initial/0 | HTTP、解析、字段、语义错误可区分；下一次提示包含安全、具体且正确的修复目标 |
| 问题维度漂移 | task 只有 reliability，标签却追加“您是从哪儿听来的？”；下一轮仅回答可信度 | 标签不得新增 source；选中问题的已批准维度在下一轮逐项得到 answer / unknown / refuse，实际文字与声明一致 |
| 风格丢失 | SafeContext.style 仅为 gameType，SafePersona anchors/goals 为空 | 传递合法 narrativeStyle/contentIntensity 和受控说话方式，保留秘密隔离；通过实际文案评估验证效果 |

结构回归样本包括：`{type:"choices",labels:[...]}` 应报告 stage 字段；`{stage:"choices",labels:[...]}` 中 86/106 码点标签分别报告索引、实长与上限 80。不得把 UTF-16 length 当码点数。

## Task 1：定位 choices HTTP 失败并建立可复用证据

**Files:** 修改 `src/game/application/server/ai/staged/liveStageSource.ts`、`src/game/application/server/ai/staged/liveStageSource.test.ts`；新增 `src/game/application/server/ai/staged/requestDiagnostics.ts` 及同名 `.test.ts`；修改 `scripts/stagedNarrativeSmoke.mjs`、`scripts/stagedNarrativeSmoke.node-test.mjs`。先通过 `rg` 定位其使用的 transport factory，只在已确认的 RPG 装配入口注入诊断，不能假定上述 source 自行创建 transport。

- [x] 先写失败测试：用公开 `createOpenAiCompatibleTransport({fetchImpl})` 注入 400/401/429/500、非 JSON 错误、超大响应、网络异常；证明当前路径不能输出定位所需分类。覆盖成功响应不得被诊断消费、取消不被转换为 HTTP 错误。
- [x] 新增仅诊断模式启用的 fetch 观察包装器：返回原 Response；对 clone 的错误流设 8 KiB 读取上限并取消剩余流，仅在内存解析。输出 numeric status、白名单 error code/param、截断标记、stage、请求配置指纹及关联 ID；未知字符串归为 `unknown`，不得原样落盘。不接管 transport 的请求、重试、超时或错误映射。
- [x] 用 mock 断言例如 `{status:400,param:"max_tokens"}` 能被保留，`message` 中秘密 sentinel 和 authorization 不出现在日志；具体 param/code 白名单在代码中封闭定义。没有合法 JSON 时仍保留 status。
- [x] 未来实施时先固定同一安全 choices 输入、模型别名及配置，最多 12 个诊断请求：原请求与精确重放各 3 次，再原提示与现有修复提示各 3 次；记录顺序、配置、结果及 provider 可见的错误分类。每次请求计数，取消即停，不自动拓展额度。精确重放与“重试改了提示”分开统计。
- [x] 根据错误证据只改变一个变量做下一组配对实验（最多 6 请求）。只有 provider 明确拒绝相应参数或配对证据支持时，才调整 choices 的该参数；不得同时提高 token、关闭 JSON、切模型。若 18 请求内无法归因，保留诊断并将 HTTP 修复标记阻塞，其他任务继续；不宣称消除了失败。
- [x] 按归因落地：RPG 请求参数/构造问题在本仓修复并加入精确 request snapshot；认证或环境问题按现有配置手册处理，禁止提交凭据；共享 transport 问题交 foundation 协同并等待公开版本修复。补充受影响文件的确切清单后才能实施该根因补丁。
- [x] 运行 `npx vitest run src/game/application/server/ai/staged/liveStageSource.test.ts src/game/application/server/ai/staged/requestDiagnostics.test.ts` 及 `npm run test:staged-smoke`，确认修复前失败、修复后通过。实施提交建议：`fix(ai): diagnose and correct staged choices requests`；未定位时不得使用声称已修复的提交说明。

## Task 2：传递具体修复反馈与正确重试审计

**Files:** 修改 `src/game/application/narrativeGeneration/runJob.ts`、`runJob.test.ts`、`src/game/application/server/ai/staged/liveStageSource.ts`、`liveStageSource.test.ts`、`src/game/domain/narrativeUnit.ts` 及对应解析测试；复用 `src/game/application/aiGenerationRetry.ts` 的公共函数，必要时追加其测试。不得另造一套 retry 类型。

- [x] 测试失败链：source 返回带 `repairReason` / `repairDetail` 的 `AiSourceFailure`，下一次 execution.repair 必须保留详情；审批拒绝也须带可定位的字段路径。测试错误 stage、labels[1] 超长、HTTP 错误、beat layout，连续两轮不得重用上一轮详情。
- [x] 使用现有 `repairFromSourceFailure` 构造 source 失败反馈；审批失败构造同一 `AiContentRepair`。扩展解析结果的安全 detail（可选字段，兼容现有消费者），只包含字段路径、索引、允许值、实际长度，不包含完整无权限输出。示例目标反馈：

  ```text
  reason: invalid_schema
  rejectionCode: choices_label_length
  detail: labels[1]: 106 Unicode code points; maximum 80. Preserve the approved inquiry aspects.
  ```

- [x] `liveStageSource` 作为审计合并唯一入口，将现有 `aiRepairAuditContext(execution.repair, execution.audit?.retry)` 的返回值合并到 `{ ...execution.audit, retry }`；无 repair 时保留原 retry，保留 jobId/trigger/purpose；`runJob` 不再重复合并。区分内容修复 attempt 与 client transport retry，测试嵌套重试后 origin 仍正确。持久化 reason 使用现有 `persistedAiRepairReason` 白名单，新增稳定代码同步登记。
- [x] HTTP 的 `retryable:false` 不得被表达修复循环当作“改写文案即可修复”：通过现有失败分类立即终止该 unit；可重试传输失败交现有 client 策略，仍失败则显式失败，不再改变提示碰运气。schema/审批错误才走有界内容修复，最多沿用 unit 的 4 次尝试，不额外重置预算。任务 1 的根因解决前这可能降低表面成功率，属于正确暴露失败。
- [x] 玩家保持稳定失败码与可重试操作，不显示 provider 原文、内部 prompt、秘密、完整 repairDetail。现有玩家出口无需改 UI；若要新增分类，仅补安全映射及测试。
- [x] 运行上述定向 Vitest 与 `src/game/application/narrativeGeneration/jobBudget.test.ts`；验证 4 次上限、deadline、审计关联和失败持久化。实施提交建议：`fix(narrative): preserve actionable repair feedback`。

## Task 3：将问题和风格契约传到表达器

**Files:** 修改 `src/game/application/narrativeGeneration/perspectiveContext.ts`、`perspectiveContext.test.ts`、`expressionTask.ts`、`expressionTask.test.ts`；修改 `src/game/application/server/ai/staged/choicePrompt.ts`、`narrationPrompt.ts`、`characterPrompt.ts`、`stagedPrompts.test.ts`、`expressionBoundary.test.ts`。复用 `src/game/application/stylePolicy.ts`；以实现时实际导出类型为准，不复制 setup 规则。

- [x] 先写投影失败测试：SafeOption 除 candidateId/dialogueAct/publicIntentTextPart 外，保留只引用安全 factId 的 `inquiries`；不传规划私有正文或未授权事实。来源是已审批 candidate.task，缺少结构化询问时不从自由文案擅自扩展知识或生成 inquiries。
- [x] 将 choices 的每个标签绑定 candidateId 及已审批 inquiries；前置检查只能拒绝引用或结构冲突；自由 `brief` 与 inquiries 的语义冲突交任务 4 的审核，传入已通过安全投影的 brief，不能让表达器自行裁决或用关键词假装完成语义校验。对纯礼貌语、问候和非询问选项，显式允许无 inquiries，但不得夹带新事实问题。NPC 输入保留已选 task 的问题维度及现有 answers 约束。
- [x] 新增安全呈现字段，包含 validated narrativeStyle（concise/novel/cinematic）、contentIntensity（normal/dark）及可选受控说话方式。通过 `buildStylePolicy` 复用指令生成；无 setup 的旧状态沿用该 helper 的默认语义。人格标签只允许现有六个合法值，未知自由标签不得原样回显。
- [x] SafePersona 新增封闭 `delivery` 枚举集合，例如 sentenceLength: short/neutral/long、register: conversational/neutral/formal、tone: restrained/neutral/humorous。从 speechStyle 仅匹配明确白名单短语，输出枚举，不复制原句；冲突或无匹配取 neutral。保持 anchors/goals 不传私密正文。不要把 narrativeStyle 或 intensity 解释为新增暴力情节、人物目标或事实的许可。
- [x] 测试开场与后续决策均可取得风格；同一安全事实分别产生 concise/cinematic 的不同提示；两个 NPC 的受控 delivery 独立；含秘密 sentinel 的 speechStyle、anchors、goals、未知标签均不进入任何表达 prompt。旧缓存输入须按新 DTO/投影版本重新计算 digest，不能复用旧表达结果冒充已应用风格。
- [x] 运行上述定向 Vitest。实施提交建议：`fix(narrative): project inquiry contracts and safe style`。

## Task 4：实际文案一致性审核与发布门禁

**设计决策：** 单靠结构化镜像、关键词正则或提示不能保证自然语言没有追加问题。因此增加独立、受限的语义审核调用；不是让 choices 自报“已一致”。审核也可能误判，需留 uncertain、反例回归和人工抽评，不能称为数学保证。它不替代事实/disclosure 审批，不审批私密事实，不创造回答。

**Files:** 修改 `src/game/application/server/ai/rpgAiClient.ts`、`rpgAiClient.test.ts`、`textAuditTypes.ts` 及审计测试；新增 `src/game/application/narrativeGeneration/dialogueConsistencyReview.ts`、`dialogueConsistencyReview.test.ts`；修改 `stageSource.ts`、`runJob.ts`、`runJob.test.ts`、`publishJob.ts`、`publishJob.test.ts`、`jobBudget.test.ts`；扩展 `src/game/application/server/persistence/narrativeJobRepository.ts` 的持久化类型、`sqliteNarrativeJobs.ts` 的解析/保存及相应测试，不另建并行 store；修改 `src/game/application/server/ai/staged/liveStageSource.ts`、新增 `dialogueConsistencyReviewPrompt.ts` 及测试；新增 `dialogueConsistencyRetry.test.ts`。复用现有 disclosure review 的持久化门禁模式，不复用其通过凭证。

- [x] 先加入两类失败用例：reliability-only 标签追加“从哪儿听来”；玩家实际问 source+reliability，NPC 声称两个 unknown、文字却只回应 reliability。加入肯定句提及“来源”但并非询问的反例，防止关键词假阳性；礼貌语不新增维度。
- [x] 定义并实现新增契约：`StageSource.reviewDialogueConsistency(request, execution)` 返回结构化 verdict pass/reject/uncertain，reject 包含 bounded violations：candidateId 或 unitKey、类型 extra_inquiry/missing_response/answer_mismatch/intent_mismatch、对应 aspect。模型不返回改写剧情或可执行指令。缺方法在 live staged 路径是配置失败，不能默认 pass；测试 source 显式实现。
- [x] 构造 request：当前决策点的实际 NPC 文案、最终 labels、已批准的 inquiry/answer 契约、安全投影的 brief、必要的玩家可见前文和安全 fact 摘要。每条 label 按 candidateId 绑定；核对新增/缺失问题及意图。对本轮 NPC 回答检查选中问题的每个维度，其实际 answer/unknown/refuse 必须与授权计划一致。旧 published 选项不得静默重写 task：先检查历史 label 与 task；不一致返回 `legacy_dialogue_contract_mismatch`，提示显式重生成，不能直接把新问题算作已授权知识。
- [x] 新增 `dialogue_consistency_review` role，登记 RPG_AI_ROLES、默认策略与 AiTextAuditRole；默认 thinking off、temperature 0、json_object、maxTokens 800、timeout 30000ms、maxAttempts 1，remaining deadline 优先。每次最多 8 条 violations；request JSON 上限 16000 Unicode 码点，超限返回显式 context_limit，不截掉待核对文字。调用使用与 staged 相同模型别名及取消信号，审核提示由独立 prompt 文件维护。测试 role 路由、配置覆盖不得提高 attempts、非法 verdict、超长结果与审计关联。
- [x] 当前 PlanProposal 每 job 至多一个 decision，审核范围为本 job 的可见对白和候选。无 decision 但存在对上一轮问题的 NPC 回答（包括 ending/null）仍需审核；无候选且无待回答问题时由确定性谓词判定不需审核，发布端重算同一谓词，baseline 不增加。不存在多决策点调度任务。
- [x] 在该决策点所有普通审批及 disclosure review 通过后、发布前发一次合并审核；审核结果不得成为旁白或其他人物的新事实来源。reject 只使被定位的表达单元失效并沿 DAG 清除依赖输出；下一次生成用安全具体反馈，复核整个受影响决策点。若是计划内部 brief/inquiries 或授权回答矛盾，标记 planning contract 失败，结束本 cycle，走现有显式重试，不让润色器修改计划。
- [x] 审核最多 2 次/job/cycle（首次+修复后复核），都计入现有 job 请求总账，新增其 baseline 计数但不提高 extraRequests 12 或 unit 4 次上限；超过剩余预算/截止时间就失败。uncertain、审核 schema 错误或请求失败均不可发布；只允许在剩余审核次数内重试，不启用无限内层修复。需要审核时 baseline 只增加 1，二次审核消耗 extraRequests；在批准计划后一次性设置 baseline，恢复时从计划计算目标值，禁止累加。测试 decision、ending/null 有待答问题、无审核三种预算。
- [x] 在 StoredJob 新增可选 dialogueConsistencyReview 对象（跨单元，不挂某个 StoredUnit）：version、cycle、inputDigest、attempts、status（pending/running/approved/failed/unknown）、passDigest?。每次调用前在同一 fence 保存中增加 attempts 与 usedRequests 并写 running；失败/重启清凭证但不清 attempts，同 cycle 达 2 次就失败。输入变化只清 pass/status、不重置计数；新 cycle 初始化新审核状态。新增审核 receipt，绑定审核契约版本、plan/unit 输入 digest、实际输出、候选顺序/ID、被选历史 label、问题与回答契约。仅对 pass 存储 digest；lease/fence 下持久化，发布事务重新计算验证，不在 publish 内调用 API。改一字、换候选、改风格、替换依赖或过期 receipt 均必须失效；恢复复用完全匹配凭证，unknown 在途请求保留 charge 后有界重做。
- [x] 存储新增字段可选以兼容旧数据解析；旧未发布 job 无凭证必须审核或按投影版本失效后重建，不一律批准；已发布 bundle 不追溯撤销，但新一轮按历史不一致规则处理。手动 retry 新 cycle 的计数语义沿现有机制，审计保留累计成本，不能把旧结果视为新审核。
- [x] 测试 fake reviewer 的 pass/reject/uncertain、超时、取消、重启、fence 竞争、digest 篡改、decision/ending/null 预算、旧 job。mock 用于证明调度门禁，不作为语义准确率证据；真实审核模型的漏报/误报由任务 5 验证。
- [x] 运行上述定向 Vitest、`disclosureReview.test.ts`、`dialogueContinuity.test.ts`、`dialogueContinuityRetry.test.ts`、`publishedBranches.test.ts`。实施提交建议：`feat(narrative): gate publication on dialogue consistency`。

## Task 5：真实验收、文档同步与交付

**Files:** 实施时修改原设计 Spec 及由[文档索引](../../Agent文档索引.md)定位的 staged 运行/系统契约文档；报告存 ignored `tmp/`，不更改当前阶段指针。可扩展现有 staged smoke runner 的诊断/样本模式，不建立平行生产生成链。

- [x] 先运行定向测试、`npm run typecheck`、`npm run test:boundaries`、`npm run check:docs`；随后运行 `npm run accept`，区分本变更失败与已有环境阻塞。完成前逐项记录未解决问题，不以通过单测取代真实质量证据。
- [x] 固定 3 个题材（武侠、都市、科幻）各开场 + 两个独立分支，9 个发布任务；从相同 setup/起始状态复制，保留模型及生成参数，记录每一类请求、重试、审核、耗时和 token。最多 90 个底层实际 API 请求（包含 transport 重试）；达到上限停止并报告样本缺失，不降低审核标准。任务 1 的 18 请求诊断额度单独报告。真实验收已随本轮实施获授权，严格遵守请求上限和独立数据目录。
- [x] 另用固定最小文本对照检验审核模型：12 条（4 正常、4 多余问题、4 缺答/回答不一致），最多 12 个实际请求，覆盖直接/间接问法与误报反例。每次 prompt 版本和失败均记录，不以修改样本来提高成绩。小样本只能作为上线门槛，不能声称统计显著或全面解决。
- [ ] 人工对隐藏模式标记的可见文案评分：连贯性、角色归属、问题覆盖、风格各 1–5 分；逐条引用证据。硬门槛：9/9 发布、零已确认串台/越权、所有抽检标签与 inquiries 相符、问题逐维响应；四维平均各 ≥4 且无 <3 分项。审核对照零漏报、最多 1 个误报；不达标继续定位，不能只按平均分宣告成功。
- [x] choices HTTP 单独报告首次与重试失败率及根因证据；9 个样本零错误仅说明本轮未复现。效率独立报告，不用成本掩盖质量失败；对比此前 9 组样本时注明生成内容非逐状态完全一致，且新增审核提高正常调用数。
- [x] 同步 Spec 的请求拓扑、审核能力边界、预算与恢复规则；系统文档记契约，operations 记诊断及安全错误解释，报告记成绩。实现按五个 Task 分开评审；全部验收结束后再汇总交付，不自动合并。

## Plan 编写阶段交付检查

- [x] 独立 subagent 只读审查四项需求覆盖、接口来源、预算与恢复可行性、隐私边界、验收是否能证伪；作者修订发现的问题。
- [x] 在目标 worktree 运行 `npm run check:docs`、`git diff --check`，确认变更只有本文；不执行以上实现任务，不调用真实 API。

## 实施验收记录

- Task 1：55daf20a；12 次真实 HTTP 诊断，缺 JSON 指令 9 次 400，补指令 3 次 200。安全证据位于本工作区 tmp/task-1-choices-http-diagnostics.json；28 项定向测试及 32 项 smoke 脚本测试通过。
- Task 2：12b85bca；主 agent 审查修复手动审计标记、稳定原因持久化与失败分类，74 项定向测试通过；全量回归 3132 项通过、4 项门禁跳过。
- Task 3：c94f0335；主 agent 审查修复否定风格、开局投影/缓存恢复测试与默认规则重复；108 项定向测试通过。全量回归发现 1 项旧可信度措辞断言，交 Task 4 集成修正；其余 3139 项通过。
- Task 4：5f859d1d；主 agent 审查修复原子失效、SQLite 恢复摘要、历史契约安全投影和无候选回应门禁；425 项定向、3200 项全量、127 项边界通过（全量之后另加 3 条用例已在定向通过）。真实模型准确性待 Task 5。
- Task 5：固定真实验收已执行，42/90 次剧情 HTTP、12/12 次审核对照 HTTP，无额外重采样。5/9 发布（武侠 3、科幻 2；科幻分支失败、都市开场失败、都市两分支未启动）。本轮 HTTP 错误为 0，但 6 次首次 choices 内容 stage 错误、后续修复成功。审核粗分类 12/12，选项错误 scope 错归因 4 条；已发布文本仍有意图/问题合同漏检，另有行动提议和先核实条件的误报。主 agent 文本评分均值 4.0/5.0/3.0/4.0，非独立真人盲评；真实质量门槛未通过。
- 后验修复：纠正具体 certainty 反馈，统一隐式观察上限的安全投影，完整校验旧历史任务引用，保留先核实条件，调整 choices 输出字段及审核归因提示；审核政策 revision 纳入凭据摘要，旧通过凭据不能冒充新规则已审。代码与离线回归由主 agent 复核；最终修复版未追加真实 API 复验，不能沿用前版成绩宣称质量通过。
- 证据：本 worktree 的 tmp/staged-quality-acceptance/quality-review.md（逐条文本评分）、root-code-review.md（代码审查）、preregistered.json（固定样本与版本）、http.jsonl（实际请求计数）及各任务审计；Task 5 最终 npm run accept exit 0：3209 项测试通过、4 项 gated live 跳过，127 项边界测试通过，类型检查、文档门禁和构建通过；无新的真实 API 请求。
