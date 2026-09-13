# Narrative P1 验收记录

## 结论

首个真实 AI 短篇已在正式规则下完成，但 P1 整体仍未通过。`b6cc0e5b` 的 `p1-core-02` 创建“青石渡”故事，完成九次行动后 Node 原生进程中断；保留原库，在独立副本通过正式 ensure 恢复同一游戏，续至第十八次行动与成功结局“一盏直烟”。实际移动、两次取物、四轮战斗、三项主线任务完成和成功结局事件均已核实。

恢复段严格 replay 为 HTTP 0、9 次响应、12 个状态匹配。原中断段缺正常封存，不能称全程无中断或整条严格 replay 通过。全文仍有物品拾取时序、终幕通用标签和收束偏弱的问题；前两项已按规则契约修复并回归。core03 已实际验证取物时序，但 16 行动后终局结构失败，36 次响应严格失败重放一致，完整流程仍未通过。

数据库依赖修复已完成：RPG 存档与共享日志改用 Node 24.15.0 内置 SQLite，未自编译原生驱动；独立审核、跨项目完整门禁与真实进程关闭重开检查通过。随后唯一新样本 core06 正常退出，4 行动、15 HTTP 后因剧情审批失败结束；数据库完整性、重载及全部响应的严格重放通过，无原生崩溃。该样本暴露的 NPC 创建知识与说话权限契约已由 801139ff 修复并完成离线验证；未给旧 NPC 回填知识，也未补造可回答金额。原故事重试和独立中篇在 0bd094e4 均失败，严格重放一致。中篇暴露的多线程闭合与结局需求冲突已由 3c40de6e 修复；同局经一次正式重试和一次玩家立场选择成功通关，新段严格重放通过。正文收束质量仍未通过，证据如下。

Task 13 终幕结果闭环已冻结为 `2f6b2dd7`，离线回归与独立复审通过；唯一新短篇 short-closure-01 在第二次行动后换幕审批失败，未到终幕，不能据此认定剧情收束修复已获 live 验证。13 次响应、5 个状态严格零网络重放一致；数据库正常。具体证据见下节。

本轮四项工作的状态如下。首要目标“完整小故事”已取得恢复后通关证据，正式六矩阵和创建到终局的实机 UI 验收没有执行，不记为通过，也不进入 P2。历史 `p1-07` 的 0/6 来自六次独立开局，不是新协议矩阵。根因与后续架构方向见 [失败分析](2026-09-13-narrative-p1-failure-analysis.md)。

| 工作 | 结果 | 未关闭边界 |
| --- | --- | --- |
| 保密、引荐、交付与退出规则 | 已完成；正式 SQLite 旅程及独立复审通过 | 不代表 live 作者可稳定使用这些能力 |
| 原始响应生产链重放 | 已完成机制与集成验证；diag02 开局成功路径、diag04 整次失败初始化实际重放一致 | core02 恢复段完整重放；原中断段和 diag03 旧磁带缺失败收尾清单，未补造 |
| 单故事、六矩阵、实机 UI | 早期诊断均未完成；core02 正式恢复后十八行动成功结局 | 六矩阵及实际 UI 创建→中途重载→终局仍待验收；UI harness 代码不算实机证据 |
| 原文审核与验收结论 | 已读完整通关原文，独立审计核对规则与叙事缺陷 | 完整样本存在确认的规则表达缺陷，不评为质量通过；未作 main 对照 |

历史 `p1-07` 的 `S1-private` 已持久化到第 5 个有效行动，随后因 `approval_rejected` 结束；其他路线在开局或审阅阶段结束。审阅耗尽背后存在作者/reviewer 契约冲突、缺少上一稿的修订，以及互动未接入作者等本地根因，不能仅归因于模型质量。`p1-08` 使用 DeepSeek `reasoning_effort=low` 与 240 秒审阅超时，长时间等待后中止且没有 summary；现存完成请求审计不足以判断中断时卡在哪一层。这些历史批次没有完整 live 轨迹，不填写其人工质量分。

## Task 13：终幕结果闭环与唯一普通短篇

实现保留既有作者、审阅、规则与存储链，在生成包中增加固定 trust/doubt 两条获批结果场景。实际 endingId 决定消费哪条；保密违约仍可将 support 判为 doubt，玩家 History 保留真实选择。结果正文、场景展示事件、记忆与 ending 同次 CAS，未选结果不入 History，结局后不新增生成调用。最终幕承担中心冲突处理，纯主线 concern 由实际 ending 事件闭合；结局页面按玩家受众展示完整有序正文。独立首轮审核发现的受众/兼容正文与线程绑定范围问题已修复并复审通过。

