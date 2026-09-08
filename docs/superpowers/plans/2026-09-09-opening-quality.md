# 初始化剧情质量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已授权执行以下步骤，使用已有 opening-context worktree。

**Goal:** 初始化生成贴合玩家设定的历史、局面和两种具体回应，并让首次选择后的 API 输入保留其因果。

**Architecture:** 扩展唯一 opening candidate 与初始化事件账本，复用实体组件、关系 seed policy、八种 DialogueAct、opaque registry 和现有记忆检索。初始化线程只作有来源的种子；首轮 handoff 投影当前事实，不新增权威剧情摘要或第二条 provider 链。

**Tech Stack:** TypeScript、Vitest、SQLite/现有仓储、现有 narrative bundle source。

**Spec:** [初始化剧情质量设计](../specs/2026-09-09-opening-quality.md)。实现者先读该 Spec，再读当前 Task；所有新增类型与边界以 Spec 为准。

## Global Constraints

- 用户已授权在 `.worktrees/opening-context` 执行 TDD 实现和隔离真实 AI 质量验收。
- 后续交付边界为创建游戏、持久化、首次选择和下一次生成上下文。
- 保留一个起始地点、一个焦点 NPC、一个内部主线任务、现有短篇/中篇预算和 NPC 决策入口。
- 保留 `trust/doubt` 终幕规则与 3/5 幕预算；初始化只生成开放的价值主题，不把它写成已决定的结局或整局路线。
- 生产失败显式重试；不以默认文案、机械补写剧情或 fixture 冒充成功。
- 使用现有 NPC speech authority；秘密不能经 memory/thread/choice 绕过权限。
- 世界权威归 EntityStore 和 eventLedger；memory 必须由 ledger 确定性重建。
- 客户端仍只收到 opaque token 和 label；AI 不提交关系数值、token、实体 ID、奖励或已完成状态。
- WorldState schema 5→6；StoryState 继续 8，EpisodicMemory 继续 1。旧世界版本显式拒绝，不迁移、不清档。
- 决策上下文维持 8,000 estimated tokens 上限；不增加 provider 触发点或评审调用。
- 分支 worktree 放 `.worktrees/`，不用 `git checkout`；保护 sibling foundation 和已有链接。
- 不更新 `docs/agent/current-phase.json` 或阶段 Plan；当前实现文档仅在代码落地后更新。

## 文件与任务图

Task 1 定义闭合候选和可执行首轮回应；Task 2 把背景和关系编入权威世界；Task 3 验证落库、重载与安全记忆；Task 4 完整生产 prompt；Task 5 第一次选择 handoff；Task 6 真实质量验收和文档收尾。顺序执行，避免 provider 提案先于消费者契约落地。

| 新文件 | 单一职责 |
|---|---|
| `src/game/domain/openingSituation.ts` | 类型与结构解析，不做关系裁决或持久化 |
| `src/game/gameplay/rpg/openingGeneration/openingSituationRules.ts` | 语义引用校验、局部 key 解析、首轮 Action 映射 |
| `src/game/application/server/ai/openingNarrativePrompt.ts` | 生产初始化 prompt，消费已有 style policy |
| `src/game/application/server/ai/narrativeContext/openingHandoffContext.ts` | 第一次决策调用所需的公开背景投影 |
| `src/game/domain/openingSituation.testutil.ts` | 下述完整最小候选，仅离线测试使用 |
| `src/game/application/testing/openingQualityJourney.test.ts` | 创建到首次选择后 provider 输入的验收 |
| `src/game/application/testing/openingQuality.live.test.ts` | 显式环境门禁的真实样本；默认测试跳过 |

测试材料放 domain 的 testutil，避免 domain 测试反向依赖 application；生产不得导入 testutil。新文件不引入共享 package；application 调 gameplay 只走 openingGeneration/narrativeMemory/npcMemory facade。其余受影响文件在各 Task 列明，不另建 parallel source。

## 统一测试材料

