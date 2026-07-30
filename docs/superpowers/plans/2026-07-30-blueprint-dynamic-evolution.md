# 蓝图动态化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 时长档位（short/medium/long/open）驱动的 BudgetPolicy 替代冻结 CONTENT_BUDGET，主线幕数可变，运行时导演可提议新地点/NPC 经闸门审批追加进蓝图并持久化。

**Architecture:** 三段式：domain 新增 GameLength + BudgetPolicy（采用"先增后删"迁移——旧 CONTENT_BUDGET 保留到清理任务才删除，保证每个任务独立编译通过）；开局链（validator/schema/prompt/fallback）全部改为 policy 驱动；运行时扩展走 propose → approve（纯函数闸门）→ compile（服务端铸 ID）→ applyBlueprintExpansion（CAS）新端口。

**Tech Stack:** TypeScript strict / Next.js / vitest / @libsql（sqlite）

**Spec:** `docs/superpowers/specs/2026-07-30-blueprint-dynamic-evolution.md`（数值表、闸门顺序、拒绝码枚举以 spec §4 为准）

## Global Constraints

- 工作分支放 `.worktrees/`（建议 `codex/blueprint-dynamic-evolution`），禁止 `git checkout` 切主工作区
- Windows PowerShell 环境；测试命令 `npx vitest run <file>`；静态检查 `npx tsc --noEmit` 与 `npx eslint .`
- 依赖边界不可破坏：domain 禁止 import gameplay/application；gameplay 禁止 import application；UI 只经 `@/game/application` 门面；`process.env` 只许 application/server 内读取；每个任务完成后跑 `npx vitest run src/dependencyBoundaries.test.ts`
- 所有新纯函数禁止 IO/env/随机/时间；随机性只来自显式 seed
- AI 产物进入蓝图/状态前必须逐字段重建，绝不透传 AI 对象引用
- 注释风格与项目一致（中文、说明"为什么"）；TDD：先写失败测试再实现
- 档位数值以 spec §4.1 表格为唯一事实源：short{3,8,10} medium{5,14,16} long{8,22,24} open{5,null,null}；safety{40,30}；opening{main 3..5, hidden 1, npc 4..6, companions 1, side 2, endings 2, town 2}

---

### Task 1: domain/newGame.ts — GameLength 字段与规范化

**Files:**
- Modify: `src/game/domain/newGame.ts`
- Test: `src/game/domain/newGame.test.ts`（若无此文件则新建；先 `Glob newGame*.test.ts` 确认）
- Modify: `src/game/domain/index.ts`（导出 `GameLength`）

**Interfaces:**
- Produces: `export type GameLength = "short" | "medium" | "long" | "open"`；`NewGameInput.gameLength?: GameLength`；`ValidatedNewGameInput` 中 gameLength 恒为四值之一（undefined → "open"）

- [ ] **Step 1: 写失败测试**（追加到 newGame 校验测试）

```ts
import { describe, expect, it } from "vitest";
import { validateNewGameInput, type NewGameInput } from "./newGame";

function baseInput(): NewGameInput {
  return {
    gameType: "wuxia",
    characterName: "李逍遥",
    characterIdentity: "落魄镖师",
    personalityTags: [],
    worldPremise: "武林纷争四起，朝廷鞭长莫及，江湖门派各怀鬼胎。",
    storyOpening: "雨夜，你在破庙中醒来，怀中多了一封血书。",
    narrativeStyle: "cinematic",
    contentIntensity: "normal"
  };
}

describe("gameLength 档位", () => {
  it("缺省规范化为 open", () => {
    const result = validateNewGameInput(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.gameLength).toBe("open");
  });
  it("显式档位原样保留", () => {
    const result = validateNewGameInput({ ...baseInput(), gameLength: "long" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.gameLength).toBe("long");
  });
  it("非法值报 INVALID_ENUM", () => {
    const result = validateNewGameInput({
      ...baseInput(),
      gameLength: "epic" as never
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual({
        field: "gameLength", code: "INVALID_ENUM", params: { value: "epic" }
      });
    }
  });
});
```

- [ ] **Step 2:** `npx vitest run src/game/domain/newGame.test.ts` → 预期 FAIL（gameLength 不存在）
- [ ] **Step 3: 实现**：`newGame.ts` 增加

```ts
export type GameLength = "short" | "medium" | "long" | "open";
const GAME_LENGTHS: readonly GameLength[] = ["short", "medium", "long", "open"];
```

`NewGameInput` 增加 `gameLength?: GameLength;`。`ValidatedNewGameInput` 类型改为 `NewGameInput & { gameLength: GameLength } & { readonly [validatedNewGameInputBrand]: true }`。`validateNewGameInput` 中：

```ts
// 时长档位：缺省视为 open（不选=随剧情推演）；提供时必须是四值之一。
const gameLength = input.gameLength ?? "open";
validateEnum(errors, "gameLength", gameLength, GAME_LENGTHS);
```

并在成功分支的 `value` 对象加入 `gameLength`。`domain/index.ts` 在 newGame 导出块补 `type GameLength`。
- [ ] **Step 4:** `npx vitest run src/game/domain/newGame.test.ts` → PASS；`npx tsc --noEmit`（既有测试用 `as ValidatedNewGameInput` 断言构造的 fixture 若报错，为其补 `gameLength: "open"`）
- [ ] **Step 5:** `git add -A && git commit -m "feat(domain): NewGameInput 增加 gameLength 时长档位"`

---

### Task 2: domain/budgetPolicy.ts — BudgetPolicy 与档位派生

**Files:**
- Create: `src/game/domain/budgetPolicy.ts`
- Test: `src/game/domain/budgetPolicy.test.ts`
- Modify: `src/game/domain/index.ts`、`src/game/application/index.ts`（门面转发类型与函数）

**Interfaces:**
- Consumes: `GameLength`（Task 1）
- Produces: `BudgetPolicy` 类型（形状见 spec §4.1）；`createBudgetPolicy(gameLength: GameLength): BudgetPolicy`；`LEGACY_BUDGET_POLICY: BudgetPolicy`；`budgetPolicyOf(blueprint: { readonly budgetPolicy?: BudgetPolicy }): BudgetPolicy`；`finalMainActOf(blueprint): number`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  createBudgetPolicy, budgetPolicyOf, finalMainActOf, LEGACY_BUDGET_POLICY
} from "./budgetPolicy";

