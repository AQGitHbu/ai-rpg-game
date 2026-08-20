# 调查选择场景重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox - [ ] syntax for tracking.

**Goal:** 移除没有决策内容的“一键调查”回合：只有一条必经线索时由规则自动揭示；存在多种调查方式时，让玩家选择调查方法，并以可见、可持久化的张力与证据质量差异形成代价和后果。

**Architecture:** 保留 discover_fact 主线目标和 fact_discovered 规则事件作为事实裁决核心，在 WorldFactEntry 上增加可选的、经过生成审批的 investigationApproaches。有选项的事实由同一个 investigate Action 携带 approachId，服务端通过 opaque choice token 投影；没有选项的事实不投影按钮，而是在地点抵达/主线交接的规则边界自动揭示一次。调查选项不复用 NPC 对话选项：询问 NPC 是未来可加入的调查方式，第一版先实现现场检查/追踪/冒险取证等固定场景选项。

**Tech Stack:** TypeScript, React, Next.js, SQLite JSON 存档, Vitest

## Global Constraints

- 保留 discover_fact objective、fact_discovered event、单次规则 CAS 和独立 scene CAS；不得通过 narration 文本直接完成任务。
- 客户端只能提交服务器下发的 opaque choiceToken；不得提交 factId、approachId、cost 或 consequence。
- 调查选项的 label/hint 不得泄漏事实正文；完整事实只在行动成功后的场景叙事和已发现事实卡中出现。
- 单一必经事实自动揭示最多推进一个当前 discover_fact objective；不得因自动路径固定点级联跳过后续 talk、move、item 或 battle 目标。
- 调查分支必须可完成：所有合法 approach 都完成当前事实目标；差异通过结构化 evidence quality、tension 变化和调查记录体现，不能制造不可恢复的软锁。
- 旧存档允许破坏性 schema 重建，不提供迁移；缺少 investigationApproaches 的事实按“无选项、自动揭示”处理。
- 保持 AI 不可用时的确定性 fallback；AI 只能提案调查提示，不能凭空创建未审批事实、地点、NPC 或任务效果。
- 生产 API、无版本后缀命名、短篇/中篇预算和现有六个 /api/game/** route 不变。
- 自动揭示一律在规则层完成（当前开局契约只保留 NPC 已知事实；运行时由 ruleEngine/resolveTurn 在一次行动的任务 reconciliation 边界处理），fact_discovered 事件必须写入 eventLedger；generatePendingScene 等场景写回只消费规则结果做叙事，不得再次裁决事实、不得修改 tension。reload 只恢复已经结算的结果；若旧状态尚未经过这个规则边界，回归 fixture 必须先执行一个能暴露该事实的成功 action，不能把场景 ensure 当成第二个裁决入口。
- 同一地点存在多个未发现事实时，只投影当前 discover_fact 主线目标对应事实的调查方式；非目标事实不投影行动按钮（避免行动栏被多事实 × 多 approach 挤爆）。

---

## 玩家规则与边界

### 调查场景的三种状态

1. **无选择事实**：当前地点只有一条必经事实，进入地点或完成 NPC 交接时规则自动发现；玩家看到“发现了什么、接下来为什么去那里”的场景反馈，不看到“调查”按钮。
2. **有选择事实**：当前地点存在 2–3 个已审批调查方式。每个方式都有不同的行动语义，例如“沿脚印追查”“检查被撬门锁”“向附近摊贩打听”，点击即提交一次正式回合。
3. **NPC 对话调查**：不在本计划中把普通 talk 选项改名为调查。NPC 的 support/challenge/free input 仍是社交行动；未来若需要“套话/质问/交换情报”，再以带 targetNpcId 的调查方式单独建模。

### 第一版代价与后果

每个 approach 由规则数据声明：

    type InvestigationApproach = {
      readonly approachId: string;
      readonly label: string;
      readonly hint?: string;
      readonly evidenceQuality: "clean" | "noisy";
      readonly tensionDelta: number;
    };

选项都发现同一个权威事实，但 clean / noisy 与 tensionDelta 必须写入 fact_discovered 事件并进入故事张力。场景反馈明确说明“证据较完整/现场留下动静”等结果；后续 NPC/结局上下文可读取该结构化记录。第一版不借调查选项直接生成未审批地点或跳过主线目标。

计划中的测试片段使用以下本地 fixture helper；实现对应任务时必须在测试文件顶部定义它们，而不是依赖生产代码中的隐式全局：

    function worldWithApproaches(): WorldState;
    function worldWithApproachlessFact(): WorldState;
    function storyWithDiscoverFact(): StoryState;
    function candidateWithApproaches(input: { text: string; approaches: readonly InvestigationApproach[] }): OpeningGenerationCandidate;
    function deterministicGeneratedFactFor(gameType: string): WorldFactEntry;
    function viewWithInvestigationApproaches(): GameSessionView;
    function createInvestigationChoiceJourney(input: { mode: "offline" | "legacy_fact" }): Promise<InvestigationChoiceJourney>;
    type InvestigationChoiceJourney = {
      view(): GameSessionView;
      record(): GameRecord;
      choose(label: string): Promise<void>;
      exposeLegacyFact(): Promise<void>;
      reload(): Promise<void>;
    };

## 文件地图

- src/game/domain/worldState.ts、src/game/domain/worldDelta.ts、src/game/domain/openingGenerationCandidate.ts：事实调查方式的权威结构与生成提案结构。
- src/game/domain/action.ts、src/game/domain/events.ts、src/game/domain/storyState.ts、src/game/domain/approvedChoice.ts：调查 Action、发现事件字段、schema 版本、token/语义摘要契约和自动揭示边界。
- src/game/gameplay/rpg/ruleEngine/validateAction.ts、resolveByType.ts、index.ts、updateStoryMetrics.ts：approach 合法性、自动揭示插入点、代价、事件和张力结算。
- src/game/gameplay/rpg/openingGeneration/*、src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts、src/game/application/server/ai/liveWorldEvolutionSource.ts、src/game/application/deterministicEvolutionBeats.ts：生成、校验、审批与离线 fallback。
- src/game/application/performTurn.ts、src/game/application/buildChoiceMap.ts、src/game/application/gameSessionView.ts：自动揭示、opaque token 和调查选项读模型。
- src/game/application/sceneGenerationContext.ts、src/game/application/deterministicSceneSource.ts、src/game/application/generatePendingScene.ts：调查结果叙事和自动路径的场景写回。
- src/components/LocationSceneScreen.tsx、src/components/AdventureGameShell.tsx：调查方式按钮、无选择事实的无按钮状态和结果展示。
- src/game/application/*test.ts、src/game/gameplay/rpg/**/*test.ts、src/components/*test.tsx、src/game/application/testing/investigationChoiceJourney.test.ts：规则、投影、UI、reload 和完整旅程回归。
- docs/策划文档/AI生成RPG_MVP.md、docs/agent/行动裁决.md、docs/agent/探索与任务推进.md、docs/agent/地图与地点冒险.md：同步玩家规则和实现事实。

---

### Task 1: 建立调查方式与事件数据契约

**Files:**
- Modify: src/game/domain/worldState.ts
- Modify: src/game/domain/worldDelta.ts
- Modify: src/game/domain/openingGenerationCandidate.ts
- Modify: src/game/domain/action.ts
- Modify: src/game/domain/events.ts
- Modify: src/game/domain/storyState.ts
- Modify: src/game/domain/approvedChoice.ts
- Test: src/game/domain/worldState.test.ts
- Test: src/game/domain/events.test.ts
- Test: src/game/domain/action.test.ts
- Test: src/game/domain/storyState.test.ts
- Test: src/game/domain/approvedChoice.test.ts
- Test: src/game/domain/openingGenerationCandidate.test.ts

**Interfaces:**
- Produces InvestigationApproach with approachId, safe label/hint, evidenceQuality and bounded tensionDelta.
- Extends WorldFactEntry.investigationApproaches and matching WorldDeltaProposal.newFact / opening candidate shape.
- Extends Action investigate to include optional approachId; approachId is never client-authored outside a server-issued choice token.
- Extends FactDiscoveredEvent with optional approachId, evidenceQuality and tensionDelta.
- Extends approvedChoice 的 token/semantic summary 派生以携带 approachId：同 fact 不同 approach 必须铸造出互不相同的 runtime token。

- [ ] **Step 1: 编写失败测试**

    it("accepts a bounded investigation approach without exposing fact text", () => {
      const fact = {
        factId: asFactId("fact_trace"),
        text: "完整事实正文",
        source: "generated" as const,
        discovered: false,
        investigationLabel: "泥地上的异常痕迹",
        investigationApproaches: [
          { approachId: "follow", label: "沿痕迹追查", evidenceQuality: "clean" as const, tensionDelta: 4 },
          { approachId: "search", label: "翻查附近杂物", evidenceQuality: "noisy" as const, tensionDelta: 12 },
        ],
      };
      expect(fact.investigationApproaches).toHaveLength(2);
      expect(fact.investigationApproaches?.[0]?.label).not.toContain(fact.text);
    });

    it("records approach metadata on fact_discovered without requiring it for auto discovery", () => {
      const event = {
        type: "fact_discovered" as const,
        factId: asFactId("fact_trace"),
        occurredAt: "t1",
        approachId: "follow",
        evidenceQuality: "clean" as const,
        tensionDelta: 4,
      };
      expect(event.evidenceQuality).toBe("clean");
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/domain/worldState.test.ts src/game/domain/events.test.ts src/game/domain/action.test.ts src/game/domain/storyState.test.ts src/game/domain/approvedChoice.test.ts src/game/domain/openingGenerationCandidate.test.ts

Expected: FAIL because the new approach fields and event metadata are not defined.

- [ ] **Step 3: 实现最小契约**

1. 在 worldState.ts 导出 InvestigationApproach，限制 tensionDelta 的合法范围为 -5..20，并将 investigationApproaches 设为可选以兼容旧记录读取。
2. 在 worldDelta.ts 和 openingGenerationCandidate.ts 复用同一类型，不创建第二份 shape；openingGenerationCandidate.world.publicFacts 的每个条目增加可选 investigationApproaches，编译器必须逐条复制到对应 WorldFactEntry。
3. 在 action.ts 只增加可选 approachId，不增加新的公开 route 或客户端 Action 类型。
4. 在 events.ts 为 FactDiscoveredEvent 增加可选结构化结果字段；旧事件缺省时 evidenceQuality 按 clean 读取，tensionDelta 按 0 的“额外张力”读取，以便保留既有 fact_discovered 的基础张力。
5. 将 STORY_STATE_SCHEMA_VERSION 从 3 提升到 4，明确旧版本不迁移；在所有 createInitialStoryState/record default 组合处保留空 approach 兼容行为。
6. 在 approvedChoice.ts 的 rebuildAction / semanticSummaryOf / serializeAction 三处同步携带 approachId，保证同 fact 不同 approach 的 runtime token 与语义摘要不碰撞（否则 Task 4 投影时第二个按钮的 token 会与第一个相同而被去重）。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/domain/worldState.test.ts src/game/domain/events.test.ts src/game/domain/action.test.ts src/game/domain/storyState.test.ts src/game/domain/approvedChoice.test.ts src/game/domain/openingGenerationCandidate.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/domain/worldState.ts src/game/domain/worldDelta.ts src/game/domain/openingGenerationCandidate.ts src/game/domain/action.ts src/game/domain/events.ts src/game/domain/storyState.ts src/game/domain/approvedChoice.ts src/game/domain/worldState.test.ts src/game/domain/events.test.ts src/game/domain/action.test.ts src/game/domain/storyState.test.ts src/game/domain/approvedChoice.test.ts src/game/domain/openingGenerationCandidate.test.ts
    git commit -m "feat(investigation): define approach and evidence outcome contracts"

---

### Task 2: 生成与审批调查方式，补齐离线 fallback

**Files:**
- Modify: src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts
- Modify: src/game/gameplay/rpg/openingGeneration/compileOpeningGenerationCandidate.ts
- Modify: src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts
- Modify: src/game/application/server/ai/liveWorldEvolutionSource.ts
- Modify: src/game/application/deterministicEvolutionBeats.ts
- Modify: src/game/application/deterministicEvolutionSource.ts
- Modify: src/game/application/server/persistence/sqliteGameRepository.ts
- Test: src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts
- Test: src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts
- Test: src/game/application/server/ai/worldEvolutionSource.test.ts
- Test: src/game/application/deterministicEvolutionBeats.test.ts
- Test: src/game/application/server/persistence/sqliteGameRepository.test.ts

**Interfaces:**
- Consumes AI/fallback newFact.investigationApproaches proposals.
- Produces approved facts where every approach has a unique ID, safe label, bounded tension delta, one of two evidence qualities, and no fact/unknown-entity text leak.
- Produces deterministic two-approach fallback for newly generated facts; facts without an approved approach list remain auto-discoverable.

- [ ] **Step 1: 编写失败测试**

    it("rejects duplicate approach ids, out-of-range tension and labels containing fact text", () => {
      const result = validateOpeningGenerationCandidate(candidateWithApproaches({
        text: "密道入口在井下",
        approaches: [
          { approachId: "a", label: "密道入口在井下", evidenceQuality: "clean", tensionDelta: 4 },
          { approachId: "a", label: "检查井沿", evidenceQuality: "noisy", tensionDelta: 40 },
        ],
      }), { gameLength: "short", targetActs: 3 });
      expect(result.ok).toBe(false);
    });

    it("fallback creates two distinct safe approaches from the genre vocabulary for a generated fact", () => {
      const fact = deterministicGeneratedFactFor("wuxia");
      const labels = fact.investigationApproaches?.map((entry) => entry.label) ?? [];
      expect(labels).toHaveLength(2);
      expect(new Set(labels).size).toBe(2);
      expect(labels.every((label) => label !== "" && !label.includes(fact.text))).toBe(true);
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/deterministicEvolutionBeats.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts

Expected: FAIL because generated facts do not yet carry or validate approach lists.

- [ ] **Step 3: 实现解析与审批**

1. 在 opening/world-evolution proposal parser 中解析 investigationApproaches：显式非空列表必须恰好 2–3 条，1 条或超过 3 条按非法列表处理并降为空列表；同时拒绝数组以外的值、重复 approachId、空 label/hint、非 clean|noisy、tensionDelta 超出 -5..20 的条目。label/hint 泄漏判定采用两级：**完整事实正文子串命中 = 硬拒绝**（防 AI 抄全文）；仅与正文关键名词重合 = 软处理，将该条降级为题材词库的 generic label 并记录稳定日志分类 `investigation_label_overlap`，不拒绝整幕。
2. 世界演化审批时只保留已通过校验的 approach；非法 approach 列表不拒绝整幕，降级为空列表并记录稳定日志分类 investigation_approach_invalid。开局候选沿用 validateOpeningGenerationCandidate 的失败结果，把同类问题记录为稳定 issue 并触发现有 deterministic fallback，未审批数据不得进入 compile。
3. 为七种题材与 generic 的确定性新事实提供两个不泄漏正文的默认方式，从 deterministicEvolutionBeats.ts 题材词库组合生成（例如武侠 = 沿痕迹追查 / 向摊贩打听，科幻 = 扫描残留数据 / 检查物理痕迹），禁止全部题材共用同一组固定文案；旧事实与无列表事实保持自动揭示。
4. 将 approach 列表随 WorldFactEntry 铸造、世界演化预览和 SQLite JSON 写回；opening compile 只复制候选 publicFacts 已审批的 investigationApproaches，保持既有 discovered = knownFactIds.includes(factId) 语义，不因“无 approach”把所有开局事实提前发现；不得在 UI 侧临时生成选项。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/deterministicEvolutionBeats.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts src/game/application/server/ai/liveWorldEvolutionSource.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/deterministicEvolutionBeats.ts src/game/application/deterministicEvolutionBeats.test.ts src/game/application/deterministicEvolutionSource.ts src/game/application/server/persistence/sqliteGameRepository.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
    git commit -m "feat(investigation): generate and approve safe investigation approaches"

---

### Task 3: 实现调查规则、代价、后果与自动揭示

**Files:**
- Modify: src/game/gameplay/rpg/ruleEngine/validateAction.ts
- Modify: src/game/gameplay/rpg/ruleEngine/resolveByType.ts
- Modify: src/game/gameplay/rpg/ruleEngine/index.ts
- Modify: src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts
- Test: src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts
- Test: src/game/gameplay/rpg/ruleEngine/validateAction.test.ts
- Test: src/game/gameplay/rpg/ruleEngine/index.test.ts
- Test: src/game/application/performTurn.test.ts

**Interfaces:**
- Produces resolveFactDiscovery(worldState, action, source), where source is { kind: "player"; approachId: string } or { kind: "automatic" }; the helper returns the same rule-resolution shape as resolveByType and never performs persistence.
- Produces autoResolveCurrentInvestigation(worldState, storyState), a pure bounded helper that either returns one automatic fact resolution or returns no-op; it does not run quest reconciliation, update the ledger itself, or create a pending job.
- Produces fact_discovered with approachId/evidenceQuality/tensionDelta for player choices; automatic discovery emits the same event with omitted approach metadata and zero extra delta.
- Produces stable failures INVESTIGATION_APPROACH_REQUIRED、UNKNOWN_INVESTIGATION_APPROACH 和 FACT_NOT_INVESTIGABLE（启用 validateAction 中已定义但从未使用的该码，拒绝无 approach 事实的客户端 investigate）；重复调查不引入新码——事实发现后沿用既有 FACT_ALREADY_DISCOVERED 天然拦截。

- [ ] **Step 1: 编写失败测试**

    it("requires an approved approach when a fact has multiple investigation approaches", () => {
      const result = validateAction(worldWithApproaches(), { type: "investigate", factId: FACT_1_ID });
      expect(result.ok).toBe(false);
      expect(result.code).toBe("INVESTIGATION_APPROACH_REQUIRED");
    });

    it("records clean versus noisy evidence and applies the declared tension cost", () => {
      const result = resolveByType(worldWithApproaches(), {
        type: "investigate", factId: FACT_1_ID, approachId: "risky",
      }, deps);
      expect(result.ok).toBe(true);
      expect(result.events[0]).toMatchObject({
        type: "fact_discovered", approachId: "risky", evidenceQuality: "noisy", tensionDelta: 12,
      });
      const nextStory = updateStoryMetrics(storyWithDiscoverFact(), result.events);
      expect(nextStory.tension).toBeGreaterThan(storyWithDiscoverFact().tension);
    });

    it("automatically discovers an approach-less fact at a reveal boundary without exposing a player action", () => {
      const result = autoResolveCurrentInvestigation(worldWithApproachlessFact(), storyWithDiscoverFact());
      expect(result.events).toContainEqual(expect.objectContaining({ type: "fact_discovered", factId: FACT_1_ID }));
      expect(result.stateChanges.some((change) => change.path.includes("discovered"))).toBe(true);
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/validateAction.test.ts src/game/gameplay/rpg/ruleEngine/index.test.ts src/game/application/performTurn.test.ts

Expected: FAIL because approach validation, event metadata, and automatic reveal do not exist.

- [ ] **Step 3: 实现规则结算**

1. 在 validateAction.ts 中查找目标 fact，并要求 fact.locationId 等于 currentLocationId；有 investigationApproaches.length >= 2 时要求 approachId 命中该事实的已审批列表（缺失/未知 approach 分别返回 INVESTIGATION_APPROACH_REQUIRED / UNKNOWN_INVESTIGATION_APPROACH）；无列表或尚未自动揭示的事实返回 FACT_NOT_INVESTIGABLE；已发现事实沿用 FACT_ALREADY_DISCOVERED（同一方式重复提交由发现状态自然拦截，无需 ALREADY_USED 死码）。释放游标/当前主线目标仍由 buildChoiceMap 与 performTurn 的 isActionReleased 共同守护。
2. 在 resolveByType.ts 抽取纯 resolveFactDiscovery：更新 discovered、追加 fact_discovered、产生 StateChange；player source 写入所选 approach 的 evidence/tension，automatic source 只写基础事实事件。
3. 在 updateStoryMetrics.ts 保留既有 fact_discovered 基础张力 12，并加上事件的额外 tensionDelta（缺省/自动揭示为 0）；将 evidence quality 保留在 event ledger，供后续 narrative context 使用。
4. 在 ruleEngine/index.ts 的 resolveTurn 中，先完成当前玩家 action 的既有一次 reconcile；若 reconcile 后的当前主线首目标是当前地点、无 approach 的 discover_fact，则调用 autoResolveCurrentInvestigation 一次，追加 fact_discovered 到同一 domainEvents，随后只再执行一次针对该自动事实的 quest reconciliation，再继续既有 advanceStoryProgression、updateStoryMetrics、ending 和 materialized view 流程。这样自动事件、目标推进、张力和 eventLedger 仍属于同一个规则回合/CAS，且最多自动消费一个事实目标；触发条件覆盖所有成功 action 类型，不只 move/talk。
5. opening compile 保持既有 discovered = knownFactIds.includes(factId) 语义，不把所有无 approach 事实预先置为 discovered，也不伪造初始 fact_discovered 事件；当前开局契约首目标固定为 talk_to_opening_npc，因此没有 opening discover_fact 时不执行自动揭示。若未来开局契约允许 discover_fact，必须只对那个当前目标事实走同一 autoResolveCurrentInvestigation 规则入口。generatePendingScene 只消费规则已写好的 fact_discovered 结果做场景旁白与“下一步”目标交接，不调用规则 helper、不得再次裁决事实或修改 tension。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/validateAction.test.ts src/game/gameplay/rpg/ruleEngine/index.test.ts src/game/application/performTurn.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/gameplay/rpg/ruleEngine/validateAction.ts src/game/gameplay/rpg/ruleEngine/resolveByType.ts src/game/gameplay/rpg/ruleEngine/index.ts src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts src/game/gameplay/rpg/ruleEngine/validateAction.test.ts src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/index.test.ts src/game/application/performTurn.test.ts
    git commit -m "feat(investigation): resolve approach costs and auto-discover linear facts"

---

### Task 4: 重构 opaque choice 投影与目标入口

**Files:**
- Modify: src/game/application/buildChoiceMap.ts
- Modify: src/game/application/gameSessionView.ts
- Modify: src/game/application/sceneGenerationContext.ts
- Modify: src/game/application/deterministicSceneSource.ts
- Test: src/game/application/buildChoiceMap.test.ts
- Test: src/game/application/gameSessionView.test.ts
- Test: src/game/application/sceneGenerationContext.test.ts
- Test: src/game/application/deterministicSceneSource.test.ts

**Interfaces:**
- Produces PlayerChoiceView.presentation investigate for approach choices; existing explore remains only for observation/candidate-event hooks.
- Produces one opaque token per approved approach with Action = investigate plus factId and approachId.
- Produces no investigate button/token for an approach-less fact; currentObjectiveChoiceTokens is empty after automatic reveal.
- Produces buildInvestigationOutcomeNarrative(input: { approachLabel: string; evidenceQuality: "clean" | "noisy"; factText: string; baseNarrative?: string; nextObjectiveLabel?: string }): string as the deterministic wrapper for an already-resolved investigation result.

- [ ] **Step 1: 编写失败测试**

    it("projects two approach choices and no generic investigate button", () => {
      const view = projectGameSessionView(worldWithApproaches(), storyWithDiscoverFact(), 0, "ending");
      expect(view.currentLocation.actions.filter((choice) => choice.presentation === "investigate").map((choice) => choice.label))
        .toEqual(["沿痕迹追查", "翻查附近杂物"]);
      expect(view.currentLocation.actions.some((choice) => choice.label === "调查现场线索")).toBe(false);
    });

    it("does not project any investigate action for an approach-less fact", () => {
      const view = projectGameSessionView(worldWithApproachlessFact(), storyWithDiscoverFact(), 0, "ending");
      expect(view.currentLocation.actions.filter((choice) => choice.presentation === "investigate")).toHaveLength(0);
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/application/buildChoiceMap.test.ts src/game/application/gameSessionView.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/deterministicSceneSource.test.ts

Expected: FAIL because the projector currently creates one action per fact and labels it as an explore action.

- [ ] **Step 3: 实现投影与叙事契约**

1. buildChoiceMap.ts 只为当前 discover_fact 主线目标对应事实（且已通过释放游标）的 approved approach 铸造 runtime token；同一地点的非目标未发现事实不投影行动按钮；approach-less/非法列表不得退化为 generic investigate 或用 explore 冒充调查；registry action 校验同时检查 approach 仍属于当前 fact 且事实未发现。
2. gameSessionView.ts 将 approach label/hint 投影为 presentation investigate，不暴露 factId、approachId、evidenceQuality 或 tensionDelta；自动事实只由 ready scene/事件旁白体现。
3. GameSessionView.story 新增 currentObjectiveChoiceTokens: readonly string[]；discover_fact 有多个 approach 时返回全部 token，单一目标行动仍同时填充兼容的 currentObjectiveChoiceToken；无 approach 时两个字段均为空/null，避免行动栏显示伪入口。
4. sceneGenerationContext.ts 给导演提供安全的 approach labels 与结果表现约束，不提供完整 fact text；deterministicSceneSource.ts 提供 buildInvestigationOutcomeNarrative，将已结算的 approach/evidence 与可选的 linearNarrativeQueue baseNarrative 组合成“采取方式 → 发现事实 → 证据质量/动静代价 → 下一目标”的 fallback 旁白。
5. 验证同 fact 不同 approach 的 runtime token 互不相同（派生契约已在 Task 1 的 approvedChoice 同步中完成）；stale revision 仍零写入。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/application/buildChoiceMap.test.ts src/game/application/gameSessionView.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/deterministicSceneSource.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/application/buildChoiceMap.ts src/game/application/gameSessionView.ts src/game/application/sceneGenerationContext.ts src/game/application/deterministicSceneSource.ts src/game/application/buildChoiceMap.test.ts src/game/application/gameSessionView.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/deterministicSceneSource.test.ts
    git commit -m "feat(investigation): project meaningful approach choices through opaque tokens"

---

### Task 5: 接入场景表演与调查结果反馈

**Files:**
- Modify: src/game/application/sceneSource.ts
- Modify: src/game/application/server/ai/liveScenePerformanceSource.ts
- Modify: src/game/application/approveAndWriteScene.ts
- Modify: src/game/application/generatePendingScene.ts
- Modify: src/components/LocationSceneScreen.tsx
- Modify: src/components/AdventureGameShell.tsx
- Test: src/game/application/server/ai/liveScenePerformanceSource.test.ts
- Test: src/game/application/approveAndWriteScene.test.ts
- Test: src/game/application/generatePendingScene.test.ts
- Create: src/components/LocationSceneScreen.test.tsx
- Test: src/components/AdventureGameShell.test.tsx

**Interfaces:**
- Consumes resolved approach outcome and forced fact_discovered beat.
- Produces a ready scene whose narration names the chosen method and its structured result; live AI may vary wording but cannot alter fact/evidence/tension outcome.
- Produces a visible “下一步” target handoff after fact discovery; no extra “确认调查” click.
- Consumes buildInvestigationOutcomeNarrative from Task 4. The existing linearNarrativeQueue remains keyed by factId; it supplies baseNarrative, and this wrapper adds the already-resolved approach/evidence result without requiring one AI queue entry per approach.

- [ ] **Step 1: 编写失败测试**

    it("uses the chosen approach in deterministic investigation feedback", () => {
      const narration = buildInvestigationOutcomeNarrative({
        approachLabel: "翻查附近杂物",
        evidenceQuality: "noisy",
        factText: "车轮印指向北巷旧道",
        baseNarrative: "你在泥地边发现了断续的车轮印。",
      });
      expect(narration).toContain("翻查附近杂物");
      expect(narration).toContain("留下了动静");
    });

    it("renders two investigation methods as separate action buttons", async () => {
      render(<LocationSceneScreen view={viewWithInvestigationApproaches()} busy={false} pending={false} onSubmit={vi.fn()} onReturnMap={vi.fn()} />);
      expect(screen.getByRole("button", { name: "沿痕迹追查" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "翻查附近杂物" })).toBeInTheDocument();
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts src/components/LocationSceneScreen.test.tsx src/components/AdventureGameShell.test.tsx

Expected: FAIL because scene context and UI do not carry approach labels/results.

- [ ] **Step 3: 实现反馈链**

1. 扩展 ScenePerformanceProposal 的调查结果节拍上下文；live prompt 只允许引用服务端已结算的 approach label、evidence quality 和 next objective，不允许 AI 决定是否发现事实或修改 tension。调查前预生成的 linearNarrativeQueue 不携带 approachId/结果，避免在玩家选择前生成错误分支。
2. approveAndWriteScene.ts 校验 AI 叙事只引用已结算的 approach/fact/entity；非法正文走 linear_narrative_fallback，不拒绝规则结果。
3. generatePendingScene.ts 将规则层已写入的 approach outcome（fact_discovered）作为强制节拍引用进场景叙事，并保留现有 investigate fast path 的零额外 live 调用语义：匹配 factId 的队列条目作为 baseNarrative，再由 buildInvestigationOutcomeNarrative 叠加所选 approachLabel/evidenceQuality/下一目标；不得在场景写回阶段再次修改事件账本或 tension。
4. LocationSceneScreen.tsx 将 presentation investigate 渲染为调查方法按钮；当 story.currentObjectiveChoiceTokens 非空时按 token 集合保留全部方法，不再用单一 currentObjectiveChoiceToken 把第二个选项过滤掉；同时将 sceneActions 过滤与 currentObjectiveRailAction / currentObjectiveIsSceneAction 判定（现状按单个 currentObjectiveChoiceToken 匹配，`LocationSceneScreen.tsx` 的 currentObjectiveRailAction / currentObjectiveIsSceneAction）改为按 token 集合处理，保证多个调查方法按钮都被识别为当前目标行动并全部保留在行动栏；不再渲染“调查现场线索”单按钮。没有行动时显示自动揭示结果或明确动线提示，而不是空白。
5. AdventureGameShell.tsx 提交按钮仍只传 choiceToken；结果场景展示 evidence quality/动静反馈和当前目标更新，禁止客户端读取或计算 tensionDelta。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts src/components/LocationSceneScreen.test.tsx src/components/AdventureGameShell.test.tsx

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/application/sceneSource.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/approveAndWriteScene.ts src/game/application/generatePendingScene.ts src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.tsx src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts src/components/LocationSceneScreen.test.tsx src/components/AdventureGameShell.test.tsx
    git commit -m "feat(investigation): show method-specific result scenes without extra confirmation"

---

### Task 6: 端到端旅程、旧数据行为与回归门禁

**Files:**
- Create: src/game/application/testing/investigationChoiceJourney.test.ts
- Modify: src/game/application/testing/foundationJourney.test.ts
- Modify: src/game/application/testing/investigationFlowJourney.test.ts
- Modify: src/game/application/server/compositionRoot.test.ts
- Test: src/game/application/gameSessionView.test.ts
- Test: src/game/application/buildChoiceMap.test.ts

**Interfaces:**
- Proves one choice-driven investigation and one automatic investigation path through real repository/CAS APIs.
- Proves reload preserves approach result in event ledger and tension, while old facts without approach metadata never expose a dead button.

- [ ] **Step 1: 编写失败旅程测试**

    it("choice-driven investigation records durable divergence", async () => {
      const journey = await createInvestigationChoiceJourney({ mode: "offline" });
      expect(journey.view().currentLocation.actions.map((choice) => choice.label)).toEqual([
        "沿痕迹追查", "翻查附近杂物",
      ]);
      await journey.choose("沿痕迹追查");
      const first = journey.record();
      expect(first.worldState.eventLedger.at(-1)).toMatchObject({ evidenceQuality: "clean" });
      const revisionBeforeReload = first.revision;
      await journey.reload();
      expect(journey.record().revision).toBe(revisionBeforeReload);
    });

    it("approach-less facts auto-resolve and never present an investigate button", async () => {
      const journey = await createInvestigationChoiceJourney({ mode: "legacy_fact" });
      await journey.exposeLegacyFact();
      await journey.reload();
      expect(journey.view().currentLocation.actions.some((choice) => choice.presentation === "investigate")).toBe(false);
      expect(journey.record().worldState.worldFacts.find((fact) => fact.factId === LEGACY_FACT_ID)?.discovered).toBe(true);
      expect(journey.record().worldState.eventLedger).toContainEqual(expect.objectContaining({
        type: "fact_discovered",
        factId: LEGACY_FACT_ID,
      }));
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/investigationFlowJourney.test.ts src/game/application/testing/foundationJourney.test.ts

Expected: FAIL until the full choice and auto paths are wired through repository reload and the application composition root.

- [ ] **Step 3: 实现旅程 fixture 与兼容断言**

1. 用真实临时 SQLite 建立含两个 approach 的 fact fixture；通过 application facade 等价 POST /api/game/actions 提交 opaque token，不在测试中构造 action/fact ID。
2. 选择 clean/noisy 两条路径各跑一次，断言 WorldState、eventLedger、StoryState.tension 和 ready scene narration 至少有两组结构化差异；两条路径都完成同一个 discover_fact objective。
3. 使用旧形状 fact（无 investigationApproaches）时，先让 fixture 执行一次会把该事实暴露为当前目标的成功 action；断言该 action 的同一规则回合自动揭示事实、没有 investigate choice，且 reload 只恢复已写入的 fact_discovered，不会等待不存在的 pending。
4. 更新原 investigationFlowJourney.test.ts：有 approach 的新 fixture 选择方法后再断言即时叙事；保留 queue 消费、fallback、linear_narrative_fallback 和幕推进防护。
5. 更新 foundationJourney.test.ts 的动作覆盖说明，使完整旅程不再把“点击调查”作为无分支动作计数，改为验证一次有选择调查和一次自动事实揭示。

- [ ] **Step 4: 运行完整门禁**

    npm run check:standards
    npm run typecheck
    npm run lint
    npm run test:boundaries
    npm run test:fast
    npm run test:game-domain
    npm run test:game-gameplay
    npm run test:game-application
    npm run test:components
    npm run test:app
    npm test
    npm run test:foundation-journey
    npm run journey:foundation
    npm run build

Expected: all commands PASS; no old test asserts a generic one-click investigation entry.

- [ ] **Step 5: 提交**

    git add src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/foundationJourney.test.ts src/game/application/testing/investigationFlowJourney.test.ts src/game/application/server/compositionRoot.test.ts
    git commit -m "test(investigation): cover choice and automatic discovery journeys"

---

### Task 7: 同步策划与 Agent 文档

**Files:**
- Modify: docs/策划文档/AI生成RPG_MVP.md
- Modify: docs/agent/行动裁决.md
- Modify: docs/agent/探索与任务推进.md
- Modify: docs/agent/地图与地点冒险.md
- Modify: docs/Agent文档索引.md

**Interfaces:**
- Documents the final player rule, automatic-reveal boundary, approach-choice contract, evidence/tension consequences, and the fact that NPC dialogue is a separate interaction type.

- [ ] **Step 1: 更新玩家规则**

在 AI生成RPG_MVP.md 的玩家行动章节写明：无选择事实自动揭示；有选择事实提供 2–3 个调查方式；所有方式都走同一规则裁决；结果必须写入 evidence quality/tension；不得把 NPC 对话选项伪装成现场调查。

- [ ] **Step 2: 更新实现事实**

在三个 docs/agent/ 文档分别补充：Action 校验与失败码、investigationApproaches 投影和 opaque token、自动揭示与即时场景写回、fallback/AI 审批边界、reload/CAS 回归测试文件。

- [ ] **Step 3: 更新索引**

在 docs/Agent文档索引.md 的“探索与任务推进”和“地图与地点冒险”条目追加本计划完成日期和 canonical 文件路径，不创建平行系统文档。

- [ ] **Step 4: 文档检查**

Run: npm run check:standards

Expected: PASS，且全文不再把“调查按钮点击”描述成默认必经玩家回合。

- [ ] **Step 5: 提交**

    git add docs/策划文档/AI生成RPG_MVP.md docs/agent/行动裁决.md docs/agent/探索与任务推进.md docs/agent/地图与地点冒险.md docs/Agent文档索引.md
    git commit -m "docs(investigation): document choice and automatic discovery rules"

---

## Non-goals

- 第一版 evidenceQuality 只作为叙事与后续生成上下文消费，不直接改变结局条件、软锁或路线关闭；approach 声明的 tensionDelta 会进入现有 tension/pacing 指标，但不新增调查专属的路线关闭规则。机制性后果（如 noisy 导致 NPC 警觉、关系变化）留待后续版本。
- 不把 NPC 对话选项改名为调查方式；“套话/质问/交换情报”类调查按带 targetNpcId 的调查方式另行建模。
- 自动揭示不单独消耗玩家回合、不创建额外 PendingNarrativeJob；其 fact_discovered 事件并入触发 action 的同一个规则回合和场景旁白，不额外弹确认按钮。
- 不为 investigate 增加新的公开 route 或版本化接口；Action union 不新增类型。

## Self-review checklist

- [ ] 有 approach 的调查是否真的有玩家选择、至少一个可见代价和一个结构化后果？
- [ ] 无 approach 的事实是否在所有可达规则入口（移动抵达、NPC 交接；未来若开局允许 discover_fact）都不会留下空目标或伪按钮，且 reload 只恢复已经结算的结果？
- [ ] NPC 对话选择是否仍保持原有两选项/自定义输入契约，没有被复用为现场调查按钮？
- [ ] AI 是否只能表达已结算结果，且非法 approach/正文不会污染规则状态？
- [ ] 同 seed、不同 approach 是否在 eventLedger、tension 或叙事反馈上可观察分化，并可通过 reload 重建？
- [ ] 是否保留现有 investigate fast path、linear narrative queue 消费和幕推进/结局演化防护？
- [ ] 自动揭示的 fact_discovered 事件是否全部由规则层写入 eventLedger，generatePendingScene 未重复裁决或修改 tension？
- [ ] 同 fact 不同 approach 的 runtime token 是否互不相同（approvedChoice 三处派生同步）？
