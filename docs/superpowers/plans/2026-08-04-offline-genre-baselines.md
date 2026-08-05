# 开发环境离线七题材开局下拉 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把开发环境「使用已有数据开始」从单一武侠题材扩展为 7 题材下拉，复用 `data/story-eval/cases/v2.json` 输入 + 派生 seed，创建零 AI 的 offline 存档供非 AI 系统/UI 开发。

**Architecture:** 新增 server-only 薄模块 `offlineBaselines.ts` 持有题材→caseId 白名单与 v2.json 解析 + seed 派生；compositionRoot 的 `createOfflineJourneyGame` 扩展接受 caseId；API handler 放宽 preset 排他判断允许伴随 caseId；前端表单加 7 题材下拉。全程复用现有 offline 链路（unavailable source → fallback 蓝图 + `runtimeNarrativeMode:"offline"`），不改规则/AI/持久化。

**Tech Stack:** TypeScript / Next.js / Vitest / SQLite（better-sqlite3）/ React Testing Library。

## Global Constraints

- 仅改 `ai-rpg-game`；`sharedInfrastructureChangeAllowed: false`，零 foundation / `@ai-game/*` 改动。
- 全程零 AI 调用（开局与运行时）；纯确定性 fallback 蓝图 + `runtimeNarrativeMode:"offline"`。
- 测试用真实临时 SQLite（`tmp/` 前缀 + afterAll 清理，仿 `phase4cOfflineJourneyRegression.test.ts`），零网络、零 `.env.local`。
- `caseId` 是服务端白名单枚举（7 个），浏览器无法注入任意 input/seed/state。
- 验收命令：`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`（全部离线）。
- 数据来源 `data/story-eval/cases/v2.json` 的 `gameLength` 固定 `long`（`createBudgetPolicy("long").mainActs === 8`）。

## Spec 事实修正（探索代码发现，执行时以此为准）

Spec §8/§9 称「不存在 wuxia 零 AI 规则通关现成证据」「须新建 harness 从 `view.availableActions` 选」。**实际**：`src/game/application/phase4cOfflineJourneyRegression.test.ts` 已是**零运行时 AI 的规则循环通关 harness**——`performDeps` 只含 `{ repository, now }`（无 `runtimeNarrativeSources` → performAction 闸门 `deps.runtimeNarrativeSources !== undefined` 为 false，不排队叙事），用蓝图驱动 BFS 路径 + objective→intent 映射走通 wuxia/sci-fi/urban 到结局。但它用 phase4c **generated** 蓝图（非 fallback）、只覆盖 3 类型、`gameLength:"short"`（3 stage）、未用 `runtimeNarrativeMode:"offline"`。Task 5 **借鉴此 harness 泛化**（而非新建 availableActions 选择器），更简单且已验证可行。

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/game/application/server/offlineBaselines.ts` | 题材→caseId 白名单 + v2.json 解析 + seed 派生 | 新建 |
| `src/game/application/server/offlineBaselines.test.ts` | offlineBaselines 单元测试 | 新建 |
| `src/game/application/server/compositionRoot.ts` | `createOfflineJourneyGame(caseId?)` 扩展 | 修改 |
| `src/game/application/server/compositionRoot.test.ts` | caseId 路径 + legacy + 非 dev 测试 | 修改 |
| `src/app/api/game/createGameHandler.ts` | preset 放宽允许伴随 caseId | 修改 |
| `src/app/api/game/createGameHandler.test.ts` | caseId 白名单/未知/类型/legacy 测试 | 修改 |
| `src/components/NewGameSetupForm.tsx` | 7 题材下拉 + 提交带 caseId | 修改 |
| `src/components/NewGameSetupForm.test.tsx` | 下拉渲染/选择/提交 caseId 测试 | 修改 |
| `src/game/application/testing/offlineGenreJourney.test.ts` | 7 题材零 AI 规则通关回归 | 新建 |
| `src/game/application/testing/offlineGenreJourney.ts` | 通用通关 harness 辅助函数 | 新建 |
---

## Task 1: offlineBaselines 模块

**Files:**
- Create: `src/game/application/server/offlineBaselines.ts`
- Test: `src/game/application/server/offlineBaselines.test.ts`

**Interfaces:**
- Produces: `OFFLINE_CASE_IDS: readonly string[]`（7 个）；`GENRE_TO_CASE: readonly { label, gameType, caseId }[]`；`resolveOfflineBaseline(caseId: string): { input: NewGameInput; seed: string } | null`。
- Consumes: `data/story-eval/cases/v2.json`（编译期 import）；`NewGameInput` from `@/game/domain`。

### Step 1: 写失败测试

Create `src/game/application/server/offlineBaselines.test.ts`:

```ts
/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { GENRE_TO_CASE, OFFLINE_CASE_IDS, resolveOfflineBaseline } from "./offlineBaselines";

