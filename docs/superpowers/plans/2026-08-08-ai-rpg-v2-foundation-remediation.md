# AI RPG v2.1 架构底座修复实现计划

> 日期：2026-08-08  
> 状态：可执行草案，待进入阶段实施  
> 修改范围：仅 `ai-rpg-game`；不修改受保护的 `../ai-game-foundation`

> **For agentic workers:** 按任务顺序执行；每个 Task 必须先写失败测试，再实现，再运行指定验收。若环境提供 `superpowers:executing-plans` 或等价执行能力，优先逐 Task 执行，不得把多个提交阶段压成一次大改。

**Goal:** 修复 v2 回合因果、选择语义、AI 事件推动、开局可达性、NPC 知识和 Expansion 闭环，使“两个 NPC 固定选择 + 一个自定义输入”能够持续推动结构化、可回放、可分化并可抵达多结局的故事。

**Architecture:** 引入 `TurnResolution` 与 `PendingNarrativeJob` 作为一次玩家回合的完整因果载体；固定选择和自由文本统一进入 `performTurn`；规则事实与 pending job 单次 CAS 提交；SceneGenerator 只消费持久化 job 和最小权限 context；AI 场景选项经 `ApprovedChoice` 服务端审批；候选事件在下一回合编译为真实领域事件。

**Tech Stack:** TypeScript, Next.js 16, React 19, libsql/SQLite, Vitest

**Spec:** `docs/superpowers/specs/2026-08-08-ai-rpg-v2-foundation-remediation-spec.md`

**Upstream Spec:** `docs/superpowers/specs/2026-08-07-ai-rpg-architecture-redesign-spec.md`

**Requirement IDs:** FND-01 ～ FND-12。每个 Task 标注覆盖编号；Plan 完成时不得存在未分配编号。

---

## 0. 执行约束

### 0.1 仓库与 worktree

- 只修改 `ai-rpg-game`，不修改 `../ai-game-foundation` 或 `.foundation`。
- 实现分支必须放在 `.worktrees/`，建议：
  - branch：`codex/v2-foundation-remediation`
  - worktree：`.worktrees/v2-foundation-remediation`
- 不使用 `git checkout` 切换主仓工作目录。
- 若 worktree 内存在 `.foundation` junction，清理时必须按根 `AGENTS.md` 使用受保护清理脚本，禁止直接 `git worktree remove`。
- 本 Plan 和对应 Spec 应先进入可被 worktree 读取的提交，再开始生产代码实现。

### 0.2 分层和依赖

- domain：纯类型与纯函数，零 IO、零 AI、零 DB、零环境变量、零时间/随机读取。
- gameplay：纯规则，零 IO、零 AI source 调用；允许接收 `now`/ID 等显式纯依赖值，但不自行读取。
- application：用例编排、最小 context 构建、source port、read model。
- application/server：AI、SQLite、环境和组合根适配。
- UI/API：只消费 application facade；不得 deep-import gameplay/domain/server 私有模块。
- 新增跨层 facade 或 import 时同步更新 `src/dependencyBoundaries.test.ts`。

### 0.3 状态和事实

- `GameRecord.revision` 是唯一 CAS 防重屏障。
- schema version、revision、turnNumber、event ledger cursor 必须是四个不同概念。
- 一次成功玩家回合只能有一次规则 StateCommit。
- SceneWriteBack 只写 narrative runtime、choice registry 和 candidateEventPool；不得修改 World State、任务、关系、知识、预算或节奏核心指标。
- AI 原文不成为世界事实；玩家原文不进入日志；长期记忆只存规则摘要。

### 0.4 测试和提交

- 每个 Task 先写失败测试并确认失败原因，再实现。
- 每个 Task 只提交列出的文件及必要联动文件，禁止 `git add -A` 吞入用户改动。
- Task 子集测试通过后运行相关层测试；每个 R 阶段末运行 typecheck + boundaries。
- R6 最终运行全量 lint/test/build 和新增 v2.1 完整旅程。
- 真实 AI smoke 必须显式 opt-in；日常验收零网络、零计费。

---

## 1. 目标文件结构

### 1.1 新建文件

```text
src/game/domain/
  turnResolution.ts
  turnResolution.test.ts
  pendingNarrativeJob.ts
  pendingNarrativeJob.test.ts
  approvedChoice.ts
  approvedChoice.test.ts
  candidateEvent.ts
  candidateEvent.test.ts
  worldGenerationCandidate.ts
  worldGenerationCandidate.test.ts

src/game/gameplay/rpg/
  dialogue/
    dialogueResolution.ts
    dialogueResolution.test.ts
    index.ts
  choices/
    approveSceneChoices.ts
    approveSceneChoices.test.ts
    index.ts
  candidateEvents/
    approveCandidateEvents.ts
    approveCandidateEvents.test.ts
    compileCandidateEvent.ts
    compileCandidateEvent.test.ts
    index.ts
  scenarioV2/
    validateWorldGenerationCandidate.ts
    validateWorldGenerationCandidate.test.ts
    compileWorldGenerationCandidate.ts
    compileWorldGenerationCandidate.test.ts
    reachability.ts
    reachability.test.ts
    index.ts

src/game/application/
  performTurn.ts
  performTurn.test.ts
  sceneGenerationContext.ts
  sceneGenerationContext.test.ts
  approveAndWriteScene.ts
  approveAndWriteScene.test.ts
  testing/v2FoundationJourney.ts
  testing/v2FoundationJourney.test.ts
  testing/v2StoryDivergenceJourney.test.ts

src/game/application/server/ai/
  liveIntentParserSourceV2.ts
  liveIntentParserSourceV2.test.ts
  liveExpansionSourceV2.ts
  liveExpansionSourceV2.test.ts
  worldGenerationSourceV2.ts
  worldGenerationSourceV2.test.ts
  sceneSourceV2.ts
  sceneSourceV2.test.ts
```

### 1.2 重点修改文件

```text
src/game/domain/action.ts
src/game/domain/events.ts
src/game/domain/narrative.ts
src/game/domain/storyState.ts
src/game/domain/worldState.ts
src/game/domain/materializedView.ts

src/game/gameplay/rpg/ruleEngine/index.ts
src/game/gameplay/rpg/ruleEngine/validateAction.ts
src/game/gameplay/rpg/ruleEngine/resolveByType.ts
src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts
src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts
src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts
src/game/gameplay/rpg/ruleEngine/resolveEnding.ts
src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts
src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts
src/game/gameplay/rpg/expansion/**

src/game/application/actionConverter.ts
src/game/application/buildChoiceMap.ts
src/game/application/performActionV2.ts
src/game/application/stateCommit.ts
src/game/application/sceneSource.ts
src/game/application/generatePendingSceneV2.ts
src/game/application/sceneWriteBack.ts
src/game/application/deterministicSceneSource.ts
src/game/application/createGameV2.ts
src/game/application/gameSessionViewV2.ts
src/game/application/handleNpcDialogueV2.ts
src/game/application/index.ts

src/game/application/server/compositionRootV2.ts
src/game/application/server/persistence/gameRepositoryV2.ts
src/game/application/server/persistence/sqliteGameRepositoryV2.ts
src/game/application/server/ai/v2SourceFactory.ts

src/app/api/v2/game/actions/route.ts
src/app/api/v2/game/npc/dialogue/route.ts
src/app/api/v2/game/narrative/ensure/route.ts
src/components/gameActionRequestV2.ts
src/components/AdventureGameShellV2.tsx
src/components/viewAdapterV2.ts
src/dependencyBoundaries.test.ts
```

---

# R1：回合事务、真实 pending 因果与单次 CAS

覆盖：FND-01、FND-11；为 FND-02、FND-12 建立基础。

## Task 1：版本语义、turnNumber 与领域标识

