# MVP Phase 4A：AI 契约模拟与生成体验 Implementation Plan

> 状态：待执行
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 使用版本化候选 fixture、可注入 source、严格校验与确定性 fallback，完成无需真实 AI 的安全动态开局模拟与生成体验。

**Architecture:** createGame 经 application port 请求候选。server-only fixture source 是该 port 的首个实现；Phase 4A 生产 composition root 注入 unavailable source，故玩家稳定走 fallback。候选必须经已有 validate/compile 后才可写 SQLite；创建响应仅返回安全的 generated/fallback 来源。

**Tech Stack:** Next.js App Router、React 19、TypeScript strict、Vitest、Testing Library、SQLite/libSQL、@ai-game/ui。

## Global Constraints

- 只改 ai-rpg-game；sharedInfrastructureChangeAllowed 必须为 false，不创建或修改 @ai-game/ai-transport。
- 候选不可直接写入 GameState、存档或 read model，必须先通过 validateScenarioBlueprintCandidate 和 compileScenarioBlueprint。
- provider、环境变量、fixture 文件读取与诊断只在 src/game/application/server/；UI/API/store 只经 application facade。
- 本阶段不发真实 AI 网络请求；不实现自由输入、NPC 对话、场景叙事、图像、语音、SSE、轮询或取消。
- 请求飞行中只显示“正在生成世界”的等待态；不得伪造“校验中”或“重试中”。
- fixture 不得有 API key、prompt、完整玩家原文或未经审查的真实响应。
- 新模块有同目录测试；新跨层 import 同步更新 dependencyBoundaries.test.ts。

## File Structure

