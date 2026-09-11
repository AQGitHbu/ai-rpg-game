# 分阶段叙事生成代码审查与真实调用报告

## 目标与方向

工作树为 `.worktrees/staged-narrative-generation`。依据 [Spec](../specs/2026-09-09-staged-narrative-generation-design.md)，本次只收敛“规划决定讲什么，旁白、单 NPC、玩家选项负责如何表达，最终完整包审批发布”。规划器掌握全局没有问题，问题在于任务越权分配、表达投影丢失具体内容，以及生成与发布使用不同审批上下文。

不同回应允许同地点、同 NPC；未新增分支、交易、认知或玩法引擎，未降低结局资格、NPC 知识与披露门槛，未以确定性剧情兜底。已有条件快照、消费前提和租约保活保留。本次未编辑 Spec/Plan，未提交、合并、推送，也未操作用户存档或 foundation。

## 本次修复

| 问题 | 最小修复 | 回归入口 |
| --- | --- | --- |
| 新 NPC 重名，规划重试重新创建旧实体 | planning 使用现有实体投影，明确当前位置、占用名称和同批赠物约束；已批准世界增量在后续图/证据/权限拒绝中保留，不自动改名 | crossActPlanning |
| 安全投影只留下笼统意图 | 新鲜 live 规划强制 ExpressionTask：受控 intent、具体 focusFactIds、先求证 prerequisiteFactIds；逐事实安全编译，不转发规划备注原文，不静默删除条件 | expressionTask、perspectiveContext、liveStageSource |
| 角色用整个知识库另起话题 | 新任务只投影任务、节拍和本单元观察的事实；任务事实必须在旁白/NPC 输出引用中覆盖；规范化后候选任务仍须匹配实际 dialogueAct | perspectiveContext、approveUnit |
| 未来表演动作泄漏当前时点 | 动作限定同 step 且 order 不晚于本单元，原有行动主体/受众约束保留 | perspectiveContext |
| 布局错误反馈不足 | unit_output_beat_layout 返回允许节拍及氛围权限，不重排或补造正文 | runJob、approveUnit |
| 新 NPC 被分配旧 NPC 的知识；public 被当作已发现 | 提示明确知识不继承；尚未发现的公开事实须先由有权 NPC 实际披露，之后的玩家旁白/选项才可引用，不能伪造 witness | planningPrompt、conditionalSnapshot、authorityHandoff |
| 任务完成事件被误拒为事实来源 | 只对 current 旁白的强制任务推进节拍，核对当前 job 已提交且对应完成目标的 quest_completed；终幕 completed=[] 时核对 ready_for_ending 的 before 目标。它证明任务完成，不授予任何事实知识 | approvePlanningContext、approveUnit |
| 证据修复反复换另一个非法事件 | 反馈精确列出 unit/beat、非法事件及允许事件，并保留增量与场景图 | approvePlanningContext |
| 已生成完整终幕却在最终发布失败 | publishJob 与生成、装配使用同一 approvePlanningContext 预览世界增量；不再用缺少结局对的旧世界重跑基础审批 | crossActPlanning：run → buildDecisionPublication → publishJob |
| smoke 漏读城镇建筑入口，误报 NO_PROGRESSION_TOKEN | 只补读取 view.currentLocation.town.interactiveBuildings 的现有 arrivalChoiceToken；不铸 token、不改玩法 | stagedNarrativeSmoke.node-test |
| 显式重试立即返回旧失败，无真实新请求 | 游戏状态重入 pending 后调用既有 jobs.control(retry) 恢复同 durable 任务周期；普通 ensure 不重置失败预算 | generatePendingNarrativeBundle：失败、普通 ensure、显式重试、原子发布 |

ExpressionTask 是小型表达任务 DTO，不产生世界效果或知识写入。支持“围绕已授权具体事实表达受控目的，并先求证再回应”，不是通用自然语言规划语言。不在 DTO 中的交易条件、隐藏动机或新线索不能作为 publicIntent/instruction 备注交给表达器补写。

