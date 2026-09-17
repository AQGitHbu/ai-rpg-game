# P3 修复设计本地源码复核

## 结论与范围

原根因分析的主要方向正确，但交接中的“规则已通过，只差 UI 收尾”不足以作为 P3 总结论。原修复 Spec/Plan 也不能直接执行：其中包含合法分享永远无法关闭证据门、预览权限冒充历史权限、合作 gate 未进入选项链、能力只有末端检查，以及验收采集和 UI/replay 缺口。本次原位修订 Spec/Plan；没有实施生产补丁，没有运行新的真实 API/UI 批次，P3 尚未完成。

核查工作区为 `.worktrees/narrative-architecture`，分支 `codex/narrative-architecture`，HEAD `b93c7542b0aafe2efe290e052d051b01d5c145b0`。开始时两份修复文档已暂存，根因分析与交接为未跟踪文件；本次保留这些已有内容与暂存状态，不提交、不清理旧 artifacts、不修改阶段指针或 foundation。

输入为用户指定的四份文档，其中分析文档实际位于 `docs/P3_源码根因分析与修复方案.md`，不是 `docs/P3/_源码根因分析与修复方案.md`。历史 runtime 指纹起始提交是 `f79479a35c81e3bd91633072425e85565d486ad3`，因此不把历史记录当作当前 HEAD 的新验收。原分析引用的独立 ZIP 复现脚本/索引未全部包含在本次四份材料中，本次未声称重跑那 12 项。

## 原分析中成立的部分

| 判断 | 当前源码/记录 | 核查结论 |
|---|---|---|
| 编译器自动补目标条件 | `narrativeDraftProjection.ts/p3EvidenceGoalBinding` 找第一个 active 且无 resolution 的目标，补 knows_fact | 成立；这不是纯引用编译，删除是正确方向 |
| 历史核验不能作为审阅前提 | `narrativeExecutionChecks.ts` 的历史依据来自 item transfer；`narrativeReviewRules.ts` 历史 event 同样限于物品 | 成立；需要补统一可见历史目录 |
| player 被放入 NPC participants 后错误归为候选缺陷 | `validateNarrativeExecutionChecks` 仅检查非空字符串，然后在 NPC 表查位置 | 成立；应同 candidateHash 修复 reviewer 响应，保留真实 NPC 越权拒绝 |
| C3/C4 验收过宽 | `p3RouteSatisfied` 无两路 guard 对比，策略采用 nextIndex !== index；live44 fork 两个 NPC 都无 cooperationDefinitions | 成立；两条成功结局不能证明合作分化和策略先后关系 |
| ensure 派发可能失去活性 | `CurrentGameScreen` 在 await ensure 前写 observedPendingJobKey，失败后只 GET | 成立；但不能据此认定历史 action14 就遇到了它 |
| A/B/CAS 主干应保留 | `generatePendingNarrativeBundle` 的非缺陷失败停止作者修订；真实 resolver/SQLite 管理行动与提交 | 修复应沿主干，不需要换引擎或放宽规则 |

原 C7 要求至少一条实际 UI；private UI/public API 合法。“public 还没跑”是当前批次缺项，不等于必须再做第二条 UI。

## 原修复方案必须更正的缺口

### 1. 分享事件角色条件会把全部合法链判为未完成

原 Plan Task 5 要求 `share.actorIds` 同时含 player/giver。实际 `resolveStoryInteraction.ts/baseInteractionDraft` 对 share 生成 actor=[player]、target=[giver]。live44 private action6 的原始事件也是如此，action7 核验才是 actor=[player,giver]、target=[player]。

本次直接读取原 before8，得到 player actor=true、giver actor=false、giver target=true。原算法会跳过这笔合法分享。修订按 operation 核对 actor/target，并要求先以原始合法链做正例，禁止改历史来迎合测试。

### 2. giver 引用的任意事实并集不是递送关联

原 Spec 把 giver 任意 goal complete/block 条件与 cooperation.allowedFactIds 并集当作关联集合，无关支线也能满足。修订以已批准主线 discover_fact objective 与 giver 显式引用交集识别唯一调查事实；历史主线 objective 保留后仍可关联。缺失/多义在调查发布前拒绝，不能拖到递送才永久 pending。

