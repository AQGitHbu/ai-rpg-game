# 分层守卫加固 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 `game/core` 专项边界守卫、修掉 1 处生产代码 deep-import 违规、让 facade 清单与目录事实自动对齐，并同步规范文档与清理死代码，使 `core + gameplay + app` 三层结构在"代码事实"和"机器守卫"两侧同时成立。

**Architecture:** 全部改动围绕 `src/dependencyBoundaries.test.ts` 这一个守卫文件展开。做法是"先补守卫暴露违规，再修违规"，而不是先改代码再补测试——因为正是守卫缺失才让违规长期隐形。facade 清单（`FACADES`）从手写清单升级为"手写 + 目录自检"，防止新增子系统时再次漏守卫。core 层新增独立规则，把规范 §1.1 的准入条件（不得依赖上层、不得出现 RPG 词汇）变成可执行断言。

**Tech Stack:** TypeScript、Vitest 3、ESLint、`tsc --noEmit`、Next.js 路径别名 `@/* → ./src/*`。

## Global Constraints

（逐条抄自 `AGENTS.md`、`docs/游戏开发规范.md`，每个 Task 默认继承）

- 分支放 `.worktrees/`，**禁止** `git checkout`；合并必须从主工作区执行 `npm run branch:merge -- <branch>`（只走 fast-forward）。完成后用 `npm run branch:finish -- <branch>` 收尾。
- **禁止** `git worktree remove` / `rm -rf` 清理 phase worktree（会沿 `.foundation` junction 递归到 `../ai-game-foundation`）。
- 本仓已执行 `git config core.quotepath false`（中文文件名可读）。
- 不得新增带版本后缀的文件/导出、并行 use case、兼容 facade 或 read-model adapter。
- 新增跨层 import、facade 或 server 入口时必须同步更新 `src/dependencyBoundaries.test.ts` 并运行 `npm run test:boundaries`。
- 每个 Task 结束必须通过 `npm run typecheck`；涉及守卫的必须过 `npm run test:boundaries`。
- 架构修改先补/调整边界测试，再改 import。
- 最低验收：`npm run test:boundaries`、`npm run typecheck`；改动 gameplay/application 时分别跑 `npm run test:game-gameplay` / `npm run test:game-application`。

## 背景：本次要修的问题

| # | 级别 | 问题 |
|---|---|---|
| 1 | Critical | `gameSessionView.ts:28` deep-import 玩法内部文件，违反规范 §1.3 |
| 2 | Critical | `FACADES` 清单 13 项 vs 实际 14 个子系统，`narrativeContext` 漏项（问题 1 的根因） |
| 3 | Critical | `game/core` 无专项 boundary guard，违反规范 §5 / §1.1 |
| 4 | Important | 规范 §1.2 称 core「当前没有生产模块」，实际有 10 处生产 import |
| 5 | Important | 规范 §2.1 生产链名 `generatePendingScene` 已失效（实为 `generatePendingNarrativeBundle`） |
| 6 | Minor | `application/sceneWriteBack.ts` 死代码，被边界测试白名单"续命" |
| 7 | Minor | `src/game/scenario/`、`src/store/` 空目录残留 |
| 8 | **新发现** | gameplay 内部跨子系统 deep-import 6 处完全未受守卫（`game/gameplay` 规则未挂 `FACADE_DEEP_IMPORTS`） |

**已决策（用户 2026-09-04）：** AI 提案审批（`approveNarrativeBundle`、`battleShapeValidation`、`npcSpeechAuthority`）**留在 application**，视为 §2.1 的显式例外而非规则裁决——因为它审批的是 provider 输出，不是玩家行动。

**已验证的前置事实（写计划前实测，可直接依赖）：**
- `gameplay/rpg` 子系统依赖图**无环**，Task 3 的 6 处 facade 化改写不会引入循环 import。
- gameplay 内无"同子系统别名深导"；仅有的自引在测试文件（`narrativeExecution/narrativeExecutionPolicy.test.ts:9`、`preparedContinuation/candidates.test.ts:26`），而 `game/gameplay` 规则默认 `includeTestFiles: false`，不会被误伤。
- 25 个 anchors 文件全部真实存在，Task 2 的清单自检不会因 anchors 失效而假红。

---

## 开始之前：建立工作分支

- [ ] **Step 1: 确认主工作区干净并建分支**

Run: `git status --porcelain && git branch --show-current`
Expected: 输出为空（无未提交改动），当前分支为 `main`。若有改动先处理干净再继续。

- [ ] **Step 2: 在 `.worktrees/` 下建立功能分支**

