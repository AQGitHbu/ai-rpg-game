# NPC 对话界面重构（视觉小说式覆盖层）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 NPC 对话从居中模态重构为视觉小说式场景内覆盖层（立绘占位居左、底部全宽对话框+名字横幅+点击翻页、右侧竖排选项面板、右上角好感度档位徽标），完整保留现有对话规则与提交链路。

**Architecture:** 新增 `NpcDialogueOverlay.tsx` 组件取代 `LocationSceneScreen.tsx` 内的 `NpcDialogueModal`；等待快照编排（reducer 定义、phase、refs）随组件迁移定义但仍在 `LocationSceneScreen` 中驱动。唯一的数据面改动是 `GameSessionView.currentLocation.npcs[]` 新增 `relationshipTier` 只读投影。提交链路（`/api/game/actions`）与规则层零改动。

**Tech Stack:** Next.js 16 + React 19 + TypeScript 5.8（strict）、vitest + @testing-library/react、手写 CSS（`src/app/globals.css` 单文件，CSS 变量见 `:1-13`）。

**Spec:** `docs/superpowers/specs/2026-08-27-npc-dialogue-ui-vn-overlay-design.md`

## Global Constraints

- 分支放 `.worktrees/`，不用 `git checkout` 切分支（`AGENTS.md` 核心约束）。
- 焦点 NPC ready 场景恰好两个固定选择 + 一个自定义输入；固定选择只消费服务端 opaque `choiceToken`，UI 不生成、不解析、不回退业务 action key。
- 每次提交产生独立浏览器 UUID，统一经 `POST /api/game/actions` 与 `performTurn`；不新增 route、API 或并行入口。
- 等待态从提交前快照渲染（含页码冻结），入口全部锁定；ready 写回后不加"继续"按钮。
- handoff 收尾与非焦点闲聊的本地关闭不创建 action、不推进回合；新出现 NPC 不自动打开。
- 好感度只展示五档文案（敌视/冷淡/中立/友善/信任），永不显示 -100~100 原始数值。
- 组件只从 `@/game/application` 导入游戏类型，禁止 deep-import `@/game/domain`、`@/game/gameplay/**`。
- 新模块必须有同目录测试；最低验收 `npm run test:boundaries`、`npm run typecheck`、`npm run test:components`、`npm run test:game-application`，合入前全量 `npm test`。
- 测试钩子稳定化（减少壳层测试迁移成本）：保留 `role="dialog"`、`aria-label="与{name}对话"`、`aria-label="关闭对话"`、`aria-label="对话选项"`、`aria-label="自定义回应"`、`data-testid="npc-dialogue-spinner"`、选项按钮 `data-testid="npc-dialogue-choice"`。

---

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/components/NpcDialogueOverlay.tsx` | 新建 | 覆盖层渲染：立绘占位、对话框、名字横幅、翻页、选项面板、徽标；导出迁移来的等待快照类型与 `reduceDialogueUiState` |
| `src/components/NpcDialogueOverlay.test.tsx` | 新建 | 覆盖层契约测试（展示/翻页/提交/等待快照/各状态） |
| `src/components/LocationSceneScreen.tsx` | 修改 | 删除 `NpcDialogueModal`（:245-464）与本地类型（:31-74），改为渲染覆盖层；对话期间隐藏侧栏与行动栏 |
| `src/game/application/gameSessionView.ts` | 修改 | `currentLocation.npcs[]` 增加 `relationshipTier` 投影（:107-112 类型、:834-847 投影） |
| `src/game/application/index.ts` | 修改 | facade re-export `RelationshipTier` 类型 |
| `src/game/application/gameSessionView.test.ts` | 修改 | 新增 `relationshipTier` 投影用例 |
| `src/app/globals.css` | 修改 | 新增 `npc-dialogue-overlay-*` 区块；删除旧对话样式与死样式 |
| `src/components/AdventureGameShell.test.tsx` | 修改 | 按新 DOM 适配失败查询（保留语义钩子后预计少量改动） |
| `docs/agent/NPC对话驱动叙事场景触发.md` | 修改 | 主要文件节补充覆盖层组件与投影字段 |

## Task 0: 分支与基线

**Files:**
- 无代码变更；确认 `docs/superpowers/specs/2026-08-27-npc-dialogue-ui-vn-overlay-design.md` 已提交

- [ ] **Step 1: 确认工作区状态并补提交 spec（如未提交）**

```bash
git status --porcelain
# 若 spec 文件显示未跟踪/未提交：
git add "docs/superpowers/specs/2026-08-27-npc-dialogue-ui-vn-overlay-design.md"
git commit -m "docs(specs): NPC 对话界面重构设计（视觉小说式覆盖层布局）"
```

- [ ] **Step 2: 创建 worktree 分支**

```bash
git worktree add .worktrees/npc-dialogue-overlay-ui -b npc-dialogue-overlay-ui main
cd .worktrees/npc-dialogue-overlay-ui
```

若 worktree 内缺少 `.foundation` junction，先执行 `npm run bootstrap:foundation`（仅链接，不复制）。

- [ ] **Step 3: 基线门禁**

```bash
npm ci && npm run typecheck && npm run test:components
```

Expected: 全部通过（基线绿）。失败则停止并报告，不进入后续任务。

---

## Task 1: relationshipTier 只读投影

**Files:**
- Modify: `src/game/application/gameSessionView.ts:107-112`（类型）、`:834-847`（投影）
- Modify: `src/game/application/index.ts`
- Test: `src/game/application/gameSessionView.test.ts`

**Interfaces:**
- Consumes: `relationshipTierOf(value: RelationshipValue): RelationshipTier`（`@/game/domain/relationship`，纯函数；档位判定 `<=-60` hostile、`<=-20` cold、`<20` neutral、`<60` friendly、其余 trusted）
- Produces: `GameSessionView["currentLocation"]["npcs"][number]["relationshipTier"]: RelationshipTier`；facade 导出 `RelationshipTier` 类型。后续 Task 2 的徽标与 Task 5 的匹配逻辑消费此字段。

- [ ] **Step 1: 写失败测试**

在 `src/game/application/gameSessionView.test.ts` 末尾追加（该文件现有 `ws` fixture 的 `npcs[0].memory.relationship.affinity` 为 `0`）：

```ts
describe("relationshipTier projection", () => {
  function viewWithAffinity(affinity: number) {
    return projectGameSessionView(
      {
        ...ws,
        npcs: ws.npcs.map((entry) => ({
          ...entry,
          memory: { ...entry.memory, relationship: { affinity } },
        })),
      },
      runtime,
    );
  }

  it("projects the five tiers from affinity boundaries", () => {
    expect(viewWithAffinity(-100).currentLocation.npcs[0]?.relationshipTier).toBe("hostile");
    expect(viewWithAffinity(-60).currentLocation.npcs[0]?.relationshipTier).toBe("hostile");
    expect(viewWithAffinity(-59).currentLocation.npcs[0]?.relationshipTier).toBe("cold");
    expect(viewWithAffinity(-20).currentLocation.npcs[0]?.relationshipTier).toBe("cold");
    expect(viewWithAffinity(-19).currentLocation.npcs[0]?.relationshipTier).toBe("neutral");
    expect(viewWithAffinity(0).currentLocation.npcs[0]?.relationshipTier).toBe("neutral");
    expect(viewWithAffinity(19).currentLocation.npcs[0]?.relationshipTier).toBe("neutral");
    expect(viewWithAffinity(20).currentLocation.npcs[0]?.relationshipTier).toBe("friendly");
    expect(viewWithAffinity(59).currentLocation.npcs[0]?.relationshipTier).toBe("friendly");
    expect(viewWithAffinity(60).currentLocation.npcs[0]?.relationshipTier).toBe("trusted");
  });
});
```

注意：`projectGameSessionView` 的实参与现有用例一致——若现有用例签名不同（如 `(worldState, storyRuntime)` 或单一 record），照抄同文件既有用例的调用方式，只替换 `affinity`。

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/game/application/gameSessionView.test.ts -t "relationshipTier"
```