describe("createBudgetPolicy", () => {
  it("四档位幕数与软上限符合档位表", () => {
    expect(createBudgetPolicy("short").mainActs).toBe(3);
    expect(createBudgetPolicy("medium").mainActs).toBe(5);
    expect(createBudgetPolicy("long").mainActs).toBe(8);
    expect(createBudgetPolicy("open").mainActs).toBe(5);
    expect(createBudgetPolicy("short").expansion).toEqual({ locationsSoftMax: 8, npcsSoftMax: 10 });
    expect(createBudgetPolicy("long").expansion).toEqual({ locationsSoftMax: 22, npcsSoftMax: 24 });
    expect(createBudgetPolicy("open").expansion).toEqual({ locationsSoftMax: null, npcsSoftMax: null });
  });
  it("开局预算与安全上限全档位一致", () => {
    for (const length of ["short", "medium", "long", "open"] as const) {
      const policy = createBudgetPolicy(length);
      expect(policy.opening).toEqual({
        mainLocationsMin: 3, mainLocationsMax: 5, hiddenLocationsMax: 1,
        coreNpcsMin: 4, coreNpcsMax: 6, companionsMax: 1,
        sideQuestsMax: 2, endings: 2, townLocationsMax: 2
      });
      expect(policy.safety).toEqual({ locationsHardMax: 40, npcsHardMax: 30 });
      expect(Object.isFrozen(policy)).toBe(true);
    }
  });
});

describe("budgetPolicyOf / finalMainActOf", () => {
  it("缺省回 LEGACY（旧存档三幕语义）", () => {
    expect(budgetPolicyOf({})).toBe(LEGACY_BUDGET_POLICY);
    expect(LEGACY_BUDGET_POLICY.mainActs).toBe(3);
    expect(LEGACY_BUDGET_POLICY.opening.mainLocationsMin).toBe(4);
    expect(LEGACY_BUDGET_POLICY.opening.mainLocationsMax).toBe(4);
    expect(finalMainActOf({})).toBe(3);
  });
  it("有 budgetPolicy 时原样返回", () => {
    const policy = createBudgetPolicy("long");
    expect(budgetPolicyOf({ budgetPolicy: policy })).toBe(policy);
    expect(finalMainActOf({ budgetPolicy: policy })).toBe(8);
  });
});
```

- [ ] **Step 2:** `npx vitest run src/game/domain/budgetPolicy.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `budgetPolicy.ts`：

```ts
import type { GameLength } from "./newGame";

// ---------------------------------------------------------------------------
// 预算策略：时长档位 → 主线弧长 + 演进软上限。开局预算与安全硬上限全档位统一，
// 时长只影响"故事走多远"，不影响开局生成体积。数值表唯一事实源在此，
// validator / schema / prompt / 闸门一律引用本模块，禁止另写字面量。
// ---------------------------------------------------------------------------

export type BudgetPolicy = { /* 按 spec §4.1 逐字段实现，全部 readonly */ };

const OPENING = Object.freeze({
  mainLocationsMin: 3, mainLocationsMax: 5, hiddenLocationsMax: 1,
  coreNpcsMin: 4, coreNpcsMax: 6, companionsMax: 1,
  sideQuestsMax: 2, endings: 2, townLocationsMax: 2
});
const SAFETY = Object.freeze({ locationsHardMax: 40, npcsHardMax: 30 });

const PRESETS = Object.freeze({
  short: { mainActs: 3, locationsSoftMax: 8, npcsSoftMax: 10 },
  medium: { mainActs: 5, locationsSoftMax: 14, npcsSoftMax: 16 },
  long: { mainActs: 8, locationsSoftMax: 22, npcsSoftMax: 24 },
  open: { mainActs: 5, locationsSoftMax: null, npcsSoftMax: null }
} as const);

export function createBudgetPolicy(gameLength: GameLength): BudgetPolicy {
  const preset = PRESETS[gameLength];
  return Object.freeze({
    policyVersion: 1, gameLength, mainActs: preset.mainActs,
    opening: OPENING, safety: SAFETY,
    expansion: Object.freeze({
      locationsSoftMax: preset.locationsSoftMax, npcsSoftMax: preset.npcsSoftMax
    })
  });
}

/** 旧存档（无 budgetPolicy 字段）的等价策略：3 幕、主地点恒 4，与旧 CONTENT_BUDGET 语义逐项一致。 */
export const LEGACY_BUDGET_POLICY: BudgetPolicy = Object.freeze({
  policyVersion: 1, gameLength: "short", mainActs: 3,
  opening: Object.freeze({ ...OPENING, mainLocationsMin: 4, mainLocationsMax: 4 }),
  expansion: Object.freeze({ locationsSoftMax: 8, npcsSoftMax: 10 }),
  safety: SAFETY
});

export function budgetPolicyOf(blueprint: { readonly budgetPolicy?: BudgetPolicy }): BudgetPolicy {
  return blueprint.budgetPolicy ?? LEGACY_BUDGET_POLICY;
}

/** 终局幕号：所有 stage === 3 的硬编码判定改为引用此函数。 */
export function finalMainActOf(blueprint: { readonly budgetPolicy?: BudgetPolicy }): number {
  return budgetPolicyOf(blueprint).mainActs;
}
```

`domain/index.ts` 与 `application/index.ts` 各追加一个导出块（application 侧转发，供 UI/测试经门面取用）。
- [ ] **Step 4:** `npx vitest run src/game/domain/budgetPolicy.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(domain): BudgetPolicy 档位派生与 legacy 回退"`

---

### Task 3: scenarioBlueprint.ts — budgetPolicy 可选字段 + MainQuestStage 放宽

**Files:**
- Modify: `src/game/domain/scenarioBlueprint.ts`
- Test: `src/game/domain/scenarioBlueprint.test.ts`