Run: `git worktree add .worktrees/layering-guard-hardening -b feat/layering-guard-hardening main`
Expected: 新 worktree 建立于 `F:/AI2/ai-rpg-game/.worktrees/layering-guard-hardening`，分支 `feat/layering-guard-hardening`。

- [ ] **Step 3: 后续所有命令都在该 worktree 内执行**

Run: `cd .worktrees/layering-guard-hardening && pwd`
Expected: `F:/AI2/ai-rpg-game/.worktrees/layering-guard-hardening`（本文后续路径均相对此目录）。

---

### Task 1: 补齐 facade 导出面（5 个符号）

Task 3 要把 6 处 gameplay 内部深导改成 facade 调用，Task 2 要让 `gameSessionView.ts` 走 facade。但其中 5 个符号**当前并未被对应 facade 导出**，必须先补，否则改写后类型检查直接失败。本 Task 纯增导出、不改任何调用方，零行为变化。

**Files:**
- Modify: `src/game/gameplay/rpg/narrativeContext/index.ts`
- Modify: `src/game/gameplay/rpg/entityWorld/index.ts`
- Modify: `src/game/gameplay/rpg/dialogue/index.ts`
- Modify: `src/game/gameplay/rpg/worldEvolution/index.ts`

**Interfaces:**
- Produces: `isObjectiveSatisfied`（narrativeContext facade）、`NpcInteractionPayload`（entityWorld facade）、`DIALOGUE_TIER_CANDIDNESS` / `DIALOGUE_REVEAL_THRESHOLD`（dialogue facade）、`investigationApproachListIsValid`（worldEvolution facade）。Task 2 与 Task 3 依赖这 5 个名字。

- [ ] **Step 1: narrativeContext facade 补 `isObjectiveSatisfied`**

`src/game/gameplay/rpg/narrativeContext/index.ts` 当前第 6 行是：

```ts
export { deriveObjectiveTransition, currentObjectiveOf, isObjectiveSatisfiedInStory } from "./deriveObjectiveTransition";
```

在其**下方**新增一行：

```ts
export { isObjectiveSatisfied } from "./objectiveRules";
```

> 只导出 `isObjectiveSatisfied`，不导出 `objectiveLabel` 与 `QuestObjective`——当前无跨子系统消费者，YAGNI。

- [ ] **Step 2: entityWorld facade 补 `NpcInteractionPayload` 类型**

`src/game/gameplay/rpg/entityWorld/index.ts` 的 entityMutation 导出块中，在 `type EntityMutation,` 之后插入 `type NpcInteractionPayload,`。改动后该块为：

```ts
export {
  applyEntityMutations,
  EntityMutationInvariantError,
  // 常驻公共面（与上面那个临时导出不同）：Fact / NPC 的存在性只由这份 active-only 派生裁决，
  // 规则层的传播与 record_npc_knowledge 因此共用同一把尺子；它只读 records，不开任何写通道。
  knowledgeReferences,
  type ApplyEntityMutationsResult,
  type EntityMutation,
  type NpcInteractionPayload,
  type EntityMutationErrorCode,
  type KnowledgeMutationSource,
  type RelationshipMutationSource,
} from "./entityMutation";
```

- [ ] **Step 3: dialogue facade 补两个常量**

`src/game/gameplay/rpg/dialogue/index.ts` 当前全文：

```ts
export { resolveDialogue } from "./dialogueResolution";
export type {
  DialogueDeps,
  DialogueDisclosure,
  DialogueResolution,
  DialogueStatus,
} from "./dialogueResolution";
```

在 `export { resolveDialogue } ...` 之后新增：

```ts
export { DIALOGUE_TIER_CANDIDNESS, DIALOGUE_REVEAL_THRESHOLD } from "./dialogueResolution";
```

- [ ] **Step 4: worldEvolution facade 补 `investigationApproachListIsValid`**

`src/game/gameplay/rpg/worldEvolution/index.ts` 中把：

```ts
export { approveWorldDelta } from "./approveWorldDelta";
```

改为：

```ts
export { approveWorldDelta, investigationApproachListIsValid } from "./approveWorldDelta";
```

- [ ] **Step 5: 类型检查与 gameplay 测试**

Run: `npm run typecheck && npm run test:game-gameplay`
Expected: 全部通过。本 Task 只增导出，行为不变。

- [ ] **Step 6: Commit**

```bash
git add src/game/gameplay/rpg
git commit -m "refactor(gameplay): export the symbols that sibling subsystems deep-import"
```

