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
      reload(): Promise<void>;
    };

## 文件地图

- src/game/domain/worldState.ts、src/game/domain/worldDelta.ts、src/game/domain/openingGenerationCandidate.ts：事实调查方式的权威结构与生成提案结构。
- src/game/domain/action.ts、src/game/domain/events.ts、src/game/domain/storyState.ts：调查 Action、发现事件字段、schema 版本和自动揭示边界。
- src/game/gameplay/rpg/ruleEngine/validateAction.ts、resolveByType.ts、updateStoryMetrics.ts：approach 合法性、代价、事件和张力结算。
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
- Test: src/game/domain/worldState.test.ts
- Test: src/game/domain/events.test.ts
- Test: src/game/domain/action.test.ts
- Test: src/game/domain/storyState.test.ts

**Interfaces:**
- Produces InvestigationApproach with approachId, safe label/hint, evidenceQuality and bounded tensionDelta.
- Extends WorldFactEntry.investigationApproaches and matching WorldDeltaProposal.newFact / opening candidate shape.
- Extends Action investigate to include optional approachId; approachId is never client-authored outside a server-issued choice token.
- Extends FactDiscoveredEvent with optional approachId, evidenceQuality and tensionDelta.

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

Run: npm test src/game/domain/worldState.test.ts src/game/domain/events.test.ts src/game/domain/action.test.ts

Expected: FAIL because the new approach fields and event metadata are not defined.

- [ ] **Step 3: 实现最小契约**