**Interfaces:**
- Produces: `ScenarioBlueprintShapeOf` 增 `readonly budgetPolicy?: BudgetPolicy`（`contentBudget` 本任务**保留不动**，Task 11 清理）；`MainQuestStage` 从 `1 | 2 | 3` 改为 `number`

- [ ] **Step 1: 写失败测试**（追加）：构造含 `budgetPolicy: createBudgetPolicy("long")` 与 `stage: 5` 主线任务的候选对象，断言类型可赋值给 `ScenarioBlueprintCandidate`（编译期断言，用 `satisfies`）且字段可读。
- [ ] **Step 2:** `npx tsc --noEmit` → FAIL（字段不存在 / stage 字面量类型不符）
- [ ] **Step 3: 实现**：`import type { BudgetPolicy } from "./budgetPolicy";`；shape 中 `openingScene` 之后加 `readonly budgetPolicy?: BudgetPolicy;`（注释：旧存档缺省，读取一律经 budgetPolicyOf）；`export type MainQuestStage = number;`（注释：正整数，上限由 budgetPolicy.mainActs 决定，结构校验在 questGraph）。
- [ ] **Step 4:** `npx vitest run src/game/domain` → PASS；`npx tsc --noEmit` → PASS
- [ ] **Step 5:** `git commit -am "feat(domain): 蓝图增加可选 budgetPolicy，主线幕号放宽为 number"`

---

### Task 4: questGraph.ts — policy 驱动的主线结构与预算校验

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/questGraph.ts`
- Test: `src/game/gameplay/rpg/scenario/questGraph.test.ts`

**Interfaces:**
- Consumes: 无新依赖（budget 数值由调用方注入，本模块不 import budgetPolicy）
- Produces: `QuestGraphInput` 增 `readonly budget: { readonly mainActs: number; readonly sideQuestsMax: number; readonly endings: number }`；结构校验规则："stage 必须是 1..mainActs 的整数，每幕恰一个主线任务"

- [ ] **Step 1: 写失败测试**：
  - 5 幕合法链（stage 1..5 逐个 unlock，终幕 reach_ending）+ `budget: { mainActs: 5, sideQuestsMax: 2, endings: 2 }` → 无 issue；
  - 缺 stage 3（mainActs 5）→ `MISSING_MAIN_STAGE`；
  - stage 6（mainActs 5）→ `INVALID_MAIN_STAGE`；
  - stage 2 出现两次 → `MAIN_STAGE_OVERBUDGET`；
  - 现有 3 幕测试全部改为显式传 `budget: { mainActs: 3, sideQuestsMax: 2, endings: 2 }`。
- [ ] **Step 2:** `npx vitest run src/game/gameplay/rpg/scenario/questGraph.test.ts` → FAIL
- [ ] **Step 3: 实现**：删除 `CONTENT_BUDGET` import；`QuestGraphInput` 加 `budget` 字段；`validateStructure` 中 stage 合法集从固定 `[1,2,3]` 改为 `Number.isInteger(stage) && stage >= 1 && stage <= budget.mainActs`；逐幕存在性/唯一性循环 `for (let act = 1; act <= budget.mainActs; act++)`；支线上限与结局数量断言改用 `budget.sideQuestsMax` / `budget.endings`。可达性算法不变。
- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/scenario/questGraph.test.ts` → PASS。注意：`validateScenarioBlueprint.ts` 调用点此时编译失败——同任务内顺手改为 `budget: { mainActs: 3, sideQuestsMax: CONTENT_BUDGET.sideQuestsMax, endings: CONTENT_BUDGET.endings }` 临时桥接（Task 6 换成 policy），保证全仓编译绿。
- [ ] **Step 5:** `npx tsc --noEmit` → PASS；`git commit -am "feat(gameplay): questGraph 支持可变主线幕数"`

---

### Task 5: 终局判定去硬编码（stage === 3 → finalMainActOf）

**Files:**
- Modify: `src/game/gameplay/rpg/battle/startBattle.ts`（L111 附近）
- Modify: `src/game/gameplay/rpg/actions/index.ts`（L140 附近）
- Modify: `src/game/application/performAction.ts`（L444 附近）
- Test: `src/game/gameplay/rpg/battle/startBattle.test.ts`（追加用例）

**Interfaces:**
- Consumes: `finalMainActOf`（Task 2）、Task 3 的 `budgetPolicy` 字段

- [ ] **Step 1: 写失败测试**：构造 5 幕蓝图 fixture（`budgetPolicy: createBudgetPolicy("medium")`，主线 q1..q5），断言 boss 战/终局闸门在 stage 5 任务上判定为终幕、在 stage 3 上判定为非终幕。
- [ ] **Step 2:** 运行 → FAIL（stage 3 被误判为终幕）
- [ ] **Step 3: 实现**：三处判定统一改写。模式（以 startBattle 为例）：

```ts
// 终局幕号来自蓝图预算策略：旧存档经 LEGACY 回退仍为 3，行为不变。
if (quest.kind !== "main" || quest.stage !== finalMainActOf(blueprint)) return false;
```

三个调用点都已持有 blueprint（核实签名后接线；`performAction.ts` L444 的 `q.stage === 3` 同样替换）。`compileScenarioBlueprint.ts` 的 `stage === 1` 不动。
- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/battle src/game/gameplay/rpg/actions src/game/application/performAction.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "refactor: 终局判定改用 finalMainActOf，支持可变幕数"`

---

### Task 6: validateScenarioBlueprint — policy 驱动校验

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.ts`
- Test: `src/game/gameplay/rpg/scenario/validateScenarioBlueprint.test.ts`

**Interfaces:**
- Consumes: `BudgetPolicy`、`createBudgetPolicy`
- Produces: `ScenarioValidationContext = { profile: GameTypeProfile; policy: BudgetPolicy }`；issue code 变更：`MAIN_LOCATION_COUNT_MISMATCH` → `MAIN_LOCATION_COUNT_OUT_OF_RANGE`、`CONTENT_BUDGET_MISMATCH` → `BUDGET_POLICY_MISMATCH`