---

### Task 2: FACADES 补 `narrativeContext` + 清单自检 + 修 application 深导（问题 1、2、建议 ④）

这是本次的核心。顺序不能反：**先让守卫能看见违规，再修违规**。同时把手写清单升级为自动对齐，杜绝再次漏项。

**Files:**
- Modify: `src/dependencyBoundaries.test.ts:56-70`（FACADES）
- Modify: `src/dependencyBoundaries.test.ts`（新增清单自检 describe）
- Modify: `src/game/application/gameSessionView.ts:23,28`

**Interfaces:**
- Consumes: Task 1 产出的 `isObjectiveSatisfied`（narrativeContext facade）。
- Produces: `narrativeContext` facade 条目；`game/application` 规则恢复全绿。

- [ ] **Step 1: 先写清单自检测试（此时应失败）**

在 `src/dependencyBoundaries.test.ts` 中，找到 `describe("boundary patterns detect synthetic violations", ...)` 这个 describe 块的**结束处**（即 `describe("canonical client surfaces stay behind the application facade", ...)` 之前），插入：

```ts
describe("facade inventory matches the gameplay subsystem directories", () => {
  const rpgRoot = resolve(sourceRoot, "game/gameplay/rpg");

  it("declares exactly one facade per rpg subsystem directory", () => {
    const directories = readdirSync(rpgRoot)
      .filter((entry) => statSync(resolve(rpgRoot, entry)).isDirectory())
      .sort();
    const declared = FACADES.map((facade) => facade.name).sort();
    expect(declared).toEqual(directories);
  });

  it("every declared facade resolves to a directory with an index.ts", () => {
    for (const facade of FACADES) {
      const directory = resolve(sourceRoot, facade.path.replace("@/", ""));
      expect(existsSync(resolve(directory, "index.ts")), facade.name).toBe(true);
    }
  });

  it("every anchor names a real module inside its facade directory", () => {
    for (const facade of FACADES) {
      const directory = resolve(sourceRoot, facade.path.replace("@/", ""));
      for (const anchor of facade.anchors) {
        expect(existsSync(resolve(directory, `${anchor}.ts`)), `${facade.name}/${anchor}`).toBe(true);
      }
    }
  });
});
```

> `resolve`、`readdirSync`、`statSync`、`existsSync` 已在文件顶部导入，无需新增 import。

- [ ] **Step 2: 运行，确认它真的抓住了漏项**

Run: `npx vitest run src/dependencyBoundaries.test.ts -t "declares exactly one facade per rpg subsystem directory"`
Expected: **FAIL**。断言信息显示 declared 数组缺 `narrativeContext`，而 directories 数组有 14 项。这证明自检非空转。

- [ ] **Step 3: 把 `narrativeContext` 补进 FACADES**

`src/dependencyBoundaries.test.ts` 的 `FACADES` 数组最后一项是：

```ts
  { name: "narrativeMemory", path: "@/game/gameplay/rpg/narrativeMemory", anchors: ["eventPolicy", "retrieveNarrativeMemory"] }
```

在其后（补上原缺失的逗号并）新增一项，使结尾变为：

```ts
  { name: "narrativeMemory", path: "@/game/gameplay/rpg/narrativeMemory", anchors: ["eventPolicy", "retrieveNarrativeMemory"] },
  { name: "narrativeContext", path: "@/game/gameplay/rpg/narrativeContext", anchors: ["objectiveRules", "deriveObjectiveTransition"] }
] as const satisfies readonly FacadeSpec[];
```

- [ ] **Step 4: 运行，确认自检通过但主规则暴露真实违规**

Run: `npx vitest run src/dependencyBoundaries.test.ts`
Expected: 清单自检 3 项全过；但主规则 `game/application does not import forbidden layers` **FAIL**，violations 为：

```
src/game/application/gameSessionView.ts: narrativeContext deep import (only the facade @/game/gameplay/rpg/narrativeContext is allowed)
```

这正是问题 1——之前它隐形存在，现在被守卫抓出来了。

- [ ] **Step 5: 修 `gameSessionView.ts` 走 facade**

`src/game/application/gameSessionView.ts` 第 23 行当前为：

```ts
import { currentObjectiveOf } from "@/game/gameplay/rpg/narrativeContext";
```

改为：

```ts
import { currentObjectiveOf, isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext";
```

并**删除**第 28 行整行：

```ts
import { isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext/objectiveRules";
```

> 调用点 `gameSessionView.ts:274` 的 `isObjectiveSatisfied(worldState, objective)` **保持不变**——本次只修分层，不改语义。见文末"遗留问题"。