describe("offlineBaselines", () => {
  it("白名单恰好 7 个，与 GENRE_TO_CASE 一一对应", () => {
    expect(OFFLINE_CASE_IDS).toHaveLength(7);
    expect(GENRE_TO_CASE.map((g) => g.caseId).sort()).toEqual([...OFFLINE_CASE_IDS].sort());
  });

  it("GENRE_TO_CASE 覆盖 7 个 gameType，无重复", () => {
    const gameTypes = GENRE_TO_CASE.map((g) => g.gameType);
    expect(gameTypes).toHaveLength(7);
    expect(new Set(gameTypes).size).toBe(7);
  });

  it("resolveOfflineBaseline 命中白名单返回合法 input + 确定性 seed", () => {
    const baseline = resolveOfflineBaseline("wuxia-a");
    expect(baseline).not.toBeNull();
    if (baseline === null) return;
    expect(baseline.input.gameType).toBe("wuxia");
    expect(baseline.input.gameLength).toBe("long");
    expect(typeof baseline.seed).toBe("string");
    expect(baseline.seed.length).toBeGreaterThan(0);
    expect(resolveOfflineBaseline("wuxia-a")?.seed).toBe(baseline.seed);
    expect(resolveOfflineBaseline("xianxia-a")?.seed).not.toBe(baseline.seed);
  });

  it("resolveOfflineBaseline 覆盖全部 7 个 caseId", () => {
    for (const caseId of OFFLINE_CASE_IDS) {
      const baseline = resolveOfflineBaseline(caseId);
      expect(baseline, `caseId=${caseId}`).not.toBeNull();
      expect(baseline?.input.gameLength).toBe("long");
    }
  });

  it("resolveOfflineBaseline 未知 caseId 返回 null", () => {
    expect(resolveOfflineBaseline("wuxia-b")).toBeNull();
    expect(resolveOfflineBaseline("nonexistent")).toBeNull();
    expect(resolveOfflineBaseline("")).toBeNull();
  });
});
```

### Step 2: 运行测试确认失败

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/game/application/server/offlineBaselines.test.ts`
Expected: FAIL（`Cannot find module './offlineBaselines'`）

### Step 3: 实现 offlineBaselines.ts

Create `src/game/application/server/offlineBaselines.ts`:

```ts
import type { NewGameInput } from "@/game/domain";
import casesData from "../../../../data/story-eval/cases/v2.json";

// ---------------------------------------------------------------------------
// 离线开局基线：从 v2.json 按 caseId 取 NewGameInput，seed 由 caseId 确定性
// 派生（FNV-1a，零新数据、可复现）。compositionRoot 的 createOfflineJourneyGame
// 按 caseId 解析后复用现有 offline 链路（unavailable source → fallback 蓝图 +
// runtimeNarrativeMode:"offline"）。本模块是离线下拉 caseId 的唯一白名单来源。
// ---------------------------------------------------------------------------

type StoryEvalCase = Readonly<{ readonly caseId: string; readonly input: NewGameInput }>;
const RAW_CASES = casesData as readonly StoryEvalCase[];

/** 题材 → 代表 case 映射（下拉 7 个选项的唯一来源）。 */
export const GENRE_TO_CASE: readonly {
  readonly label: string;
  readonly gameType: NewGameInput["gameType"];
  readonly caseId: string;
}[] = Object.freeze([
  { label: "武侠", gameType: "wuxia", caseId: "wuxia-a" },
  { label: "仙侠", gameType: "xianxia", caseId: "xianxia-a" },
  { label: "奇幻", gameType: "fantasy", caseId: "fantasy-a" },
  { label: "科幻", gameType: "science_fiction", caseId: "science-fiction-a" },
  { label: "都市", gameType: "urban", caseId: "urban-a" },
  { label: "架空历史", gameType: "alternate_history", caseId: "alternate-history-a" },
  { label: "末日", gameType: "post_apocalypse", caseId: "post-apocalypse-a" },
]);

/** caseId 白名单（由 GENRE_TO_CASE 派生，外部校验用）。 */
export const OFFLINE_CASE_IDS: readonly string[] = Object.freeze(
  GENRE_TO_CASE.map((entry) => entry.caseId),
);

/** FNV-1a 双路 32 位 → 16 位十六进制串（稳定可复现，与 fallback 同思路）。 */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  let hash2 = (0x811c9dc5 ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash2 ^= text.charCodeAt(i);
    hash2 = Math.imul(hash2, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0") + hash2.toString(16).padStart(8, "0");
}

/**
 * 按 caseId 解析离线基线。input 取自 v2.json；seed 由 caseId 派生。
 * 未知 caseId → null（由调用方映射为 400）。
 */
export function resolveOfflineBaseline(
  caseId: string,
): { readonly input: NewGameInput; readonly seed: string } | null {
  const found = RAW_CASES.find((entry) => entry.caseId === caseId);
  if (found === undefined) return null;
  return {
    input: found.input,
    seed: fnv1aHex(`offline-baseline:${caseId}`),
  };
}
```

### Step 4: 运行测试确认通过

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/game/application/server/offlineBaselines.test.ts`
Expected: PASS（5 tests）

### Step 5: 提交

```bash
git add src/game/application/server/offlineBaselines.ts src/game/application/server/offlineBaselines.test.ts
git commit -m "feat(server): 离线开局基线模块（题材→caseId 白名单 + v2.json 解析 + seed 派生）"
```

---

## Task 2: compositionRoot 扩展 createOfflineJourneyGame(caseId)

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`
- Test: `src/game/application/server/compositionRoot.test.ts`