- [ ] **Step 1: 写失败测试**（测试的 `issuesOf` helper 统一改为传 `{ profile: TEST_PROFILE, policy: createBudgetPolicy("open") }`）：
  - 3 个主地点（≥min）→ 无 MAIN_LOCATION 问题；6 个 → `MAIN_LOCATION_COUNT_OUT_OF_RANGE` 且 params 含 `{ min: 3, max: 5, actual: 6 }`；
  - 候选缺 `budgetPolicy` 或 `mainActs` 与派生 policy 不符 → `BUDGET_POLICY_MISMATCH`（path `budgetPolicy`）；
  - town 地点 3 个（policy 上限 2）→ `TOWN_LOCATION_OVERBUDGET`；
  - 旧 `contentBudget` 相关用例删除。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：
  - context 加 `policy`；`validateBudgetCounts(issues, candidate, policy)`：main 数量区间判定、hidden/npc/companion 上限改引 `policy.opening.*`；
  - `validateSchemaBasics` 中 contentBudget 逐字段比对整段替换为：

```ts
// 候选必须原样复述派生的 budgetPolicy（JSON round-trip 深比较，防 AI 私改预算）。
const declared = candidate.budgetPolicy;
if (JSON.stringify(declared ?? null) !== JSON.stringify(policy)) {
  issues.push({ path: "budgetPolicy", code: "BUDGET_POLICY_MISMATCH", params: {} });
}
```

  - questGraph 调用点的临时桥接（Task 4）换成 `budget: { mainActs: policy.mainActs, sideQuestsMax: policy.opening.sideQuestsMax, endings: policy.opening.endings }`；
  - `validateLocationScales` 的上限改 `policy.opening.townLocationsMax`（常量 `TOWN_SCALE_LOCATIONS_MAX` 保留导出，Task 11 处理引用方后再删）；
  - 全部调用方（`createGame.ts` 与测试）补 policy 参数：`createGame.ts` 用 `createBudgetPolicy(request.input.gameLength)`。
- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/scenario src/game/application/createGame.test.ts` → PASS；`npx tsc --noEmit`
- [ ] **Step 5:** `git commit -am "feat(gameplay): 蓝图校验改为 BudgetPolicy 驱动"`

---

### Task 7: createFallbackBlueprint — 可变主线链与 budgetPolicy 填充

**Files:**
- Modify: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.ts`
- Test: `src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts`

**Interfaces:**
- Produces: 签名不变（policy 由 `input.gameLength` 内部派生）；输出蓝图含 `budgetPolicy` 快照与 `mainActs` 幕主线链

- [ ] **Step 1: 写失败测试**：
  - `gameLength: "long"` 输入 → 主线恰 8 条、stage 排序 `[1..8]`、stage k 的 onSuccess unlock stage k+1、stage 8 reach_ending；`candidate.budgetPolicy` deep-equal `createBudgetPolicy("long")`；
  - `gameLength: "short"` → 3 幕（与旧行为一致）；
  - 同 seed 同输入两次生成 deep-equal（确定性回归）；
  - 产物经 `validateScenarioBlueprintCandidate`（policy 对应档位）零 issue——这是幕链正确性的最强断言。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：`const policy = createBudgetPolicy(input.gameLength);`；主线生成改为循环：幕 1 与终幕沿用现有首尾模板（名称/叙述不变，终幕 objective/outcome 不变）；中间幕（2..mainActs-1）循环现有中段模板数组（现第 2 幕模板扩为 3 套变体），名称前缀"第 k 章·"，objective 依次轮换 `visit_location(loc_2/loc_3/loc_4)`、`talk_to_npc(npc_2)`、`discover_fact(既有 fact)`，全部引用既有实体；ID 规则 `quest_main_<k>`；`contentBudget` 字段暂保留（Task 11 删），新增 `budgetPolicy: policy`。
- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/scenario/createFallbackBlueprint.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(gameplay): fallback 蓝图按档位生成可变主线链"`

---

### Task 8: scenarioResponseFormat — schema 工厂化

**Files:**
- Modify: `src/game/application/server/ai/scenarioResponseFormat.ts`
- Test: `src/game/application/server/ai/scenarioResponseFormat.test.ts`

**Interfaces:**
- Produces: `buildScenarioCandidateJsonSchema(policy: BudgetPolicy)`；`buildScenarioResponseFormatExtraBody(outputFormat: AiOutputFormat, policy: BudgetPolicy)`；常量 `SCENARIO_CANDIDATE_JSON_SCHEMA` 删除（测试改经工厂取 medium 实例断言）

- [ ] **Step 1: 写失败测试**：
  - `buildScenarioCandidateJsonSchema(createBudgetPolicy("long"))` 的 quest main 变体 `stage` 为 `{ type: "integer", minimum: 1, maximum: 8 }`；
  - `budgetPolicy` 子 schema：`mainActs` 为 `{ const: 8 }`、`expansion.locationsSoftMax` 为 `{ const: 22 }`（open 档为 `{ const: null }` 需用 `{ enum: [null] }` 表达，JSON Schema 无 null const 惯例——统一用 `enum: [value]`）；
  - required 列表以 `budgetPolicy` 替换 `contentBudget`；
  - `buildScenarioResponseFormatExtraBody("prompt_only", policy)` 仍返回 undefined；json_schema 返回 strict + 对应 policy 的 schema；
  - 同 policy 两次构建 JSON round-trip 相等（可序列化回归）。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：顶层 schema 组装函数化，`CONTENT_BUDGET_SCHEMA` 替换为 `budgetPolicySchemaOf(policy)`（嵌套 strictObject，叶子全部 `{ enum: [value] }` 精确锁定）；stage 改 integer 区间；locations `minItems: 3, maxItems: 6`。
- [ ] **Step 4:** 运行 → PASS
- [ ] **Step 5:** `git commit -am "feat(ai): 候选 JSON Schema 按 BudgetPolicy 构建"`

---

### Task 9: prompt 与 live source 按请求构建

**Files:**
- Modify: `src/game/application/server/ai/scenarioPrompt.ts`
- Modify: `src/game/application/server/ai/liveScenarioCandidateSource.ts`
- Modify: `src/game/application/server/ai/scenarioCandidateSourceFactory.ts`
- Test: 各自旁置 `.test.ts`