工程验证：完整 2834 tests passed、1 skipped；typecheck、131 boundaries、check:docs 通过，lint 0 errors、50 项既有 warning。真实验收未因工程检查通过而降级。

| 项目 | short-closure-01 |
| --- | --- |
| 冻结代码 | `2f6b2dd7` |
| 协议哈希 | `efc832d4c9c31475d7c8b012a79a0f838739d7d942a6ec201ac6883c9dec4bae` |
| 输入 | 正式 createGame；普通武侠短篇、3 幕，无旧开局或存档注入 |
| 游戏 ID | `a99d771b-c172-465d-8439-c2bbc99a1820` |
| 最终进度 | 2 次行动，revision 4、turn 2、currentAct 2；换幕生成失败，ending=null |
| 调用/重放 | live 13 HTTP；replay 0 HTTP、13 响应、5 状态一致，comparison passed=true |
| 数据库 | live/replay 只读 integrity_check 均为 ok |
| 未验证项 | 未到第 4 行动重载点及终幕，不能认定新终幕 live 通过 |

原始证据位于 `artifacts/narrative-p1/short-closure-01/`，已导出全部已提交正文 `complete-story.md`。正文只完成开局倾听，尚无冲突处理或结局，不能评分为完整故事。末次审阅拒绝续接 NPC 在缺少事实披露许可时声称知道玩家曾在茶棚表示愿意帮忙；该场景未提交。保留失败及修订证据，本批不继续抽样，不改旧存档，也不加入剧情措辞补丁。

独立核对三版候选：第一版明确声明 `existingFactIds=[fact_0,fact_1,fact_4]`，但附带非法顶层字段 `worldDelta.newFact2=null`，结构解析拒绝且反馈只给出 `world_delta_invalid`。第二版修订漏掉 `existingFactIds`，台词仍引用停航损失与会首主张；第三版删除部分相关句子，却保留“茶棚里说要搭手的游侠”，需要未获授权的 fact_3。后两版的逐说话人权限均正确为空，未见已声明知识被投影丢失或旧焦点 NPC 权限误套。当前最小阻断位于候选结构错误反馈与修订时合法知识声明的保留，不应靠自动授知、放宽披露或新终幕设计解决。详细审计在 `failure-review.md`。

## 已完成的离线证据

- P1-A 的五路线、泄密后 reload 与交付、普通离场和中性自由输入共八条正式规则旅程见 [P1-A 验收报告](2026-09-13-narrative-architecture-p1-a.md)。
- Task 5 的实体/经历/活跃 thread 召回见 `storyEvidenceJourney`、`retrieveStoryEvidence` 相关测试。
- Task 6/7 的角色私密判断、整场候选联合修订和 reviewer 故障边界见 application/AI 测试。
- Task 8 的租约、候选版本、HTTP 预算、取消、并发 ensure 和旧 worker fencing 见 `narrativeRecoveryJourney`、SQLite persistence 和 RPG client 测试。
- Task 9 的固定输入、S1/S2 × 三路线分母、协议哈希/代码指纹、1000 次批次预算和 register/live/replay CLI 门禁见 [P1 旅程协议](2026-09-12-narrative-p1-protocol.md) 与 `narrativeP1LiveJourney` / `narrativeP1Journey.node-test`。
- live 结果保存在 `artifacts/narrative-p1/p1-01/p1-01/`（旧 runner 路径）和 `artifacts/narrative-p1/p1-02/`；这些产物被 `.gitignore` 忽略，不作为源码提交。

## P1 最小 NPC 创建契约修复

动态 `newNpc.existingFactIds` 只声明当前闭包内、具有 `known + public + initial_world` 权威来源的既有事实；省略仍为空，不新增 Entity 字段，不回填已有 NPC。审批创建组件与兼容投影同步；审阅依据使用同次预审批解析后的场景身份，按具体说话人和听众列出权限，保留原候选/hash。原审阅把 focus NPC 权限用于整包的歧义已移除，既有秘密、实际听众和 legacy 对话边界保持不变。

