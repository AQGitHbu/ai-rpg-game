# 分阶段剧情生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现剧情规划、独立旁白、单 NPC 表现、纯对白选项四类生成职责，按权限与依赖生成一个原子发布、可恢复、有实质分支的叙事包。

**Architecture:** domain 定义类型化骨架、分支、表达单元与依赖；gameplay 审批规则变化并派生认知投影；application 审批表达、调度和装配。独立生成任务与游戏记录存在同一 SQLite 数据库，通过任务版本、lease fencing 与游戏 CAS 原子发布。统一生产入口原位替换，旧 source 仅在切换前继续服务，最终不能成为备用生产路径。

**Tech Stack:** TypeScript、Next.js、React、Vitest、SQLite/@libsql/client、现有 @ai-game/ai-transport、现有 AI 审计与 retry helper；不新增依赖或修改 foundation。

## Global Constraints

- 唯一需求依据：[Spec](../specs/2026-09-09-staged-narrative-generation-design.md)。本文只规划；checkbox 不代表实现已完成。当前阶段指针不改动。
- “旁白与角色表现固定分开请求，不设置‘上下文安全时合并’的例外，也不与规划器合并。”
- “步骤图无环、引用唯一且闭合，沿用最多 12 个连续步骤的上限。”
- “每个逻辑生成单元在一次尝试周期内最多四次完整内容尝试；输入版本改变不重置其累计次数。”
- “所有玩家对白选择只显示玩家准备说出的原话”。两个普通候选必须有规则可执行的分支差异；仅语气、同义改写或无后续意义的 trust 微差不通过。
- 保留 initialization、narrative_choice、npc_free_text 三类业务触发。移动、取物、赠物、战斗消费获批步骤，不额外启动 AI。自由输入维持中性 talk/ask，不增加 intent provider。
- 无未来知识提前提交，无剧情代替玩家执行物理行动，无失败文本兜底。全部必要单元通过才发布；此前已提交的规则回合不因生成失败回滚。
- application 调 gameplay 只走子系统 index；provider 和环境只在 server/ai；SQLite client 只由 sqliteClient.ts 导入；客户端只经 application facade 获取安全 view。
- 阅读 [开发规范](../../游戏开发规范.md)、相关 agent 文档；公共包只消费公开 API。不得修改 docs/共同规范、.foundation 或 sibling 仓库。
- 执行时先确认工作区改动；需要隔离时 worktree 放 .worktrees。每 Task 只暂存自己文件，完成定向测试、typecheck、test:boundaries 后提交。不得自动合并、推送或清理用户存档。
- 当前基线已包含 openingNarrativePrompt.ts、openingHandoffContext.ts、opening.situation、resolveOpeningResponses 与 aiGenerationRetry.ts；不得按旧 support/challenge 硬编码基线重做这些功能。

---

## 依赖、范围与文件职责

本变更各部分共享发布事务与权限契约，作为一个 Plan 执行，按独立可验收的任务切分。Task 1 → 2 → 3 → 4 → 5 → 6；Task 7 依赖 1、2，可在 3–6 完成后执行；8 依赖 5–7；9 依赖 2–8；10–12 顺序执行。Task 10 是唯一生产切换点；此前新增模块有独立测试但不对用户启用。禁止中间提交部署半条生成链。

| 文件/目录 | 本次职责 |
| --- | --- |
| `src/game/domain/narrativePlan.ts`、`narrativeUnit.ts`、`narrativeBranch.ts`、`narrativeObservation.ts` | 新纯类型与严格解析；不含 IO、AI 或规则审批 |
| `src/game/gameplay/rpg/narrativePlanning/` | 新 facade：骨架规则审批、预览、分支应用、步骤条件、认知时序 |
| `src/game/application/narrativeGeneration/` | 视角投影、表达审批、单元 source port、调度与整包装配 |
| `src/game/application/server/ai/staged/` | 四类 prompt 与 live source；只消费安全 DTO |
| `src/game/application/server/persistence/narrativeJobRepository.ts` | 独立任务端口；当前游戏仓储的同数据库事务扩展 |
| `src/game/application/server/persistence/sqliteNarrativeJobs.ts` | SQL 操作 helper，使用注入的现有 client/transaction 类型 |
| `src/game/application/createGame.ts`、`generatePendingNarrativeBundle.ts`、`performTurn.ts` | 唯一生产用例原位接入 |
| `src/game/application/server/compositionRoot.ts` | source、仓储、时钟、取消和后台协调器装配 |
| `src/app/api/game/route.ts`、`src/app/api/game/initialization/route.ts` | 创建/初始化任务状态及重试；不生成 prompt |
| `src/components/CurrentGameScreen.tsx`、`NewGameSetupForm.tsx`、`gameActionRequest.ts` | 无存档初始化恢复、对白选项和展示顺序 |
| `src/game/application/testing/stagedNarrativeJourney.test.ts` | 真用例链离线验收，注入 scripted source |
| `scripts/stagedNarrativeSmoke.mjs` | 显式门禁的真实 AI 有界验收 |

所有新源码文件有同目录 `.test.ts`；测试专用 fixture 用 `.testutil.ts`，不从生产导入。下面片段规定跨任务 API 和关键断言，fixture 的完整真实状态由 Task 1 的 domain fixture 与 Task 8 的 application harness 提供；不能用 `as never` 或绕过审批拼接“成功”结果。

## 固定实施决策

1. 默认只有四类生成，不引入第五个在线审核模型。在线执行严格结构、引用、受众、候选映射、已知泄漏与格式检查；复杂语义泄漏/意图保真由真实文本验收作为上线门槛，不宣称已实现通用语义证明。确定性规则发现冲突或无法建立引用依据时拒绝。不能声称四请求包含隐形语义评审。
2. 初始配置：最多 40 个基础单元（含规划，12 连续步骤外加当前 scene；最多 1 个普通决策表达单元），额外内容请求额度 12，每单元每周期最多 4 次；单任务并行 2、进程全局 provider 并行 4；内容请求总数最多 baseline+12 且不超过 52。规划改版后的首次新增单元也占额外额度。预算不得通过改名重置。
3. 周期总时限 600 秒，单次 provider 45 秒、最多 2 次传输尝试；按剩余时间缩短 timeout，不能开始超时后重试。输入预算规划 8000、旁白 2500、角色 4000、选项 2500 estimated tokens；输出上限分别 6000、1000、1600、600；thinking 默认 off。这些为初始性能约束，不保证最大规模包在慢 provider 下必然成功。基础 DAG 按每调用至少 1000ms 调度保留量做可容纳性检查，真实延迟另测。
4. 新持久化版本计划为 WorldState 7、StoryState 9、EntityStore 2、bundle contract 2、job schema 1；实施开始若版本已被其他工作占用，使用下一版本并同步全部测试，不覆盖现有版本含义。旧游戏显式 UNSUPPORTED_RECORD，不自动迁移/清档；现有初始化历史和关系 provenance 原样保留。
5. 有限分支能力采用“选择一个已批准的后续目标”而非任意效果 DSL。两条分支各有受支持的目标、公开意图、结构化来源与规则条件；本次选择可以切换当前 quest 的后续目标，但不能替玩家完成移动、取物、给予或击败。只有关系变化而没有可用目标差异的提案拒绝。

### Task 1: 建立骨架、单元、分支和观察契约

**Files:**
- Create: `src/game/domain/narrativePlan.ts`, `src/game/domain/narrativeUnit.ts`, `src/game/domain/narrativeBranch.ts`, `src/game/domain/narrativeObservation.ts` 及各自 `.test.ts`
- Create: `src/game/domain/testing/stagedNarrativeFixture.testutil.ts`
- Create: `src/game/domain/worldDeltaProposal.ts`, `src/game/domain/worldDeltaProposal.test.ts`
- Modify: `src/game/application/server/ai/liveWorldEvolutionSource.ts`, `src/game/application/server/ai/worldEvolutionSource.test.ts`

**Interfaces:** 复用 domain 的 `Action`、`DialogueAct`、`StructuredDialogueTopic`、`WorldDeltaProposal`、`NarrativeBundleTrigger`、`NarrativeBundleTerminal`、`OpeningGenerationCandidate`、`NarrativeEmotion` 和品牌 ID。新增：