**Interfaces:**
- Consumes: `resolveOfflineBaseline` from `./offlineBaselines`（Task 1）。
- Produces: 扩展 `ServerGameEntryPoints.createOfflineJourneyGame(caseId?: string, traceId?: string): Promise<OfflineJourneyGameResult>`；`caseId===undefined` → legacy `PHASE10_JOURNEY_BASELINE`；未知 caseId → `INVALID_INPUT`。
- **破坏性注意**：现有调用点 `createGameHandler.ts` 传的是 `traceId`（`entryPoints.createOfflineJourneyGame(context?.traceId)`），新签名把首参改为 `caseId`，Task 3 会同步改 handler。现有无参调用（`compositionRoot.test.ts:153`、`compositionRoot.storyEval.test.ts:52`）不受影响（undefined → legacy）。

- [ ] **Step 1: 写失败测试（先在 compositionRoot.test.ts 的已有 describe 内追加以证 caseId 路径）**

在 `src/game/application/server/compositionRoot.test.ts`（已有 `openDevelopmentEntryPoints` 与 `openEntryPoints` helper）的「开发离线旅程开局」describe 内追加：

```ts
it("createOfflineJourneyGame(caseId) 用 v2.json 题材基线创建 offline 存档", async () => {
  const entryPoints = openDevelopmentEntryPoints(nextDbPath());
  const created = await entryPoints.createOfflineJourneyGame("xianxia-a");
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.source).toBe("fallback");
  expect(created.view.world.gameType).toBe("xianxia");
  if (created.view.narrativeGeneration && "status" in created.view.narrativeGeneration) {
    // offline 模式：narrative.mode 为 offline（view 不含该字段，读存档验证）
  }
});

it("createOfflineJourneyGame(caseId) 未知 caseId 返回 INVALID_INPUT", async () => {
  const entryPoints = openDevelopmentEntryPoints(nextDbPath());
  const created = await entryPoints.createOfflineJourneyGame("nope");
  expect(created.ok).toBe(false);
  if (created.ok) return;
  expect(created.code).toBe("INVALID_INPUT");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/game/application/server/compositionRoot.test.ts`
Expected: FAIL（TS: `createOfflineJourneyGame` 不接受字符串实参 / 行为未实现）

- [ ] **Step 3: 实现 compositionRoot.ts**

3a. 顶部 import 增加：
```ts
import { resolveOfflineBaseline } from "./offlineBaselines";
```

3b. 接口签名（现有 `createOfflineJourneyGame(traceId?: string)`，约 92 行）改为：
```ts
/** 开发专用：使用离线基线开局（缺省 Phase 10 电视剧基线；caseId 经 offlineBaselines 解析），零 AI。 */
createOfflineJourneyGame(caseId?: string, traceId?: string): Promise<OfflineJourneyGameResult>;
```


3c. 实现主体（现有 `createOfflineJourneyGame: (traceId) => {...}`，约 390-403 行）改为：

```ts
createOfflineJourneyGame: (caseId, traceId) => {
  if (env.NODE_ENV !== "development") {
    logger.warn("offline_journey_create_rejected", {
      scope: "request",
      source: "rpg.server.create_offline_journey_game",
      code: "DEVELOPMENT_TOOLS_DISABLED",
    });
    return Promise.resolve({ ok: false, code: "DEVELOPMENT_TOOLS_DISABLED" });
  }
  const baseline = caseId === undefined
    ? PHASE10_JOURNEY_BASELINE
    : resolveOfflineBaseline(caseId);
  // handler 已在白名单拦截未知 caseId；此处防御漂移，返回稳定 INVALID_INPUT。
  if (baseline === null) {
    logger.warn("offline_journey_unknown_case", {
      scope: "request",
      source: "rpg.server.create_offline_journey_game",
      caseId,
    });
    return Promise.resolve({ ok: false, code: "INVALID_INPUT", fieldErrors: [] });
  }
  return runLoggedUseCase(logger, "create_offline_journey_game", () => createGame({
    input: baseline.input,
    seed: baseline.seed,
  }, offlineJourneyDependencies), {}, traceId);
},
```

注：`PHASE10_JOURNEY_BASELINE`（`{ input, seed }`）与 `resolveOfflineBaseline` 返回类型结构一致，`baseline` 三态（legacy / 解析 / null）合并后窄化正确。

