# Narrative P1 验收记录

## 结论

首个真实 AI 短篇已在正式规则下完成，但 P1 整体仍未通过。`b6cc0e5b` 的 `p1-core-02` 创建“青石渡”故事，完成九次行动后 Node 原生进程中断；保留原库，在独立副本通过正式 ensure 恢复同一游戏，续至第十八次行动与成功结局“一盏直烟”。实际移动、两次取物、四轮战斗、三项主线任务完成和成功结局事件均已核实。

恢复段严格 replay 为 HTTP 0、9 次响应、12 个状态匹配。原中断段缺正常封存，不能称全程无中断或整条严格 replay 通过。全文仍有物品拾取时序、终幕通用标签和收束偏弱的问题；前两项已按规则契约修复并回归，尚未在新冻结 live 中验证。

本轮四项工作的状态如下。首要目标“完整小故事”已取得恢复后通关证据，正式六矩阵和创建到终局的实机 UI 验收没有执行，不记为通过，也不进入 P2。历史 `p1-07` 的 0/6 来自六次独立开局，不是新协议矩阵。根因与后续架构方向见 [失败分析](2026-09-13-narrative-p1-failure-analysis.md)。

| 工作 | 结果 | 未关闭边界 |
| --- | --- | --- |
| 保密、引荐、交付与退出规则 | 已完成；正式 SQLite 旅程及独立复审通过 | 不代表 live 作者可稳定使用这些能力 |
| 原始响应生产链重放 | 已完成机制与集成验证；diag02 开局成功路径、diag04 整次失败初始化实际重放一致 | core02 恢复段完整重放；原中断段和 diag03 旧磁带缺失败收尾清单，未补造 |
| 单故事、六矩阵、实机 UI | 早期诊断均未完成；core02 正式恢复后十八行动成功结局 | 六矩阵及实际 UI 创建→中途重载→终局仍待验收；UI harness 代码不算实机证据 |
| 原文审核与验收结论 | 已读完整通关原文，独立审计核对规则与叙事缺陷 | 完整样本存在确认的规则表达缺陷，不评为质量通过；未作 main 对照 |

历史 `p1-07` 的 `S1-private` 已持久化到第 5 个有效行动，随后因 `approval_rejected` 结束；其他路线在开局或审阅阶段结束。审阅耗尽背后存在作者/reviewer 契约冲突、缺少上一稿的修订，以及互动未接入作者等本地根因，不能仅归因于模型质量。`p1-08` 使用 DeepSeek `reasoning_effort=low` 与 240 秒审阅超时，长时间等待后中止且没有 summary；现存完成请求审计不足以判断中断时卡在哪一层。这些历史批次没有完整 live 轨迹，不填写其人工质量分。

## 已完成的离线证据

- P1-A 的五路线、泄密后 reload 与交付、普通离场和中性自由输入共八条正式规则旅程见 [P1-A 验收报告](2026-09-13-narrative-architecture-p1-a.md)。
- Task 5 的实体/经历/活跃 thread 召回见 `storyEvidenceJourney`、`retrieveStoryEvidence` 相关测试。
- Task 6/7 的角色私密判断、整场候选联合修订和 reviewer 故障边界见 application/AI 测试。
- Task 8 的租约、候选版本、HTTP 预算、取消、并发 ensure 和旧 worker fencing 见 `narrativeRecoveryJourney`、SQLite persistence 和 RPG client 测试。
- Task 9 的固定输入、S1/S2 × 三路线分母、协议哈希/代码指纹、1000 次批次预算和 register/live/replay CLI 门禁见 [P1 旅程协议](2026-09-12-narrative-p1-protocol.md) 与 `narrativeP1LiveJourney` / `narrativeP1Journey.node-test`。
- live 结果保存在 `artifacts/narrative-p1/p1-01/p1-01/`（旧 runner 路径）和 `artifacts/narrative-p1/p1-02/`；这些产物被 `.gitignore` 忽略，不作为源码提交。

## 门禁结果

- `npm run accept`：通过；lint 0 errors，218 个测试文件通过，2784 tests passed、1 skipped，typecheck、fast gates、build 均通过。
- `npm run test:narrative-p1-script`：通过；20 passed。
- `npm run check:docs`、`npm run test:docs`、`git diff --check`：通过。
- `npm run env:check`：通过；`.env.local` 仅注入当前进程，密钥未写入协议、审计摘要或报告。

## 普通生产主线