```ts
type Check<T> = { ok: true; value: T } | { ok: false; code: string };
type Stage = "planning" | "narration" | "character" | "choices";
type ScenePoint = { stepKey: string; order: number };
type FactUse = { factId: string; certainty: "known" | "suspected" };
type EvidenceRef = { kind: "committed"; eventId: string }
  | { kind: "conditional"; observationKey: string };
type SafeBeat = { beatId: string; kind: MandatoryNarrativeBeat["kind"];
  factIds: readonly string[]; evidence: readonly EvidenceRef[]; instruction: string };
type TextPart = { text: string; facts: readonly FactUse[];
  evidence: readonly EvidenceRef[]; beatIds: readonly string[] };
type Observation = {
  key: string; point: ScenePoint; audienceIds: readonly string[];
  fact: FactUse; source: { kind: "witness" } | { kind: "speech"; speakerId: string };
};
type CosmeticAction = {
  key: string; actorId: string; point: ScenePoint;
  kind: "pause" | "look" | "gesture"; objectId: string | null;
  audienceIds: readonly string[];
};
type RouteTarget =
  | { kind: "talk_to_npc"; npcId: string }
  | { kind: "visit_location"; locationId: string }
  | { kind: "obtain_item"; itemId: string }
  | { kind: "discover_fact"; factId: string }
  | { kind: "defeat_enemy"; enemyId: string };
type BranchOption = {
  candidateId: string; dialogueAct: DialogueAct; topic: StructuredDialogueTopic;
  target: RouteTarget; publicIntent: TextPart;
  deferredLocation: WorldDeltaProposal["newLocation"];
};
type Decision = { kind: "ordinary"; point: ScenePoint; npcId: string;
  options: readonly [BranchOption, BranchOption] };
type EndingExpression = { kind: "ending"; point: ScenePoint; npcId: string;
  options: readonly [{ candidateId: "trust"; dialogueAct: "support"; publicIntent: TextPart },
    { candidateId: "doubt"; dialogueAct: "challenge"; publicIntent: TextPart }] };
type ChoiceExpression = Decision | EndingExpression;
type Unit = {
  key: string; stage: Exclude<Stage, "planning">; point: ScenePoint;
  speakerId: string | null; dependencies: readonly string[];
  taskFactIds: readonly string[]; requiredObservationKeys: readonly string[];
  requiredBeats: readonly SafeBeat[];
};
type PlanProposal = {
  opening: OpeningGenerationCandidate | null; worldDelta: WorldDeltaProposal | null;
  steps: readonly { key: string; trigger: NarrativeBundleTrigger; next: readonly string[] }[];
  units: readonly Unit[]; observations: readonly Observation[];
  actions: readonly CosmeticAction[]; decision: Decision | null;
  terminal: NarrativeBundleTerminal;
};
type UnitOutput =
  | { stage: "narration"; parts: readonly TextPart[]; actionKeys: readonly string[] }
  | { stage: "character"; speakerId: string; parts: readonly TextPart[];
      emotion: NarrativeEmotion; actions: readonly CosmeticAction[];
      answeredBeatIds: readonly string[] }
  | { stage: "choices"; labels: readonly { candidateId: string; label: string }[] };
```

`Check`、`Stage`、`ScenePoint`、`SafeBeat`、`TextPart`、`Unit`、`UnitOutput` 从 narrativeUnit 导出；EvidenceRef/Observation/CosmeticAction 从 narrativeObservation 导出；ChoiceExpression/Decision/EndingExpression/BranchOption/RouteTarget 从 narrativeBranch 导出；PlanProposal 从 narrativePlan 导出。复用 domain/narrativeBeat 的 MandatoryNarrativeBeat。解析器分别为 `parsePlanProposal(raw: unknown): Check<PlanProposal>`、`parseUnitOutput(raw: unknown): Check<UnitOutput>`、`parseBranchOption(raw: unknown): Check<BranchOption>`、`parseObservation(raw: unknown): Check<Observation>`。

终幕候选完全由规则派生，不能由 PlanProposal.decision 输入；审批生成 ApprovedPlan.choiceExpression。普通 decision 与 ending expression 是互斥联合，最多一个 choices 单元。requiredBeats 同样由服务端从 PendingNarrativeJob.mandatoryBeats 与步骤 descriptor 投影、覆盖 AI 提案同字段，并核对规划不得删漏必需任务；修复不能改变源 beatId。

worldDelta 的当前 parser 在 server/ai/liveWorldEvolutionSource.ts，domain 禁止反向导入。Task 1 同时将 `parseWorldDeltaProposal` 及它的纯解析依赖移动到新 `src/game/domain/worldDeltaProposal.ts`，旧文件 import/re-export 同一实现，更新其测试 import；规则过滤仍留 gameplay，不将 parser 复制一份。opening 使用已有 domain parser。`opening` 用于结构素材，后续阶段分离序幕等最终展示文本，见 Task 5。

- [x] **Step 1:** 编写 exact-key、缺字段、循环、超限和空句段测试；最低示例：

```ts
expect(parsePlanProposal({ opening: null, worldDelta: null, steps: [], units: [],
  observations: [], actions: [], decision: null, terminal: { kind: "ending" },
  hiddenPrompt: "leak" }).ok).toBe(false);
expect(parseUnitOutput({ stage: "choices", labels: [
  { candidateId: "a", label: "我愿意帮你。" },
  { candidateId: "a", label: "我不答应。" },
] }).ok).toBe(false);
```

- [x] **Step 2:** `npx vitest run src/game/domain/narrativePlan.test.ts src/game/domain/narrativeUnit.test.ts src/game/domain/narrativeBranch.test.ts src/game/domain/narrativeObservation.test.ts`；预期缺少模块/导出，或新非法输入尚未拒绝而失败。
- [x] **Step 3:** 实现逐字段重建；key 上限 128，句段 text 1–500 字、每输出最多 12 段，label 1–80 字；拒绝重复 ID、未知 enum。fixture 导出 `makeStagedPlan(): PlanProposal`：两个在场 NPC、两个可达地点、二选一分别指向不同地点；不含正式文本。定义 `makeCharacterOutput(): UnitOutput` 与 `makeChoiceOutput(): UnitOutput` 提供有效和可局部替换的生成结果。
- [x] **Step 4:** 上述测试通过，运行 `npm run typecheck`、`npm run test:boundaries`。
- [x] **Step 5:** 只 stage 本 Task 文件，提交 `feat: define staged narrative contracts`。

### Task 2: 有界路线分支、token 与真实规则后果

**Files:**
- Create: `src/game/gameplay/rpg/narrativePlanning/index.ts`, `branches.ts`, `branches.test.ts`
- Modify: `src/game/domain/approvedChoice.ts`, `src/game/domain/storyState.ts`, `src/game/domain/events.ts`, `src/game/domain/eventPayloadValidation.ts`
- Modify: `src/game/domain/narrative.ts`, `src/game/application/server/persistence/storyStatePersistenceValidation.ts`（分支目标会话作用域及严格恢复）
- Modify: `src/game/application/performTurn.ts`, `src/game/application/buildChoiceMap.ts`, `src/game/gameplay/rpg/ruleEngine/index.ts`, `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts`
- Modify: `src/game/gameplay/rpg/narrativeMemory/renderNarrativeMemory.ts`, `src/dependencyBoundaries.test.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/entityMutation.ts` 及测试、`src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts` 及测试
- Test: 上述同名测试；新增 `src/game/application/testing/stagedBranchJourney.test.ts`

**Interfaces:**
- Consumes Task 1 `BranchOption`, `Decision`, `RouteTarget`。
- Produces `approveDecision(input: { decision: Decision; world: WorldState; story: StoryState }): Check<Decision>`。
- Produces `applyNarrativeBranch(input: { world: WorldState; story: StoryState; decision: Decision; candidateId: string }): Check<{ world: WorldState; story: StoryState; drafts: readonly NarrativeEventDraft[] }>`，只从 gameplay facade 导出。
- `ApprovedChoice`/构造输入增加 `branch?: { decisionId: string; candidateId: string }`；`StoryState` 增加 `branchDecisions`（批准 decisionId → Decision）和 `selectedBranches`（decisionId → candidateId）。其严格持久化接入 Task 7；此 Task 使用显式 fixture。

- [x] **Step 1:** 用同一真实状态的两个副本执行真实 choice token，断言：

```ts
expect(left.record.storyState.selectedBranches[decisionId]).not.toBe(
  right.record.storyState.selectedBranches[decisionId]);
expect(left.view.quests).not.toEqual(right.view.quests);
expect(left.record.worldState.currentLocationId).toBe(before.worldState.currentLocationId);
expect(right.record.worldState.currentLocationId).toBe(before.worldState.currentLocationId);
```

`left/right/before/decisionId` 在测试内由新 fixture 真实创建与 `performTurn` 调用得到；`quests` 是现有 GameSessionView 的正式字段，另检查 `currentLocation.currentObjectiveLabel` 随路线正确变化。
- [x] **Step 2:** `npx vitest run src/game/gameplay/rpg/narrativePlanning/branches.test.ts src/game/application/testing/stagedBranchJourney.test.ts`；预期新分支状态缺失/目标相同导致失败。
- [x] **Step 3:** 按规则可达性审批两条 target；拒绝同 target、无前提依据、未有获批延迟定义的不存在实体、已完成目标、无可继续主线。选择只替换当前主线的下一个未执行目标，保留既有已完成前缀及共同可完成后缀；生成 `narrative_branch_selected` 事件（decisionId、candidateId、target 的结构化 refs）。在 resolveTurn 的单次事件提交前纳入变化，不额外 commit，不把对话直接变成 move。`performTurn` 从 registry 获得 branch，不接受客户端提交。下一次规划强制携带所选 target，不允许改写路线来制造假分支。
- [x] **Step 4:** token hash 与 semanticSummary 纳入 branch 两个 ID；重铸、复制 registry 和同 act/topic 的两条候选均保留 branch；不修改通用 Action union 暴露任意分支。回归旧 token、重复选择、CAS 失败零写入。narrativePlanning 加入 facade 清单。运行步骤 2、`npx vitest run src/game/domain/approvedChoice.test.ts src/game/application/performTurn.test.ts src/game/application/buildChoiceMap.test.ts` 与全局最低门禁。
- [x] **Step 5:** 逐文件 stage，提交 `feat: apply approved narrative route choices`。