- [ ] **Step 6: 运行边界测试与类型检查**

Run: `npm run test:boundaries && npm run typecheck`
Expected: 109 项 + 新增 3 项清单自检全部通过。

- [ ] **Step 7: 跑 application 行为测试确认零行为变化**

Run: `npm run test:game-application`
Expected: 全绿。若出现失败，说明 facade 导出与深导版本语义不等价，停下来排查，不要改断言迁就实现。

- [ ] **Step 8: Commit**

```bash
git add src/dependencyBoundaries.test.ts src/game/application/gameSessionView.ts
git commit -m "fix(boundaries): guard narrativeContext facade and drop its deep import"
```

---

### Task 3: gameplay 内部跨子系统深导收口（问题 8，新发现）

`game/gameplay` 规则当前只禁上层依赖，**没有挂 `FACADE_DEEP_IMPORTS`**，所以 6 处跨子系统深导从未被守卫。本 Task 补上守卫并逐个改写。

**Files:**
- Modify: `src/dependencyBoundaries.test.ts:221-233`（gameplay 规则）
- Modify: `src/game/gameplay/rpg/dialogue/dialogueResolution.ts:11`
- Modify: `src/game/gameplay/rpg/narrativeBundle/descriptors.ts:21`
- Modify: `src/game/gameplay/rpg/narrativeContext/npcResponsePolicy.ts:3`
- Modify: `src/game/gameplay/rpg/openingGeneration/validateOpeningGenerationCandidate.ts:5`
- Modify: `src/game/gameplay/rpg/ruleEngine/reconcileQuests.ts:6`
- Modify: `src/game/gameplay/rpg/worldEvolution/storyReveal.ts:5`

**Interfaces:**
- Consumes: Task 1 补的 5 个 facade 导出、Task 2 补的 `narrativeContext` FACADES 条目。
- Produces: `game/gameplay` 规则含 facade 深导守卫；6 个文件改为 facade 调用。

- [ ] **Step 1: 给 gameplay 规则挂上 facade 深导守卫（此时应失败）**

`src/dependencyBoundaries.test.ts` 中 `game/gameplay` 规则当前为：

```ts
  {
    directory: "game/gameplay",
    patterns: [
      forbiddenSpecifierPrefix("@/game/application"),
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      RELATIVE_ESCAPE_FROM_GAMEPLAY,
      SERVER_ONLY_IMPORT,
      LIBSQL_IMPORT
    ]
  },
```

在 `forbiddenSpecifierPrefix("@/providers/"),` 之后插入 `...Object.values(FACADE_DEEP_IMPORTS),`，使其变为：

```ts
  {
    directory: "game/gameplay",
    patterns: [
      forbiddenSpecifierPrefix("@/game/application"),
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      ...Object.values(FACADE_DEEP_IMPORTS),
      RELATIVE_ESCAPE_FROM_GAMEPLAY,
      SERVER_ONLY_IMPORT,
      LIBSQL_IMPORT
    ]
  },
```

- [ ] **Step 2: 运行，确认暴露 6 处违规**

Run: `npx vitest run src/dependencyBoundaries.test.ts -t "game/gameplay does not import forbidden layers"`
Expected: **FAIL**，violations 恰好 6 条，对应下面 Step 3–8 的六个文件。

- [ ] **Step 3: 改 `dialogue/dialogueResolution.ts`**

```ts
import type { EntityMutation, NpcInteractionPayload } from "@/game/gameplay/rpg/entityWorld/entityMutation";
```
→
```ts
import type { EntityMutation, NpcInteractionPayload } from "@/game/gameplay/rpg/entityWorld";
```

- [ ] **Step 4: 改 `narrativeBundle/descriptors.ts`**

```ts
import type { PreparedChoiceCandidate, PreparedArrivalNpcContext } from "@/game/gameplay/rpg/preparedContinuation/candidates";
```
→
```ts
import type { PreparedChoiceCandidate, PreparedArrivalNpcContext } from "@/game/gameplay/rpg/preparedContinuation";
```

- [ ] **Step 5: 改 `narrativeContext/npcResponsePolicy.ts`**

```ts
import { DIALOGUE_TIER_CANDIDNESS, DIALOGUE_REVEAL_THRESHOLD } from "@/game/gameplay/rpg/dialogue/dialogueResolution";
```
→
```ts
import { DIALOGUE_TIER_CANDIDNESS, DIALOGUE_REVEAL_THRESHOLD } from "@/game/gameplay/rpg/dialogue";
```