| 路径 | 职责 |
|---|---|
| src/game/application/scenarioGeneration.ts | 纯 source port、稳定失败类别与安全来源类型。 |
| src/game/application/server/ai/fixtureScenarioCandidateSource.ts | server-only manifest/fixture 读取和 unavailable source。 |
| data/fixtures/phase4/*.json | 三个合法候选和每个受控失败模式。 |
| src/game/application/scenarioCandidateRecovery.ts | 仅做允许的机械修复，绝不创造剧情。 |
| src/game/application/createGame.ts | source、修复、一次重试、fallback 与原子存档编排。 |
| src/app/api/game/createGameHandler.ts | 返回 view 与 generationSource，拒绝泄漏内部诊断。 |
| src/components/NewGameSetupForm.tsx | 等待态、禁用、防重复提交与安全响应解析。 |
| src/components/CurrentGameScreen.tsx | 本次创建后的 fallback 提示；刷新时不保留。 |
| docs/agent/* 与 docs/Agent文档索引.md | Phase 4A 交接和已实现事实。 |

---

### Task 1: 建立可启动的 Phase 4A 交接入口

**Files:**

- Modify: docs/agent/current-phase.json
- Modify: docs/agent/当前开发阶段.md
- Modify: docs/Agent文档索引.md
- Test: scripts/checkHandoff.mjs

**Interfaces:**

- Consumes: 已确认设计 docs/superpowers/specs/2026-07-28-ai-contract-simulation-and-dynamic-opening-design.md。
- Produces: 单仓 planned/not_started 配置，供 npm run phase:start 创建实现 worktree。

- [ ] **Step 1: 验证旧阶段无法交接新工作**

Run:

    npm run handoff:check:docs

Expected: FAIL，当前配置仍是 completed/implemented。

- [ ] **Step 2: 写入完整 machine-readable 配置**

将 current-phase.json 替换为：

    {
      "schemaVersion": 1,
      "phase": "mvp-phase-4a-ai-contract-simulation",
      "status": "planned",
      "implementationStatus": "not_started",
      "targetBranch": "codex/mvp-phase-4a-ai-contract-simulation",
      "worktreeName": "mvp-phase-4a-ai-contract-simulation",
      "repositories": ["ai-rpg-game"],
      "plan": "docs/superpowers/plans/2026-07-28-mvp-phase-4a-ai-contract-simulation.md",
      "entryDocs": [
        "docs/游戏设计原则.md",
        "docs/游戏开发规范.md",
        "docs/Agent文档索引.md",
        "docs/agent/当前开发阶段.md",
        "docs/agent/MVP核心闭环.md",
        "docs/agent/AI环境.md",
        "docs/策划文档/AI生成RPG_MVP.md",
        "docs/superpowers/specs/2026-07-26-ai-rpg-mvp-development-spec.md",
        "docs/superpowers/specs/2026-07-28-ai-contract-simulation-and-dynamic-opening-design.md",
        "docs/superpowers/plans/2026-07-28-mvp-phase-4a-ai-contract-simulation.md"
      ],
      "acceptanceCommands": [
        "npm run lint", "npm run typecheck", "npm test",
        "npm run test:fast", "npm run build", "npm run phase:status"
      ],
      "startCommand": "npm run phase:start",
      "sharedInfrastructureChangeAllowed": false
    }

当前开发阶段文档标注“Phase 4A：待执行”；明确 fixture/fallback、无真实模型、无 shared package 变更。索引同步链接本 Plan。

- [ ] **Step 3: 验证配置**

Run:

    npm run phase:status
    npm run handoff:check:docs
    npm run phase:start -- --dry-run

Expected: 前两条成功并显示 planned/not_started；dry-run 只打印操作。

- [ ] **Step 4: Commit**

    git add docs/agent/current-phase.json docs/agent/当前开发阶段.md docs/Agent文档索引.md
    git commit -m "docs: start phase 4a AI contract simulation"

### Task 2: 定义 source port、fixture manifest 和 server-only source

**Files:**

- Create: src/game/application/scenarioGeneration.ts
- Create: src/game/application/scenarioGeneration.test.ts
- Create: src/game/application/server/ai/fixtureScenarioCandidateSource.ts
- Create: src/game/application/server/ai/fixtureScenarioCandidateSource.test.ts
- Create: data/fixtures/phase4/manifest.json
- Create: data/fixtures/phase4/generated-wuxia.json
- Create: data/fixtures/phase4/generated-science-fiction.json
- Create: data/fixtures/phase4/generated-urban.json
- Create: data/fixtures/phase4/repairable-extra-fields.json
- Create: data/fixtures/phase4/unrepairable-reference.json
- Create: data/fixtures/phase4/budget-exceeded.json
- Create: data/fixtures/phase4/unreachable-ending.json
- Create: data/fixtures/phase4/cross-type-content.json
- Create: data/fixtures/phase4/illegal-entity.json
- Create: data/fixtures/phase4/invalid-json.json
- Create: data/fixtures/phase4/timeout.json
- Create: data/fixtures/phase4/rate-limited.json
- Create: data/fixtures/phase4/service-error.json
- Create: data/fixtures/phase4/empty-response.json
- Modify: src/game/application/index.ts

**Interfaces:**

- Consumes: ValidatedNewGameInput 与 ScenarioBlueprintCandidate。
- Produces: ScenarioCandidateSource、ScenarioCandidateAttempt、ScenarioCandidateFailureCategory、ScenarioGenerationSource，以及只供 server/test observer 消费的 generation event。

- [ ] **Step 1: 写 port 的失败测试**

在 scenarioGeneration.test.ts 添加：

    import { describe, expect, it } from "vitest";
    import { SCENARIO_CANDIDATE_FAILURE_CATEGORIES } from "./scenarioGeneration";

    it("公开完整且冻结的候选失败类别", () => {
      expect(SCENARIO_CANDIDATE_FAILURE_CATEGORIES).toEqual([
        "invalid_json", "schema_violation", "budget_exceeded", "reference_broken",
        "unreachable_ending", "cross_type_content", "illegal_entity", "timeout",
        "rate_limited", "service_error", "empty_response"
      ]);
      expect(Object.isFrozen(SCENARIO_CANDIDATE_FAILURE_CATEGORIES)).toBe(true);
    });

Run:

    npx vitest run src/game/application/scenarioGeneration.test.ts

Expected: FAIL，模块不存在。

- [ ] **Step 2: 实现纯 application port**

scenarioGeneration.ts 必须导出冻结数组及以下形状：

export type ScenarioGenerationSource = "generated" | "fallback";
export type ScenarioGenerationStage =
  | "requested" | "candidate_received" | "validating" | "repairing"
  | "retrying" | "falling_back" | "completed" | "failed";
export type ScenarioGenerationEvent = Readonly<{
  stage: ScenarioGenerationStage;
  outcome?: ScenarioGenerationSource;
  category?: ScenarioCandidateFailureCategory | "persistence_failure";
}>;
    export type ScenarioGenerationRequest = Readonly<{
      input: ValidatedNewGameInput;
      seed: string;
      traceId: string;
    }>;
    export type ScenarioCandidateAttempt =
      | Readonly<{
          ok: true;
          contractVersion: "phase4a-v1";
          origin: "fixture";
          candidate: ScenarioBlueprintCandidate;
          diagnostics: readonly string[];
        }>
      | Readonly<{
          ok: false;
          contractVersion: "phase4a-v1";
          origin: "fixture" | "unavailable";
          category: ScenarioCandidateFailureCategory;
          diagnostics: readonly string[];
        }>;
    export type ScenarioCandidateSource = Readonly<{
      generate(request: ScenarioGenerationRequest): Promise<ScenarioCandidateAttempt>;
    }>;

index.ts 只 re-export 纯 type/constant；不得 export server factory。

- [ ] **Step 3: 固化 fixture 数据**

manifest 为 phase4a-v1；每个条目有唯一 id、file、gameType、seed、expectedAttempt、expectedCategory（失败时）、expectedFallback 和 expectedStages。固定 ID 为：

    generated-wuxia
    generated-science-fiction
    generated-urban
    repairable-extra-fields
    unrepairable-reference
    budget-exceeded
    unreachable-ending
    cross-type-content
    illegal-entity
    invalid-json
    timeout
    rate-limited
    service-error
    empty-response

三个 generated JSON 保存完整 ScenarioBlueprintCandidate。它们分别以现有 phase1 的 wuxia、science_fiction、urban 输入及 seed 运行 createFallbackBlueprint(input, seed, { profiles }) 一次后完整固定；生成后以 validateScenarioBlueprintCandidate 和 compileScenarioBlueprint 验证。

其余候选从合法完整候选复制，只制造 manifest 声明的一种错误。invalid-json.json 本身仍是合法 fixture JSON，保存 responseText: "{not-json"，由 source 映射 invalid_json；不可提交损坏 JSON 文件。

- [ ] **Step 4: 写 fixture source 的失败测试**

测试临时 fixture 根目录，不修改真实 fixture；覆盖合法 generated-wuxia、timeout、未知 ID、缺失文件、manifest 版本错误和根结构错误。

    const source = createFixtureScenarioCandidateSource({
      fixtureRoot,
      fixtureId: "timeout"
    });
    expect(await source.generate(request)).toMatchObject({
      ok: false,
      origin: "fixture",
      category: "timeout",
      diagnostics: ["FIXTURE_TIMEOUT"]
    });

Run:

    npx vitest run src/game/application/server/ai/fixtureScenarioCandidateSource.test.ts

Expected: FAIL，factory 不存在。

- [ ] **Step 5: 实现 source**

导出：

    createFixtureScenarioCandidateSource(options: Readonly<{
      fixtureRoot: string;
      fixtureId: string;
    }>): ScenarioCandidateSource

    createUnavailableScenarioCandidateSource(): ScenarioCandidateSource

实现只可使用 node:fs/promises、node:path、纯 port/domain types。必须阻止 manifest file 路径逃出 fixtureRoot；异常一律映射 service_error，diagnostics 仅为稳定代码。candidate 返回前检查 root object、locations/npcs/quests/items/enemies/endings 数组及 world/openingScene/player object；失败映射 schema_violation。unavailable source 恒返回：

    {
      ok: false,
      contractVersion: "phase4a-v1",
      origin: "unavailable",
      category: "service_error",
      diagnostics: ["PHASE4A_NO_LIVE_SOURCE"]
    }

- [ ] **Step 6: 验证并提交**

    npx vitest run src/game/application/scenarioGeneration.test.ts src/game/application/server/ai/fixtureScenarioCandidateSource.test.ts
    git add src/game/application/scenarioGeneration.ts src/game/application/scenarioGeneration.test.ts src/game/application/server/ai/fixtureScenarioCandidateSource.ts src/game/application/server/ai/fixtureScenarioCandidateSource.test.ts data/fixtures/phase4 src/game/application/index.ts
    git commit -m "feat: add phase 4a scenario fixture source"

Expected: 所有 fixture tests 通过；提交无密钥或 node_modules。

### Task 3: 接入 recovery、一次重试与确定性 fallback

**Files:**

- Create: src/game/application/scenarioCandidateRecovery.ts
- Create: src/game/application/scenarioCandidateRecovery.test.ts
- Modify: src/game/application/createGame.ts
- Modify: src/game/application/createGame.test.ts
- Modify: src/game/application/applicationFixture.testutil.ts
- Modify: src/game/application/server/compositionRoot.ts

**Interfaces:**

- Consumes: Task 2 source 和既有 validator/compiler/fallback/repository。
- Produces: 成功 createGame 结果 source: generated | fallback；不成功候选最多修复一次、重试一次后 fallback。

- [ ] **Step 1: 写 recovery 的失败测试**

只允许：删除未知根字段、trim 所有字符串、裁剪末尾超预算列表。不可修复悬空引用、任务图、tag、数值、名称、剧情文本或 ID。

    it("只移除未知字段并裁剪超预算尾部项", () => {
      const repaired = repairScenarioCandidate(repairableCandidate);
      expect(repaired?.extraPromptInstruction).toBeUndefined();
      expect(repaired?.npcs).toHaveLength(6);
    });

    it("悬空引用不能被机械修复伪造成合法候选", () => {
      expect(repairScenarioCandidate(unrepairableReferenceCandidate)).toBeNull();
    });

Run:

    npx vitest run src/game/application/scenarioCandidateRecovery.test.ts

Expected: FAIL，helper 不存在。

- [ ] **Step 2: 实现 recovery helper**

实现：

    repairScenarioCandidate(
      candidate: ScenarioBlueprintCandidate
    ): ScenarioBlueprintCandidate | null

先 clone，绝不原地改 fixture。根字段白名单固定为 schemaVersion、generationId、seed、templateVersion、gameType、inputDigest、world、player、locations、npcs、quests、enemies、items、endings、openingScene、contentBudget。只裁剪 locations 到 mainLocations + hiddenLocationsMax、npcs 到 coreNpcsMax、side quests 到 sideQuestsMax。裁剪后每次走完整 validator；若引用被删除、结构不完整或仍有 issue，返回 null。

- [ ] **Step 3: 写 use case 失败矩阵**

在 createGame.test.ts 注入记录 calls 的 fake source。分别断言：合法候选 generated；repairable 候选 generated 且 source 调用一次；首次不可修复、第二次合法 generated 且调用两次；两次 timeout fallback；repository 冲突/抛错保持稳定错误；输入无效时 source 和 repository 调用均为零。

    expect(result).toMatchObject({ ok: true, source: "fallback" });
    expect(source.calls).toHaveLength(2);
    expect(repository.createCalls).toHaveLength(1);

- [ ] **Step 4: 最小实现编排**

CreateGameDependencies 新增必需 scenarioCandidateSource 和 newTraceId，以及可选 generationObserver(event: ScenarioGenerationEvent): void。生产实现不传 observer；测试注入记录数组。严格顺序：

    validate input
    -> attempt #1
    -> validate/compile 或 repair once 后 validate/compile
    -> attempt #2，重复相同流程
    -> createFallbackBlueprint(input, seed, { profiles })
    -> validate/compile
    -> initializeGameState
    -> createInitialGame 一次

source failure 不能变成 GENERATION_INVALID；只有 fallback 本身不可编译才可返回该码。diagnostics 不进入 CreateGameResult。compositionRoot 注入 unavailable source 和 randomUUID traceId，不读取 AI 环境。

每次阶段变化调用 observer：requested、candidate_received、validating、repairing（仅发生修复）、retrying（第二次 source 前）、falling_back、completed（附 generated/fallback outcome）；repository 返回错误或抛错时记录 failed（附 persistence_failure）。observer 不得抛回 use case、不得写数据库，且不通过 API handler 返回。

- [ ] **Step 5: 验证并提交**

    npx vitest run src/game/application/scenarioCandidateRecovery.test.ts src/game/application/createGame.test.ts
    npx vitest run src/dependencyBoundaries.test.ts
    git add src/game/application/scenarioCandidateRecovery.ts src/game/application/scenarioCandidateRecovery.test.ts src/game/application/createGame.ts src/game/application/createGame.test.ts src/game/application/applicationFixture.testutil.ts src/game/application/server/compositionRoot.ts
    git commit -m "feat: route game creation through scenario source"

Expected: 所有 source 失败仍可保存完整 fallback 游戏，且没有候选绕过 validate/compile。

### Task 4: 返回安全来源并实现等待与降级提示

**Files:**

- Modify: src/app/api/game/createGameHandler.ts
- Modify: src/app/api/game/createGameHandler.test.ts
- Modify: src/components/NewGameSetupForm.tsx
- Modify: src/components/NewGameSetupForm.test.tsx
- Modify: src/components/CurrentGameScreen.tsx
- Modify: src/components/CurrentGameScreen.test.tsx

**Interfaces:**

- Consumes: Task 3 成功结果 view + source。
- Produces: POST 成功体 { view, generationSource }，以及一次性 fallback 提示。

- [ ] **Step 1: 写 API 失败测试**

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      view: expectedView,
      generationSource: "fallback"
    });

另断言成功 body 不含 seed、inputDigest、blueprint、state、diagnostics、fixtureId、origin 或 traceId；失败 body 完全维持既有契约。

- [ ] **Step 2: 实现 API 安全映射**

成功分支仅改为：

    return json(201, { view: result.view, generationSource: result.source });

不修改请求白名单；客户端提交 generationSource 仍由 UNEXPECTED_FIELDS 拒绝；GET current 不返回该字段。

- [ ] **Step 3: 写 UI 失败测试**

将 onCreated 形状扩展为：

    onCreated?: (
      view: GameSessionView,
      generationSource: "generated" | "fallback"
    ) => void

测试提交后存在 role=status 的“正在生成世界，请稍候……”，按钮和 fieldset disabled，重复 submit 仅一次 fetch。fallback 响应调用回调并传 fallback；缺失或未知 generationSource 是失败，不得默认 generated。

CurrentGameScreen 测试必须断言 fallback 创建后显示 warning Tag 与“已使用稳定模板完成开局，仍可完整游玩。”；直接 GET current 恢复同一 view 时不显示它。

- [ ] **Step 4: 实现 UI**

CreateGameApiBody 加 generationSource 联合。response.ok、view 存在且来源有效时才调用回调。CurrentGameScreen active state 加 createdWithFallback；只在创建回调设为 true，loadCurrentGame、刷新、清档和行动成功均清除。使用现有 Panel、Tag 和 aria-live=polite；不新增共享 UI，不添加时间驱动进度。

- [ ] **Step 5: 验证并提交**

    npx vitest run src/app/api/game/createGameHandler.test.ts src/components/NewGameSetupForm.test.tsx src/components/CurrentGameScreen.test.tsx
    git add src/app/api/game/createGameHandler.ts src/app/api/game/createGameHandler.test.ts src/components/NewGameSetupForm.tsx src/components/NewGameSetupForm.test.tsx src/components/CurrentGameScreen.tsx src/components/CurrentGameScreen.test.tsx
    git commit -m "feat: show deterministic generation fallback"

Expected: 用户只看等待态与安全 fallback 提示，不会看到 fixture 或内部诊断。

### Task 5: 加固边界、三类型回归、文档与全量验收

**Files:**

- Modify: src/dependencyBoundaries.test.ts
- Create: src/game/application/phase4aScenarioGenerationRegression.test.ts
- Modify: docs/agent/current-phase.json
- Modify: docs/agent/当前开发阶段.md
- Modify: docs/agent/MVP核心闭环.md
- Modify: docs/agent/AI环境.md
- Modify: docs/Agent文档索引.md

**Interfaces:**

- Consumes: Tasks 2–4。
- Produces: 受守卫的 server-only source、三类型 SQLite 证明与 implemented 文档事实。

- [ ] **Step 1: 写失败的边界和集成测试**

dependencyBoundaries.test.ts 拒绝：component 或 src/app/api 直导 application/server/ai；fixture source 导入 persistence；domain/gameplay 导入 application/scenarioGeneration。允许 createGame 导入纯 port，允许 compositionRoot 导入 fixture factory。

phase4aScenarioGenerationRegression.test.ts 用临时 SQLite 覆盖三个合法 fixture 和 timeout、reference、cross-type 三个失败 fixture。断言 reload、既有双结局路线、内容预算、fallback source、零半初始化记录和 API/view 不含 fixture 名称。

- [ ] **Step 2: 实现守卫并运行回归**

静态扫描同时检查 alias 和相对 import，覆盖 ts/tsx。临时库只在 tmp/ 下，使用 repository close/cleanup；不得删除 SQLite schema、数据库目录、.foundation 或 sibling foundation。

    npx vitest run src/dependencyBoundaries.test.ts src/game/application/phase4aScenarioGenerationRegression.test.ts

Expected: PASS。

- [ ] **Step 3: 更新已实现事实**

完成后 current-phase.json 只把 status 改 completed、implementationStatus 改 implemented，保留 phase、branch、worktree、plan 和 acceptanceCommands。当前阶段、MVP核心闭环、AI环境和索引记录 fixture source、一次修复/重试、fallback、generationSource；明确真实 AI 与 shared transport 尚未实现。

- [ ] **Step 4: 完整验收**

    npm run lint
    npm run typecheck
    npm test
    npm run test:fast
    npm run build
    npm run phase:status

Expected: 全部命令退出码为 0；phase status 显示 Phase 4A；无外网 AI 调用。handoff:check 仅在任务启动前验证 planned/not_started，因此阶段完成后不运行它。

- [ ] **Step 5: 提交**

    git add src/dependencyBoundaries.test.ts src/game/application/phase4aScenarioGenerationRegression.test.ts docs/agent/current-phase.json docs/agent/当前开发阶段.md docs/agent/MVP核心闭环.md docs/agent/AI环境.md docs/Agent文档索引.md
    git commit -m "test: verify phase 4a scenario generation"
    git status --short

Expected: 最终 status 无输出。不要清理 worktree；日后清理含 .foundation junction 的 worktree 必须使用 cleanupConsumerWorktree.mjs，不能直接 git worktree remove。

## 明确边界

- 本 Plan 不读取 AI_API_BASE_URL、AI_MODEL 或 AI_API_KEY，不启用真实模型。
- foundation、SLG 和 @ai-game/ai-transport 不在范围内；Phase 4B 必须另写跨仓 Plan，并使用三个同名 worktree。
- fixture 只用于开发和回归；生产 Phase 4A 固定使用 unavailable source 后的确定性 fallback。
- 流式响应、实时进度与取消留给 Phase 4B 的独立设计决策。