开局分支采用有界的“延迟地点定义”，不假设初始已有两个 NPC/地点。`deferredLocation` 默认 null；非 null 时只允许 visit_location，target.locationId 必须等于服务端分配给该定义的稳定 ID。复用 newLocation 的严格结构与连通性校验，但提取无 evolutionNeed 前提的纯结构审批 helper，不能伪造普通 world evolution 触发或绕过其 gate。两条定义分别在独立 sandbox 通过现有地点材质化和目标可达性检查；允许共用一个剩余地点额度（至多选择一条），不得合并计算为已生成两个地点。两条路线须在公开目的和后续可执行目标上不同，不接受只换地点名。未选择时定义仅保存在服务端 decision registry，不加入 EntityStore/地图/知识；真实开局仍一个 NPC、一个地点。选择时在同一次规则事务中仅材质化所选地点并设置访问目标，玩家位置不变；这属于获批分支效果，不发 provider 请求、不递增幕数。目标完成后沿用共同后缀/正常演化。预算不够或后缀无法完成则拒绝该候选，不能临时多造实体。新地点公开名称和选择理由必须有当前 NPC 可披露、玩家经本场表达可知的依据；隐藏地点细节不进入 options DTO。

为此新增有界 `EntityMutation` 臂 `replace_quest_objective`（questId、objectiveIndex、expectedOld: QuestObjective、replacement: QuestObjective）；处理器验证索引是当前未完成目标、旧值精确匹配、新引用存在且获批，保留其他目标与状态。目标更新、所选地点材质化、branch 事件与规则回合一起 CAS。测试必须从真实 opening compiler 的单 NPC/单地点状态执行左右 token，检查只出现各自所选地点、当前目标/地图不同、未选地点不存在、玩家未移动；双 NPC fixture 仅用于多人权限测试，不能替代开局验收。增加 EntityMutation 序列化、恢复、任务投影和重复选择零写入测试。

延迟地点仅支持 `placement:"world"`、`scale:"scene"`，不把 town_building 当 LocationEntry。provider 的延迟 target.locationId 固定为局部符号 `"$deferred"`；approveDecision 逐候选重建为保留的不同品牌 ID 后才比较 target。原始符号不能进入 registry/token/事件。包发布时在同一 CAS 中推进 nextLocationOrdinal 保留两个序号（允许未选分支留下序号空洞），实体预算仍只预留一个；取消/失败未发布包不占权威序号。延迟材质化消费已保留 ID，不再次自增铸造。世界状态改变导致额度/连接前提失效时按 stale 分支拒绝，不挤占后续实体或复用其他 ID。地点结构 helper 的提取与有界材质化 helper 都归 worldEvolution facade，并在其 index.ts 导出、添加单元测试；branches 不跨子系统导入私有文件。

规则顺序固定为：验证 choice/分支与回合前置条件 → 计算正常对白效果 → 应用获批分支目标变化 → reconcileQuests → 统一事件提交。不能先把原 talk_to_npc 任务结算完成/advance_story 后再改目标。对白事实、关系及会话事件仍保留；只有该获批 branch 替换当前目标，普通未带 branch 的 talk 行为不变。新增测试覆盖原 talk 本回合恰好完成时，分支访问目标仍待玩家执行且任务不提前结算。

开局延迟路线必须闭合至下一 NPC 决策，不能仅创建空地点便终止：有限规则模板为 `visit_location(所选新地点) → talk_to_npc(原 NPC)`，新地点与原地点双向连接，原 NPC 留在原处；步骤图包括当前回应、外出抵达观察、返回原地点、原 NPC 的新会话与下一决策。两路线在各自地点用途/公开调查目的、访问目标和永久地图解锁上不同；不要求无限分叉，但不能只换文案。没有共同后缀的初始单 talk 任务使用上述两目标序列替代；已有后缀时在该序列后保留。对应 mutation 的 replacement 改为非空 `readonly QuestObjective[]`，只替换一个 expectedOld 槽位，数组长度最多2，不提供任意任务重写；审批仅允许上述延迟模板或单个既有目标。新会话以 questId+目标索引+decisionId 区分，旧 talk 的 completed/usedAction 不得使返程 talk 自动完成；修改 dialogueSession 的严格类型/恢复与 reconcileQuests 对该目标作用域的读取（StoryState9承载），旧普通会话维持原语义。descriptors/coverage 增加这种出发—抵达—返回—会话的有限模板，并检查总步骤≤12；沿路 move 仅消费已批准片段、零 provider。Task 3/9/12 必须实际跑真实单NPC开局的两个分支，分别验证选择后包生成成功→外出移动→返程移动→新 NPC 决策可用，未在选择或抵达时提前结算 quest。NPC 不再原地、返程断开等前提失效按既有显式 stale/重试策略处理，不瞬移 NPC 或新增隐藏生成触发。

### Task 3: 骨架规则审批、条件快照与表达 DAG

**Files:**
- Create: `src/game/gameplay/rpg/narrativePlanning/approvePlan.ts`, `sceneSnapshot.ts`, `unitGraph.ts` 及测试
- Modify: `src/game/gameplay/rpg/narrativePlanning/index.ts`, `src/game/gameplay/rpg/narrativeBundle/descriptors.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`, `src/game/gameplay/rpg/openingGeneration/index.ts` 及测试
- Test: `src/game/gameplay/rpg/narrativeBundle/descriptors.test.ts`

**Interfaces:**
- `ApprovedPlan = { proposal: PlanProposal; world: WorldState; story: StoryState; units: readonly Unit[]; choiceExpression: ChoiceExpression | null; stepDependencies: Readonly<Record<string, readonly StepDependency[]>> }`，仅 approvePlan 返回；preview 不是权威状态。
- `PlanApprovalInput = { kind: "opening"; proposal: PlanProposal; generation: GenerationMetadata; gameLength: GameLength; seed: string } | { kind: "decision"; proposal: PlanProposal; world: WorldState; story: StoryState }`；`approvePlan(input: PlanApprovalInput): Check<ApprovedPlan>`。
- `sceneSnapshot(input: { plan: ApprovedPlan; point: ScenePoint }): Check<{ world: WorldState; story: StoryState; observations: readonly Observation[] }>`。
- `readyUnits(units: readonly Unit[], approvedKeys: ReadonlySet<string>): readonly Unit[]`。
- `checkStepDependencies(input: { world: WorldState; story: StoryState; phase: "before" | "after"; expected: readonly StepDependency[] }): Check<true>`。

`StepDependency` 在 domain/narrativePlan 定义，纯数据、无任意字段路径：

```ts
type StepDependency = { phase: "before" | "after"; predicate:
  | { kind: "player_location"; locationId: string }
  | { kind: "npc_location"; npcId: string; locationId: string }
  | { kind: "item_holder"; itemId: string; holderId: string }
  | { kind: "entity_lifecycle"; entityId: string; lifecycle: "active" | "inactive" | "resolved" }
  | { kind: "branch_selected"; decisionId: string; candidateId: string }
  | { kind: "observation"; observationKey: string; audienceId: string }
  | { kind: "battle_victory"; enemyId: string }
};
```

审批把存在性、lifecycle 枚举与 EntityStore 实际契约对齐。before 检查在 resolveTurn 前，after 检查在纯规则结果上、同次 CAS 前；任何失败都不提交规则变化。

- [x] **Step 1:** 测试图排序与同点未来观察不可见：

```ts
const units: Unit[] = [
  { key: "npc", stage: "character", point: { stepKey: "current", order: 1 },
    speakerId: "npc_0", dependencies: [], taskFactIds: [], requiredObservationKeys: [], requiredBeats: [] },
  { key: "labels", stage: "choices", point: { stepKey: "current", order: 2 },
    speakerId: null, dependencies: ["npc"], taskFactIds: [], requiredObservationKeys: [], requiredBeats: [] },
];
expect(readyUnits(units, new Set()).map(x => x.key)).toEqual(["npc"]);
expect(readyUnits(units, new Set(["npc"])).map(x => x.key)).toEqual(["labels"]);
```

- [x] **Step 2:** `npx vitest run src/game/gameplay/rpg/narrativePlanning`；预期新增接口缺失失败。
- [x] **Step 3:** 复用 worldEvolution 的 approveWorldDelta/materializeWorldDelta，以及现有 openingGeneration compiler 形成 preview；用服务端 descriptors 限制动作图，不以 AI stepKey 决定合法 Action。强制当前片段至下一 NPC 决策止，1 个决策单元、每包 39 个表达单元上限。拒绝缺依赖、跨未选分支、循环、需回应的文本尚未批准、无观察来源的知识传播。并行只在依赖闭包互不依赖时成立。
- [x] **Step 4:** 为未来 move、胜利后 NPC 和赠物预览逐步骤执行纯规则投影；不向真实 repository 写入。步骤依赖记录实体/位置/持有/已选分支/知识来源，不能仅记录全局 revision；战斗随机细节不在快照可保证内容中。运行上述测试与最低门禁。
- [x] **Step 5:** 提交 `feat: approve staged plans and scene dependencies`。