- [ ] **Step 6: 改 `openingGeneration/validateOpeningGenerationCandidate.ts`**

```ts
import { investigationApproachListIsValid } from "@/game/gameplay/rpg/worldEvolution/approveWorldDelta";
```
→
```ts
import { investigationApproachListIsValid } from "@/game/gameplay/rpg/worldEvolution";
```

- [ ] **Step 7: 改 `ruleEngine/reconcileQuests.ts`**

```ts
import { isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext/objectiveRules";
```
→
```ts
import { isObjectiveSatisfied } from "@/game/gameplay/rpg/narrativeContext";
```

- [ ] **Step 8: 改 `worldEvolution/storyReveal.ts`**

```ts
import { isObjectiveSatisfiedInStory } from "@/game/gameplay/rpg/narrativeContext/deriveObjectiveTransition";
```
→
```ts
import { isObjectiveSatisfiedInStory } from "@/game/gameplay/rpg/narrativeContext";
```

- [ ] **Step 9: 运行边界测试**

Run: `npm run test:boundaries`
Expected: 全绿，6 条违规消失。

- [ ] **Step 10: 复验无循环 import（本 Task 的关键风险）**

facade `index.ts` 会拉入整个子系统，比原来的单文件 import 更宽，理论上可能制造循环。写计划前已验证依赖图无环，但改写后必须实测复验：

Run: `npm run typecheck && npm run test:game-gameplay`
Expected: 全绿。若出现 `TDZ` / `Cannot access 'X' before initialization` / 导出为 `undefined`，说明 facade 化引入了循环，把该处改回相对路径直接引用具体文件，并在 commit message 里说明原因。

- [ ] **Step 11: Commit**

```bash
git add src/dependencyBoundaries.test.ts src/game/gameplay
git commit -m "refactor(gameplay): call sibling subsystems through their facades"
```

---

### Task 4: core 专项 boundary guard（问题 3）

规范 §5 与 §1.1 要求 core 有专门守卫，目前完全没有。core 自身是干净的（零外部 import、无 RPG 词汇），所以本 Task 是**补守卫**而非修违规。

**Files:**
- Modify: `src/dependencyBoundaries.test.ts`（新增 `CORE_RPG_VOCABULARY` 模式、core 规则、合成用例、扫描面自检）

- [ ] **Step 1: 在模式定义区新增 RPG 词汇模式**

在 `src/dependencyBoundaries.test.ts` 的 `const SERVER_ONLY_IMPORT` 定义之后新增：

```ts
/** core 是无 RPG 语义的通用机制层：出现这些业务词汇即视为被污染（规范 1.1）。 */
const CORE_RPG_VOCABULARY: BoundaryPattern = {
  label: "core module mentions RPG vocabulary",
  regex: /\b(?:npc|quest|battle|combat|narrative|story|savegame|gamestate|worldstate|storystate|prompt)\b/i
};
```

> 刻意**不含** `location` / `item` / `player` 等通用词——它们在无业务语义的通用代码里可能 legitimate 出现，纳入会制造假红。取舍在规范 §1.1 同步说明。

- [ ] **Step 2: 新增 core 规则**

在 `rules` 数组中，把下面这条插到 `game/domain` 规则**之前**（core 是最底层，先读更顺）：

```ts
  {
    directory: "game/core",
    patterns: [
      forbiddenSpecifierPrefix("@/game/domain"),
      forbiddenSpecifierPrefix("@/game/gameplay/"),
      forbiddenSpecifierPrefix("@/game/application"),
      forbiddenSpecifierPrefix("@/components/"),
      forbiddenSpecifierPrefix("@/store/"),
      forbiddenSpecifierPrefix("@/app/"),
      forbiddenSpecifierPrefix("@/providers/"),
      CORE_RPG_VOCABULARY,
      JSON_IMPORT,
      SERVER_ONLY_IMPORT,
      LIBSQL_IMPORT
    ]
  },
```

- [ ] **Step 3: 给新补的模式加合成违例用例（防空转）**

在 `describe("boundary patterns detect synthetic violations")` 的 `cases` 数组中新增两项：

```ts
    {
      pattern: forbiddenSpecifierPrefix("@/game/domain"),
      snippet: `import type { WorldState } from "@/game/domain/worldState";`
    },
    {
      pattern: CORE_RPG_VOCABULARY,
      snippet: `export function resolveQuest(npcId: string): string { return npcId; }`
    },
```

- [ ] **Step 4: 新增 core 扫描面自检（防扫描空转）**