Expected: FAIL（`relationshipTier` 为 `undefined` / 类型错误）。

- [ ] **Step 3: 实现投影**

`gameSessionView.ts` 顶部 imports 追加：

```ts
import { relationshipTierOf, type RelationshipTier } from "@/game/domain/relationship";
```

`currentLocation.npcs` 类型（约 :107）增加字段：

```ts
    readonly npcs: readonly {
      readonly npcId: string;
      readonly name: string;
      readonly role: string;
      readonly talkChoice: PlayerChoiceView | null;
      /** 好感档位投影：只给档位不给数值（关系绝不裸给数字）。 */
      readonly relationshipTier: RelationshipTier;
    }[];
```

投影处（约 :834）`presentNpcs.map` 返回对象追加：

```ts
        relationshipTier: relationshipTierOf(npc.memory.relationship),
```

- [ ] **Step 4: facade 导出**

`src/game/application/index.ts` 追加（与既有 `export type { AiFailureKind } ...` 同区）：

```ts
export type { RelationshipTier } from "@/game/domain/relationship";
```

- [ ] **Step 5: 运行测试与门禁**

```bash
npx vitest run src/game/application/gameSessionView.test.ts
npm run test:boundaries && npm run typecheck
```

Expected: 全部 PASS（新增字段是纯追加；`gameSessionView.test.ts:1217` 断言的是 `currentLocation` 顶层键，不受嵌套字段影响）。

- [ ] **Step 6: Commit**

```bash
git add src/game/application/gameSessionView.ts src/game/application/gameSessionView.test.ts src/game/application/index.ts
git commit -m "feat(application): 投影 NPC 好感档位 relationshipTier 到会话视图"
```

---

## Task 2: NpcDialogueOverlay 骨架（对话框、横幅、关闭、徽标、立绘占位）

**Files:**
- Create: `src/components/NpcDialogueOverlay.tsx`
- Create: `src/components/NpcDialogueOverlay.test.tsx`
- Modify: `src/app/globals.css`（新增覆盖层样式区块）

**Interfaces:**
- Consumes: `NpcDialogueView`（经 `@/game/application`）、`PlayerInteraction`（`./gameActionRequest`）、`normalizeDisplayText`（`./displayText`）、`RelationshipTier`
- Produces（后续任务依赖）：
  - `export type DialoguePhase = "choice" | "waiting"`
  - `export type DialogueUiState` / `export type DialogueUiAction` / `export function reduceDialogueUiState(state, action)`（从 `LocationSceneScreen.tsx:31-74` 原样迁移，行为不变）
  - `export function NpcDialogueOverlay(props: NpcDialogueOverlayProps)`
  - Props：`dialogue`（`NpcDialogueView`）、`busy: boolean`、`phase: DialoguePhase`、`pendingPlayerResponse: string | null`、`pendingChoiceToken: string | null`、`resetInputNonce: number`、`handoffAcknowledgement: { label: string } | null`、`relationshipTier: RelationshipTier | null`、`onSubmit: (interaction: PlayerInteraction, playerResponse: string) => void`、`onAcknowledge?: () => void`、`onClose: () => void`

- [ ] **Step 1: 迁移等待快照类型与 reducer**

新建 `NpcDialogueOverlay.tsx`，把 `LocationSceneScreen.tsx:24`（`Dialogue` 别名）、`:31-54`（`DialogueUiState`、`DialogueUiAction`、`DialoguePhase`、`SubmittedDialogue`）、`:56-74`（`reduceDialogueUiState`）原样复制过来并加 `export`。`SubmittedDialogue` 不导出（仅 LocationSceneScreen 内部需要时也从这里 import）。本任务不改任何逻辑。

- [ ] **Step 2: 写骨架失败测试**

