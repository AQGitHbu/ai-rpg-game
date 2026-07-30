# Phase 10 Runtime AI Director and Scene Performance Implementation Plan

> 状态：已实施；异步场景任务与轮询恢复进行中
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑通“规则结算 → 世界导演 AI → 规则批准 → 剧情编剧 AI → 规则批准 → 最小知识 NPC AI → 两个固定选项”的真实、可恢复、可降级运行时剧情闭环。

**Architecture:** 保留现有 `performAction`、纯 RPG resolver、SQLite CAS 和 `GameSessionView` 分层；新增 narrative domain state、纯 action-key/批准规则、application 三角色 source ports 与 orchestrator。三个 live source 分别构造最小 prompt，复用现有 `@ai-game/ai-transport`；AI 只能生成已批准场景，玩家选项最终仍映射到既有 `AvailableAction`。

**Tech Stack:** Next.js 16、React 19、TypeScript 5.8、Vitest、libSQL、现有 `@ai-game/ai-transport@0.1.0`、OpenAI-compatible non-stream structured output。

## Global Constraints

- 单仓修改 `ai-rpg-game`；不修改 `.foundation`、`../ai-game-foundation`、`@ai-game/ai-transport` 或 `@ai-game/ui`。
- 不实现自由输入、意图解析 AI、streaming、运行时蓝图扩容、AI 图片或语音。
- director、writer、npc 必须是三个独立 source、三个独立请求和三份不同上下文。
- NPC 请求不得包含其 `knownFactIds` 之外的事实正文、其他 NPC 私密知识、完整任务图、结局条件或导演计划。
- AI 不得直接修改属性、任务、地图、背包、战斗、奖励、结局、revision 或 SQLite。
- 两个剧情选项必须映射当前规则投影的两个不同 `AvailableAction`；客户端只得到并提交 choiceToken。
- AI 失败使用完整确定性 fallback scene，不拼接部分 AI 输出；规则结果保持不变。
- 非战斗 narrative scene 恰好两个选项；可用合法行动少于两个、active battle 或 ending 时 narrative scene 为 null。
- 日常测试零网络零计费；真实调用仅由 `RUN_REAL_AI_RUNTIME_SMOKE=1` 显式开启。
- 所有 provider 调用保持 server-only；UI/API 只通过 `@/game/application` facade。

## 明确边界

- 本阶段只编排开局蓝图已经存在的实体和既有 `AvailableAction`，不运行时修改蓝图。
- AI 只生成导演提案、场景脚本、NPC 台词和选项标签；规则层批准引用，application 编排，repository 只保存最终 `GameState`。
- 三个 AI 角色不能通过一个共享大上下文模拟；NPC 上下文必须在 prompt 构造前完成最小投影。
- 美术方向只存在于 Spec，不在本 Plan 创建 production port、视觉档案或图片任务。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/game/domain/narrative.ts` | 持久化场景、NPC 台词、两个选择的稳定领域类型 |
| `src/game/domain/gameState.ts` | `GameState.narrative` |
| `src/game/gameplay/rpg/narrative/actionCandidates.ts` | `AvailableAction ↔ actionKey` 的纯稳定映射 |
| `src/game/gameplay/rpg/narrative/approveDirectorProposal.ts` | 导演提案规则批准 |
| `src/game/gameplay/rpg/narrative/approveSceneScript.ts` | 编剧剧本和 NPC 输出规则批准 |
| `src/game/gameplay/rpg/narrative/fallbackNarrativeScene.ts` | 零 AI 的完整场景 fallback |
| `src/game/gameplay/rpg/narrative/index.ts` | narrative gameplay public facade |
| `src/game/application/runtimeNarrative.ts` | 三角色 source 契约、失败类别、request/attempt 类型 |
| `src/game/application/runtimeNarrativeContexts.ts` | director/writer/NPC 最小上下文投影 |
| `src/game/application/orchestrateRuntimeNarrative.ts` | 三调用顺序、批准、fallback |
| `src/game/application/server/ai/runtimeNarrativePrompt.ts` | 三角色 prompt 构造 |
| `src/game/application/server/ai/runtimeNarrativeResponseFormat.ts` | 三角色 strict JSON schema |
| `src/game/application/server/ai/liveRuntimeNarrativeSources.ts` | 三个真实 source |
| `src/game/application/server/ai/fixtureRuntimeNarrativeSources.ts` | 离线成功、越权、泄漏 fixture source |
| `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts` | env、transport 和 unavailable source 装配 |
| `src/game/application/server/ai/runtimeNarrativeAudit.ts` | 脱敏逐角色审计 |
| `src/components/NarrativeScenePanel.tsx` | 场景叙事、NPC 台词、两个 token 按钮 |
| `scripts/phase10RuntimeAiSmoke.mjs` | opt-in 真实最小链路 smoke |

### Task 1: Narrative domain state 与旧存档默认值

**Files:**
- Create: `src/game/domain/narrative.ts`
- Create: `src/game/domain/narrative.test.ts`
- Modify: `src/game/domain/gameState.ts`
- Modify: `src/game/domain/index.ts`
- Modify: `src/game/gameplay/rpg/scenario/compileScenarioBlueprint.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Modify: `src/game/application/server/persistence/sqliteGameRepository.test.ts`

**Interfaces:**
- Produces: `NarrativeRuntimeState`, `NarrativeSceneState`, `NarrativeChoiceState`, `NarrativeNpcLineState`, `NarrativeEmotion`.
- `GameState.narrative` is always present after initialization or repository migration.
- Keep `stateVersion: 1`; the repository adds `{ currentScene: null }` to legacy state JSON exactly like existing additive Phase 4–6 defaults.

- [ ] **Step 1: Write failing domain tests**

```ts
import { describe, expect, it } from "vitest";
import type { NarrativeSceneState } from "./narrative";

describe("NarrativeSceneState", () => {
  it("requires exactly two approved choices", () => {
    const scene = {
      sceneId: "scene-1",
      turn: 1,
      narration: "雨声压低了酒馆里的交谈。",
      usedFactIds: [],
      npcLine: null,
      choices: [
        { choiceToken: "scene-1:a", label: "询问掌柜", actionKey: "talk:npc_1" },
        { choiceToken: "scene-1:b", label: "检查角落", actionKey: "investigate:fact_1" }
      ],
      source: "generated"
    } satisfies NarrativeSceneState;
    expect(scene.choices).toHaveLength(2);
  });
});
```

Add an initialization assertion to `compileScenarioBlueprint.test.ts`:

```ts
expect(state.narrative).toEqual({ currentScene: null });
```

Add a repository legacy-read test whose `state_json` omits `narrative` and assert:

```ts
expect(result.status).toBe("active");
if (result.status === "active") {
  expect(result.record.state.narrative).toEqual({ currentScene: null });
}
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
npx vitest run src/game/domain/narrative.test.ts src/game/gameplay/rpg/scenario/compileScenarioBlueprint.test.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
```

