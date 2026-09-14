# Narrative P2 Story Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修正 p2-01 暴露的行动越界、空转推进与虚假收束，在真实小故事质量成立后重新验证长期记忆。

**Architecture:** 保留整场作者和现有一次语义审阅；由服务端规定核查范围，审阅器提交可验证的语义抽取。剧情疑问与形式任务完成分开，作者和审阅器共用基于当前状态的推进要求，不增加另一层剧情规划器。

**Tech Stack:** TypeScript、Vitest、现有 RPG 规则引擎、NarrativeBundle 与 P2 正式旅程工具。

## Global Constraints

- 仅在 `codex/narrative-architecture` / `.worktrees/narrative-architecture` 实施；不改 main、staged、`.foundation`、`current-phase.json`。
- EntityStore3 / World7 / Story12 保持。整场作者、单 NPC 判断、一次语义审阅和三版候选上限保持；不新增模型、调用层、向量库或剧情替代输出。
- p2-01 原始磁带及失败结论保留。新契约需新冻结批次；本次执行代码与离线验收、重规划覆盖，不启动新 API 批次。
- 行动、物品、知识与已完成前提以规则状态/事件/槽预览为准；场内无玩法效果的小动作及明确未来意向仍可表达。不能靠关键词黑名单判断剧情。
- 记忆仍按 50 条阈值、每批 10 条运行；不注入 History、不拆段凑数、不降低阈值、不重复对白补覆盖。模型别名 `ai-slg-game-model`，上游与 1M 容量为用户确认信息；64,000 输入估算门禁不因此自动调整。

## Task 1：行动核查、推进要求和真实收束

**Files:** `src/game/application/server/ai/liveNarrativeCandidateReview.ts`、`narrativeReviewRules.ts`、新增 `narrativeExecutionChecks.ts` / `narrativeProgressContract.ts` 及测试；`narrativeContext/narrativeBundleContext.ts`、`openingSemanticContract.ts`；`src/game/gameplay/rpg/storyThreads/advanceStoryThreads.ts`、`src/game/gameplay/rpg/ruleEngine/index.ts` 及规则/完整旅程测试；使用 live reviewer 的 P2 fixture 与 node fixture。

**Interfaces:** `buildNarrativeExecutionChecks(input)` 只读生成候选路径、规则依据与必须核查维度。decision 的 `pass` 必须携带完整核查，逐候选路径绑定引文和状态抽取；漏项、重项、未知路径/引文、主题错绑或不明确返回现有 `UNCERTAIN`。可确定的越界转换为现有 `ACTION_MISMATCH` 缺陷，并保留候选版本/hash；`revise` 继续使用有依据的既有缺陷结构。新增响应字段不进入持久化 World/Story schema。

- [x] 复现内堂 talk 的结局写成已离开并乘船、裸 pass 被接受；核查至少覆盖当前场景、续接场景、两个主题的结局正文与标签/描述、beatSummary。每个检查给出服务端范围，不能由模型自行删选。
- [x] 在同次 reviewer 中抽取玩家位置、实际参与 NPC、物品转移及已完成前提，绑定实际候选原文和对应规则依据。位置抽取区分 unchanged、at(locationId)、outside_known_location；用当前状态或真实槽/结局预览验证，不能把同一次条件结果当作当前场景的已完成事实。
- [x] 增加作者/reviewer 共用的推进要求：开场建立具体利害与可完成的委托；中间幕至少带来具体分歧、能改变判断的信息或有根据的回应变化；终幕处理本次委托和立场后果，明确仍未解决的问题。新 NPC 知情必须声明 existingFactIds，不能借推进要求绕过权限。复述引路/核验不算冲突推进；不强迫每幕新增战斗、秘密或数值系统。
- [x] 自由输入转换的 `talk/ask/utterance` 保留实际交互和 NPC 回应，但不消耗两轮正式回应的 dialogueSession 计数、不单凭 met 完成 talk_to_npc；首次追问仍建立未完成会话以供 quest gate 使用。现有正式选项保持推进作用；追问后仍可选择，固定 ask 入口的 bootstrap 保持。测试连续追问不会换幕、两次正式回应仍正常完成，避免把增加正文量当作增加玩法。
- [x] 在现有审阅中明确核查推进与收束并提供候选引用，重复确认、无具体利害或未回应中心问题不能以纯风格观察掩盖；若违反共同推进契约，使用明确的规则依据和既有因果缺陷通路。不得把审美分数当确定性规则。
- [x] 空 closure 的 question 即使收到 ending_reached 也只保持 advanced；具备实际 closure 的疑问按原条件闭合，显式 goal/promise 不自动解除。保留有限委托可结束的既有 gate，不让未证实的宏观和解阻塞合法交付。报告中区分“游戏已结束”与“所有社会冲突均已解决”。
- [x] 回归非法外移/异地 NPC/转移或前提前置、合法同场动作和未来意向、主题换序、空白 pass、错误引文；通过正式 generator 证明拒绝版本不写 History、修订只提交一次。测试明确：结构化抽取仍依赖模型理解，离线通过不代表真实剧情已提高。
- [x] 升级受影响的 live reviewer fixture，不能增加生产兼容开关接受旧裸 pass。检查状态版本不变与完整故事无死锁。

## Task 2：重新规划真实记忆覆盖

**Files:** 新增 `docs/superpowers/plans/2026-09-14-narrative-p2-memory-coverage.md`，原 P2 Plan 的后续入口与 `docs/superpowers/README.md`。

- [x] 根据实际旅程驱动、talk 推进规则和摘要批次边界制定下一轮可执行计划，先查清“有意义的额外互动”是否会直接耗尽幕推进，不能只给目标字数。
- [x] 分开短篇质量门禁与中篇记忆门禁。记录短篇 32、中篇 49 条有效原文的事实；预登记有限追问议题、行动选择、停止条件和失败分母，先证明生产路径可以在交付前形成两批摘要。
- [x] 旧事追问固定为真实早期 History 来源，检查来源已被覆盖、间隔达到门槛、实际作者请求含原话且无权限泄漏；同一 ready 快照执行摘要开关对照，并保留未达到覆盖时明确失败。
- [x] 新协议冻结前必须完成驱动修改与稀疏自然回应的离线旅程；摘要效果、文本质量、运行正确性分别评估，不用扩充 fixture 正文替代自然覆盖。

## Task 3：整体验证与文档事实更新

**Files:** `docs/agent/运行时AI导演与场景表演.md`、`探索与任务推进.md`、`战斗与结局.md`、`NPC对话驱动叙事场景触发.md`、`docs/策划文档/AI生成RPG_MVP.md`，新增 `docs/superpowers/reports/2026-09-14-narrative-p2-story-repair.md`。

- [x] 独立审阅运行时修改与跨模块连接，修复实际缺陷；记录任务与整体验证。
- [x] 运行受影响 Vitest、P2 node 脚本测试、typecheck、lint、boundaries、完整 Vitest、check:docs 与 build。按实际结果记录，不能把旧成绩转记本次。
- [x] 系统文档原位维护新准入/推进/Thread 契约，Plan 勾选已完成任务；记忆覆盖 Plan 的实施任务保持待执行。本次不声称 P2 质量或记忆实跑已通过，不合并主分支。

## 执行结果

运行时修复、独立审阅与离线验收已完成，证据见 [修复报告](../reports/2026-09-14-narrative-p2-story-repair.md)。记忆覆盖重规划已完成文档，其 v2 驱动和真实 API 验收任务仍待实施。