`NpcDialogueOverlay.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NpcDialogueOverlay } from "./NpcDialogueOverlay";
import type { NpcDialogueView } from "@/game/application";

export function makeDialogue(overrides?: Partial<NpcDialogueView>): NpcDialogueView {
  return {
    npcId: "npc_1",
    name: "薇拉",
    role: "酒馆老板的女儿",
    speechPages: ["那天夜里井边传来很奇怪的声音。", "我去看了一眼，但什么都没看清。"],
    choices: [
      { choiceToken: "token_a", label: "后来那口井里到底出了什么事？", presentation: "dialogue" },
      { choiceToken: "token_b", label: "我想帮你查清楚。", presentation: "dialogue" },
    ],
    freeInputEnabled: true,
    giveChoices: [],
    ...overrides,
  };
}

function renderOverlay(overrides?: Partial<React.ComponentProps<typeof NpcDialogueOverlay>>) {
  const props = {
    dialogue: makeDialogue(),
    busy: false,
    phase: "choice" as const,
    pendingPlayerResponse: null,
    pendingChoiceToken: null,
    resetInputNonce: 0,
    handoffAcknowledgement: null,
    relationshipTier: "friendly" as const,
    onSubmit: vi.fn(),
    onAcknowledge: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<NpcDialogueOverlay {...props} />), props };
}

describe("NpcDialogueOverlay 骨架", () => {
  it("渲染名字横幅、当前页台词、关闭按钮与占位头像首字", () => {
    renderOverlay();
    expect(screen.getByRole("dialog", { name: "与薇拉对话" })).toBeTruthy();
    expect(screen.getByText("薇拉")).toBeTruthy();
    expect(screen.getByText("那天夜里井边传来很奇怪的声音。")).toBeTruthy();
    expect(screen.getByLabelText("关闭对话")).toBeTruthy();
    expect(screen.getByText("薇", { selector: ".npc-dialogue-overlay-avatar" })).toBeTruthy();
  });

  it("右上角徽标显示档位文案，不显示数值", () => {
    renderOverlay();
    const badge = screen.getByText(/薇拉 · 友善/);
    expect(badge).toBeTruthy();
    expect(badge.textContent).not.toMatch(/\d/);
  });

  it("relationshipTier 为 null 时隐藏徽标", () => {
    renderOverlay({ relationshipTier: null });
    expect(screen.queryByText(/· 友善/)).toBeNull();
  });

  it("点击关闭调用 onClose", async () => {
    const user = userEvent.setup();
    const { props } = renderOverlay();
    await user.click(screen.getByLabelText("关闭对话"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: 运行确认失败**

```bash
npx vitest run src/components/NpcDialogueOverlay.test.tsx
```

Expected: FAIL（组件不存在）。

- [ ] **Step 4: 实现骨架组件**

`NpcDialogueOverlay.tsx` 在迁移的导出之下追加：

```tsx
"use client";

import { useState, useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import type { NpcDialogueView, RelationshipTier } from "@/game/application";
import type { PlayerInteraction } from "./gameActionRequest";
import { normalizeDisplayText } from "./displayText";

// 此处为 Step 1 迁移的 Dialogue/DialogueUiState/DialogueUiAction/DialoguePhase/SubmittedDialogue/reduceDialogueUiState（均 export，SubmittedDialogue 除外）

const RELATIONSHIP_TIER_LABEL: Record<RelationshipTier, string> = {
  hostile: "敌视",
  cold: "冷淡",
  neutral: "中立",
  friendly: "友善",
  trusted: "信任",
};

export type NpcDialogueOverlayProps = {
  readonly dialogue: NpcDialogueView;
  readonly busy: boolean;
  readonly phase: DialoguePhase;
  readonly pendingPlayerResponse: string | null;
  readonly pendingChoiceToken: string | null;
  readonly resetInputNonce: number;
  readonly handoffAcknowledgement: NpcDialogueView["handoffAcknowledgement"] | null;
  readonly relationshipTier: RelationshipTier | null;
  readonly onSubmit: (interaction: PlayerInteraction, playerResponse: string) => void;
  readonly onAcknowledge?: () => void;
  readonly onClose: () => void;
};

export function NpcDialogueOverlay({
  dialogue,
  busy,
  phase,
  pendingPlayerResponse,
  pendingChoiceToken,
  resetInputNonce,
  handoffAcknowledgement,
  relationshipTier,
  onSubmit,
  onAcknowledge,
  onClose,
}: NpcDialogueOverlayProps) {
  const [text, setText] = useState("");
  const previousResetInputNonce = useRef(resetInputNonce);

  useEffect(() => {
    if (previousResetInputNonce.current === resetInputNonce) return;
    previousResetInputNonce.current = resetInputNonce;
    setText("");
  }, [resetInputNonce]);

  const locked = busy || phase === "waiting";

  return (
    <div
      className="npc-dialogue-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`与${dialogue.name}对话`}
      aria-busy={phase === "waiting"}
    >
      {relationshipTier !== null ? (
        <div className="npc-dialogue-overlay-affinity" aria-label="好感度">
          ♥ {dialogue.name} · {RELATIONSHIP_TIER_LABEL[relationshipTier]}
        </div>
      ) : null}

      <div className="npc-dialogue-overlay-figure" aria-hidden="true">
        <div className="npc-dialogue-overlay-avatar">{dialogue.name.charAt(0)}</div>
      </div>

      {/* 选项面板：Task 4 实现 */}

      <section className="npc-dialogue-overlay-box">
        <span className="npc-dialogue-overlay-name">{dialogue.name}</span>
        <button
          type="button"
          className="npc-dialogue-overlay-close"
          aria-label="关闭对话"
          onClick={onClose}
          disabled={locked}
        >
          ×
        </button>
        <p className="npc-dialogue-overlay-speech">
          {dialogue.speechPages.length > 0 ? normalizeDisplayText(dialogue.speechPages[0]) : "还没有开始对话。"}
        </p>
      </section>
    </div>
  );
}
```

注意：`"use client"` 放文件首行（迁移的类型在前、指令在首行即可，TS 类型声明不受影响）；若迁移后首行不是 `"use client"`，把它提到第一行。

- [ ] **Step 5: 新增样式区块**

`globals.css` 末尾追加（变量取自 `:1-13`；布局按 spec §2.1）：

```css
/* ==========================================================================
   NPC 对话覆盖层（视觉小说式布局）
   ========================================================================== */

/* 透明全屏根：可见但拦截 HUD/场景交互，等效旧遮罩的锁定行为 */
.npc-dialogue-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  animation: modal-fade-in 0.2s ease-out;
}

.npc-dialogue-overlay-affinity {
  position: absolute;
  top: 12px;
  right: 14px;
  padding: 4px 12px;
  border-radius: 12px;
  border: 1px solid var(--game-surface-border);
  background: rgb(0 0 0 / 62%);
  color: var(--game-accent);
  font-size: 0.82rem;
  z-index: 3;
}