**Files:**
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/resolvedEvent.ts`
- Modify: `src/game/domain/events.ts`
- Create: `src/game/domain/turnResolution.ts`
- Test: `src/game/domain/storyState.test.ts`
- Test: `src/game/domain/turnResolution.test.ts`

- [ ] **Step 1：写失败测试**

测试必须覆盖：

- 新 Story State 初始化 `turnNumber = 0`；
- `version` 升级到本次明确的新 schema 版本；
- `TurnResolution` 明确包含 turnId/actionId/baseRevision/turnNumber/action/primaryResult/domainEvents/next states；
- `ResolvedEvent` 不再用 eventLedger 长度表达 stateVersion；
- 一个回合含多个 GameEvent 时 turnNumber 仍只增加 1；
- domain helper 不读取 `Date.now()` 或随机数。

- [ ] **Step 2：运行失败测试**

Run：

```text
npm run test:game-domain -- src/game/domain/storyState.test.ts src/game/domain/turnResolution.test.ts
```

Expected：因缺少 turnNumber/TurnResolution 或旧 stateVersion 语义失败。

- [ ] **Step 3：实现最小领域契约**

要求：

- 使用 branded `TurnId`/`NarrativeJobId` 或现有安全 ID helper；
- `TurnResolution` 是规则编排结果，不承担 IO；
- `domainEvents` 为有序数组；
- schema version 与 DB revision 完全分离；
- 为后续旧 v2 存档识别保留稳定错误分类，不在 domain 中静默迁移。

- [ ] **Step 4：运行 domain 测试与 typecheck**

Run：

```text
npm run test:game-domain
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`feat(domain): 建立 v2.1 回合版本与 TurnResolution 契约`

---

## Task 2：PendingNarrativeJob 成为 narrative pending 的唯一载体

**Files:**
- Create: `src/game/domain/pendingNarrativeJob.ts`
- Test: `src/game/domain/pendingNarrativeJob.test.ts`
- Modify: `src/game/domain/narrative.ts`
- Test: `src/game/domain/narrative.test.ts`

- [ ] **Step 1：写失败测试**

断言：

- pending 变体必须含 `job`，不能只有 requestedAt；
- job 包含 actionId/turnId/turnNumber/basedOnRevision/actionSummary/resolvedEvent/domain event range/requestedAt；
- talk/free text job 可带 bounded utterance 和 focusNpcId；
- job JSON round-trip 后信息不丢失；
- `basedOnRevision = expectedRevision + 1` 的构造 helper 有显式测试；
- idle/ready 状态不残留玩家原文；
- job 构造拒绝空 actionId、无效 ledger range 和超长 utterance。

- [ ] **Step 2：运行失败测试**

Run：`npm run test:game-domain -- src/game/domain/pendingNarrativeJob.test.ts src/game/domain/narrative.test.ts`

- [ ] **Step 3：实现类型与纯构造函数**

要求：

- utterance 上限引用统一常量；
- job 保存当前场景生成必需的结构化摘要，不保存完整 World State；
- `actionSummary` 不允许任意 path patch；
- 玩家原文不得进入 GameEvent 的通用日志字段。

- [ ] **Step 4：回归 domain 测试**

- [ ] **Step 5：提交**

建议提交：`feat(domain): pending narrative 持久化真实回合因果`

---

## Task 3：RuleEngine 输出完整 TurnResolution

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/index.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveEnding.ts`

- [ ] **Step 1：写失败集成测试**

覆盖 move、talk、partial_success、blocked、battle victory：

- `TurnResolution.action` 等于转换后的真实 Action；
- `primaryResult.eventKind/status` 保真；
- domainEvents 包含 resolver、任务和结局事件，顺序稳定；
- `nextWorldState.eventLedger` 与 domainEvents 对齐；
- blocked/invalid 不产生 next state commit payload；
- actionId/turnId/turnNumber 贯穿结果；
- 一回合多个事件仍只增加一个 turnNumber。

- [ ] **Step 2：运行失败测试**

Run：`npm run test:game-gameplay -- src/game/gameplay/rpg/ruleEngine/index.test.ts`

- [ ] **Step 3：重构 facade，保留纯函数边界**

实现策略：

- 可以先保留当前内部 `RuleEngineResult`，新增纯 `resolveTurn` facade；
- 在本 Task 结束前，application 不再自己拼 ResolvedEvent；
- `triggeredEvents: string[]` 只保留兼容展示，不再作为完整事件源；
- 拒绝路径返回稳定 code、feedback 和零写入信息。

- [ ] **Step 4：运行 gameplay 层测试**

Run：

```text
npm run test:game-gameplay
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`refactor(rule-engine): 以 TurnResolution 收敛单回合规则结果`

---

## Task 4：单次 CAS 同时提交规则状态和 PendingNarrativeJob

**Files:**
- Create: `src/game/application/performTurn.ts`
- Test: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/stateCommit.ts`
- Test: `src/game/application/stateCommit.test.ts`
- Modify: `src/game/application/server/persistence/gameRepositoryV2.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepositoryV2.ts`
- Test: `src/game/application/server/persistence/sqliteGameRepositoryV2.test.ts`
- Modify: `src/game/application/performActionV2.ts`

- [ ] **Step 1：写失败用例测试**

必须证明：

- 成功回合 repository `applyState` 只调用一次；
- 该次写入同时包含 World State、Story State.turnNumber 和 pending job；
- pending job.resolvedEvent 等于真实 TurnResolution.primaryResult；
- pending job.basedOnRevision 等于提交后的 revision；
- 构造 pending job 失败时 repository 零写入；
- CAS stale 时不返回行动成功；
- rule reject 时零写入；
- scene queue 不再存在第二次“非致命” commit。

- [ ] **Step 2：写 SQLite 原子性测试**

故障注入点至少覆盖：

- JSON 序列化失败；
- UPDATE 前失败；
- stale revision；
- read-back 失败；
- transaction rollback 后 World/Story 均保持旧值。

- [ ] **Step 3：实现 performTurn 和兼容壳**

要求：

- `performActionV2` 暂时作为 thin alias/adapter 调用 `performTurn`，避免大范围入口同时破坏；
- action conversion、rule resolution、pending job 构造、commit 顺序集中在 application；
- repository 不理解业务，只原子保存传入的新双状态；
- commit 后返回保存记录，不从未保存的内存结果投影视图。

- [ ] **Step 4：运行 application + persistence 测试**

Run：

```text
npm run test:game-application -- src/game/application/performTurn.test.ts src/game/application/stateCommit.test.ts src/game/application/server/persistence/sqliteGameRepositoryV2.test.ts
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`refactor(application): 单次 CAS 提交回合事实与叙事任务`

---