开局不能给 approvePlan 填造假的现成 world/story。拆出 `compileOpeningStructure`，接收 candidate、generation、gameLength、seed，返回已审批的结构 world/story 与稳定实体 ID；不依赖 initialNarrative，不发布 planner.prologue。原 compileOpeningGenerationCandidate 改为该纯结构编译器加叙事安装的兼容包装，Task 10 切换前旧入口仍通过测试。结构 preview 的 narrative 使用正式 pending 状态，而非伪造 ready 台词。ApprovedPlan 保存这一结构结果；最终仅安装获批 narration/character/choices 和 observations，不能再次运行结构编译或分配 ID。generation/seed/gameLength 全部来自 durable initialization 输入与 envelope。测试从 opening 输入无 GameRecord 完成 approve→表达→publish，断言所有实体 ID、结构与 preview 一致，且 planner 序幕没有进入视图。

### Task 4: 单角色、玩家感知和安全选项上下文

**Files:**
- Create: `src/game/application/narrativeGeneration/perspectiveContext.ts`, `perspectiveContext.test.ts`
- Create: `src/game/gameplay/rpg/narrativePlanning/observations.ts`, `observations.test.ts`
- Modify: `src/game/application/npcSpeechAuthority.ts`, `src/game/gameplay/rpg/narrativePlanning/index.ts`
- Modify: `src/game/gameplay/rpg/npcMemory/index.ts`, `src/game/gameplay/rpg/ruleEngine/propagateKnownFacts.ts`

**Interfaces:**
- `SafeContext = { unit: Unit; visibleFacts: readonly { id: string; text: string; certainty: "known" | "suspected"; sources: readonly EvidenceRef[] }[]; priorText: readonly TextPart[]; allowedActions: readonly CosmeticAction[]; options: readonly { candidateId: string; dialogueAct: DialogueAct; publicIntent: TextPart }[]; playerUtterance: string | null; style: string; requiredBeats: readonly SafeBeat[]; choiceKind: "ordinary" | "ending" | null }`。
- `projectUnitContext(input: { plan: ApprovedPlan; unit: Unit; approved: ReadonlyMap<string, UnitOutput> }): Check<SafeContext>`；SafeContext 内的 Unit 必须重建，只保留授权后的 taskFactIds/观察引用，不能泄露隐藏 key。
- `collectDisclosures(input: { plan: ApprovedPlan; unit: Unit; output: UnitOutput }): Check<readonly Observation[]>`；纯规则匹配，不进行文本挖掘创建 fact。

SafeContext 还必须有 `persona: SafePersona | null`，其中 `SafePersona = { publicName: string; publicRole: TextPart; anchors: readonly TextPart[]; goals: readonly TextPart[]; emotion: NarrativeEmotion; relationshipTier: string; behavior: readonly ("answer_directly" | "withhold_source" | "express_uncertainty")[] }`；narration/choices 的 persona 为 null。anchors/goals 只取有公开依据且对受众可说的内容，敏感动机转受控 behavior 由规则批准，不返回秘密正文。“过滤原始自由字段”不能被实施成丢掉全部人格与当前情绪。SafePersona 与 SafeContext 同模块导出。

- [x] **Step 1:** 隐藏事实用唯一 sentinel，断言实际整个 DTO 不含：

```ts
expect(JSON.stringify(npcContext)).not.toContain("SECRET_TRACKING_SEAL");
expect(JSON.stringify(narratorContext)).not.toContain("SECRET_TRACKING_SEAL");
expect(JSON.stringify(choiceContext)).not.toContain("SECRET_TRACKING_SEAL");
expect(npcContext.priorText).toEqual([]); // 未在场，不可获知玩家私聊
```

context 由 makeStagedPlan 派生 preview、审批相应输出后获得，不能手写 safe DTO 跳过投影。覆盖秘密嵌入目标 description/reason、人格 taboos、旧记忆标题、任务名与修复信息。
- [x] **Step 2:** `npx vitest run src/game/application/narrativeGeneration/perspectiveContext.test.ts src/game/gameplay/rpg/narrativePlanning/observations.test.ts`；预期新投影缺失失败。
- [x] **Step 3:** 使用 buildNpcSpeechAuthority；actor 可说事实 = actor 可知 ∩ 对受众可披露；旁白 = 玩家现场观察 + 玩家已知且本场相关；选项 = 玩家视角 + 前序已批准可见表达。不能把 discovered 全集当 NPC 知识。结构化目标/人格仅传公开且有事实依据的字段；无法证明不含秘密的 raw goal.reason、history.summary、anchors 自由正文不原样传，优先用公开角色身份和受控风格字段，不能用全量字符串删敏感词充当安全投影。
- [x] **Step 4:** collectDisclosures 校验要求披露的每个 observation 都有已批准句段 fact 引用，audience 实际在场且 disclosure 可用；遗漏拒绝。NPC 声称只产生 speech 来源认知，certainty 不能升级；先审批所有输出，Task 9 实际消费时提交。现有 propagateKnownFacts 的自动传播必须在 staged 模式下改为消费该证据，不能在 talk 规则阶段先把计划披露写入。运行两组测试、npcSpeechAuthority 测试与最低门禁。
- [x] **Step 5:** 提交 `feat: isolate narrative speaker and player contexts`。

强制节拍链：服务端源 mandatory beat → 按 speaker/玩家投影 SafeBeat → source 的 TextPart.beatIds/answeredBeatIds → approveUnit 核对 coverage → assembleBundle 保留原 ID。安全投影不得携带隐藏 instruction；无法在权限内完成必需 beat 时返回 `beat_authority_conflict`，回到规划修复，而非删 beat 或扩大 actor 权限。终幕安全 options 从 ApprovedPlan.choiceExpression 的 ending 臂投影，不要求 RouteTarget。

### Task 5: 四类单次 source、prompt、取消与审计

**Files:**
- Create: `src/game/application/narrativeGeneration/stageSource.ts`
- Create: `src/game/application/server/ai/staged/planningPrompt.ts`, `narrationPrompt.ts`, `characterPrompt.ts`, `choicePrompt.ts`, `liveStageSource.ts` 及测试
- Modify: `src/game/application/server/ai/rpgAiClient.ts`, `aiRuntimeConfig.ts`, `textAuditTypes.ts`, `textAuditRecorder.ts`
- Modify: `src/game/application/aiGenerationRetry.ts`, `src/game/application/server/ai/openingNarrativePrompt.ts`, `.env.example`

**Interfaces:**

```ts
type PlanningContext =
  | { kind: "opening"; input: OpeningGenerationInput }
  | { kind: "decision"; world: WorldState; story: StoryState; job: PendingNarrativeJob };
type StageRequest =
  | { stage: "planning"; context: PlanningContext }
  | { stage: Exclude<Stage, "planning">; context: SafeContext };
type StageSuccess = { ok: true; stage: "planning"; value: PlanProposal }
  | { ok: true; stage: Exclude<Stage, "planning">; value: UnitOutput };
type StageSource = {
  generate(request: StageRequest, execution: {
    signal: AbortSignal; timeoutMs: number; repair?: AiContentRepair;
    audit: AiTextAuditContext;
  }): Promise<StageSuccess | AiSourceFailure>;
};
```

StageSource port 不导入 transport。liveStageSource 调用已有 RpgAiClient；complete 增加可选第四参数 `{ signal?: AbortSignal; timeoutMs?: number }`，透传已存在的公共 AiRequestOptions，不复制公共 HTTP/取消逻辑。新增 role `planning/narration/character/choices`；旧 role 只保留既有 fixture/审计兼容，Task 10 生产断言排除。

四个 prompt 模块分别导出 `buildPlanningPrompt(context: PlanningContext, repair?: AiContentRepair): string`、`buildNarrationPrompt(context: SafeContext, repair?: AiContentRepair): string`、`buildCharacterPrompt(context: SafeContext, repair?: AiContentRepair): string`、`buildChoicePrompt(context: SafeContext, repair?: AiContentRepair): string`。PlanningContext/StageRequest/StageSource 定义于 stageSource；SafeContext 定义于 perspectiveContext。既有 AiContentRepair/AiSourceFailure 从 application/aiGenerationRetry 导入，审计类型从现有 textAuditTypes 导入，不重复定义错误 envelope。

- [x] **Step 1:** source 注入 recording client，每类各一次 complete，角色请求不含 planning 内容；验证 provider JSON 无未知字段、source failure 保留分类、AbortSignal 原样透传。示例：

```ts
expect(calls.map(call => call.role)).toEqual(["planning", "narration", "character", "choices"]);
expect(calls[2].messages.map(m => m.content).join("\n")).not.toContain("SECRET_TRACKING_SEAL");
expect(calls[3].messages.map(m => m.content).join("\n")).toContain("只返回玩家直接说出的对白");
expect(transportOptions.signal).toBe(controller.signal);
```