Task 1 创建 `openingSituation.testutil.ts`，导出 `makeOpeningQualityCandidate(): OpeningGenerationCandidate`。函数必须每次返回新对象，不调用真实 AI，不由随机 seed 决定断言。用下列候选替换测试中重复内联样板；production 不得导入它。

```ts
export function makeOpeningQualityCandidate(): OpeningGenerationCandidate {
  return {
    world: {
      summary: "浮港依靠旧式动力机维持航道，船厂正在安排维修。",
      tone: "克制", themes: ["责任", "生计"],
      publicFacts: [
        { key: "fact_past", text: "主角过去曾与船厂技师共同维修引擎。" },
        { key: "fact_request", text: "技师希望先停机检查，船厂却急于恢复作业。" },
        { key: "fact_records", text: "维修记录可以在现场核对。" },
        { key: "fact_secret", text: "技师私自隐去了上次维修失误。" },
      ],
    },
    player: {
      name: "沈砚", identity: "返乡的修理师", backgroundSummary: "曾在船厂修理引擎。",
      baseStats: { hp: 100, attack: 10, defense: 5 },
    },
    prologue: "你重返浮港，旧日同事正为停机检查与恢复作业的争执发愁。",
    storyContract: {
      version: 1, targetActs: 3, centralConflict: "如何兼顾维修安全与船厂生计",
      endingDirections: [
        { key: "trust", theme: "共同承担责任" },
        { key: "doubt", theme: "保留独立判断" },
      ],
    },
    opening: {
      location: { name: "浮港", description: "航道边的船厂聚落。", buildingName: "维修棚", scale: "town" },
      npc: {
        name: "林舟", role: "船厂技师", description: "你的旧日同事，担心仓促开机会伤人。",
        knownFactKeys: ["fact_past", "fact_request", "fact_records"], privateFactKeys: ["fact_secret"],
        anchors: {
          selfConcept: "对维修负责的技师", values: ["安全"], speechStyle: "直说顾虑",
          capabilityBoundaries: ["无权独自停掉整个船厂"], taboos: [],
        },
        goals: [{ horizon: "short", description: "争取停机检查", priority: 3, reason: "担心仓促开机" }],
      },
      quest: { name: "回应停机请求", description: "与林舟商量如何处理眼前分歧。", objective: { kind: "talk_to_opening_npc" } },
      situation: {
        history: [{ key: "worked_together", factKeys: ["fact_past"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: [] }],
        threads: [{ key: "shutdown", questionFactKey: "fact_request", supportingFactKeys: ["fact_records", "fact_secret"], participantRefs: ["player", "opening_npc"], causeHistoryKeys: ["worked_together"] }],
        npcConnection: { familiarity: "known", stance: "neutral", basisHistoryKeys: ["worked_together"] },
        responses: [
          { key: "ask_records", dialogueAct: "ask", topic: { kind: "fact", key: "fact_records" } },
          { key: "refuse_shutdown", dialogueAct: "refuse", topic: { kind: "thread", key: "shutdown" } },
        ],
      },
    },
  };
}
```

配套当前场景使用 `segments:[{beatId:"opening",text:"林舟把维修记录摊在工作台上，等你回应。"}]`，NPC line 为“我想先停机检查。你愿意先听听我的顾虑吗？”，emotion=guarded，usedFactIds=[fact_1,fact_2]，usedEventIds=[]，answeredBeatIds=[]；choice label 分别为“先把维修记录给我看看。”“我现在不能答应停机，你先说清顾虑。”，candidateId 与 responses.key 一致，objectiveLink=null，continuationScenes=[]，terminal=current_scene。这里 usedFactIds 是服务端已有顺序约定，不允许新增自定义 ID。

### Task 1：首轮情境候选与 Action 编译

**Files:**
- Create: `src/game/domain/openingSituation.ts`、`src/game/domain/openingSituation.test.ts`
- Create: `src/game/gameplay/rpg/openingGeneration/openingSituationRules.ts`、同名 `.test.ts`
- Create: `src/game/domain/openingSituation.testutil.ts`
- Modify: `src/game/domain/openingGenerationCandidate.ts`、同名 `.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts`、同名 `.test.ts`、`index.ts`
- Modify: `src/game/application/createGame.ts`、同名 `.test.ts`
- Modify: `src/game/application/server/ai/openingGenerationSource.ts`、同名 `.test.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.ts`、同名 `.test.ts`