独立复审 SpecPASS/QualityPASS。完整 accept 通过（2816 tests/1 skipped、131 boundaries、typecheck、lint、fast、Next build）；复审后的身份、投影修正及新增拒绝矩阵另经定向回归与 typecheck。`artifacts/p1-npc-minimal-accept.log` 保存完整门禁。`artifacts/verify-core06-npc.mjs` 用 core06 原始创建 delta 构造明确标记的离线测试：原包无声明仍为空，显式加入 fact_1 才获知识，经真实 SQLite 保存/关闭/重开后权限一致，原 NPC/玩家知识与原始审计/runtime 哈希未变；该测试不是原故事恢复或通关。

原故事的后续验证使用 `artifacts/retry-core-06-npc.mjs`，独立审核通过。固定原 game/job/action/revision，复制原库到单独目录后仅正式 retry 一次，不重做第四行动。原始 4 行动、15 HTTP 保留；新增最多 20 行动、185 HTTP，独立登记 90 分钟窗口，后续磁带单独严格 replay。修复冻结为 `801139ff`；实际运行代码身份为文档提交后的 `0bd094e4`，生产源码不变。用户明确确认目的地和数据范围后已执行原故事重试与独立中篇，结果见下节。
## 原故事重试与独立中篇（0bd094e4）

按用户要求顺序执行原故事一次正式 retry，再独立新建一局中篇；中间没有修改生产代码、提示或 HEAD，没有自动开启额外 epoch 或重新抽样。两次进程均正常退出，SQLite 只读 integrity_check 均为 ok。

| 验证 | 原故事 core06 正式 retry | 独立中篇 medium-story-01 |
| --- | --- | --- |
| 来源 | 原失败库独立副本，保留原 4 行动/15 HTTP | 正式 createGame，全新 SQLite；普通武侠输入仅 gameLength 改为 medium |
| 游戏 ID | 24384670-0638-4d55-a84f-49e48068cd3e | d81cade3-bd4b-44ec-b247-586134eafde3 |
| 进度 | 新增 3 行动，累计 7 行动 | 28 行动/25 规则回合，5 幕、5 项主线完成，战斗结束 |
| 真实调用 | 新增 9 HTTP，累计 24 HTTP | 69 HTTP |
| 重载 | 原局中途重载证据保留 | 第 4 次行动后真实 close/reopen，完整状态一致 |
| 最终结果 | 无结局，provider_failed / approval_rejected | 无结局，provider_failed / approval:world_delta_rejected |
| 严格重放 | 0 HTTP，9 响应、6 状态一致 | 0 HTTP，69 响应、33 状态一致 |

原故事第一次恢复生成成功，随后执行 support、take_item、support。最后新 NPC 明确声明 existingFactIds=[fact_2]，预审批与逐说话人权限已认可，旧 NPC 未补知识；整包因挑战选项把“赵家认为、钱掌柜不认”的争议写成确定事实而被语义审阅拒绝，新 NPC 因而未提交。

中篇最后失败不是 runner 忽略了结局按钮：存档已包含 ending_dyn_0/1，但 endingAllowed=false，正式 read model 和 choice map 只有移动与普通交谈。随后玩家合法选择交谈。末次 job 的三个候选均尝试再次提供 endingPair，被确定性审批拒绝，没有进入语义审阅。

上游规则不一致：最终主线完成只按 mainThreadId 关闭一条线程，但 endingAllowed 要求整个 unresolvedThreads 为空。开局两条 question 线程都关联 quest_0，第一条 resolved，第二条 thread_init_t_first_run 仍 advanced，导致全部任务完成、进度 100 后仍无结局入口。同时行动推进设 needs_ending_pair，作者据此强制生成 endingPair，实际审批却因已有两个结局派生 need=none，返回 no_need:no_evolution_need。该矛盾已在 Task 12 统一契约后通过同局续跑验证，未直接清空线程、修改原存档或新增样本。

独立审核确认中篇四名动态 NPC 的显式既有事实知识均已在 SQLite 持久化，本次 NPC 最小修复实际生效。两次均是未完成故事，不作完整叙事质量评分，不计 P1 通过或优于 main。上述两次原始运行期间未修改规则、回填状态或再开样本；修复后的中篇续接另记如下。

证据：artifacts/narrative-p1/core06-npc-retry/ 的 summary、retry-manifest、complete-story、failure-review 与 replay；artifacts/narrative-p1/medium-story-01/ 的 protocol、live/summary、live/complete-story、live/acceptance-review 与 replay。中篇驱动 artifacts/run-medium-story.mjs 经独立审核，固定 64 行动/400 HTTP/90 分钟，绑定代码、输入、provider 与驱动哈希。数据库只读核验在 artifacts/story-runs-database-integrity.json。