- [ ] **Step 4: 运行测试确认通过**

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/game/application/server/compositionRoot.test.ts`
Expected: PASS（新增 2 条 + 原有全部通过）

- [ ] **Step 5: 提交**

```bash
git add src/game/application/server/compositionRoot.ts src/game/application/server/compositionRoot.test.ts
git commit -m "feat(server): createOfflineJourneyGame 支持按 caseId 解析 v2.json 基线"
```

---

## Task 3: createGameHandler 放宽 preset 允许伴随 caseId

**Files:**
- Modify: `src/app/api/game/createGameHandler.ts`
- Test: `src/app/api/game/createGameHandler.test.ts`

**Interfaces:**
- Consumes: `OFFLINE_CASE_IDS` from `@/game/application/server/offlineBaselines`（Task 1）；`createOfflineJourneyGame(caseId?, traceId?)`（Task 2）。
- Produces: preset 分支接受 `{ developmentPreset, caseId? }`；白名单外字段 → 400 `UNEXPECTED_FIELDS`；caseId 非字符串 → 400 `INVALID_FIELD_TYPES[caseId]`；未知 caseId → 400 `UNEXPECTED_FIELDS[caseId]`；缺失 → 传 `undefined`（legacy）。

- [ ] **Step 1: 写失败测试（在已有「开发离线旅程开局」describe 内追加）**

在 `src/app/api/game/createGameHandler.test.ts`（已有 `postJson`、`openDevelopmentEntryPoints`）追加：

```ts
it("preset + 合法 caseId ⇒ 201 该题材基线", async () => {
  const entryPoints = openDevelopmentEntryPoints(nextDbPath());
  const response = await handleCreateGameRequest(
    postJson({ developmentPreset: "phase10-journey-v1", caseId: "post-apocalypse-a" }),
    entryPoints,
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  expect(body.view.world.gameType).toBe("post_apocalypse");
});

it("preset + 未知 caseId ⇒ 400 UNEXPECTED_FIELDS[caseId] 且不创建", async () => {
  const databasePath = nextDbPath();
  const entryPoints = openDevelopmentEntryPoints(databasePath);
  const response = await handleCreateGameRequest(
    postJson({ developmentPreset: "phase10-journey-v1", caseId: "unknown" }),
    entryPoints,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: "UNEXPECTED_FIELDS", fields: ["caseId"] });
});

it("preset + caseId 类型错误 ⇒ 400 INVALID_FIELD_TYPES[caseId]", async () => {
  const entryPoints = openDevelopmentEntryPoints(nextDbPath());
  const response = await handleCreateGameRequest(
    postJson({ developmentPreset: "phase10-journey-v1", caseId: 42 }),
    entryPoints,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: "INVALID_FIELD_TYPES", fields: ["caseId"] });
});

it("preset + 白名单外其他字段 ⇒ 400 UNEXPECTED_FIELDS", async () => {
  const entryPoints = openDevelopmentEntryPoints(nextDbPath());
  const response = await handleCreateGameRequest(
    postJson({ developmentPreset: "phase10-journey-v1", caseId: "wuxia-a", evil: 1 }),
    entryPoints,
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as { fields?: string[] };
  expect(body.fields).toContain("evil");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/app/api/game/createGameHandler.test.ts`
Expected: FAIL（preset 分支仍要求 `Object.keys(record).length === 1`，带 caseId 请求落到 normal 路径被拒）

- [ ] **Step 3: 实现 createGameHandler.ts**

3a. 顶部 import 增加（handler 属于 server 层，import server 模块合法）：
```ts
import { OFFLINE_CASE_IDS } from "@/game/application/server/offlineBaselines";
```

3b. 替换现有 preset 分支（`if (record["developmentPreset"] === OFFLINE_JOURNEY_PRESET && Object.keys(record).length === 1)`，约 67 行）：

```ts
if (record["developmentPreset"] === OFFLINE_JOURNEY_PRESET) {
  const extraKeys = Object.keys(record).filter((key) => key !== "developmentPreset");
  const unexpected = extraKeys.filter((key) => key !== "caseId");
  if (unexpected.length > 0) {
    return json(400, { code: "UNEXPECTED_FIELDS", fields: unexpected.sort() }, context);
  }
  const rawCaseId = record["caseId"];
  if (rawCaseId !== undefined && typeof rawCaseId !== "string") {
    return json(400, { code: "INVALID_FIELD_TYPES", fields: ["caseId"] }, context);
  }
  const caseId = rawCaseId as string | undefined;
  if (caseId !== undefined && !OFFLINE_CASE_IDS.includes(caseId)) {
    return json(400, { code: "UNEXPECTED_FIELDS", fields: ["caseId"] }, context);
  }
  if (entryPoints.createOfflineJourneyGame === undefined) {
    return json(403, { code: "DEVELOPMENT_TOOLS_DISABLED" }, context);
  }
  let presetResult;
  try {
    presetResult = await entryPoints.createOfflineJourneyGame(caseId, context?.traceId);
  } catch {
    return json(500, { code: "INTERNAL_ERROR" }, context);
  }
  if (presetResult.ok) {
    return json(201, { view: presetResult.view, generationSource: presetResult.source }, context);
  }
  if (presetResult.code === "DEVELOPMENT_TOOLS_DISABLED") {
    return json(403, { code: presetResult.code }, context);
  }
  switch (presetResult.code) {
    case "INVALID_INPUT": return json(400, { code: presetResult.code, fieldErrors: presetResult.fieldErrors }, context);
    case "ACTIVE_GAME_EXISTS": return json(409, { code: presetResult.code }, context);
    case "GENERATION_INVALID": return json(422, { code: presetResult.code }, context);
    case "INFRASTRUCTURE_FAILURE": return json(503, { code: presetResult.code }, context);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/app/api/game/createGameHandler.test.ts`
Expected: PASS（新增 4 条 + 原「纯 preset ⇒ 201 wuxia」与「非 dev ⇒ 403」仍通过）

- [ ] **Step 5: 提交**

```bash
git add src/app/api/game/createGameHandler.ts src/app/api/game/createGameHandler.test.ts
git commit -m "feat(api): POST /api/game 开发 preset 允许伴随白名单 caseId"
```

---

## Task 4: NewGameSetupForm 7 题材下拉

**Files:**
- Modify: `src/components/NewGameSetupForm.tsx`
- Test: `src/components/NewGameSetupForm.test.tsx`

**Interfaces:**
- Consumes: 无 server 模块（前端不 import server 层）。自带展示用 `OFFLINE_GENRES` 常量；安全边界在 server 白名单（Task 1），前端传任意 caseId 都会被 server 校验。
- Produces: dev 下渲染「题材」下拉 + 提交 body 携带 `caseId`；`handleOfflineJourneyStart` 改为 `{ developmentPreset, caseId }`。

- [ ] **Step 1: 更新 UI 测试（修改现有 + 新增）**

在 `src/components/NewGameSetupForm.test.tsx`：

1a. 现有「开发环境可使用已有离线旅程数据开始」测试的 body 断言（约 61-73 行，原 `toEqual({ developmentPreset: "phase10-journey-v1" })`）改为：

```ts
expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
  developmentPreset: "phase10-journey-v1",
  caseId: "wuxia-a",
});
```

1b. 新增下拉测试（追加到同一文件）：

```ts
it("开发环境渲染 7 题材下拉，默认武侠；选择后提交携带所选 caseId", async () => {
  const view = buildSessionViewFixture();
  const fetchMock = stubFetch(async () => jsonResponse(201, { view, generationSource: "fallback" }));
  const onCreated = vi.fn();
  const user = userEvent.setup();
  render(<NewGameSetupForm developmentTools onCreated={onCreated} />);

  const select = screen.getByLabelText("离线题材");
  expect(select).toBeInTheDocument();
  expect(select).toHaveValue("wuxia-a");
  for (const label of ["武侠", "仙侠", "奇幻", "科幻", "都市", "架空历史", "末日"]) {
    expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
  }

  await user.selectOptions(select, "post-apocalypse-a");
  await user.click(screen.getByRole("button", { name: "使用已有数据开始" }));

  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(view, "fallback"));
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    developmentPreset: "phase10-journey-v1",
    caseId: "post-apocalypse-a",
  });
});
```

- [ ] **Step 2: 运行 UI 测试确认失败**

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/components/NewGameSetupForm.test.tsx`
Expected: FAIL（body 缺 caseId / 无「离线题材」下拉）