Expected: FAIL because narrative types and `GameState.narrative` do not exist.

- [ ] **Step 3: Add the domain types**

Create `src/game/domain/narrative.ts`:

```ts
import type { FactId, NpcId } from "./scenarioBlueprint";

export const NARRATIVE_EMOTIONS = [
  "neutral", "warm", "guarded", "afraid", "angry", "sad"
] as const;
export type NarrativeEmotion = (typeof NARRATIVE_EMOTIONS)[number];

export type NarrativeChoiceState = {
  readonly choiceToken: string;
  readonly label: string;
  readonly actionKey: string;
};

export type NarrativeNpcLineState = {
  readonly npcId: NpcId;
  readonly text: string;
  readonly emotion: NarrativeEmotion;
  readonly usedFactIds: readonly FactId[];
};

export type NarrativeSceneState = {
  readonly sceneId: string;
  readonly turn: number;
  readonly narration: string;
  readonly usedFactIds: readonly FactId[];
  readonly npcLine: NarrativeNpcLineState | null;
  readonly choices: readonly [NarrativeChoiceState, NarrativeChoiceState];
  readonly source: "generated" | "fallback";
};

export type NarrativeRuntimeState = {
  readonly currentScene: NarrativeSceneState | null;
};
```

Export these types from `src/game/domain/index.ts`, add
`readonly narrative: NarrativeRuntimeState` to `GameState`, and initialize:

```ts
narrative: { currentScene: null },
```

In `sqliteGameRepository.ts`, extend the existing additive state-default chain with:

```ts
function withNarrativeDefault(state: Record<string, unknown>): Record<string, unknown> {
  if (state["narrative"] !== undefined) return state;
  return { ...state, narrative: { currentScene: null } };
}
```

Apply it before casting the parsed state to `GameState`.

- [ ] **Step 4: Run focused tests**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/domain/narrative.ts src/game/domain/narrative.test.ts src/game/domain/gameState.ts src/game/domain/index.ts src/game/gameplay/rpg/scenario/compileScenarioBlueprint.ts src/game/application/server/persistence/sqliteGameRepository.ts src/game/application/server/persistence/sqliteGameRepository.test.ts
git commit -m "feat: add narrative runtime state"
```

### Task 2: Action keys 与纯规则批准

**Files:**
- Create: `src/game/gameplay/rpg/narrative/actionCandidates.ts`
- Create: `src/game/gameplay/rpg/narrative/actionCandidates.test.ts`
- Create: `src/game/gameplay/rpg/narrative/approveDirectorProposal.ts`
- Create: `src/game/gameplay/rpg/narrative/approveDirectorProposal.test.ts`
- Create: `src/game/gameplay/rpg/narrative/approveSceneScript.ts`
- Create: `src/game/gameplay/rpg/narrative/approveSceneScript.test.ts`
- Create: `src/game/gameplay/rpg/narrative/index.ts`
- Modify: `src/dependencyBoundaries.test.ts`

**Interfaces:**
- Produces `NarrativeActionCandidate`, `toNarrativeActionCandidates`, `findAvailableActionByKey`.
- Produces `approveDirectorProposal(input)` and `approveSceneScript(input)`.
- Consumes `DirectorProposal` and `SceneScriptProposal` from Task 3; use type-only imports from application is forbidden, so define proposal data types in this folder and re-export them through the gameplay facade. Task 3 aliases its source outputs to these pure proposal types.

- [ ] **Step 1: Write failing action-key tests**

```ts
it("creates stable unique keys without exposing them to the UI layer", () => {
  const candidates = toNarrativeActionCandidates([
    { type: "talk", npcId: asNpcId("npc_1"), label: "与掌柜交谈" },
    { type: "investigate", factId: asFactId("fact_1"), label: "调查线索" }
  ]);
  expect(candidates.map((entry) => entry.actionKey)).toEqual([
    "talk:npc_1",
    "investigate:fact_1"
  ]);
});

it("only resolves a key from the current available action list", () => {
  expect(findAvailableActionByKey(actions, "talk:npc_1")).toEqual(actions[0]);
  expect(findAvailableActionByKey(actions, "talk:npc_hidden")).toBeNull();
});
```

- [ ] **Step 2: Write failing approval tests**

Director test:

```ts
const result = approveDirectorProposal({
  proposal: {
    sceneGoal: "让玩家注意到掌柜的回避",
    tensionLevel: 2,
    focusNpcId: "npc_1",
    relevantFactIds: ["fact_1"],
    allowedRevealFactIds: ["fact_1"],
    suggestedActionKeys: ["talk:npc_1", "investigate:fact_1"],
    introducedEntities: [{ kind: "npc", id: "npc_1" }],
    pacing: "develop"
  },
  blueprint,
  state,
  candidates
});
expect(result.ok).toBe(true);
```

Add rejection assertions for:

```ts
expect(approve({ focusNpcId: "npc_not_present" })).toMatchObject({ ok: false });
expect(approve({ allowedRevealFactIds: ["fact_undiscovered"] })).toMatchObject({ ok: false });
expect(approve({ suggestedActionKeys: ["talk:npc_1", "talk:npc_1"] })).toMatchObject({ ok: false });
expect(approve({ suggestedActionKeys: ["talk:npc_1", "move:loc_hidden"] })).toMatchObject({ ok: false });
```

Writer test:

```ts
expect(approveSceneScript({
  proposal: validScript,
  plan: approvedPlan,
  blueprint
})).toMatchObject({ ok: true });

expect(approveSceneScript({
  proposal: {
    ...validScript,
    npcInstruction: {
      ...validScript.npcInstruction!,
      allowedFactIds: ["fact_unknown_to_npc"]
    }
  },
  plan: approvedPlan,
  blueprint
})).toMatchObject({ ok: false, category: "knowledge_scope_violation" });
```

- [ ] **Step 3: Run tests and verify failure**

```bash
npx vitest run src/game/gameplay/rpg/narrative
```

Expected: FAIL because the narrative gameplay facade does not exist.

- [ ] **Step 4: Implement stable action keys**

Use the exact closed mapping:

```ts
export function actionKeyOf(action: AvailableAction): string {
  switch (action.type) {
    case "observe": return `observe:${action.locationId}`;
    case "talk": return `talk:${action.npcId}`;
    case "investigate": return `investigate:${action.factId}`;
    case "move": return `move:${action.locationId}`;
    case "take_item": return `take_item:${action.itemId}`;
    case "start_battle": return `start_battle:${action.enemyId}`;
    case "battle_action": return `battle_action:${action.action}`;
  }
}