**Interfaces:**
- Produces: `liveScenarioCandidateSource` 选项 `extraBody` → `buildExtraBody?: (request: ScenarioGenerationRequest) => Record<string, unknown> | undefined`

- [ ] **Step 1: 写失败测试**：
  - prompt：`gameLength: "long"` 请求 → user 消息含"主线任务恰好 8 幕"与"3~5 个主要地点"、不含"主要地点 4"；模板 JSON 段含 `"budgetPolicy"`；
  - factory：json_schema 模式下，long 请求发出的 extraBody schema 中 stage maximum 为 8（用 fake transport 捕获请求体断言）。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：prompt 预算段落全部改 policy 插值（`const policy = createBudgetPolicy(request.input.gameLength)`），加"# 时长档位"段；live source 每次 `generate` 调 `options.buildExtraBody?.(request)`；factory 装配 `buildExtraBody: (request) => buildScenarioResponseFormatExtraBody(outputFormat, createBudgetPolicy(request.input.gameLength))`。
- [ ] **Step 4:** `npx vitest run src/game/application/server/ai` → PASS
- [ ] **Step 5:** `git commit -am "feat(ai): 开局 prompt 与 response_format 按时长档位构建"`

---

### Task 10: UI 时长选择 + createGame 全链回归

**Files:**
- Modify: `src/components/NewGameSetupForm.tsx`
- Test: `src/components/NewGameSetupForm.test.tsx`
- Modify: `src/game/application/createGame.ts`（Task 6 已接 policy，此处只补幕数断言回归）
- Test: `src/game/application/createGame.test.ts`（追加档位用例）

- [ ] **Step 1: 写失败测试**：
  - 表单渲染"游戏时长"下拉，默认值 `open`，四个选项文案：不限（随剧情推演）/短篇/中篇/长篇；提交后 payload 含 `gameLength`；
  - createGame（fixture source 路径 + fallback 路径）以 `gameLength: "long"` 创建 → 存档蓝图 `budgetPolicy.mainActs === 8`、主线 8 条。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：表单加 `useState<NewGameInput["gameLength"]>("open")` 与 select（结构仿既有 narrativeStyle 字段）；createGame 无需新改动（验证 Task 6/7 接线即可）。
- [ ] **Step 4:** `npx vitest run src/components/NewGameSetupForm.test.tsx src/game/application/createGame.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(ui): 新游戏表单增加游戏时长档位"`

---

### Task 11: 清理 CONTENT_BUDGET + 契约版本升级

**Files:**
- Modify: `src/game/domain/scenarioBlueprint.ts`（删 `ContentBudget`、`CONTENT_BUDGET`、shape 的 `contentBudget` 字段）
- Modify: `src/game/domain/index.ts`、`src/game/application/index.ts`（删相应导出）
- Modify: `src/game/application/scenarioGeneration.ts`（`SCENARIO_CANDIDATE_CONTRACT_VERSION` → `"scenario-dynamic-v2"`）
- Modify: 全部残余引用方（`createFallbackBlueprint.ts` 删 contentBudget 填充；测试 fixture 把 `contentBudget: { ...CONTENT_BUDGET }` 替换为 `budgetPolicy: createBudgetPolicy("short")`——short 的 3 幕与旧 fixture 主线一致；`validateScenarioBlueprint.ts` 删 `TOWN_SCALE_LOCATIONS_MAX` 导出并修 `scenarioPrompt.ts` 引用）

- [ ] **Step 1:** `Grep "CONTENT_BUDGET|contentBudget|TOWN_SCALE_LOCATIONS_MAX"` 列出全部残余引用清单
- [ ] **Step 2:** 逐文件替换（fixture 注意：旧 fixture 主地点为 4 个、主线 3 幕 → 用 `createBudgetPolicy("short")` 会因 opening main 3..5 与 4 兼容、幕数 3 一致而通过；如个别 fixture 依赖 LEGACY 的 4/4 断言，用 `LEGACY_BUDGET_POLICY`）
- [ ] **Step 3:** 契约版本字符串替换 + 相关契约测试断言更新
- [ ] **Step 4:** 全量验证：`npx vitest run` → 全 PASS；`npx tsc --noEmit`；`npx eslint .`
- [ ] **Step 5:** `git commit -am "refactor: 移除 CONTENT_BUDGET，契约升级 scenario-dynamic-v2"`

---

### Task 12: 扩展提案契约 + approveBlueprintExpansion 审批闸门

**Files:**
- Modify: `src/game/gameplay/rpg/narrative/types.ts`
- Modify: `src/game/gameplay/rpg/narrative/approveDirectorProposal.ts`（新字段丢弃式重建）
- Test: `src/game/gameplay/rpg/narrative/approveDirectorProposal.test.ts`（追加）
- Create: `src/game/gameplay/rpg/narrative/approveBlueprintExpansion.ts`
- Test: `src/game/gameplay/rpg/narrative/approveBlueprintExpansion.test.ts`
- Modify: `src/game/gameplay/rpg/narrative/index.ts`（导出新类型与函数）