### 3. generationContract 不是已提交历史快照

`approveNarrativeBundle` 先运行 `previewNarrativeDisclosure` 并替换本地 world/story，最后再返回 generationContract。该状态的 ledger 可以仍为原账本，但 NPC 知识、目标和任务已被本候选预览改变。用它调用 projectObserverEvidence 会把候选权限当作历史权限；仅过滤 event sequence 不够。

修订由编排器传入预审批前 record 的 committedState，历史与权限仅从该值投影，缺失在 HTTP 前 fail closed。保持 disclosure preview 用于本候选生成图，不把它删掉。

### 4. 历史事件可见不等于 payload 全公开

原 Task 2 将 evidenceQuality 写入公共审阅目录，与现有 storyConsequenceContext 的质量/隐藏条件隔离不符；projectObserverEvidence 的事件过滤也不替代 payload 内每个引用的授权。修订字段白名单及 payload 引用核验，质量只留在规则与受限验收。

### 5. 只提取 resolver 不会使实际选项遵守合作条件

`descriptors.ts/preparedNpcContext` 与 `storyConsequenceContext.activeInteractionIds` 目前只检查 interaction.condition。原 Task 6 仅修改 resolver，不能实现它要求的“拒绝路不暴露该合作”。修订把共用 gate 接到这些生产投影，保留未来到达槽的预演位置，并以正式批准 choice/registry/UI/实际执行做一致性回归。

### 6. 只有 prompt 追加与末端失败，不能让缺能力的故事收敛

删除自动目标补写是必要的；但原方案只在测试输入末尾加文字，再在 fork/终局要求显式目标和合作，没有把能力要求与缺项修订接入调查发布前的审批。新增 Task 6A：调查同包创建现场 NPC 的有限目标并显式绑定，giver 以明确知识前提控制核验，发布前检查覆盖，沿原三版预算修订。C2 不再依赖 writer 猜测旧 giver 私有目标含义；不补写目标、不自动重抽。

共同前缀实际先走到 `investigation-fork` 再复制 SQLite，不是在 town 初始化时就具备未来 scene。检查必须放对时点。合作检查点之后，允许路先执行对应合作，再离场回访；旧选择优先级可能先把玩家带离现场。旧“private 调查前可输入就等待策略”的分支还会与新 after-share 输入时机冲突，已明确删除。

### 7. 原能力模型仍可能制造假阳性或错误缺项状态

原 C3 只检查两条 afterActions 含旧 sourceEventId，没有检查它们发生在检查点/成功合作之后，也不检查实际后果状态；append-only ledger 留着事件不等于后果保留。原 routeCompleted 布尔数组又把 not_run 变成 failed。

修订时序、状态/provenance 验证及 routeId/status 模型；C1/C5/C6/C7/C8 补明确来源与判据。文件 hash 和 pointer 存在只证明材料身份，不能证明预填 allowed/passed 正确；汇总必须读取源值重算，包含篡改结论并重新计算 hash 仍应失败的测试。

### 8. 采集接口缺少数据入口与一致性边界

原 collector 只有 ready/after_action/terminal，无法取得 fork；没有原作者调用/批准符号表输入，却要求比较 raw 与 approved hash。新增 fork hook、收尾后的三流读取和真实编译符号映射来源。

UI ensure 可与 runner GET 交错，随意把 settled GET 写为 A 快照会混入 B 或租约状态。修订用真实 repository.applyState 成功返回的 record 只读采集 A；不改变生产 Action，不在回放里忽略业务字段。free_text 的 selectedAction 为空，不能用它证明没有执行业务，须查真实 job/事件差集。

### 9. UI runner 可掩盖前端派发失败，刷新证明不充分

P1 `waitForNarrativeP1Generation` 自己调用 ensure，UI driver 只是拦截 performTurn。因此 UI 页面即使未派发 B，后台也可能完成。修订 UI 接管后只 GET 等待，页面实际 ensure 另记来源。