export function toNarrativeActionCandidates(
  actions: readonly AvailableAction[]
): readonly NarrativeActionCandidate[] {
  return actions.map((action) => ({
    actionKey: actionKeyOf(action),
    kind: action.type,
    publicLabel: action.label
  }));
}

export function findAvailableActionByKey(
  actions: readonly AvailableAction[],
  actionKey: string
): AvailableAction | null {
  return actions.find((action) => actionKeyOf(action) === actionKey) ?? null;
}
```

- [ ] **Step 5: Implement collect-all approvals**

Define stable issue categories:

```ts
export type NarrativeApprovalCategory =
  | "schema_violation"
  | "reference_broken"
  | "knowledge_scope_violation"
  | "choice_not_legal";
```

Both approval functions must construct new approved objects field by field and never return the AI object by reference. Count Unicode code points using:

```ts
const codePointLength = (value: string) => Array.from(value).length;
```

Director approval checks the exact rules in Spec §5.2. Writer approval checks Spec §5.4 and returns `ApprovedSceneScript`.

- [ ] **Step 6: Add narrative facade boundary coverage**

Export only public types and functions from `src/game/gameplay/rpg/narrative/index.ts`. Add `gameplay/rpg/narrative` to the existing facade/deep-import boundary test alongside actions, quests, scenario and battle.

- [ ] **Step 7: Run focused and boundary tests**

```bash
npx vitest run src/game/gameplay/rpg/narrative src/dependencyBoundaries.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/game/gameplay/rpg/narrative src/dependencyBoundaries.test.ts
git commit -m "feat: approve runtime narrative proposals"
```

### Task 3: 三角色 application contracts 与最小上下文

**Files:**
- Create: `src/game/application/runtimeNarrative.ts`
- Create: `src/game/application/runtimeNarrative.test.ts`
- Create: `src/game/application/runtimeNarrativeContexts.ts`
- Create: `src/game/application/runtimeNarrativeContexts.test.ts`
- Modify: `src/game/application/index.ts`

**Interfaces:**
- Produces `WorldDirectorSource.propose`, `SceneWriterSource.write`, `NpcPerformerSource.perform`.
- Produces `buildWorldDirectorRequest`, `buildSceneWriterRequest`, `buildNpcPerformanceRequest`.
- Consumes approved proposal types from `@/game/gameplay/rpg/narrative`.

- [ ] **Step 1: Write contract tests**

Assert the stable role and failure sets:

```ts
expect(RUNTIME_NARRATIVE_ROLES).toEqual(["director", "writer", "npc"]);
expect(RUNTIME_NARRATIVE_FAILURE_CATEGORIES).toEqual([
  "unavailable", "timeout", "rate_limited", "service_error",
  "invalid_json", "schema_violation", "reference_broken",
  "knowledge_scope_violation", "choice_not_legal", "empty_response"
]);
```

Assert each source accepts only its own request:

```ts
const director: WorldDirectorSource = { propose: vi.fn() };
const writer: SceneWriterSource = { write: vi.fn() };
const npc: NpcPerformerSource = { perform: vi.fn() };
expect(director.propose).not.toBe(writer.write);
expect(writer.write).not.toBe(npc.perform);
```

- [ ] **Step 2: Write negative context tests**

Build a blueprint containing:

- `npc_1.knownFactIds = ["fact_public"]`;
- `npc_2.knownFactIds = ["fact_other_secret"]`;
- world facts `fact_public`, `fact_unknown`, `fact_other_secret`.

Then assert:

```ts
const request = buildNpcPerformanceRequest(input);
const serialized = JSON.stringify(request);
expect(serialized).toContain("公开事实正文");
expect(serialized).not.toContain("NPC 不知道的幕后真相");
expect(serialized).not.toContain("另一名 NPC 的秘密");
expect(serialized).not.toContain("sceneGoal");
expect(serialized).not.toContain("ending");
expect(serialized).not.toContain("attack");
expect(serialized).not.toContain("defense");
```

Writer assertions:

```ts
const serialized = JSON.stringify(buildSceneWriterRequest(input));
expect(serialized).toContain(approvedPlan.sceneGoal);
expect(serialized).not.toContain("AI_API_KEY");
expect(serialized).not.toContain("GAME_DB_PATH");
expect(serialized).not.toContain("playerHp");
expect(serialized).not.toContain("enemyHp");
```

- [ ] **Step 3: Run tests and verify failure**

```bash
npx vitest run src/game/application/runtimeNarrative.test.ts src/game/application/runtimeNarrativeContexts.test.ts
```

Expected: FAIL because contracts and projectors do not exist.

- [ ] **Step 4: Implement contracts**

Use:

```ts
export const RUNTIME_NARRATIVE_CONTRACT_VERSION = "phase10-v1" as const;
export const RUNTIME_NARRATIVE_ROLES = ["director", "writer", "npc"] as const;

export type RuntimeNarrativeAttempt<T> =
  | Readonly<{ ok: true; origin: "fixture" | "live"; value: T; diagnostics: readonly string[] }>
  | Readonly<{
      ok: false;
      origin: "fixture" | "live" | "unavailable";
      category: RuntimeNarrativeFailureCategory;
      diagnostics: readonly string[];
    }>;

export interface WorldDirectorSource {
  propose(request: WorldDirectorRequest): Promise<RuntimeNarrativeAttempt<DirectorProposal>>;
}
export interface SceneWriterSource {
  write(request: SceneWriterRequest): Promise<RuntimeNarrativeAttempt<SceneScriptProposal>>;
}
export interface NpcPerformerSource {
  perform(request: NpcPerformanceRequest): Promise<RuntimeNarrativeAttempt<NpcPerformanceProposal>>;
}
```

The three request types are closed readonly object types, not a common bag with optional fields.

- [ ] **Step 5: Implement explicit context projectors**

Projectors must build each object field by field. For NPC facts use the exact intersection:

```ts
const allowed = new Set(instruction.allowedFactIds);
const known = new Set(npc.knownFactIds.map(String));
const facts = blueprint.world.facts
  .filter((fact) => allowed.has(String(fact.id)) && known.has(String(fact.id)))
  .map((fact) => ({ id: String(fact.id), text: fact.text }));
```

Never build an NPC request with `{ ...blueprint }`, `{ ...state }`, serialized GameRecord or a shared “all context” helper.

- [ ] **Step 6: Run focused tests**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/game/application/runtimeNarrative.ts src/game/application/runtimeNarrative.test.ts src/game/application/runtimeNarrativeContexts.ts src/game/application/runtimeNarrativeContexts.test.ts src/game/application/index.ts
git commit -m "feat: define least-privilege narrative AI ports"
```

### Task 4: Orchestrator 与完整 fallback