- [ ] **Step 3: 实现 NewGameSetupForm.tsx**

3a. 模块级新增（文件顶部，`GAME_TYPES` 之后）：

```ts
/** 离线开局题材下拉：展示项与 server 白名单一致；server 才是安全边界。 */
const OFFLINE_GENRES: readonly { readonly label: string; readonly caseId: string }[] = [
  { label: "武侠", caseId: "wuxia-a" },
  { label: "仙侠", caseId: "xianxia-a" },
  { label: "奇幻", caseId: "fantasy-a" },
  { label: "科幻", caseId: "science-fiction-a" },
  { label: "都市", caseId: "urban-a" },
  { label: "架空历史", caseId: "alternate-history-a" },
  { label: "末日", caseId: "post-apocalypse-a" },
];
```

3b. 组件内 state（`useState` 区）增加：

```ts
const [offlineCaseId, setOfflineCaseId] = useState<string>("wuxia-a");
```

3c. `handleOfflineJourneyStart` 的请求 body（原 `{ developmentPreset: "phase10-journey-v1" }`）改为：

```ts
body: JSON.stringify({ developmentPreset: "phase10-journey-v1", caseId: offlineCaseId })
```

3d. 开发 Panel 内按钮上方加下拉（现有 `developmentTools ?` Panel 内、`InlineButton` 之前；沿用同一 `Panel compact` 结构）：

```tsx
<label className="offline-genre-select">
  <span>题材</span>
  <select
    name="offlineGenre"
    aria-label="离线题材"
    value={offlineCaseId}
    onChange={(event) => setOfflineCaseId(event.target.value)}
  >
    {OFFLINE_GENRES.map((genre) => (
      <option key={genre.caseId} value={genre.caseId}>
        {genre.label}
      </option>
    ))}
  </select>
</label>
```

- [ ] **Step 4: 运行 UI 测试确认通过**

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/components/NewGameSetupForm.test.tsx`
Expected: PASS（新增 + 修改断言通过；「非 dev 不渲染」测试仍通过）

- [ ] **Step 5: 提交**

```bash
git add src/components/NewGameSetupForm.tsx src/components/NewGameSetupForm.test.tsx
git commit -m "feat(ui): 开发开局加 7 题材下拉，提交携带 caseId"
```

---

## Task 5: 7 题材零 AI 规则通关回归

**Files:**
- Create: `src/game/application/testing/offlineGenreJourney.ts`（通用 harness 辅助：BFS 路径 + objective→intent 泛化 + battle 推导，**借鉴并泛化** `phase4cOfflineJourneyRegression.test.ts`）
- Create: `src/game/application/testing/offlineGenreJourney.test.ts`（7 题材各一，fallback 蓝图 + offline mode 走到结局）

**Interfaces:**
- Consumes: `resolveOfflineBaseline`/`OFFLINE_CASE_IDS`（Task 1）；`createGame`/`performAction`/`getCurrentGame`；`PlayerIntent` from `@/game/gameplay/rpg/actions`。
- Produces: 证明 7 条 fallback 蓝图在 `runtimeNarrativeMode:"offline"` + 无 `runtimeNarrativeSources` 下可规则循环到成功结局、零 fetch。

**机器可读事实（Task 5 依据）**：`createBudgetPolicy("long").mainActs === 8`；fallback 蓝图 `kind:"main"` quest 的 `stage` 从 1 递增到 `mainActs`；每个 objective 的 target ID 可在蓝图 `npcs/items/facts/enemies/locations` 中定位其所在 `locationId`；终幕 active 后 `start_battle` + `battle_action:"attack"` 直到 boss 死亡触发成功结局。

### Step 1: 写失败测试（offlineGenreJourney.test.ts）

参考 `phase4cOfflineJourneyRegression.test.ts` 的 openRepository/afterAll/performDeps 结构，新建测试文件：

```ts
/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { OFFLINE_CASE_IDS } from "../server/offlineBaselines";
import { createGame } from "../createGame";
import { getCurrentGame } from "../getCurrentGame";
import { performAction } from "../performAction";
import { createUnavailableTestScenarioSource } from "../applicationFixture.testutil";
import { buildEndToEndRuleJourney, findBossEnemy, performRuleSequence } from "./offlineGenreJourney";
import { asGameId } from "../server/persistence/gameRepository";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository, type SqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { resolve, join } from "node:path";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