**Interfaces:**
- 新增 `parseOpeningSituation(value: unknown): OpeningSituationProposal | null`，类型逐字采用 Spec。
- 新增 `resolveOpeningResponses(candidate: OpeningGenerationCandidate): readonly { candidateId: string; action: TalkAction }[] | null`，从 openingGeneration facade 导出；成功返回恰好两项，失败返回 null。
- candidate 中必填 situation；由 Spec key 约定解析 player/npc/fact/thread，不让 provider 提交 Action。

- [x] **Step 1：建立最小合法候选和失败测试。** 在 `openingSituation.test.ts` 导入上述 helper；明确循环引用、非法 act、unknown keys、上限和缺字段均拒绝。

```ts
const candidate = makeOpeningQualityCandidate();
expect(parseOpeningSituation(candidate.opening.situation)).not.toBeNull();
expect(parseOpeningSituation({ ...candidate.opening.situation, injectedEffect: 99 })).toBeNull();
expect(parseOpeningSituation({ ...candidate.opening.situation, responses: [] })).toBeNull();
```

- [x] **Step 2：执行红灯。** `npx vitest run src/game/domain/openingSituation.test.ts src/game/gameplay/rpg/openingGeneration/openingSituationRules.test.ts`；新增模块缺失应失败，记录实际失败原因。
- [x] **Step 3：实现结构与引用校验。** exact-key、数量、非空、局部 key 唯一、history 拓扑顺序、fact 引用存在、公开目标、known/private 不交叉、关系 basis 完整；结构错误不机械补 situation。`resolveOpeningResponses` 以事实数组顺序映射 fact ID，以 `thread_init_<key>` 映射 thread ID，使用 `semanticSummaryOf` 拒绝重复 Action。

```ts
const choices = resolveOpeningResponses(makeOpeningQualityCandidate());
expect(choices?.map(c => c.action.dialogueAct)).toEqual(["ask", "refuse"]);
expect(choices?.[1]?.action.topic).toEqual({ kind: "thread", threadId: "thread_init_shutdown" });
```

- [x] **Step 4：替换首轮 support/challenge 硬编码。** `compileOpeningNarrative` 按已验证 responses 匹配 currentScene candidateId，拒绝缺项、额外项和重复；逐项通过原 `createApprovedChoice` 生成 registry。保留顶层四字段、ready scene、speech 审批与原子创建。旧 repair/normalizer 只能保留字段，不补默认 situation；fixture source 显式产出新的 situation 和一致 choices。
- [x] **Step 5：测试同 act 不同 topic。** 两项 ask 分别指向 fact_records 与 thread_shutdown 应通过且 token 不同；两项 ask 指向同 fact，即使 key/label 不同也拒绝；秘密 topic 拒绝；label 不能变成规则依据。
- [x] **Step 6：运行定向测试及 typecheck。** `npx vitest run src/game/domain/openingGenerationCandidate.test.ts src/game/domain/openingSituation.test.ts src/game/gameplay/rpg/openingGeneration src/game/application/createGame.test.ts src/game/application/server/ai/openingGenerationSource.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts`；`npm run typecheck`。更新受影响测试候选，不能添加生产默认值换取旧测试通过。
- [x] **Step 7：提交可审查单元。** `git add` 只选本 Task 文件；`git commit -m "feat: compile contextual opening responses"`。

### Task 2：背景事件与 NPC 初始关系

**Files:**
- Modify: `src/game/domain/events.ts`、`eventPayloadValidation.ts`、`eventLedger.ts`、相关 `.test.ts`
- Modify: `src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts`、同名 `.test.ts`
- Modify: `src/game/gameplay/rpg/npcMemory/index.ts`（仅在 seed policy 尚未导出时添加 facade 导出）
- Modify: `src/game/domain/episodicMemory.ts`、同名 `.test.ts`