**Files:**
- Create: `src/game/gameplay/rpg/narrative/fallbackNarrativeScene.ts`
- Create: `src/game/gameplay/rpg/narrative/fallbackNarrativeScene.test.ts`
- Create: `src/game/application/orchestrateRuntimeNarrative.ts`
- Create: `src/game/application/orchestrateRuntimeNarrative.test.ts`
- Modify: `src/game/gameplay/rpg/narrative/index.ts`
- Modify: `src/game/application/index.ts`

**Interfaces:**
- Produces `generateRuntimeNarrativeScene(input, deps): Promise<NarrativeSceneState | null>`.
- `deps` contains three independent sources, `newSceneId`, `newChoiceToken`, `newTraceId`.
- Returns null for ending, active battle, or fewer than two legal non-battle candidates.

- [ ] **Step 1: Write failing orchestration-order test**

```ts
const calls: string[] = [];
const scene = await generateRuntimeNarrativeScene(input, {
  director: { propose: async () => { calls.push("director"); return directorSuccess; } },
  writer: { write: async () => { calls.push("writer"); return writerSuccess; } },
  npc: { perform: async () => { calls.push("npc"); return npcSuccess; } },
  newSceneId: () => "scene-1",
  newChoiceToken: (slot) => `scene-1:${slot}`,
  newTraceId: () => "trace-1"
});
expect(calls).toEqual(["director", "writer", "npc"]);
expect(scene?.choices).toHaveLength(2);
```

Add tests:

```ts
expect(await generateRuntimeNarrativeScene(battleInput, deps)).toBeNull();
expect(await generateRuntimeNarrativeScene(oneActionInput, deps)).toBeNull();
```

- [ ] **Step 2: Write failing all-or-nothing fallback tests**

For director failure, writer rejection and NPC knowledge violation assert:

```ts
expect(result?.source).toBe("fallback");
expect(result?.choices.map((choice) => choice.actionKey)).toEqual(
  candidates.slice(0, 2).map((candidate) => candidate.actionKey)
);
expect(result?.narration).not.toContain("AI 原始失败文本");
```

Also assert that writer success is discarded when NPC fails; no AI narration is combined with fallback NPC text.

- [ ] **Step 3: Run tests and verify failure**

```bash
npx vitest run src/game/gameplay/rpg/narrative/fallbackNarrativeScene.test.ts src/game/application/orchestrateRuntimeNarrative.test.ts
```

Expected: FAIL because orchestrator and fallback do not exist.

- [ ] **Step 4: Implement deterministic fallback**

Select the first two stable non-battle candidates from `projectAvailableActions`; create labels from their existing public labels and a neutral narration based only on current location:

```ts
return {
  sceneId,
  turn,
  narration: `你在${currentLocation.name}整理眼前的线索，下一步仍由你决定。`,
  usedFactIds: [],
  npcLine: null,
  choices: [
    { choiceToken: tokenA, label: candidates[0].publicLabel, actionKey: candidates[0].actionKey },
    { choiceToken: tokenB, label: candidates[1].publicLabel, actionKey: candidates[1].actionKey }
  ],
  source: "fallback"
};
```

- [ ] **Step 5: Implement strict orchestration**

Use this sequence:

```ts
director attempt
→ approveDirectorProposal
→ writer attempt
→ approveSceneScript
→ if npcInstruction !== null, npc attempt and fact/emotion approval
→ construct a new NarrativeSceneState field by field
```

On any failed attempt, thrown error, rejected approval or invalid NPC output, call `createFallbackNarrativeScene` once. Do not retry in Phase 10 and do not combine successful partial output with fallback.

- [ ] **Step 6: Run focused tests**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/game/gameplay/rpg/narrative/fallbackNarrativeScene.ts src/game/gameplay/rpg/narrative/fallbackNarrativeScene.test.ts src/game/gameplay/rpg/narrative/index.ts src/game/application/orchestrateRuntimeNarrative.ts src/game/application/orchestrateRuntimeNarrative.test.ts src/game/application/index.ts
git commit -m "feat: orchestrate runtime narrative roles"
```

### Task 5: 初始场景与 narrative_choice 原子规则链

**Files:**
- Modify: `src/game/application/createGame.ts`
- Modify: `src/game/application/createGame.test.ts`
- Modify: `src/game/gameplay/rpg/actions/intents.ts`
- Modify: `src/game/application/performAction.ts`
- Modify: `src/game/application/performAction.test.ts`
- Modify: `src/game/application/performActionSqlite.test.ts`
- Modify: `src/game/gameplay/rpg/actions/validateIntent.ts`
- Modify: `src/game/gameplay/rpg/actions/resolveAction.ts`

**Interfaces:**
- Adds `PlayerIntent` member `{ type: "narrative_choice"; choiceToken: string }`.
- `createGame` receives a `generateNarrativeScene` dependency and saves an initial scene before its single initial write.
- `performAction` resolves token → current action key → current `AvailableAction` before invoking existing resolver logic.

- [ ] **Step 1: Write failing create-game test**

```ts
expect(generateNarrativeScene).toHaveBeenCalledOnce();
expect(repository.createInitialGame).toHaveBeenCalledWith(expect.objectContaining({
  state: expect.objectContaining({
    narrative: {
      currentScene: expect.objectContaining({
        sceneId: "scene-initial",
        choices: expect.any(Array)
      })
    }
  })
}));
```

Add a contract-boundary failure test in which the injected generator unexpectedly throws; assert `createGame` still performs one initial save with `narrative.currentScene: null` and does not leave a half-created record.

- [ ] **Step 2: Write failing choice tests**

Valid:

```ts
const result = await performAction({
  intent: { type: "narrative_choice", choiceToken: "scene-1:a" },
  expectedRevision: 3
}, deps);
expect(result.ok).toBe(true);
expect(repository.applyResolvedAction).toHaveBeenCalledOnce();
```

Tampered and stale:

```ts
expect(await choose("forged-token")).toMatchObject({
  ok: false, code: "ACTION_REJECTED"
});
expect(repository.applyResolvedAction).not.toHaveBeenCalled();
```

Atomicity:

```ts
expect(saved.nextState.eventLedger).toContainEqual(
  expect.objectContaining({ type: "npc_met" })
);
expect(saved.nextState.narrative.currentScene?.sceneId).toBe("scene-next");
```

- [ ] **Step 3: Run focused tests and verify failure**

```bash
npx vitest run src/game/application/createGame.test.ts src/game/application/performAction.test.ts src/game/application/performActionSqlite.test.ts
```

Expected: FAIL because `narrative_choice` and narrative dependencies do not exist.

- [ ] **Step 4: Add the intent without routing it through resolveAction**

Extend `PlayerIntent`:

```ts
| { readonly type: "narrative_choice"; readonly choiceToken: string }
```

`validateIntent` and `resolveAction` return `INTENT_NOT_ROUTED` for this type. `performAction` must intercept it before the existing resolver switch.

- [ ] **Step 5: Resolve token to a current legal action**

In `performAction`:

```ts
const currentScene = record.state.narrative.currentScene;
const choice = currentScene?.choices.find(
  (entry) => entry.choiceToken === command.intent.choiceToken
);
if (choice === undefined) return rejected("该剧情选项已失效。");