.npc-dialogue-overlay-figure {
  position: absolute;
  left: 5%;
  bottom: 27%;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.npc-dialogue-overlay-avatar {
  width: clamp(120px, 14vw, 190px);
  height: clamp(160px, 19vw, 255px);
  display: grid;
  place-items: center;
  border: 2px solid var(--game-accent);
  border-radius: 14px 14px 0 0;
  background: var(--game-accent-soft);
  color: var(--game-accent);
  font-size: clamp(2.4rem, 5vw, 3.6rem);
  font-weight: 700;
  text-shadow: 0 2px 10px rgb(0 0 0 / 60%);
}

.npc-dialogue-overlay-box {
  position: absolute;
  left: 9%;
  right: 9%;
  bottom: 4%;
  min-height: 132px;
  padding: 26px 22px 18px;
  border: 2px solid var(--game-accent);
  border-radius: 12px;
  background: rgb(14 20 16 / 94%);
  box-shadow: var(--game-shadow-modal);
  cursor: pointer;
  z-index: 2;
}

.npc-dialogue-overlay-name {
  position: absolute;
  top: -13px;
  left: 20px;
  padding: 2px 14px;
  border: 1px solid var(--game-accent);
  border-radius: 6px;
  background: var(--game-surface-bg);
  color: var(--game-accent);
  font-size: 0.86rem;
  font-weight: 700;
}

.npc-dialogue-overlay-close {
  position: absolute;
  top: 8px;
  right: 10px;
  width: 28px;
  height: 28px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--game-surface-border);
  border-radius: 50%;
  background: var(--game-surface-raised);
  color: var(--game-text-muted);
  font-size: 1.05rem;
  line-height: 1;
  cursor: pointer;
}

.npc-dialogue-overlay-close:hover:not(:disabled) {
  color: var(--game-text-primary);
  border-color: var(--game-accent);
}

.npc-dialogue-overlay-speech {
  margin: 0;
  line-height: 1.8;
  color: var(--game-text-primary);
}
```

- [ ] **Step 6: 运行测试与类型检查**

```bash
npx vitest run src/components/NpcDialogueOverlay.test.tsx
npm run typecheck
```

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/components/NpcDialogueOverlay.tsx src/components/NpcDialogueOverlay.test.tsx src/app/globals.css
git commit -m "feat(components): NPC 对话覆盖层骨架（对话框/名字横幅/徽标/立绘占位）"
```

---

## Task 3: 翻页状态机

**Files:**
- Modify: `src/components/NpcDialogueOverlay.tsx`
- Test: `src/components/NpcDialogueOverlay.test.tsx`

**Interfaces:**
- Consumes: Task 2 骨架
- Produces: 组件内部 `pageIndex` 行为契约——末页才显示选项面板（Task 4 依赖 `isLastPage`）；内容键 = `npcId + "\u0001" + speechPages.join("\u0001")`

- [ ] **Step 1: 写失败测试**

追加到 `NpcDialogueOverlay.test.tsx`：

```tsx
import { fireEvent } from "@testing-library/react";

describe("NpcDialogueOverlay 翻页", () => {
  it("首页隐藏选项面板并显示翻页箭头", () => {
    renderOverlay();
    expect(screen.queryByLabelText("对话选项")).toBeNull();
    expect(screen.getByText("▶")).toBeTruthy();
  });

  it("点击对话框翻到末页后显示选项面板、隐藏箭头", async () => {
    const user = userEvent.setup();
    renderOverlay();
    await user.click(screen.getByText("那天夜里井边传来很奇怪的声音。"));
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
    expect(screen.queryByText("▶")).toBeNull();
    expect(screen.getByLabelText("对话选项")).toBeTruthy();
  });

  it("键盘 Enter 翻页；输入框内的 Enter 不翻页", () => {
    renderOverlay();
    const box = screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box")!;
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
  });

  it("台词内容变化时页码重置回首页", () => {
    const { rerender, props } = renderOverlay();
    const box = screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box")!;
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
    rerender(
      <NpcDialogueOverlay
        {...props}
        dialogue={makeDialogue({ speechPages: ["全新的第一页。", "全新的第二页。"] })}
      />,
    );
    expect(screen.getByText("全新的第一页。")).toBeTruthy();
    expect(screen.queryByText("全新的第二页。")).toBeNull();
  });

  it("内容相同的新数组引用不重置页码", () => {
    const { rerender, props } = renderOverlay();
    const box = screen.getByRole("dialog", { name: "与薇拉对话" }).querySelector(".npc-dialogue-overlay-box")!;
    fireEvent.keyDown(box, { key: "Enter" });
    rerender(<NpcDialogueOverlay {...props} dialogue={makeDialogue()} />);
    expect(screen.getByText("我去看了一眼，但什么都没看清。")).toBeTruthy();
  });

  it("busy 或等待态时点击不翻页", () => {
    renderOverlay({ phase: "waiting", pendingPlayerResponse: "我想帮你。", pendingChoiceToken: "token_b" });
    fireEvent.click(screen.getByText("那天夜里井边传来很奇怪的声音。"));
    expect(screen.queryByText("我去看了一眼，但什么都没看清。")).toBeNull();
  });

  it("单页台词直接显示选项面板，无翻页箭头", () => {
    renderOverlay({ dialogue: makeDialogue({ speechPages: ["只有一句。"] }) });
    expect(screen.queryByText("▶")).toBeNull();
    expect(screen.getByLabelText("对话选项")).toBeTruthy();
  });

  it("speechPages 为空时显示空态文案", () => {
    renderOverlay({ dialogue: makeDialogue({ speechPages: [] }) });
    expect(screen.getByText("还没有开始对话。")).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/components/NpcDialogueOverlay.test.tsx
```

Expected: 新用例 FAIL（无翻页逻辑、无 `对话选项` 区域——`对话选项` 断言依赖 Task 4 的面板；本任务先让翻页与空态相关断言通过，`对话选项` 出现时机在 Task 4 落地。若测试框架要求全绿，可先把"末页显示选项面板"的三条断言移到 Task 4；其余必须在本任务转绿）。

- [ ] **Step 3: 实现翻页**

组件内加入（`locked` 定义之后、return 之前）：

