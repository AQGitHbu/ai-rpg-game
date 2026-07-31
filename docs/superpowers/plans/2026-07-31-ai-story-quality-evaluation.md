# AI 故事质量评估方案实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可重复的 AI 故事质量评估管线：评估专用采集通道（三采集点写 `artifacts/story-eval/<run-id>/`）、长故事旅程驱动、离线指标分析、LLM-as-judge 评审，以及版本化量表文档 v1。

**Architecture:** 采集不做单一装饰器，而是三个采集点各取其唯一可见的数据——source 工厂内注入 `captureSink`（prompt/模型原文只在 source 内部可见）、编排层 `approvalObserver`（审批结果 + 已批准导演计划）、旅程驱动侧组装 story.jsonl。所有注入均为可选参数，`STORY_EVAL_CAPTURE` 未设置时装配与行为与现状完全一致。旅程经 `createServerGameEntryPoints` 驱动（唯一命中装配点的服务端路径），驱动侧另开评估专用只读 repository 读取 actionKey/seed/蓝图。

**Tech Stack:** Node 20+ / TypeScript 5.8 / Vitest 3.1 / @ai-game/ai-transport（不改 foundation）/ SQLite（@libsql/client）/ Node 24 strip-types（门禁脚本经 registerHooks 加载 TS）

## Global Constraints

- 规格唯一事实源：`docs/superpowers/specs/2026-07-31-ai-story-quality-evaluation-design.md`（approved，commit b7120a6）。任务实现与之冲突时以 spec 为准并报告。
- 环境变量全部可选，未设置零影响：`STORY_EVAL_CAPTURE`、`STORY_EVAL_ARTIFACT_DIR`（门禁脚本专用，composition root 缺省派生 `<ISO时间戳>-<pid>`）、`RUN_REAL_AI_STORY_EVAL`、`STORY_EVAL_SEED`、`STORY_EVAL_MAX_SCENES`（默认 60）、`RUN_REAL_AI_STORY_EVAL_JUDGE`、`STORY_EVAL_JUDGE_MODEL`。
- 安全红线：不改日志脱敏、fixture 录制格式、审批红线、journey 契约；`artifacts/` 与 `tmp/` 已在 .gitignore，产物永不进 git；`AI_API_KEY` 等凭据永不落盘；真实计费调用必须显式 env 开关；采集失败静默降级，绝不抛错到游戏主流程。
- 不修改 `@ai-game/*` foundation package（含 `.foundation/packages/ai-transport`）；不修改现有 npm 脚本的既有行为。
- TDD：每个任务先写失败测试再实现；每个任务结束跑该任务测试 + `npm run typecheck`；涉及 composition 链的任务追加跑 `npm run test:phase10-journey`（回归：`STORY_EVAL_CAPTURE` 未设置时行为不变）。
- 分支放 `.worktrees/`（不用 `git checkout`）；worktree 内存在 `.foundation` junction 时，清理必须用 `node ../ai-game-foundation/scripts/cleanupConsumerWorktree.mjs --repository . --worktree-name <name>`。
- 提交粒度：每个任务一次 commit，信息含 `feat(ai-story-eval): ...` 前缀；`git add` 只加本任务文件。

---

### Task 1: storyEvalCapture 模块（Sink 接口 + 文件 sink + 审批事件映射）

**Files:**
- Create: `src/game/application/server/ai/storyEvalCapture.ts`
- Test: `src/game/application/server/ai/storyEvalCapture.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）:
  - `type StoryEvalCallRecord = { kind: "ai_call"; role: "scenario" | "director" | "writer" | "npc"; traceId: string; attempt: number; messages: readonly { role: string; content: string }[]; rawResponse: string | null; parsedCandidate: Readonly<Record<string, unknown>> | null; failureCategory: string | null; latencyMs: number }`——**关联键契约**：`traceId` 一律为场景级原始 id（ai_call 由 source 层从 request.traceId 去掉 `-director/-script/-npcLine` 与 `-retry` 后缀归一化，见 Task 2；审批记录由编排层直接用场景 traceId）；`attempt` 为同场景同角色 **1-based** 尝试序号（首次=1，重试递增；ai_call 从 request.traceId 中 `-retry` 出现次数 +1 解析，审批记录由编排层循环变量 +1）。两套记录按 `traceId + role + attempt` 关联（spec §6.1）。
  - `type StoryEvalApprovalRecord = { kind: "role_approval"; traceId: string; role: "director" | "writer" | "npc"; attempt: number; category: string | null } | { kind: "plan_approved"; traceId: string; attempt: number; planSummary: Readonly<Record<string, unknown>> } | { kind: "expansion_decision"; traceId: string; decision: BlueprintExpansionDecision }`——`role_approval`/`plan_approved` 的 `traceId`/`attempt` 与 ai_call 同契约（见上）
  - `type StoryEvalRecord = StoryEvalCallRecord | StoryEvalApprovalRecord`
  - `type StoryEvalSink = { append(record: StoryEvalRecord): void }`
  - `type StoryEvalApprovalEvent`（见代码；与 ApprovalRecord 形状一致，供编排层 emit）
  - `createFileStoryEvalSink(directory: string): StoryEvalSink`（同步追加写 `calls.jsonl`，写失败静默降级）
  - `createStoryEvalApprovalObserver(sink: StoryEvalSink): (event: StoryEvalApprovalEvent) => void`

- [ ] **Step 1: 写失败测试**

创建 `src/game/application/server/ai/storyEvalCapture.test.ts`：

```typescript
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileStoryEvalSink,
  createStoryEvalApprovalObserver,
  type StoryEvalApprovalEvent,
  type StoryEvalCallRecord,
} from "./storyEvalCapture";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "story-eval-"));
  dirs.push(dir);
  return dir;
}

const sampleCall: StoryEvalCallRecord = {
  kind: "ai_call",
  role: "director",
  traceId: "trace-1",
  attempt: 1,
  messages: [{ role: "system", content: "instr" }, { role: "user", content: "{}" }],
  rawResponse: '{"ok":true}',
  parsedCandidate: { ok: true },
  failureCategory: null,
  latencyMs: 12,
};

describe("createFileStoryEvalSink", () => {
  it("同步追加写 JSONL 到 calls.jsonl，每条一行", () => {
    const dir = tempDir();
    const sink = createFileStoryEvalSink(dir);
    sink.append(sampleCall);
    sink.append({ kind: "role_approval", traceId: "trace-1", role: "director", attempt: 1, category: null });
    const lines = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: "ai_call", role: "director", traceId: "trace-1" });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: "role_approval", category: null });
  });

  it("目录创建失败时降级为 no-op，绝不抛错", () => {
    const dir = tempDir();
    const occupiedFile = join(dir, "occupied");
    writeFileSync(occupiedFile, "x", "utf8");
    const sink = createFileStoryEvalSink(occupiedFile); // mkdirSync 在已存在文件路径上失败
    expect(() => sink.append(sampleCall)).not.toThrow();
    expect(readdirSync(dir)).toEqual(["occupied"]);
  });
});

describe("createStoryEvalApprovalObserver", () => {
  it("把三类审批事件映射为 sink 记录", () => {
    const dir = tempDir();
    const sink = createFileStoryEvalSink(dir);
    const observer = createStoryEvalApprovalObserver(sink);
    const events: StoryEvalApprovalEvent[] = [
      { kind: "role_approval", traceId: "t1", role: "director", attempt: 1, category: "reference_violation" },
      { kind: "plan_approved", traceId: "t1", attempt: 1, planSummary: { pacing: "setup", tensionLevel: 2, focusNpcId: null } },
      { kind: "expansion_decision", traceId: "t1", decision: { ok: false, reason: "none_proposed" } },
    ];
    for (const event of events) observer(event);
    const lines = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.kind)).toEqual(["role_approval", "plan_approved", "expansion_decision"]);
    expect(lines[1].planSummary.tensionLevel).toBe(2);
    expect(lines[2].decision.reason).toBe("none_proposed");
  });

  it("observer 回调抛错时静默降级（sink.append 抛错也被吞掉）", () => {
    const dir = tempDir();
    const sink = createFileStoryEvalSink(dir);
    const observer = createStoryEvalApprovalObserver(sink);
    const throwingObserver = createStoryEvalApprovalObserver({
      append() { throw new Error("sink boom"); },
    });
    expect(() => throwingObserver({ kind: "plan_approved", traceId: "t", attempt: 1, planSummary: {} })).not.toThrow();
    expect(() => observer({ kind: "role_approval", traceId: "t", role: "npc", attempt: 1, category: null })).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/server/ai/storyEvalCapture.test.ts`
Expected: FAIL（`Cannot find module './storyEvalCapture'`）

- [ ] **Step 3: 写最小实现**

创建 `src/game/application/server/ai/storyEvalCapture.ts`：

```typescript
// ---------------------------------------------------------------------------
// storyEvalCapture：评估专用采集通道（spec §6）。
//
// 只有两个职责：
// 1. StoryEvalSink —— 同步追加写 JSONL 的容错 sink（写失败静默降级，绝不抛错）；
// 2. createStoryEvalApprovalObserver —— 把编排层审批事件映射为 sink 记录。
// prompt/模型原文只在 source 内部捕获后写入；审批结果只在编排层可见后写入；
// 本模块不 import repository/persistence/transport（目录边界守卫保证）。
// 未装配（captureSink/approvalObserver 为 undefined）时零开销、零行为变化。
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BlueprintExpansionDecision } from "@/game/gameplay/rpg/narrative";

/** source 工厂捕获回调写入的记录：一次 AI 调用的完整素材（仅采集模式）。
 *  关联键契约：traceId 为场景级原始 id（source 层从 request.traceId 去角色/重试后缀归一化），
 *  attempt 为同场景同角色 1-based 尝试序号；按 traceId + role + attempt 与审批记录关联。 */
export type StoryEvalCallRecord = {
  readonly kind: "ai_call";
  readonly role: "scenario" | "director" | "writer" | "npc";
  readonly traceId: string;
  readonly attempt: number;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly rawResponse: string | null;
  readonly parsedCandidate: Readonly<Record<string, unknown>> | null;
  readonly failureCategory: string | null;
  readonly latencyMs: number;
};

/** 编排层审批记录：按 traceId + role + attempt 与 ai_call 记录关联（同一关联键契约）。
 *  traceId 为场景级原始 id；attempt 为同场景同角色 1-based 尝试序号。 */
export type StoryEvalApprovalRecord =
  | {
      readonly kind: "role_approval";
      readonly traceId: string;
      readonly role: "director" | "writer" | "npc";
      readonly attempt: number;
      readonly category: string | null;
    }
  | {
      readonly kind: "plan_approved";
      readonly traceId: string;
      readonly attempt: number;
      readonly planSummary: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "expansion_decision";
      readonly traceId: string;
      readonly decision: BlueprintExpansionDecision;
    };

export type StoryEvalRecord = StoryEvalCallRecord | StoryEvalApprovalRecord;

export type StoryEvalSink = Readonly<{
  append(record: StoryEvalRecord): void;
}>;

/** 编排层审批事件（orchestrateNarrativeScene 内部产生，经 approvalObserver 发出）。 */
export type StoryEvalApprovalEvent =
  | {
      readonly kind: "role_approval";
      readonly traceId: string;
      readonly role: "director" | "writer" | "npc";
      readonly attempt: number;
      readonly category: string | null;
    }
  | {
      readonly kind: "plan_approved";
      readonly traceId: string;
      readonly attempt: number;
      readonly planSummary: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "expansion_decision";
      readonly traceId: string;
      readonly decision: BlueprintExpansionDecision;
    };

/** 同步追加写 calls.jsonl；目录/写入失败一律静默降级（与日志 sink 同一容错哲学）。 */
export function createFileStoryEvalSink(directory: string): StoryEvalSink {
  let filePath: string | null = null;
  try {
    mkdirSync(directory, { recursive: true });
    filePath = join(directory, "calls.jsonl");
  } catch {
    // 目录创建失败：降级为 no-op sink，绝不抛错到游戏主流程。
  }
  return {
    append(record) {
      if (filePath === null) return;
      try {
        appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
      } catch {
        // 写失败静默降级。
      }
    },
  };
}

/** 把编排层审批事件映射为 sink 记录；由 composition root 注入编排层。 */
export function createStoryEvalApprovalObserver(
  sink: StoryEvalSink
): (event: StoryEvalApprovalEvent) => void {
  return (event) => {
    try {
      if (event.kind === "role_approval") {
        sink.append({
          kind: "role_approval",
          traceId: event.traceId,
          role: event.role,
          attempt: event.attempt,
          category: event.category,
        });
      } else if (event.kind === "plan_approved") {
        sink.append({
          kind: "plan_approved",
          traceId: event.traceId,
          attempt: event.attempt,
          planSummary: event.planSummary,
        });
      } else {
        sink.append({ kind: "expansion_decision", traceId: event.traceId, decision: event.decision });
      }
    } catch {
      // 采集失败绝不抛到游戏主流程。
    }
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/server/ai/storyEvalCapture.test.ts`
Expected: PASS（2 describe，4 it）

- [ ] **Step 5: 提交**

```bash
git add src/game/application/server/ai/storyEvalCapture.ts src/game/application/server/ai/storyEvalCapture.test.ts
git commit -m "feat(ai-story-eval): add story eval capture sink module"
```

---

### Task 2: liveRuntimeNarrativeSources 捕获回调（director/writer/npc）

**Files:**
- Modify: `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`
- Test: `src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts`（新建）

**Interfaces:**
- Consumes: `StoryEvalSink`（Task 1）
- Produces: `LiveRuntimeNarrativeSourcesOptions`（原 inline input 类型具名导出）：`{ transport: AiTransport; config: AiTransportConfig; responseFormat?: (role: Role) => Readonly<Record<string, unknown>> | undefined; logger?: GameLogger; captureSink?: StoryEvalSink }`；`Role` 类型导出。每次调用捕获：role、traceId（**归一化场景级 id**，见下）、attempt、完整 messages、rawResponse、repair 后候选、失败类别、latencyMs；未传 `captureSink` 时行为与现状完全一致。
- **关联键设计**（spec §6.1，Task 1 类型注释同步）：编排层构造的 request.traceId 形态为 `` `<场景id>-<角色后缀>` ``（director→`-director`、writer→`-script`、npc→`-npcLine`），重试追加 `-retry`。source 层**无全局计数器**，从 request.traceId 纯函数解析：`attempt` = `-retry` 出现次数 + 1；`traceId` = 去 `-retry` 与角色后缀后的场景级 id。同一场景同一角色的重试记录共享归一化 traceId、attempt 递增；不同场景互不污染。

- [ ] **Step 1: 写失败测试**

创建 `src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts`：

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { StoryEvalCallRecord, StoryEvalSink } from "./storyEvalCapture";
import { createLiveRuntimeNarrativeSources } from "./liveRuntimeNarrativeSources";

const config = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" };

const contextWithCandidates = {
  actionCandidates: [
    { actionKey: "observe:loc_a", kind: "observe", label: "观察" },
    { actionKey: "move:loc_b", kind: "move", label: "前往" },
  ],
  npcIdsPresent: [],
  discoveredFactIds: [],
  progression: { allowedPacing: ["setup"] },
};

function okFetch(content: string) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("createLiveRuntimeNarrativeSources captureSink", () => {
  it("三角色各捕获一条完整 ai_call，且不改 source 返回值", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = okFetch(JSON.stringify({
      sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
      relevantFactIds: [], allowedRevealFactIds: [],
      suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
      introducedEntities: [], pacing: "setup",
      proposedNewLocations: [], proposedNewNpcs: [],
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: createTransport(), config, captureSink: sink });

      const director = await sources.directorSource.generate({
        traceId: "t-director",
        context: { ...contextWithCandidates, coverageTargetActionKey: "observe:loc_a" } as unknown as Record<string, unknown>,
      });
      expect(director.ok).toBe(true);

      const writer = await sources.sceneScriptSource.generate({
        traceId: "t-script", // 编排层 writer 请求的真实后缀形态（orchestrateNarrativeScene）
        context: {
          plan: { suggestedActionKeys: ["observe:loc_a", "move:loc_b"] },
          actionCandidates: contextWithCandidates.actionCandidates,
          allowedFactCards: [],
          npcProfile: null,
        } as unknown as Record<string, unknown>,
      });
      expect(writer.ok).toBe(true);

      const npc = await sources.npcLineSource.generate({
        traceId: "t-npcLine", // 编排层 npc 请求的真实后缀形态（orchestrateNarrativeScene）
        context: {
          factCards: [],
          npcProfile: { id: "npc_1", name: "N", role: "村民" },
        } as unknown as Record<string, unknown>,
      });
      expect(npc.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.role)).toEqual(["director", "writer", "npc"]);
    for (const record of records) {
      expect(record.attempt).toBe(1);
      expect(record.messages.length).toBeGreaterThanOrEqual(2);
      expect(record.rawResponse).toContain("suggestedActionKeys");
      expect(record.parsedCandidate).not.toBeNull();
      expect(record.failureCategory).toBeNull();
      expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    }
    // traceId 归一化为场景级 id（去角色/重试后缀）——与编排层审批事件共用关联键
    expect(records.map((record) => record.traceId)).toEqual(["t", "t", "t"]);
  });

  it("同场景重试 attempt 递增，跨场景不泄漏（无全局计数器）", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = okFetch(JSON.stringify({
      sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
      relevantFactIds: [], allowedRevealFactIds: [],
      suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
      introducedEntities: [], pacing: "setup",
      proposedNewLocations: [], proposedNewNpcs: [],
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: createTransport(), config, captureSink: sink });
      // 场景 a：首次 + 重试（编排层 traceId 形态：`a-director`、`a-director-retry`）
      await sources.directorSource.generate({
        traceId: "a-director",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      await sources.directorSource.generate({
        traceId: "a-director-retry",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      // 场景 b：首次调用 attempt 应回到 1（attempt 从 traceId 解析，非全局计数）
      await sources.directorSource.generate({
        traceId: "b-director",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(records.map((record) => record.attempt)).toEqual([1, 2, 1]);
    expect(records.map((record) => record.traceId)).toEqual(["a", "a", "b"]);
  });

  it("解析失败时记录 rawResponse 与 failureCategory，仍走原失败返回", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = okFetch("not json at all");
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: createTransport(), config, captureSink: sink });
      const result = await sources.directorSource.generate({
        traceId: "t-bad",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("invalid_json");
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].rawResponse).toBe("not json at all");
    expect(records[0].parsedCandidate).toBeNull();
    expect(records[0].failureCategory).toBe("invalid_json");
  });

  it("未传 captureSink 时行为与现状一致（不抛错、正常返回）", async () => {
    const fetchSpy = okFetch(JSON.stringify({
      sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
      relevantFactIds: [], allowedRevealFactIds: [],
      suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
      introducedEntities: [], pacing: "setup",
      proposedNewLocations: [], proposedNewNpcs: [],
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createLiveRuntimeNarrativeSources({ transport: createTransport(), config });
      const result = await sources.directorSource.generate({
        traceId: "t-plain",
        context: { ...contextWithCandidates } as unknown as Record<string, unknown>,
      });
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

function createTransport() {
  // 与 runtimeNarrativeSourceFactory 相同的生产 transport：默认 fetch（测试中已 mock）。
  // 通过动态 import 避免顶层加载 @ai-game/ai-transport 副作用。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("@ai-game/ai-transport").createOpenAiCompatibleTransport();
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts`
Expected: FAIL（TS 错误：`LiveRuntimeNarrativeSourcesOptions` 不存在 / `captureSink` 未知属性）

- [ ] **Step 3: 写实现**

修改 `src/game/application/server/ai/liveRuntimeNarrativeSources.ts`：

1) 顶部 import 追加：

```typescript
import type { StoryEvalSink } from "./storyEvalCapture";
```

2) `type Role` 与 `createLiveRuntimeNarrativeSources` 签名替换为：

```typescript
export type Role = "director" | "writer" | "npc";
type Request = DirectorRequest | SceneScriptRequest | NpcLineRequest;

export type LiveRuntimeNarrativeSourcesOptions = Readonly<{
  transport: AiTransport;
  config: AiTransportConfig;
  responseFormat?: (role: Role) => Readonly<Record<string, unknown>> | undefined;
  logger?: GameLogger;
  /** Task 2：评估采集回调——prompt 与模型原文只在本模块内部可见，仅此处可捕获。 */
  captureSink?: StoryEvalSink;
}>;

/** Three separate sources and requests; each builder receives only its already-projected context. */
export function createLiveRuntimeNarrativeSources(input: LiveRuntimeNarrativeSourcesOptions): Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }> {
  return {
    directorSource: { generate: async (request) => run<DirectorProposal, DirectorAttempt>("director", request, input, "plan") },
    sceneScriptSource: { generate: async (request) => run<SceneScriptProposal, SceneScriptAttempt>("writer", request, input, "script") },
    npcLineSource: { generate: async (request) => run<NpcPerformanceProposal, NpcLineAttempt>("npc", request, input, "performance") },
  };
}

/** 编排层构造的 request.traceId 角色后缀（orchestrateNarrativeScene）：writer 用 -script、npc 用 -npcLine。 */
const TRACE_ROLE_SUFFIX: Readonly<Record<Role, string>> = {
  director: "-director",
  writer: "-script",
  npc: "-npcLine",
};

/** 归一化为场景级 traceId：去掉 -retry 与角色后缀——与编排层审批事件共用关联键（spec §6.1）。 */
function sceneTraceIdOf(role: Role, requestTraceId: string): string {
  let id = requestTraceId;
  while (id.endsWith("-retry")) id = id.slice(0, -"-retry".length);
  if (id.endsWith(TRACE_ROLE_SUFFIX[role])) id = id.slice(0, -TRACE_ROLE_SUFFIX[role].length);
  return id;
}

/** 同场景同角色 1-based 尝试序号：request.traceId 中 -retry 出现次数 + 1（无全局状态，跨场景不泄漏）。 */
function attemptOf(requestTraceId: string): number {
  let count = 1;
  let index = requestTraceId.indexOf("-retry");
  while (index !== -1) {
    count += 1;
    index = requestTraceId.indexOf("-retry", index + 1);
  }
  return count;
}
```

3) `run` 函数整体替换为：