**Interfaces:**
- Produces（形状以 spec §4.5 为准）：`ProposedNewLocation`、`ProposedNewNpc`；`DirectorProposal` 追加 `proposedNewLocations: readonly ProposedNewLocation[]`、`proposedNewNpcs: readonly ProposedNewNpc[]`；`BlueprintExpansionRejection`（8 个拒绝码）；`ApprovedBlueprintExpansion = { newLocation: ProposedNewLocation | null; newNpc: ProposedNewNpc | null }`；`BlueprintExpansionDecision`；`approveBlueprintExpansion(input: { blueprint: ScenarioBlueprint; state: GameState; plan: ApprovedDirectorPlan }): BlueprintExpansionDecision`
- 职责划分（关键原则：**扩展问题绝不使场景失败**）：
  - `approveDirectorProposal`：只做结构重建——两个新数组任一条目非纯字符串字段对象、`scale` 非 `"scene"|"town"`、或数组长度 > 1，则该数组整体重建为 `[]`（丢弃式，不返回 schema_violation）；合法条目逐字段拷贝重建。`introducedEntities` 既有语义完全不变。
  - `approveBlueprintExpansion`：纯语义闸门，顺序固定：`none_proposed`（两数组皆空）→ `invalid_payload`（码点长度越界 / npc.locationId 既非蓝图既有 ID 也非哨兵 `"new:0"` / 用了 `"new:0"` 但无新地点提案 / connectFromLocationId 非蓝图既有 ID）→ `pacing_locked`（plan.pacing ∈ {climax, resolution}）→ `endgame_locked`（当前激活主线幕 = `finalMainActOf(blueprint)`，或主线已全部完成）→ `soft_cap_reached`（提议地点且蓝图地点总数 ≥ `expansion.locationsSoftMax`，NPC 同理；null 跳过）→ `hard_cap_reached`（≥ `safety.*HardMax`）→ `connect_not_unlocked`（connectFrom 不在 `state.unlockedLocationIds`）→ `town_cap_reached`（提议 `scale: "town"` 且蓝图 town 地点总数 ≥ `opening.townLocationsMax`）。

- [ ] **Step 1: 写失败测试**（fixture 构造仿既有 narrative 测试的最小蓝图/状态 builder；policy 用 `createBudgetPolicy("short")` 便于触发软上限）：

```ts
import { describe, expect, it } from "vitest";
import { approveBlueprintExpansion } from "./approveBlueprintExpansion";

// buildBlueprint()/buildState()/buildPlan() 复用本目录既有测试的 fixture 构造惯例，
// 蓝图带 budgetPolicy: createBudgetPolicy("short")（软上限 8/10），state 解锁 loc_1。
const validLocation = {
  name: "废弃货栈", description: "码头边长期无人问津的旧货栈。",
  scale: "scene" as const, connectFromLocationId: "loc_1",
  reason: "线人约定在此交接密信。"
};

describe("approveBlueprintExpansion 闸门顺序", () => {
  it("无提案 → none_proposed", () => {
    const decision = approveBlueprintExpansion({
      blueprint: buildBlueprint(), state: buildState(),
      plan: buildPlan({ proposedNewLocations: [], proposedNewNpcs: [] })
    });
    expect(decision).toEqual({ ok: false, reason: "none_proposed" });
  });
  it("name 超 20 码点 → invalid_payload", () => { /* 同上，name 21 字 */ });
  it("pacing climax → pacing_locked（即使载荷合法）", () => { /* pacing: "climax" */ });
  it("激活主线为终幕 → endgame_locked", () => { /* state 激活 stage === mainActs 的主线 */ });
  it("地点总数达软上限 8 → soft_cap_reached；open 档同状态放行", () => { /* 两组断言 */ });
  it("connectFrom 未解锁 → connect_not_unlocked", () => { /* connectFrom loc_hidden */ });
  it("town 提案且 town 已达 2 → town_cap_reached", () => { /* scale: "town" */ });
  it("合法提案 → ok 且 expansion 为逐字段重建（引用不等于输入）", () => {
    const plan = buildPlan({ proposedNewLocations: [validLocation], proposedNewNpcs: [] });
    const decision = approveBlueprintExpansion({ blueprint: buildBlueprint(), state: buildState(), plan });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.expansion.newLocation).toEqual(validLocation);
      expect(decision.expansion.newLocation).not.toBe(plan.proposedNewLocations[0]);
      expect(decision.expansion.newNpc).toBeNull();
    }
  });
});
```

approveDirectorProposal 追加用例：提案数组含非法条目（缺字段/scale 非法/长度 2）→ 审批仍 ok 且对应数组为 `[]`；合法单条目 → 逐字段重建保留。
- [ ] **Step 2:** `npx vitest run src/game/gameplay/rpg/narrative` → FAIL
- [ ] **Step 3: 实现**：types.ts 按 spec §4.5 增加类型；approveDirectorProposal 在既有重建流程末尾追加两数组的丢弃式重建；approveBlueprintExpansion 按上述闸门顺序实现（纯函数、无 IO；码点长度用 `[...str].length`；地点/NPC 总数用 `blueprint.locations.length` / `blueprint.npcs.length`；town 计数经 `locationScaleOf`）。
- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/narrative` → PASS；`npx tsc --noEmit`（DirectorProposal 新增字段会使既有 fixture/测试对象缺字段报错——为其补 `proposedNewLocations: [], proposedNewNpcs: []`）
- [ ] **Step 5:** `git commit -am "feat(gameplay): 导演扩展提案契约与审批闸门"`

---

### Task 13: compileBlueprintExpansion + blueprint_expanded 事件

**Files:**
- Modify: `src/game/domain/events.ts`（新增 `BlueprintExpandedEvent` 并加入 `GameEvent` 联合）
- Create: `src/game/gameplay/rpg/narrative/compileBlueprintExpansion.ts`
- Test: `src/game/gameplay/rpg/narrative/compileBlueprintExpansion.test.ts`
- Modify: `src/game/domain/index.ts`、narrative barrel（导出）

**Interfaces:**
- Produces:

```ts
/** 运行时蓝图扩展落账事件：记录本次追加的实体 ID，供回放与调试。 */
export type BlueprintExpandedEvent = {
  readonly type: "blueprint_expanded";
  readonly newLocationIds: readonly LocationId[];
  readonly newNpcIds: readonly NpcId[];
  readonly occurredAt: string;
};