当前 refresh 只比较同 entry 的 GET；修订还要求 ready 节点关/重开同 SQLite，再真实浏览器导航并继续行动。原计划的三次重派未覆盖悬挂 fetch；ensure/current 请求增加 15 秒本地等待上限，服务端 job 幂等仍保持。

### 10. 回放和退出码需要落到真实执行接口

初始化/共享前缀是独立 runtime，原 replay proof 只 hash private/public 不够。修订三流完整回放、audit 与 source hash；保留 P1 返回的 replayedTransportAttempts。UI executor 限制仅用于 live，不能阻止记录命令驱动的离线 replay。raw live 的总体验收为 not_run 时，不能沿用 `result.passed ? 0 : 1` 导致正常业务完成永远 exit1；退出码按注册、执行、严格回放、最终汇总分别定义。

## 历史现场的本地复核

- live44 private/public runtime 分别 28/26 次 transport 记录；private 有一次 `network_error`，后来恢复。共享流另计；routes 中两路合计 62 次包含共享初始化/前缀。交接“均 output.ok=true”不准确，但也不能把恢复后的网络失败说成当前总阻塞。
- 两路 fork 的 NPC `npc_0`、`npc_dyn_1` 都没有显式 cooperationDefinitions。结合旧 runner 无 C3 对比，旧成功记录不足以证明新要求；本次没有冒称重新执行原报告的 13 对 performTurn 对照实验。
- UI runtime 最后一份 before14 为 ready/revision23，UI 文件最后是 expected_command，没有 browser_action14。用当前 buildChoiceMap 读取该保存快照，token 映射为 `{type:'talk',npcId:'npc_dyn_2',dialogueAct:'challenge'}`。这是当前代码对保存状态的离线复算，不是历史浏览器已提交或未来仍可复用 token 的证明。
- 无 refresh_verified、terminal、public 路线和 routes.json。该目录仍是部分证据；不能与 live44 拼装完整通过。

## 本次实际验证

运行环境：Node v24.15.0、npm 11.5.2。未使用 API key，未发起 provider 请求。

```powershell
node --test scripts/narrativeP3Journey.node-test.mjs scripts/narrativeP3UiJourney.node-test.mjs
npx vitest run src/game/application/server/ai/narrativeDraftProjection.test.ts src/game/application/server/ai/narrativeExecutionChecks.test.ts src/game/application/server/ai/liveNarrativeCandidateReview.test.ts src/game/gameplay/rpg/storyInteraction/resolveStoryInteraction.test.ts src/components/CurrentGameScreen.test.tsx
```

Node tests：22/22 通过。Vitest：5 文件、107 tests，106 通过、1 失败。失败是 `liveNarrativeCandidateReview.test.ts:373` 的 `turns semantic candidate defects into actionable author repair constraints`：stable/worldDelta=null 输入仍要求包含 beatSummary 时序文案，当前 prompt 不含该句。Plan Task 12 要将 stable=null 与需要演化的摘要约束分成两种回归，不在无演化回合强加摘要。

本次未执行全量 typecheck/lint/build，也未新跑 SQLite E2E/live/UI。旧测试通过不证明修复成立；新增红绿、完整回放和 G5 必须在实施后完成。

`npm run check:docs` 已运行：当前文档 35 份，24 个错误均来自原输入 `docs/P3_源码根因分析与修复方案.md` 引用缺失的 `P3_源码证据索引.html` 及其锚点，另有两条体积提醒。本次不伪造该附件或删去原输入证据引用来制造绿灯；这属于已有导入材料缺项，未由本次 Spec/Plan 链接引入。

本次改动的 `git diff --check` 通过；独立检查 Spec、Plan、本报告与过程 README 的 38 个本地 Markdown 链接，全部存在。该定向检查不替代仓库级检查，也不修饰其已有失败。

## 修订入口

- [修订 Spec](../specs/2026-09-17-narrative-p3-correctness-remediation-spec.md)
- [修订 Plan](../plans/2026-09-17-narrative-p3-correctness-remediation.md)

原交接和原根因分析保留为输入记录；本报告记录勘误与新判断，不重写旧 runtime、steps、SQLite 或既有成绩。