```typescript
async function run<T extends object, A>(role: Role, request: Request, input: LiveRuntimeNarrativeSourcesOptions, field: "plan" | "script" | "performance"): Promise<A> {
  const startedAt = Date.now();
  const logger = input.logger ?? NOOP_GAME_LOGGER;
  const attempt = attemptOf(request.traceId);
  const capture = (outcome: Readonly<{ rawResponse: string | null; parsedCandidate: Record<string, unknown> | null; failureCategory: NarrativeFailureCategory | null }>) => {
    try {
      input.captureSink?.append({
        kind: "ai_call",
        role,
        traceId: sceneTraceIdOf(role, request.traceId),
        attempt,
        messages: messages(role, request),
        rawResponse: outcome.rawResponse,
        parsedCandidate: outcome.parsedCandidate,
        failureCategory: outcome.failureCategory,
        latencyMs: Date.now() - startedAt,
      });
    } catch { /* 采集失败绝不抛到游戏主流程 */ }
  };
  let completed;
  // This provider disables extended reasoning through enable_thinking. Output
  // shape remains prompt-directed and is always locally parsed and approved.
  try { completed = await input.transport.complete(input.config, messages(role, request), { extraBody: { enable_thinking: false, ...input.responseFormat?.(role) }, temperature: 0.2, timeoutMs: 120_000 }); } catch { audit(logger, role, false, "service_error", Date.now() - startedAt); capture({ rawResponse: null, parsedCandidate: null, failureCategory: "service_error" }); return failure(request, "service_error") as A; }
  if (!completed.ok) { const failedCategory = category[completed.code]; audit(logger, role, false, failedCategory, completed.latencyMs); capture({ rawResponse: (completed as { content?: string }).content ?? null, parsedCandidate: null, failureCategory: failedCategory }); return failure(request, failedCategory) as A; }
  const payload = parseObject(completed.content);
  if (payload === null) { const failureCategory = completed.content.trim() === "" ? "empty_response" : "invalid_json"; audit(logger, role, false, failureCategory, completed.latencyMs); capture({ rawResponse: completed.content, parsedCandidate: null, failureCategory }); return failure(request, failureCategory) as A; }
  const repaired = repairRuntimeNarrativeReferences(role, payload, request.context);
  audit(logger, role, true, undefined, completed.latencyMs);
  capture({ rawResponse: completed.content, parsedCandidate: repaired, failureCategory: null });
  return { ok: true, provenance: "generated", [field]: repaired as T, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" } } as A;
}
```

> 注：`import type { NarrativeFailureCategory }` 已在第 4 行 import 列表内（复用）。文件其余部分（repair/audit/messages/parseObject）不变。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts`
Expected: PASS（4 it）

Run: `npm run typecheck` —— Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/game/application/server/ai/liveRuntimeNarrativeSources.ts src/game/application/server/ai/liveRuntimeNarrativeSources.storyEval.test.ts
git commit -m "feat(ai-story-eval): capture prompt and raw output in live runtime narrative sources"
```

---

### Task 3: liveScenarioCandidateSource 捕获回调（scenario）

**Files:**
- Modify: `src/game/application/server/ai/liveScenarioCandidateSource.ts`
- Test: `src/game/application/server/ai/liveScenarioCandidateSource.storyEval.test.ts`（新建）

**Interfaces:**
- Consumes: `StoryEvalSink`（Task 1）
- Produces: `LiveScenarioCandidateSourceOptions` 新增可选 `captureSink?: StoryEvalSink`；每次 `generate` 捕获一条 `role: "scenario"` 的 ai_call（含完整 prompt messages、模型原文、解析后候选/失败类别）。

- [ ] **Step 1: 写失败测试**

创建 `src/game/application/server/ai/liveScenarioCandidateSource.storyEval.test.ts`：

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { AiMessage, AiTransport, AiTransportConfig, AiTransportFailureCode } from "@ai-game/ai-transport";
import type { StoryEvalCallRecord, StoryEvalSink } from "./storyEvalCapture";
import { createLiveScenarioCandidateSource } from "./liveScenarioCandidateSource";

const config: AiTransportConfig = { baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" };

const minimalCandidate = {
  world: { name: "W", summary: "S", tone: "dark", themes: ["t"] },
  openingScene: {},
  player: {},
  locations: [],
  npcs: [],
  quests: [],
  items: [],
  enemies: [],
  endings: [],
};

function buildSource(records: StoryEvalCallRecord[], responseContent: string) {
  const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
  const fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: responseContent } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
  const source = createLiveScenarioCandidateSource({
    transport: require("@ai-game/ai-transport").createOpenAiCompatibleTransport(),
    config,
    buildMessages: (request) => [{ role: "system", content: "scenario prompt" }, { role: "user", content: JSON.stringify(request.input) }],
    audit: { record: () => {} },
    captureSink: sink,
  });
  return { source, fetchSpy };
}

const request = {
  traceId: "t-scenario",
  input: { gameType: "wuxia" as const, gameLength: "long" as const, worldPremise: "P", storyOpening: "O" },
};