- [x] **Step 2:** `npx vitest run src/game/application/server/ai/staged src/game/application/server/ai/rpgAiClient.test.ts`；预期新 roles/参数缺失失败。
- [x] **Step 3:** planning prompt 使用预算、公开与私密分区、已选 branch、开局 situation/history/novelty；openingNarrativePrompt 提取既有设定风格要求，禁止遗失 characterProfile/personalityTags。规划 opening 中的 prologue、描述为内容素材，最终序幕由 narration 单元覆盖后才发布；不能直接展示 planner 的 prologue。角色 prompt 只接 SafeContext；旁白不含 NPC 台词输出字段；choice prompt 只返回两条 id/label，禁止前缀、效果、Action。每个 stage 独立 messages，无共享会话。
- [x] **Step 4:** 四类政策使用固定决策表预算；reuse renderAiRepairFeedback/persistedAiRepairReason，不新增自由文本错误存储。审计 context 加 unitKey、inputDigest、cycle、stage、dependencyVersion 和 retry 分类；普通日志只稳定码。测试 timeout 剩余预算、aborted 不重试、空响应进入有界内容修复、配置越界失败。运行本组测试、`npm run typecheck`、`npm run test:boundaries`、`npm run test:fast`。
- [x] **Step 5:** 提交 `feat: add isolated narrative generation sources`。

### Task 6: 纯对白、表演与旁白审批和确定性审核范围

**Files:**
- Create: `src/game/application/narrativeGeneration/approveUnit.ts`, `dialogueLabel.ts`, `assembleBundle.ts` 及测试
- Modify: `src/game/application/approveNarrativeBundle.ts`, `src/game/domain/narrativeBundle.ts`, `src/game/domain/preparedContinuation.ts`

**Interfaces:**
- `checkDialogueLabel(label: string): Check<string>` 不修改 label 正文，只允许外部空白 trim。
- `approveUnit(input: { unit: Unit; context: SafeContext; output: UnitOutput }): Check<UnitOutput>`。
- `assembleBundle(input: { plan: ApprovedPlan; approved: ReadonlyMap<string, UnitOutput> }): Check<NarrativeBundleProposal>`；新 bundle proposal 扩展 stage provenance/顺序元数据，但最终状态仍由现有 approveNarrativeBundle 转换，避免重写其规则。

- [x] **Step 1:** 纯对白失败断言及合法冒号：

```ts
expect(checkDialogueLabel("盯着她问：你到底是谁？").ok).toBe(false);
expect(checkDialogueLabel("（握紧剑）我不答应。").ok).toBe(false);
expect(checkDialogueLabel("我只有一个条件：先放人。").ok).toBe(true);
expect(checkDialogueLabel("我不替你送信，我要当面问清楚。").ok).toBe(true);
```

- [x] **Step 2:** `npx vitest run src/game/application/narrativeGeneration/approveUnit.test.ts src/game/application/narrativeGeneration/dialogueLabel.test.ts src/game/application/narrativeGeneration/assembleBundle.test.ts`；预期未实现失败。
- [x] **Step 3:** 严格 stage/output 匹配；旁白 actionKeys 必须已批准且玩家可见；speaker、facts、eventIds、certainty、披露、观察覆盖、候选映射逐项验证。对白拒绝外层引号、句首说话标签、括号舞台说明、序号、装饰性 >、常见小说式冒号前缀；不能用“任何冒号都是错”代替规则。限制这些检查只证明已列格式和结构，不宣称理解任意语义。
- [x] **Step 4:** 装配按 ScenePoint 顺序，不按 Promise 完成顺序；每句直接对白只归对应 NPC，旁白不复制该对白；规划素材不进展示字段；缺必要单元拒绝。组装句段 fact 引用与 observation，保持各 speaker 来源，不能并集后授权全场 NPC。添加 secret sentinel 精确泄漏拒绝作为已知泄漏检查，不能回显 secret 到 repair。对不在引用卡片中的新世界断言归不可建立来源而拒绝；无法自动判别的隐喻/意图细节由 Task 12 人工验收。运行上述测试与最低门禁。
- [x] **Step 5:** 提交 `feat: approve and assemble isolated narrative expressions`。

审批不得沿用“所有 continuationScenes 共享同一个 previewWorldState”的逻辑。新增 `approveNarrativeBundle` 的 staged 输入字段 `plan: ApprovedPlan`，对每一步调用 sceneSnapshot 与该步的 speaker authority；当前场景仍只允许已提交或本次原子发布真实成立的证据。NarrativeBundleProposal/PreparedSceneSeedState 增加 `conditionalEvidence`（句段索引、observationKey、audienceId）和 `answeredBeatIds` 的逐 speaker 传递；committed eventIds 单独走原有 ledger 校验。条件引用只能指向同包前序且条件可证明的 observation，不能伪造一个已提交 EventId，也不能组装时替模型补造 answeredBeatIds。未来条件 authority 与本次真实 authority 分开验证。

### Task 7: 持久化 job、lease 和原子发布契约

**Files:**
- Create: `src/game/application/server/persistence/narrativeJobRepository.ts`, `sqliteNarrativeJobs.ts` 及测试
- Modify: `src/game/application/server/persistence/gameRepository.ts`, `sqliteGameRepository.ts`, `worldStatePersistenceValidation.ts`, `storyStatePersistenceValidation.ts`
- Modify: `src/game/application/server/persistence/sqliteClient.ts`（仅导出既有 client transaction 类型别名，不增加数据库连接）
- Modify: `src/game/domain/worldState.ts`, `storyState.ts`, `narrativeBundle.ts`, `eventPayloadValidation.ts`, `src/game/domain/entity/entityStore.ts`

**Interfaces:** 同一个 SQLite 实例实现 GameRepository 与 NarrativeJobRepository；不要第二连接独立 commit 游戏发布。

```ts
type StoredUnit = {
  unit: Unit | null; key: string; inputDigest: string; attempts: number;
  status: "pending" | "running" | "approved" | "failed" | "unknown";
  value: PlanProposal | UnitOutput | null;
};
type StoredJob = {
  schemaVersion: 1; id: string; scope: "initialization" | "decision";
  version: number; cycle: number; status: "pending" | "failed" | "published" | "cancelled";
  input: PlanningContext; inputDigest: string; baseRevision: number | null;
  gameId: string | null; units: readonly StoredUnit[];
  usedRequests: number; baselineRequests: number; deadline: string;
  failureCode: string | null;
  initialization: InitializationEnvelope | null;
};
type InitializationEnvelope = {
  requestId: string; newGameId: string; seed: string; generation: GenerationMetadata;
  target: { kind: "create" }
    | { kind: "replace"; expectedGameId: string; expectedRevision: number; endingIdentity: string };
};
type Lease = { jobId: string; owner: string; fence: number; expiresAt: string };
type Publication =
  | { kind: "opening"; input: CreateInitialGameInput; replace?: ReplaceCurrentGameInput }
  | { kind: "decision"; input: ApplyStateInput };
interface NarrativeJobRepository {
  start(input: { requestId: string; digest: string; job: StoredJob }): Promise<Check<StoredJob>>;
  get(id: string): Promise<Check<StoredJob>>;
  claim(input: { id: string; owner: string; now: string; expiresAt: string }): Promise<Check<Lease>>;
  renew(input: { lease: Lease; now: string; expiresAt: string }): Promise<Check<Lease>>;
  release(input: { lease: Lease }): Promise<Check<true>>;
  control(input: { id: string; expectedVersion: number; expectedCycle: number;
    operation: "cancel" | "retry"; now: string }): Promise<Check<StoredJob>>;
  save(input: { lease: Lease; expectedVersion: number; job: StoredJob }): Promise<Check<StoredJob>>;
  publish(input: { lease: Lease; expectedVersion: number; publication: Publication }): Promise<Check<StoredJob>>;
}
```

get 不暴露给 UI；safe status 单独投影。lease 30 秒 TTL、10 秒续租，renew 验证相同 owner/fence 且未过期，不改变 payload version；接管递增 fence。worker 写入同时验证未过期 lease、版本、status 与当前周期，发布时间额外验证 ready coverage 和游戏 CAS。control 是不需要 worker lease 的独立控制事务，仍强制 expectedVersion/expectedCycle CAS：cancel 只接受 pending/failed，设置 cancelled、递增 fence 并撤销 lease；retry 只接受 failed，递增 cycle/fence、清空 lease、恢复 pending、deadline=now+600秒、清零本周期请求/单元次数并保留历史审计和输入仍匹配的 approved 产物。published/cancelled 不可 retry；重复操作返回安全现状或冲突，不能再增加周期。API 从服务器读取 version/cycle 后执行一次控制 CAS，冲突返回409，不自动循环。error code 使用现有 infrastructure/stale 语义及 JOB_NOT_FOUND、JOB_CONFLICT、LEASE_LOST、UNSUPPORTED_JOB。

- [x] **Step 1:** SQLite 临时库 reopen、双 claimant 和事务故障测试：

```ts
expect(secondClaim.ok).toBe(false);
expect(staleWorkerSave.ok).toBe(false);
expect(afterReopen.units.filter(x => x.status === "approved"))).toEqual(approvedBeforeClose);
expect(afterFailedPublish.currentGame).toEqual(beforePublish.currentGame);
expect(afterFailedPublish.job.status).not.toBe("published");
```