## 中篇结束流程修复与同局通关（3c40de6e）

Task 12 只闭合有正式任务绑定、完成/失败事件且无额外 closure/goal/promise 约束的线程，保留事件依据；已有结局对时作者与审批共同派生无演化需求。正式 retry 在同 job 的 CAS 内重算派生状态，不重做 Action、改写 World/Event 或直接授予结局。独立 SpecPASS/QualityPASS；179 项受影响测试、完整 2830 tests（1 skipped）、typecheck、131 boundaries、check:docs、lint（0 errors）通过。

- 原始来源为 medium-story-01，gameId `d81cade3-bd4b-44ec-b247-586134eafde3`、28 行动、69 HTTP、revision 43/turn 25。独立复制后只正式 retry 一次，原 SQLite、steps、runtime、protocol 和两份审计的六项文件哈希未变。
- 新增 3 HTTP（角色判断、作者、审阅各一次）后，同一失败 job 恢复 ready，revision 44/turn 25；endingAllowed=true，两条线程有规则依据，已有两条 ending 未重复生成，此时 ending 仍为空。
- 玩家实际看见认可/保留疑虑两个服务端选项，选择“我认可你的回应，愿意继续合作。”，提交 `medium-complete-action-28`，写入唯一成功 `ending_reached:ending_dyn_0`。最终“信义说合”、outcome=success、narrative=ready，revision 45/turn 26，五幕五项主线完成，无递送契约。
- 新增 1 行动，累计 29 行动、72 HTTP。live/replay 正常退出 0；新段严格 replay 为 HTTP 0、3 响应、4 状态一致。两份 SQLite integrity_check=ok，终态与 runtime 哈希一致，原 NPC 完整知识条目保留。
- 原 69 响应/33 状态在 0bd094e4 严格重放，新段在 3c40de6e 重放；这是同故事跨修复版本恢复通关，不是单一版本无中断全程通过。

全文已读。规则终局可达，但正文仍说“你要往渡口去说合”“先听明白了再拿主意”，结局描述却跳至三方愿意先解缆再清账；最终立场沿用已批准场景，没有新增结果场景。因此剧情收束质量不记通过，也不证明优于 main。后续应核对中心冲突的实际行动结果与终幕表达，不能以重复抽样或措辞补丁代替；本轮不再新增生成。

证据：`artifacts/narrative-p1/medium-ending-retry-01/` 下的 protocol、live/replay、verification.json、complete-story.md、acceptance-review.md；完整测试日志 `artifacts/task-12-full-tests-final.log`。原失败证据原样保留。

## 门禁结果

- foundation 同名工作树 `npm run ready:family`：通过，日志公共测试、SLG 消费者快速门禁/共享 UI/Next 构建及 RPG 完整门禁均执行。RPG 为 lint 0 errors/49 warnings、218 个测试文件通过/1 skipped、2811 tests passed/1 skipped、typecheck、fast gates、131 项边界与 Next webpack build 通过；覆盖 `accept` 的各项命令。完整输出 `artifacts/node-sqlite-family-02.log`，退出码 0。第一轮只因目录测试仍断言旧 logging 版本而失败，修正版本断言后重新完整执行，保留第一轮日志。
- `npm run test:narrative-p1-script`：通过；20 passed。
- `npm run check:docs`、`npm run test:docs`、`git diff --check`：通过。
- `npm run env:check`：通过；`.env.local` 仅注入当前进程，密钥未写入协议、审计摘要或报告。

## 普通生产主线

### 数据库替换与 p1-core-06