const available = projectAvailableActions(record.blueprint, record.state);
const selected = findAvailableActionByKey(available, choice.actionKey);
if (selected === null) return rejected("该剧情选项当前不可执行。");
```

Convert `selected` to the existing `PlayerIntent` closed union with a switch, then run the unchanged action/battle resolver, quest reconciliation and ending resolution.

- [ ] **Step 6: Generate the next scene before the single CAS**

After deterministic rule resolution and ending resolution:

```ts
const narrativeScene =
  nextState.ending !== null || nextState.battle.status === "active"
    ? null
    : await deps.generateNarrativeScene({
        blueprint: record.blueprint,
        state: nextState,
        turn: (currentScene?.turn ?? 0) + 1
      });

nextState = {
  ...nextState,
  narrative: { currentScene: narrativeScene }
};
```

Wrap the generator call so an unexpected contract-level throw becomes `narrativeScene = null`; the already computed legal rule result must still reach the single CAS. Keep one `applyResolvedAction` call with the original expected revision. If CAS returns stale, discard the generated scene and return stale without a second AI call.

- [ ] **Step 7: Generate the initial scene before createInitialGame**

After `initializeGameState`, call the injected generator with turn 1, merge the returned scene into narrative, then pass that state to the existing single `createInitialGame`.

- [ ] **Step 8: Run focused tests**

Run the Step 3 command.

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/game/application/createGame.ts src/game/application/createGame.test.ts src/game/gameplay/rpg/actions/intents.ts src/game/application/performAction.ts src/game/application/performAction.test.ts src/game/application/performActionSqlite.test.ts src/game/gameplay/rpg/actions/validateIntent.ts src/game/gameplay/rpg/actions/resolveAction.ts
git commit -m "feat: advance approved narrative choices"
```

### Task 6: Live/fixture sources、structured output 与脱敏审计

**Files:**
- Create: `src/game/application/server/ai/runtimeNarrativePrompt.ts`
- Create: `src/game/application/server/ai/runtimeNarrativePrompt.test.ts`
- Create: `src/game/application/server/ai/runtimeNarrativeResponseFormat.ts`
- Create: `src/game/application/server/ai/runtimeNarrativeResponseFormat.test.ts`
- Create: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Create: `src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts`
- Create: `src/game/application/server/ai/fixtureRuntimeNarrativeSources.ts`
- Create: `src/game/application/server/ai/fixtureRuntimeNarrativeSources.test.ts`
- Create: `src/game/application/server/ai/runtimeNarrativeAudit.ts`
- Create: `src/game/application/server/ai/runtimeNarrativeAudit.test.ts`
- Create: `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts`
- Create: `src/game/application/server/ai/runtimeNarrativeSourceFactory.test.ts`
- Modify: `src/game/application/server/compositionRoot.ts`
- Modify: `src/game/application/server/compositionRoot.test.ts`

**Interfaces:**
- Produces three live sources backed by one existing transport instance.
- Produces three independent strict schemas and prompt builders.
- Factory returns `{ director, writer, npc }`; invalid env returns three unavailable sources.

- [ ] **Step 1: Write prompt separation tests**

```ts
expect(buildDirectorMessages(directorRequest)).toContainEqual(
  expect.objectContaining({ role: "system" })
);
expect(JSON.stringify(buildNpcMessages(npcRequest))).not.toContain("幕后真相");
expect(JSON.stringify(buildNpcMessages(npcRequest))).not.toContain("sceneGoal");
expect(JSON.stringify(buildWriterMessages(writerRequest))).toContain("sceneGoal");
```

Assert every builder returns a different system instruction and contains its contract version.

- [ ] **Step 2: Write strict-schema tests**

Assert:

```ts
expect(DIRECTOR_RESPONSE_SCHEMA.additionalProperties).toBe(false);
expect(WRITER_RESPONSE_SCHEMA.additionalProperties).toBe(false);
expect(NPC_RESPONSE_SCHEMA.additionalProperties).toBe(false);
expect(WRITER_RESPONSE_SCHEMA.properties.choices.minItems).toBe(2);
expect(WRITER_RESPONSE_SCHEMA.properties.choices.maxItems).toBe(2);
```

- [ ] **Step 3: Write live-source and audit tests**

Use an injected fake transport and assert three distinct requests:

```ts
await sources.director.propose(directorRequest);
await sources.writer.write(writerRequest);
await sources.npc.perform(npcRequest);
expect(transport.complete).toHaveBeenCalledTimes(3);
```

Audit serialization must satisfy:

```ts
const serialized = JSON.stringify(entries);
for (const forbidden of [
  "AI_API_KEY", "Authorization", "prompt", "rawResponse",
  "公开事实正文", "幕后真相", "https://provider.example"
]) {
  expect(serialized).not.toContain(forbidden);
}
```

- [ ] **Step 4: Run tests and verify failure**

```bash
npx vitest run src/game/application/server/ai/runtimeNarrative
```

If the shell glob does not match on Windows, run:

```bash
npx vitest run src/game/application/server/ai/runtimeNarrativePrompt.test.ts src/game/application/server/ai/runtimeNarrativeResponseFormat.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts src/game/application/server/ai/fixtureRuntimeNarrativeSources.test.ts src/game/application/server/ai/runtimeNarrativeAudit.test.ts src/game/application/server/ai/runtimeNarrativeSourceFactory.test.ts
```

Expected: FAIL because runtime narrative server adapters do not exist.

- [ ] **Step 5: Implement prompt and schemas**

Use three independent message builders. The NPC builder accepts only `NpcPerformanceRequest`; do not pass blueprint/state and redact nothing after serialization because forbidden fields must never be present before prompt construction.

Use the existing Phase 4C output-format helper pattern:

```ts
json_schema → role-specific strict response_format
json_object → { type: "json_object" }
prompt_only → no response_format
```

- [ ] **Step 6: Implement sources and stable error mapping**

Each source:

1. builds its own messages;
2. calls injected `@ai-game/ai-transport` public API;
3. parses one JSON object;
4. maps provider/parse errors to `RuntimeNarrativeFailureCategory`;
5. returns no raw error text in diagnostics;
6. emits one sanitized audit entry.

Do not add retries in Phase 10.

- [ ] **Step 7: Implement factory and composition root wiring**

Reuse `parseAiRuntimeConfig(env)` and create one transport. Inject the three sources into one `generateRuntimeNarrativeScene` closure, and inject that closure into both `createGame` and `performAction`. UUID providers create trace, scene and choice tokens server-side.

- [ ] **Step 8: Run focused tests**