- [x] **Step 2:** `npx vitest run src/game/application/server/persistence/sqliteNarrativeJobs.test.ts`；预期接口不存在失败。
- [x] **Step 3:** 新表 narrative_jobs（id PK、request_id UNIQUE、digest、version、status、cycle、lease_owner、fence、expires_at、payload_json）、initialization_slot（单当前初始化任务指针）。start 同 requestId 同 digest 返回现有 job，不同 digest 冲突；decision job 唯一键绑定 gameId+pending jobId。任务进度不修改 game revision。未知 job schema 明确拒绝，全部 JSON exact-key/ref 校验。publish 在同 write transaction 修改 game/current/opening_history、job published 和初始化指针；不能先调 applyState 再标记 job。
- [x] **Step 4:** 更新版本分类及全部现有 fixture 使用版本常量。新增 branch/observation/bundle 字段严格恢复；observations 的真实来源保存 ledger，StoryState 仅确定性投影，不长期保存额外玩家原文。EntityStore 仍为 2，仅校验新增 event provenance，不给 player 偷添未定义组件。运行 persistence 全目录、domain 测试及最低门禁。
- [x] **Step 5:** 提交 `feat: persist fenced narrative jobs and atomic publication`。

初始化 start 前铸造并保存 InitializationEnvelope；重启后只能从该 envelope 恢复 newGameId、seed、generation 和 replace 条件，不能读取当前 UI 参数重建，不能重试时换 seed。decision job 的 initialization 必须为 null，initialization job 必须非 null。Publication.opening.input.gameId 与 envelope.newGameId 必须匹配；create/replace 模式不允许调用者切换，replace CAS 同时校验目标游戏、revision、仍是结局和 endingIdentity。requestId/digest 唯一键、旧游戏身份和新游戏身份各自独立。测试增加“原游戏A重开失败→进程重启→同任务重试仍只可替换A对应revision”，中间current变成B则发布拒绝且B不变。

### Task 8: 可恢复 DAG 调度与有界预算

**Files:**
- Create: `src/game/application/narrativeGeneration/runJob.ts`, `jobBudget.ts`, `runJob.test.ts`, `jobBudget.test.ts`
- Create: `src/game/application/testing/stagedNarrativeHarness.testutil.ts`
- Modify: `src/game/application/server/ai/_shared/ensureCoordinator.ts` 及测试

**Interfaces:** `runJob(input: { id: string; lease: Lease }, deps: { jobs: NarrativeJobRepository; source: StageSource; now: () => string; signal: AbortSignal }): Promise<Check<StoredJob>>`；`canStartRequest(input: { job: StoredJob; unitAttempts: number; now: string }): Check<true>`。runJob 不 claim/release，完成生成和审批后返回待发布的 pending job。ensureCoordinator 的单一执行作用域负责 claim→启动续租→runJob→装配 Publication→publishJob→finally 停止续租并 fenced release；调用方不得取得 pending 结果后脱离此作用域发布。renew 返回的新 Lease 由协调器保存，publish 使用最新 lease；owner/fence 在有效租期内不变。任一续租失败立即 abort，禁止随后发布。

Harness 导出 `createStagedHarness()`，提供 `jobs`, `source`, `calls`, `clock`, `controller`, `startDecision()`, `run()`；基于生产 approvePlan/projectUnitContext/approveUnit，只有 provider 响应 scripted。clock 支持 advance(ms)，source 支持 failNext(stage)、hold(stage)、release(stage)；每个定义在本测试 helper 实现，不放生产 facade。

- [x] **Step 1:** 先写下游重试和并行顺序测试：

```ts
const h = createStagedHarness();
h.source.failNext("choices");
await h.startDecision();
await h.run();
expect(h.calls.filter(c => c.stage === "planning")).toHaveLength(1);
expect(h.calls.filter(c => c.stage === "choices")).toHaveLength(2);
expect(h.calls.filter(c => c.stage === "narration")).toHaveLength(1);
```

- [x] **Step 2:** `npx vitest run src/game/application/narrativeGeneration/runJob.test.ts src/game/application/narrativeGeneration/jobBudget.test.ts`；预期 runner 不存在失败。
- [x] **Step 3:** claim → charge/save running → generate → approve → save approved，绝不先发请求后扣预算；planning 固定逻辑 key，其他 key 由服务端 point/stage/speaker/ordinal 铸造，模型重命名无效。调度 readyUnits，每 job 最多 2 个在途；依赖 inputDigest/版本匹配才复用。骨架重做撤销全部依赖旧骨架的表达，仍累计 attempts；对只改变一独立角色的修复，不取消无关旁白。
- [x] **Step 4:** 在途未知请求重启标 unknown、保留 charge，等待 lease 过期后可有界重做；没有 provider 幂等支持不声称恰好一次。超时 signal 传 client，迟到输出用 fence/version/cycle 拒绝。budget policy 使用固定决策数值，最坏单元数与关键路径容纳性在规划审批检查，手动 retry 新 cycle 但保留审计累计。失败状态包括真实 failureKind，不能把 transport 全归 schema。测试 fake clock deadline、四次/额外12额度、取消、lease 丢失和半包不可发布。
- [x] **Step 5:** 跑本 Task 测试、ensureCoordinator 测试及最低门禁，提交 `feat: run recoverable bounded narrative unit graphs`。

首次规划前 baselineRequests=1；第一次骨架批准后固定为 1+必需表达数，不随之后改版缩减或扩大，新增单元消耗额外额度。扣费与同 job 并行写回由协调器串行化，不能让两个 provider 完成各自覆盖另一方结果。增加生成完成至发布间崩溃/过期/他进程接管测试：新 owner 读取持久化 approved 单元可直接重新装配，无新增 provider；旧 owner publish 必须失败。跨进程 control 撤销 lease 后，即使 provider 不响应 abort，迟到输出也不可写回；测试在持有锁、请求尚未返回时 cancel 立即成功，以及失败后一次 retry 恰好增加一个周期。

### Task 9: 事件、认知、预生成消费与整包发布

**Files:**
- Create: `src/game/application/narrativeGeneration/publishJob.ts`, `publishJob.test.ts`
- Modify: `src/game/application/consumeNarrativeBundle.ts`, `approveNarrativeBundle.ts`, `reconcileCommittedMemory.ts`
- Modify: `src/game/gameplay/rpg/narrativeBundle/coverage.ts`, `endingDecision.ts`, `src/game/domain/narrative.ts`
- Modify: `src/game/gameplay/rpg/narrativeMemory/renderNarrativeMemory.ts`, `src/game/gameplay/rpg/npcMemory/index.ts`
- Test: 同名测试及 `src/game/application/testing/stagedNarrativeJourney.test.ts`

**Interfaces:** `publishJob(input: { job: StoredJob; lease: Lease; publication: Publication }, jobs: NarrativeJobRepository): Promise<Check<StoredJob>>` 先复核产物、输入与任务 ready coverage，再调用原子仓储方法。`collectDisclosures` 返回的 observations 在当前 scene 发布、未来 scene 实际消费时转成真实 event draft；新事件 `narrative_observed` 包含 key、audience、factId、certainty、source speaker/见证，不保存模型原文。

- [x] **Step 1:** 完整 publish/consume 路径验证：

```ts
expect(beforeMove.knowledge.some(x => x.factId === futureFactId)).toBe(false);
expect(afterMove.knowledge.some(x => x.factId === futureFactId)).toBe(true);
expect(afterMove.revision).toBeGreaterThan(publishedRevision);
expect(afterMove.futureStepConsumed).toBe(true);
expect(afterDuplicateConsume).toEqual(afterMove);
```

这些为测试选择器结果，knowledge 来源由 ledger 重建，revision 来自 repository；不把测试选择器混入 GameRecord。
- [x] **Step 2:** `npx vitest run src/game/application/narrativeGeneration/publishJob.test.ts src/game/application/consumeNarrativeBundle.test.ts src/game/application/testing/stagedNarrativeJourney.test.ts`；预期新 observation/依赖未接入失败。
- [x] **Step 3:** 所有 provenance 引用由 commitEventDrafts 铸造；按当前/未来时间切分，未来不能先写 presented。bundle contract2 保存每步依赖和表达顺序，consume 时复核实际前提而非 baseRevision 相等。known/suspected 与 witness/speech 分开，已知世界事实不得因听到怀疑说法降级，传播不得升级怀疑为确定。复用 npcMemory mutation，不写投影数组。
- [x] **Step 4:** 终幕选择语义由 endingDecision 决定，给 choices 单元安全语义生成纯对白；内部单独存 terminal label map，不能违反 ending bundle 无普通 choices 的契约。点击终幕仍只 resolveEnding，无 provider。战败 checkpoint 恢复 observations、branch state 与事件，所有重新生成的 token 绑定实际 revision。跑上述测试、战斗与结局回归及最低门禁。
- [x] **Step 5:** 提交 `feat: publish and consume staged narrative evidence atomically`。

条件证据兑现：获批 bundle 存 observationKey 与受众映射；实际步骤消费生成 narrative_observed draft，commitEventDrafts 得到真实 EventId 后把本次可用条件引用绑定为真实 provenance，再更新知识和重建记忆，同次 CAS 提交。尚未消费的条件引用保留为条件，绝不进入已提交 ledger。失败/撤退使相应条件不成立，拒绝依赖它的表演。新增测试必须证明“乙只能在前序披露实际发生后引用该事实”既能在预生成审批通过，又不会在消费前进入乙的永久知识。

终幕 label map 存在 bundle contract2 的 `endingLabels: { trust: string; doubt: string } | null`；ordinary 包必须 null，ending 包必须恰好两条，parseNarrativeBundleState 和持久化恢复同样验证。ready coverage 把 ending choices 单元计入预算与必需单元；其失败阻止整个终幕包发布。endingDecisionStances 读取已批准 label map，保持原 action/资格/token 铸造，不再输出生产硬编码 label；gameSessionView 只投影合法立场。仅将来消费规则已准备终幕时展示，不能提早泄露结局方向。