## Task 5：SceneGenerator 消费真实 job，不再伪造 ResolvedEvent

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Create: `src/game/application/sceneGenerationContext.ts`
- Test: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/generatePendingSceneV2.ts`
- Test: `src/game/application/generatePendingSceneV2.test.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`
- Test: `src/game/application/deterministicSceneSource.test.ts`

- [ ] **Step 1：写失败测试**

断言：

- move job 生成器收到 travel，而非 observe；
- partial_success/failure/blocked 状态不被改写；
- talk utterance 和 focusNpcId 保留；
- ensure 不创建新的 actionId 或伪 ResolvedEvent；
- 进程重启后从 repository job 恢复相同 context；
- fallback sceneId/choiceToken 由 jobId/turnId 纯函数派生，两次调用完全相同；
- 旧 pending 无 job 返回稳定 `legacy_pending`/`unavailable` 分类，不伪装成功恢复。

- [ ] **Step 2：运行失败测试**

Run：`npm run test:game-application -- src/game/application/generatePendingSceneV2.test.ts src/game/application/deterministicSceneSource.test.ts`

- [ ] **Step 3：实现 job 驱动上下文**

本阶段 context 可以先包含最小现有字段；R5 再完成 NPC 知识裁剪。禁止 SceneSource 接收整个 GameRecord。

- [ ] **Step 4：删除 `Date.now()` scene ID**

所有离线/fallback ID 从稳定输入派生。测试不得 mock 全局时间来维持确定性。

- [ ] **Step 5：运行 R1 回归**

Run：

```text
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application
npm run test:boundaries
npm run typecheck
```

- [ ] **Step 6：提交**

建议提交：`fix(narrative): SceneGenerator 消费持久化回合结果`

---

## Task 6：Expansion 路径统一进入 TurnResolution 和 pending

**Files:**
- Modify: `src/game/application/performTurn.ts`
- Test: `src/game/application/performTurn.test.ts`
- Modify: `src/game/gameplay/rpg/expansion/index.ts`
- Test: `src/game/gameplay/rpg/expansion/index.test.ts`
- Modify: `src/game/application/p3OfflineRegression.test.ts`

- [ ] **Step 1：写失败测试**

覆盖：

- 未知 NPC 扩展 + 重演算成功后一次 CAS、真实 dialogue pending；
- 未知地点扩展 + 重演算成功后一次 CAS、真实 travel pending；
- 重演算仍失败时 commit 结果不能被忽略；
- 审批拒绝保持原行动拒绝且零规则写入；
- Expansion AI/source 失败不破坏普通合法行动；
- 不发生第二轮 Expansion。

- [ ] **Step 2：移动 AI source 调用责任**

在 application 中编排 source；gameplay `expansion/` 仅保留纯 trigger/approve/apply/re-evaluate helper。若重演算 facade 需要 callback，callback 必须是显式纯规则函数，不得在 gameplay 内 await source。

- [ ] **Step 3：实现并运行测试**

Run：

```text
npm run test:game-gameplay -- src/game/gameplay/rpg/expansion
npm run test:game-application -- src/game/application/performTurn.test.ts src/game/application/p3OfflineRegression.test.ts
npm run test:boundaries
npm run typecheck
```

- [ ] **Step 4：提交**

建议提交：`fix(expansion): 扩展重演算统一进入原子回合流水线`

---

## R1 阶段验收

- [ ] 同一回合只增长一次规则 revision；
- [ ] pending job 保存真实 Action/ResolvedEvent/utterance；
- [ ] ensure 不再构造伪事件；
- [ ] Expansion 成功路径产生对应场景；
- [ ] fallback 可确定性 replay；
- [ ] FND-01、FND-11 对应测试全部通过。

---

# R2：统一输入、对话语义与 ApprovedChoice

覆盖：FND-02、FND-03、FND-04、FND-10；继续强化 FND-01。

## Task 7：TalkAction 对话语义和关系裁决

**Files:**
- Modify: `src/game/domain/action.ts`
- Test: `src/game/domain/action.test.ts`
- Create: `src/game/gameplay/rpg/dialogue/dialogueResolution.ts`
- Create: `src/game/gameplay/rpg/dialogue/dialogueResolution.test.ts`
- Create: `src/game/gameplay/rpg/dialogue/index.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/validateAction.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`

- [ ] **Step 1：写失败领域测试**

定义并覆盖 `DialogueAct`：ask/support/challenge/threaten/deceive/offer/refuse/reassure；topic 支持 fact/quest/thread/general；utterance 可选且规则不得读取其文本决定成功。

- [ ] **Step 2：写失败规则测试**

至少覆盖：

- 首次 ask 与重复 ask 的关系变化不同；
- support/challenge/threaten 对同一 NPC 产生不同结构化结果；
- NPC 不知道 topic fact 时不能直接透露；
- hostile/trusted 档位影响 willingness，但不允许 AI 直接修改关系；
- 同一固定选择重复点击不重复获得首次见面奖励；
- 规则生成稳定 NpcInteraction 摘要。

- [ ] **Step 3：实现纯 dialogue facade 并集成 resolver**

- [ ] **Step 4：运行测试**

Run：

```text
npm run test:game-domain -- src/game/domain/action.test.ts
npm run test:game-gameplay -- src/game/gameplay/rpg/dialogue src/game/gameplay/rpg/ruleEngine
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`feat(dialogue): 固定对话选择进入结构化规则裁决`

---

## Task 8：ApprovedChoice 与场景选择审批

**Files:**
- Create: `src/game/domain/approvedChoice.ts`
- Test: `src/game/domain/approvedChoice.test.ts`
- Create: `src/game/gameplay/rpg/choices/approveSceneChoices.ts`
- Create: `src/game/gameplay/rpg/choices/approveSceneChoices.test.ts`
- Create: `src/game/gameplay/rpg/choices/index.ts`
- Modify: `src/game/domain/narrative.ts`
- Modify: `src/game/application/buildChoiceMap.ts`
- Test: `src/game/application/buildChoiceMap.test.ts`

- [ ] **Step 1：写失败测试**

断言：

- ApprovedChoice 绑定 sceneId/basedOnRevision/label/action/semanticSummary；
- opaque token 不含 actionKey、实体 ID 或可解析业务语义；
- 两个语义重复选择被拒绝；
- label 与 action 明显不一致被拒绝或整体 fallback；
- 不存在/不在场/不可达目标被拒绝；
- token 只在当前 scene + revision 有效；
- registry server persistence round-trip 后可解析相同 Action。

- [ ] **Step 2：实现候选→审批→registry**

SceneSource 输出应改为 `ChoiceProposal[]`，不能直接输出持久化 ApprovedChoice。审批函数逐字段重建结果，禁止返回 AI 原对象引用。

- [ ] **Step 3：调整 buildChoiceMap**

只从持久化 registry 构建 token→Action；删除 `parseActionKey` 作为生产选择入口。调试 helper 若保留必须 server-only 且不进入 read model。

- [ ] **Step 4：运行测试与边界**

Run：

```text
npm run test:game-domain -- src/game/domain/approvedChoice.test.ts
npm run test:game-gameplay -- src/game/gameplay/rpg/choices
npm run test:game-application -- src/game/application/buildChoiceMap.test.ts
npm run test:boundaries
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`feat(choices): 服务端审批并注册 opaque 场景选项`

---

## Task 9：固定选择与自由文本统一 performTurn

**Files:**
- Modify: `src/game/application/actionConverter.ts`
- Test: `src/game/application/actionConverter.test.ts`
- Modify: `src/game/application/performTurn.ts`
- Test: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/handleNpcDialogueV2.ts`
- Test: `src/game/application/handleNpcDialogueV2.test.ts`
- Modify: `src/game/application/server/compositionRootV2.ts`
- Create: `src/game/application/server/ai/liveIntentParserSourceV2.ts`
- Test: `src/game/application/server/ai/liveIntentParserSourceV2.test.ts`

- [ ] **Step 1：写自由文本端到端失败测试**

覆盖：

- targetNpcId + “我相信你” → support TalkAction → TurnResolution → NPC memory → pending job；
- “你在撒谎” → challenge TalkAction，与 support 产生不同关系/事件；
- “我的等级升到100” → freeform，属性不变，但产生 `player_intent_expressed` 和可回应 pending；
- source 超时/非法 JSON → freeform fallback；
- pending 期间自由文本被拒绝；
- NPC 不在场时零写入；
- chat 不再走零 CAS 旁路；轻量问候仍形成受规则记录的对话回合。

- [ ] **Step 2：让 handleNpcDialogueV2 成为 thin adapter**

兼容 NPC HTTP 入口可以保留，但内部构造 `Interaction.free_text` 并调用 `performTurn`。删除直接写 `playerNpcChat` pending 的逻辑。

- [ ] **Step 3：装配 live/fixture IntentParserSource**

AI 有效时 live；无配置时 fixture/规则预分类；两者输出都必须再经过 Action schema 和目标合法性检查。

- [ ] **Step 4：运行 application/server 测试**

Run：

