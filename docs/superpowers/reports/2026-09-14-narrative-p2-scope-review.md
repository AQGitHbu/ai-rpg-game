# P2 范围核查：从完整小故事到可追溯的较长经历

## 结论

以 `codex/narrative-architecture` 的 `dfb567b1` 为 P2 规划基准。更新后的 [P1 Plan](../plans/2026-09-12-narrative-architecture-p1.md) 已允许进入 P2：正式公开递送、同前缀退出对照、实机创建与重载流程满足最小收尾。它没有证明任意故事、保密/核验矩阵或整体叙事优于 main；本次不重开 P1 历史失败批次。

P2 应围绕一个可验收结果：**在完整短/中篇中，玩家能准确回忆较早的人与话，NPC 按实际经历回应，旧选择仍影响后续，摘要维护不制造遗忘、越权或存档竞争。** 先补证据进入上下文的完整路径，再增加派生摘要，最后验证完整旅程。不能把“加了摘要字段”当成剧情质量提升。

具体执行见 [P2 Plan](../plans/2026-09-14-narrative-architecture-p2.md)；总架构仍由 [总 Spec](../specs/2026-09-12-narrative-architecture-design.md) 维护。

## P1 证据及其边界

| 事项 | 当前已证实范围 | 本次处理 |
| --- | --- | --- |
| delivery-core-01 | 正式创建，三幕、10 行动、27 HTTP；实际交付后成功 ending/ready；中途重载及 27 响应/15 状态严格回放 | 继承为规则、场景编译、终局的基准，不重写旧磁带 |
| exit-comparison-01 | 相同开局与四行动前缀下选择可见放弃入口；未交付、物品仍归玩家、失败终局 | 继承已有选择后果；最后 turn 修复是旧响应离线验证，不称新 live |
| ui-live-01 | 实机创建→游玩→刷新→终局，包含一次显式生成重试 | 继承流程证据；P2 只新增记忆/重载有关的 UI 检查 |
| 保密/核验 focused、六路线矩阵 | 旧失败与未执行项目仍在 | 不作为 P2 摘要建设前置，也不改成通过；综合玩法矩阵交 P3 |
| 普通纠纷/中篇历史样本 | 有经修复恢复的通关，也有未结算返程、复航或异地 NPC 代办等正文错误 | 说明规则可完成性仍有边界；P2 继续使用有现成可执行中心结果的递送题材 |
| main 对照 | 没有同条件完整旅程对照 | P2 先比较有/无摘要的证据使用；替代 main 的判断留后续专项 |

原始过程及完整文本引用由 [P1 验收报告](2026-09-12-narrative-p1-acceptance.md) 维护，本报告不重计其成绩。

## 代码核查发现

以下为代码阅读结论，区别于尚未运行的新回归。P2 Task 必须先用行为测试复现，再修改；不根据推测放宽权限。