**Interfaces:**
- 新 payload 的完整字段见 Spec；事件 envelope 沿用 `NarrativeEventDraft`。
- 扩展 `commitInitializationEvent` 输入 `backgroundDrafts?: readonly NarrativeEventDraft[]`；仍返回原 `EventCommitResult`，helper 将 game_initialized 与 backgroundDrafts 一次提交，不允许背景 draft 重复 game_initialized key。
- compiler 成功产出带初始化事件的 WorldState 与由完整 ledger 重建的 memory；不更改返回类型。

- [x] **Step 1：增加行为测试。** 从统一候选编译；history/thread 必须出现在 init episode、turn=0，thread cause 指向 history，history factIds 指向 fact_0，内存重建一致。

```ts
const history = compiled.worldState.eventLedger.find(e => e.kind === "opening_history_established")!;
const thread = compiled.worldState.eventLedger.find(e => e.kind === "opening_thread_established")!;
expect(thread.causeEventIds).toContain(history.eventId);
expect(thread.turnNumber).toBe(0);
expect(compiled.storyState.memory).toEqual(rebuildEpisodicMemory(compiled.worldState.eventLedger));
```

这里 `compiled` 使用现有 compile 测试的 generation/initialNarrative 固定输入，candidate 替换为 `makeOpeningQualityCandidate()`；不创建第二个 compiler helper。

- [x] **Step 2：红灯运行。** `npx vitest run src/game/domain/eventLedger.test.ts src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.test.ts`。
- [x] **Step 3：提交闭合背景。** 按 Spec 顺序建 draft，participant ref 映射已铸造实体，facts/causeKeys 均走既有验证；ledger 的类型集合、payload parser、event union 全部同步。episodeKind 将两个新增 kind 识别为 initialization。非法因果返回稳定错误，不部分提交。
- [x] **Step 4：用已批准背景初始化 NPC。** known/neutral 使用 acquainted，stranger/neutral 使用 unknown；其余姿态读取现有 `INITIAL_RELATIONSHIP_SEED_POLICY` 的 dimensions/stage，保留单向 edge、initial_world 来源，无伪造 action evidence。`met` 同步 familiarity；emotion 使用已批准 currentScene.npcLine.emotion。编译器不接收裸关系数值。
- [x] **Step 5：增加相反关系与边界验证。** stranger+ally 拒绝；known 无公开 basis 拒绝；已认识 NPC 不出现首次相识规则事件；rival 和 ally 的关系值分别等于已有 policy；所有姿态不会自动产生承诺或知识传播。
- [x] **Step 6：定向绿灯与提交。** `npx vitest run src/game/domain/eventLedger.test.ts src/game/domain/episodicMemory.test.ts src/game/gameplay/rpg/openingGeneration`；`npm run typecheck`；`git commit -m "feat: establish opening history and relationships"`（先逐项 add 本 Task 文件）。

### Task 3：持久化与安全历史召回

**Files:**
- Modify: `src/game/domain/worldState.ts`、同名 `.test.ts`
- Modify: `src/game/application/server/persistence/worldStatePersistenceValidation.ts`、同名 `.test.ts`
- Modify: `src/game/application/server/persistence/storyStatePersistenceValidation.ts`、同名 `.test.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`
- Modify: `src/game/gameplay/rpg/narrativeMemory/renderNarrativeMemory.ts`、同名 `.test.ts`
- Modify: `src/game/gameplay/rpg/narrativeMemory/retrieveNarrativeMemory.test.ts`

**Interfaces:** 原仓储、memory 类型不变；新增事件卡对公开 fact 渲染正文，secret 继续过滤。`parsePersistableStoryState` 继续从输入 ledger 重建对比，不独立接受摘要。