测试中的秘密 sentinel 不进入表达上下文；无权限的任务条件直接拒绝。逐段事实引用覆盖能检查结构遗漏，不能证明模型句子没有隐含编造，因此不能宣称任意自然语言语义已得到形式验证。

## 真实 API 验证

使用现有生产配置和 composition root，隔离临时 SQLite；只提交服务端实际注册的行动 token，未打印密钥、未改用户存档。每次运行有 100 次 fetch / 12 分钟上限（最早运行上限不同），单请求外层至多 95 秒。保留全部审计，不把失败调用藏掉。

| 运行 | 实际请求 | 主旅程结果 | 其他结果 |
| --- | ---: | --- | --- |
| 1 | 27 | 2 次行动后 unit_output_beat_layout | 开局、重载、左右续接通过 |
| 2 | 52 | 8 次行动后 plan_ending_not_ready；终幕三个表达器已完成，最终发布使用旧世界 | 开局、重载、左右续接通过 |
| 3 | 39 | 5 次行动后 beat_authority_conflict，规划证据和知识错误交替 | 开局、重载、右侧通过；左侧 AI_RESPONSE_INVALID |
| 4 | 15 | 2 次行动后 plan_evidence_not_fact_source | 开局重载通过；只跑主线 |
| 5 | 18 | 2 次行动后 plan_evidence_not_fact_source | 开局重载通过；只跑主线 |
| 6 | 53 | 8 次行动后终幕证据误拒 | 开局重载通过；显式重试已产生真实新调用 |
| 7 | 48 | 9 次正式行动通关，0 次手动重试 | generated，重载后 revision=15，结局“信其所言”，outcome=success |
| 8 | 20 | 2 次行动后脚本误报 NO_PROGRESSION_TOKEN | 四模块整包已发布；合法城镇建筑 token 存在，脚本未读取 |
| 9（最终版本） | 70 | 9 次正式行动通关，2 次显式重试 | generated，重载后 revision=15，结局“盐路同舟”，outcome=success；耗时 261.4 秒 |

运行 4/5 的两次“手动重试”只重新排队游戏状态，durable 任务未恢复，不能算模型尝试。运行 6 的两次显式重试确实重启同任务，但暴露 ready_for_ending.completed 为空的契约误判；未跳过闸门。运行 1–7 累计 252 次真实请求，离线回放不计入。

运行 7 已从新开局走完整短篇、发布终幕、提交结局 token，并从 SQLite 读回成功结局。完整通关后文本抽查仍发现“那条路我熟”、凭口述生成脚印、补造过去对白等细节；已在三个表达 prompt 收紧，而非放宽事实/规则闸门。

随后使用独立受控事实与现有 live StageSource/approveUnit 做两组三表达器真实复测，共 6 次请求（不是完整旅程）：第一组结构通过，但人工发现拒绝候选抄用了另一候选的求证条件、NPC 将不知道写成记不得。补充独立候选与未知表达约束后，第二组均结构通过；NPC 直接承认未知、不再编造催促台词，旁白保留“据贺七所说”而不制造脚印，协助选项保留先确认条件，拒绝选项不再复制该条件。运行 8 使用最终表达提示，整包已发布却被脚本漏读建筑 token 阻断。离线保存响应重放确认第二建筑的 arrivalChoiceToken 存在且无需 isCurrentFocus=true；修复脚本并加红绿测试，不改游戏规则。最终运行 9 在同一新开局旅程中，分别经历 beat_authority_conflict 与 unit_attempts_exhausted 后，由测试驱动显式调用现有重试接口两次，再完成终幕发布与正式结局选择。没有跳过行动、降低资格或补授 NPC 知识。最终 SQLite 读回 revision=15、结局“盐路同舟”、outcome=success。九次完整旅程测试加两组三表达复测累计 348 次真实请求；离线保存响应重放不计入。两条短篇通关证明当前链路可以完成，最终运行仍需重试，不能描述成零失败稳定。

### 审计目录

全部位于工作树 `tmp/`：