// —— tmp/ 暂存策略与 phase4c 相同 ——
const TMP_ROOT = resolve("tmp");
const RUN_PREFIX = "sqlite-offline-genre-";
try {
  for (const entry of readdirSync(TMP_ROOT)) {
    if (entry.startsWith(RUN_PREFIX)) {
      try { rmSync(join(TMP_ROOT, entry), { recursive: true, force: true }); } catch { /* 占用忽略 */ }
    }
  }
} catch { /* 无 tmp */ }
const RUN_ROOT = join(TMP_ROOT, `${RUN_PREFIX}${Date.now()}-${process.pid}`);
mkdirSync(RUN_ROOT, { recursive: true });
const openRepos: SqliteGameRepository[] = [];

afterAll(() => openRepos.forEach((r) => void r.close()));

function openRepository(name: string): SqliteGameRepository {
  const repo = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(join(RUN_ROOT, `${name}.sqlite`)),
    logError: () => {},
  });
  openRepos.push(repo);
  return repo;
}

function offlineDeps(repo: SqliteGameRepository) {
  return {
    repository: repo,
    newGameId: () => asGameId(`genre-${Math.random().toString(36).slice(2)}`),
    newSeed: () => "seed-unused",
    newTraceId: () => "genre-journey",
    now: () => "2026-08-04T00:00:00.000Z",
    scenarioCandidateSource: createUnavailableTestScenarioSource(),
    runtimeNarrativeMode: "offline" as const,
  };
}

describe("offlineGenreJourney：7 题材 fallback 蓝图零 AI 规则通关", () => {
  for (const caseId of OFFLINE_CASE_IDS) {
    it(`${caseId}：fallback 蓝图 + offline → 规则行动 → 成功结局，零 fetch`, async () => {
      const baseline = require("../server/offlineBaselines").resolveOfflineBaseline(caseId);
      expect(baseline).not.toBeNull();
      if (baseline === null) return;
      const writer = openRepository(caseId);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
        throw new Error("zero-network expected");
      });
      try {
        const created = await createGame({ input: baseline.input, seed: baseline.seed }, offlineDeps(writer));
        expect(created.ok).toBe(true);
        if (!created.ok) return;
        expect(created.source).toBe("fallback");

        const read = await getCurrentGame({ repository: writer });
        expect(read.status).toBe("active");
        if (read.status !== "active") return;
        const blueprint = await (async () => {
          const check = await (writer as unknown as { getCurrentGame: () => Promise<{ ok: boolean; status: string; record: { blueprint: unknown } }> }).getCurrentGame();
          return check.record.blueprint;
        })();
        const boss = findBossEnemy(blueprint as never);
        const journey = buildEndToEndRuleJourney(blueprint as never, boss.locationId);
        let revision = read.view.revision;
        revision = await performRuleSequence(writer, journey.intents, revision);
        const battleResult = await performAction(
          { intent: { type: "start_battle", enemyId: boss.id }, expectedRevision: revision },
          { repository: writer, now: () => "2026-08-04T00:00:00.000Z" },
        );
        expect(battleResult.ok).toBe(true);
        if (!battleResult.ok) return;
        revision = battleResult.view.revision;
        let guard = 0;
        while (battleResult.view.battle !== null && guard < 200) {
          guard += 1;
          const attack = await performAction(
            { intent: { type: "battle_action", action: "attack" as const }, expectedRevision: revision },
            { repository: writer, now: () => "2026-08-04T00:00:00.000Z" },
          );
          if (!attack.ok) throw new Error("attack 应当成功");
          revision = attack.view.revision;
          if (attack.view.ending !== null) break;
        }
        expect(battleResult.view.ending ?? null).not.toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    }, 60_000);
  }
});
```

注：上方测试内联读存档取 blueprint；`vi` 需 `import { vi } from "vitest"`。若内联 `getCurrentGame` 类型不便，可为 repository 增加 `loadActiveRecord`（reference phase4c 的 `loadActiveRecord`）。

### Step 2: 实现 harness（offlineGenreJourney.ts）

借鉴 `phase4cOfflineJourneyRegression.test.ts` 的 `movePath`/`appendTravel`/`performSequence`/`findBossEnemy`，泛化 `buildStage3ReadyJourney` 覆盖全部 main stage（`mainActs` 而非写死 3），并补 `discover_fact`/`defeat_enemy` 目标映射。

```ts
import type { ScenarioBlueprint, PlayerIntent } from "@/game/domain";
// 说明：PlayerIntent 实际来自 @/game/gameplay/rpg/actions；此处用 domain 类型别名保持一致（以 phase4c 的实际导入为准）。