- 冻结：RPG `cec82659`、foundation `03dbd44`（驱动实现 `ebccae8`）、SLG 消费者 `d9c39545`。`@ai-game/logging` 为 `0.2.0`，运行时 Node ≥24.15.0。RPG 与共享日志的 manifest/lock 不再包含 libsql；SLG 自有存档不在本次 RPG 修复范围内，其驱动未替换。所有修改留在独立同名 worktree，未合并 main。
- 使用 Node 发行版现成 `node:sqlite`，没有 Rust/C++/Node/SQLite 自编译，没有旧存档迁移。保留事务、CAS、未提交回滚、幂等关闭、异步锁竞争及日志查询/保留契约；Next 原 libsql external 与测试 alias 已移除。
- 独立新进程验证真实 production composition 与日志 40 次关闭重开，40 条日志全部查回。模块解析守卫拒绝 libsql，进程 native module 清单无 libsql。现成依赖重新安装后的检查同样通过，证据 `artifacts/node-sqlite-validation/runtime-verification.json`；日志 CLI 合同通过。独立代码审核结论为 PASS。
- 唯一新故事 `p1-core-06`：`claimScope=production_core_story`，正式 createGame、新数据库、原 core 输入与实际 opaque choices；4 行动、1 次重载、15 HTTP、427747 ms，完成 0/1。开局“青芦渡”与移动至“芦荡滩”成功，最终 Node 正常退出码 1，失败码 `AI_GENERATION_FAILED`，不是原生异常。
- 末段 job 的 epoch 0：v1 输出额外 `graph` 字段被结构校验拒绝；v2 无依据补写修船用料与账目被审阅要求修订；v3 未回答差额、披露未授权事实并补写亲手造船历史，最终 `approval_rejected`。该 job 的 5 次 HTTP 均成功返回，不是传输或数据库失败。
- 关键状态：赵拴 `knowledge.entries=[]`，事实 `fact_1` 虽玩家已知但 `speakerMayDisclose=false`。玩家已选“修船差多少，咱们一起理个明白”，而可用状态没有具体差额。不能通过放开所有公开事实的角色知情权限、虚构金额或把全部拒绝当审阅误判来取巧。后续应先核对新 NPC 具象化时的事实知情和任务可回答性契约，不追加提示补丁或另开故事重采。
- 最终存档 revision 7/turn 4、22 个正式事件、`narrative=provider_failed`、lease 已释放、无 ending；`PRAGMA integrity_check=ok`。严格零网络 replay 消费 15 次响应，opening 与 route 的全部 6 个语义状态匹配，保留同一 4 行动失败。replay 退出码 1 表示忠实复现失败故事，两个 comparison 均 `passed=true`，不冒充成功通关。
- 原产物 `artifacts/narrative-p1/p1-core-06/`，重放 `artifacts/narrative-p1/p1-core-06-replay/replay/`；完整可见正文、数据库核验和独立失败归因分别见该原产物中的 `complete-story.md`、`database-final-check.json`、`independent-failure-review.md`。原故事支持正式 `{retry:true}`，本次未重复采样或执行无依据的额外重试。

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

两项代码修复经过独立复审与相关回归；通关文本来自修改前 b6cc0e5b，新提示的实跑证据见下文。原生 crash 暂无确定根因，不为此次恢复修改依赖；无中断稳定性仍需单独验证。

### p1-core-03：规则时序验证与终局结构失败

冻结代码 `59fe62b0`，真实创建后完成 16 次有效行动与中途重载，消耗 36 次 HTTP、1110645 ms；最终 `AI_GENERATION_FAILED`，0/1，不算完整故事。取物后的正文已明确纸页在玩家手中，NPC 也承认玩家持有，上一批取物时序问题获得实际验证。

终局三个作者版本的失败不同，均未进入本次终局语义审阅：第一版 worldDelta 合法，但 npcLine 省略 emotion 与三组引用元数据，导致 current_scene_invalid；第二版把 beatSummary 等 worldDelta 字段放到顶层；第三版 worldDelta 仅有 endingPair，缺少必填 beatSummary。其他可空字段省略并不是解析失败原因。终局提示“必须只提供 endingPair”与通用摘要要求产生歧义，通用 world_delta_invalid 修订反馈又错误地指向 newFact，未给出实际缺失字段。

原始产物在 `artifacts/narrative-p1/p1-core-03/`；修改代码前已在独立 `p1-core-03-replay/replay/` 完成严格重放：HTTP 0、36 次原始响应、16 次行动和最终失败一致。原进程在正常失败摘要封存后再次以 `0xC0000005` 退出，重放正常退出 1。隔离 SQLite 探针的 10 个独立进程均正常退出，未复现崩溃；不能据此认定依赖、GC 或业务代码为根因。诊断证据在 `artifacts/native-sqlite-probe/`，未猜测性修改依赖。

### core03 终局显式重试