- [x] **Step 1：先写重载和泄密失败测试。** 保存统一候选编译结果，reload 后比较 EntityStore、ledger、memory、registry 的深度一致；将 background fact ID 改成不存在的值后拒绝；将 memory 改成与 ledger 不一致后拒绝。
- [x] **Step 2：运行红灯。** `npx vitest run src/game/application/server/persistence/worldStatePersistenceValidation.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts src/game/gameplay/rpg/narrativeMemory/renderNarrativeMemory.test.ts`。
- [x] **Step 3：升级世界版本。** WorldState schema 6，已知 5 加入 UNSUPPORTED_RECORD；更新当前数据构造、snapshot、SQLite 分类与测试常量。旧数据拒绝不能导致 current pointer 被清除。StoryState shape 8 和 memory 1 不改，仅修正过时注释与事件验证调用。
- [x] **Step 4：渲染有实际意义的历史。** 新事件卡按 safeFactIds 输出公开正文与 eventId/causeEventIds，标注“开局时已成立”；thread 只输出公开 question 和公开 supporting facts。所有事实读取当前 EntityStore，不能照搬任意历史 summary 原文。

```ts
expect(renderedText).toContain("主角过去曾与船厂技师共同维修引擎");
expect(renderedText).not.toContain("技师私自隐去了上次维修失误");
expect(renderedText).not.toContain("fact_secret");
```

`renderedText` 在原 renderNarrativeMemory 测试装配中连接返回的 requiredEventsText/relevantEventsText；候选使用统一 fixture，不仅检查孤立字符串 helper。

- [x] **Step 5：验证正常失败语义。** 初始语音引用不合法、重复语义选项、event 引用损坏时整局不写回；生成失败不会替换已有 current game。首次回合 CAS 失败不得补写背景或选择事件。
- [x] **Step 6：测试与提交。** `npx vitest run src/game/application/server/persistence src/game/gameplay/rpg/narrativeMemory src/game/domain/worldState.test.ts`；`npm run typecheck`；`git commit -m "feat: persist and recall grounded opening history"`（只 stage 本 Task 文件）。

### Task 4：完整玩家输入与情境导向的生产 prompt

**Files:**
- Create: `src/game/application/server/ai/openingNarrativePrompt.ts`、同名 `.test.ts`
- Modify: `src/game/application/server/ai/liveNarrativeBundleSource.ts`、同名 `.test.ts`
- Modify: `src/game/application/testing/openingNoveltyJourney.test.ts`

**Interfaces:**

```ts
export function buildOpeningNarrativePrompt(
  context: Extract<NarrativeBundleSourceContext, { kind: "opening" }>,
): string;
```

唯一调用点为 liveNarrativeBundleSource 的 opening 分支。原 `buildOpeningPrompt` 从该文件移走，不再保留两套生产定义；旧 openingGenerationSource 不成为生产 fallback。

- [x] **Step 1：写 transport 输入回归。** 通过 mock aiClient.complete 捕获实际 messages，输入 characterProfile=“曾在船厂修理引擎。”、personalityTags=[冷静,多疑]、cinematic、dark，recent 中提供“上次为码头商人交接清单”。验证所有内容真实进入请求；缺 setup 仍能生成合法指令。

```ts
expect(prompt).toContain("曾在船厂修理引擎");
expect(prompt).toContain("冷静");
expect(prompt).toContain("cinematic");
expect(prompt).toContain("dark");
expect(prompt).toContain("上次为码头商人交接清单");
expect(complete).toHaveBeenCalledTimes(1);
```