```tsx
  const pages = dialogue.speechPages;
  const lastIndex = Math.max(0, pages.length - 1);
  const [pageIndex, setPageIndex] = useState(0);
  const clampedIndex = Math.min(pageIndex, lastIndex);
  const isLastPage = clampedIndex >= lastIndex;

  // 内容键变化（新回应写回/切换 NPC）才重置；引用变化不重置。
  const contentKey = `${dialogue.npcId}\u0001${pages.join("\u0001")}`;
  const previousContentKey = useRef(contentKey);
  useEffect(() => {
    if (previousContentKey.current === contentKey) return;
    previousContentKey.current = contentKey;
    setPageIndex(0);
  }, [contentKey]);

  function advancePage(): void {
    if (locked) return;
    if (isLastPage) return;
    setPageIndex(clampedIndex + 1);
  }

  function handleBoxKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    // 自由输入框持有焦点时保留其输入/提交语义，不触发翻页。
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, button, form") !== null) return;
    event.preventDefault();
    advancePage();
  }
```

`<section className="npc-dialogue-overlay-box">` 改为：

```tsx
      <section
        className="npc-dialogue-overlay-box"
        onClick={advancePage}
        onKeyDown={handleBoxKeyDown}
        tabIndex={0}
      >
```

台词段改为渲染当前页：

```tsx
        <p className="npc-dialogue-overlay-speech">
          {pages.length > 0 ? normalizeDisplayText(pages[clampedIndex]) : "还没有开始对话。"}
        </p>
        {!isLastPage && pages.length > 0 ? (
          <span className="npc-dialogue-overlay-next" aria-hidden="true">▶</span>
        ) : null}
```

样式追加：

```css
.npc-dialogue-overlay-next {
  position: absolute;
  right: 12px;
  bottom: 8px;
  color: var(--game-accent);
  animation: npc-dialogue-next-bob 1.1s ease-in-out infinite;
}

@keyframes npc-dialogue-next-bob {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(3px); }
}

@media (prefers-reduced-motion: reduce) {
  .npc-dialogue-overlay-next { animation: none; }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/components/NpcDialogueOverlay.test.tsx
```

Expected: 翻页相关用例全部 PASS（`对话选项` 用例若已写，允许仍失败，由 Task 4 转绿）。

- [ ] **Step 5: Commit**

```bash
git add src/components/NpcDialogueOverlay.tsx src/components/NpcDialogueOverlay.test.tsx src/app/globals.css
git commit -m "feat(components): 对话覆盖层点击/键盘翻页与内容键重置"
```

---

## Task 4: 选项面板与各对话状态