export function compileBlueprintExpansion(input: {
  readonly blueprint: ScenarioBlueprint;
  readonly state: GameState;
  readonly expansion: ApprovedBlueprintExpansion;
  readonly occurredAt: string; // 时间由调用方注入，保持纯函数
}): { readonly nextBlueprint: ScenarioBlueprint; readonly nextState: GameState };
```

- [ ] **Step 1: 写失败测试**：
  - 新地点：ID 为 `loc_dyn_1`（蓝图已含 `loc_dyn_1` 时铸 `loc_dyn_2`——序号 = 既有同前缀最大序号 + 1）；`kind: "main"`、`availableItemIds: []`；scale 按提案（`"scene"` 时与 `locationScaleOf` 缺省语义兼容）；双向连通：新地点 `connectedLocationIds: [connectFrom]`，connectFrom 的 `connectedLocationIds` 追加新 ID（其余地点引用不变）；
  - 新 NPC：ID `npc_dyn_1`；`isCompanion: false`、`knownFactIds: []`；`locationId` 哨兵 `"new:0"` 解析为本次新地点实 ID；
  - state：`unlockedLocationIds` 追加新地点；`state.npcs` 追加 runtime 条目（与 `initializeGameState` 对既有 NPC 的初始条目形状逐字段一致——先读 `initializeGameState` 把该构造逻辑提为可复用纯 helper 再引用，禁止复制粘贴两份）；`eventLedger` 末尾追加 `blueprint_expanded` 事件（ID 列表与 occurredAt 正确）；
  - 纯度：同输入两次调用 deep-equal；输入 blueprint/state 未被变异（前后 deep-equal 断言）；
  - 仅 NPC 无地点的提案：不产生新地点、事件 `newLocationIds: []`。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：events.ts 加事件类型（注释风格仿既有"Phase 10：叙事选择"条目）；compileBlueprintExpansion 全部新对象展开构造，绝不变异输入；ID 铸造扫描 `blueprint.locations`/`blueprint.npcs` 现有 ID 的 `^loc_dyn_(\d+)$` / `^npc_dyn_(\d+)$` 取最大序号。
- [ ] **Step 4:** `npx vitest run src/game/gameplay/rpg/narrative src/game/domain` → PASS
- [ ] **Step 5:** `git commit -am "feat(gameplay): 蓝图扩展编译（服务端铸 ID + blueprint_expanded 事件）"`

---

### Task 14: gameRepository 端口 applyBlueprintExpansion + sqlite CAS 实现

**Files:**
- Modify: `src/game/application/server/persistence/gameRepository.ts`（端口新增方法，形状见 spec §4.5）
- Modify: `src/game/application/server/persistence/sqliteGameRepository.ts`
- Test: `src/game/application/server/persistence/sqliteGameRepository.test.ts`（追加）
- Modify: 全部实现该端口的测试替身（先 `Grep "GameRepository"` 列出 in-memory/fake 实现，逐一补方法）

**Interfaces:**
- Produces: `ApplyBlueprintExpansionInput = { gameId; expectedRevision; nextBlueprint; nextState }`；`applyBlueprintExpansion(input): Promise<ApplyResolvedActionResult>`（复用既有结果类型，含 `STALE_GAME_REVISION`）

- [ ] **Step 1: 写失败测试**（sqlite 测试沿用本文件既有临时库/初始化惯例）：
  - 成功路径：createInitialGame 后以正确 revision 调 applyBlueprintExpansion（nextBlueprint 追加一个地点、nextState 解锁它）→ ok；`getCurrentGame` 读回的 blueprint 含新地点、state 已解锁、revision + 1；
  - CAS 冲突：以过期 revision 调用 → `{ ok: false, code: "STALE_GAME_REVISION" }`，且库中 blueprint/state/revision 均未变；
  - 与 applyResolvedAction 交错：expansion 后再 applyResolvedAction（携带新 revision）→ ok（链路无隐藏状态）。
- [ ] **Step 2:** 运行 → FAIL（端口无此方法）
- [ ] **Step 3: 实现**：sqlite 实现单事务内同时更新 blueprint JSON、state JSON、revision + 1，`WHERE ... AND revision = expectedRevision`（语句结构仿既有 applyResolvedAction，仅多更新 blueprint 列；受影响行数 0 → STALE）。序列化沿用既有 JSON 通道，`schemaVersion` 不变。
- [ ] **Step 4:** `npx vitest run src/game/application/server/persistence` → PASS；`npx tsc --noEmit`（测试替身补齐）
- [ ] **Step 5:** `git commit -am "feat(persistence): applyBlueprintExpansion 端口与 sqlite 单事务 CAS 实现"`

---

### Task 15: 导演 AI 链路——上下文、prompt、修复层、fixture、契约升级

**Files:**
- Modify: `src/game/application/runtimeNarrativeContexts.ts`（`DirectorContext` 增字段）
- Modify: 导演 live prompt 与修复层（先 `Grep "introducedEntities" src/game/application` 定位强制清空 introducedEntities 的修复代码与 prompt 模板文件，在同处扩展）
- Modify: 叙事 fixture source 与 fixture 数据（缺省空数组 + 新增一份含扩展提案的 fixture）
- Modify: `NARRATIVE_CONTRACT_VERSION` 定义处（`"runtime-narrative-v1"` → `"runtime-narrative-v2"`）及其契约测试
- Test: 各触点旁置测试追加

**Interfaces:**
- Produces: `DirectorContext` 追加 `readonly expansionAllowed: boolean`（= 以当前 blueprint/state 预判非 pacing 项闸门：终幕未激活且未达软/硬上限；pacing 属提案内容无法预判，不参与此标志）与 `readonly remainingLocationBudget: number | null`（`locationsSoftMax - 当前地点总数`，open 为 null，下限 0）

- [ ] **Step 1: 写失败测试**：
  - `toDirectorContext`：short 档软上限 8、现 5 地点 → `remainingLocationBudget: 3`、`expansionAllowed: true`；终幕激活 → `expansionAllowed: false`；open 档 → `remainingLocationBudget: null`；旧存档（无 budgetPolicy）→ LEGACY 软上限口径；
  - live 修复层：导演响应 JSON 中 `proposedNewLocations` 为字符串/缺失/超长数组 → 清洗为 `[]` 且场景继续（不抛错）；合法提案原样通过（不再像 introducedEntities 一样强制清空）；
  - fixture source：既有 fixture 解析后两字段为 `[]`；新扩展 fixture 解析出 1 地点 + 1 NPC 提案；
  - 契约测试：版本号断言更新为 `"runtime-narrative-v2"`。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：
  - `toDirectorContext` 用 `budgetPolicyOf(blueprint)` 派生两字段；
  - 导演 system prompt 增补"# 蓝图扩展"段：可选提案、至多各 1、必须给剧情理由、ID 由系统分配（禁止编造 ID）、`expansionAllowed: false` 或预算为 0 时禁止提案；prompt 中插值 `remainingLocationBudget`；
  - 修复层对两个新字段做丢弃式清洗（任何形状不符 → `[]`），与既有 introducedEntities 清洗代码同处实现但语义不同（introducedEntities 保持强制清空不变）；
  - fixture source 解析层为缺省字段补 `[]`。
- [ ] **Step 4:** `npx vitest run src/game/application` → PASS
- [ ] **Step 5:** `git commit -am "feat(ai): 导演链路支持蓝图扩展提案，契约升级 runtime-narrative-v2"`

---

### Task 16: 编排接线 + 持久化保存点 + 离线旅程回归

**Files:**
- Modify: `src/game/application/orchestrateNarrativeScene.ts`（返回值追加 `expansionDecision`）
- Modify: `src/game/application/generatePendingNarrativeScene.ts`（decision ok 时改走 applyBlueprintExpansion）
- Test: `src/game/application/orchestrateNarrativeScene.test.ts`、`src/game/application/generatePendingNarrativeScene.test.ts`（追加）
- Test: 旅程回归（在既有 narrative 旅程回归测试文件内追加，或新建 `src/game/application/blueprintExpansionJourney.test.ts`）

**Interfaces:**
- Produces: `OrchestrateSceneResult` 追加 `readonly expansionDecision: BlueprintExpansionDecision`；`orchestrateNarrativeScene` 保持**不写库**约定不变
- 接线规则：导演 plan 审批通过后计算 `approveBlueprintExpansion({ blueprint, state, plan })`；导演不可用/走 fallback plan 时 `expansionDecision = { ok: false, reason: "none_proposed" }`

- [ ] **Step 1: 写失败测试**：
  - orchestrate：fixture 导演带合法提案 → 结果 `expansionDecision.ok === true`；fixture 无提案 → `none_proposed`；导演 source 抛错走 fallback → `none_proposed`；
  - generatePendingNarrativeScene：decision ok → 仓储收到的是 `applyBlueprintExpansion` 调用（fake repository 记录调用），`nextBlueprint` 含新地点、`nextState` 同时含 currentScene 与解锁/npcs/事件变化；decision 拒绝 → 沿用 `applyResolvedAction` 且场景照常保存；`applyBlueprintExpansion` 返回 STALE → `"stale"`；
  - 旅程回归（对应 spec 验收 6/7，全 fixture 离线）：扩展 fixture 走完"pending → 生成 → 保存"一轮后：蓝图地点 +1 且 ID 为 `loc_dyn_1`、大地图投影出现新节点（`locationAdventureView`）、可 `move` 进入新地点、eventLedger 含 `blueprint_expanded`；将蓝图预填至软上限后同类提案被拒（`soft_cap_reached`）且场景正常保存；pacing climax fixture → `pacing_locked`。
- [ ] **Step 2:** 运行 → FAIL
- [ ] **Step 3: 实现**：orchestrate 在导演审批成功分支后计算 decision 并入结果（fallback 分支给 `none_proposed`）；generatePendingNarrativeScene 保存点改为：

```ts
const sceneState = {
  ...record.state,
  narrative: { currentScene: generated.scene, generation: { status: "idle" as const }, mode: record.state.narrative.mode },
};
// 扩展审批通过时与场景同一次 CAS 落库，杜绝"场景引用了未落库地点"的中间态。
const saved = generated.expansionDecision.ok
  ? await deps.repository.applyBlueprintExpansion({
      gameId: record.gameId,
      expectedRevision: record.revision,
      ...compileBlueprintExpansion({
        blueprint: record.blueprint,
        state: sceneState,
        expansion: generated.expansionDecision.expansion,
        occurredAt, // 取值方式先核实既有事件写入点（如 performAction 的事件时间来源）并保持一致
      }),
    })
  : await deps.repository.applyResolvedAction({
      gameId: record.gameId, expectedRevision: record.revision, nextState: sceneState,
    });