- [x] **Step 2：红灯运行。** `npx vitest run src/game/application/server/ai/openingNarrativePrompt.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts`。
- [x] **Step 3：实现单一 prompt。** `buildStylePolicy(input.setup)` 提供风格与强度；完整传递 profile；novelty 取最近 3 项、输出 attempt，明确设定优先。描述 situation 结构、公开权限和 responses 映射；使用结构示例，不使用固定客栈/证物剧情。输出依然是 opening/currentScene/continuationScenes/terminal；首场景 emotion 说明完整枚举，示例不成为唯一情绪。
- [x] **Step 4：写生成任务的具体要求。** 文本采用：“先确立与玩家开端一致的已发生事实，写出焦点 NPC 此刻的诉求与阻碍，再让首场景停在需要玩家回应的位置。两项回应分别绑定已有 dialogueAct 和公开 fact/thread；不得在序幕或 NPC 台词中宣称玩家已接受其中一项。结局 theme 仅表达开放价值方向。”不得要求每局秘密、倒计时、背叛或反转。
- [x] **Step 5：更新输出解析测试。** 合法 situation 一次解析成功；unknown key、missing situation、非法 response 引用返回失败，不能由 normalizer 修补剧情；novelty retry 保留 setup 并获得被拒候选摘要，不重复空调用。
- [x] **Step 6：测试与提交。** `npx vitest run src/game/application/server/ai/openingNarrativePrompt.test.ts src/game/application/server/ai/liveNarrativeBundleSource.test.ts src/game/application/testing/openingNoveltyJourney.test.ts`；`npm run typecheck`；`git commit -m "feat: generate openings from player context"`（只 stage 本 Task 文件）。

### Task 5：首次选择到下一次 API 的闭环

**Files:**
- Create: `src/game/application/server/ai/narrativeContext/openingHandoffContext.ts`、同名 `.test.ts`
- Create: `src/game/application/testing/openingQualityJourney.test.ts`
- Modify: `src/game/application/server/ai/narrativeContext/narrativeBundleContext.ts`、同名 `.test.ts`
- Modify: `src/game/application/performTurn.test.ts`
- Modify: `src/game/application/performTurn.ts`（仅在测试证明既有 act/topic/label 通道遗漏时修复）

**Interfaces:**

```ts
export function buildOpeningHandoffContext(input: Readonly<{
  worldState: WorldState;
  job: PendingNarrativeJob;
}>): Readonly<{
  requiredEventIds: readonly EventId[];
  publicText: string;
}> | null;
```

首轮不存在初始化事件或 turnNumber!=1 返回 null；该接口只投影与检索，不更改状态。现有 compileDecisionNarrativeContext 将 refs 合入 retrieveNarrativeMemory 所需事件，文本纳入公开 mandatory block；不把完整 eventLedger 放进 prompt。

- [x] **Step 1：建立完整离线旅程。** createGame 使用 fixture bundle source；原路径结束序幕；clone 同一批准状态到两份独立内存仓储。通过真正 choice token 执行各自选项，再捕获 decision source context 与实际编译 messages；不能手写 PendingNarrativeJob 代替旅程。
- [x] **Step 2：写两个方向断言并确认红灯。** `npx vitest run src/game/application/testing/openingQualityJourney.test.ts`。

```ts
expect(firstJob.selectedDialogue?.dialogueAct).toBe("ask");
expect(secondJob.selectedDialogue?.dialogueAct).toBe("refuse");
expect(secondJob.selectedDialogue?.topic).toEqual({ kind: "thread", threadId: "thread_init_shutdown" });
expect(secondPrompt).toContain("主角过去曾与船厂技师共同维修引擎");
expect(secondPrompt).toContain("我现在不能答应停机");
expect(secondPrompt).not.toContain("技师私自隐去了上次维修失误");
```

firstJob/secondJob 为两份 source 捕获的真实 decision job；secondPrompt 为其 compileDecisionNarrativeContext 输出。具体取值方式沿现有 source spy，不另外定义业务装配路径。

- [x] **Step 3：按已批准 topic 召回。** thread topic 查 `opening_thread_established`，追溯 causeEventIds；fact topic 查关联 thread/history；没有 topic（自由输入）按焦点 NPC 取有界公开初始化记录。只读取事件 refs 和当前 store，除公开 fact 外不渲染任意历史正文；首次 handoff 明确选择是意图，结果来自 mandatory beats。
- [x] **Step 4：覆盖边界。** 同 act 不同 topic 的两条旅程 token 不冲突且 job.topic 不同；refuse 不自动 give_item/move；免费文本原话走现有通道；错误 token/CAS 失败零写入；同 job 重试不重复 history；turn=2 不再强制注入开局块；大输入仍满足 8,000 token 预算，required refs 不被静默丢弃。
- [x] **Step 5：隔离既有节奏字段。** 断言初始化 thread ID 不写进旧 unresolvedThreads；首轮 task 完成不会让新背景材料从 handoff 丢失；不通过增加 currentAct 或改任务目标来强迫分支。
- [x] **Step 6：完整离线验收与提交。** `npx vitest run src/game/application/testing/openingQualityJourney.test.ts src/game/application/performTurn.test.ts src/game/application/server/ai/narrativeContext`；`npm run typecheck`；`npm run test:boundaries`；`git commit -m "feat: carry opening causality into first decision"`（只 stage 本 Task 文件）。