- `p1-core-01`：冻结 `bb9b2177`，`claimScope=production_core_story`；0/1、10 HTTP、310848 ms、2 有效动作。真实开局通过；第二次行动后的新幕和续接场景已正式提交，最后一次 reviewer 为 pass。
- 阻断为 runner `ROUTE_POLICY_UNSUPPORTED`：只收集对话/当前地点按钮，漏掉 `worldMap.locations[].travelChoice`。实际状态已有合法 `move:loc_dyn_1` 和对应地图按钮，不是生成失败或游戏无路可走。
- 原产物 `artifacts/narrative-p1/p1-core-01/`；独立重放 `artifacts/narrative-p1/p1-core-01-replay/replay/`，HTTP 0、10 原始响应、所有状态一致，保留同一失败码。未完成不能评分。
- 修复入口收集覆盖正式地图、可获取物品、NPC 与建筑 arrival token；core 建筑回退仅接受真实 Action `explore`。4 项生产 projection、20 项脚本、typecheck 和独立复审通过；本次不修改生产剧情、规则或审阅结果。

### p1-core-02：中断后同故事通关

- 原 run：`b6cc0e5b`、真实创建、25 个完整原始响应（opening 4 + route 21），九次行动；第 4 次行动后正式重载。第九次行动后 Node `v24.15.0` 以 `-1073741819`（0xC0000005）退出，无 JavaScript 错误或正常 summary；存档留下 1 次未完成 HTTP reservation。原 summary 的 0 HTTP 是中断前初始 checkpoint，不能当最终实际计数。
- 恢复：`artifacts/resume-core-02.mjs` 绑定原协议、代码、驱动与 SQLite 哈希；原库只读，独立副本走正式 ensure/performTurn，接续 action 9–17。原预算继续生效，独立范围 `interrupted_core_story_recovery`。恢复消耗 9 次 HTTP；合计 34 个完整响应，另 1 个已预留但未记录完成的请求，不宣称全部 HTTP 精确值。
- 唯一 gameId：`d0059431-27e9-4532-9124-5bb78a44ca6a`；18 个 action ID 无重复。两次 `item_obtained`，最终两物品 owner 均为玩家；battle_started、battle_resolved:victory、enemy_defeated 与三项 quest_completed 均有事件，战后玩家 75 HP。action 17 写 `ending_reached:ending_dyn_0`，最终 outcome=success，无递送契约。
- 恢复产物：`artifacts/narrative-p1/p1-core-02-resume/`；其 `replay/` 为 HTTP 0、9 次响应和 12 状态一致。原中断目录只读，未补造正常收尾、未改原协议为 pass。
- 完整玩家正文：`artifacts/narrative-p1/p1-core-02-resume/complete-story.md`，独立审核核对全部文本、状态与来源。

### 文本审核与规则收敛

1. take_item 后的预生成场景仍说传帖未拿、信牌在架，和实际 owner 冲突。根因是续接槽缺展示时已结算语义，通用提示又以当前生成时 item_obtained 限制所有槽。修复让每个 slot 由正式 trigger 投影 after_successful_trigger 与规则结果，author/reviewer 共同使用；具体 take/give step 可作为物品状态审阅依据。不是修改已生成原文。
2. 终幕 support/challenge 按钮原为硬编码“证据/真相”，与本线递交生计诉求脱节。改为中性认可/保留疑虑，既有 Action 与结局条件不变。
3. 故事有茶棚→船家→执事的完整递话链，但停航缘由、决策者与恢复生计未落实，成功结局仍等待回音；战斗必要性弱，最后主要按 NPC 好感分流。因此本次证明规则终局可达，不证明已解决渡口纠纷、选择后果充分或叙事优于 main。后续应围绕具体主线目标及其可验证结局收束，不扩大记忆/Entity 或堆叠 reviewer。

两项代码修复经过独立复审与相关回归；通关文本来自修改前 b6cc0e5b，后续规则提示尚未取得新的 live 效果证据。原生 crash 暂无确定根因，不为此次恢复修改依赖；无中断稳定性仍需单独验证。

## 固定初态核心诊断

`p1-focused-01` 的 `claimScope=fixed_opening_story`，源为 `p1-diag-03/S1-opening.sqlite` 的零回合获批初态，原库只读。协议冻结源协议、runtime、audit、数据库和语义哈希，两路线独立复制；原始文件在 `artifacts/narrative-p1/p1-focused-01/`。

- deliver：五次正式对话行动，包含真实承诺与核验，并在第四次行动后重载。作者的新场景槽格式可解析，前四轮正文获批；当前幕仍未正式进入新地点。
- 第五次行动的三个版本都通过本地解析并进入 reviewer；版本 1 同时被指出正文问题和内部 DTO 格式问题，版本 2/3 修正文后仍因内部 DTO 格式被拒绝。实际作者响应均提交 sceneDrafts，reviewer 所见是程序编译后的 currentScene/continuationScenes/terminal，并另含获准 npcOutwardProposals。作者输出契约被错误套用到内部审核对象，成为最终阻断点。
- withdraw：`DELIVER_FAILED_WITHDRAW_NOT_RUN`；保留两条分母，不以短退出增加完成数。
- `replay/summary.json`：HTTP 0，replayedTransportAttempts 28，deliver 五动作及 `AI_GENERATION_FAILED` 一致；`S1-deliver.comparison.json` 保存逐状态比较。失败复现不算完成故事。
- 作者与审核对象的表示契约边界已修复并经独立复审，完整 accept 通过；修复验证批次见下文；不修改候选拒绝结果、不追加本批重试、不扩展 Entity 或规则。