describe("createLiveScenarioCandidateSource captureSink", () => {
  it("成功时捕获完整 ai_call（scenario 角色）且不改返回值", async () => {
    const records: StoryEvalCallRecord[] = [];
    const { source, fetchSpy } = buildSource(records, JSON.stringify(minimalCandidate));
    try {
      const result = await source.generate(request);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.origin).toBe("live");
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("scenario");
    expect(records[0].traceId).toBe("t-scenario");
    expect(records[0].attempt).toBe(1);
    expect(records[0].messages).toHaveLength(2);
    expect(records[0].parsedCandidate).not.toBeNull();
    expect(records[0].failureCategory).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("解析失败时记录 rawResponse 与 failureCategory=invalid_json", async () => {
    const records: StoryEvalCallRecord[] = [];
    const { source } = buildSource(records, "oops");
    try {
      const result = await source.generate(request);
      expect(result.ok).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records[0].rawResponse).toBe("oops");
    expect(records[0].parsedCandidate).toBeNull();
    expect(records[0].failureCategory).toBe("invalid_json");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/server/ai/liveScenarioCandidateSource.storyEval.test.ts`
Expected: FAIL（TS 错误：`captureSink` 不存在于 `LiveScenarioCandidateSourceOptions`）

- [ ] **Step 3: 写实现**

修改 `src/game/application/server/ai/liveScenarioCandidateSource.ts`：

1) import 追加：

```typescript
import type { StoryEvalSink } from "./storyEvalCapture";
```

2) `LiveScenarioCandidateSourceOptions` 追加字段：

```typescript
export type LiveScenarioCandidateSourceOptions = Readonly<{
  transport: AiTransport;
  config: AiTransportConfig;
  buildMessages: (request: ScenarioGenerationRequest) => readonly AiMessage[];
  audit: ScenarioGenerationAudit;
  /** Task 9：按请求构建结构化输出 extraBody（response_format）；undefined = 不发送。 */
  buildExtraBody?: (request: ScenarioGenerationRequest) => Readonly<Record<string, unknown>> | undefined;
  /** Task 3：评估采集回调——prompt 与模型原文只在本模块内部可见，仅此处可捕获。 */
  captureSink?: StoryEvalSink;
}>;
```

3) `createLiveScenarioCandidateSource` 内 `generate` 的失败/成功 return 前插入捕获。用以下方式替换 generate 函数体（从 `const messages = buildMessages(request);` 到函数尾）：

```typescript
      const messages = buildMessages(request);
      const extraBody = buildExtraBody?.(request);
      const capture = (outcome: Readonly<{ rawResponse: string | null; parsedCandidate: Record<string, unknown> | null; failureCategory: ScenarioCandidateFailureCategory | null; latencyMs: number }>) => {
        try {
          options.captureSink?.append({
            kind: "ai_call",
            role: "scenario",
            traceId: request.traceId,
            attempt,
            messages,
            rawResponse: outcome.rawResponse,
            parsedCandidate: outcome.parsedCandidate,
            failureCategory: outcome.failureCategory,
            latencyMs: outcome.latencyMs,
          });
        } catch { /* 采集失败绝不抛到游戏主流程 */ }
      };

      let result;
      try {
        result = await transport.complete(config, messages, {
          extraBody: { enable_thinking: false, ...(extraBody ?? {}) },
          temperature: 0.2,
          timeoutMs: 120_000
        });
      } catch {
        // transport 意外抛错：不泄漏 message，映射稳定 service_error。
        audit.record({
          traceId: request.traceId,
          attempt,
          outcome: "failure",
          category: "service_error",
          latencyMs: 0
        });
        capture({ rawResponse: null, parsedCandidate: null, failureCategory: "service_error", latencyMs: 0 });
        return liveFailure("service_error", ["LIVE_TRANSPORT_THROW"]);
      }

      if (!result.ok) {
        const category = TRANSPORT_CATEGORY[result.code];
        audit.record({
          traceId: request.traceId,
          attempt,
          outcome: "failure",
          category,
          transportCode: result.code,
          latencyMs: result.latencyMs
        });
        capture({ rawResponse: (result as { content?: string }).content ?? null, parsedCandidate: null, failureCategory: category, latencyMs: result.latencyMs });
        return liveFailure(category, [`LIVE_TRANSPORT_${result.code.toUpperCase()}`]);
      }

      const parsed = parseCandidate(result.content);
      if (!parsed.ok) {
        audit.record({
          traceId: request.traceId,
          attempt,
          outcome: "failure",
          category: parsed.category,
          latencyMs: result.latencyMs,
          usage: result.usage
        });
        capture({ rawResponse: result.content, parsedCandidate: null, failureCategory: parsed.category, latencyMs: result.latencyMs });
        return liveFailure(parsed.category, parsed.diagnostics);
      }

      audit.record({
        traceId: request.traceId,
        attempt,
        outcome: "ok",
        latencyMs: result.latencyMs,
        usage: result.usage
      });
      capture({ rawResponse: result.content, parsedCandidate: parsed.candidate, failureCategory: null, latencyMs: result.latencyMs });
      return {
        ok: true,
        contractVersion: SCENARIO_CANDIDATE_CONTRACT_VERSION,
        origin: "live",
        candidate: parsed.candidate as unknown as ScenarioBlueprintCandidate,
        diagnostics: []
      };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/server/ai/liveScenarioCandidateSource.storyEval.test.ts`
Expected: PASS（2 it）

Run: `npm run typecheck` —— Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/game/application/server/ai/liveScenarioCandidateSource.ts src/game/application/server/ai/liveScenarioCandidateSource.storyEval.test.ts
git commit -m "feat(ai-story-eval): capture prompt and raw output in live scenario candidate source"
```

---

### Task 4: 两个工厂透传 captureSink

**Files:**
- Modify: `src/game/application/server/ai/runtimeNarrativeSourceFactory.ts`
- Modify: `src/game/application/server/ai/scenarioCandidateSourceFactory.ts`
- Test: `src/game/application/server/ai/sourceFactory.storyEval.test.ts`（新建）

**Interfaces:**
- Consumes: `StoryEvalSink`（Task 1）、`createLiveScenarioCandidateSource`（Task 3）、`createLiveRuntimeNarrativeSources`（Task 2）
- Produces: `createRuntimeNarrativeSources(env, options: { logger?: GameLogger; captureSink?: StoryEvalSink })`；`ScenarioCandidateSourceFactoryOptions` 新增 `captureSink?: StoryEvalSink`。未传时装配与现状完全一致。

- [ ] **Step 1: 写失败测试**

创建 `src/game/application/server/ai/sourceFactory.storyEval.test.ts`：

```typescript
/** @vitest-environment node */
import { describe, expect, it, vi } from "vitest";
import type { StoryEvalCallRecord, StoryEvalSink } from "./storyEvalCapture";
import { createRuntimeNarrativeSources } from "./runtimeNarrativeSourceFactory";
import { createScenarioCandidateSource } from "./scenarioCandidateSourceFactory";

const validEnv = {
  AI_API_BASE_URL: "http://127.0.0.1:9/v1",
  AI_MODEL: "test-model",
  AI_API_KEY: "test-key",
};

describe("source factories captureSink passthrough", () => {
  it("runtimeNarrativeSourceFactory 透传 captureSink 到 live source", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        sceneGoal: "g", tensionLevel: 2, focusNpcId: null,
        relevantFactIds: [], allowedRevealFactIds: [],
        suggestedActionKeys: ["observe:loc_a", "move:loc_b"],
        introducedEntities: [], pacing: "setup",
        proposedNewLocations: [], proposedNewNpcs: [],
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const sources = createRuntimeNarrativeSources(validEnv, { captureSink: sink });
      const result = await sources.directorSource.generate({
        traceId: "t-factory",
        context: {
          actionCandidates: [
            { actionKey: "observe:loc_a", kind: "observe", label: "观察" },
            { actionKey: "move:loc_b", kind: "move", label: "前往" },
          ],
          npcIdsPresent: [],
          discoveredFactIds: [],
          progression: { allowedPacing: ["setup"] },
        } as unknown as Record<string, unknown>,
      });
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("director");
  });

  it("scenarioCandidateSourceFactory 透传 captureSink 到 live source", async () => {
    const records: StoryEvalCallRecord[] = [];
    const sink: StoryEvalSink = { append: (record) => records.push(record as StoryEvalCallRecord) };
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        world: {}, openingScene: {}, player: {},
        locations: [], npcs: [], quests: [], items: [], enemies: [], endings: [],
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    try {
      const source = createScenarioCandidateSource(validEnv, { captureSink: sink });
      const result = await source.generate({
        traceId: "t-factory-scenario",
        input: { gameType: "wuxia" as const, gameLength: "long" as const, worldPremise: "P", storyOpening: "O" },
      });
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe("scenario");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/server/ai/sourceFactory.storyEval.test.ts`
Expected: FAIL（TS 错误：`captureSink` 未知属性 / 或测试断言失败：records 为空）

- [ ] **Step 3: 写实现**

`src/game/application/server/ai/runtimeNarrativeSourceFactory.ts` 整体替换为：

```typescript
import { createOpenAiCompatibleTransport } from "@ai-game/ai-transport";
import type { GameLogger } from "@/game/logging";
import { parseAiRuntimeConfig } from "./aiRuntimeConfig";
import { createLiveRuntimeNarrativeSources } from "./liveRuntimeNarrativeSources";
import type { StoryEvalSink } from "./storyEvalCapture";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type NpcLineSource, type SceneScriptSource } from "../../runtimeNarrative";

export function createRuntimeNarrativeSources(env: Record<string, string | undefined>, options: Readonly<{ logger?: GameLogger; captureSink?: StoryEvalSink }> = {}): Readonly<{ directorSource: DirectorSource; sceneScriptSource: SceneScriptSource; npcLineSource: NpcLineSource }> {
  const runtime = parseAiRuntimeConfig(env);
  // Runtime narrative deliberately stays prompt-only. Some compatible providers
  // implement response_format through guided grammar and reject it server-side.
  if (runtime.status === "available") return createLiveRuntimeNarrativeSources({ transport: createOpenAiCompatibleTransport(), config: runtime.config, logger: options.logger, captureSink: options.captureSink });
  const unavailable = () => ({ async generate(request: { traceId: string }) { return { ok: false as const, provenance: "unavailable" as const, category: "service_error" as const, diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "failed" as const, category: "service_error" as const } }; } });
  return { directorSource: unavailable(), sceneScriptSource: unavailable(), npcLineSource: unavailable() };
}
```

`src/game/application/server/ai/scenarioCandidateSourceFactory.ts` 修改：

1) import 追加：`import type { StoryEvalSink } from "./storyEvalCapture";`
2) `ScenarioCandidateSourceFactoryOptions` 追加 `captureSink?: StoryEvalSink;`
3) `createLiveScenarioCandidateSource({ ... })` 调用追加 `captureSink: options.captureSink,`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/server/ai/sourceFactory.storyEval.test.ts`
Expected: PASS（2 it）

Run: `npm run typecheck` —— Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/game/application/server/ai/runtimeNarrativeSourceFactory.ts src/game/application/server/ai/scenarioCandidateSourceFactory.ts src/game/application/server/ai/sourceFactory.storyEval.test.ts
git commit -m "feat(ai-story-eval): passthrough captureSink through both ai source factories"
```

---

### Task 5: 编排层 approvalObserver 与透传链

**Files:**
- Modify: `src/game/application/orchestrateNarrativeScene.ts`
- Modify: `src/game/application/generatePendingNarrativeScene.ts`
- Test: `src/game/application/orchestrateNarrativeScene.storyEval.test.ts`（新建）

> `getOrCreateScene.ts` **不在采集链路**（生产路径 generatePendingNarrativeScene 直调 orchestrateNarrativeScene，getOrCreateScene 仅被 re-export 与自身测试引用），spec §6.1 也只要求 coordinator → generatePendingNarrativeScene → orchestrateNarrativeScene 三层透传——本任务不修改它。

**Interfaces:**
- Consumes: `StoryEvalApprovalEvent`（Task 1）
- Produces:
  - `OrchestrateNarrativeSceneInput` 新增可选 `approvalObserver?: (event: StoryEvalApprovalEvent) => void`
  - `GeneratePendingNarrativeSceneDependencies` 新增可选 `approvalObserver?: (event: StoryEvalApprovalEvent) => void`（透传）
  - `RuntimeNarrativeTaskCoordinator` 无需代码改动：其 deps 类型即 `GeneratePendingNarrativeSceneDependencies`，透传随类型自动生效（Task 6 在 composition root 注入）。
- 事件 attempt 语义（与 Task 1/2 关联键契约一致）：编排层循环变量 0-based，emit 时 +1 为 1-based 尝试序号。

- [ ] **Step 1: 写失败测试**

创建 `src/game/application/orchestrateNarrativeScene.storyEval.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId, type GameState, type ScenarioBlueprint } from "@/game/domain";
import { NARRATIVE_CONTRACT_VERSION, type DirectorSource, type SceneScriptSource, type NpcLineSource } from "./runtimeNarrative";
import { orchestrateNarrativeScene } from "./orchestrateNarrativeScene";
import type { StoryEvalApprovalEvent } from "./server/ai/storyEvalCapture";

// 与 orchestrateNarrativeScene.test.ts 相同的构造助手（规格 §11 允许测试内复制）。
function buildTestBlueprint(): ScenarioBlueprint {
  return {
    schemaVersion: 1 as const,
    generationId: "gen-test" as ScenarioBlueprint["generationId"],
    seed: "test-seed",
    templateVersion: "tpl-1",
    inputDigest: "digest-test",
    gameType: "wuxia",
    world: {
      name: "Test World",
      summary: "A test world",
      tone: "dark",
      themes: ["justice"],
      facts: [{ id: asFactId("fact_1"), text: "公开事实1", source: "player_input" }],
    },
    locations: [
      { id: asLocationId("loc_a"), name: "地点A", description: "", kind: "public", connectedLocationIds: [] },
    ],
    npcs: [
      { id: asNpcId("npc_1"), name: "NPC1", role: "村民", locationId: asLocationId("loc_a"), knownFactIds: [asFactId("fact_1")] },
    ],
    quests: [],
    enemies: [],
    items: [],
    endings: [],
    player: {
      name: "Player", identity: "Hero",
      startingItemIds: [],
      baseStats: { hp: 20, attack: 5, defense: 3 },
    },
    openingScene: {
      locationId: asLocationId("loc_a"),
      narration: "开始",
      suggestedActions: [],
      presentNpcIds: [asNpcId("npc_1")],
      investigableFactIds: [],
    },
  } as unknown as ScenarioBlueprint;
}

function buildTestGameState(): GameState {
  return {
    stateVersion: 1 as const,
    generation: {
      generationId: "gen-test" as GameState["generation"]["generationId"],
      seed: "test-seed",
      templateVersion: "tpl-1",
      inputDigest: "digest-test",
      gameType: "wuxia",
    },
    player: { name: "Player", identity: "Hero", stats: { hp: 20, attack: 5, defense: 3 } },
    currentLocationId: asLocationId("loc_a"),
    unlockedLocationIds: [asLocationId("loc_a")],
    visitedLocationIds: [asLocationId("loc_a")],
    // met: false 使 talk:npc_1 进入候选（与 orchestrateNarrativeScene.test.ts 规则行动文案用例
    // 同手法），保证 candidates ≥ 2 且两 key 不同——approveDirectorProposal 对
    // keyA === keyB 直接 choice_not_legal，mock 必须返回两个不同的合法 key。
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: false }],
    quests: [],
    inventory: [],
    worldFacts: [{ factId: asFactId("fact_1"), discovered: true }],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: { currentScene: null, generation: { status: "idle" }, mode: "ai" },
    eventLedger: [{
      type: "game_initialized",
      generation: {
        generationId: "gen-test" as GameState["generation"]["generationId"],
        seed: "test-seed",
        templateVersion: "tpl-1",
        inputDigest: "digest-test",
        gameType: "wuxia",
      },
    }],
  } as unknown as GameState;
}

function createMockSources() {
  const directorSource: DirectorSource = {
    async generate(request) {
      const context = request.context as { actionCandidates?: { actionKey: string }[] };
      const candidates = context.actionCandidates ?? [];
      return {
        ok: true,
        provenance: "generated",
        plan: {
          sceneGoal: "目标",
          tensionLevel: 3,
          focusNpcId: asNpcId("npc_1"),
          relevantFactIds: [],
          allowedRevealFactIds: [],
          suggestedActionKeys: ["talk:npc_1", "observe:loc_a"] as [string, string],
          introducedEntities: [],
          pacing: "setup",
          proposedNewLocations: [],
          proposedNewNpcs: [],
        },
        diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
      };
    },
  };
  const sceneScriptSource: SceneScriptSource = {
    async generate(request) {
      const context = request.context as { plan?: { suggestedActionKeys?: [string, string] } };
      const keys = context.plan?.suggestedActionKeys ?? ["talk:npc_1", "observe:loc_a"];
      return {
        ok: true,
        provenance: "generated",
        script: {
          narration: "叙事文本",
          usedFactIds: [],
          npcInstruction: {
            npcId: asNpcId("npc_1"),
            speechAct: "warn",
            emotion: "guarded",
            allowedFactIds: [],
            mayLie: false,
          },
          choices: [
            { actionKey: keys[0], label: "a", strategy: "s" },
            { actionKey: keys[1], label: "b", strategy: "t" },
          ],
        },
        diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
      };
    },
  };
  const npcLineSource: NpcLineSource = {
    async generate(request) {
      return {
        ok: true,
        provenance: "generated",
        performance: { text: "台词", usedFactIds: [], emotion: "warm" },
        diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
      };
    },
  };
  return { directorSource, sceneScriptSource, npcLineSource };
}

describe("orchestrateNarrativeScene approvalObserver", () => {
  it("成功链路依次发出 role_approval / plan_approved / expansion_decision 事件", async () => {
    const events: StoryEvalApprovalEvent[] = [];
    const result = await orchestrateNarrativeScene({
      traceId: "t-obs",
      blueprint: buildTestBlueprint(),
      state: buildTestGameState(),
      ...createMockSources(),
      approvalObserver: (event) => events.push(event),
    });
    expect(result.provenance).toBe("generated");
    // 事件顺序是采集契约而非巧合：director 审批 → 计划批准 → writer 审批 → npc 审批 → 扩展裁决。
    expect(events.map((event) => event.kind)).toEqual([
      "role_approval",   // director 通过
      "plan_approved",   // 已批准导演计划
      "role_approval",   // writer 通过
      "role_approval",   // npc 通过
      "expansion_decision",
    ]);
    const directorApproval = events[0];
    if (directorApproval.kind === "role_approval") {
      expect(directorApproval.role).toBe("director");
      expect(directorApproval.category).toBeNull();
      expect(directorApproval.attempt).toBe(1); // 1-based：编排层循环 0 转 1
    }
    const planApproved = events[1];
    if (planApproved.kind === "plan_approved") {
      expect(planApproved.planSummary).toMatchObject({ pacing: "setup", tensionLevel: 3 });
    }
    const expansion = events[4];
    if (expansion.kind === "expansion_decision") {
      expect(expansion.decision).toEqual({ ok: false, reason: "none_proposed" });
    }
  });

  it("审批驳回时发出带 category 的 role_approval 事件", async () => {
    const events: StoryEvalApprovalEvent[] = [];
    const { directorSource, sceneScriptSource, npcLineSource } = createMockSources();
    const rejectingDirector: DirectorSource = {
      async generate(request) {
        return {
          ok: true,
          provenance: "generated",
          // 引用不在任何候选中的 actionKey：approveDirectorProposal 必驳回。
          plan: {
            sceneGoal: "目标",
            tensionLevel: 3,
            focusNpcId: null,
            relevantFactIds: [],
            allowedRevealFactIds: [],
            suggestedActionKeys: ["move:nowhere", "move:nowhere2"],
            introducedEntities: [],
            pacing: "setup",
            proposedNewLocations: [],
            proposedNewNpcs: [],
          },
          diagnostics: { traceId: request.traceId, contractVersion: NARRATIVE_CONTRACT_VERSION, stage: "candidate_received" },
        };
      },
    };
    const result = await orchestrateNarrativeScene({
      traceId: "t-reject",
      blueprint: buildTestBlueprint(),
      state: buildTestGameState(),
      directorSource: rejectingDirector,
      sceneScriptSource,
      npcLineSource,
      approvalObserver: (event) => events.push(event),
    });
    expect(result.provenance).toBe("fallback");
    const rejected = events.find((event) => event.kind === "role_approval");
    expect(rejected).toBeDefined();
    if (rejected?.kind === "role_approval") {
      expect(rejected.category).not.toBeNull();
    }
    // 驳回后没有 plan_approved
    expect(events.some((event) => event.kind === "plan_approved")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.storyEval.test.ts`
Expected: FAIL（TS 错误：`approvalObserver` 不存在于 input 类型）

- [ ] **Step 3: 写实现**

`src/game/application/orchestrateNarrativeScene.ts`：

1) import 追加：

```typescript
import type { StoryEvalApprovalEvent } from "./server/ai/storyEvalCapture";
```

2) `OrchestrateNarrativeSceneInput` 追加：

```typescript
  /** Task 5：审批观察回调——审批结果与已批准导演计划只在本层可见，仅此处可发出。 */
  readonly approvalObserver?: (event: StoryEvalApprovalEvent) => void;
```

3) director 审批循环内（`const approval = approveDirectorProposal(...)` 之后）：

```typescript
    const approval = approveDirectorProposal({ proposal: directorAttempt.plan, blueprint, state, candidates });
    input.approvalObserver?.({ kind: "role_approval", traceId, role: "director", attempt, category: approval.ok ? null : approval.category });
    if (approval.ok) {
      plan = approval.value;
      input.approvalObserver?.({ kind: "plan_approved", traceId, attempt, planSummary: approval.value as unknown as Record<string, unknown> });
      break;
    }
```

4) writer 审批循环内（`const approval = approveSceneScript(...)` 之后）：

```typescript
    const approval = approveSceneScript({ proposal: scriptAttempt.script, plan, blueprint });
    input.approvalObserver?.({ kind: "role_approval", traceId, role: "writer", attempt: attempt + 1, category: approval.ok ? null : approval.category });
    if (approval.ok) { script = approval.value; break; }
```

5) npc 审批循环内（`const approved = approveNpcPerformance(...)` 之后）：

```typescript
        const approved = approveNpcPerformance({ proposal: attempt.performance, allowedFactIds: npcInst.allowedFactIds });
        input.approvalObserver?.({ kind: "role_approval", traceId, role: "npc", attempt: attemptIndex + 1, category: approved.ok ? null : approved.category });
        if (!approved.ok) continue;
```

6) Step 6 处（`const expansionDecision = approveBlueprintExpansion(...)` 之后）追加：

```typescript
  const expansionDecision = approveBlueprintExpansion({ blueprint, state, plan });
  input.approvalObserver?.({ kind: "expansion_decision", traceId, decision: expansionDecision });
```

> 注：`NarrativeApprovalResult` 的 ok 分支无 `category` 字段，`approval.ok ? null : approval.category` 恰好产出 `string | null`，类型兼容。

`src/game/application/generatePendingNarrativeScene.ts`：

1) import 追加：

```typescript
import type { StoryEvalApprovalEvent } from "./server/ai/storyEvalCapture";
```

2) `GeneratePendingNarrativeSceneDependencies` 追加 `approvalObserver?: (event: StoryEvalApprovalEvent) => void;`
3) `orchestrateNarrativeScene({ ... })` 调用追加 `approvalObserver: deps.approvalObserver,`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.storyEval.test.ts`
Expected: PASS（2 it）

Run: `npx vitest run src/game/application/orchestrateNarrativeScene.test.ts src/game/application/generatePendingNarrativeScene.test.ts` —— Expected: PASS（现有行为不变）

Run: `npm run typecheck` —— Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/game/application/orchestrateNarrativeScene.ts src/game/application/generatePendingNarrativeScene.ts src/game/application/orchestrateNarrativeScene.storyEval.test.ts
git commit -m "feat(ai-story-eval): emit approval observer events from orchestration layer"
```

---

### Task 6: compositionRoot 开关装配

**Files:**
- Modify: `src/game/application/server/compositionRoot.ts`
- Test: `src/game/application/server/compositionRoot.storyEval.test.ts`（新建）

**Interfaces:**
- Consumes: `createFileStoryEvalSink` / `createStoryEvalApprovalObserver` / `StoryEvalSink` / `StoryEvalApprovalEvent`（Task 1）、工厂 captureSink（Task 4）、deps approvalObserver（Task 5）
- Produces: `resolveStoryEvalAssembly(env)`（导出，供测试）：`{ captureSink: StoryEvalSink | undefined; approvalObserver: ((event: StoryEvalApprovalEvent) => void) | undefined }`——`STORY_EVAL_CAPTURE !== "1"` 时全 undefined；否则按 `STORY_EVAL_ARTIFACT_DIR` 或缺省 `<ISO时间戳>-<pid>` 目录创建 sink。

- [ ] **Step 1: 写失败测试**

创建 `src/game/application/server/compositionRoot.storyEval.test.ts`：

```typescript
/** @vitest-environment node */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerGameEntryPoints, resolveStoryEvalAssembly } from "./compositionRoot";
import wuxiaFixture from "../../../../data/fixtures/phase1/wuxia.json";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  }
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "composition-story-eval-"));
  dirs.push(dir);
  return dir;
}

const validAiEnv = {
  AI_API_BASE_URL: "http://127.0.0.1:9/v1",
  AI_MODEL: "test-model",
  AI_API_KEY: "test-key",
  // createOfflineJourneyGame 首行检查 NODE_ENV !== "development" 即返回
  // DEVELOPMENT_TOOLS_DISABLED（compositionRoot 现状），测试 1 必须显式置 development。
  NODE_ENV: "development",
};

const fixture = wuxiaFixture as unknown as { input: { gameType: string; characterName: string; characterIdentity: string; personalityTags: string[]; worldPremise: string; storyOpening: string; narrativeStyle: string; contentIntensity: string } };

describe("resolveStoryEvalAssembly", () => {
  it("STORY_EVAL_CAPTURE 未设置时返回全 undefined（零装配）", () => {
    const assembly = resolveStoryEvalAssembly({});
    expect(assembly.captureSink).toBeUndefined();
    expect(assembly.approvalObserver).toBeUndefined();
  });
  it("STORY_EVAL_CAPTURE=1 且给目录时装配 sink 与 observer", () => {
    const dir = tempDir();
    const assembly = resolveStoryEvalAssembly({ STORY_EVAL_CAPTURE: "1", STORY_EVAL_ARTIFACT_DIR: dir });
    expect(assembly.captureSink).toBeDefined();
    expect(assembly.approvalObserver).toBeDefined();
  });
});

describe("createServerGameEntryPoints 采集装配", () => {
  it("STORY_EVAL_CAPTURE 未设置时不产生任何文件（行为与现状一致）", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "no-capture.sqlite");
    const entry = createServerGameEntryPoints({ ...validAiEnv, GAME_DB_PATH: dbPath });
    try {
      const result = await entry.createOfflineJourneyGame();
      expect(result.ok).toBe(true);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await entry.close();
    }
    // 无 STORY_EVAL_ARTIFACT_DIR 指向时不应产生 story-eval 目录
    const storyEvalDirs = readdirSync(dir).filter((name) => name.startsWith("story-eval"));
    expect(storyEvalDirs).toEqual([]);
  });

  it("STORY_EVAL_CAPTURE=1 时 createGame 把 scenario 调用写入 calls.jsonl", async () => {
    const dir = tempDir();
    const artifactDir = join(dir, "story-eval", "run-test");
    const dbPath = join(dir, "capture.sqlite");
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        world: { name: "W", summary: "S", tone: "dark", themes: ["t"] },
        openingScene: {}, player: {},
        locations: [], npcs: [], quests: [], items: [], enemies: [], endings: [],
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    let entry;
    try {
      entry = createServerGameEntryPoints({
        ...validAiEnv,
        GAME_DB_PATH: dbPath,
        STORY_EVAL_CAPTURE: "1",
        STORY_EVAL_ARTIFACT_DIR: artifactDir,
      });
      const result = await entry.createGame(fixture.input as never);
      expect(result.ok).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await entry?.close();
    }
    const lines = readFileSync(join(artifactDir, "calls.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    expect(first.kind).toBe("ai_call");
    expect(first.role).toBe("scenario");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/server/compositionRoot.storyEval.test.ts`
Expected: FAIL（`resolveStoryEvalAssembly` 不存在；第二个 it 中 calls.jsonl 不存在；注意测试 1 依赖 NODE_ENV=development，若仍失败先检查该键）