type QuestLike = { kind: string; stage: number | null; objectives: readonly { kind: string; npcId?: string; itemId?: string; factId?: string; enemyId?: string; locationId?: string }[] };

/** 由蓝图定位实体所在 locationId（item 用 availableItemIds 反查、fact 用 investigableFactIds 反查）。 */
function entityLocation(blueprint: ScenarioBlueprint, kind: "npc" | "item" | "fact" | "enemy", id: string): string {
  if (kind === "npc") {
    const npc = blueprint.npcs.find((n) => n.id === id);
    if (npc) return npc.locationId;
  }
  for (const loc of blueprint.locations) {
    if (kind === "item" && loc.availableItemIds?.includes(id)) return loc.id;
    if (kind === "fact" && loc.investigableFactIds?.includes(id)) return loc.id;
  }
  if (kind === "enemy") {
    const enemy = blueprint.enemies.find((e) => e.id === id);
    if (enemy) return enemy.locationId;
  }
  throw new Error(`无法定位 ${kind}:${id} 的所在地点`);
}

/** 旅行辅助：把路径每一步转成 move intent（依赖当前起点）。 */
function appendTravel(blueprint: ScenarioBlueprint, intents: PlayerIntent[], fromId: string, toId: string): string {
  // BFS 求出 fromId→toId 的最短路径（实现同 phase4c movePath），
  // 每一步 push { type: "move", locationId }，返回终点。
  return /* … */ "";
}

/**
 * 泛化全主线：stage 1..mainActs-1 的 objectives 逐类映射为 intent，
 * 推到最后一幕 active 并抵达 boss 所在地点。若缺陷蓝图缺目标 throw。
 */