**Files:**
- Modify: `src/components/NpcDialogueOverlay.tsx`
- Modify: `src/app/globals.css`
- Test: `src/components/NpcDialogueOverlay.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `isLastPage`、`locked`
- Produces: 焦点选项（恰好两个固定选择）、赠物、自由输入、startChoice、handoff、闲聊"知道了"、等待快照渲染——全部经 `onSubmit`/`onAcknowledge`/`onClose` 回调，不新增提交路径

- [ ] **Step 1: 写失败测试**

```tsx
describe("NpcDialogueOverlay 选项面板", () => {
  async function turnToLastPage() {
    const user = userEvent.setup();
    await user.click(screen.getByText("那天夜里井边传来很奇怪的声音。"));
    return user;
  }

  it("末页渲染两个固定选项，点击经 onSubmit 提交对应 token", async () => {
    const { props } = renderOverlay();
    const user = await turnToLastPage();
    const options = screen.getAllByTestId("npc-dialogue-choice");
    expect(options.map((el) => el.textContent)).toEqual([
      "后来那口井里到底出了什么事？",
      "我想帮你查清楚。",
    ]);
    await user.click(options[1]);
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: "token_b" },
      "我想帮你查清楚。",
    );
  });

  it("赠物选项并入面板并走 fixed_choice 提交", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({
        giveChoices: [
          { itemName: "药草", choice: { choiceToken: "token_give", label: "赠出：药草", presentation: "item" } },
        ],
      }),
    });
    const user = await turnToLastPage();
    await user.click(screen.getByTestId("npc-dialogue-give-token_give"));
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: "token_give" },
      "赠出：药草",
    );
  });

  it("自由输入以 free_text + targetNpcId 提交；空白不提交；等待态禁用", async () => {
    const { props } = renderOverlay();
    const user = await turnToLastPage();
    const input = screen.getByLabelText("自定义回应");
    await user.type(input, "我还有别的问题。");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "free_text", text: "我还有别的问题。", targetNpcId: "npc_1" },
      "我还有别的问题。",
    );
    expect((input as HTMLInputElement).value).toBe("我还有别的问题。"); // 草稿保留，由父级经 resetInputNonce 清空
  });

  it("等待态：快照选项全部禁用、已选项标记与 spinner、玩家回应临时展示", () => {
    renderOverlay({
      phase: "waiting",
      busy: true,
      pendingPlayerResponse: "我想帮你查清楚。",
      pendingChoiceToken: "token_b",
    });
    const options = screen.getAllByTestId("npc-dialogue-choice");
    expect(options.every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(options[1].getAttribute("aria-current")).toBe("true");
    expect(screen.getAllByTestId("npc-dialogue-spinner").length).toBeGreaterThan(0);
    expect(screen.getByText(/我想帮你查清楚。/)).toBeTruthy();
  });

  it("等待态锁定关闭按钮与自由输入", () => {
    renderOverlay({ phase: "waiting", busy: true, pendingPlayerResponse: "x", pendingChoiceToken: "token_a" });
    expect((screen.getByLabelText("关闭对话") as HTMLButtonElement).disabled).toBe(true);
  });

  it("startChoice 空态只显示单一开始交谈入口", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({
        speechPages: [],
        choices: [],
        freeInputEnabled: false,
        startChoice: { choiceToken: "token_ask", label: "与薇拉交谈", presentation: "dialogue" },
      }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "与薇拉交谈" }));
    expect(props.onSubmit).toHaveBeenCalledWith(
      { kind: "fixed_choice", choiceToken: "token_ask" },
      "与薇拉交谈",
    );
    expect(screen.queryByLabelText("自定义回应")).toBeNull();
  });

  it("handoff 收尾只显示单一交接确认，点击走 onAcknowledge", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({ speechPages: ["旧 NPC 的最后一句。"], choices: [], freeInputEnabled: false }),
      handoffAcknowledgement: { label: "与下一位 NPC 交谈" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "与下一位 NPC 交谈" }));
    expect(props.onAcknowledge).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it("非焦点闲聊只有\"知道了\"，点击走 onClose", async () => {
    const { props } = renderOverlay({
      dialogue: makeDialogue({ speechPages: ["最近来问井的事的人不少。"], choices: [], freeInputEnabled: false }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "知道了" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run src/components/NpcDialogueOverlay.test.tsx
```

Expected: 新用例 FAIL（选项面板未实现）。

- [ ] **Step 3: 实现选项面板**

组件内（`advancePage` 之后）移植原模态的判定与提交逻辑：

```tsx
  // 焦点 NPC 的正式对话严格由两个批准选项或自由输入标识；
  // 非焦点 NPC 的单个 talk choice 是唯一的正式交谈入口。
  const hasFocusInteraction = dialogue.freeInputEnabled || dialogue.choices.length === 2;

  const waitingChoices = [
    ...dialogue.choices,
    ...dialogue.giveChoices.map((entry) => entry.choice),
    ...(dialogue.startChoice === undefined ? [] : [dialogue.startChoice]),
  ];

  async function submitFreeText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = text.trim();
    if (normalized === "") return;
    onSubmit({ kind: "free_text", text: normalized, targetNpcId: dialogue.npcId }, normalized);
  }
```

在立绘占位之后、对话框之前渲染面板（等待态也渲染禁用版面板，翻页已冻结在提交时的末页）：

```tsx
      {phase === "waiting" ? (
        <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
          {waitingChoices.map((choice) => (
            <button
              key={choice.choiceToken}
              type="button"
              data-testid="npc-dialogue-choice"
              disabled={true}
              aria-current={choice.choiceToken === pendingChoiceToken ? "true" : undefined}
              className={choice.choiceToken === pendingChoiceToken ? "npc-dialogue-overlay-choice--selected" : undefined}
            >
              <span aria-hidden="true">&gt; </span>{choice.label}
              {choice.choiceToken === pendingChoiceToken ? (
                <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" />
              ) : null}
            </button>
          ))}
          <p className="npc-dialogue-overlay-status" role="status" aria-live="polite">正在等待{dialogue.name}回应……</p>
        </div>
      ) : isLastPage ? (
        dialogue.startChoice !== undefined ? (
          <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
            <button
              type="button"
              className="npc-dialogue-overlay-cta"
              disabled={busy}
              onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: dialogue.startChoice!.choiceToken }, dialogue.startChoice!.label)}
            >
              <span aria-hidden="true">&gt; </span>{dialogue.startChoice.label}
            </button>
          </div>
        ) : hasFocusInteraction ? (
          <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
            {dialogue.choices.map((choice) => (
              <button
                key={choice.choiceToken}
                type="button"
                data-testid="npc-dialogue-choice"
                disabled={busy}
                onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken }, choice.label)}
              >
                <span aria-hidden="true">&gt; </span>{choice.label}
              </button>
            ))}
            {dialogue.giveChoices.length > 0 ? (
              <>
                <span className="npc-dialogue-overlay-panel-divider">给予道具</span>
                {dialogue.giveChoices.map((entry) => (
                  <button
                    key={entry.choice.choiceToken}
                    type="button"
                    data-testid={`npc-dialogue-give-${entry.choice.choiceToken}`}
                    disabled={busy}
                    onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: entry.choice.choiceToken }, entry.choice.label)}
                  >
                    <span aria-hidden="true">&gt; </span>{entry.choice.label}
                  </button>
                ))}
              </>
            ) : null}
            {dialogue.freeInputEnabled ? (
              <form className="npc-dialogue-overlay-input" onSubmit={(event) => void submitFreeText(event)}>
                <input
                  aria-label="自定义回应"
                  value={text}
                  disabled={busy}
                  placeholder="或直接说……"
                  onChange={(event) => setText(event.target.value)}
                  maxLength={240}
                />
                <button type="submit" disabled={busy || text.trim() === ""}>发送</button>
              </form>
            ) : null}
          </div>
        ) : (
          /* 非焦点 NPC：零回合展示；剧情交接只保留一个真实下一步，普通闲聊才用"知道了"关闭 */
          <div className="npc-dialogue-overlay-panel" role="group" aria-label="对话选项">
            {dialogue.choices.length > 0 ? (
              dialogue.choices.map((choice) => (
                <button
                  key={choice.choiceToken}
                  type="button"
                  className="npc-dialogue-overlay-cta"
                  disabled={busy}
                  onClick={() => onSubmit({ kind: "fixed_choice", choiceToken: choice.choiceToken }, choice.label)}
                >
                  <span aria-hidden="true">&gt; </span>{choice.label}
                </button>
              ))
            ) : handoffAcknowledgement !== null && handoffAcknowledgement !== undefined ? (
              <button type="button" className="npc-dialogue-overlay-cta" onClick={onAcknowledge ?? onClose}>
                {normalizeDisplayText(handoffAcknowledgement.label)}
              </button>
            ) : (
              <button type="button" className="npc-dialogue-overlay-dismiss" disabled={busy} onClick={onClose}>
                知道了
              </button>
            )}
          </div>
        )
      ) : null}
```

对话框台词后追加玩家临时回应（等待态；自由输入提交时 `pendingChoiceToken` 为 null）：

```tsx
        {pendingPlayerResponse !== null && pendingChoiceToken === null ? (
          <p className="npc-dialogue-overlay-speech npc-dialogue-overlay-speech--player">
            {normalizeDisplayText(pendingPlayerResponse)}
            {phase === "waiting" ? (
              <span data-testid="npc-dialogue-spinner" className="npc-dialogue-inline-spinner" aria-hidden="true" />
            ) : null}
          </p>
        ) : null}
```

- [ ] **Step 4: 面板样式追加**

```css
.npc-dialogue-overlay-panel {
  position: absolute;
  right: 4%;
  bottom: 32%;
  width: min(340px, 30vw);
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--game-surface-border);
  border-radius: 10px;
  background: rgb(10 16 12 / 92%);
  z-index: 3;
}

.npc-dialogue-overlay-panel button {
  padding: 8px 12px;
  border: 1px solid var(--game-surface-border);
  border-radius: 8px;
  background: var(--game-surface-raised);
  color: var(--game-text-primary);
  text-align: left;
  cursor: pointer;
}

.npc-dialogue-overlay-panel button:hover:not(:disabled) {
  border-color: var(--game-accent);
}

.npc-dialogue-overlay-panel button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.npc-dialogue-overlay-choice--selected {
  opacity: 1 !important;
  border-color: var(--game-accent) !important;
  cursor: wait;
}