- 运行 1 主线：`staged-narrative-smoke-audit-bcf6f4b6-1b69-4668-bc41-f616b752bc0e`；两侧：`9e244a56-9169-4725-ae76-6e5efa202fc7`、`420ecb3d-a917-4479-bc03-23d3046ea660`（同前缀）。
- 运行 2 主线：`staged-narrative-smoke-audit-fdab7942-1f07-48e7-a50c-6c5573b90e73`；两侧：`148c5354-67e0-4a8d-b006-d42a7f49a435`、`82d9c0f0-6a49-476b-9402-bd7be43af69a`。
- 运行 3 主线：`staged-narrative-smoke-audit-b583910a-4a7c-4234-8f30-651f4d046148`；两侧：`821888d7-707a-4b15-b4d6-1aa1919aaac6`、`2dd025c4-17d7-480c-a885-4d18b114d148`。
- 运行 4：`staged-narrative-smoke-audit-a74877a5-febf-478d-8938-43bb6b43745d`。
- 运行 5：`staged-narrative-smoke-audit-79f62c42-0dc0-4d89-b14f-edd625263b49`。
- 运行 6：`staged-narrative-smoke-audit-e8ac8467-ce34-4756-bac3-ba1468140967`。
- 运行 7：`staged-narrative-smoke-audit-2db21a1c-1e7b-45e1-8c67-a2ee51b18176`。
- 运行 8：`staged-narrative-smoke-audit-a3d447a2-dc6d-44d2-bd44-eea1f4202f3c`。
- 运行 9：`staged-narrative-smoke-audit-07d72547-11f8-4b5a-8c7d-0d1508b94a26`。
- 表达复测：`expression-fidelity-audit-d3885ded-0a5f-425c-becc-2acbec9a8ab5`、`expression-fidelity-audit-3189b3f8-a53b-4252-bfba-4e9fed8794ca`；诊断脚本保留为 `tmp/expression-fidelity.probe.mjs`，默认不进入测试发现。

### 离线重放与红绿证据

运行 2 的保存响应在临时 SQLite 离线重放，确认失败时 currentAct=targetActs=3、storyProgress=100、endingAllowed=true、未解线索为空、三个任务完成、当前 NPC 在场，但原世界尚未具象化结局对。由此定位 publishJob 复核误用旧世界；新增实际发布测试修复前失败、修复后通过。修复后的第二次离线重放因后续请求序列偏离而中断，不把它记作真实调用或成功通关。

终幕事件回归修复前报 plan_evidence_not_fact_source，修复后通过证据闸门；移除当前 job 的对应事件仍拒绝。普通完整终幕发布链另有测试覆盖。显式 durable 重试测试修复前无法恢复同 job，修复后回到同一周期接口并发布；普通 ensure 不新增 source 调用。

## 检查结果

- 全量 Vitest：227 文件、3012 项通过，1 项 live 测试跳过。收尾对分阶段生成、审批和 prompt 的 23 文件 264 项定向回归通过，包含最终候选规范化任务一致性防御。
- test:fast 通过，含文档、共同规范、配置、共享边界、类型及 127 项依赖边界测试。
- 生产 build 通过；改动代码 ESLint 0 错误，smoke 原有两个未使用变量警告保留。
- smoke node:test 32 项通过；check:docs（34 份当前文档，0 错误、0 提醒）与 git diff --check 通过。
- 初始化测试保留了 Windows SQLite 占用的独立临时目录，未清理其他目录。

## 验收边界

- 已有两条真实短篇完整通关，其中最终版本使用两次显式重试；三题材、多种选择及连续重复稳定性未完成，不能把单条通关或重试成功称为零重试稳定。
- 最小任务投影保留受控目的、具体事实与先求证顺序；没有放行任意规划正文，也没有声称所有自然语言隐含编造均已消除。最终样本旁白仍把“已发现盐包暗记”扩写成“方才已一一翻看过包角”；结构引用审批不能证明这项具体动作实际发生，属于剩余文本保真风险，不能把成功通关当作逐句语义验收全通过。
- 长请求租约已有真实 SQLite 与假时钟回归，不等于真实慢 provider 双进程压测。
- 未新增新地点必选规则；文案风格、复杂多 NPC 与更丰富的决策分化仍不在本次扩展范围。