Run the explicit Step 4 command.

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/game/application/server/ai/runtimeNarrativePrompt.ts src/game/application/server/ai/runtimeNarrativePrompt.test.ts src/game/application/server/ai/runtimeNarrativeResponseFormat.ts src/game/application/server/ai/runtimeNarrativeResponseFormat.test.ts src/game/application/server/ai/liveRuntimeNarrativeSources.ts src/game/application/server/ai/liveRuntimeNarrativeSources.test.ts src/game/application/server/ai/fixtureRuntimeNarrativeSources.ts src/game/application/server/ai/fixtureRuntimeNarrativeSources.test.ts src/game/application/server/ai/runtimeNarrativeAudit.ts src/game/application/server/ai/runtimeNarrativeAudit.test.ts src/game/application/server/ai/runtimeNarrativeSourceFactory.ts src/game/application/server/ai/runtimeNarrativeSourceFactory.test.ts src/game/application/server/compositionRoot.ts src/game/application/server/compositionRoot.test.ts
git commit -m "feat: connect runtime narrative AI roles"
```

### Task 7: Safe read model、API 与两个固定选项 UI

**Files:**
- Modify: `src/game/application/gameSessionView.ts`
- Modify: `src/game/application/gameSessionView.test.ts`
- Modify: `src/app/api/game/actions/actionHandler.ts`
- Modify: `src/app/api/game/actions/actionHandler.test.ts`
- Modify: `src/components/gameActionRequest.ts`
- Create: `src/components/NarrativeScenePanel.tsx`
- Create: `src/components/NarrativeScenePanel.test.tsx`
- Modify: `src/components/AdventureGameShell.tsx`
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/components/CurrentGameScreen.test.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Adds `GameSessionView.narrativeScene: NarrativeSceneView | null`.
- Adds action payload `{ intent: { type: "narrative_choice"; choiceToken }, revision }`.
- Narrative UI never receives `actionKey`, fact IDs, source or diagnostics.

- [ ] **Step 1: Write failing zero-leak projection test**

```ts
const view = projectGameSessionView(inputWithNarrativeScene);
expect(view.narrativeScene).toEqual({
  narration: "雨声压低了酒馆里的交谈。",
  npcLine: {
    npcId: "npc_1",
    name: "陆掌柜",
    text: "矿井的事，我知道得不多。",
    emotion: "guarded"
  },
  choices: [
    { choiceToken: "scene-1:a", label: "继续追问" },
    { choiceToken: "scene-1:b", label: "检查登记册" }
  ]
});
const serialized = JSON.stringify(view.narrativeScene);
expect(serialized).not.toContain("actionKey");
expect(serialized).not.toContain("usedFactIds");
expect(serialized).not.toContain("generated");
```

- [ ] **Step 2: Write failing API whitelist tests**

Valid:

```ts
await request({
  intent: { type: "narrative_choice", choiceToken: "scene-1:a" },
  revision: 7
});
expect(entryPoints.performAction).toHaveBeenCalledWith({
  intent: { type: "narrative_choice", choiceToken: "scene-1:a" },
  expectedRevision: 7
});
```

Invalid:

```ts
expect(await request({
  intent: {
    type: "narrative_choice",
    choiceToken: "scene-1:a",
    actionKey: "take_item:item_secret"
  },
  revision: 7
})).toHaveProperty("status", 400);
```

- [ ] **Step 3: Write failing UI tests**

```tsx
render(<NarrativeScenePanel scene={scene} revision={7} onSuccess={onSuccess} onStale={onStale} />);
expect(screen.getAllByRole("button")).toHaveLength(2);
await userEvent.click(screen.getByRole("button", { name: "继续追问" }));
expect(JSON.parse(String(request.body))).toEqual({
  intent: { type: "narrative_choice", choiceToken: "scene-1:a" },
  revision: 7
});
```

Add:

```ts
expect(twoButtons.every((button) => button.disabled)).toBe(true);
```

while the request is pending, and root route tests for:

- ending wins over narrative;
- battle wins over narrative;
- narrative wins over ordinary map interactions;
- null narrative keeps existing AdventureGameShell behavior.

- [ ] **Step 4: Run focused tests and verify failure**

```bash
npx vitest run src/game/application/gameSessionView.test.ts src/app/api/game/actions/actionHandler.test.ts src/components/NarrativeScenePanel.test.tsx src/components/AdventureGameShell.test.tsx src/components/CurrentGameScreen.test.tsx
```

Expected: FAIL because safe narrative projection and UI do not exist.

- [ ] **Step 5: Implement safe projection and API**

Project names by resolving `npcId` against the compiled blueprint. Throw on dangling references. Return only the exact `NarrativeSceneView` fields from Spec §4.2.

Extend API intent fields with `choiceToken`, update the target-field map:

```ts
narrative_choice: ["choiceToken"]
```

and reject all other target fields.

- [ ] **Step 6: Implement NarrativeScenePanel**

Render narration in a labelled region, optional NPC line, and exactly two buttons. `postGameAction` remains the only fetch helper. Do not show IDs, AI role names, source or provider failures.

- [ ] **Step 7: Integrate routing and CSS**

Inside the non-battle/non-ending `AdventureGameShell`, render `NarrativeScenePanel` as the active location content when `narrativeScene !== null`; otherwise keep the existing map/location flow unchanged. Add responsive RPG-only classes in `globals.css`.

- [ ] **Step 8: Run focused tests**

Run the Step 4 command.

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts src/app/api/game/actions/actionHandler.ts src/app/api/game/actions/actionHandler.test.ts src/components/gameActionRequest.ts src/components/NarrativeScenePanel.tsx src/components/NarrativeScenePanel.test.tsx src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx src/components/CurrentGameScreen.test.tsx src/app/globals.css
git commit -m "feat: play approved AI narrative choices"
```

### Task 8: 离线权限回归与真实 opt-in smoke

**Files:**
- Create: `data/fixtures/phase10/manifest.json`
- Create: `data/fixtures/phase10/director-valid.json`
- Create: `data/fixtures/phase10/writer-valid.json`
- Create: `data/fixtures/phase10/npc-valid.json`
- Create: `data/fixtures/phase10/npc-unknown-fact.json`
- Create: `data/fixtures/phase10/writer-illegal-choice.json`
- Create: `src/game/application/phase10RuntimeNarrativeRegression.test.ts`
- Create: `scripts/phase10RuntimeAiSmoke.mjs`
- Create: `scripts/phase10RuntimeAiSmoke.node-test.mjs`
- Modify: `package.json`

**Interfaces:**
- Offline regression is the authoritative daily journey.
- Smoke is opt-in and emits only sanitized role summaries.

- [ ] **Step 1: Write the failing offline journey**

For 武侠、科幻、都市 fixtures:

```ts
it.each(["wuxia", "sci_fi", "urban"] as const)(
  "%s: initial scene → choose token → next scene → reload",
  async (gameType) => {
    const created = await createFixtureGame(gameType);
    expect(created.view.narrativeScene?.choices).toHaveLength(2);
    const token = created.view.narrativeScene!.choices[0].choiceToken;
    const advanced = await choose(token, created.view.revision);
    expect(advanced.ok).toBe(true);
    expect(advanced.view.narrativeScene?.choices).toHaveLength(2);
    expect(await reload()).toEqual(advanced.view);
  }
);
```

Add exact assertions:

- npc recorder payload excludes unknown and other-NPC fact text;
- malicious NPC fixture produces full fallback;
- writer illegal choice produces full fallback;
- tampered token and stale revision produce zero writes;
- selected token applies the underlying action once;
- AI unavailable and generated routes produce identical deterministic rule state;
- battle and ending invoke no runtime narrative source.

- [ ] **Step 2: Run regression and verify failure**

```bash
npx vitest run src/game/application/phase10RuntimeNarrativeRegression.test.ts
```

Expected: FAIL because fixture data and regression helper are not complete.

- [ ] **Step 3: Add versioned fixtures and pass regression**

`manifest.json` records contract `phase10-v1`, each fixture filename, role, outcome and expected category. Raw provider responses are not fixtures; store only the parsed contract objects needed by fixture sources.

Run Step 2.

Expected: PASS.

- [ ] **Step 4: Write smoke-script guard tests**

Assert:

```ts
expect(runWithoutOptIn.exitCode).toBe(0);
expect(runWithoutOptIn.stdout).toContain("skipped");
expect(runWithoutOptIn.transportCalls).toBe(0);
```

Also assert the summary whitelist contains only:

```text
role, generated, fallback, category, latencyMs, inputTokens, outputTokens
```

- [ ] **Step 5: Implement the opt-in smoke**

Add scripts:

```json
{
  "test:phase10-ai-smoke-script": "node --test scripts/phase10RuntimeAiSmoke.node-test.mjs",
  "smoke:ai:phase10": "node scripts/phase10RuntimeAiSmoke.mjs"
}
```

The script must:

1. skip unless `RUN_REAL_AI_RUNTIME_SMOKE=1`;
2. use a temporary SQLite path;
3. create one legal game;
4. assert two initial choices;
5. choose the first token;
6. reload the next scene;
7. print sanitized role summaries;
8. close the repository in `finally`;
9. never print prompt, response, player input, URL, model, key or fact text.

- [ ] **Step 6: Run offline smoke tests**

```bash
npm run test:phase10-ai-smoke-script
npx vitest run src/game/application/phase10RuntimeNarrativeRegression.test.ts
```

Expected: PASS with zero real network calls.

- [ ] **Step 7: Commit**

```bash
git add data/fixtures/phase10 src/game/application/phase10RuntimeNarrativeRegression.test.ts scripts/phase10RuntimeAiSmoke.mjs scripts/phase10RuntimeAiSmoke.node-test.mjs package.json
git commit -m "test: cover runtime AI narrative journey"
```

### Task 9: 文档、边界与最终验收