### Task 10: 原位切换生产与初始化任务 API

**Files:**
- Modify: `src/game/application/createGame.ts`, `generatePendingNarrativeBundle.ts`, `retryNarrativeGeneration.ts`, `narrativeBundleSource.ts`
- Modify: `src/game/application/server/compositionRoot.ts`, `src/game/application/server/ai/sourceFactory.ts`
- Create: `src/game/application/initializationStatus.ts`, `src/app/api/game/initialization/route.ts` 及测试
- Modify: `src/app/api/game/route.ts`, `src/app/api/game/narrative/ensure/route.ts`, `src/game/application/index.ts`
- Test: `src/game/application/server/providerTriggerBoundary.test.ts`, `compositionRoot.test.ts`, `src/app/api/game/routeContract.test.ts` 与用例同名测试

**Interfaces:** 新 public `InitializationView = { requestId: string; status: "pending" | "failed" | "published" | "cancelled"; failureKind?: AiFailureKind; revision?: number }`，不含 input、unit 或 skeleton。

| 请求 | 契约 |
| --- | --- |
| POST /api/game | 保留原 setup/restart，增加必填 requestId；start durable initialization，返回 202 + InitializationView；同 requestId 同输入返回已有状态，已发布 200；冲突409 |
| GET /api/game/initialization | 无 query 返回当前 initialization_slot 的安全状态或 none，供无浏览器 marker 的恢复；requestId query 只读指定当前任务；不自动重试失败 |
| POST /api/game/initialization | `{requestId, operation:"retry"}` 或 `{requestId,operation:"cancel"}`，exact-key 校验；retry 只恢复同任务，cancel 使在途结果失效 |
| POST /api/game/narrative/ensure | 维持 pending 调度、显式 retry=true 语义，调新 runner；不建立第二套生产调度 |

重新生成：先显式 cancel 当前任务，再以新 requestId 提交；服务器单槽 CAS 防多 tab 并发覆写。修改同 requestId 输入返回409而非重新计费。decision start 和 provider_pending 关联不得出现一个提交成功而另一个永久丢失：ensure 可从已提交 pending job 幂等补建 task，不提前调用 provider。

- [x] **Step 1:** API 测试无存档创建失败后查询恢复，重复 POST 只一次 start，新输入同 ID 409、未知 key400；生产决策只有 four-stage source。核心断言：

```ts
expect(first.status).toBe(202);
expect(repeatedBody.requestId).toBe(firstBody.requestId);
expect(providerPlanningCalls).toBe(1);
expect(currentGameBeforePublish.status).toBe("none");
expect(initializationStatus.status).toBe("failed");
```

- [x] **Step 2:** `npx vitest run src/app/api/game src/game/application/server/compositionRoot.test.ts src/game/application/server/providerTriggerBoundary.test.ts`；预期新 route/返回码不匹配失败。
- [x] **Step 3:** createGame 改为 durable start + 查询语义，调用 Task 3 结构编译/表达安装；保留初始历史、novelty、speech 与 setup 校验。generatePendingNarrativeBundle 委托协调器的完整 runJob+publishJob 租约作用域，删除旧完整包四次循环，防重试乘法。retry 经 control 对旧 version/cycle CAS 成功、创建新 cycle 后才重新调度；cancel 同样经 control，不等待 worker 释放锁；current 游戏读取保持只读。
- [x] **Step 4:** sourceFactory 唯一生产装配 StageSource；移除 liveNarrativeBundleSource 的生产调用，仍被 fixture 需要的纯 parser 移至 domain/application 正式归属，不能让旧源成为 fallback。新增 initialization route 审计映射并更新六 route 固定数量断言为实际集合。初始化重开发布复核 ended identity/revision，失败不删旧游戏。跑全 application、app、最低门禁。
- [x] **Step 5:** 提交 `feat: switch production to staged narrative jobs`。

### Task 11: 初始化恢复与纯对白显示

**Files:**
- Modify: `src/components/gameActionRequest.ts`, `NewGameSetupForm.tsx`, `CurrentGameScreen.tsx`, `GenerationStatusModal.tsx`, `NpcDialogueOverlay.tsx`
- Modify: `src/game/application/gameSessionView.ts`, `src/game/application/index.ts`
- Test: 上述同名 tests（组件使用 `.test.tsx`）

**Interfaces:** gameActionRequest 增加 `fetchInitialization(requestId?: string): Promise<InitializationView | {status:"none"}>`、`retryInitialization(requestId: string): Promise<InitializationView>`、`cancelInitialization(requestId: string): Promise<InitializationView>`。错误统一转现有错误展示，不能把网络失败当 none。

- [x] **Step 1:** RTL 模拟202→刷新→failed→retry→published，断言 requestId 不变、无半游戏和重复创建；显示选项原样：

```ts
expect(screen.getByRole("button", { name: "我不替你送信，我要当面问清楚。" })).toBeVisible();
expect(screen.queryByText(/盯着她问|顺着她的话头/)).toBeNull();
expect(retryBody).toEqual({ requestId: initialRequestId, operation: "retry" });
```

- [x] **Step 2:** `npx vitest run src/components/CurrentGameScreen.test.tsx src/components/NewGameSetupForm.test.tsx src/components/NpcDialogueOverlay.test.tsx src/components/gameActionRequest.test.ts`；预期202尚未处理失败。
- [x] **Step 3:** 创建前生成一次 requestId，sessionStorage 仅存 marker/id，不存隐藏输入或任务产物。刷新服务器 slot 恢复；重试禁用双击，网络未知重查同 ID。已有重开 marker 与结束游戏并存时显示初始化进度，失败可回旧结局；取消后允许新请求。storage 不可用仍用服务器状态恢复。
- [x] **Step 4:** view 只投影获批 label 和按场景顺序的内容。对话分页/旁白页遵守 ScenePoint，必须先展示选项依赖的旁白和对白再允许选择；后台完成不跳页，不改当前 displayedDialogue。UI 不清洗模型文本来掩盖审批失败；手动操作按钮保留原用途。运行本组测试、components、最低门禁。
- [x] **Step 5:** 提交 `feat: restore initialization jobs and render dialogue-only choices`。

### Task 12: 完整旅程、真实质量验收与文档归位

> **记账说明（2026-09-10）**：Task 1–9 的 Step 勾选此前从未回填，导致计划文档显示为未完成。经逐项核对**交付物与测试**后回填：Task 1–9 的测试文件全部存在，运行 `npx vitest run` 覆盖 `src/game/domain`、`src/game/gameplay/rpg/narrativePlanning`、`src/game/application/narrativeGeneration`、`src/game/application/server/persistence/sqliteNarrativeJobs.test.ts` 共 **20 files / 195 tests 全绿**；Task 5 的四类 prompt（`staged/{planning,narration,character,choice}Prompt.ts`）、Task 7 的 `narrativeJobRepository.ts`、Task 9 的 `publishJob.ts` / `consumeNarrativeBundle.ts` / `realizeObservations.ts` 均在位。因此回填是**补记账**，不是补实现。

**Files:**
- Modify: `src/game/application/testing/stagedNarrativeJourney.test.ts`, `src/game/application/testing/stagedBranchJourney.test.ts`
- Create: `scripts/stagedNarrativeSmoke.mjs`, `scripts/stagedNarrativeSmoke.node-test.mjs`
- Modify: `package.json`, `docs/agent/运行时AI导演与场景表演.md`, `NPC人格知识与关系图.md`, `AI环境.md`, `AI文本审计.md`, `实体与组件世界状态.md`, `行动裁决.md`, `MVP核心闭环.md`, `地图与地点冒险.md`, `战斗与结局.md`, `剧情连续性与结构化记忆.md`
- Modify: `docs/策划文档/运行时AI角色职责与生成规则.md`, `docs/Agent文档索引.md`（仅职责/阅读依赖变化）, `docs/operations/README.md`（若增加运维入口）
- Create: `docs/superpowers/reports/2026-09-09-staged-narrative-generation-review.md`（实施验收证据，不混入当前契约）

**Interfaces:** package scripts `test:staged-smoke = node --test scripts/stagedNarrativeSmoke.node-test.mjs`、`smoke:ai:staged = node scripts/stagedNarrativeSmoke.mjs`。smoke 复用现有 phase4bAiSmoke 的 TS loader 与 env 门禁方式，用独立临时 GAME_DB_PATH；require `RUN_REAL_AI_SMOKE=1`，默认零 provider 调用。

- [x] **Step 1:** node:test 验证无门禁失败退出、独立临时库、不读写用户 current slot、超总请求预算停止；离线 journey 覆盖 Spec 全表，每个 branch 从同一获批状态分叉而非手写 selectedBranches。核心断言：

```ts
expect(journey.providerCallsOnMove).toBe(0);
expect(journey.providerCallsOnBattleRound).toBe(0);
expect(journey.normalDecisionStages.sort()).toEqual(["character", "choices", "narration", "planning"]);
expect(journey.publishedPartialPackages).toBe(0);
expect(journey.futureKnowledgeBeforeTrigger).toEqual([]);
```