在 Task 2 新增的 `describe("facade inventory matches the gameplay subsystem directories")` 之后插入：

```ts
describe("core layer stays free of product semantics", () => {
  it("core rule actually scans both core modules (guard is not vacuous)", () => {
    const coreFiles = exists(resolve(sourceRoot, "game/core"), false).map(toPosixRelative);
    expect(coreFiles).toContain("game/core/json/structuredJsonResponse.ts");
    expect(coreFiles).toContain("game/core/retry/boundedAttempts.ts");
  });

  it("core implementations import nothing at all", () => {
    for (const relative of [
      "game/core/json/structuredJsonResponse.ts",
      "game/core/retry/boundedAttempts.ts"
    ]) {
      const specifiers = extractSpecifiers(readFileSync(resolve(sourceRoot, relative), "utf8"));
      expect(specifiers, relative).toEqual([]);
    }
  });
});
```

- [ ] **Step 5: 运行边界测试**

Run: `npm run test:boundaries`
Expected: 全绿（core 当前干净），且新增的 4 项自检通过。

- [ ] **Step 6: 验证守卫真的会失败（关键：不能只绿不验）**

临时把 `src/game/core/retry/boundedAttempts.ts` 第 1 行改为 `import type { WorldState } from "@/game/domain/worldState";`，运行：

Run: `npx vitest run src/dependencyBoundaries.test.ts -t "game/core does not import forbidden layers"`
Expected: **FAIL**。确认后立即 `git checkout -- src/game/core/retry/boundedAttempts.ts` 还原。

- [ ] **Step 7: Commit**

```bash
git add src/dependencyBoundaries.test.ts
git commit -m "test(boundaries): add the core layer guard required by spec 1.1"
```

---

### Task 5: 规范文档同步（问题 4、5、§2.1 例外决策）

**Files:**
- Modify: `docs/游戏开发规范.md`（§1.2、§1.3、§2.1、§5）

- [ ] **Step 1: 更新 §1.2 的 core 行**

当前第 60 行：

```md
| `src/game/core/` | 当前没有生产模块。 | 尚未实现；不得把现有 RPG 代码为“对齐三层”而机械搬迁。 |
```

改为：

```md
| `src/game/core/` | 已有 `json`（`parseStructuredJsonObject`）与 `retry`（`runBoundedAttempts`）两个无 RPG 语义的通用机制，被 application 与 `application/server/ai` 共 10 处生产 import 消费；各有独立 facade 与同目录测试，并受 `src/dependencyBoundaries.test.ts` 的 core 专项守卫约束。 | 已符合，见 1.1 准入条件与第 5 节守卫。 |
```

- [ ] **Step 2: 更新 §1.2 的收尾段**

当前：

```md
因此，当前项目已落实 domain → gameplay → application 的主要边界，但尚不是已落地的完整 core + gameplay + app 三层实现。后续新增机制遵守本节准入条件；不以空 `core` 目录作为完成标志。
```

改为：

```md
因此，当前项目已落实 domain → gameplay → application → UI 的主要边界，core 层也已按本节准入条件落地 `json` 与 `retry` 两个通用机制，构成完整的 core + gameplay + app 三层结构。后续新增 core 机制仍须遵守本节准入条件；不以空 `core` 目录作为完成标志。
```

- [ ] **Step 3: §1.3 补 gameplay 内部 facade 规则，并修陈旧子系统名**

当前第 68 行：

```md
- application 通过 `@/game/gameplay/rpg/<system>` 的 `index.ts` facade 调用玩法。不得 deep-import `actions`、`quests`、`battle`、`narrative`、`scenario` 或 `town` 的内部文件。
```

改为（子系统清单改为泛指，因为 `actions`/`quests`/`battle`/`narrative`/`scenario` 这些子系统早已退役，原列举已失效）：

```md
- application 通过 `@/game/gameplay/rpg/<system>` 的 `index.ts` facade 调用玩法，不得 deep-import 任何子系统的内部文件。
- gameplay 内部跨子系统调用同样只走 `@/game/gameplay/rpg/<system>` 的 `index.ts` facade，不得 deep-import 兄弟子系统的内部文件；`src/dependencyBoundaries.test.ts` 的 `game/gameplay` 规则已包含该守卫。
```

- [ ] **Step 4: §2.1 写死 AI 提案审批例外 + 修正生产链名**

当前 §2.1 第二段（"application 可以编排玩法 facade…"）之后、"当前生产 application 只有一条…"这一段之前，插入新段落：