.npc-dialogue-overlay-panel-divider {
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px dashed var(--game-surface-border);
  color: var(--game-accent);
  font-size: 0.75rem;
  letter-spacing: 0.14em;
}

.npc-dialogue-overlay-input {
  display: flex;
  gap: 8px;
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--game-surface-border);
}

.npc-dialogue-overlay-input input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--game-surface-border);
  border-radius: 6px;
  background: var(--game-surface-raised);
  color: inherit;
}

.npc-dialogue-overlay-input button {
  padding: 8px 14px;
}

.npc-dialogue-overlay-cta {
  border-color: var(--game-accent) !important;
  color: var(--game-accent);
  font-weight: 600;
}

.npc-dialogue-overlay-dismiss {
  justify-self: end;
}

.npc-dialogue-overlay-status {
  margin: 0;
  color: var(--game-text-muted);
  font-style: italic;
  font-size: 0.85rem;
}

.npc-dialogue-overlay-speech--player {
  margin-top: 10px;
  color: var(--game-success);
}
```

- [ ] **Step 5: 运行测试与门禁**

```bash
npx vitest run src/components/NpcDialogueOverlay.test.tsx
npm run typecheck
```

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/components/NpcDialogueOverlay.tsx src/components/NpcDialogueOverlay.test.tsx src/app/globals.css
git commit -m "feat(components): 对话覆盖层选项面板、自由输入与等待快照渲染"
```

---

## Task 5: 接入 LocationSceneScreen（删旧模态、隐藏面板、徽标匹配）

**Files:**
- Modify: `src/components/LocationSceneScreen.tsx`
- Test: `src/components/LocationSceneScreen.test.tsx`（回归不改写）、`src/components/AdventureGameShell.test.tsx`（失败适配，见 Task 6）

**Interfaces:**
- Consumes: Task 1 `relationshipTier`、Task 2-4 `NpcDialogueOverlay` 与其导出
- Produces: 场景视图最终行为——对话期间侧栏/行动栏隐藏、HUD 可见但被覆盖层拦截

- [ ] **Step 1: 删除旧模态与本地类型，改为导入**

`LocationSceneScreen.tsx`：

1. 删除 `:24` 的 `type Dialogue = ...`、`:31-54` 类型块、`:56-74` 的 `reduceDialogueUiState`，改为：

```tsx
import {
  NpcDialogueOverlay,
  reduceDialogueUiState,
  type Dialogue,
  type DialoguePhase,
  type DialogueUiState,
  type SubmittedDialogue,
} from "./NpcDialogueOverlay";
```

（`SubmittedDialogue` 若 Task 2 未导出，则在 `NpcDialogueOverlay.tsx` 补 `export`。）

2. 整体删除 `NpcDialogueModal` 函数（约 :245-464）。

- [ ] **Step 2: 渲染覆盖层并隐藏面板**

徽标匹配（`displayedDialogue` 定义之后）：

```tsx
  const displayedRelationshipTier = displayedDialogue === undefined
    ? null
    : view.currentLocation.npcs.find((npc) => npc.npcId === displayedDialogue.npcId)?.relationshipTier ?? null;
```

侧栏渲染（约 :812）加条件——对话打开时隐藏：

```tsx
      {displayedDialogue === undefined && sidebarNpcs.length > 0 ? (
        <aside className="scene-npc-sidebar" aria-label="场景人物">
```

底部行动栏（约 :889）同样加条件：

```tsx
        {displayedDialogue === undefined && boundaryPreparationAction !== undefined ? (
          <nav className="scene-action-rail--bottom" aria-label="行动栏">
```

模态渲染点（约 :903-921）替换为：

```tsx
      {/* NPC 对话覆盖层：只有用户主动点击才弹出 */}
      {displayedDialogue ? (
        <NpcDialogueOverlay
          dialogue={displayedDialogue}
          busy={busy || pending}
          handoffAcknowledgement={displayedDialogue.choices.length === 0 && !displayedDialogue.freeInputEnabled
            ? displayedDialogue.handoffAcknowledgement ?? null
            : null}
          pendingPlayerResponse={dialogueUi.pendingPlayerResponse}
          pendingChoiceToken={dialogueUi.pendingChoiceToken}
          resetInputNonce={dialogueInputResetNonce}
          relationshipTier={displayedRelationshipTier}
          onSubmit={submitDialogueInteraction}
          onAcknowledge={resetDialogue}
          phase={dialoguePhase}
          onClose={() => {
            resetDialogue();
          }}
        />
      ) : null}
```

其余编排逻辑（`submitDialogueInteractionFor`、revision 同步 effect、busy 恢复 effect、`handleNpcCardClick`、测试环境自动打开 `initialOpenDialogueNpcId`）一律不动。

- [ ] **Step 3: 运行组件测试**

```bash
npm run test:components
```

Expected: `NpcDialogueOverlay.test.tsx` 与 `LocationSceneScreen.test.tsx` PASS；`AdventureGameShell.test.tsx` 可能出现 DOM 查询失败，全部记录到 Task 6 处理，不在本任务临时绕过。

- [ ] **Step 4: Commit**

```bash
git add src/components/LocationSceneScreen.tsx src/components/NpcDialogueOverlay.tsx
git commit -m "refactor(components): 场景视图接入 NPC 对话覆盖层并移除旧模态"
```

---

## Task 6: 壳层测试适配与旧样式清理

**Files:**
- Modify: `src/components/AdventureGameShell.test.tsx`
- Modify: `src/app/globals.css`

**Interfaces:**
- Consumes: Task 5 的最终 DOM
- Produces: `npm run test:components` 全绿；无残留死样式

- [ ] **Step 1: 适配失败的壳层测试**

```bash
npm run test:components
```

对每个失败用例：优先用保留的语义钩子重写查询（`role="dialog"`、`aria-label="对话选项"`、`data-testid="npc-dialogue-choice"`、`data-testid="npc-dialogue-spinner"`、按钮文本）。不要为迁就旧断言改产品代码；若失败暴露真实行为回归（如等待态入口未锁定），回到覆盖层修复并补覆盖层单测。