实现说明：`normalDecisionStages` 按骨架实际单元断言（夹具为双 NPC，故 character 两次），单 NPC 骨架下即为上表四次；`publishedPartialPackages` 由 `harness.publishedCount()` 承载（未批准完为零）；无 GameRecord 时可查询/重试同一初始化任务由 `startInitialization`/`runInitializationJob` 覆盖；`futureKnowledgeBeforeTrigger` 的跨 NPC/未来认知场景在真实 smoke 中逐条人工判断（离线夹具不含跨地点认知差）。
- [x] **Step 2:** `npx vitest run src/game/application/testing/stagedNarrativeJourney.test.ts src/game/application/testing/stagedBranchJourney.test.ts`，`node --test scripts/stagedNarrativeSmoke.node-test.mjs`；预期未覆盖的新场景失败，不接受 skip 代替实现。已确认：先写测试时 `stagedNarrativeSmoke.mjs` 缺失导致 `ERR_MODULE_NOT_FOUND`（非 skip），实现后 20 + 21 全绿。
- [x] **Step 3:** 实现有界 real smoke：3 个开局，每局同一批准决策各执行两个分支，共6次续接；至少包含疑似证据、跨 NPC 认知差异、未来抵达/战斗条件。其中至少一条短篇从开局运行至合法结局；续接单独成功不能称通关。全 run 最多160次 provider transport 请求、45分钟，任一上限达到后停止并记录未完成。不因失败重复采样直到成功。保存完整审计与脱敏报告，不提交凭据、临时存档或原始玩家隐私输入。

脚本能力完整：`SMOKE_LIMITS` = 160 请求 / 45 分钟 / 单局 40 回合；达限记 `SMOKE_BUDGET_STOP` 并停止后续局；首局（`playToEnding`）在分支后继续推进至 `world.ending`，未到结局报 `PLAYTHROUGH_ENDING_NOT_REACHED`（续接成功明确不算通关）；独立临时 `GAME_DB_PATH`，不碰用户存档槽。**真实 AI 执行属 Step 4**：需在具备配置的环境显式 `npm run smoke:ai:staged`，未执行前不得声称验收完成。
- [ ] **Step 4:** 执行 `npm run typecheck`、`npm run test:boundaries`、`npm test`、`npm run test:fast`、`npm run build`；然后在有真实 AI 配置的实施环境显式门禁运行 `npm run smoke:ai:staged`。人工逐条检查旁白/台词秘密泄露、纯对白、事实来源和两条策略分化。通过标准：所有离线门禁通过，所有已发布样本无已发现越权泄漏/假分支/格式违规，3/3开局及6/6续接在预算内成功，至少1局完整短篇通关；失败样本全部留存，未满足不得声称验收完成。
- [ ] **Step 5:** 浏览器验证202开局刷新恢复、失败同任务重试、NPC/旁白阅读顺序、两个 label 无小说前缀、选择导致不同目标；不能以静态截图代替实际交互。报告记录实际延迟、请求数、transport重试、质量拒绝与剩余限制；不声称自然语言绝对安全。
- [ ] **Step 6:** 原位更新事实归属文档：运行时链/预算归 runtime，知识归 NPC/记忆，API恢复与配置归 operations/AI环境，玩家纯对白和分支归策划；不重复维护详细契约。文档新增入口依赖才改索引，不写阶段成绩。`npm run check:docs`、`git diff --check`；只提交本任务文件，`docs: document staged narrative contracts and acceptance`。

## 关键实现片段（对应 Task 的 Step 3，不是替代验收）

Task 1 的未知字段检查必须先缩窄 unknown，不能直接类型断言成功：

```ts
function hasOnlyKeys(raw: unknown, allowed: readonly string[]): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    && Object.keys(raw).every(key => allowed.includes(key));
}
```

Task 2 的 token 输入必须带分支身份，放在现有 deriveChoiceToken 的语义摘要步骤：

```ts
function branchTokenPart(branch: ApprovedChoice["branch"]): string {
  return branch === undefined ? "" : JSON.stringify([branch.decisionId, branch.candidateId]);
}
```

Task 3 的 DAG 调度只选依赖全部通过的未完成单元：

```ts
export function readyUnits(units: readonly Unit[], approvedKeys: ReadonlySet<string>): readonly Unit[] {
  return units.filter(unit => !approvedKeys.has(unit.key)
    && unit.dependencies.every(key => approvedKeys.has(key)));
}
```

Task 4 的引用裁剪不能只过滤顶层卡片；句段也必须整体批准：

```ts
function hasAllowedFacts(part: TextPart, allowed: ReadonlySet<string>): boolean {
  return part.facts.every(fact => allowed.has(fact.factId));
}
```

该判断只覆盖引用权限，实际 DTO 还需按 Task 4 检查 persona、priorText、任务和 evidence，不把引用合规作为正文安全证明。

Task 5 的 choices prompt 只能序列化 SafeContext：

```ts
export function buildChoicePrompt(context: SafeContext, repair?: AiContentRepair): string {
  return [
    "只返回玩家直接说出的对白；输出严格 JSON labels 数组，逐项 candidateId 和 label。",
    "恰好两项。不得添加说话标签、舞台动作、心理描写或结果预告；不得修改候选意图。",
    renderAiRepairFeedback(repair),
    JSON.stringify(context),
  ].filter(Boolean).join("\n");
}
```

Task 6 格式检查保留合法冒号；扩展测试语料而非不断裁掉前缀：

```ts
export function checkDialogueLabel(raw: string): Check<string> {
  const label = raw.trim();
  if (Array.from(label).length < 1 || Array.from(label).length > 80)
    return { ok: false, code: "invalid_label_length" };
  if (/^[>“”"「『（(\[]/.test(label) || /^\d+[、.]/.test(label)
    || /^(?:玩家|你说|盯着.*?问|顺着.*?接一句|试探地说|谨慎地试探)[：:]/.test(label))
    return { ok: false, code: "dialogue_prefix_forbidden" };
  return { ok: true, value: label };
}
```

Task 7 的版本/lease 写回条件必须在 SQL，而非只在内存判断（参数绑定，不拼接值）：

```sql
UPDATE narrative_jobs SET payload_json = ?, version = version + 1
WHERE id = ? AND version = ? AND lease_owner = ? AND fence = ?
  AND expires_at > ? AND cycle = ? AND status = 'pending';
```

Task 8 的预算检查位于扣费事务前后，拒绝不消耗新请求：

```ts
export function canStartRequest(input: { job: StoredJob; unitAttempts: number; now: string }): Check<true> {
  if (Date.parse(input.now) >= Date.parse(input.job.deadline))
    return { ok: false, code: "job_deadline_exceeded" };
  if (input.unitAttempts >= 4 || input.job.usedRequests >= Math.min(52, input.job.baselineRequests + 12))
    return { ok: false, code: "job_budget_exceeded" };
  return { ok: true, value: true };
}
```

Task 9 的条件引用兑现不伪造 EventId：

```ts
function bindEvidence(ref: EvidenceRef, committed: ReadonlyMap<string, string>): Check<EvidenceRef> {
  if (ref.kind === "committed") return { ok: true, value: ref };
  const eventId = committed.get(ref.observationKey);
  return eventId === undefined ? { ok: false, code: "observation_not_consumed" }
    : { ok: true, value: { kind: "committed", eventId } };
}
```

Task 10 初始化响应只取安全字段（错误分类经既有 helper 转换）：

```ts
function initializationPublicFields(job: StoredJob): Pick<InitializationView, "requestId" | "status"> {
  if (job.initialization === null) throw new Error("not_initialization_job");
  return { requestId: job.initialization.requestId, status: job.status };
}
```

Task 11 渲染必须直接使用 approved label，不能再调用小说式文案装饰：

```tsx
<button type="button" disabled={busy} onClick={() => onChoose(choice.choiceToken)}>
  {choice.label}
</button>
```

其中 `busy/choice/onChoose` 使用 NpcDialogueOverlay 的既有 props/事件适配，不增加新业务动作；测试跟随其当前回调名称。Task 12 的脚本真实调用门禁必须在加载 provider 前检查：

```js
if (process.env.RUN_REAL_AI_SMOKE !== "1") {
  throw new Error("RUN_REAL_AI_SMOKE=1 is required");
}
```

## Spec 覆盖矩阵

| Spec | Task |
| --- | --- |
| 1–3 四职责、独立请求、调用数和 DAG | 1、3、5、8、10 |
| 4 世界骨架/开局/预算/规则审批 | 1、3、5 |
| 5 实质分支、受控行为、自定义输入 | 2、3、10、12 |
| 6 认知、披露、表演动作、审核限制 | 4、5、6、9、12 |
| 7 独立旁白、时点、预生成消费 | 3、4、6、9、11 |
| 8 纯对白、安全候选、终幕 | 2、4、6、9、11 |
| 9 恢复、初始化、CAS、lease、预算、取消 | 7、8、9、10、11 |
| 10 transport、审计、客户端 | 5、8、10、11 |
| 11 场景矩阵与真实验收 | 12，各任务定向测试 |

实施任务通过后在对应 checkbox 和提交记录中填写证据；Plan review 只证明计划经过检查，不能提前勾选实施验收。执行期间发现当前代码与此基线变化，应先更新相关接口与任务依赖，再实施，不能绕过规则或增加隐形 provider 请求。