### Task 6：真实样本评审、文档与收尾

**Files:**
- Create: `src/game/application/testing/openingQuality.live.test.ts`
- Create during execution: `docs/superpowers/reports/2026-09-09-opening-quality.md`
- Modify after implementation: `docs/策划文档/AI生成RPG_MVP.md` 第 4/6 节
- Modify after implementation: `docs/agent/运行时AI导演与场景表演.md`、`剧情连续性与结构化记忆.md`、`NPC人格知识与关系图.md`、`实体与组件世界状态.md`

**Interfaces:** live 测试使用现有 server composition 的 AI 配置装配、生产 source 和 approval；注入隔离 SQLite 仓储与 current pointer，不连接正在玩的 slot。`RPG_OPENING_QUALITY_LIVE=1` 是新测试的显式门禁，`it.skipIf(process.env.RPG_OPENING_QUALITY_LIVE !== "1")`；默认 `npm test` 不产生网络请求。

- [x] **Step 1：先验证默认跳过。** `npx vitest run src/game/application/testing/openingQuality.live.test.ts` 应明确显示 skipped。创建测试前定向阅读 [AI 环境](../../agent/AI环境.md) 和 [AI 文本审计](../../agent/AI文本审计.md)；从已有 composition 读取配置，不复制 key 或新增配置来源。
- [x] **Step 2：固定六组输入。** 每组都使用 valid GameSetup，短篇，seed 分别为 `opening-quality-<序号>-a`/`-b`；世界和开端按下表逐字构造，身份、姓名、风格按表传入，普通强度，性格仅取已有合法标签。

| 组 | 类型、主角、身份、风格 | 世界前提 | 故事开端 |
|---|---|---|---|
| 1 | wuxia；沈砚；返乡郎中；novel | 山城的诊所共同储备药材，街坊依赖行医者互相协助维持日常诊治。 | 你回乡探亲时得知旧识为救治病人私自取药，旧识正在等你回应负责人对缺药的追问。 |
| 2 | science_fiction；陆宁；空间站维修员；cinematic | 民用空间站依靠定期停机检修维持运转，各班组需要协商有限的维修时段。 | 你接班时，同班技师要求延长停机检查，但货运安排即将受到影响，他请你回应这一请求。 |
| 3 | urban；周禾；社区店主；concise | 老城区的商户共同使用装卸通道，邻里通过协商解决日常经营中的空间分配。 | 相熟店主希望借用你店门前的空地接货，你的开门准备也因此受影响，对方正在等你答复。 |
| 4 | fantasy；黎安；学徒修复师；novel | 城市依靠公共工坊维护照明器具，工匠按约定轮值，居民重视节庆前的修复工作。 | 师傅请你回应一项临时加班安排，而你已计划回家照顾家人，他希望先听你的想法。 |
| 5 | post_apocalypse；许川；聚落炊事员；concise | 灾后聚落统一分配饮水和食物，每个轮值岗位都要说明当天的资源使用情况。 | 熟悉的值守员希望临时调整晚餐供水，你担心影响做饭，他当面询问你愿意如何安排。 |
| 6 | alternate_history；顾言；账房学徒；cinematic | 河港作坊靠行会协调订单，账房记录工钱和交货时间，师徒共同承担记账责任。 | 你的师兄要求先按旧账发放工钱，可你发现记录有一处不一致，他等你说明是否照办。 |

表中类型 ID 已对照现有 `newGame` 枚举。运行前对全部 setup 调用生产输入 validator，拒绝失效输入，不增加新题材。