```

- [ ] **Step 4:** `npx vitest run src/game/application` → PASS；`npx vitest run src/dependencyBoundaries.test.ts` → PASS
- [ ] **Step 5:** `git commit -am "feat(application): 场景与蓝图扩展同事务落库，离线旅程回归"`

---

### Task 17: 文档更新

**Files:**
- Create: `docs/agent/蓝图动态化.md`（实现事实：BudgetPolicy 档位表与 LEGACY 回退、扩展闸门顺序与拒绝码、applyBlueprintExpansion CAS、契约版本 scenario-dynamic-v2 / runtime-narrative-v2）
- Modify: `docs/Agent文档索引.md`（登记新文档）
- Modify: `docs/策划文档/`（玩法事实：开局时长档位选项、开局只生成起始区域、剧情推进中世界扩张的玩家可感知规则）
- Modify: 既有 `docs/agent/` 中描述 CONTENT_BUDGET / 三幕固定 / 蓝图只读的段落（先 `Grep "CONTENT_BUDGET|三幕|contentBudget" docs/` 找残留描述，逐处更正）

- [ ] **Step 1:** Grep 列出文档残留清单并逐一更正
- [ ] **Step 2:** 新文档按 `docs/agent/` 既有文档的结构惯例撰写（先读同目录 1~2 篇确认格式）
- [ ] **Step 3:** `git commit -am "docs: 蓝图动态化实现记录与索引登记"`

---

## Final Verification

- [ ] `npx vitest run` 全量 PASS
- [ ] `npx tsc --noEmit` / `npx eslint .` 零错误
- [ ] 对照 spec §6 验收标准 1~8 逐条自查（每条在上述任务测试中有对应断言：1→Task 1/10；2→Task 7/10；3→Task 6；4→Task 5；5→Task 2/5 LEGACY 用例；6/7→Task 16 旅程；8→本节全量检查）
- [ ] 分支收尾按 `superpowers:finishing-a-development-branch`；worktree 清理遵守 AGENTS.md 的 `.foundation` junction 禁令（从 main 运行 `cleanupConsumerWorktree.mjs`，禁止直接 `git worktree remove`）
