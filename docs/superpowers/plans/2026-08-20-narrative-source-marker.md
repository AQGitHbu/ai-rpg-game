# 剧情文本来源标记 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在统一的 application read-model 投影层为确定性 fallback 生成的玩家可见剧情文本增加 `【fallback】` 前缀，同时保持 API 生成文本不变。

**Architecture:** `NarrativeSceneState.source` 已经是当前场景文本的权威来源。新增纯展示 helper `decorateNarrativeText`，由 `projectGameSessionView` 在唯一投影出口统一处理旁白、NPC 台词和对白分页；文本不会被写回存档，也不会把玩家输入或无来源的旧存档实体描述误判为 fallback。焦点 NPC 页面沿用场景来源，非焦点/缺失台词的确定性闲聊明确按 fallback 处理。

**Tech Stack:** TypeScript, Vitest, application read model

## Global Constraints

- 不新增路由、provider、存档字段或第二套 session view。
- 仅对 `NarrativeSceneState` 及其派生的玩家可见场景文本加标记；玩家填写的 setup 文本、世界实体描述和静态 UI 文案不标记。
- `generated` 文本保持原文；`fallback` 文本只在展示投影时加一次 `【fallback】`，重复投影不能叠加标记。
- 保持旧存档兼容：缺失 `npcDialogues`/来源字段时继续按现有确定性投影行为工作。
- 新增 application 纯函数测试，并运行 `npm run test:game-application`、`npm run typecheck`、`npm run test:boundaries`。

---

### Task 1: 建立统一叙事文本装饰器

**Files:**
- Create: `src/game/application/narrativeText.ts`
- Test: `src/game/application/narrativeText.test.ts`

**Interfaces:**
- Produces `NarrativeTextSource = "generated" | "fallback"`。
- Produces `decorateNarrativeText(text: string, source: NarrativeTextSource): string`。
- Produces `decorateNarrativePages(pages: readonly string[], source: NarrativeTextSource): readonly string[]`。

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { decorateNarrativePages, decorateNarrativeText } from "./narrativeText";