| 发现 | 代码事实来源（仓库根相对路径） | 对 P2 的影响 |
| --- | --- | --- |
| 正式原文基础已经存在 | `src/game/domain/narrativeHistory.ts`：History 有独立 sequence、segment/action/job/scene/revision、speaker/audience、fact/event 引用；`shown_choice` 单独保存 | 不重新设计 History，也不把回合数或 Event sequence 当 History 游标 |
| 双向检索的硬引用没有完整传递 | `retrieveStoryEvidence.ts` 产出 `manifest.mandatory`；`retrieveNarrativeMemory.ts` 只把 evidence eventIds 加入 cause 候选，`requiredEvents` 仍仅来自 query.requiredEventIds；episode 最后 `.slice(0,maxEpisodes)` | 活跃承诺/指代所需旧事件不能仅依赖可丢弃的 episode 卡；须把必需性贯穿检索、render、compiler |
| 名称入口主要找事件，未普遍补回对应原话 | `retrieveStoryEvidence.ts`：explicit/exact 分支取相关事件最后 8 条；historyIds 主要从经历文本匹配和 dialogueFocus 填充；Thread/Promise 分支只加事件 | “知道这是哪个人”不保证作者能看到那个人早先的准确表述；增加事件→原文反向索引与有依据的选择 |
| 原文类型与可见性需在召回前统一 | `visibleHistoryEntries` 包含 shown_choice，经历匹配会处理它；`renderNarrativeMemory` 到输出时才去掉；名称检索遍历全部 records，公开 core.name 未做 observer 认识该实体的判断 | 未选项可能影响候选排序，隐藏实体可能进入检索结果；先过滤，后排序，不能靠最后不显示字符串掩盖 |
| 角色判断未统一使用旧原话 | `projectNpcDeliberation.ts` 读取 knownFacts、recentInteractions、结构化 currentEvidence、当前 job 表达，没有消费双向检索的历史原文包 | 玩家作者会记得但 NPC 不一定能据自己的经历回答；自知历史与 outward 权限必须分开 |
| 当前“近期场景”主要是结构卡 | `episodicMemory.ts` 保留最近 8 个 scene 记录，`retrieveNarrativeMemory` 默认取 4；`renderNarrativeMemory` 的 recentScenesText 为 beat/ID 卡，原文依赖 historyIds；bundle 另注入上一场景 | 不能声称已有“摘要＋全部未覆盖原文”的上下文契约 |
| 当前没有 AI 长历史摘要 | `NarrativeEpisode.summaryKeys` 是事件种类/派生标签，summaryVersion=1；未见 coveredThroughSequence 或滚动原文摘要实现 | 新摘要应与现有 episode reducer 区分，不能覆盖其 ledger 一致性校验 |
| bundle 长度实际不受限 | `narrativeBundleContext.ts` 使用 `Number.MAX_SAFE_INTEGER`；compiler 保留 mandatory，仅在 manifest 记录 overflow | P2 必须登记真实可用输入预算和前置溢出行为，不能重新随意套 8000，也不能把“有预算参数”当已受控 |
| 当前存档与原方案不同 | `StoryState` schema **12**、World **7**、EntityStore **3**；`sqliteClient.ts` 使用 `node:sqlite`，package engines 为 Node ≥24.15.0 | P2 默认不改这些权威 schema；摘要用 RPG 独立派生缓存，不能按旧计划再做 libsql 或 schema10 改造 |
| 生产链已收敛 | `narrativeDraftProjection.ts`/`compileNarrativeDraft`、有序 expressions、endingOutcomes；`narrativeRequestClient.ts` 的 author/npc_deliberation/review 使用统一传输与预算 | 直接接入现有链；不恢复三路润色、不新增剧情规划器或平行生产 source |

表中 memory 检索文件位于 `src/game/gameplay/rpg/narrativeMemory/`，其他未展开路径的 server AI 文件位于 `src/game/application/server/ai/`。

## P2 的取舍

1. **补齐回忆的证据链是首要功能。** mandatory 来源、原话、消歧、observer 权限、当前实体状态一起到达作者与角色判断；查询也接收有效摘要/近期原文的实体引用，形成“摘要引用→当前实体→一次旧原文补充”，不能只扫描最后一句。用正式生成请求验证，不能只检查一个 helper 的字符串。三份参考文档的具体采用和舍弃由 P2 Plan 的对应表统一维护。
2. **摘要先采用带来源的摘录选编。** 模型选择历史记录/事件引用，正文由服务端取完整原文；不先增加会改写否定、承诺条件或事实状态的自由摘要。分批摘要保留，概览从分批源重新选编，原文随时可召回。其压缩率与可读性需实测；不能因 token 减少直接判通过。
3. **摘要单独缓存，游戏仍可独立成立。** cache 更新只影响派生资料，不递增 gameplay revision、不使 choice token 失效、不与 A/B 抢写整份 StoryState。失败不推进覆盖水位，未覆盖原文必须仍被读取；真正超预算才显式停止构造。
4. **保持 P1 的可执行故事边界。** P2 增加短篇回归和五幕中篇的较长间隔追问，不引入开船、支付、组织关系或通用行动。主线完成性、回忆正确性、文本质量分开验收。
5. **有/无摘要比较使用同一 P2 代码与同一状态。** 可以关闭派生摘要，不能关闭规则/权限。旧磁带只做原协议严格回放或明确标注的回归，不用改变 prompt 后的旧响应冒充新生成。

## 本次验证与限制

- 工作区开始检查时 clean，HEAD=`dfb567b1`；本次只写文档。
- 实际运行 memory 检索、render、NPC projection 四个测试文件：**17 tests passed**。第一次仅设置 maxWorkers=2 与默认 minWorkers 冲突，未执行测试；显式 minWorkers=1/maxWorkers=2 后通过，没有改配置或断言。
- 已有 `storyEvidenceJourney.test.ts` 是人工构造一个旧 History/事件、写 SQLite 后读取的检索测试；它不经过连续多幕生产生成，也没有在该用例中实际积累超过近期窗口的后续场景。P2 将另补正式旅程覆盖。
- 未运行完整游戏测试、真实 API 或新 UI 游玩；这些不是本次规划完成的证据。
- 当前连续性系统文档仍把 StoryState 写成 11，与代码 12 不符；本次只修正这个已核实的事实，不提前描述 P2 已实现。