- [x] **Step 3：执行真实创建与续接。** `RPG_OPENING_QUALITY_LIVE=1 npx vitest run src/game/application/testing/openingQuality.live.test.ts`。12 次创建＋其中 3 组双选择续接 6 次；每次使用独立仓储，双选择从相同已批准状态分叉。读取审计 runId/trace/job，记录实际 transport/retry 数；失败不得被吞掉。未配置环境时保留未完成状态，不写质量通过。
- [x] **Step 4：按 Spec 人工打分。** 每个成功开局五维评分和简短原文证据；跨样本归类结构；每个续接对照所选 label、Action、结果事件与 NPC 回应。报告记录模型配置中的非秘密标识、成功率、重试、所有失败、阈值结论及样本路径；不要在当前系统文档写成绩。拒绝/失败样本也进入分母，不反复采样直到碰到好故事。
- [x] **Step 5：事实归属更新。** 玩家规则写开场体验和选择语义；运行时文档写唯一生产 prompt 和 handoff；记忆文档写新增背景事件与“线程种子无完整生命周期”；NPC 文档写 initial connection；实体文档写 WorldState 6 及旧版处理。修改既有章节，不追加日期补丁。没有新增系统文档或阅读职责变化，不改索引。
- [x] **Step 6：最终检查。** `npm run typecheck`、`npm run test:boundaries`、`npm run check:docs`、`npm test`、`git diff --check`。本轮若修改测试脚本/配置或规范门禁，再执行 `npm run test:fast`；没有脚本变更不无端扩展门禁。真实质量评审不能用上述离线成绩替代。
- [x] **Step 7：提交与安全合入。** 记录实际测试结果、未满足项；确认 worktree clean 后提交本 Task 文件。后续实施统一使用 `codex/opening-context` 分支与 `.worktrees/opening-context` 工作区；用户授权合入时，从主仓 main 运行 `npm run branch:merge -- codex/opening-context`。已完成本分支实施与提交，未执行合入。

## 验收清单与覆盖映射

| 需求 | 交付任务 | 验收证据 |
|---|---|---|
| 完整玩家配置、设定优先于去重 | 4、6 | 实际 AI messages＋12 次创建评审 |
| 初始历史有来源，可重载可召回 | 2、3 | ledger 因果、SQLite reload、公开正文 |
| 当前局面不维护第二份权威摘要 | 2、5 | EntityStore 投影、hand off 只读测试 |
| 既有关系不强制陌生 | 2、6 | familiarity、seed policy、人物一致性评分 |
| 首轮可超出 support/challenge | 1、5 | ask/refuse 及同 act 不同 topic token/事件 |
| 后续调用知道所选意图与原因 | 5、6 | 首轮旅程捕获＋6 次真实续接 |
| 秘密与数值权限不被绕过 | 1、3、5 | 非法引用拒绝、secret sentinel 不入 prompt |
| 不预先替玩家承诺或安排路线 | 4、6 | prompt 契约＋人工文本评审 |
| 失败和重试不污染当前游戏 | 3、5 | current pointer、CAS、同 job 重试测试 |

## Plan 自审与执行状态

- Task 1–6 已在指定 worktree 实施，阶段指针未改；全分支独立审查及收尾修复定向复审通过。
- 新类型、key、事件 payload 和版本决策在 Spec 唯一详细维护，Task 使用同名接口。
- 已将“初始化线程种子”与未实现的动态生命周期区分；不会把背景问题永久当作当前问题。
- 已区分逻辑生成请求、transport 重试与真实样本质量；只通过工程检查不能宣称质量目标达成。
- 实际 RED/GREEN、真实调用、逐样本评分与前轮失败证据见[验收报告](../reports/2026-09-09-opening-quality.md)。
- 最终门禁：`npm run typecheck`、`npm run test:boundaries`（124 项）、`npm run check:docs`（34 份）、`npm test`（2,564 通过，live 默认跳过）、`git diff --check`。真实最终批次 12/12 创建、6/6 续接通过，最低 9/10，全部强制维度 2/2。