### 最后修复验证：p1-focused-02

代码 `3d6260ee`，同一 diag03 获批初态，0/2、27 HTTP、1130298 ms。deliver 五动作和第四动作后的重载均已提交；换幕生成失败，尚未移动到新地点。withdraw 保留 `DELIVER_FAILED_WITHDRAW_NOT_RUN`。原始证据在 `artifacts/narrative-p1/p1-focused-02/`，`replay/S1-deliver.comparison.json` passed=true，HTTP 0/replayed 27、五动作与最终失败状态一致。

这次未再出现 sceneDrafts/compiled DTO 格式误判，修复目标得到验证，但未达到完整故事目标：

- 引荐互动修订暴露引用权限歧义：review v1 请求已携带获准 fact_4 提案，却因为公开事实只有 fact_0–3 而将其判不存在；作者改为 fact_3 后又被要求保留原私密提案。秘密可引用与正文可披露没有独立权威目录，不能只依靠“获准方案”说明。
- 同一 action 的每次修订重跑 NPC 判断。response 同为 cooperate 时，goalIds、promiseId 已发生变化，下一版又换 proposalKey；旧候选修订反馈与新授权条款并存。最后一版引荐通过，不能据此忽略依赖漂移。
- 换幕 v1 指出提前执行移动、未建立的逼近威胁和选项意图；v2 仅剩 talk 选项写入坐下/喝茶；v3 改好选项后，又因玩家斗笠未登记为持有物而拒绝。斗笠句在这三份抵达正文中逐字相同，并非第三版新增。
- 前两类正文问题有行动/事实边界依据；最终把普通服饰细节一律要求 inventory 已登记，反映表达细节与可操作状态的审阅边界不清。不能把普通描写当正式物品转移，也不应只为通过这一句增加 Entity 或斗笠白名单。

未完成路线不评分。后续收敛任务是在同一 Plan 中明确审阅判定边界、引用权限投影与稳定的候选依赖，先用本批真实候选验证边界，再重新规定 live 验收；当前不执行第三个样本、不进入六矩阵/UI/main 对照。

## A1–A10 范围

| 项目 | 当前证据 | live 状态 |
| --- | --- | --- |
| A1 | P1-A 私下/公开规则旅程 | `p1-07` 未完成正式终局 |
| A2 | P1-A SQLite 重载与承诺状态 | `p1-07` 仅有 `S1-private` 中途存档，无 live 重载终局 |
| A3 | NPC continuity / knowledge boundary 离线测试 | 未完成 live 路线 |
| A4–A5 | story evidence 正式检索与长期证据测试 | 未完成 live 路线 |
| A6 | P1-A `verify_first` 合法核验后显式交付 | `p1-07` 未完成路线 |
| A7 | 候选 review/修订与 stale hash 测试 | 离线通过；live 出现审阅修订耗尽 |
| A8–A9 | Task 8 recovery、CAS、token/revision 隔离测试 | 离线通过；live 未走到对应完整轨迹 |
| A10 | P1-A 交付/主动退出终局测试 | 离线通过；live 未完成终局 |

## Live 执行边界

历史批次保留 S1/S2 × private/public/verify_first 六路线分母，未完成路线未从分母删除；旧实现未共享同 scenario 开局快照。这些是诊断样本，协议 v3 的新矩阵须重新登记运行。

| 批次 | 结果 | 主要边界 |
| --- | --- | --- |
| `p1-01` | 0/6，HTTP 10 | 旧 runner 产物路径重复；5 条 `ROUTE_RUNNER_CRASHED`，1 条 `AI_GENERATION_FAILED` |
| `p1-02` | 0/6，HTTP 9 | 生产路由 setup 合同不匹配，六条 `PRODUCTION_ROUTE_CRASHED`，SQLite 均无 `game_records` |
| `p1-03` | 0/6，HTTP 12 | reviewer 兼容词未归一化，候选进入 `AI_GENERATION_FAILED` |
| `p1-04` | 0/6，HTTP 34 | reviewer 兼容词已修复；后台生成仍被 runner 当作有效行动反复轮询，出现 `ROUTE_ACTION_BUDGET_EXHAUSTED` |
| `p1-05` | 未完成 | 使用上下文闸门修复前版本；观察到历史增长导致 `context_budget_exceeded`，随后为切换新策略而停止，不作为完整批次结论 |
| `p1-06` | 未生成 summary | 使用无本地预算闸门版本启动；首条路线运行期间会话中断，保留局部审计产物，不作为完整批次结论 |
| `p1-07` | 0/6，HTTP 44 | 无 `context_budget_exceeded`；剩余为 provider timeout、语义审阅修订耗尽和 `approval_rejected` |
| `p1-08` | 未完成，无 summary | 显式 `reasoning_effort=low`、author/review 240 秒；前两条路线各完成 3 次开局生成但未落盘，`S1-verify_first` 推进到 revision 25 后因 provider 长时间无返回而中止，不计入正式矩阵 |