**Files:**
- Modify: `docs/agent/运行时AI导演与场景表演.md`
- Modify: `docs/agent/MVP核心闭环.md`
- Modify: `docs/agent/AI环境.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `docs/策划文档/AI生成RPG_MVP.md`
- Modify: `docs/agent/current-phase.json`
- Modify: `docs/agent/当前开发阶段.md`
- Modify: `src/dependencyBoundaries.test.ts`

**Interfaces:**
- Documents implementation facts only after every offline acceptance command passes.
- `current-phase.json` becomes implemented only after merge to main.

- [ ] **Step 1: Run a forbidden-context source scan**

```bash
rg -n "buildNpcPerformanceRequest|NpcPerformanceRequest" src/game/application src/game/application/server
rg -n "blueprint|GameState|GameRecord|ending|AI_API_KEY|GAME_DB_PATH" src/game/application/server/ai/runtimeNarrativePrompt.ts
```

Expected:

- NPC prompt builder consumes only `NpcPerformanceRequest`;
- no live source passes blueprint, state or record into NPC prompt construction;
- no client component imports runtime AI contracts.

- [ ] **Step 2: Run full offline acceptance**

```bash
npm run lint
npm run typecheck
npm test
npm run test:fast
npm run build
npm run phase:status
```

Expected: all exit 0; no real AI/image/network request.

- [ ] **Step 3: Run the optional real smoke only with explicit operator authorization**

```bash
RUN_REAL_AI_RUNTIME_SMOKE=1 npm run smoke:ai:phase10
```

On PowerShell:

```powershell
$env:RUN_REAL_AI_RUNTIME_SMOKE='1'
npm run smoke:ai:phase10
Remove-Item Env:RUN_REAL_AI_RUNTIME_SMOKE
```

Expected: generated or stable fallback for director/writer/npc, two initial choices, one successful choice, reload-consistent next scene, sanitized summary only.

- [ ] **Step 4: Update implementation facts**

Record:

- the three-source contract and context separation;
- no free input and no image calls;
- existing action resolver remains authoritative;
- exact offline test count;
- whether the real smoke was actually run;
- any role that fell back and its stable category without prompt/response details.

Do not claim real smoke execution if only fixture tests ran.

- [ ] **Step 5: Mark phase implemented after merge**

Update `current-phase.json`:

```json
{
  "schemaVersion": 1,
  "phase": "mvp-phase-10-runtime-ai-director",
  "status": "implemented",
  "implementationStatus": "implemented",
  "targetBranch": "codex/phase10-runtime-ai-director",
  "worktreeName": "phase10-runtime-ai-director",
  "repositories": ["ai-rpg-game"],
  "plan": "docs/superpowers/plans/2026-07-30-mvp-phase-10-runtime-ai-director.md",
  "sharedInfrastructureChangeAllowed": false,
  "startCommand": "npm run phase:start",
  "entryDocs": [
    "docs/游戏设计原则.md",
    "docs/游戏开发规范.md",
    "docs/Agent文档索引.md",
    "docs/agent/当前开发阶段.md",
    "docs/agent/运行时AI导演与场景表演.md",
    "docs/superpowers/specs/2026-07-30-runtime-ai-director-scene-performance-design.md",
    "docs/superpowers/plans/2026-07-30-mvp-phase-10-runtime-ai-director.md"
  ],
  "acceptanceCommands": [
    "npm run lint",
    "npm run typecheck",
    "npm test",
    "npm run test:fast",
    "npm run build",
    "npm run phase:status"
  ]
}
```

- [ ] **Step 6: Commit**

```bash
git add docs/agent/运行时AI导演与场景表演.md docs/agent/MVP核心闭环.md docs/agent/AI环境.md docs/Agent文档索引.md docs/策划文档/AI生成RPG_MVP.md docs/agent/current-phase.json docs/agent/当前开发阶段.md src/dependencyBoundaries.test.ts
git commit -m "docs: complete runtime AI director phase"
```

### Task 10: 异步场景任务、轮询与恢复

**目标：** 规则结算不等待任一 AI provider；持久化一个可恢复的 pending 标记，
由客户端显式 ensure 请求启动单飞后台任务，并通过 current-game 轮询恢复。

- [x] `GameState.narrative` 增加持久化 `generation: idle | pending`，旧档缺失时默认 `idle`。
- [x] `createGame` 与 `narrative_choice` 只写规则结果和 `pending`，不在请求路径调用 director / writer / NPC。
- [x] `generatePendingNarrativeScene` 从当前 revision 读取 pending 标记，生成后以 CAS 保存场景；
  restart 后同一标记可再次执行。CAS stale 一律丢弃生成结果。
- [x] `RuntimeNarrativeTaskCoordinator` 只做进程内单飞；持久化状态而非内存队列才是恢复依据。
- [x] `POST /api/game/narrative/ensure` 仅返回 `202 pending` / `200 ready` / `503 unavailable`，绝不等待 provider。
- [x] `CurrentGameScreen` 在 pending 时 ensure 并以 750ms 轮询 `/api/game/current`；UI 显示生成中，
  application 同时拒绝任何推进规则的 action。
- [x] 若规则层不足两个合法行动，清除 pending 而不让 AI 或 fallback 伪造选项。
- [x] 离线完整旅程改为显式 materialize pending 任务；黄金基线记录场景写入造成的 revision 变化。
- [x] 覆盖 pending 保存、fallback、重复 ensure 单飞、HTTP 映射与零网络完整旅程。

**边界：** Phase 10 的 introduced entity 仍只能是蓝图中既有 ID 的首次登场。
任何 AI 创建 NPC、地点、道具或其它 blueprint ID 的能力属于后续独立的“受审批蓝图扩展”阶段，
不得由本任务或 fallback 实现。

### Task 11: 地图优先叙事视图与离线旅程开发开局

**目标：** 地图始终是非战斗主视图；AI 场景只能在玩家进入当前地点后显示。
开发环境可一键用 Phase 10 完整旅程使用的固定输入和 seed 创建无 AI 的可重复地图开局。

**Files:**
- Modify: `src/components/AdventureGameShell.tsx`, `src/components/NarrativeScenePanel.tsx` and their tests.
- Modify: `src/components/CurrentGameScreen.tsx`, `src/components/NewGameSetupForm.tsx` and its tests.
- Modify: `src/game/domain/narrative.ts`, `src/game/application/createGame.ts`, `src/game/application/performAction.ts`, persistence defaults and their tests.
- Modify: `src/game/application/server/compositionRoot.ts`, `src/app/api/game/createGameHandler.ts` and their tests.
- Modify: `docs/agent/地图与地点冒险.md`, `docs/agent/运行时AI导演与场景表演.md`, `docs/Agent文档索引.md`.

**Interfaces:**
- `NarrativeRuntimeState.mode` is `"ai" | "offline"`; old saves default to `"ai"`.
- `CreateGameDependencies.runtimeNarrativeMode?: NarrativeMode`; `offline` never queues a scene provider call.
- `ServerGameEntryPoints.createOfflineJourneyGame()` is development-only and owns the fixed input/seed; browser submits only `{ developmentPreset: "phase10-journey-v1" }`.

- [x] **Step 1: Add failing UI tests**

```tsx
renderShell({ view: viewWithNarrative });
expect(screen.getByRole("button", { name: "进入青石镇" })).toBeVisible();
expect(screen.queryByText(viewWithNarrative.narrative!.narration)).toBeNull();
await user.click(screen.getByRole("button", { name: "进入青石镇" }));
expect(screen.getByText(viewWithNarrative.narrative!.narration)).toBeVisible();
```

Assert the development setup button submits exactly the preset marker and no player-entered fields.

- [x] **Step 2: Implement minimal map-first composition**

```tsx
const showNarrative = screen === "scene" && view.narrative !== null;
return screen === "map" ? <WorldMapScreen ... /> : showNarrative
  ? <NarrativeScenePanel ... onReturnMap={() => setScreen("map")} />
  : <LocationSceneScreen ... />;
```

`NarrativeScenePanel` owns only player-safe text, two opaque tokens and a local `返回地图` button.

- [x] **Step 3: Add persistent offline-mode gate and server-owned preset**

```ts
type NarrativeMode = "ai" | "offline";
if (state.narrative.mode !== "offline" && deps.runtimeNarrativeSources !== undefined) {
  // mark pending after a narrative choice
}
```

The composition root reads the committed Phase 1 wuxia fixture as the exact input/seed used by the Phase 10 journey test, injects an unavailable scenario source and `runtimeNarrativeMode: "offline"`, and exposes it only when `NODE_ENV === "development"`.

- [x] **Step 4: Implement strict API/UI wiring**

```ts
if (record.developmentPreset === "phase10-journey-v1" && Object.keys(record).length === 1) {
  return mapDevelopmentPreset(await entryPoints.createOfflineJourneyGame());
}
```

All other payloads continue through the existing NewGameInput whitelist; production returns a stable development-disabled result.

- [x] **Step 5: Run focused tests and offline acceptance**

```powershell
npx vitest run src/components/AdventureGameShell.test.tsx src/components/NewGameSetupForm.test.tsx src/app/api/game/createGameHandler.test.ts src/game/application/createGame.test.ts src/game/application/server/compositionRoot.test.ts
npm run journey:phase10
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: the preset makes zero provider calls, map remains reachable before/after narrative generation, all ordinary API whitelist and persistence safeguards remain intact.

## Final Review Checklist

- [ ] Spec §2–5 的角色权限、固定两选项、现有实体范围和零状态写入分别映射到 Tasks 1–7。
- [ ] Spec §6 的初始化、单次 CAS、stale 丢弃与完整 fallback 映射到 Tasks 4–5。
- [ ] Spec §7 的现有 transport、三次独立请求、structured output 和 opt-in smoke 映射到 Tasks 6、8。
- [ ] Spec §8 的 battle/ending 优先级、token-only UI 和 deterministic fallback 映射到 Task 7。
- [ ] Spec §9 的美术接口仅保留在设计文档，没有创建未使用 production code。
- [ ] Spec §11 的负向上下文、篡改 token、规则一致性和 reload 验收映射到 Tasks 3、5、7、8。
- [ ] Plan 不修改 foundation，不 deep import `@ai-game/*`，不创建运行时实体。
- [ ] director、writer、npc 类型名、方法名和失败类别在所有任务中一致。
- [ ] 所有实现步骤均给出精确文件、接口、命令和预期结果。