- [ ] **Step 3: 写实现**

`src/game/application/server/compositionRoot.ts`：

1) import 追加（`node:path` 的 `resolve` 是本任务新引入的依赖，必须一并追加）：

```typescript
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createFileStoryEvalSink,
  createStoryEvalApprovalObserver,
  type StoryEvalApprovalEvent,
  type StoryEvalSink,
} from "./ai/storyEvalCapture";
```

2) 在 `createServerGameEntryPoints` 之前插入：

```typescript
// ---------------------------------------------------------------------------
// 评估采集装配（spec §6.2）：仅当 STORY_EVAL_CAPTURE=1 时创建 sink 并注入
// captureSink/approvalObserver；未设置时全 undefined（零开销、零行为变化）。
// run-id 沿用 phase10 惯例：<ISO 时间戳>-<pid>（门禁脚本经 STORY_EVAL_ARTIFACT_DIR 覆盖）。
// ---------------------------------------------------------------------------

export function resolveStoryEvalAssembly(env: Record<string, string | undefined>): Readonly<{
  captureSink: StoryEvalSink | undefined;
  approvalObserver: ((event: StoryEvalApprovalEvent) => void) | undefined;
}> {
  if (env.STORY_EVAL_CAPTURE !== "1") {
    return { captureSink: undefined, approvalObserver: undefined };
  }
  const artifactDir = env.STORY_EVAL_ARTIFACT_DIR ??
    resolve("artifacts", "story-eval", `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  const sink = createFileStoryEvalSink(artifactDir);
  return { captureSink: sink, approvalObserver: createStoryEvalApprovalObserver(sink) };
}
```

3) `createServerGameEntryPoints` 函数体首行插入：

```typescript
  const storyEval = resolveStoryEvalAssembly(env);
```

4) 替换两处工厂调用与 coordinator 构造：

```typescript
  const runtimeNarrativeSources = createRuntimeNarrativeSources(env, { logger, captureSink: storyEval.captureSink });
```

```typescript
    scenarioCandidateSource: createScenarioCandidateSource(env, { logger, captureSink: storyEval.captureSink }),
```

```typescript
  const narrativeCoordinator = new RuntimeNarrativeTaskCoordinator({
    repository,
    newTraceId: () => randomUUID(),
    now: () => new Date().toISOString(),
    runtimeNarrativeSources,
    logger,
    approvalObserver: storyEval.approvalObserver,
  }, logger);
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/server/compositionRoot.storyEval.test.ts`
Expected: PASS（4 it）

Run: `npx vitest run src/game/application/testing/phase11StoryContinuityJourney.test.ts` —— Expected: PASS（回归：未设置开关时行为不变）

Run: `npm run test:phase10-journey` —— Expected: PASS（同上回归）

Run: `npm run typecheck` —— Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/game/application/server/compositionRoot.ts src/game/application/server/compositionRoot.storyEval.test.ts
git commit -m "feat(ai-story-eval): assemble capture sinks in composition root behind STORY_EVAL_CAPTURE"
```

---

### Task 7: 选择策略模块（PRNG + 探索优先分类）

**Files:**
- Create: `src/game/application/testing/storyEvalStrategy.ts`
- Test: `src/game/application/testing/storyEvalStrategy.test.ts`

**Interfaces:**
- Consumes: `GameRecord`（`src/game/application/server/persistence/gameRepository.ts`：`{ gameId, blueprint, state, revision, createdAt }`）
- Produces:
  - `mulberry32(seed: number): () => number`
  - `hashStringToSeed(value: string): number`
  - `isExploratory(actionKey: string, record: GameRecord): boolean`
  - `pickNarrativeChoice(record: GameRecord, rand: () => number): { index: 0 | 1; reason: "explore" | "random" }`
  - `buildStoryEvalInput(gameLength: "long" | "short", baseSeed: number): { input: NewGameInput; seed: number }`——合法开局输入（worldPremise≥20 字、storyOpening≥20 字）

- [ ] **Step 1: 写失败测试**

创建 `src/game/application/testing/storyEvalStrategy.test.ts`：

```typescript
/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { asFactId, asLocationId, asNpcId } from "@/game/domain";
import type { GameRecord } from "../server/persistence/gameRepository"; // GameRecord 在 gameRepository 定义，domain 不导出
import type { ScenarioBlueprint } from "@/game/domain";
import type { GameState } from "@/game/domain";
import { buildStoryEvalInput, hashStringToSeed, isExploratory, mulberry32, pickNarrativeChoice } from "./storyEvalStrategy";

describe("mulberry32", () => {
  it("同种子产出同一序列，不同种子序列不同", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    const seqC = [c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("hashStringToSeed", () => {
  it("稳定且区分输入", () => {
    expect(hashStringToSeed("abc")).toBe(hashStringToSeed("abc"));
    expect(hashStringToSeed("abc")).not.toBe(hashStringToSeed("abd"));
  });
});

function makeRecord(overrides: Partial<GameState> = {}): GameRecord {
  const blueprint = {
    schemaVersion: 1,
    generationId: "g",
    seed: "seed-x",
    templateVersion: "tpl",
    inputDigest: "d",
    gameType: "wuxia",
    world: { name: "W", summary: "S", tone: "dark", themes: [], facts: [] },
    locations: [{ id: asLocationId("loc_a"), name: "A", description: "", kind: "public", connectedLocationIds: [] }],
    npcs: [],
    quests: [],
    enemies: [],
    items: [],
    endings: [],
    player: { name: "P", identity: "I", startingItemIds: [], baseStats: { hp: 10, attack: 1, defense: 1 } },
    openingScene: { locationId: asLocationId("loc_a"), narration: "n", suggestedActions: [], presentNpcIds: [], investigableFactIds: [] },
  } as unknown as ScenarioBlueprint;
  const state = {
    stateVersion: 1,
    generation: { generationId: "g", seed: "seed-x", templateVersion: "tpl", inputDigest: "d", gameType: "wuxia" },
    player: { name: "P", identity: "I", stats: { hp: 10, attack: 1, defense: 1 } },
    currentLocationId: asLocationId("loc_a"),
    unlockedLocationIds: [asLocationId("loc_a")],
    visitedLocationIds: [asLocationId("loc_a")],
    npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: false }],
    quests: [],
    inventory: [],
    worldFacts: [{ factId: asFactId("fact_1"), discovered: false }],
    defeatedEnemyIds: [],
    battle: { status: "idle" },
    ending: null,
    narrative: {
      currentScene: {
        sceneId: "s1",
        turn: 1,
        narration: "n",
        usedFactIds: [],
        npcLine: null,
        choices: [
          { choiceToken: "c1", label: "探索新地点", actionKey: "move:loc_b" },
          { choiceToken: "c2", label: "留在原地", actionKey: "observe:loc_a" },
        ],
        source: "generated",
      },
      generation: { status: "idle" },
      mode: "ai",
    },
    eventLedger: [],
    ...overrides,
  } as unknown as GameState;
  return { gameId: "game-1" as never, blueprint, state, revision: 0, createdAt: "2026-07-31T00:00:00.000Z" };
}

describe("isExploratory", () => {
  it("move 到未访问地点、talk 未见 NPC、investigate 未发现事实、take_item 均为探索", () => {
    const record = makeRecord();
    expect(isExploratory("move:loc_b", record)).toBe(true);
    expect(isExploratory("talk:npc_1", record)).toBe(true);
    expect(isExploratory("investigate:fact_1", record)).toBe(true);
    expect(isExploratory("take_item:item_1", record)).toBe(true);
    expect(isExploratory("observe:loc_a", record)).toBe(false);
    expect(isExploratory("start_battle:enemy_1", record)).toBe(false);
  });

  it("已访问地点/已见 NPC/已发现事实不算探索", () => {
    const record = makeRecord({
      visitedLocationIds: [asLocationId("loc_a"), asLocationId("loc_b")],
      npcs: [{ npcId: asNpcId("npc_1"), locationId: asLocationId("loc_a"), met: true }],
      worldFacts: [{ factId: asFactId("fact_1"), discovered: true }],
    });
    expect(isExploratory("move:loc_b", record)).toBe(false);
    expect(isExploratory("talk:npc_1", record)).toBe(false);
    expect(isExploratory("investigate:fact_1", record)).toBe(false);
  });
});

describe("pickNarrativeChoice", () => {
  it("恰好一个探索选项时必选它", () => {
    const record = makeRecord();
    const pick = pickNarrativeChoice(record, () => 0.99);
    expect(pick).toEqual({ index: 0, reason: "explore" });
  });

  it("两个都是探索选项时用 PRNG 掷硬币", () => {
    const record = makeRecord({
      narrative: {
        currentScene: {
          sceneId: "s2",
          turn: 1,
          narration: "n",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "A", actionKey: "move:loc_b" },
            { choiceToken: "c2", label: "B", actionKey: "take_item:item_1" },
          ],
          source: "generated",
        },
        generation: { status: "idle" },
        mode: "ai",
      },
    } as never);
    expect(pickNarrativeChoice(record, () => 0.2).index).toBe(0);
    expect(pickNarrativeChoice(record, () => 0.8).index).toBe(1);
    expect(pickNarrativeChoice(record, () => 0.5).reason).toBe("explore");
  });

  it("无探索选项时随机，reason=random", () => {
    const record = makeRecord({
      narrative: {
        currentScene: {
          sceneId: "s3",
          turn: 1,
          narration: "n",
          usedFactIds: [],
          npcLine: null,
          choices: [
            { choiceToken: "c1", label: "A", actionKey: "observe:loc_a" },
            { choiceToken: "c2", label: "B", actionKey: "start_battle:enemy_1" },
          ],
          source: "generated",
        },
        generation: { status: "idle" },
        mode: "ai",
      },
    } as never);
    expect(pickNarrativeChoice(record, () => 0.2)).toEqual({ index: 0, reason: "random" });
  });
});

describe("buildStoryEvalInput", () => {
  it("产出合法 long 输入（满足 domain 校验下限）", () => {
    const { input } = buildStoryEvalInput("long", 1);
    expect(input.gameLength).toBe("long");
    expect(input.worldPremise.length).toBeGreaterThanOrEqual(20);
    expect(input.storyOpening.length).toBeGreaterThanOrEqual(20);
    expect(input.personalityTags.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/testing/storyEvalStrategy.test.ts`
Expected: FAIL（`Cannot find module './storyEvalStrategy'`）

- [ ] **Step 3: 写最小实现**

创建 `src/game/application/testing/storyEvalStrategy.ts`：

```typescript
// ---------------------------------------------------------------------------
// storyEvalStrategy：评估旅程的确定性选择策略（spec §7）。
// 只依赖 GameRecord（评估专用 repository 的读取结果），不经过客户端投影，
// 不触碰 entry points 安全红线。PRNG 为 mulberry32 级别，种子稳定可复现。
// ---------------------------------------------------------------------------

import type { NewGameInput } from "@/game/domain";
import type { GameRecord } from "../server/persistence/gameRepository";

/** mulberry32：32 位种子 PRNG，返回 [0,1) 均匀序列。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把任意字符串稳定散列为 32 位种子（FNV-1a 变体）。 */
export function hashStringToSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function splitAction(actionKey: string): { kind: string; target: string } {
  const separator = actionKey.indexOf(":");
  if (separator < 0) return { kind: actionKey, target: "" };
  return { kind: actionKey.slice(0, separator), target: actionKey.slice(separator + 1) };
}

/**
 * 行动是否为探索性：前往未访问地点 / 与未见 NPC 交谈 / 调查未发现事实 /
 * 拾取物品（功能推进）。move/talk/investigate 是否探索取决于 GameRecord 状态。
 */
export function isExploratory(actionKey: string, record: GameRecord): boolean {
  const { kind, target } = splitAction(actionKey);
  if (kind === "take_item") return true;
  if (kind === "investigate") {
    const fact = record.state.worldFacts.find((entry) => String(entry.factId) === target);
    return fact === undefined || !fact.discovered;
  }
  if (kind === "move") {
    return !record.state.visitedLocationIds.some((id) => String(id) === target);
  }
  if (kind === "talk") {
    const npc = record.state.npcs.find((entry) => String(entry.npcId) === target);
    return npc === undefined || !npc.met;
  }
  return false;
}

/** 探索优先选择：唯一探索选项必选；同类掷硬币；无探索随机。返回下标与理由（记入 story.jsonl）。 */
export function pickNarrativeChoice(
  record: GameRecord,
  rand: () => number,
): { index: 0 | 1; reason: "explore" | "random" } {
  const choices = record.state.narrative.currentScene?.choices ?? [];
  if (choices.length !== 2) return { index: 0, reason: "random" };
  const exploreIndexes = choices
    .map((choice, index) => (isExploratory(choice.actionKey, record) ? index : -1))
    .filter((index): index is 0 | 1 => index === 0 || index === 1);
  if (exploreIndexes.length === 1) return { index: exploreIndexes[0], reason: "explore" };
  if (exploreIndexes.length === 2) return { index: rand() < 0.5 ? 0 : 1, reason: "explore" };
  return { index: rand() < 0.5 ? 0 : 1, reason: "random" };
}

/** 评估旅程固定开局：合法 long/short 输入（满足 domain 校验下限），seed 仅作参考。 */
export function buildStoryEvalInput(
  gameLength: "long" | "short",
  seed: number,
): { input: NewGameInput; seed: number } {
  return {
    input: {
      gameType: "wuxia",
      characterName: "沈孤鸿",
      characterIdentity: "落魄镖师",
      personalityTags: ["重义", "沉默"],
      worldPremise: "江湖动荡，镖局衰败，各派为一部失传剑谱明争暗斗，庙堂亦暗中插手。",
      storyOpening: "雨夜押镖入城，镖车半路被劫，唯一线索是一枚寒山派的青铜令牌。",
      narrativeStyle: "concise",
      contentIntensity: "normal",
      gameLength,
    },
    seed,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/testing/storyEvalStrategy.test.ts`
Expected: PASS（5 describe）

Run: `npm run typecheck` —— Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/game/application/testing/storyEvalStrategy.ts src/game/application/testing/storyEvalStrategy.test.ts
git commit -m "feat(ai-story-eval): add deterministic choice strategy for eval journey"
```

---

### Task 8: 评估旅程本体（离线 fetch-mock 全链路）

**Files:**
- Create: `src/game/application/testing/storyEvalJourney.test.ts`

**Interfaces:**
- Consumes: `createServerGameEntryPoints`（composition root，Task 6 装配）、`createSqliteGameRepository` + `createSqliteClient`（评估专用只读 repository）、`deriveContentProgression`（`@/game/gameplay/rpg/narrative`，读 `mainStage`）、`pickNarrativeChoice`/`mulberry32`/`hashStringToSeed`/`buildStoryEvalInput`（Task 7）
- Produces:
  - `runStoryEvalJourney(config)`（导出）：完整单局驱动。config：`{ env: Record<string,string|undefined>; dbPath: string; artifactDir: string; strategySeed: number; maxScenes: number; requireGeneratedOpening: boolean; modelLabel?: string }`
  - 返回 `{ status: "converged" | "max_scenes" | "aborted"; sceneCount: number; fallbackScenes: number; openingSource: string; endingOutcome: string | null }`
  - 产物：`<artifactDir>/calls.jsonl`（sink 写）、`<artifactDir>/story.jsonl`、`<artifactDir>/manifest.json`
  - `createFakeAiFetch()`（导出）：基于 global fetch mock 的假 transport 响应生成器，区分 scenario/director/writer/npc 四种角色
  - 真实模式用例：`it.runIf(process.env.RUN_REAL_AI_STORY_EVAL === "1")`，从 `process.env` 读取配置（门禁脚本注入）

- [ ] **Step 1: 写失败测试（离线模式 + 产物断言）**

创建 `src/game/application/testing/storyEvalJourney.test.ts`：

```typescript
/** @vitest-environment node */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import type { GameSessionView } from "../gameSessionView";
import { createServerGameEntryPoints, type ServerGameEntryPoints } from "../server/compositionRoot";
import { createSqliteClient } from "../server/persistence/sqliteClient";
import { createSqliteGameRepository, type SqliteGameRepository } from "../server/persistence/sqliteGameRepository";
import { deriveContentProgression } from "@/game/gameplay/rpg/narrative";
import { buildStoryEvalInput, hashStringToSeed, mulberry32, pickNarrativeChoice } from "./storyEvalStrategy";

// ---------------------------------------------------------------------------
// 评估旅程本体（spec §7）：经 createServerGameEntryPoints 驱动（唯一能命中
// §6.2 采集装配点、且与浏览器局同一条服务端路径的方式）。驱动侧另开评估专用
// 只读 repository（createSqliteGameRepository + 同一 GAME_DB_PATH）读取
// actionKey/主线阶段/世界 seed/蓝图快照——不经过客户端投影，不破坏安全红线。
// 离线模式（默认）：global fetch 被 mock，零网络零计费；真实模式仅在
// RUN_REAL_AI_STORY_EVAL=1 时启用（由门禁脚本 storyEvalJourney.mjs 注入）。
// ---------------------------------------------------------------------------

const tmpRoot = resolve("tmp", `story-eval-journey-${process.pid}-${Date.now()}`);
mkdirSync(tmpRoot, { recursive: true });
const openRepositories: SqliteGameRepository[] = [];

afterAll(async () => {
  vi.restoreAllMocks();
  for (const repository of openRepositories) await repository.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows 句柄延迟：下次运行用唯一路径。
  }
});

function openEvalRepository(dbPath: string): SqliteGameRepository {
  const repository = createSqliteGameRepository({
    clientFactory: () => createSqliteClient(dbPath),
    logError: () => {},
  });
  openRepositories.push(repository);
  return repository;
}

type StoryRow = {
  kind: "scene" | "ending";
  sceneIndex: number;
  sceneId?: string;
  mainStage?: number | null;
  narration?: string;
  npcLine?: { text: string; emotion: string } | null;
  choices?: readonly { label: string; actionKey: string }[];
  directorPlan?: Readonly<Record<string, unknown>> | null;
  fallback?: boolean;
  playerChoice?: { index: number; actionKey: string; reason: string };
  newEvents?: readonly { type: string }[];
  outcome?: string | null;
};

/** 按 sceneId 前缀 traceId 关联 calls.jsonl 中的 plan_approved 记录（spec §6.3）。 */
function directorPlanFor(sceneId: string, calls: readonly Readonly<Record<string, unknown>>[]): Readonly<Record<string, unknown>> | null {
  const record = calls.find((call) =>
    call.kind === "plan_approved" &&
    typeof call.traceId === "string" &&
    sceneId.startsWith(call.traceId),
  );
  return record !== undefined ? (record.planSummary as Readonly<Record<string, unknown>>) : null;
}