```text
npm run test:game-application -- src/game/application/actionConverter.test.ts src/game/application/performTurn.test.ts src/game/application/handleNpcDialogueV2.test.ts src/game/application/server/ai/liveIntentParserSourceV2.test.ts
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`refactor(input): 固定选择与 NPC 自定义输入统一回合入口`

---

## Task 10：API discriminated union、UUID 和错误语义

**Files:**
- Modify: `src/app/api/v2/game/actions/route.ts`
- Add/Modify Test: `src/app/api/v2/game/actions/route.test.ts` 或 handler test
- Modify: `src/app/api/v2/game/npc/dialogue/route.ts`
- Add/Modify Test: 对应 dialogue route/handler test
- Modify: `src/components/gameActionRequestV2.ts`
- Test: `src/components/gameActionRequestV2.test.ts`

- [ ] **Step 1：写失败 API 契约测试**

覆盖未知 kind、未知字段、空 token、空/超长 text、非法 targetNpcId、负数/小数 revision、错误 HTTP 状态，以及合法 fixed/free 请求。

- [ ] **Step 2：实现显式解析器**

禁止 `as never` 将原始 body 直接送入用例。解析器只返回白名单 Interaction。

- [ ] **Step 3：客户端 actionId 改用 UUID**

浏览器使用 `crypto.randomUUID()`，提供测试环境可注入 fallback；不得使用 `Date.now()` 作为唯一 actionId。

- [ ] **Step 4：实现 HTTP 状态映射**

400 输入、404 无存档、409 stale、业务拒绝稳定 422/业务码、503 基础设施、500 损坏/未知错误。

- [ ] **Step 5：运行 app/components 测试**

Run：

```text
npm run test:app
npm run test:components -- src/components/gameActionRequestV2.test.ts
npm run typecheck
```

- [ ] **Step 6：提交**

建议提交：`fix(api): 严格校验 v2 Interaction 与回合错误语义`

---

## Task 11：Read model 移除 actionKey 和 NPC 选项串线

**Files:**
- Modify: `src/game/application/gameSessionViewV2.ts`
- Test: `src/game/application/gameSessionViewV2.test.ts`
- Modify: `src/components/viewAdapterV2.ts`
- Test: `src/components/viewAdapterV2.test.ts`
- Modify: `src/components/AdventureGameShellV2.tsx`
- Test: relevant component tests

- [ ] **Step 1：写零泄漏失败测试**

序列化 view 并断言不含：actionKey、ApprovedAction、choice registry、PendingNarrativeJob、candidateEventPool、未发现事实正文、其他 NPC hidden facts。

- [ ] **Step 2：写焦点 NPC 测试**

- 只有 focusNpc 获得当前两个 dialogue choices；
- 其他在场 NPC 只展示自己的台词；
- 世界行动选择不被投影为每个 NPC 的对话选择；
- 自定义输入只对焦点 NPC 开启。

- [ ] **Step 3：修改 view 和适配器**

客户端只保留 `{ choiceToken, label, hint? }`，不再解析字符串构造 Action。

- [ ] **Step 4：运行 application/components 测试**

Run：

```text
npm run test:game-application -- src/game/application/gameSessionViewV2.test.ts
npm run test:components
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`fix(read-model): 隐藏 actionKey 并隔离焦点 NPC 选项`

---

## R2 阶段验收

- [ ] 两个固定 NPC 选择产生不同结构化规则结果；
- [ ] 自定义输入和固定选择共用一次 performTurn；
- [ ] 客户端无法看到或构造 actionKey；
- [ ] 篡改/过期 token 零写入；
- [ ] freeform 越权声明零事实变化但能生成回应；
- [ ] FND-02、FND-03、FND-04、FND-10 对应测试通过。

---

# R3：完整开局世界、任务图和多结局可达性

覆盖：FND-06、FND-07、FND-10；为 FND-12 提供可完成世界。

## Task 12：WorldGenerationCandidate 完整领域契约

**Files:**
- Create: `src/game/domain/worldGenerationCandidate.ts`
- Test: `src/game/domain/worldGenerationCandidate.test.ts`
- Modify: `src/game/application/createGameV2.ts`
- Modify: `src/game/application/server/ai/v2SourceFactory.ts`（后续拆除旧 world source）

- [ ] **Step 1：写失败类型/fixture 测试**

候选必须覆盖：

- 世界约束、公开/隐藏事实；
- 玩家、地点、NPC、物品、敌人、阵营；
- NPC 初始 known/hidden facts 和 goals；
- 与 gameLength/targetActs 对齐的主线任务骨架；
- 0–2 支线；
- 至少两个非空 requirements 的语义不同结局；
- 起始地点/NPC/任务/main thread；
- opening budget counts。

测试至少提供 wuxia/scifi/urban 三个最小合法 fixture，以及引用断裂、空结局、无起始锚点等非法 fixture。

- [ ] **Step 2：实现纯 candidate 类型和 schema parser**

AI 原始 unknown 必须先经 schema parser，不能直接断言成 Entry 数组。schema parser 只做形状/枚举/长度检查；引用和可达性留给 gameplay validator。

- [ ] **Step 3：运行 domain 测试**

Run：`npm run test:game-domain -- src/game/domain/worldGenerationCandidate.test.ts`

- [ ] **Step 4：提交**

建议提交：`feat(domain): 定义完整 v2.1 世界生成候选契约`

---

## Task 13：世界引用、地点图、任务图和结局可达性 validator

**Files:**
- Create: `src/game/gameplay/rpg/scenarioV2/validateWorldGenerationCandidate.ts`
- Create: `src/game/gameplay/rpg/scenarioV2/validateWorldGenerationCandidate.test.ts`
- Create: `src/game/gameplay/rpg/scenarioV2/reachability.ts`
- Create: `src/game/gameplay/rpg/scenarioV2/reachability.test.ts`
- Create: `src/game/gameplay/rpg/scenarioV2/index.ts`

- [ ] **Step 1：写失败 validator 测试矩阵**

按稳定错误码覆盖：

- duplicate_id；
- missing_reference；
- starting_location_missing；
- unreachable_location；
- locked_location_without_unlock_path；
- main_act_gap；
- first_act_not_actionable；
- quest_predecessor_missing/cycle；
- objective_unreachable；
- ending_requirement_empty；
- ending_unreachable；
- insufficient_distinct_endings；
- npc_fact_reference_invalid；
- budget_exceeded/hard_limit_exceeded；
- invalid_starting_inventory/location/NPC。

- [ ] **Step 2：实现图算法纯 helper**

要求：

- 地点连通与任务依赖分别建图；
- 解锁条件作为边/门条件显式分析；
- validator 不执行 AI 修复；
- 同一 candidate 结果确定；
- 错误包含稳定 code 和最小定位 ID，不包含完整秘密正文。

- [ ] **Step 3：加入“至少两条结局路线”证明**

验证不是仅有两个 EndingEntry，而是从开局任务图存在两组可满足 requirements 的结构路径。

- [ ] **Step 4：运行 gameplay 测试**

Run：`npm run test:game-gameplay -- src/game/gameplay/rpg/scenarioV2`

- [ ] **Step 5：提交**

建议提交：`feat(scenario): 校验开局世界与多结局可达性`

---

## Task 14：编译候选为 World/Story State，移除正常路径硬编码主线

**Files:**
- Create: `src/game/gameplay/rpg/scenarioV2/compileWorldGenerationCandidate.ts`
- Create: `src/game/gameplay/rpg/scenarioV2/compileWorldGenerationCandidate.test.ts`
- Modify: `src/game/application/createGameV2.ts`
- Test: `src/game/application/createGameV2.test.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/domain/storyState.ts`

- [ ] **Step 1：写失败 compile 测试**

断言：

- candidate 定义和 runtime 正确进入单一 World State；
- starting/unlocked/visited 集合正确；
- NPC memory 初始知识和 goals 正确；
- main thread、targetActs、budget opening、tension 初值正确；
- 第一幕任务 active，其余任务按图 locked；
- 两个结局 requirements 保留；
- 相同 candidate 编译结果完全相同；
- compiler 不读取时间/随机，generation metadata 由调用方显式传入。

- [ ] **Step 2：修改 createGameV2 编排**

流程固定为：source → schema parse → validate → 一次修复（后续 Task）→ compile → createInitialGame。删除正常生成路径中的固定“探索未知世界”和空 requirements“冒险成功”。

- [ ] **Step 3：旧 v2 record 策略**

repository 明确识别不兼容 schema，返回 `LEGACY_V2_RECORD`/corrupt 分类；开发清档可恢复。禁止用大量 optional default 把旧因果不完整状态伪装成新状态。

- [ ] **Step 4：运行 domain/gameplay/application 测试**

Run：

```text
npm run test:game-domain
npm run test:game-gameplay -- src/game/gameplay/rpg/scenarioV2
npm run test:game-application -- src/game/application/createGameV2.test.ts
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`refactor(create-game): 从已验证候选编译完整双状态`

---

## Task 15：地点解锁和完整任务 outcome

**Files:**
- Modify: `src/game/domain/events.ts`
- Test: `src/game/domain/events.test.ts`
- Modify: `src/game/domain/worldState.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/validateAction.ts`
- Modify: `src/game/application/gameSessionViewV2.ts`

- [ ] **Step 1：写失败任务图测试**

覆盖：

- 完成第一幕任务 → `unlock_quests` 和 `location_unlocked` 同回合；
- 解锁后的任务可在固定点 reconciliation 中继续检查，但不重复完成；
- onSuccess reach_ending 只设置可达要求，不绕过 ending resolver；
- onFailure 解锁失败路线或关闭任务；
- locked 地点在规则解锁前不可移动，解锁后进入 ApprovedChoice 候选；
- reload 后解锁状态一致。

- [ ] **Step 2：实现显式 unlock 事件和纯 reducer**

禁止把已存在 locked 地点交给 ExpansionProposer。地点解锁只能来自规则 outcome、事实、权限、物品或批准候选事件。

- [ ] **Step 3：运行规则与 view 测试**

Run：

```text
npm run test:game-gameplay -- src/game/gameplay/rpg/ruleEngine
npm run test:game-application -- src/game/application/gameSessionViewV2.test.ts
npm run typecheck
```

- [ ] **Step 4：提交**

建议提交：`feat(quests): 任务 outcome 驱动地点和后续任务解锁`

---

## Task 16：修正幕、进度、伏笔、节奏和结局顺序

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/advanceStoryProgression.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveEnding.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/resolveEnding.test.ts`