```md
**AI 提案审批例外（2026-09-04 确立）**：对 provider 输出的结构化提案做审批属于 application，不视为规则裁决。适用范围包括 `approveNarrativeBundle`、`battleShapeValidation`、`npcSpeechAuthority`。判据是：被审批对象是 AI 提案而非玩家行动，闸门只比对「提案是否与已批准的世界/剧情事实一致」，不产生新的规则结论。行动合法性、数值、掉落、任务与胜负仍只在 `gameplay/rpg` 裁决。新增审批模块放在 `src/game/application/` 并在同目录测试里证明它只做一致性校验、不写入规则结论。
```

并把下一段开头的生产链名更正——当前：

```md
当前生产 application 只有一条无版本后缀的运行链：`createGame`、`performTurn`、`generatePendingScene`、`projectGameSessionView`、`GameRepository` 与 `compositionRoot`。
```

改为：

```md
当前生产 application 只有一条无版本后缀的运行链：`createGame`、`performTurn`、`generatePendingNarrativeBundle`、`projectGameSessionView`、`GameRepository` 与 `compositionRoot`。
```

- [ ] **Step 5: §5 补 core 守卫事实**

当前：

```md
- 架构修改先补或调整边界测试，再改 import。新增 core 后，将现有 `src/dependencyBoundaries.test.ts` 的规则拆分或补充为 core 专项守卫，确保 core 的依赖白名单可执行。
```

改为：

```md
- 架构修改先补或调整边界测试，再改 import。core 专项守卫位于 `src/dependencyBoundaries.test.ts` 的 `game/core` 规则：禁止 core 依赖 domain/gameplay/application/components/store/app，禁止 JSON import、`server-only`、`@libsql/client`，并禁止出现 npc/quest/battle/combat/narrative/story/savegame/gameState/worldState/storyState/prompt 等 RPG 词汇（不含 location/item/player 等通用词，避免假红）。
- `FACADES` 清单必须覆盖 `src/game/gameplay/rpg/` 下的全部子系统目录，由 `facade inventory matches the gameplay subsystem directories` 用例自动校验；新增子系统时只改清单一处。
```

- [ ] **Step 6: Commit**

```bash
git add docs/游戏开发规范.md
git commit -m "docs(规范): record the landed core layer, AI approval exception and facade guard"
```

---

### Task 6: 死代码与空目录清理（问题 6、7）

**Files:**
- Delete: `src/game/application/sceneWriteBack.ts`
- Delete: `src/game/application/sceneWriteBack.test.ts`
- Modify: `src/dependencyBoundaries.test.ts:820`（从白名单移除）
- Delete: `src/game/scenario/.gitkeep`、`src/store/.gitkeep`（及其空目录）

> 依据：`sceneWriteBack.ts` 的 `writeBackScene` 只是 `repo.applySceneWriteBack` 外加一次 `reconcileCommittedMemory` 的薄封装（31 行）；同一职责已由 `stateCommit.ts:31` 承担，且 `stateCommit.ts` 才是 compositionRoot 实际装配的写入路径。全库无任何生产代码 import `sceneWriteBack`。

- [ ] **Step 1: 删除死代码文件**

Run: `git rm src/game/application/sceneWriteBack.ts src/game/application/sceneWriteBack.test.ts`
Expected: 两个文件被删除并暂存。

- [ ] **Step 2: 从边界测试白名单移除**

`src/dependencyBoundaries.test.ts` 中 `canonical state surfaces stay inside scanned scopes and respect layering` 用例的 application 文件清单当前为：

```ts
    for (const relative of [
      "game/application/createGame.ts",
      "game/application/performTurn.ts",
      "game/application/stateCommit.ts",
      "game/application/sceneWriteBack.ts"
    ]) {
```

删掉最后一行 `"game/application/sceneWriteBack.ts"`（并去掉上一行 `stateCommit.ts` 后新增的逗号），改为：

```ts
    for (const relative of [
      "game/application/createGame.ts",
      "game/application/performTurn.ts",
      "game/application/stateCommit.ts"
    ]) {
```

> 保留 `stateCommit.ts`——它才是真正的生产写入路径，继续承担"application 编排只经纯端口取持久化契约"的钉死作用。

- [ ] **Step 3: 删除空目录**

Run: `git rm src/game/scenario/.gitkeep src/store/.gitkeep`
Expected: 两个占位文件被删除，目录随之消失。

> 路径别名 `@/* → ./src/*` 是通配映射，不存在指向这两个目录的显式别名，删除不会影响解析。`game/gameplay/rpg/scenario` 早已退役（`retiredPrefixes` 用例已钉死），`src/game/scenario` 是其历史残留。