export type StoryEvalJourneyConfig = Readonly<{
  env: Record<string, string | undefined>;
  dbPath: string;
  artifactDir: string;
  strategySeed: number;
  maxScenes: number;
  requireGeneratedOpening: boolean;
  modelLabel?: string;
}>;

export type StoryEvalJourneyResult = Readonly<{
  status: "converged" | "max_scenes" | "aborted";
  sceneCount: number;
  fallbackScenes: number;
  openingSource: string;
  endingOutcome: string | null;
}>;

export async function runStoryEvalJourney(config: StoryEvalJourneyConfig): Promise<StoryEvalJourneyResult> {
  const { env, dbPath, artifactDir, strategySeed, maxScenes, requireGeneratedOpening } = config;
  const rand = mulberry32(hashStringToSeed(String(strategySeed)));
  const { input } = buildStoryEvalInput("long", strategySeed);
  let entry: ServerGameEntryPoints | null = null;
  let evalRepository: SqliteGameRepository | null = null;
  const storyRows: StoryRow[] = [];
  let status: StoryEvalJourneyResult["status"] = "max_scenes";
  let openingSource = "unknown";
  let endingOutcome: string | null = null;
  let fallbackScenes = 0;
  let sceneCount = 0;

  try {
    entry = createServerGameEntryPoints({ ...env, GAME_DB_PATH: dbPath });
    evalRepository = openEvalRepository(dbPath);

    const created = await entry.createGame(input);
    if (!created.ok) throw new Error(`createGame failed: ${created.code}`);
    // requireGeneratedOpening：真实模式要求开局由 AI 生成（离线 fetch-mock 走
    // fallback 开局可接受）；不满足直接失败，避免把非生成开局误记成生成。
    if (requireGeneratedOpening && created.source !== "generated") {
      throw new Error(`opening was not AI-generated: ${created.source}`);
    }
    openingSource = created.source;

    const loadRecord = async () => {
      const loaded = await evalRepository!.getCurrentGame();
      if (!loaded.ok || loaded.status !== "active") throw new Error("eval repository record unavailable");
      return loaded.record;
    };
    const getView = async (): Promise<GameSessionView> => {
      const current = await entry!.getCurrentGame();
      if (current.status !== "active") throw new Error("journey view unavailable");
      return current.view;
    };

    let view = await getView();
    let previousLedgerLength = (await loadRecord()).state.eventLedger.length;
    const manifest: Record<string, unknown> = {
      gameId: null,
      worldSeed: null,
      strategySeed,
      gameLength: "long",
      model: config.modelLabel ?? null,
      status,
      sceneCount: 0,
      fallbackScenes: 0,
      blueprint: null,
    };

    for (let sceneIndex = 1; sceneIndex <= maxScenes; sceneIndex += 1) {
      // 1. pending 时确保生成并轮询到场景/战斗/结局就绪（带超时）。
      if (view.narrativeGeneration.status === "pending" || view.narrative === null) {
        await entry.ensureNarrativeGeneration();
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          view = await getView();
          if (view.narrative !== null || view.battle !== null || view.ending !== null) break;
          await sleep(500);
        }
        if (view.narrative === null && view.battle === null && view.ending === null) {
          throw new Error("narrative generation timeout");
        }
      }
      // 2. 结局：收尾记录。
      if (view.ending !== null) {
        endingOutcome = view.ending.outcome;
        status = "converged";
        const record = await loadRecord();
        const tailEvents = record.state.eventLedger
          .slice(previousLedgerLength)
          .map((event) => ({ type: event.type }));
        storyRows.push({ kind: "ending", sceneIndex, outcome: endingOutcome, newEvents: tailEvents });
        previousLedgerLength = record.state.eventLedger.length;
        break;
      }
      // 3. 战斗：attack 优先打完（battle_action 为独立 intent，不占场景序号）。
      if (view.battle !== null) {
        while (view.battle !== null) {
          const result = await entry.performAction({
            intent: { type: "battle_action", action: "attack" },
            expectedRevision: view.revision,
          });
          if (!result.ok) throw new Error(`battle action rejected: ${result.code}`);
          view = result.view;
        }
        continue;
      }
      // 4. 场景就绪：记录 story 行。
      const record = await loadRecord();
      const scene = record.state.narrative.currentScene;
      if (scene === null) throw new Error("scene vanished before record");
      const stage = deriveContentProgression({ blueprint: record.blueprint, state: record.state }).mainStage;
      const calls = readCalls(artifactDir);
      const choice = pickNarrativeChoice(record, rand);
      const newEvents = record.state.eventLedger
        .slice(previousLedgerLength)
        .map((event) => ({ type: event.type }));
      storyRows.push({
        kind: "scene",
        sceneIndex,
        sceneId: scene.sceneId,
        mainStage: stage,
        narration: scene.narration,
        npcLine: scene.npcLine === null ? null : { text: scene.npcLine.text, emotion: scene.npcLine.emotion },
        choices: scene.choices.map((entry) => ({ label: entry.label, actionKey: entry.actionKey })),
        directorPlan: directorPlanFor(scene.sceneId, calls),
        fallback: scene.source === "fallback",
        playerChoice: { index: choice.index, actionKey: scene.choices[choice.index]?.actionKey ?? "", reason: choice.reason },
        newEvents,
      });
      previousLedgerLength = record.state.eventLedger.length;
      sceneCount += 1;
      if (scene.source === "fallback") fallbackScenes += 1;
      if (fallbackScenes > sceneCount / 2) {
        status = "aborted";
        break;
      }
      // 5. 执行选择。
      const result = await entry.performAction({
        intent: { type: "narrative_choice", choiceToken: scene.choices[choice.index]?.choiceToken ?? "" },
        expectedRevision: view.revision,
      });
      if (!result.ok) throw new Error(`narrative choice rejected at ${sceneIndex}: ${result.code}`);
      view = result.view;
    }

    // 6. 收尾产物：manifest.json 与 story.jsonl。
    const finalRecord = await loadRecord();
    const blueprint = finalRecord.blueprint;
    manifest.gameId = String(finalRecord.gameId);
    manifest.worldSeed = blueprint.seed;
    manifest.status = status;
    manifest.sceneCount = sceneCount;
    manifest.fallbackScenes = fallbackScenes;
    manifest.blueprint = {
      world: { name: blueprint.world.name, summary: blueprint.world.summary, tone: blueprint.world.tone, themes: blueprint.world.themes },
      npcs: blueprint.npcs.map((npc) => ({
        id: String(npc.id),
        name: npc.name,
        role: npc.role,
        description: (npc as Record<string, unknown>).description ?? null,
        isCompanion: npc.isCompanion,
        knownFactIds: npc.knownFactIds.map(String),
      })),
      quests: blueprint.quests.map((quest) => ({
        id: String(quest.id),
        name: quest.name,
        kind: quest.kind,
        stage: quest.kind === "main" ? quest.stage : null,
        description: quest.description,
      })),
      endings: blueprint.endings.map((ending) => ({
        id: String(ending.id),
        name: ending.name,
        description: ending.description,
      })),
    };
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "story.jsonl"), storyRows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    writeFileSync(join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } finally {
    await entry?.close();
  }
  return { status, sceneCount, fallbackScenes, openingSource, endingOutcome };
}

function readCalls(artifactDir: string): readonly Readonly<Record<string, unknown>>[] {
  try {
    return readFileSync(join(artifactDir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Readonly<Record<string, unknown>>);
  } catch {
    return [];
  }
}

/** 假 transport 响应生成器：按 system prompt 首词区分四角色，返回合法 JSON。 */
export function createFakeAiFetch() {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages?: { role: string; content: string }[];
    };
    const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
    const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
    let content: string;
    if (system.startsWith("You are the world director")) {
      const context = JSON.parse(user) as {
        actionCandidates?: { actionKey: string }[];
        progression?: { allowedPacing?: string[] };
      };
      const candidates = context.actionCandidates ?? [];
      const first = candidates[0]?.actionKey ?? "observe:loc_1";
      // 防重复 key：approveDirectorProposal 对 keyA === keyB 直接 choice_not_legal，
      // 必须从候选里挑一个与 first 不同的 key；候选不足时退回 first（触发审批驳回→
      // 重试→fallback，与生产行为一致；离线旅程构造保证候选 ≥ 2）。
      const second = candidates.find((candidate) => candidate.actionKey !== first)?.actionKey ?? first;
      const pacing = context.progression?.allowedPacing?.at(-1) ?? "setup";
      content = JSON.stringify({
        sceneGoal: "推进当前可行动作",
        tensionLevel: 3,
        focusNpcId: null,
        relevantFactIds: [],
        allowedRevealFactIds: [],
        suggestedActionKeys: [first, second],
        introducedEntities: [],
        pacing,
        proposedNewLocations: [],
        proposedNewNpcs: [],
      });
    } else if (system.startsWith("You are the scene writer")) {
      const context = JSON.parse(user) as { plan?: { suggestedActionKeys?: string[] } };
      const keys = context.plan?.suggestedActionKeys ?? ["observe:loc_1", "observe:loc_2"];
      content = JSON.stringify({
        narration: "你继续前行，眼前的景象与线索逐渐清晰，新的选择摆在面前。",
        usedFactIds: [],
        npcInstruction: null,
        choices: [
          { actionKey: keys[0], label: "继续前行", strategy: "推进当前目标" },
          { actionKey: keys[1], label: "谨慎观察", strategy: "暂缓当前目标" },
        ],
      });
    } else if (system.startsWith("You are one NPC performer")) {
      content = JSON.stringify({ text: "这条路通向你想找的地方。", usedFactIds: [], emotion: "warm" });
    } else {
      // 开局蓝图生成（scenario）：返回结构合法但内容为空的最小候选，编译阶段
      // 会失败 → 走 fallback 开局（离线模式接受；真实模式要求 generated）。
      content = JSON.stringify({
        world: {}, openingScene: {}, player: {},
        locations: [], npcs: [], quests: [], items: [], enemies: [], endings: [],
      });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("Story eval journey (offline)", () => {
  it("fetch-mock 全链路跑通：采集/故事流水/manifest 产物完整，零网络", async () => {
    const fetchSpy = createFakeAiFetch();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchSpy);
    const artifactDir = join(tmpRoot, "offline-run");
    const dbPath = join(tmpRoot, "offline.sqlite");
    try {
      const result = await runStoryEvalJourney({
        env: {
          AI_API_BASE_URL: "http://127.0.0.1:9/v1",
          AI_MODEL: "fake-model",
          AI_API_KEY: "fake-key",
          STORY_EVAL_CAPTURE: "1",
          STORY_EVAL_ARTIFACT_DIR: artifactDir,
        },
        dbPath,
        artifactDir,
        strategySeed: 7,
        maxScenes: 3,
        requireGeneratedOpening: false,
        modelLabel: "fake-model",
      });
      expect(result.status).toBe("max_scenes");
      expect(result.sceneCount).toBe(3);
      expect(result.openingSource).toBe("fallback");
    } finally {
      vi.restoreAllMocks();
    }

    // calls.jsonl：source 捕获 + 审批记录齐全。
    const callLines = readFileSync(join(artifactDir, "calls.jsonl"), "utf8").trim().split("\n");
    expect(callLines.length).toBeGreaterThan(0);
    const roles = callLines.map((line) => JSON.parse(line).role).filter((role) => role !== undefined);
    expect(roles).toContain("director");
    expect(roles).toContain("writer");
    const kinds = callLines.map((line) => JSON.parse(line).kind);
    expect(kinds).toContain("plan_approved");
    expect(kinds).toContain("role_approval");

    // story.jsonl：场景行结构完整，导演计划摘要已关联。
    const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
    expect(storyLines).toHaveLength(3);
    for (const line of storyLines) {
      const row = JSON.parse(line) as StoryRow;
      expect(row.kind).toBe("scene");
      expect(row.narration).toBeTruthy();
      expect(row.mainStage).not.toBeNull(); // 主线 quest 存在时总是数字（deriveContentProgression）
      expect(Number(row.mainStage)).toBeGreaterThanOrEqual(1);
      expect(row.choices).toHaveLength(2);
      expect(row.directorPlan).toMatchObject({ pacing: expect.any(String), tensionLevel: 3 });
      expect(row.playerChoice).toMatchObject({ index: expect.any(Number), reason: expect.any(String) });
      expect(Array.isArray(row.newEvents)).toBe(true);
    }

    // manifest.json：gameId/世界 seed/蓝图快照。
    const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.gameId).toBeTruthy();
    expect(manifest.worldSeed).toBeTruthy();
    expect(manifest.status).toBe("max_scenes");
    expect(manifest.sceneCount).toBe(3);
    const blueprint = manifest.blueprint as { quests: readonly { kind: string }[]; endings: readonly unknown[]; world: { name: string } };
    expect(blueprint.world.name).toBeTruthy();
    expect(blueprint.quests.some((quest) => quest.kind === "main")).toBe(true);
    expect(blueprint.endings.length).toBeGreaterThan(0);
  });
});

describe("Story eval journey (real AI, opt-in)", () => {
  it.runIf(process.env.RUN_REAL_AI_STORY_EVAL === "1")(
    "记录一局真实 long 故事旅程（门禁脚本注入 env）",
    async () => {
      const artifactDir = process.env.STORY_EVAL_ARTIFACT_DIR;
      const dbPath = process.env.GAME_DB_PATH;
      if (artifactDir === undefined || dbPath === undefined) {
        throw new Error("missing safe story-eval artifact dir or db path");
      }
      const result = await runStoryEvalJourney({
        env: process.env,
        dbPath,
        artifactDir,
        strategySeed: Number(process.env.STORY_EVAL_SEED ?? "0"),
        maxScenes: Number(process.env.STORY_EVAL_MAX_SCENES ?? "60"),
        requireGeneratedOpening: true,
        modelLabel: process.env.AI_MODEL ?? null,
      });
      // requireGeneratedOpening 已在 runStoryEvalJourney 内部校验（开局非 generated 直接失败）。
      const storyLines = readFileSync(join(artifactDir, "story.jsonl"), "utf8").trim().split("\n");
      expect(storyLines.length).toBeGreaterThan(0);
    },
    1_800_000,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/game/application/testing/storyEvalJourney.test.ts`
Expected: FAIL（`runStoryEvalJourney` 尚不存在；或 fetch-mock 下装配断言失败）

- [ ] **Step 3: 实现（上述代码即完整实现）**

> 注意：`runStoryEvalJourney` 内部使用 `readCalls(artifactDir)` 在循环中实时关联导演计划——因为 `calls.jsonl` 由 sink 同步追加写，场景记录时该场景的 plan_approved 已落盘。`requireGeneratedOpening` 在 journey 内部实现：createGame 后校验 `created.source === "generated"`，不满足直接抛错（离线 fetch-mock 走 fallback 开局，必须显式传 false）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/game/application/testing/storyEvalJourney.test.ts`
Expected: PASS（离线 1 it；真实用例被 runIf 跳过）

Run: `npm run typecheck` —— Expected: 无错误

Run: `npm run test:phase10-journey` 与 `npm run test:phase11-journey` —— Expected: PASS（回归）

- [ ] **Step 5: 提交**

```bash
git add src/game/application/testing/storyEvalJourney.test.ts
git commit -m "feat(ai-story-eval): add full journey driver with story.jsonl and manifest artifacts"
```

---

### Task 9: 门禁脚本 storyEvalJourney.mjs（+ node-test + npm scripts）

**Files:**
- Create: `scripts/storyEvalJourney.mjs`
- Create: `scripts/storyEvalJourney.node-test.mjs`
- Modify: `package.json`（scripts）

**Interfaces:**
- Consumes: `runStoryEvalJourney` 所在的 vitest 测试文件（Task 8）、`defaultAiEnvSources`/`readAiEnv`/`validateAiEnv`/`projectRoot`（`scripts/aiEnv.mjs`）
- Produces: 门禁 CLI——`node scripts/storyEvalJourney.mjs --mode=record [--runs N] [--seed <base>]`；`--mode=replay` 跑零网络离线用例；record 模式要求 `RUN_REAL_AI_STORY_EVAL=1`，逐局 spawnSync vitest 子进程，childEnv 注入 `STORY_EVAL_CAPTURE=1`、`STORY_EVAL_ARTIFACT_DIR`、`STORY_EVAL_SEED`、`STORY_EVAL_MAX_SCENES`、`GAME_DB_PATH`（tmp 临时 SQLite）与 AI 三键；`--runs N` 时策略 seed 依次递增。

- [ ] **Step 1: 写失败测试（node-test）**

创建 `scripts/storyEvalJourney.node-test.mjs`：

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  main,
  resolveBaseSeed,
  resolveJourneyMode,
  resolveRunCount,
} from "./storyEvalJourney.mjs";

test("resolveJourneyMode 只接受 record/replay", () => {
  assert.equal(resolveJourneyMode(["--mode=record"]), "record");
  assert.equal(resolveJourneyMode(["--mode=replay"]), "replay");
  assert.equal(resolveJourneyMode([]), "replay");
  assert.equal(resolveJourneyMode(["--mode=bogus"]), null);
});

test("resolveRunCount 缺省 1，解析正整数", () => {
  assert.equal(resolveRunCount([]), 1);
  assert.equal(resolveRunCount(["--runs=3"]), 3);
  assert.equal(resolveRunCount(["--runs=0"]), null);
  assert.equal(resolveRunCount(["--runs=abc"]), null);
});

test("resolveBaseSeed 缺省 20260731，解析数字", () => {
  assert.equal(resolveBaseSeed([]), 20260731);
  assert.equal(resolveBaseSeed(["--seed=42"]), 42);
  assert.equal(resolveBaseSeed(["--seed=x"]), null);
});

test("main 在 record 模式且 RUN_REAL_AI_STORY_EVAL 未设置时打印提示并 exit 1", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=record"],
    env: {},
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("REAL_AI_OPT_IN_REQUIRED")));
});

test("main replay 模式 spawn 离线 vitest 且不要求 AI 凭据", () => {
  let spawnedEnv = null;
  const code = main({
    argv: ["--mode=replay"],
    env: {},
    log: () => {},
    spawn: (env) => { spawnedEnv = env; return 0; },
  });
  assert.equal(code, 0);
  assert.ok(spawnedEnv !== null);
  assert.equal(spawnedEnv.RUN_REAL_AI_STORY_EVAL, "0");
});

test("main record 模式缺 AI 凭据时 AI_ENV_INVALID", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=record"],
    env: { RUN_REAL_AI_STORY_EVAL: "1" },
    // sources 注入空列表：确定性失败，不依赖真实 .env 文件（测试环境隔离）。
    sources: () => [],
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("must not spawn"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("AI_ENV_INVALID")));
});