- [ ] **Step 1：写失败顺序测试**

构造最终主线行动，断言同一 TurnResolution 内：

1. 行动完成；
2. quest completed；
3. storyProgress/currentAct 更新；
4. thread 回收；
5. endingAllowed 变 true；
6. ending_reached 写入；
7. nextPacingNeed 为 resolve；
8. 不需要额外点击一次。

- [ ] **Step 2：写确定性指标测试**

- storyProgress 由主线 stage/目标比例推导，不靠任意任务固定 +10；
- 支线不直接推进主幕；
- rest 固定 tension -10 并产生 player_rested；
- battle/fact/quest/NPC 首遇固定张力值与 spec 一致；
- 重复 talk 不重复首遇 +3；
- unresolved thread ID 创建/回收命名一致；
- 强制 thread 或强制候选事件未处理时 endingAllowed=false。

- [ ] **Step 3：按固定顺序重排 rule facade**

顺序必须与 Spec §13.1 一致，并以集成测试锁定。不要靠注释维持。

- [ ] **Step 4：运行 gameplay 回归**

Run：

```text
npm run test:game-gameplay -- src/game/gameplay/rpg/ruleEngine
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`fix(story): 同回合收敛任务节奏伏笔与结局`

---

## Task 17：live/fixture 世界源、修复和完整开局回归

**Files:**
- Create: `src/game/application/server/ai/worldGenerationSourceV2.ts`
- Create: `src/game/application/server/ai/worldGenerationSourceV2.test.ts`
- Modify: `src/game/application/server/ai/v2SourceFactory.ts`
- Modify: `src/game/application/server/compositionRootV2.ts`
- Add fixtures: `data/fixtures/v2-foundation/worlds/**`
- Add regression: `src/game/application/v2WorldGenerationRegression.test.ts`

- [ ] **Step 1：写 source 契约测试**

覆盖：有效结构化候选、非法 JSON、schema 错误、引用错误、超预算、一次机械修复、一次 AI 修复失败、确定性 fallback、敏感信息不进入日志。

- [ ] **Step 2：实现 source 与审批编排**

- prompt 使用完整 candidate schema；
- parse 后仍必须走纯 validator；
- 机械修复只允许 ID 格式/空数组/显式可推导引用等无创意修复；
- 不得修改剧情语义来“让测试通过”；
- fallback fixture 必须通过同一 validator/compiler。

- [ ] **Step 3：加入题材×长度矩阵**

至少 7 题材 × short/medium/long；日常使用 fixture，不真实调用。

- [ ] **Step 4：运行 R3 回归**

Run：

```text
npm run test:game-domain
npm run test:game-gameplay
npm run test:game-application -- src/game/application/createGameV2.test.ts src/game/application/v2WorldGenerationRegression.test.ts
npm run test:boundaries
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`feat(world-generation): 生成并验证可完成多结局世界`

---

## R3 阶段验收

- [ ] 正常路径不再硬编码单任务/空条件结局；
- [ ] locked 主线地点均有规则解锁路径；
- [ ] targetActs 与主线任务图一致；
- [ ] 最终行动同回合抵达结局；
- [ ] 至少两个结局图上可达；
- [ ] FND-06、FND-07、FND-10 对应测试通过。

---

# R4：AI 候选事件成为真实世界推动力

覆盖：FND-05、FND-07；为 FND-12 提供动态故事分化。

## Task 18：结构化 EventCandidate 与 proposed effects

**Files:**
- Create: `src/game/domain/candidateEvent.ts`
- Create: `src/game/domain/candidateEvent.test.ts`
- Modify: `src/game/domain/storyState.ts`
- Modify: `src/game/domain/events.ts`
- Test: `src/game/domain/events.test.ts`

- [ ] **Step 1：写失败类型测试**

支持至少：npc_reveals_fact、npc_changes_stance、hostile_force_acts、enemy_appears、thread_complicates、thread_resolves、location_state_changes。

每条必须含 involved IDs、prerequisites、proposedEffects、intendedPacing、reason、proposedAtTurn、expiresAtTurn。description 不能作为唯一执行字段。

- [ ] **Step 2：定义审计事件**

至少：candidate_event_proposed、approved、rejected、expired、activated。事件不得携带完整 AI 原文或隐藏事实正文。

- [ ] **Step 3：运行 domain 测试并提交**

Run：`npm run test:game-domain`

建议提交：`feat(events): 定义可审批可执行的 AI 候选事件`

---

## Task 19：纯候选事件审批、编译和应用

**Files:**
- Create: `src/game/gameplay/rpg/candidateEvents/approveCandidateEvents.ts`
- Create: `src/game/gameplay/rpg/candidateEvents/approveCandidateEvents.test.ts`
- Create: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.ts`
- Create: `src/game/gameplay/rpg/candidateEvents/compileCandidateEvent.test.ts`
- Create: `src/game/gameplay/rpg/candidateEvents/index.ts`
- Remove/Replace: `src/game/gameplay/rpg/ruleEngine/approveCandidateEvents.ts`

- [ ] **Step 1：写审批失败测试矩阵**

覆盖：预算不足、过期、重复 ID、实体不存在/死亡、prerequisite 未满足、事实冲突、pacing 不允许、ending 已抵达、超过每回合 1 条。

- [ ] **Step 2：写批准→真实事件测试**

每种支持 kind 至少一条：批准后必须生成真实 GameEvent 和明确 next state；只 tension +10 而无领域事件必须失败。

- [ ] **Step 3：实现纯 approve/compile/apply**

逐字段重建批准对象；禁止执行任意 path patch；effect 必须是封闭 union 并由规则编译。

- [ ] **Step 4：运行 gameplay 测试**

Run：`npm run test:game-gameplay -- src/game/gameplay/rpg/candidateEvents`

- [ ] **Step 5：提交**

建议提交：`feat(candidate-events): 审批并编译 AI 事件为领域事实`

---

## Task 20：按“玩家行动优先”顺序集成 TurnResolution

**Files:**
- Modify: `src/game/gameplay/rpg/ruleEngine/index.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/index.test.ts`
- Modify: `src/game/application/performTurn.ts`
- Test: `src/game/application/performTurn.test.ts`
- Modify: `src/game/domain/materializedView.ts`
- Test: `src/game/domain/materializedView.test.ts`

- [ ] **Step 1：写顺序测试**

断言当前已批准选择先完成，再激活上一场候选；候选不能在提交前让已点击 Action 突然变 invalid。玩家事件和反应事件共同进入 TurnResolution，顺序固定。

- [ ] **Step 2：写候选池生命周期测试**

- FIFO 上限 8；
- 同 ID 去重；
- 每回合最多批准 1 条；
- rejected/expired 从池移除并有审计；
- 未处理保留原顺序；
- materialized recentBeats 能看到批准反应但不含 AI 原文。

- [ ] **Step 3：实现集成并运行测试**

Run：

```text
npm run test:game-domain -- src/game/domain/materializedView.test.ts
npm run test:game-gameplay -- src/game/gameplay/rpg/ruleEngine src/game/gameplay/rpg/candidateEvents
npm run test:game-application -- src/game/application/performTurn.test.ts
npm run typecheck
```

- [ ] **Step 4：提交**

建议提交：`feat(turn): 玩家行动后激活 AI 候选世界反应`

---

## Task 21：SceneSource 生成候选事件并经 SceneWriteBack 追加

**Files:**
- Modify: `src/game/application/sceneSource.ts`
- Create: `src/game/application/approveAndWriteScene.ts`
- Test: corresponding scene approval/writeback tests
- Create/Modify: `src/game/application/server/ai/sceneSourceV2.ts`
- Test: `src/game/application/server/ai/sceneSourceV2.test.ts`
- Modify: `src/game/application/sceneWriteBack.ts`
- Test: `src/game/application/sceneWriteBack.test.ts`

- [ ] **Step 1：写场景提议测试**

AI 场景可以提出 0..N 个 candidate，但审批后最多按池规则追加；当前 scene writeback 不得改变 World State、tension、任务、关系或立即执行候选。

- [ ] **Step 2：实现 candidate schema/repair**

非法候选丢弃，不让整个合法场景失败；但候选中夹带 path patch、未知实体或未授权事实时必须拒绝并记录分类。

- [ ] **Step 3：持久化测试**

SQLite applySceneWriteBack 仍只 patch narrative + registry + candidate pool；增加列/字段时保持 CAS 和故障注入覆盖。

- [ ] **Step 4：运行 R4 回归**

Run：

```text
npm run test:game-domain
npm run test:game-gameplay -- src/game/gameplay/rpg/candidateEvents src/game/gameplay/rpg/ruleEngine
npm run test:game-application -- src/game/application/generatePendingSceneV2.test.ts src/game/application/sceneWriteBack.test.ts src/game/application/server/ai/sceneSourceV2.test.ts
npm run test:boundaries
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`feat(scene): 场景提议进入下一回合候选事件池`

---

## R4 阶段验收

- [ ] AI candidate 当前场景不直接修改世界；
- [ ] 下一回合批准后产生正式 GameEvent 和状态变化；
- [ ] 过期/冲突/预算不足明确拒绝；
- [ ] 规则结果影响后续 scene context 或合法行动；
- [ ] FND-05、FND-07 对应测试通过。

---

# R5：NPC 记忆、知识隔离和最小权限 Scene Context

覆盖：FND-08、FND-10；强化 FND-03、FND-12。

## Task 22：NpcInteraction v2.1 和对话记忆闭环

**Files:**
- Modify: `src/game/domain/worldState.ts`
- Test: `src/game/domain/worldState.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/updateNpcMemory.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts`
- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.ts`
- Test: `src/game/gameplay/rpg/dialogue/dialogueResolution.test.ts`

- [x] **Step 1：写失败记忆测试**

NpcInteraction 必须含 turnNumber/actionId/locationId/dialogueAct/topicSummary/outcome/relationshipDelta/learnedFactIds/规则摘要。覆盖：

- 历史最多 10 条；
- 首次/重复交互摘要不同；
- support/challenge/threaten/freeform 产生稳定不同摘要；
- relationship clamp；
- emotion 由规则结果更新；
- 玩家原文不进入长期 summary；
- 同 actionId 不因错误重试追加两次（CAS 失败路径零写入）。

- [x] **Step 2：实现并集成 TalkAction/free text**

- [x] **Step 3：运行 domain/gameplay 测试**

Run：

```text
npm run test:game-domain -- src/game/domain/worldState.test.ts
npm run test:game-gameplay -- src/game/gameplay/rpg/dialogue src/game/gameplay/rpg/ruleEngine/updateNpcMemory.test.ts
npm run typecheck
```

- [x] **Step 4：提交**

建议提交：`feat(npc-memory): 记录结构化对话语义与规则结果`

---

## Task 23：FactChange audience 与知识传播来源

**Files:**
- Modify: `src/game/domain/resolvedEvent.ts`
- Modify: `src/game/domain/events.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts`
- Modify: relevant investigate/dialogue/candidate event resolvers

- [x] **Step 1：写失败知识传播测试**

区分：scene_witness、player_told、npc_revealed、public_broadcast、faction_shared。断言：

- 玩家私下调查不会自动让所有当前地点 met NPC 知道；
- NPC 在场目击才传播；
- 玩家明确告知目标 NPC 后传播；
- NPC 透露事实给玩家不等于其他 NPC 自动知道；
- knownFactIds 去重且永不裁剪；
- 未知/不存在 fact 或 audience 被拒绝；
- 同 ledger replay 得到相同知识分布。

- [x] **Step 2：实现封闭传播来源和纯 reducer**

- [x] **Step 3：运行 rule engine 测试并提交**

Run：`npm run test:game-gameplay -- src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.test.ts src/game/gameplay/rpg/ruleEngine`

建议提交：`fix(knowledge): 按明确受众传播 NPC 已知事实`

---

## Task 24：SceneGenerationContext 最小权限 DTO

**Files:**
- Create: `src/game/application/sceneGenerationContext.ts`
- Create: `src/game/application/sceneGenerationContext.test.ts`
- Modify: `src/game/application/sceneSource.ts`
- Modify: `src/game/application/generatePendingSceneV2.ts`
- Modify: `src/game/domain/materializedView.ts`（仅必要类型）

- [x] **Step 1：写 context 快照/零泄漏测试**

构造两个 NPC 各自秘密，断言焦点 NPC context 只含：

- 自己公开档案；
- 自己 known/hidden fact cards；
- 当前场景可见 facts；
- 自己最近交互；
- relationship/emotion/goals；
- forbidden knowledge 索引；
- 规则结果和玩家本回合 utterance；
- Story pacing/budget summary；
- 最多规定数量 recentBeats。

明确断言 context JSON 不含：

- 另一个 NPC 私密事实正文；
- 完整 World/Story State；
- 完整 eventLedger；
- DB/provider/environment/config；
- candidate pool 全部内部 effect；
- choice registry 的其它内部 Action。

- [x] **Step 2：实现 application projector**

SceneSource port 只接受 DTO。禁止先把完整 state 传给 source 再让 adapter 自行过滤。

- [x] **Step 3：运行 application + boundary tests**

Run：

```text
npm run test:game-application -- src/game/application/sceneGenerationContext.test.ts src/game/application/generatePendingSceneV2.test.ts
npm run test:boundaries
npm run typecheck
```

- [x] **Step 4：提交**

建议提交：`refactor(scene-context): 以最小权限 DTO 隔离 NPC 知识`

---

## Task 25：live SceneSource prompt、输出审批和 fallback

**Files:**
- Create/Modify: `src/game/application/server/ai/sceneSourceV2.ts`
- Test: `src/game/application/server/ai/sceneSourceV2.test.ts`
- Create/Modify: `src/game/application/approveAndWriteScene.ts`
- Test: `src/game/application/approveAndWriteScene.test.ts`
- Modify: `src/game/application/deterministicSceneSource.ts`

- [x] **Step 1：写 AI source 测试矩阵**

覆盖：合法 JSON、非法 JSON、未知 emotion、未知 NPC、NPC 使用 forbidden fact、叙事把 failure 写成 success、选项目标非法、选项语义重复、候选事件部分非法、超长字段、timeout/provider failure。

- [x] **Step 2：实现一次调用场景包**

输出一次包含 narration/dialogue/two choice proposals/event proposals/asset requests（资产可为空）。不恢复三角色串行调用。

- [x] **Step 3：实现纯审批后写回**

- 冲突文本或核心结构非法 → 整场 fallback；
- 非核心非法 event proposal → 丢弃 proposal，合法场景可保留；
- ApprovedChoice 由服务器铸 token；
- source 原对象不得直接持久化；
- fallback 同样走审批，防止两套契约漂移。

- [x] **Step 4：运行 application/server AI 测试**

Run：

```text
npm run test:game-application -- src/game/application/approveAndWriteScene.test.ts src/game/application/server/ai/sceneSourceV2.test.ts src/game/application/deterministicSceneSource.test.ts
npm run typecheck
```

- [x] **Step 5：提交**

建议提交：`feat(scene-ai): 生成并审批最小知识场景包`

---

## Task 26：Read model 隐藏事实和 NPC 上下文回归

**Files:**
- Modify: `src/game/application/gameSessionViewV2.ts`
- Test: `src/game/application/gameSessionViewV2.test.ts`
- Modify: `src/components/viewAdapterV2.ts`
- Test: `src/components/viewAdapterV2.test.ts`
- Modify: relevant NPC dialogue component tests

- [x] **Step 1：写未发现事实泄漏测试**

任务目标引用隐藏 FactId 时，view 只能显示中性目标，不出现 fact.text/FactId。NPC hidden/known cards、forbiddenKnowledge 和长期内部摘要不出现在客户端。

- [x] **Step 2：写多 NPC 对话测试**

焦点 NPC 台词和选项对应；其他 NPC 不复用 token；切换 NPC 时只能使用该 NPC 当前可用的自定义输入/选择。

- [x] **Step 3：实现并运行测试**

Run：

```text
npm run test:game-application -- src/game/application/gameSessionViewV2.test.ts
npm run test:components
npm run typecheck
```

- [x] **Step 4：提交**

建议提交：`fix(npc-view): 阻断隐藏事实与跨 NPC 选项泄漏`

---

## R5 阶段验收

- [x] NPC 自定义和固定对话均写入有界结构化记忆；
- [x] 玩家原文不进入长期记忆和日志；
- [x] NPC 只能引用自己的知识；
- [x] 玩家告知/在场目击的知识传播可回放；
- [x] SceneSource 不再接收完整双状态；
- [x] FND-08、FND-10 对应测试通过。

---

# R6：Expansion 生产闭环、Action 闭合与完整分化旅程

覆盖：FND-09、FND-12；最终复核 FND-01 ～ FND-11。

## Task 27：Expansion 纯规则完整性

**Files:**
- Modify: `src/game/gameplay/rpg/expansion/expansionTrigger.ts`
- Test: `src/game/gameplay/rpg/expansion/expansionTrigger.test.ts`
- Modify: `src/game/gameplay/rpg/expansion/approveExpansion.ts`
- Test: `src/game/gameplay/rpg/expansion/approveExpansion.test.ts`
- Modify: `src/game/gameplay/rpg/expansion/applyExpansion.ts`
- Test: `src/game/gameplay/rpg/expansion/applyExpansion.test.ts`
- Modify: `src/game/gameplay/rpg/expansion/expansionTypes.ts`

- [ ] **Step 1：写触发和优先复用测试**

覆盖 entity_not_found、连续低张力、任务角色缺口；已有合适实体时返回 reuse，不创建新实体；climax/resolve、soft max、hard limit 时不扩张并给出收束信号。

- [ ] **Step 2：写批量审批/应用完整性测试**

- 同批多实体 ID 唯一；
- 引用可指向同批新实体且二次整批验证；
- 同回合目标新地点立即 unlocked 且双向连接；
- 新物品挂到地点/NPC/容器并可取得；
- 新 NPC 位置索引一致；
- 新敌人有合法遭遇入口；
- item/enemy/fact 有明确预算；
- 既有定义字段不被任意覆盖；
- 无任意 path patch。

- [ ] **Step 3：实现纯 trigger/reuse/approve/apply**

删除 gameplay 内 source await；ID factory 每次调用产生不同稳定 ID，测试注入确定序列。

- [ ] **Step 4：运行 expansion 测试**

Run：`npm run test:game-gameplay -- src/game/gameplay/rpg/expansion`

- [ ] **Step 5：提交**

建议提交：`fix(expansion): 补齐复用预算引用解锁与实体挂载`

---

## Task 28：live ExpansionSource 和 application 编排

**Files:**
- Create: `src/game/application/server/ai/liveExpansionSourceV2.ts`
- Test: `src/game/application/server/ai/liveExpansionSourceV2.test.ts`
- Create/Modify: `src/game/application/expansionProposer.ts`
- Test: `src/game/application/expansionProposer.test.ts`
- Modify: `src/game/application/server/compositionRootV2.ts`
- Remove production use: `createFixtureExpansionSource()` 直注入

- [ ] **Step 1：写 source 成功/失败测试**

合法 proposal、非法 JSON、未知 kind、超长字段、引用越权、timeout、provider failure、fixture fallback、日志脱敏。

- [ ] **Step 2：实现 factory**

AI 配置有效 → live；无配置 → deterministic fixture。source 只提议，不审批、不铸正式 ID、不写状态。

- [ ] **Step 3：集成 performTurn**

条件触发才调用；审批后最多重演算一次；节奏驱动扩展不改变当前主行动结果；全部进入同一 TurnResolution/pending job。

- [ ] **Step 4：运行 application/server tests**

Run：

```text
npm run test:game-application -- src/game/application/expansionProposer.test.ts src/game/application/performTurn.test.ts src/game/application/server/ai/liveExpansionSourceV2.test.ts
npm run test:boundaries
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`feat(expansion-ai): 条件注入实时世界扩展提议`

---

## Task 29：Action union、validator、resolver、view 全闭合

**Files:**
- Modify: `src/game/domain/action.ts`
- Test: `src/game/domain/action.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/validateAction.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/validateAction.test.ts`
- Modify: `src/game/gameplay/rpg/ruleEngine/resolveByType.ts`
- Test: `src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts`
- Modify: `src/game/application/gameSessionViewV2.ts`
- Modify: relevant UI action adapters/tests

- [ ] **Step 1：建立 Action 支持矩阵测试**

对 production union 的每个 type，静态/数据驱动测试必须证明存在：解析、validation、resolution/event、choice/view。未实现类型从生产 union 或合法候选中移除，不保留永远 INTENT_NOT_ROUTED 的公开类型。

- [ ] **Step 2：统一命名**

明确并统一 attack/start_battle；flee/withdraw 只在 adapter 转换一次；investigate/use_item/give_item/interact/accept_quest/narrative choice 要么闭合实现，要么从 MVP production candidate 集移除并在后续 Spec 恢复。

- [ ] **Step 3：无状态行动也产生主事件**

explore→location_explored，rest→player_rested，freeform→player_intent_expressed。不得 success + 空事件。

- [ ] **Step 4：运行 domain/gameplay/application/components tests**

Run：

```text
npm run test:game-domain -- src/game/domain/action.test.ts src/game/domain/events.test.ts
npm run test:game-gameplay -- src/game/gameplay/rpg/ruleEngine
npm run test:game-application -- src/game/application/gameSessionViewV2.test.ts
npm run test:components
npm run typecheck
```

- [ ] **Step 5：提交**

建议提交：`fix(actions): 闭合 v2.1 行动词汇与领域事件`

---

## Task 30：15 回合完整离线旅程

**Files:**
- Create: `src/game/application/testing/v2FoundationJourney.ts`
- Create: `src/game/application/testing/v2FoundationJourney.test.ts`
- Add fixtures: `data/fixtures/v2-foundation/journey/v1/**`
- Modify: `package.json`
- Add script test if needed: `scripts/v2FoundationJourney.mjs` + test

- [ ] **Step 1：先写失败旅程**

固定旅程至少覆盖：

1. 创建经验证世界；
2. 生成序幕；
3. NPC 固定 ask；
4. NPC 固定 support/challenge 之一；
5. 自定义输入；
6. partial_success 或 failure；
7. 事实传播；
8. 地点解锁与移动；
9. 候选事件提议；
10. 下一回合候选事件激活；
11. 世界扩展或复用；
12. 物品/调查；
13. 战斗；
14. 最终立场选择；
15. 结局。

至少 reload 3 次，并在一个 pending job 中模拟进程重启。

- [ ] **Step 2：断言完整因果和确定 replay**

- 每个成功回合恰好一次规则 CAS；
- 每个 current scene 可追溯到 job/turn；
- token 只消费一次；
- ledger/turnNumber/revision 各自语义正确；
- fixture replay 的规则状态和事件序列完全相同；
- 无网络、无真实费用。

- [ ] **Step 3：新增脚本入口**

建议：

```text
npm run test:v2-foundation-journey
npm run journey:v2-foundation
```

- [ ] **Step 4：运行并提交**

建议提交：`test(journey): 覆盖 v2.1 十五回合完整故事闭环`

---

## Task 31：同 seed 分叉与多结局证明

**Files:**
- Create: `src/game/application/testing/v2StoryDivergenceJourney.test.ts`
- Reuse: v2 foundation journey harness/fixtures

- [ ] **Step 1：写 A/B 分叉失败测试**

相同 seed、相同开局：

- A：相信/支持关键 NPC；
- B：质疑/威胁关键 NPC；
- 后续至少一项合法行动或候选事件不同；
- TurnResolution、NPC memory、facts/threads/quests 中至少一项当前回合即不同；
- SceneGenerationContext 读取到不同结构状态；
- 最终抵达不同结局，或在明确测试版本中抵达显著不同的结构化世界状态。

只比较 narration 字符串不同不得通过。

- [ ] **Step 2：自由输入分叉测试**

同一 NPC 输入两种语义文本，验证规则分类、记忆和下一场 context 分化，同时越权声明不改变事实。

- [ ] **Step 3：重复 replay 稳定性**

每条分支各运行两次，规则事件完全相同；AI fixture 表达允许通过固定 fixture 保持稳定。

- [ ] **Step 4：运行并提交**

Run：`npm run test:game-application -- src/game/application/testing/v2StoryDivergenceJourney.test.ts`

建议提交：`test(story): 证明同 seed 玩家选择产生结构化分化`

---

## Task 32：持久化规模边界与长篇后续门禁

**Files:**
- Modify/Test: `src/game/application/server/persistence/sqliteGameRepositoryV2.test.ts`
- Create/Modify docs: `docs/agent/剧情连续性与结构化记忆.md`
- Optional new follow-up Spec/Plan only if implementing segmented ledger now

- [ ] **Step 1：增加短篇规模测试**

至少模拟 50–100 回合，验证 JSON record 读写、materialized cursor、CAS 和 reload 正确；记录测试耗时/大小基线但不写不稳定墙钟断言。

- [ ] **Step 2：明确长篇门禁**

若本轮不实施独立 append-only event table，则在 agent 文档明确：当前 v2.1 正式支持短篇/中篇上限；启用 long/open 正式承诺前必须另立 segmented ledger Plan。UI/产品配置不得声称无限长期记忆。

- [ ] **Step 3：如决定本轮实现独立 ledger**

先停下并新建专门 Spec/Plan，覆盖事务原子性、snapshot/cursor、归档、回放和迁移；不得在本 Task 中顺手重写 repository。

- [ ] **Step 4：提交**

建议提交：`test(persistence): 固化 v2.1 存档规模与长篇门禁`

---

## Task 33：文档、索引和当前阶段收口

**Files:**
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `docs/agent/current-phase.json`
- Modify: `docs/Agent文档索引.md`
- Modify: relevant `docs/agent/*.md`
- Modify: `docs/游戏开发规范.md` if implementation boundaries changed
- Modify: `docs/策划文档/` only where player-visible rules changed

- [ ] **Step 1：更新实现事实**

至少更新：MVP 核心闭环、行动裁决、NPC 对话、运行时 AI 导演/场景、剧情连续性、蓝图动态化（重命名/标注 v1）、战斗与结局、AI 环境。

- [ ] **Step 2：更新索引优先级**

明确 v2.1 为当前生产链；v1 只作为历史参考。记录唯一执行 Plan、本次 Spec、分支/worktree、验收命令和旧存档策略。

- [ ] **Step 3：运行文档/标准检查**

Run：

```text
npm run check:standards
npm run test:handoff-check
npm run phase:status
```

- [ ] **Step 4：提交**

建议提交：`docs: 记录 v2.1 架构底座实现事实与当前阶段`

---

## R6 阶段验收

- [ ] live/fixture ExpansionSource 走相同审批链；
- [ ] Action union 全部闭合或明确移出 MVP；
- [ ] 15 回合旅程、reload、pending 重启和结局通过；
- [ ] 同 seed 分支产生结构化差异与不同结局；
- [ ] 长篇存储能力边界被明确；
- [ ] FND-09、FND-12 通过，FND-01～FND-11 无回归。

---

# 最终验收与收口

## 最终验收顺序

### 分层测试

- [ ] Run：`npm run test:game-domain`
- [ ] Run：`npm run test:game-gameplay`
- [ ] Run：`npm run test:game-application`
- [ ] Run：`npm run test:app`
- [ ] Run：`npm run test:components`
- [ ] Run：`npm run test:game-logging`

### 静态与架构门禁

- [ ] Run：`npm run check:standards`
- [ ] Run：`npm run typecheck`
- [ ] Run：`npm run lint`
- [ ] Run：`npm run test:boundaries`
- [ ] Run：`npm run test:fast`

### 完整回归

- [ ] Run：`npm test`
- [ ] Run：`npm run test:v2-foundation-journey`
- [ ] Run：`npm run journey:v2-foundation`
- [ ] Run：`npm run build`
- [ ] Run：`npm run phase:status`

### 真实 AI smoke（显式 opt-in）

真实 smoke 不作为日常离线验收的替代。若执行，必须：

- 使用明确环境门禁；
- 记录调用数量、结果分类和 fallback 数量；
- 不记录 prompt、原始 provider 输出、玩家原文、API key 或完整存档；
- 成功后立即用脱敏 fixture replay；
- 未执行时明确写“未执行”，不能把 fixture 通过写成真实 AI 成功。

---

## FND 覆盖矩阵

| 需求 | 主要 Tasks | 最终证明 |
|---|---|---|
| FND-01 回合因果 | 1–6 | 真实 job、单次 CAS、重启恢复 |
| FND-02 统一输入 | 9–10 | fixed/free 均进入 performTurn |
| FND-03 对话语义 | 7、22 | support/challenge 等结构化分化 |
| FND-04 opaque choice | 8、11、25 | 客户端零 actionKey、token 防篡改 |
| FND-05 可执行事件 | 18–21 | candidate → GameEvent → next state |
| FND-06 可达开局 | 12–15、17 | 图 validator + 多结局 fixture |
| FND-07 故事顺序 | 15–16、19–20 | 同回合任务/幕/结局收敛 |
| FND-08 NPC 最小权限 | 22–26 | 记忆、知识传播、context 零泄漏 |
| FND-09 Expansion | 6、27–28 | live/fixture、复用、审批、重演算 |
| FND-10 完整审批 | 8、10、12–13、17、24–25 | HTTP/AI/schema/invariant 测试 |
| FND-11 并发确定性 | 1–6、30 | 单次 CAS、pending 恢复、fallback replay |
| FND-12 结构化分化 | 30–31 | 同 seed 分叉与多结局 |

---

## 关键停止条件

执行 Agent 遇到以下情况必须停止当前 Task，保留已有安全改动并报告，不得用兼容 hack 绕过：

1. 无法在一次 CAS 中同时保存规则状态和 PendingNarrativeJob；
2. 为兼容旧 v2 存档必须伪造原 Action/ResolvedEvent；
3. SceneSource 必须接收完整 World State 才能通过现有 prompt；
4. AI 选项无法被绑定到规则可识别的 ApprovedAction；
5. 开局 validator 证明当前 candidate 无任何多结局可达路径；
6. Expansion 批量 proposal 无法保证 ID/引用唯一；
7. candidate event 只能通过任意 path patch 执行；
8. NPC 知识测试发现 source 能看到其它 NPC 私密正文；
9. worktree `.foundation` junction 或 sibling foundation 完整性异常；
10. 需要修改共享 package 才能继续——此时必须按共享模块流程重新定界，不得直接改 foundation。

---

## Self-Review

### Spec coverage

- [x] 回合因果与 pending job：Tasks 1–6
- [x] 固定/自由统一输入：Tasks 7–11
- [x] 完整世界和多结局可达性：Tasks 12–17
- [x] AI 候选事件执行闭环：Tasks 18–21
- [x] NPC 记忆、知识和最小 context：Tasks 22–26
- [x] Expansion、Action 闭合、完整旅程：Tasks 27–33
- [x] FND-01～FND-12 全部映射到任务和最终证明

### Boundary review

- [x] AI source 调用只在 application/server adapter + application 编排
- [x] gameplay 只保留纯规则
- [x] SceneWriteBack 不写世界事实
- [x] UI/API 不解析 actionKey，不 deep-import gameplay
- [x] 无 foundation 修改

### Placeholder scan

- [x] 无 TBD/待定实现占位；长篇 ledger 被明确划为独立触发 Plan，而非模糊顺手实现
- [x] 每个 Task 都有文件范围、失败测试、实现要求、验收命令和提交检查点
- [x] 所有最终验收均可在无网络环境执行；真实 AI smoke 单独门禁

### Completion rule

只有 R1～R6、最终验收和文档收口全部完成，才能把当前阶段标记为 completed。任何单个 R 阶段完成都只能记录为 in_progress，不得宣称 v2 架构底座已完成。