已落地的代码级修复如下：

- `abc531be`：把 runner 的验证输入投影为正式 `GameSetup`，修复生产入口 setup 合同。
- `b282f42a`：为观察到的 reviewer scope/code 兼容词建立受控归一化，未知值仍 fail closed。
- `bdc60a9d`：runner 等待后台叙事生成完成后才计有效行动，避免 pending poll 消耗行动预算。
- `85ca21af`：移除叙事包本地 8,000 estimated-token 拒绝闸门，并更新 TDD 覆盖；provider 失败仍走既有失败协议。
- `4970e11e`：审阅单次超时调整为 240 秒，并按 DeepSeek 官方字段显式发送 `thinking.type=enabled` 与 `reasoning_effort=low`；参数透传和协议冻结均有 TDD 覆盖。

具体保密条件、真实引荐、真实归还及送达后禁止弃约的规则闭环已补齐；真实响应重放机制与独立诊断也已执行，正式矩阵尚未执行。修复后的离线门禁见 [失败分析](2026-09-13-narrative-p1-failure-analysis.md)；本报告门禁数字为本次修复后的工程检查，输出见本地 artifacts/p1-diag04-accept.log；不代表已完成 live 验收。响应 replay 已实现：新 SQLite 重走原始响应解析、NPC 判断、审阅、审批和规则写入，严格比对请求与逻辑存档；协议绑定、原始审计哈希和零网络集成测试通过。实际重放范围见本报告结论；没有完整故事或六矩阵的重放证据。


## 当前诊断样本

- p1-diag-01（575354ca）：0/1，8 HTTP，1 个行动，226916 ms。开局首次结构错误经修订后通过；随后 NPC 输入列出 npc_met，outward 却拒绝该 ID，消耗两次候选机会。第三版作者补造接应人识别方式，被审阅正确拒绝。未完成路线不评分。
- 诊断同时暴露 runner 漏读 NPC 面板选择，只点到地点通用交谈；对应完整读模型及最终显式交付回归已补齐。NPC 证据、真实当前表达、互动 schema 和开局核验依据契约已统一，独立审核通过；后续批次结果分别列于下文。
- p1-diag-02（cc0fecbe）：开局 author/reviewer 两次响应成功，首个保密动作落盘到 revision 1；后续预留 1 次 HTTP 后进程异常中断，没有正常结束摘要。启动快照中的 HTTP 0 不是最终计数。未见续租或请求超时审计，现有证据不足以区分宿主中断与事件循环阻塞。其完整开局已在新 SQLite 中零网络重放，匹配 2 次原始响应与 opening 全状态；仅为开局证据。
- p1-diag-03（cc0fecbe）：独立隐藏后台进程正常结束，0/1，8 HTTP，1 个行动，418962 ms。开局给出了暗语与半枚铜钱短痕的核验方法；首个实际选择是私下请求引荐，尚非正式承诺。NPC 第 1 版因把 secret 放入普通 factIds 被拒，第 2 版因听众自指被拒，第 3 版通过；作者未把保密条件绑定成可执行 interaction，且提前透露部分线索，审阅正确要求修订，但候选额度已耗尽。该未完成路线不评分。
- diag03 同时定位到条件披露的权限缺口：privateFactKeys 编成 secret，而既有规则没有“真实保密承诺后可引荐告知”的路径。另有正常失败退出未封存 replay 审计清单的问题；原始响应仍完整保留，但该失败磁带不可声称已严格重放。修复已随 ebf4a85b 冻结，使用新样本验证，没有修改旧审计补造通过。
- p1-diag-04（ebf4a85b）：0/1，4 HTTP，289699 ms，零行动。前两版分别把 item 及整组 location/npc/quest/situation/item 放错嵌套层；生产 source 复现均为 opening_unknown_keys，反馈没有给出具体 JSON 路径。第三版通过结构校验，但把私密 courier_pursuers 中客栈追查者线索写进公开正文，被 reviewer 以 DISCLOSURE 拒绝。`replay/S1-opening.comparison.json` 确认最终状态匹配，replay summary 为 HTTP 0、replayedTransportAttempts 4、同一 AI_GENERATION_FAILED；无行动、无终局，不评分。