test("main replay 模式 spawn 抛错时 SPAWN_FAILED 并 exit 1", () => {
  const lines = [];
  const code = main({
    argv: ["--mode=replay"],
    env: {},
    log: (line) => lines.push(line),
    spawn: () => { throw new Error("boom"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("SPAWN_FAILED")));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/storyEvalJourney.node-test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

创建 `scripts/storyEvalJourney.mjs`：

```javascript
// ---------------------------------------------------------------------------
// storyEvalJourney：评估旅程门禁脚本（spec §7）。
// 沿用 scripts/phase11StoryContinuityJourney.mjs 的门禁模式：
// - --mode=replay：跑零网络离线用例（vitest 文件内 fetch 被 mock）；
// - --mode=record：要求 RUN_REAL_AI_STORY_EVAL=1 才发真实计费调用；校验 AI 凭据
//   （aiEnv.mjs），逐局 spawnSync vitest 子进程，childEnv 显式注入
//   STORY_EVAL_CAPTURE=1、STORY_EVAL_ARTIFACT_DIR、STORY_EVAL_SEED、
//   STORY_EVAL_MAX_SCENES、GAME_DB_PATH（tmp 临时 SQLite）与 AI 三键。
// - --runs N：策略 seed 依次递增，每局独立 run-id 与独立临时库（结束即清）。
// 真实计费调用一律显式 env 开关；stdout 绝不打印凭据。
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  defaultAiEnvSources,
  projectRoot,
  readAiEnv,
  validateAiEnv,
} from "./aiEnv.mjs";

const PREFIX = "[story-eval-journey]";
const TEST_FILE = "src/game/application/testing/storyEvalJourney.test.ts";

export function resolveJourneyMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "replay";
  return mode === "record" || mode === "replay" ? mode : null;
}

export function resolveRunCount(argv) {
  const arg = argv.find((entry) => entry.startsWith("--runs="));
  if (arg === undefined) return 1;
  const value = Number(arg.slice("--runs=".length));
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function resolveBaseSeed(argv) {
  const arg = argv.find((entry) => entry.startsWith("--seed="));
  if (arg === undefined) return 20260731;
  const value = Number(arg.slice("--seed=".length));
  return Number.isFinite(value) ? value : null;
}

export function isPathInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !rel.includes(":");
}

function spawnJourney(env) {
  return spawnSync(
    process.execPath,
    ["./node_modules/vitest/vitest.mjs", "run", TEST_FILE],
    {
      cwd: projectRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    },
  ).status ?? 1;
}

/** 清扫上次运行因 Windows 句柄延迟而遗留的临时库（与 phase4b smoke 同一约定）。 */
function sweepStaleTempDatabases() {
  const tmpRoot = resolve(projectRoot, "tmp");
  let entries;
  try {
    entries = readdirSync(tmpRoot);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("story-eval-run-")) continue;
    try {
      rmSync(resolve(tmpRoot, entry), { force: true });
    } catch {
      // 仍被占用：留待下次运行清理。
    }
  }
}

export function main({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
  spawn = spawnJourney,
  // sources 注入式（node-test 传 () => [] 确定性失败）；默认读取真实 .env 候选。
  sources = defaultAiEnvSources({ cwd: projectRoot, env }),
} = {}) {
  // spawn 可能抛错（如 vitest.mjs 缺失）：统一包装，绝不崩溃主流程。
  const runSpawn = (childEnv) => {
    try {
      return spawn(childEnv);
    } catch {
      log(`${PREFIX} SPAWN_FAILED`);
      return 1;
    }
  };
  const mode = resolveJourneyMode(argv);
  if (mode === null) {
    log(`${PREFIX} INVALID_MODE`);
    return 1;
  }
  const runs = resolveRunCount(argv);
  if (runs === null) {
    log(`${PREFIX} INVALID_RUNS`);
    return 1;
  }
  const baseSeed = resolveBaseSeed(argv);
  if (baseSeed === null) {
    log(`${PREFIX} INVALID_SEED`);
    return 1;
  }
  if (mode === "replay") {
    log(`${PREFIX} replay: zero-network offline journey`);
    return runSpawn({ ...env, RUN_REAL_AI_STORY_EVAL: "0" });
  }
  if (env.RUN_REAL_AI_STORY_EVAL !== "1") {
    log(`${PREFIX} REAL_AI_OPT_IN_REQUIRED：真实 AI 评估需显式设置 RUN_REAL_AI_STORY_EVAL=1`);
    return 1;
  }

  const source = sources
    .find((candidate) => existsSync(candidate) && validateAiEnv(readAiEnv(candidate)).length === 0);
  if (source === undefined) {
    log(`${PREFIX} AI_ENV_INVALID`);
    return 1;
  }
  const aiValues = readAiEnv(source);
  const artifactRoot = resolve(projectRoot, "artifacts", "story-eval");
  const dbRoot = resolve(projectRoot, "tmp");
  mkdirSync(dbRoot, { recursive: true });
  sweepStaleTempDatabases();
  let failed = 0;
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    // runId 带随机后缀：防并发/同毫秒冲突覆盖同目录产物。
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
    const artifactDir = resolve(artifactRoot, runId);
    const databasePath = resolve(dbRoot, `story-eval-run-${runIndex}-${randomUUID()}.sqlite`);
    if (!isPathInside(artifactRoot, artifactDir)) {
      log(`${PREFIX} ARTIFACT_PATH_REJECTED`);
      return 1;
    }
    const childEnv = {
      ...env,
      RUN_REAL_AI_STORY_EVAL: "1",
      STORY_EVAL_CAPTURE: "1",
      STORY_EVAL_ARTIFACT_DIR: artifactDir,
      STORY_EVAL_SEED: String(baseSeed + runIndex),
      STORY_EVAL_MAX_SCENES: env.STORY_EVAL_MAX_SCENES ?? "60",
      GAME_DB_PATH: databasePath,
    };
    for (const key of ["AI_API_BASE_URL", "AI_MODEL", "AI_API_KEY"]) {
      childEnv[key] = aiValues.get(key).decoded;
    }
    log(`${PREFIX} record run ${runIndex + 1}/${runs} seed=${baseSeed + runIndex}`);
    const status = runSpawn(childEnv);
    if (status !== 0) failed += 1;
    try {
      rmSync(databasePath, { force: true });
    } catch {
      // Windows 句柄延迟：留待下次 sweep。
    }
  }
  log(`${PREFIX} ${failed === 0 ? "REAL_AI_JOURNEY_OK" : `REAL_AI_JOURNEY_FAILED ${failed}/${runs}`}`);
  return failed === 0 ? 0 : 1;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main();
}
```

`package.json` scripts 追加（放在 `smoke:ai:phase11-journey` 之后）：

```json
    "test:story-eval-journey": "vitest run src/game/application/testing/storyEvalJourney.test.ts",
    "test:story-eval-journey-script": "node --test scripts/storyEvalJourney.node-test.mjs",
    "journey:story-eval": "node scripts/storyEvalJourney.mjs --mode=replay",
    "smoke:ai:story-eval": "node scripts/storyEvalJourney.mjs --mode=record",
    "test:story-eval-analyze": "node --test scripts/storyEvalAnalyze.node-test.mjs",
    "analyze:story-eval": "node scripts/storyEvalAnalyze.mjs",
    "test:story-eval-judge": "node --test scripts/storyEvalJudge.node-test.mjs",
    "judge:story-eval": "node scripts/storyEvalJudge.mjs"
```

> 注：`analyze`/`judge` 脚本在 Task 10/11 创建；此处一次性追加全部 npm scripts（npm 允许脚本指向尚不存在的文件，后续任务补齐）。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:story-eval-journey-script` —— Expected: PASS（7 test）

Run: `npm run journey:story-eval` —— Expected: PASS（replay 跑离线用例，零网络）

- [ ] **Step 5: 提交**

```bash
git add scripts/storyEvalJourney.mjs scripts/storyEvalJourney.node-test.mjs package.json
git commit -m "feat(ai-story-eval): add gated journey script with multi-run support"
```

---

### Task 10: 客观指标分析脚本 storyEvalAnalyze.mjs

**Files:**
- Create: `scripts/storyEvalAnalyze.mjs`
- Create: `scripts/storyEvalAnalyze.node-test.mjs`

**Interfaces:**
- Consumes: run 目录（`calls.jsonl`/`story.jsonl`/`manifest.json`）
- Produces:
  - `computeStoryEvalMetrics({ calls, story, manifest })`（纯函数，导出）
  - `pacingRank(pacing)`（导出）
  - `main({ argv, fs, log })`（注入式，供 node-test）：`node scripts/storyEvalAnalyze.mjs <runDir>` → 写 `<runDir>/metrics.json` + 打印摘要
- 口径说明：`tension.stddev` 为**总体标准差**（除以 n 而非 n-1）；`retries` 按关联键契约统计——同一 `traceId` 的最大 `attempt` > 1 即算一次重试（attempt 为同场景同角色 1-based 尝试序号）。

- [ ] **Step 1: 写失败测试**

创建 `scripts/storyEvalAnalyze.node-test.mjs`：

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStoryEvalMetrics, main, pacingRank } from "./storyEvalAnalyze.mjs";

const calls = [
  { kind: "ai_call", role: "director", traceId: "t1", attempt: 1, failureCategory: null },
  { kind: "ai_call", role: "director", traceId: "t2", attempt: 2, failureCategory: "invalid_json" },
  { kind: "ai_call", role: "director", traceId: "t3", attempt: 2, failureCategory: null },
  { kind: "ai_call", role: "writer", traceId: "t4", attempt: 1, failureCategory: null },
  { kind: "ai_call", role: "scenario", traceId: "t5", attempt: 1, failureCategory: null },
  { kind: "role_approval", role: "director", attempt: 1, category: "reference_violation" },
  { kind: "role_approval", role: "writer", attempt: 1, category: "schema_violation" },
  { kind: "plan_approved", attempt: 1, planSummary: { tensionLevel: 1, pacing: "setup" } },
  { kind: "plan_approved", attempt: 2, planSummary: { tensionLevel: 5, pacing: "develop" } },
  { kind: "expansion_decision", decision: { ok: true, expansion: {} } },
  { kind: "expansion_decision", decision: { ok: false, reason: "budget_exhausted" } },
];

const story = [
  { kind: "scene", sceneIndex: 1, mainStage: 1, narration: "aaa bbb ccc", newEvents: [{ type: "narrative_choice" }], fallback: false, directorPlan: { allowedRevealFactIds: [] } },
  { kind: "scene", sceneIndex: 2, mainStage: 2, narration: "aaa bbb ddd", newEvents: [{ type: "fact_discovered" }], fallback: false, directorPlan: { allowedRevealFactIds: ["f1"] } },
  { kind: "scene", sceneIndex: 3, mainStage: 2, narration: "xxx yyy zzz", newEvents: [], fallback: true, directorPlan: null },
  { kind: "ending", sceneIndex: 4, outcome: "success", newEvents: [] },
];

const manifest = { status: "converged", sceneCount: 3, fallbackScenes: 1 };

test("computeStoryEvalMetrics 计算全部客观指标", () => {
  const metrics = computeStoryEvalMetrics({ calls, story, manifest });
  assert.equal(metrics.sceneCount, 3);
  assert.equal(metrics.converged, true);
  assert.equal(metrics.fallbackRate, 1 / 3);
  assert.equal(metrics.perRole.director.attempts, 3);
  assert.equal(metrics.perRole.director.retries, 2);      // t2/t3 的 attempt>1
  assert.equal(metrics.perRole.director.invalidJson, 1);
  assert.equal(metrics.perRole.writer.attempts, 1);
  assert.equal(metrics.approvalRejections.reference_violation, 1);
  assert.equal(metrics.approvalRejections.schema_violation, 1);
  assert.deepEqual(metrics.tension.values, [1, 5]);
  assert.equal(metrics.tension.stddev, 2);                // [1,5] 总体标准差 = 2
  assert.deepEqual(metrics.pacing.distribution, { setup: 1, develop: 1 });
  assert.equal(metrics.pacing.illegalOrderCount, 0);      // setup→develop 合法
  assert.deepEqual(metrics.factsPerAct, [{ act: 1, revealed: 0 }, { act: 2, revealed: 1 }]);
  assert.ok(metrics.trigramRepeat > 0 && metrics.trigramRepeat < 1);
  assert.equal(metrics.narrationLengths.mean > 0, true);
  assert.equal(metrics.expansions.proposed, 2);
  assert.equal(metrics.expansions.approved, 1);
  assert.equal(metrics.expansions.adoptionRate, 0.5);
  assert.equal(metrics.maxScenesHit, false);
});

test("pacingRank 顺序合法判定", () => {
  assert.ok(pacingRank("setup") < pacingRank("develop"));
  assert.equal(pacingRank("climax"), 3);
  assert.equal(pacingRank("bogus"), -1);
});

test("main 对给定 runDir 写 metrics.json 并打印摘要", () => {
  const files = {};
  const code = main({
    argv: ["/run/dir"],
    fs: {
      readFileSync: (path) => {
        if (path.endsWith("calls.jsonl")) return calls.map((line) => JSON.stringify(line)).join("\n") + "\n";
        if (path.endsWith("story.jsonl")) return story.map((line) => JSON.stringify(line)).join("\n") + "\n";
        if (path.endsWith("manifest.json")) return JSON.stringify(manifest);
        throw new Error(`unexpected read: ${path}`);
      },
      writeFileSync: (path, content) => { files[path] = content; },
    },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.ok(files["/run/dir/metrics.json"] !== undefined);
  const written = JSON.parse(files["/run/dir/metrics.json"]);
  assert.equal(written.sceneCount, 3);
});

test("main 无参数时 RUN_DIR_REQUIRED", () => {
  const lines = [];
  const code = main({ argv: [], fs: {}, log: (line) => lines.push(line) });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("RUN_DIR_REQUIRED")));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/storyEvalAnalyze.node-test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

创建 `scripts/storyEvalAnalyze.mjs`：

```javascript
// ---------------------------------------------------------------------------
// storyEvalAnalyze：零 AI 成本的客观指标分析（spec §8.1）。
// 纯离线：输入任意 run 目录（calls.jsonl / story.jsonl / manifest.json），
// 输出 metrics.json。可对历史 run 重复执行，是每轮调优后的免费第一道体检。
// 指标定义见 docs/策划文档/AI内容质量评估标准.md §3（与本文件保持一致）。
// ---------------------------------------------------------------------------

import { resolve } from "node:path";

const PACING_ORDER = ["setup", "develop", "turn", "climax", "resolution"];

export function pacingRank(pacing) {
  return PACING_ORDER.indexOf(pacing);
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 总体标准差（除以 n 而非 n-1；口径与接口文档一致，避免与样本标准差混淆）。 */
function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance = mean(values.map((value) => (value - avg) ** 2));
  return Math.sqrt(variance);
}

/** 相邻 narration 字符 3-gram 重复率（Jaccard 平均），0=无重复。 */
function trigramRepeatRate(narrations) {
  const grams = (text) => {
    const chars = Array.from(text);
    const set = new Set();
    for (let index = 0; index + 3 <= chars.length; index += 1) {
      set.add(chars.slice(index, index + 3).join(""));
    }
    return set;
  };
  const ratios = [];
  for (let index = 1; index < narrations.length; index += 1) {
    const prev = grams(narrations[index - 1]);
    const curr = grams(narrations[index]);
    if (prev.size === 0 || curr.size === 0) continue;
    let overlap = 0;
    for (const gram of curr) if (prev.has(gram)) overlap += 1;
    ratios.push(overlap / (prev.size + curr.size - overlap));
  }
  return ratios.length === 0 ? 0 : mean(ratios);
}

export function computeStoryEvalMetrics({ calls, story, manifest }) {
  const sceneRows = story.filter((row) => row.kind === "scene");
  const endingRow = story.find((row) => row.kind === "ending");
  const aiCalls = calls.filter((call) => call.kind === "ai_call");
  const perRole = {};
  for (const role of ["scenario", "director", "writer", "npc"]) {
    const roleCalls = aiCalls.filter((call) => call.role === role);
    const attemptsByTrace = new Map();
    for (const call of roleCalls) {
      const previous = attemptsByTrace.get(call.traceId) ?? 0;
      attemptsByTrace.set(call.traceId, Math.max(previous, call.attempt));
    }
    // 关联键契约（Task 1/2）：attempt 为同场景同角色 1-based 尝试序号；重试 = 出现 attempt>1 的 trace 数。
    const retries = [...attemptsByTrace.values()].filter((attempt) => attempt > 1).length;
    perRole[role] = {
      attempts: roleCalls.length,
      retries,
      invalidJson: roleCalls.filter((call) => call.failureCategory === "invalid_json").length,
      failures: roleCalls.filter((call) => call.failureCategory !== null).length,
    };
  }
  const approvalRejections = {};
  for (const call of calls) {
    if (call.kind !== "role_approval" || call.category === null) continue;
    approvalRejections[call.category] = (approvalRejections[call.category] ?? 0) + 1;
  }
  const planApproved = calls.filter((call) => call.kind === "plan_approved");
  const tension = planApproved
    .map((call) => call.planSummary?.tensionLevel)
    .filter((value) => typeof value === "number");
  const pacingValues = planApproved
    .map((call) => call.planSummary?.pacing)
    .filter((value) => typeof value === "string");
  const pacing = { distribution: {}, illegalOrderCount: 0 };
  let previousRank = -1;
  for (const value of pacingValues) {
    const rank = pacingRank(value);
    if (rank < 0) continue;
    pacing.distribution[value] = (pacing.distribution[value] ?? 0) + 1;
    if (rank < previousRank) pacing.illegalOrderCount += 1;
    previousRank = rank;
  }
  const factsPerAct = [];
  for (const row of sceneRows) {
    if (typeof row.mainStage !== "number") continue;
    const act = factsPerAct.find((entry) => entry.act === row.mainStage);
    const revealed = (row.directorPlan?.allowedRevealFactIds ?? []).length;
    if (act === undefined) {
      factsPerAct.push({ act: row.mainStage, revealed });
    } else {
      act.revealed += revealed;
    }
  }
  const narrationLengths = sceneRows.map((row) => Array.from(row.narration ?? "").length);
  const lineLengths = sceneRows
    .flatMap((row) => (row.npcLine === null || row.npcLine === undefined ? [] : [Array.from(row.npcLine.text ?? "").length]));
  const expansions = calls.filter((call) => call.kind === "expansion_decision");
  const approved = expansions.filter((call) => call.decision?.ok === true).length;
  return {
    sceneCount: sceneRows.length,
    converged: endingRow !== undefined,
    fallbackRate: sceneRows.length === 0 ? 0 : sceneRows.filter((row) => row.fallback === true).length / sceneRows.length,
    fallbackScenes: sceneRows.filter((row) => row.fallback === true).length,
    perRole,
    approvalRejections,
    tension: { values: tension, stddev: stddev(tension) },
    pacing,
    factsPerAct,
    trigramRepeat: trigramRepeatRate(sceneRows.map((row) => row.narration ?? "")),
    narrationLengths: {
      min: narrationLengths.length === 0 ? 0 : Math.min(...narrationLengths),
      max: narrationLengths.length === 0 ? 0 : Math.max(...narrationLengths),
      mean: mean(narrationLengths),
    },
    lineLengths: {
      min: lineLengths.length === 0 ? 0 : Math.min(...lineLengths),
      max: lineLengths.length === 0 ? 0 : Math.max(...lineLengths),
      mean: mean(lineLengths),
    },
    expansions: {
      proposed: expansions.length,
      approved,
      adoptionRate: expansions.length === 0 ? 0 : approved / expansions.length,
    },
    maxScenesHit: manifest?.status === "max_scenes",
  };
}

function readLines(text) {
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

export function main({ argv, fs, log }) {
  const runDir = argv[0];
  if (runDir === undefined) {
    log("[story-eval-analyze] RUN_DIR_REQUIRED");
    return 1;
  }
  const join = (name) => `${runDir.replace(/[\\/]+$/, "")}/${name}`;
  const metrics = computeStoryEvalMetrics({
    calls: readLines(fs.readFileSync(join("calls.jsonl"), "utf8")),
    story: readLines(fs.readFileSync(join("story.jsonl"), "utf8")),
    manifest: JSON.parse(fs.readFileSync(join("manifest.json"), "utf8")),
  });
  fs.writeFileSync(join("metrics.json"), JSON.stringify(metrics, null, 2) + "\n", "utf8");
  log(`[story-eval-analyze] scenes=${metrics.sceneCount} converged=${metrics.converged} fallbackRate=${metrics.fallbackRate.toFixed(3)} tensionStddev=${metrics.tension.stddev.toFixed(3)} trigramRepeat=${metrics.trigramRepeat.toFixed(3)}`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = main({ argv: process.argv.slice(2), fs: await import("node:fs"), log: console.log });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:story-eval-analyze` —— Expected: PASS（4 test）

Run: `node scripts/storyEvalAnalyze.mjs`（无参数）—— Expected: 输出 RUN_DIR_REQUIRED、exit 1

- [ ] **Step 5: 提交**

```bash
git add scripts/storyEvalAnalyze.mjs scripts/storyEvalAnalyze.node-test.mjs
git commit -m "feat(ai-story-eval): add offline objective metrics analyzer"
```

---

### Task 11: LLM 评审脚本 storyEvalJudge.mjs

**Files:**
- Create: `scripts/storyEvalJudge.mjs`
- Create: `scripts/storyEvalJudge.node-test.mjs`

**Interfaces:**
- Consumes: run 目录（`story.jsonl` + `manifest.json`，**不喂 calls.jsonl**——评审只看玩家视角）、量表文档 `docs/策划文档/AI内容质量评估标准.md`（唯一事实源，脚本只读不内嵌）
- Produces:
  - `buildEarlyPredictionPrompt({ world, npcs }, story)`——非剧透 manifest + 前 25% 场景（向上取整）
  - `buildStoryLevelPrompt({ scaleText, version, manifest, story })`——完整 manifest + 全部场景 + S1–S3/S5–S8
  - `buildSceneLevelPrompt({ scaleText, version, sampled, dimension })`——C1 全量 / C2–C4 每幕抽 2
  - `sampleScenesPerAct(story, seed, perAct)`——确定性抽样（mulberry32）
  - `parseJudgeJson(text)`——接受 fence 包裹或裸 JSON，非对象返回 null
  - `callJudge({ baseUrl, apiKey, model, messages, fetchImpl, retries })`——直连 `/chat/completions`，强制 JSON + 一次重试
  - `main({ argv, env, fs, log, fetchImpl })`（注入式）：门禁 `RUN_REAL_AI_STORY_EVAL_JUDGE=1`；写 `scores.json` + `report.md`（含 §5.4 人工抽查清单）

- [ ] **Step 1: 写失败测试**

创建 `scripts/storyEvalJudge.node-test.mjs`：

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEarlyPredictionPrompt,
  buildSceneLevelPrompt,
  buildStoryLevelPrompt,
  collectLowScenes,
  main,
  parseJudgeJson,
  sampleScenesPerAct,
} from "./storyEvalJudge.mjs";

const manifest = {
  world: { name: "W", summary: "S", tone: "dark", themes: ["t"] },
  npcs: [{ name: "N", role: "村民" }],
  quests: [{ id: "q1", name: "主线", kind: "main", stage: 1 }],
  endings: [{ id: "e1", name: "终局", description: "d" }],
};
const story = [
  { kind: "scene", sceneIndex: 1, mainStage: 1, narration: "n1" },
  { kind: "scene", sceneIndex: 2, mainStage: 1, narration: "n2" },
  { kind: "scene", sceneIndex: 3, mainStage: 2, narration: "n3" },
  { kind: "scene", sceneIndex: 4, mainStage: 2, narration: "n4" },
  { kind: "scene", sceneIndex: 5, mainStage: 3, narration: "n5" },
  { kind: "scene", sceneIndex: 6, mainStage: 3, narration: "n6" },
];

test("buildEarlyPredictionPrompt 只含前 25% 场景且排除双结局与任务结构", () => {
  const prompt = buildEarlyPredictionPrompt({ world: manifest.world, npcs: manifest.npcs }, story);
  assert.ok(prompt.includes("n1"));
  assert.ok(prompt.includes("n2"));          // 6 场景的 25% = 1.5 → 向上取整 2
  assert.ok(!prompt.includes("n3"));
  assert.ok(!prompt.includes("终局"));        // 结局排除
  assert.ok(!prompt.includes("q1"));          // 任务结构排除
  assert.ok(prompt.includes("世界观"));       // 非剧透部分包含
});

test("buildStoryLevelPrompt 含完整 manifest 与全部场景与 S 维度清单", () => {
  const prompt = buildStoryLevelPrompt({
    scaleText: "# 量表 v9\nS1 三幕式",
    version: "v9",
    manifest,
    story,
  });
  assert.ok(prompt.includes("n5"));
  assert.ok(prompt.includes("终局"));
  assert.ok(prompt.includes("S1"));
  assert.ok(prompt.includes("v9"));
});

test("sampleScenesPerAct 每幕抽 2 且确定性", () => {
  // 6 场景 = 每幕各 2 个（act1/act2/act3），perAct=2 → 全量 6。
  const sampled = sampleScenesPerAct(story, 42, 2);
  assert.equal(sampled.length, 6);
  const again = sampleScenesPerAct(story, 42, 2);
  assert.deepEqual(sampled, again);
  const acts = new Set(sampled.map((row) => row.mainStage));
  assert.deepEqual([...acts].sort(), [1, 2, 3]);
});

test("parseJudgeJson 接受 fence 包裹与裸 JSON，拒绝非对象", () => {
  assert.deepEqual(parseJudgeJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJudgeJson('{"a":1}'), { a: 1 });
  assert.equal(parseJudgeJson("nope"), null);
  assert.equal(parseJudgeJson("[1,2]"), null);
});

test("collectLowScenes 收集 ≤2 分场景与 seed 随机 3 场景", () => {
  const scores = {
    sceneLevel: {
      C1: { scores: [{ sceneIndex: 1, score: 2 }, { sceneIndex: 3, score: 4 }] },
      C2: { scores: [{ sceneIndex: 2, score: 5 }] },
      C3: { scores: [] },
      C4: { scores: [] },
    },
    storyLevel: { scores: { S5: { score: 1, evidence: [] } } },
  };
  const low = collectLowScenes(scores, story, { strategySeed: 7 });
  // 断言集合关系而非随机抽样命中的具体 index（seed 随机部分不固定，去 index 依赖）。
  assert.ok(low.includes(1));   // C1 低分场景（sceneIndex 1）
  assert.ok(low.includes("S5")); // 故事级低分维度
  assert.ok(low.length >= 4);   // {1, S5} + seed 随机 3（去重后至少 4）
});

test("main 门禁：RUN_REAL_AI_STORY_EVAL_JUDGE 未设置时打印提示并 exit 1，不发请求", async () => {
  const lines = [];
  const code = await main({
    argv: ["/run/dir"],
    env: {},
    fs: {
      readFileSync: () => { throw new Error("must not read"); },
      writeFileSync: () => { throw new Error("must not write"); },
    },
    log: (line) => lines.push(line),
    fetchImpl: () => { throw new Error("must not fetch"); },
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("JUDGE_OPT_IN_REQUIRED")));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test scripts/storyEvalJudge.node-test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

创建 `scripts/storyEvalJudge.mjs`：

```javascript
// ---------------------------------------------------------------------------
// storyEvalJudge：LLM-as-judge 评审脚本（spec §8.2）。
// 输入只有 story.jsonl + manifest.json，绝不喂 calls.jsonl（评审只看玩家视角，
// 避免被内部计划带偏）。三段评审：
//   ① 早期预测测试（S4，独立先行，输入隔离：只喂前 25% 场景 + 非剧透 manifest）；
//   ② 故事级评审（S1–S3、S5–S8，完整 manifest 与全部场景，逐维证据）；
//   ③ 场景级评审（C1 全量、C2–C4 每幕抽 2）。
// 量表文本唯一事实源：docs/策划文档/AI内容质量评估标准.md（脚本只读，不内嵌）。
// 输出强制 JSON，本地解析 + 一次重试；仍失败记 null，不编分。
// 门禁：RUN_REAL_AI_STORY_EVAL_JUDGE=1 才调用；模型默认 AI_MODEL，
// STORY_EVAL_JUDGE_MODEL 可覆盖；复用 AI_API_BASE_URL/AI_API_KEY。
// ---------------------------------------------------------------------------

import { resolve } from "node:path";

const SCALE_DOC = resolve(import.meta.dirname ?? process.cwd(), "..", "docs", "策划文档", "AI内容质量评估标准.md");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 每幕场景按种子确定性抽样（场景内随机打乱后取前 perAct 个）。 */
export function sampleScenesPerAct(story, seed, perAct) {
  const scenes = story.filter((row) => row.kind === "scene");
  const byAct = new Map();
  for (const row of scenes) {
    const act = row.mainStage ?? 0;
    if (!byAct.has(act)) byAct.set(act, []);
    byAct.get(act).push(row);
  }
  const sampled = [];
  for (const [act, rows] of byAct) {
    const rand = mulberry32(hashStringToSeed(`${seed}:${act}`));
    const shuffled = [...rows].sort(() => rand() - 0.5);
    sampled.push(...shuffled.slice(0, perAct));
  }
  return sampled;
}

function sceneToText(row) {
  const parts = [`场景 ${row.sceneIndex}: ${row.narration ?? ""}`];
  if (row.npcLine?.text !== undefined) {
    parts.push(`NPC 台词（${row.npcLine.emotion ?? ""}）：${row.npcLine.text}`);
  }
  if (Array.isArray(row.choices)) {
    parts.push(`选项：${row.choices.map((choice) => choice.label).join(" / ")}`);
  }
  if (row.playerChoice !== undefined) {
    parts.push(`玩家选择：${row.playerChoice.actionKey}（${row.playerChoice.reason}）`);
  }
  if (Array.isArray(row.newEvents) && row.newEvents.length > 0) {
    parts.push(`事件：${row.newEvents.map((event) => event.type).join(", ")}`);
  }
  return parts.join("\n");
}

/** ① 早期预测测试：非剧透 manifest + 前 25% 场景（向上取整）。 */
export function buildEarlyPredictionPrompt(nonSpoiler, story) {
  const scenes = story.filter((row) => row.kind === "scene");
  const quarter = Math.max(1, Math.ceil(scenes.length * 0.25));
  const firstQuarter = scenes.slice(0, quarter).map(sceneToText).join("\n\n");
  return [
    "你是故事质量评审员。以下是开局部分（仅前 25% 场景）与世界观/NPC 档案（不含结局、任务结构与后续内容）。",
    "请预测：1) 结局走向；2) boss/最终敌人的身份；3) 关键反转。每项给出置信度（1-5）。",
    "只输出 JSON：{\"predictions\":[{\"item\":\"结局走向\",\"prediction\":\"...\",\"confidence\":1}],\"reasoning\":\"...\"}",
    `世界观：${JSON.stringify(nonSpoiler.world)}`,
    `NPC 档案：${JSON.stringify(nonSpoiler.npcs)}`,
    `开局场景：\n${firstQuarter}`,
  ].join("\n\n");
}

/** ② 故事级评审：完整 manifest + 全部场景 + S1–S3/S5–S8 量表。 */
export function buildStoryLevelPrompt({ scaleText, version, manifest, story }) {
  const scenes = story.filter((row) => row.kind === "scene").map(sceneToText).join("\n\n");
  return [
    `你是故事质量评审员。请按以下量表（版本 ${version}）为整局故事打分（S1–S3、S5–S8，1-5 分）。`,
    "每个分数必须附证据：场景序号 + 原文引文。无证据的分数将重评一次。",
    "只输出 JSON：{\"scores\":{\"S1\":{\"score\":3,\"evidence\":[{\"sceneIndex\":1,\"quote\":\"...\"}]},\"S2\":{...}},\"reasoning\":\"...\"}",
    `量表：\n${scaleText}`,
    `完整设定（含结局与任务结构）：${JSON.stringify(manifest)}`,
    `完整故事：\n${scenes}`,
  ].join("\n\n");
}

/** ③ 场景级评审：C1 全量或 C2–C4 抽样，逐场景打分。 */
export function buildSceneLevelPrompt({ scaleText, version, sampled, dimension }) {
  const sceneText = sampled.map(sceneToText).join("\n\n");
  return [
    `你是故事质量评审员。请按量表（版本 ${version}）为以下场景评 ${dimension} 维度（1-5 分），逐场景给出分数与一句证据。`,
    "只输出 JSON：{\"scores\":[{\"sceneIndex\":1,\"score\":3,\"evidence\":\"...\"}],\"reasoning\":\"...\"}",
    `量表：\n${scaleText}`,
    `场景：\n${sceneText}`,
  ].join("\n\n");
}

export function parseJudgeJson(text) {
  const trimmed = String(text ?? "").trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\s*```$/i.exec(trimmed)?.[1];
  for (const candidate of [trimmed, fenced]) {
    if (candidate === undefined) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch { /* 继续尝试下一个候选 */ }
  }
  return null;
}

/** 直连兼容 chat/completions（scripts 目录不跨 @ai-game 边界，直接 fetch）。 */
export async function callJudge({ baseUrl, apiKey, model, messages, fetchImpl = fetch, retries = 1 }) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature: 0.2 }),
      });
      if (!response.ok) throw new Error(`judge_http_${response.status}`);
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("judge_empty_response");
      const parsed = parseJudgeJson(content);
      if (parsed !== null) return { ok: true, parsed };
      throw new Error("judge_invalid_json");
    } catch (error) {
      lastError = error;
    }
  }
  return { ok: false, error: String(lastError?.message ?? "judge_failed") };
}

function readLines(fs, path) {
  return fs.readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/** 人工抽查清单（spec §5.4）：任一维度 ≤2 分的场景 + 每局 seed 随机 3 个场景。 */
export function collectLowScenes(scores, story, manifest) {
  const low = new Set();
  const sceneLevel = scores.sceneLevel ?? {};
  for (const dimension of ["C1", "C2", "C3", "C4"]) {
    const result = sceneLevel[dimension];
    for (const entry of result?.scores ?? []) {
      if (typeof entry.score === "number" && entry.score <= 2) low.add(entry.sceneIndex);
    }
  }
  const storyLevel = scores.storyLevel?.scores ?? {};
  for (const key of Object.keys(storyLevel)) {
    if (typeof storyLevel[key]?.score === "number" && storyLevel[key].score <= 2) {
      low.add(key); // 故事级低分无场景索引：维度名整体列入报告说明
    }
  }
  const rand = mulberry32(hashStringToSeed(String(manifest?.strategySeed ?? "0")));
  const scenes = story.filter((row) => row.kind === "scene");
  const shuffled = [...scenes].sort(() => rand() - 0.5);
  for (const row of shuffled.slice(0, 3)) low.add(row.sceneIndex);
  return [...low];
}

function buildReport({ scores, manifest, lowScenes, sampled }) {
  const lines = [
    `# 故事质量评审报告（量表 ${scores.scaleVersion}，评审模型 ${scores.judgeModel}）`,
    "",
    `- gameId: ${manifest.gameId ?? "unknown"}`,
    `- worldSeed: ${manifest.worldSeed ?? "unknown"}`,
    `- strategySeed: ${manifest.strategySeed ?? "unknown"}`,
    `- gameLength: ${manifest.gameLength ?? "unknown"}`,
    `- status: ${manifest.status ?? "unknown"}（场景数 ${manifest.sceneCount ?? "?"}）`,
    "",
    "## 故事级分数",
    "",
    "| 维度 | 分数 | 证据 |",
    "| --- | --- | --- |",
  ];
  const storyLevel = scores.storyLevel?.scores ?? {};
  for (const key of ["S1", "S2", "S3", "S5", "S6", "S7", "S8"]) {
    const entry = storyLevel[key];
    if (entry === undefined) {
      lines.push(`| ${key} | null | 评审失败 |`);
      continue;
    }
    const evidence = Array.isArray(entry.evidence)
      ? entry.evidence.map((item) => `场景${item.sceneIndex}:${item.quote}`).join("；")
      : "";
    lines.push(`| ${key} | ${entry.score} | ${evidence} |`);
  }
  lines.push("", "## 早期预测测试（S4 依据）", "", `\`\`\`json\n${JSON.stringify(scores.earlyPrediction, null, 2)}\n\`\`\``, "");
  lines.push("## 场景级分数", "", "| 场景 | C1 | C2 | C3 | C4 |", "| --- | --- | --- | --- | --- |");
  const sampledIndexes = new Set(sampled.map((row) => row.sceneIndex));
  const allIndexes = new Set(sampledIndexes);
  for (const entry of scores.sceneLevel?.C1?.scores ?? []) allIndexes.add(entry.sceneIndex);
  for (const index of [...allIndexes].sort((a, b) => a - b)) {
    const score = (dimension) => {
      const entry = (scores.sceneLevel?.[dimension]?.scores ?? []).find((item) => item.sceneIndex === index);
      return entry?.score ?? "-";
    };
    lines.push(`| ${index} | ${score("C1")} | ${score("C2")} | ${score("C3")} | ${score("C4")} |`);
  }
  lines.push("", "## 人工抽查清单", "", "以下场景需人工复核评审模型判断（检查要点：声线、连续性、选项差异、证据引文）：", "");
  for (const index of lowScenes) lines.push(`- 场景 ${index}`);
  lines.push("", "## 评审失败维度", "", scores.failures.length === 0 ? "无" : scores.failures.map((name) => `- ${name}`).join("\n"));
  return lines.join("\n") + "\n";
}

export async function main({ argv, env, fs, log, fetchImpl = fetch }) {
  const runDir = argv[0];
  if (runDir === undefined) {
    log("[story-eval-judge] RUN_DIR_REQUIRED");
    return 1;
  }
  if (env.RUN_REAL_AI_STORY_EVAL_JUDGE !== "1") {
    log("[story-eval-judge] JUDGE_OPT_IN_REQUIRED：需显式设置 RUN_REAL_AI_STORY_EVAL_JUDGE=1（未发起任何请求）");
    return 1;
  }
  const baseUrl = env.AI_API_BASE_URL;
  const apiKey = env.AI_API_KEY;
  const model = env.STORY_EVAL_JUDGE_MODEL ?? env.AI_MODEL;
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    log("[story-eval-judge] JUDGE_AI_ENV_INVALID");
    return 1;
  }
  let scaleText;
  try {
    scaleText = fs.readFileSync(SCALE_DOC, "utf8");
  } catch {
    log("[story-eval-judge] SCALE_DOC_MISSING");
    return 1;
  }
  const versionMatch = /^>\s*版本[:：]\s*(\S+)/m.exec(scaleText);
  const version = versionMatch?.[1] ?? "unknown";
  const join = (name) => `${runDir.replace(/[\\/]+$/, "")}/${name}`;
  const story = readLines(fs, join("story.jsonl"));
  const manifest = JSON.parse(fs.readFileSync(join("manifest.json"), "utf8"));

  // ① 早期预测（S4）
  const predictionResult = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildEarlyPredictionPrompt({ world: manifest.blueprint?.world, npcs: manifest.blueprint?.npcs }, story) }],
    fetchImpl,
  });
  // ② 故事级（S1–S3、S5–S8）
  const storyResult = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildStoryLevelPrompt({ scaleText, version, manifest: manifest.blueprint, story }) }],
    fetchImpl,
  });
  // ③ 场景级（C1 全量、C2–C4 每幕抽 2）
  const scenesWithNpc = story.filter((row) => row.kind === "scene" && row.npcLine?.text !== undefined);
  const sampled = sampleScenesPerAct(story, Number(manifest.strategySeed ?? "0"), 2);
  const c1Result = scenesWithNpc.length > 0
    ? await callJudge({
        baseUrl, apiKey, model,
        messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled: scenesWithNpc, dimension: "C1（NPC 声线一致性）" }) }],
        fetchImpl,
      })
    : { ok: true, parsed: { scores: [], reasoning: "no npc lines" } };
  const c2Result = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled, dimension: "C2（场景衔接连续性）" }) }],
    fetchImpl,
  });
  const c3Result = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled, dimension: "C3（选项抉择质量）" }) }],
    fetchImpl,
  });
  const c4Result = await callJudge({
    baseUrl, apiKey, model,
    messages: [{ role: "user", content: buildSceneLevelPrompt({ scaleText, version, sampled, dimension: "C4（文本质量）" }) }],
    fetchImpl,
  });

  const scores = {
    scaleVersion: version,
    judgeModel: model,
    earlyPrediction: predictionResult.ok ? predictionResult.parsed : null,
    storyLevel: storyResult.ok ? storyResult.parsed : null,
    sceneLevel: {
      C1: c1Result.ok ? c1Result.parsed : null,
      C2: c2Result.ok ? c2Result.parsed : null,
      C3: c3Result.ok ? c3Result.parsed : null,
      C4: c4Result.ok ? c4Result.parsed : null,
    },
    failures: [
      ...(predictionResult.ok ? [] : ["early_prediction"]),
      ...(storyResult.ok ? [] : ["story_level"]),
      ...(c1Result.ok ? [] : ["C1"]),
      ...(c2Result.ok ? [] : ["C2"]),
      ...(c3Result.ok ? [] : ["C3"]),
      ...(c4Result.ok ? [] : ["C4"]),
    ],
  };
  const lowScenes = collectLowScenes(scores, story, manifest);
  const report = buildReport({ scores, manifest, lowScenes, sampled });
  fs.writeFileSync(join("scores.json"), JSON.stringify(scores, null, 2) + "\n", "utf8");
  fs.writeFileSync(join("report.md"), report, "utf8");
  log(`[story-eval-judge] version=${version} model=${model} failures=${scores.failures.length === 0 ? "none" : scores.failures.join(",")}`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  process.exitCode = await main({ argv: process.argv.slice(2), env: process.env, fs: await import("node:fs"), log: console.log });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test:story-eval-judge` —— Expected: PASS（6 test）

- [ ] **Step 5: 提交**

```bash
git add scripts/storyEvalJudge.mjs scripts/storyEvalJudge.node-test.mjs
git commit -m "feat(ai-story-eval): add three-phase LLM judge script"
```

---

### Task 12: 量表文档、agent 文档、索引与环境变量示例

**Files:**
- Create: `docs/策划文档/AI内容质量评估标准.md`
- Create: `docs/agent/AI内容质量评估.md`
- Modify: `docs/Agent文档索引.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: spec §5 量表与 §5.4 抽查清单（唯一事实源）；Task 8–11 的实现事实
- Produces: 量表文档 v1（judge 脚本运行时读取，版本号行格式 `> 版本：v1` 必须与脚本正则 `/^>\s*版本[:：]\s*(\S+)/m` 匹配）

- [ ] **Step 1: 创建量表文档**

创建 `docs/策划文档/AI内容质量评估标准.md`（内容 = spec §5 逐字转录，加版本头）：

```markdown
# AI 内容质量评估标准（v1）

> 版本：v1 ｜ 日期：2026-07-31 ｜ 状态：approved（spec：docs/superpowers/specs/2026-07-31-ai-story-quality-evaluation-design.md）

本文件是 LLM 评审 prompt 与人工抽查的唯一事实源。量表变更时升版本号（v2…），
并同步更新 spec 与评审脚本读取逻辑。

## 1. 故事级维度（整局一次评分，1–5 分）

权重：S2、S4 为 1.5（悬念与不可预测性是当前最重的痛点），其余 1.0。
故事级与场景级分数分开报告，不合并为单一总分。

| # | 维度 | 1 分锚点 | 3 分锚点 | 5 分锚点 |
| --- | --- | --- | --- | --- |
| S1 | 三幕式结构完整性 | pacing 标签与文本脱节，各幕平铺无递进 | 结构可辨但转折（turn）生硬或高潮仓促 | setup→develop→turn→climax→resolution 在文本中层层递进，幕间有明确升级 |
| S2 | 悬念持续性 | 多数幕结束时没有未解问题，tension 曲线平坦 | 有主悬念但中段松弛，个别幕无钩子 | 每幕留有钩子，主悬念持续加压且文本张力与 tensionLevel 一致 |
| S3 | 铺垫与回收（只评信息线索） | 前期线索多数成为孤儿，或结局依赖未铺垫的信息 | 主线线索有回收，支线线索约半数落空 | 前 1/3 引入的关键线索在后 2/3 几乎全部回收，回收自然不生硬 |
| S4 | 不可预测性（早期预测测试） | 评审只读前 25% 即高置信全中结局与关键反转 | 能预测大方向但细节与反转有偏差 | 早期预测置信度低或方向错误，实际展开合理但未被猜中 |
| S5 | 实体引入功能性（只评实体） | 新登场 NPC/地点/物品多为背景填充，与主线无关 | 实体有功能但部分扩展提议的 reason 未兑现 | 每个首次登场与动态扩展实体都推动剧情或兑现其提议理由 |
| S6 | 战斗铺垫合理性 | boss 战突兀出现，无动机建立与张力积累 | 有铺垫但张力积累不足或动机牵强 | boss 战前有清晰的动机链与逐幕升级的张力，战斗是剧情必然 |
| S7 | 结局兑现度 | 结局未回应主线冲突或与玩家行动矛盾 | 回应主线但部分悬念未闭合 | 结局回应主线冲突与主要悬念，与玩家行动逻辑自洽 |
| S8 | 选择后果感 | 选项选什么后续叙事都一样，选择无痕迹 | 部分选择被承接，部分被无视 | 上一幕的选择在下一幕叙事中被明确承接并体现差异 |

S4 评分规则：早期预测测试独立于完整评审之前执行（避免上下文污染）。评审模型只读前 25% 场景，
预测结局走向、boss 身份、关键反转并自报置信度（1–5）；预测命中项越多且置信越高，S4 得分越低
（全中且置信 5 → S4=1；方向错误或置信 ≤2 → S4≥4，由锚点裁量）。

## 2. 场景级维度（逐场景/抽样评分，1–5 分）

| # | 维度 | 评分口径与边界 |
| --- | --- | --- |
| C1 | NPC 声线一致性 | 只评语气、用词、性格是否符合 manifest 中的 NPC 档案，以及不同 NPC 是否有区分度。知识越权已由规则审批硬性保证，不重复评。 |
| C2 | 场景衔接连续性 | 与前序场景及结构化记忆无矛盾；无凭空引用的事件、地点或人物关系。 |
| C3 | 选项抉择质量 | 实际评的是 director 挑选的两个行动是否构成有意义的策略差异。writer 写的 label 会被规则文案替换后才展示、strategy 不进入持久化——玩家看到的选项文字不是 AI 写的；若基线发现选项无聊，改 prompt 无效，需改规则文案或放开 writer 文案（记为发现，不在本 spec 内修）。 |
| C4 | 文本质量 | 重复感/流水账、辞藻堆砌、与 sceneGoal 的相关度；含文风与世界观一致性。 |

抽样：C1 对全部含 NPC 台词的场景逐条评；C2–C4 每幕抽 2 个场景（seed 确定性抽样）。

## 3. 客观指标（确定性计算，零 AI 成本）

- 整局 fallback 率；各角色重试率与 invalid_json 率；审批驳回分类分布。
- tensionLevel 曲线（完整序列 + 标准差作为平坦度）；pacing 分布与顺序合法性。
- 每幕事实揭示密度；相邻场景 narration 字符 3-gram 重复率；narration/台词长度分布。
- 扩展提议数与采纳率；场景总数与是否收敛到结局（场景上限内）。

## 4. 人工抽查清单

评审报告自动列出：所有任一维度 ≤2 分的场景 + 每局 seed 随机 3 个场景，附检查要点
（声线、连续性、选项差异、证据引文），由人工复核评审模型的判断是否成立。
人工结论用于校准量表锚点与评审 prompt（量表变化则文档升版本）。
```

- [ ] **Step 2: 创建 agent 文档**

创建 `docs/agent/AI内容质量评估.md`：

```markdown
# AI 内容质量评估（实现事实）

> 对应 spec：docs/superpowers/specs/2026-07-31-ai-story-quality-evaluation-design.md
> 量表事实源：docs/策划文档/AI内容质量评估标准.md（v1）

## 采集通道（三采集点，各取其唯一可见的数据）

1. **source 工厂捕获回调**（`calls.jsonl` 主体）：`createLiveScenarioCandidateSource` 与
   `createLiveRuntimeNarrativeSources` 可选 `captureSink` 参数，在 transport 调用处一次拿齐
   角色/尝试序号/完整 prompt/模型原文/解析后候选/延迟。中间层
   `runtimeNarrativeSourceFactory.ts` 与 `scenarioCandidateSourceFactory.ts` 透传。
2. **编排层审批记录**（`calls.jsonl` 补充）：`OrchestrateNarrativeSceneInput.approvalObserver`
   可选字段，发出 role_approval / plan_approved / expansion_decision 三类事件（类型定义在
   `src/game/application/server/ai/storyEvalCapture.ts`）。透传链：compositionRoot →
   `RuntimeNarrativeTaskCoordinator`（deps 类型即 GeneratePendingNarrativeSceneDependencies）→
   `generatePendingNarrativeScene` → `orchestrateNarrativeScene`。
3. **驱动侧故事流水**（`story.jsonl`）：`src/game/application/testing/storyEvalJourney.test.ts`
   的 `runStoryEvalJourney` 组装；导演计划摘要按 sceneId 前缀 traceId 关联 calls.jsonl。

装配：`compositionRoot.ts` 的 `resolveStoryEvalAssembly(env)`——`STORY_EVAL_CAPTURE=1` 才创建
sink（缺省目录 `artifacts/story-eval/run-<ISO 时间戳>-<pid>`，`STORY_EVAL_ARTIFACT_DIR` 覆盖）；
未设置时全部 undefined，装配与行为与现状完全一致。

## 产物（artifacts/story-eval/<run-id>/，不入 git）

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| calls.jsonl | source 捕获 + 审批回调 | ai_call / role_approval / plan_approved / expansion_decision |
| story.jsonl | 旅程驱动 | 场景序号/主线阶段/narration/NPC 台词/最终选项文案/导演计划摘要/fallback/玩家选择/规则事件 |
| manifest.json | 旅程驱动 | gameId/世界 seed/策略 seed/gameLength/模型/开局蓝图快照 |
| metrics.json | analyze 脚本 | §3 全部客观指标 |
| scores.json + report.md | judge 脚本 | 结构化分数 + 证据 + 人工抽查清单 |

## 脚本与命令

- `npm run journey:story-eval`：replay 模式（零网络离线用例）
- `npm run smoke:ai:story-eval -- --runs 3 --seed <n>`：record 模式（需 `RUN_REAL_AI_STORY_EVAL=1`，逐局递增 seed）
- `npm run analyze:story-eval -- <runDir>`：客观指标 → metrics.json
- `npm run judge:story-eval -- <runDir>`：三段评审（需 `RUN_REAL_AI_STORY_EVAL_JUDGE=1`）→ scores.json + report.md

## 基线流程

先 1 局 long 试点跑通全管线并人工抽查复核评审可靠性 → 稳定后补 2 局（seed 递增）→
3 局汇总为基线 v1（`artifacts/story-eval/baseline-v1/report.md`，工作产物）；持久基线回填
`docs/策划文档/AI内容质量评估标准.md` 的分数表与客观指标摘要。基线是描述性快照，不是及格线。

## 环境变量（全部可选）

STORY_EVAL_CAPTURE（服务端装配开关，浏览器手玩采集需在启动 dev server 的 shell 中临时设置）、
STORY_EVAL_ARTIFACT_DIR（门禁脚本注入）、RUN_REAL_AI_STORY_EVAL、STORY_EVAL_SEED、
STORY_EVAL_MAX_SCENES（默认 60）、RUN_REAL_AI_STORY_EVAL_JUDGE、STORY_EVAL_JUDGE_MODEL。

## 已知发现（基线阶段只记录不修）

- writer 选项文案被规则文案替换后才展示：若 C3 基线分低，改 prompt 无效，需改规则文案或放开 writer 文案。
- 同模型评审自身产物存在自我偏袒风险：由人工抽查校准；偏袒明显时设 STORY_EVAL_JUDGE_MODEL 为独立模型。
```

- [ ] **Step 3: 更新文档索引与环境变量示例**

`docs/Agent文档索引.md`：追加两行（与既有条目格式一致）：

```markdown
- [AI内容质量评估](agent/AI内容质量评估.md) - 评估采集通道、产物、脚本命令与基线流程的实现事实
- [AI内容质量评估标准（策划）](../策划文档/AI内容质量评估标准.md) - 故事级/场景级量表 v1 与客观指标定义
```

`.env.example` 末尾追加（全部注释掉、不含默认值）：

```bash
# ---------------------------------------------------------------------------
# AI 故事质量评估（STORY_EVAL_*）——全部可选，未设置零影响。
# 两类设置惯例：
# - RUN_REAL_AI_*：只在 shell 中为单次脚本运行设置、不持久化（与 RUN_REAL_AI_JOURNEY 同惯例）；
# - STORY_EVAL_CAPTURE：服务端装配开关——评估旅程由门禁脚本自动传给子进程；浏览器手玩采集
#   需在启动 dev server 的 shell 中临时设置（同样不持久化，避免忘关后 prompt 原文长期落盘）。
# ---------------------------------------------------------------------------
# STORY_EVAL_CAPTURE=1
# STORY_EVAL_ARTIFACT_DIR=artifacts/story-eval/run-example
# RUN_REAL_AI_STORY_EVAL=1
# STORY_EVAL_SEED=20260731
# STORY_EVAL_MAX_SCENES=60
# RUN_REAL_AI_STORY_EVAL_JUDGE=1
# STORY_EVAL_JUDGE_MODEL=ai-model-name
```

- [ ] **Step 4: 验证**

Run: `node -e "const fs=require('node:fs');const text=fs.readFileSync('docs/策划文档/AI内容质量评估标准.md','utf8');if(!/^>\s*版本[:：]\s*(\S+)/m.test(text)){throw new Error('version header missing')}"`
Expected: 无输出（版本头匹配 judge 脚本正则）

Run: `npm run typecheck` 与 `npm test` —— Expected: 全绿

Run: `npm run lint` —— Expected: 无错误

Run: `npm run journey:story-eval` 与 `npm run journey:phase10` —— Expected: PASS（离线零网络回归）

- [ ] **Step 5: 提交**

```bash
git add docs/策划文档/AI内容质量评估标准.md docs/agent/AI内容质量评估.md docs/Agent文档索引.md .env.example
git commit -m "docs(ai-story-eval): add scale document, agent doc, index and env example"
```

---

### 收尾验证（跨任务）

- [ ] **Step 1: 全量验收**

Run:
```bash
npm run lint
npm run typecheck
npm test
npm run test:boundaries
npm run journey:story-eval
npm run journey:phase10
npm run journey:phase11
```
Expected: 全部通过；`STORY_EVAL_CAPTURE` 未设置时现有 journey 行为不变。

- [ ] **Step 2: 手工冒烟（可选，不消耗真实调用）**

Run: `npm run analyze:story-eval -- <离线 run 目录>`（从 `tmp/` 或测试产物复制一个 run 目录）→ 产出 metrics.json。

- [ ] **Step 3: 提交收尾（如有遗留改动）**

```bash
git status --short
git add -A
git commit -m "chore(ai-story-eval): finalize plan artifacts"   # 仅当存在未提交改动
```