`38b8ea51` 在原失败存档的独立副本调用一次正式 `retry:true`，同一游戏追加第 17 次行动后达到成功结局“渡口交付”，7 HTTP，进程正常退出 0。独立范围为 `failed_ending_explicit_retry`，预算与原批分开，原库/步骤/协议哈希及旧新代码均绑定；不算原批无中断通关。`artifacts/narrative-p1/core03-ending-retry/replay/` 严格重放 HTTP 0、7 响应、4 状态一致。

终局首稿结构与审批已通过；正式结局立场仍被 performTurn 当作普通 NPC 对话，规则已经写入 ending_reached 后又创建 pending job，导致额外生成结局对并被世界增量审批拒绝。成功结局真实存在，但后台失败状态不能算完整稳定闭环。此终止边界在 main 的同入口也存在，不能归因于本次元数据编译；后续收束为正式终局提交后停止生成，保留退出故事另行生成终场的契约。

### p1-core-04：修订意见路径契约不一致

`dc27bb4d` 新建普通短篇，开局通过，1 次行动后失败，5 HTTP、138053 ms，进程正常退出 1。全程严格重放为 HTTP 0、5 响应和相同失败状态；产物分别在 `artifacts/narrative-p1/p1-core-04/` 与 `p1-core-04-replay/replay/`。

本次不是三个候选耗尽：最终 epoch 0、candidateVersion 1、当前 job HTTP 3。审阅请求以 `{...,proposal}` 包装候选，模型返回两条 `proposal.currentScene.npcLine.text` 修订路径；解析器却只相对内部 candidate 解路径，转成 UNCERTAIN，调度据此非重试失败，第二、第三版未执行。修订本身仍须保留：木匠工序是否属于无害表达与“柳伯没答应抵押”是否改变人物承诺，不能为了通关一律删除。修复只统一明确请求外壳与内部路径，不改变审阅 verdict 或事实边界。

### p1-core-05：捕获原生持久化崩溃

代码 `5a0b4154`、Node 24.15.0。真实创建后完成两次行动，保存 8 个完整响应（opening 2、route 6），另有一个未完成 reservation，随后原生退出 `0xC0000005`。第一轮实际完成 NPC 判断、作者首稿、审阅 revise、作者修订及审阅 pass，第二轮 NPC 判断后中断。初始 summary 的 0 HTTP/0 ms 不是最终计数；route 未正常封存，不能声称整条严格重放。

`artifacts/resume-core-05.mjs` 绑定原库、步骤、协议、原始响应、代码及 Node 可执行文件哈希；保持原 90 分钟、24 行动与累计 HTTP 预算。原库只读，独立 `core05-native-resume/` 经正式租约恢复追加两次行动，同一游戏累计四行动，另保存 8 个完整响应；在同一 Node 版本下再次崩溃，无正常恢复 summary 或完整恢复段重放。没有以重置预算或修改存档伪造通过。

从微软官网下载并验证签名的便携式 ProcDump 仅监视此次恢复进程，捕获 `artifacts/native-tools/core05-dumps/node.exe_260913_211501.dmp`。未安装全局调试器、未上传转储。独立元数据与首层栈核对确认：异常为无效地址读取，模块是 `@libsql/win32-x64-msvc/index.node` 0.5.29，偏移 `0x55661e`，可信直接调用点 `0x604ab6`。没有 PDB，不能把局部栈包装成完整符号调用栈。

准确 `libsql-js v0.5.29` 的 Cargo.lock 锁定 libsql 0.9.30；从官方 crate 下载的 SHA256 与锁文件一致。其外层 LibsqlConnection 和内层 Connection 的 Drop 均调用 disconnect，disconnect 在 sqlite3_close_v2 后没有清空句柄，确含[上游 2251](https://github.com/tursodatabase/libsql/issues/2251)所述重复关闭缺陷；异常类型、版本与局部调用特征均吻合，构成当前最强根因证据，仍待修复前后对照。核验时[修复 PR 2261](https://github.com/tursodatabase/libsql/pull/2261)尚未合并，client 0.18.0 仍依赖同一原生版本范围，不能宣称升级即解决。详细证据为 `artifacts/native-tools/upstream-assessment.md`、`core05-first-frame.json`。

当时游戏仓储与共享日志均依赖该原生库；只更换其中一个入口不能证明排除故障。该诊断批次没有修改依赖或 foundation。其后用户明确禁止自编译并允许舍弃旧存档，隔离原生补丁方案已停止；实际采用的 Node 内置 SQLite 替换和 core06 证据见本报告上节，不以保留连接不释放、删除 close 或反复抽样掩盖缺陷。

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