describe("narrative text source decoration", () => {
  it("marks fallback text exactly once", () => {
    expect(decorateNarrativeText("确定性旁白。", "fallback")).toBe("【fallback】确定性旁白。");
    expect(decorateNarrativeText("【fallback】确定性旁白。", "fallback")).toBe("【fallback】确定性旁白。");
  });

  it("leaves generated and blank text unchanged", () => {
    expect(decorateNarrativeText("API 旁白。", "generated")).toBe("API 旁白。");
    expect(decorateNarrativeText("", "fallback")).toBe("");
    expect(decorateNarrativeText("   ", "fallback")).toBe("   ");
  });

  it("decorates every page through the same helper", () => {
    expect(decorateNarrativePages(["第一页。", "第二页。"], "fallback"))
      .toEqual(["【fallback】第一页。", "【fallback】第二页。"]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- src/game/application/narrativeText.test.ts`

Expected: FAIL because `narrativeText.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal helper**

```ts
export type NarrativeTextSource = "generated" | "fallback";
export const FALLBACK_NARRATIVE_MARKER = "【fallback】";

export function decorateNarrativeText(text: string, source: NarrativeTextSource): string {
  if (source !== "fallback" || text.trim() === "" || text.startsWith(FALLBACK_NARRATIVE_MARKER)) {
    return text;
  }
  return `${FALLBACK_NARRATIVE_MARKER}${text}`;
}

export function decorateNarrativePages(
  pages: readonly string[],
  source: NarrativeTextSource,
): readonly string[] {
  return pages.map((page) => decorateNarrativeText(page, source));
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- src/game/application/narrativeText.test.ts`

Expected: PASS.

### Task 2: 在 GameSessionView 的唯一投影出口应用标记

**Files:**
- Modify: `src/game/application/gameSessionView.ts`
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Consumes `NarrativeSceneState.source` and the helper from `./narrativeText`.
- Keeps the existing `GameSessionView` shape; only player-visible string values from `narrative` are decorated.

- [ ] **Step 1: Add regression tests for generated/fallback scenes**

Add tests covering the projection contract:

```ts
it("在 read model 统一标记 fallback 场景的旁白、NPC 台词和对白页", () => {
  const view = projectGameSessionView(ws, {
    ...ss,
    narrative: {
      ...ss.narrative,
      currentScene: {
        sceneId: "scene-fallback-marker",
        turn: 0,
        narration: "确定性旁白。",
        usedFactIds: [],
        npcLine: { npcId: npc1.id, text: "确定性回应。", emotion: "neutral", usedFactIds: [] },
        choices: [] as never,
        source: "fallback",
        event: { kind: "dialogue", focusNpcId: npc1.id },
        npcDialogues: [{ npcId: npc1.id, npcName: npc1.name, npcRole: npc1.role, speechPages: ["确定性回应。"] }],
      },
    },
  }, 0, "ending");

  expect(view.narrative.narration).toBe("【fallback】确定性旁白。");
  expect(view.narrative.npcLine?.text).toBe("【fallback】确定性回应。");
  expect(view.narrative.npcDialogues[0]?.speechPages).toEqual(["【fallback】确定性回应。"]);
});

it("不改变 generated 场景文本，并把非焦点确定性闲聊标为 fallback", () => {
  // 使用包含焦点 NPC 与第二名 NPC 的 generated scene；焦点台词保持原文，
  // 第二名 NPC 的确定性闲聊页带 fallback 标记。
});
```

- [ ] **Step 2: Run the application test and verify the new assertion fails**

Run: `npm test -- src/game/application/gameSessionView.test.ts`

Expected: the new source-marker assertions FAIL while the existing projection tests continue to describe current behavior.

- [ ] **Step 3: Apply the helper once in the projection path**

1. Import `decorateNarrativePages` and `decorateNarrativeText`.
2. Decorate `scene.narration` with `scene.source` in the returned `narrative.narration`.
3. Decorate the projected `npcLine.text` with `scene.source`.
4. For each `npcDialogues` entry, use `scene.source` only when that NPC is the current `scene.npcLine` speaker; otherwise use `fallback` for deterministic idle/fallback speech. Apply the source after legacy speech normalization and generic-greeting detection so the marker cannot interfere with existing cleanup.
5. When a missing/invalid supplied page falls back to `composeDeterministicNpcLine` or `composeIdleNpcLine`, decorate it with `fallback`.
6. Do not decorate `setup`, `currentLocation`, quest, inventory, ending, choice labels, or player-authored text because those values do not carry the current scene source contract.

- [ ] **Step 4: Run the application test and verify it passes**

Run: `npm test -- src/game/application/gameSessionView.test.ts`

Expected: PASS, including the existing NPC speech normalization and legacy-save tests updated only where they assert the newly visible marker.

### Task 3: Update implementation documentation and run acceptance checks

**Files:**
- Modify: `docs/agent/地图与地点冒险.md`
- Modify: `docs/Agent文档索引.md`

- [ ] **Step 1: Document the canonical projection rule**

Add an implementation note that `GameSessionView` decorates fallback scene narration/NPC speech with `【fallback】`, generated text stays unchanged, and the marker is presentation-only and not persisted.

- [ ] **Step 2: Run focused and minimum project checks**

Run:

```text
npm test -- src/game/application/narrativeText.test.ts src/game/application/gameSessionView.test.ts
npm run test:game-application
npm run typecheck
npm run test:boundaries
```

Expected: all commands PASS. If the full application suite exposes exact legacy-text assertions, update only those assertions to include the documented presentation marker; do not change runtime source semantics.

- [ ] **Step 3: Review the diff for scope**

Run: `git diff --check` and `git status --short`.

Expected: only the helper, application projection/tests, and the two implementation documentation files are changed; no route, persistence schema, provider, or shared package changes appear.