export function buildEndToEndRuleJourney(blueprint: ScenarioBlueprint, bossLocationId: string): {
  intents: readonly PlayerIntent[];
  endLocationId: string;
} {
  const mainQuests = blueprint.quests.filter((q) => q.kind === "main")
    .sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0)) as readonly QuestLike[];
  const mainActs = mainQuests.length;
  const intents: PlayerIntent[] = [];
  let at = blueprint.player.startingLocationId;
  for (let stage = 1; stage < mainActs; stage += 1) {
    const quest = mainQuests[stage - 1];
    for (const obj of quest.objectives) {
      let target = obj.locationId;
      if (obj.npcId) target = entityLocation(blueprint, "npc", obj.npcId);
      else if (obj.itemId) target = entityLocation(blueprint, "item", obj.itemId);
      else if (obj.factId) target = entityLocation(blueprint, "fact", obj.factId);
      else if (obj.enemyId) target = entityLocation(blueprint, "enemy", obj.enemyId);
      if (target !== at) at = appendTravel(blueprint, intents, at, target);
      if (obj.npcId) intents.push({ type: "talk", npcId: obj.npcId } as PlayerIntent);
      else if (obj.itemId) intents.push({ type: "take_item", itemId: obj.itemId } as PlayerIntent);
      else if (obj.factId) intents.push({ type: "investigate", factId: obj.factId } as PlayerIntent);
      else if (obj.enemyId) intents.push({ type: "start_battle", enemyId: obj.enemyId } as PlayerIntent);
    }
  }
  if (at !== bossLocationId) at = appendTravel(blueprint, intents, at, bossLocationId);
  return { intents, endLocationId: at };
}
```

**实现提示（消除占位符）**：`appendTravel` 中标注 `/* … */` 处即 phase4c 的 `movePath`（BFS 最短路径）——直接从 `phase4cOfflineJourneyRegression.test.ts` 复制 `movePath` 与 `appendTravel` 的完整实现（它们已通用，不假设 stage 数）。`findBossEnemy` 与 `performRuleSequence`（= phase4c `perfromSequence`，逐 intent `performAction` 后返回最新 revision）同样照搬。`PlayerIntent` 从 `@/game/gameplay/rpg/actions` 导入（Phase4c 第 12 行即 `import { type PlayerIntent } from "@/game/gameplay/rpg/actions"`）。

### Step 3: 运行并固化为简洁测试

- [ ] **3a. 先只跑 harness 编译**

Run: `Set-Location F:\AI2\ai-rpg-game; npx tsc --noEmit`（或 `npm run typecheck`）
Expected: FAIL 到通过（补齐 `resolveOfflineBaseline` 导入、`vi` import、repository 取 blueprint 的类型收窄）

- [ ] **3b. 用更简洁的最终版测试替换 Step 1 草稿**（避免 Step 1 内联 journey/battle 的翻转瑕疵 —— battle 循环应基于**最新 view** 判断）：

将 Step 1 的 `it(...)` 主体替换为：

```ts
it(`${caseId}：fallback + offline → 规则行动 → 成功结局，零 fetch`, async () => {
  const baseline = resolveOfflineBaseline(caseId);
  expect(baseline).not.toBeNull();
  if (baseline === null) return;
  const writer = openRepository(caseId);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("zero-network expected");
  });
  try {
    const created = await createGame(
      { input: baseline.input, seed: baseline.seed },
      offlineDeps(writer),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source).toBe("fallback");

    const record = await loadActiveRecord(writer); // 从 phase4c 复制此 helper
    const boss = findBossEnemy(record.blueprint);
    const journey = buildEndToEndRuleJourney(record.blueprint, boss.locationId);
    let revision = 0;
    revision = await performRuleSequence(writer, journey.intents, revision);

    const started = await performAction(
      { intent: { type: "start_battle", enemyId: boss.id }, expectedRevision: revision },
      actionDeps(writer),
    );
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    let view = started.view; // 最新 view，用于循环判断
    let guard = 0;
    while (view.battle !== null && view.ending === null && guard < 200) {
      guard += 1;
      const attack = await performAction(
        { intent: { type: "battle_action", action: "attack" }, expectedRevision: view.revision },
        actionDeps(writer),
      );
      if (!attack.ok) throw new Error("attack 应当成功");
      view = attack.view;
    }
    expect(view.ending).not.toBeNull();
    if (view.ending !== null) expect(view.ending.outcome).toBe("success");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
}, 60_000);
```

其中 `actionDeps(repo)` 返回 `{ repository: repo, now: () => "2026-08-04T00:00:00.000Z" }`；`loadActiveRecord`/`findBossEnemy` 从 phase4c 复制。

- [ ] **Step 4: 运行 7 题材回归确认通过**

Run: `Set-Location F:\AI2\ai-rpg-game; npx vitest run src/game/application/testing/offlineGenreJourney.test.ts`
Expected: PASS（7 个 caseId 各 1 条 + 失败即红）

- [ ] **Step 5: 提交**

```bash
git add src/game/application/testing/offlineGenreJourney.ts src/game/application/testing/offlineGenreJourney.test.ts
git commit -m "test(regression): 7 题材 fallback 蓝图离线规则通关回归"
```

- [ ] **Step 6: 视需要更新 spec 的 §8/§9 措辞**（把「不存在现成零 AI 通关 harness」改为「phase4c 已是现成 harness，本 Task 借鉴泛化」），并在 `docs/agent/<相关>.md` 登记实现事实（见 Task 6）。


---

## Task 6: 文档同步与全量验收

**Files:**
- Modify: `docs/Agent文档索引.md`（如需要登记）
- Modify: 相关 `docs/agent/*.md`（`无AI试玩验收.md`、`地图与地点冒险.md` —— 登记「离线开局 7 题材下拉」实现事实）
- Modify: `docs/superpowers/specs/2026-08-04-offline-genre-baselines-design.md`（§8/§9 措辞按 Task 5 Step 6 修正，如有）

**Consumes:** Task 1-5 全部就绪。

- [ ] **Step 1: 登记实现事实**

在 `docs/agent/无AI试玩验收.md` 与 `docs/agent/地图与地点冒险.md` 各加一条（示例）：
> 2026-08-04：开发环境「使用已有数据开始」扩展为 7 题材下拉；按 caseId 复用 `data/story-eval/cases/v2.json` 输入 + 派生 seed 创建 offline 存档（确定性 fallback 蓝图 + `runtimeNarrativeMode:"offline"`，零 AI）。新增 `server/offlineBaselines.ts`（题材→caseId 白名单 + seed 派生）与 7 题材零 AI 规则通关回归 `testing/offlineGenreJourney.test.ts`。

同步更新 `docs/Agent文档索引.md`（如该行提及单题材离线则改为 7 题材）。

- [ ] **Step 2: 全量离线验收**

Run:
```bash
npm run lint
npm run typecheck
npm test
npm run build
```
Expected: 全部通过（离线）；`npm test` 全量不触发网络/AI。

- [ ] **Step 3: 提交**

```bash
git add docs/Agent文档索引.md docs/agent/无AI试玩验收.md docs/agent/地图与地点冒险.md docs/superpowers/specs/2026-08-04-offline-genre-baselines-design.md
git commit -m "docs: 登记离线 7 题材开局实现事实"
```

---

## Self-Review 结论

- **Spec 覆盖**：§6.1 前端下拉 → Task 4；§6.2 API caseId → Task 3；§6.3 offlineBaselines → Task 1；§6.4 compositionRoot → Task 2；§5 映射/白名单 → Task 1；§9 测试 → Task 1-5；§8 通关证据 → Task 5；§12 文档 → Task 6。§6.5 复用 offline 链路由实现沿用、无新代码。
- **占位符**：Task 5 的 BFS/helper 明确指示复制 phase4c 完整实现（非待办）；其余步骤含具体代码。
- **类型一致**：`createOfflineJourneyGame(caseId?, traceId?)` 在 Task 2 定义、Task 3 调用一致；`resolveOfflineBaseline`/`OFFLINE_CASE_IDS` 在 Task 1 定义、Task 2/3/5 消费一致。⚠️ 唯一需注意：Task 2 Step 1 测试引用了 `created.view.world.gameType`（存在）与 `created.source`（CreateGameResult 有 source 字段），已核对。