1. 在 worldState.ts 导出 InvestigationApproach，限制 tensionDelta 的合法范围为 -5..20，并将 investigationApproaches 设为可选以兼容旧记录读取。
2. 在 worldDelta.ts 和 openingGenerationCandidate.ts 复用同一类型，不创建第二份 shape。
3. 在 action.ts 只增加可选 approachId，不增加新的公开 route 或客户端 Action 类型。
4. 在 events.ts 为 FactDiscoveredEvent 增加可选结构化结果字段；旧事件缺省时按 clean、0 读取。
5. 将 STORY_STATE_SCHEMA_VERSION 从 3 提升到 4，明确旧版本不迁移；在所有 createInitialStoryState/record default 组合处保留空 approach 兼容行为。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/domain/worldState.test.ts src/game/domain/events.test.ts src/game/domain/action.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/domain/worldState.ts src/game/domain/worldDelta.ts src/game/domain/openingGenerationCandidate.ts src/game/domain/action.ts src/game/domain/events.ts src/game/domain/storyState.ts
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
      }));
      expect(result.ok).toBe(false);
    });

    it("fallback creates two distinct safe approaches for a generated fact", () => {
      const fact = deterministicGeneratedFactFor("wuxia");
      expect(fact.investigationApproaches?.map((entry) => entry.label)).toEqual([
        "沿痕迹追查",
        "仔细检查现场",
      ]);
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts src/game/application/deterministicEvolutionBeats.test.ts

Expected: FAIL because generated facts do not yet carry or validate approach lists.

- [ ] **Step 3: 实现解析与审批**

1. 在 opening/world-evolution proposal parser 中解析 investigationApproaches，拒绝数组以外的值、重复 approachId、空 label/hint、非 clean|noisy、tensionDelta 超出 -5..20 和 label/hint 直接包含权威事实正文的条目。
2. 审批时只保留已通过校验的 approach；非法 approach 列表不拒绝整幕，降级为空列表并记录稳定日志分类 investigation_approach_invalid。
3. 为七种题材与 generic 的确定性新事实提供两个不泄漏正文的默认方式，使用 deterministicEvolutionBeats.ts 的题材场景词汇；旧事实与无列表事实保持自动揭示。
4. 将 approach 列表随 WorldFactEntry 铸造、世界演化预览和 SQLite JSON 写回；不得在 UI 侧临时生成选项。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.test.ts src/game/gameplay/rpg/worldEvolution/approveWorldDelta.test.ts src/game/application/server/ai/worldEvolutionSource.test.ts src/game/application/deterministicEvolutionBeats.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/gameplay/rpg/openingGeneration src/game/gameplay/rpg/worldEvolution/approveWorldDelta.ts src/game/application/server/ai/liveWorldEvolutionSource.ts src/game/application/deterministicEvolutionBeats.ts src/game/application/deterministicEvolutionSource.ts
    git commit -m "feat(investigation): generate and approve safe investigation approaches"

---

### Task 3: 实现调查规则、代价、后果与自动揭示

**Files:**
- Modify: src/game/gameplay/rpg/ruleEngine/validateAction.ts
- Modify: src/game/gameplay/rpg/ruleEngine/resolveByType.ts
- Modify: src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts
- Modify: src/game/application/performTurn.ts
- Modify: src/game/application/generatePendingScene.ts
- Test: src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts
- Test: src/game/gameplay/rpg/ruleEngine/validateAction.test.ts
- Test: src/game/application/performTurn.test.ts
- Test: src/game/application/generatePendingScene.test.ts

**Interfaces:**
- Produces resolveFactDiscovery(worldState, action, source), where source is player with approachId or automatic.
- Produces fact_discovered with approachId/evidenceQuality/tensionDelta for player choices; automatic discovery emits the same event with omitted approach metadata and zero extra delta.
- Produces stable failures INVESTIGATION_APPROACH_REQUIRED, UNKNOWN_INVESTIGATION_APPROACH and INVESTIGATION_APPROACH_ALREADY_USED without partial writes.

- [ ] **Step 1: 编写失败测试**

    it("requires an approved approach when a fact has multiple investigation approaches", () => {
      const result = resolveAction(worldWithApproaches(), { type: "investigate", factId: FACT_1_ID }, deps);
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
      const result = autoResolveCurrentInvestigation(worldWithApproachlessFact(), storyWithDiscoverFact(), deps);
      expect(result.events).toContainEqual(expect.objectContaining({ type: "fact_discovered", factId: FACT_1_ID }));
      expect(result.stateChanges.some((change) => change.path.includes("discovered"))).toBe(true);
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/validateAction.test.ts src/game/application/performTurn.test.ts src/game/application/generatePendingScene.test.ts

Expected: FAIL because approach validation, event metadata, and automatic reveal do not exist.

- [ ] **Step 3: 实现规则结算**

1. 在 validateAction.ts 中查找目标 fact；有 investigationApproaches.length >= 2 时要求 approachId 命中且未被本次调查记录消费；无列表时拒绝客户端直接 investigate，避免隐藏的无选择按钮继续存在。
2. 在 resolveByType.ts 抽取纯 resolveFactDiscovery：更新 discovered、追加 fact_discovered、产生 StateChange；player source 写入所选 approach 的 evidence/tension，automatic source 只写基础事实事件。
3. 在 updateStoryMetrics.ts 使用事件的 tensionDelta（缺省时沿用 fact_discovered=12），并将 evidence quality 保留在 event ledger，供后续 narrative context 使用。
4. 在 performTurn.ts 增加 autoResolveCurrentInvestigation，只在成功 action 后的当前地点/当前主线首目标是无 approach discover_fact 时执行一次，然后再跑既有 quest reconciliation；不自动消费下一个 objective。
5. 在 generatePendingScene.ts 对开局/地点抵达/对话交接的初始 direct-fact 场景调用同一规则 helper，确保没有任何玩家 action 也不会出现“当前目标是调查但没有按钮”的软锁；scene write-back 只写 helper 已产生的规则结果，不重新解释 narration。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/gameplay/rpg/ruleEngine/resolveByType.test.ts src/game/gameplay/rpg/ruleEngine/validateAction.test.ts src/game/application/performTurn.test.ts src/game/application/generatePendingScene.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/gameplay/rpg/ruleEngine/validateAction.ts src/game/gameplay/rpg/ruleEngine/resolveByType.ts src/game/gameplay/rpg/ruleEngine/updateStoryMetrics.ts src/game/application/performTurn.ts src/game/application/generatePendingScene.ts
    git commit -m "feat(investigation): resolve approach costs and auto-discover linear facts"

---

### Task 4: 重构 opaque choice 投影与目标入口

**Files:**
- Modify: src/game/application/buildChoiceMap.ts
- Modify: src/game/application/gameSessionView.ts
- Modify: src/game/application/sceneGenerationContext.ts
- Modify: src/game/application/deterministicSceneSource.ts
- Modify: src/game/domain/approvedChoice.ts
- Test: src/game/application/buildChoiceMap.test.ts
- Test: src/game/application/gameSessionView.test.ts
- Test: src/game/application/sceneGenerationContext.test.ts
- Test: src/game/application/deterministicSceneSource.test.ts

**Interfaces:**
- Produces PlayerChoiceView.presentation investigate for approach choices; existing explore remains only for observation/candidate-event hooks.
- Produces one opaque token per approved approach with Action = investigate plus factId and approachId.
- Produces no investigate button/token for an approach-less fact; currentObjectiveChoiceTokens is empty after automatic reveal.

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

1. buildChoiceMap.ts 只为当前可见 fact 的 approved approach 铸造 runtime token；registry action 校验同时检查 approach 仍属于当前 fact 且事实未发现。
2. gameSessionView.ts 将 approach label/hint 投影为 presentation investigate，不暴露 factId、approachId、evidenceQuality 或 tensionDelta；自动事实只由 ready scene/事件旁白体现。
3. GameSessionView.story 新增 currentObjectiveChoiceTokens: readonly string[]；discover_fact 有多个 approach 时返回全部 token，单一目标行动仍同时填充兼容的 currentObjectiveChoiceToken；无 approach 时两个字段均为空/null，避免行动栏显示伪入口。
4. sceneGenerationContext.ts 给导演提供安全的 approach labels 与结果表现约束，不提供完整 fact text；deterministicSceneSource.ts 为每个 approach 生成“采取方式 → 发现事实 → 证据质量/动静代价 → 下一目标”的 fallback 旁白。
5. approvedChoice.ts 的 semantic summary 和 token 派生包含 approachId，保证两个同 fact 选项不会碰撞且 stale revision 仍零写入。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/application/buildChoiceMap.test.ts src/game/application/gameSessionView.test.ts src/game/application/sceneGenerationContext.test.ts src/game/application/deterministicSceneSource.test.ts

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/application/buildChoiceMap.ts src/game/application/gameSessionView.ts src/game/application/sceneGenerationContext.ts src/game/application/deterministicSceneSource.ts src/game/domain/approvedChoice.ts
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
- Produces buildInvestigationOutcomeNarrative(input: { approachLabel: string; evidenceQuality: "clean" | "noisy"; factText: string; nextObjectiveLabel?: string }): string for deterministic fallback text.

- [ ] **Step 1: 编写失败测试**

    it("uses the chosen approach in deterministic investigation feedback", () => {
      const narration = buildInvestigationOutcomeNarrative({
        approachLabel: "翻查附近杂物",
        evidenceQuality: "noisy",
        factText: "车轮印指向北巷旧道",
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

1. 扩展 ScenePerformanceProposal 的调查结果节拍上下文；live prompt 只允许引用服务端已结算的 approach label、evidence quality 和 next objective，不允许 AI 决定是否发现事实或修改 tension。
2. approveAndWriteScene.ts 校验 AI 叙事只引用已结算的 approach/fact/entity；非法正文走 linear_narrative_fallback，不拒绝规则结果。
3. generatePendingScene.ts 将 approach outcome 作为 fact_discovered 强制节拍写回，并保留现有 investigate fast path 的零额外 live 调用语义。
4. LocationSceneScreen.tsx 将 presentation investigate 渲染为调查方法按钮；当 story.currentObjectiveChoiceTokens 非空时按 token 集合保留全部方法，不再用单一 currentObjectiveChoiceToken 把第二个选项过滤掉；不再渲染“调查现场线索”单按钮。没有行动时显示自动揭示结果或明确动线提示，而不是空白。
5. AdventureGameShell.tsx 提交按钮仍只传 choiceToken；结果场景展示 evidence quality/动静反馈和当前目标更新，禁止客户端读取或计算 tensionDelta。

- [ ] **Step 4: 运行测试确认通过**

Run: npm test src/game/application/server/ai/liveScenePerformanceSource.test.ts src/game/application/approveAndWriteScene.test.ts src/game/application/generatePendingScene.test.ts src/components/LocationSceneScreen.test.tsx src/components/AdventureGameShell.test.tsx

Expected: PASS.

- [ ] **Step 5: 提交**

    git add src/game/application/sceneSource.ts src/game/application/server/ai/liveScenePerformanceSource.ts src/game/application/approveAndWriteScene.ts src/game/application/generatePendingScene.ts src/components/LocationSceneScreen.tsx src/components/AdventureGameShell.tsx
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
      expect(journey.view().currentLocation.actions.some((choice) => choice.presentation === "investigate")).toBe(false);
      expect(journey.record().worldState.worldFacts.find((fact) => fact.factId === LEGACY_FACT_ID)?.discovered).toBe(true);
    });

- [ ] **Step 2: 运行测试确认失败**

Run: npm test src/game/application/testing/investigationChoiceJourney.test.ts src/game/application/testing/investigationFlowJourney.test.ts src/game/application/testing/foundationJourney.test.ts

Expected: FAIL until the full choice and auto paths are wired through repository reload and the application composition root.

- [ ] **Step 3: 实现旅程 fixture 与兼容断言**

1. 用真实临时 SQLite 建立含两个 approach 的 fact fixture；通过 application facade 等价 POST /api/game/actions 提交 opaque token，不在测试中构造 action/fact ID。
2. 选择 clean/noisy 两条路径各跑一次，断言 WorldState、eventLedger、StoryState.tension 和 ready scene narration 至少有两组结构化差异；两条路径都完成同一个 discover_fact objective。
3. 使用旧形状 fact（无 investigationApproaches）验证自动揭示、没有 investigate choice、不会等待不存在的 pending。
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

## Self-review checklist

- [ ] 有 approach 的调查是否真的有玩家选择、至少一个可见代价和一个结构化后果？
- [ ] 无 approach 的事实是否在所有入口（开局、移动抵达、NPC 交接、reload）都不会留下空目标或伪按钮？
- [ ] NPC 对话选择是否仍保持原有两选项/自定义输入契约，没有被复用为现场调查按钮？
- [ ] AI 是否只能表达已结算结果，且非法 approach/正文不会污染规则状态？
- [ ] 同 seed、不同 approach 是否在 eventLedger、tension 或叙事反馈上可观察分化，并可通过 reload 重建？
- [ ] 是否保留现有 investigate fast path、linear narrative queue 消费和幕推进/结局演化防护？