- [ ] **Step 4: 验证**

Run: `npm run test:boundaries && npm run typecheck && npm run test:game-application`
Expected: 全绿。若 `test:boundaries` 报 `game/application/sceneWriteBack.ts` 不存在，说明还有遗漏引用，`git checkout` 还原后重新核查。

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "chore: drop the unused sceneWriteBack shim and empty scaffolding dirs"
```

---

### Task 7: 全量验收与收尾

- [ ] **Step 1: 静态门禁**

Run: `npm run test:fast`
Expected: 全部通过（`check:standards` / `test:foundation-locator` / `test:ai-env` / `test:handoff-check` / `shared:check` / `typecheck` / `test:boundaries`）。

- [ ] **Step 2: lint**

Run: `npm run lint`
Expected: 无 error。

- [ ] **Step 3: 全量测试**

Run: `npm test`
Expected: 全部通过。基线参考：2026-09-02 记录为 173 个文件 / 2318 项；本计划删了 `sceneWriteBack.test.ts`（1 文件 3 项）、新增清单自检与 core 自检（+7 项），文件数与项数会有小幅变化，但**不允许出现失败项**。

- [ ] **Step 4: 生产构建**

Run: `npm run build`
Expected: 构建成功——这是 facade 化改写未引入循环 import 的最终证明。

- [ ] **Step 5: 复查守卫有效性（回归本次的核心目的）**

人工抽查三条，确认守卫现在真的会拦：

Run: `npx vitest run src/dependencyBoundaries.test.ts`
Expected: 全绿，且测试项数比改动前多 7 项（清单自检 3 + core 扫描面 2 + core 实现零 import 1 + core 规则 1）。

- [ ] **Step 6: 合并回 main**

确认 worktree 干净后回到主工作区执行：

Run: `cd ../.. && npm run branch:merge -- feat/layering-guard-hardening`
Expected: fast-forward 合并成功，worktree 与分支按 `branch:finish` 流程清理完毕。若脚本报 worktree 不干净或分支未合入，**不要**改用 `git worktree remove` 或 `rm -rf`，按报出的精确路径人工处理后重试。

---

## 遗留问题（本计划刻意不改，需另行决策）

`src/game/application/gameSessionView.ts:274` 用的是 WorldState-only 的 `isObjectiveSatisfied(worldState, objective)`，而 narrativeContext facade 另有一个 `isObjectiveSatisfiedInStory(ws, ss, objective)`——后者在前者为 true 的基础上，还会对 `talk_to_npc` 目标额外检查 StoryState 的会话完成状态。

也就是说，对 `talk_to_npc` 类型的目标，read model 可能把它标为「已完成」而剧情层认为尚未完成。

**本计划只修分层、不改语义**（Step 2 Step 5 明确保留原调用），因此这个差异被原样保留。它是否为 bug 需要产品/策划确认，建议单独开一个 issue 跟进，不要混在本次守卫加固里改——否则一旦回归，无法区分是分层改动还是语义改动引入的。

## Self-Review

- **Spec 覆盖**：问题 1→Task 2；问题 2→Task 2；问题 3→Task 4；问题 4→Task 5 Step 1–2；问题 5→Task 5 Step 4；问题 6→Task 6；问题 7→Task 6 Step 3；问题 8（新发现）→Task 3；§2.1 AI 审批例外决策→Task 5 Step 4；建议 ④ 清单自检→Task 2 Step 1。全部 8 项 + 1 项决策均有对应 Task，无遗漏。
- **占位符扫描**：无 TBD/TODO/"类似 Task N"/"添加适当校验"。每处 import 改写都给出了改前改后的完整行。
- **类型一致性**：Task 1 产出的 5 个符号名（`isObjectiveSatisfied`、`NpcInteractionPayload`、`DIALOGUE_TIER_CANDIDNESS`、`DIALOGUE_REVEAL_THRESHOLD`、`investigationApproachListIsValid`）与 Task 2 Step 5、Task 3 Step 3–8 的使用完全一致。
- **顺序依赖**：Task 1 必须先于 Task 2/3（否则 facade 导出缺失导致 typecheck 失败）；Task 2 必须先于 Task 3（否则 `narrativeContext` deep-import 规则不存在）。任务内步骤已按 TDD 顺序排列。
- **风险点**：Task 3 引入循环 import 是本计划最大风险，已用 Step 10（typecheck + gameplay 测试）和 Task 7 Step 4（生产构建）双重复验。