注意翻页引入的行为差异：壳层用例若直接点击选项，需先翻到末页（两页台词是常态；`isTest` 自动打开仍有效）。可在壳层测试辅助函数中加一步"点击对话框翻到末页"，或把测试 fixture 的台词保持单页（单页直接出选项）。逐例判断，保持原断言语义。

- [ ] **Step 2: 运行组件测试直至全绿**

```bash
npm run test:components
```

Expected: PASS。

- [ ] **Step 3: 清理旧对话样式**

先确认无引用（在 `src/` 内搜索，逐一确认后才删）：

```bash
grep -rn "npc-dialogue-panel\|npc-dialogue-backdrop\|npc-dialogue-stage\|npc-dialogue-figure\|npc-dialogue-portrait\|npc-dialogue-speech\|npc-dialogue-choices\|npc-dialogue-input\|npc-dialogue-give\|npc-dialogue-talk-cta\|npc-dialogue-dismiss-btn\|npc-dialogue-status\|npc-dialogue-close\|npc-dialogue-choice--selected" src/ --include="*.tsx" --include="*.ts"
```

Expected: 零命中（测试与产品代码均已切换到 `npc-dialogue-overlay-*`）。随后从 `globals.css` 删除：

- `:1247-1484` 区块内所有 `.npc-dialogue-*` 规则（`.npc-dialogue-panel`、`.npc-dialogue-close`、`.npc-dialogue-stage`、`.npc-dialogue-figure`、`.npc-dialogue-portrait`、`.npc-dialogue-talk-cta`、`.npc-dialogue-speech`、`.npc-dialogue-phase-label`、`.npc-dialogue-status`、`.npc-dialogue-next-step`、`.npc-dialogue-continue`、`.npc-dialogue-pager`、`.npc-dialogue-pager-status`、`.npc-dialogue-reply`、`.npc-dialogue-choices`、`.npc-dialogue-input`）——保留该区块内不相关的 `@media (max-width: 700px)` HUD 规则
- `:2872-2894` `.npc-dialogue-backdrop` 两条规则（保留 `@keyframes modal-fade-in`，覆盖层复用它）
- `:3100-3128` `.npc-dialogue-give*` 规则
- `:3450-3463` `.npc-dialogue-choice--selected` 两条规则
- **保留** `.npc-dialogue-inline-spinner` 与 `@keyframes npc-dialogue-spin`（`:3429-3448`，覆盖层复用）

删除后复查：

```bash
grep -n "npc-dialogue-" src/app/globals.css | grep -v "npc-dialogue-overlay\|npc-dialogue-inline-spinner\|npc-dialogue-spin"
```

Expected: 无输出。

- [ ] **Step 4: 门禁**

```bash
npm run typecheck && npm run test:components
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/AdventureGameShell.test.tsx src/app/globals.css
git commit -m "test(components): 壳层对话用例适配覆盖层布局并清理旧样式"
```

---

## Task 7: 文档更新与全量验收

**Files:**
- Modify: `docs/agent/NPC对话驱动叙事场景触发.md`

- [ ] **Step 1: 更新实现事实文档**

`docs/agent/NPC对话驱动叙事场景触发.md`「主要文件」节追加一条：

```markdown
- `src/components/NpcDialogueOverlay.tsx` — 视觉小说式对话覆盖层（立绘占位、底部对话框点击翻页、右侧选项面板、好感档位徽标）与等待快照编排类型。
```

「玩家可见规则」或「修改注意事项」不新增规则条目（本次无玩法事实变化）；「主要验收」节补一句：

```markdown
- `NpcDialogueOverlay.test.tsx`：覆盖层展示/翻页/提交/等待快照契约。
```

检查 `docs/Agent文档索引.md`：该文档已被索引则无需改动；未索引才补一行。

- [ ] **Step 2: 全量门禁**

```bash
npm run test:boundaries && npm run typecheck && npm run test:components && npm run test:game-application
npm test
```

Expected: 全部 PASS。失败则定位修复后重跑；不带 `--no-verify` 类绕过。

- [ ] **Step 3: Commit**

```bash
git add "docs/agent/NPC对话驱动叙事场景触发.md"
git commit -m "docs(agent): 记录 NPC 对话覆盖层组件与测试入口"
```

- [ ] **Step 4: 浏览器手动验收**

```bash
npm run dev
```

真实走一遍：进入地点 → 点击侧栏 NPC → 覆盖层打开（侧栏/行动栏隐藏、HUD 可见不可点）→ 逐页翻阅台词 → 末页出现两个选项与输入框 → 提交后等待快照（已选项+spinner、入口锁定）→ 新台词直接出现 → 右上角徽标显示档位 → 点非焦点 NPC 出闲聊"知道了" → ✕ 关闭后面板恢复。核对 `docs/策划文档/` 无玩法文案需要调整（本次无玩法变化）。

- [ ] **Step 5: 收尾**

按仓库流程从主工作区执行 `npm run branch:merge -- npc-dialogue-overlay-ui`（fast-forward 合并 + worktree 安全清理）；不使用 `git worktree remove`。

---

## Self-Review 记录

- Spec §1.1 五范围内条目 → Task 1（投影）、Task 2-4（布局渲染）、Task 5（面板取舍）、Task 6（样式）全覆盖。
- Spec §2.3 状态矩阵六状态 → Task 4 测试逐一对应（翻页中/末页/等待/startChoice/handoff/闲聊）；失败态由现有模态承担、覆盖层不介入（Task 5 不改失败路径）。
- Spec §4.1 内容键与输入框排除 → Task 3；§4.3 快照含页码冻结 → Task 3（等待态锁定翻页）+ Task 4（等待面板）；§4.4 关闭/交接 → Task 4；§4.5 无切换入口 → Task 5 不新增。
- Spec §5 徽标取值与隐藏 → Task 1 + Task 5；§6 可访问性 → Task 2/3（role/aria/键盘）；§7 测试策略 → Task 1/2-4/6；§8 不变量 → Global Constraints + Task 4/5 不移植提交逻辑。
- 类型一致性：`DialoguePhase`、`DialogueUiState`、`reduceDialogueUiState`、`NpcDialogueOverlayProps` 在 Task 2 定义，Task 5 消费，名称一致；`relationshipTier` 字段名贯穿 Task 1/5。
- 已知执行风险：Task 6 壳层适配工作量取决于语义钩子命中率；若适配改动超过 30 个断言，先停下来评估是否遗漏稳定钩子，而不是继续堆改动。
