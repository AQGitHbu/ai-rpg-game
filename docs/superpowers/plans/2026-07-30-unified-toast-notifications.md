# 统一信息提示框 (Unified Toast Notifications) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现游戏统一的黄色信息提示框（Toast Notification），支持5秒淡出消失以及多条提示框向上顶起的纵向堆叠效果。

**Architecture:** 创建 `ToastNotification` 组件与 Toast 队列状态/Context，通过 CSS `@keyframes` 处理 5 秒动画（前 4.5s 保持亮色，后 0.5s 淡出），并在 `AdventureGameShell` 及各操作反馈处统一接入。

**Tech Stack:** React 19, TypeScript, CSS Keyframes (Vanilla CSS), Vitest, React Testing Library.

## Global Constraints

- **Styling**: RPG 主题 CSS 均写入 `src/app/globals.css`，使用 Vanilla CSS。
- **Testing**: 组件测试放置在同目录 `.test.tsx` 文件，使用 `vitest` 与 `@testing-library/react`。
- **No deep imports**: 不使用未导出的包内部细节。

---

### Task 1: Toast Notification 组件与 CSS 动画实现

**Files:**
- Create: `src/components/ToastNotification.tsx`
- Modify: `src/app/globals.css:898-910`
- Create: `src/components/ToastNotification.test.tsx`

**Interfaces:**
- Consumes: React standard hooks (`useState`, `useEffect`, `useCallback`)
- Produces: `ToastContainer` component, `ToastItem` component, `useToastList` hook or `ToastProvider` / `ToastMessage` types:
  ```ts
  export type ToastMessage = {
    readonly id: string;
    readonly message: string;
    readonly createdAt: number;
  };
  ```

- [ ] **Step 1: Write the failing test for ToastNotification**

Create `src/components/ToastNotification.test.tsx`:
```tsx
import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToastContainer, type ToastMessage } from "./ToastNotification";

describe("ToastNotification", () => {
  it("正确渲染单条和多条 toast 提示框", () => {
    const toasts: ToastMessage[] = [
      { id: "1", message: "你来到了铁剑山庄。", createdAt: 1000 },
      { id: "2", message: "你获得了锈铁钥匙。", createdAt: 2000 }
    ];
    render(<ToastContainer toasts={toasts} onDismiss={vi.fn()} />);

    const statusElements = screen.getAllByRole("status");
    expect(statusElements).toHaveLength(2);
    expect(statusElements[0]).toHaveTextContent("你来到了铁剑山庄。");
    expect(statusElements[1]).toHaveTextContent("你获得了锈铁钥匙。");
  });

  it("当动画结束或超时 5.1s 时触发 onDismiss 回调", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const toasts: ToastMessage[] = [
      { id: "t1", message: "你来到了铁剑山庄。", createdAt: 1000 }
    ];
    render(<ToastContainer toasts={toasts} onDismiss={onDismiss} />);

    act(() => {
      vi.advanceTimersByTime(5100);
    });

    expect(onDismiss).toHaveBeenCalledWith("t1");
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ToastNotification.test.tsx`
Expected: FAIL with "Cannot find module ./ToastNotification"

- [ ] **Step 3: Implement ToastNotification and CSS Keyframes**

Create `src/components/ToastNotification.tsx`:
```tsx
"use client";

import { useEffect } from "react";

export type ToastMessage = {
  readonly id: string;
  readonly message: string;
  readonly createdAt: number;
};

type ToastItemProps = {
  readonly toast: ToastMessage;
  readonly onDismiss: (id: string) => void;
};

export function ToastItem({ toast, onDismiss }: ToastItemProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, 5100);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="game-toast-item adventure-toast"
      onAnimationEnd={() => onDismiss(toast.id)}
    >
      {toast.message}
    </div>
  );
}

type ToastContainerProps = {
  readonly toasts: readonly ToastMessage[];
  readonly onDismiss: (id: string) => void;
};

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="game-toast-container" aria-label="游戏提示框">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
```

Modify `src/app/globals.css` (replace legacy `.adventure-toast` rules around line 898-909 with updated container and keyframe styles):
```css
.game-toast-container {
  position: fixed;
  bottom: 32px;
  left: 50%;
  translate: -50% 0;
  z-index: 1000;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  align-items: center;
  pointer-events: none;
}

.game-toast-item {
  background: #ebd8a3;
  color: #1c1912;
  font-size: 0.875rem;
  font-weight: 500;
  padding: 10px 20px;
  border-radius: 12px;
  border: 1px solid #d4c088;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  text-align: center;
  max-width: 90vw;
  pointer-events: auto;
  animation: gameToastFadeInOut 5s ease-in-out forwards;
}

@keyframes gameToastFadeInOut {
  0% {
    opacity: 0;
    transform: translateY(12px);
  }
  6% {
    opacity: 1;
    transform: translateY(0);
  }
  90% {
    opacity: 1;
    transform: translateY(0);
  }
  100% {
    opacity: 0;
    transform: translateY(-8px);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ToastNotification.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit Task 1**

```bash
git add src/components/ToastNotification.tsx src/components/ToastNotification.test.tsx src/app/globals.css
git commit -m "feat: add ToastNotification component and CSS animation"
```

---

### Task 2: 在 AdventureGameShell 中集成 Toast 状态管理与渲染

**Files:**
- Modify: `src/components/AdventureGameShell.tsx:58,95-145,253-257`
- Modify: `src/components/AdventureGameShell.test.tsx:257-274`

**Interfaces:**
- Consumes: `ToastContainer`, `ToastMessage` from `ToastNotification.tsx`
- Produces: Integrated toast message state in `AdventureGameShell`

- [ ] **Step 1: Write/Update the test in AdventureGameShell.test.tsx**

Update `src/components/AdventureGameShell.test.tsx` to verify multiple toasts push upwards and render correctly:

```tsx
  it("成功行动用 ToastContainer 显示反馈，并支持多条推送", async () => {
    const movedView = buildMovedSessionViewFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ view: movedView, feedback: { ok: true, message: "你来到了城外官道。" } })
      )
    );
    const user = userEvent.setup();
    renderShell({ onViewChange: vi.fn() });

    await user.click(screen.getByRole("button", { name: "前往城外官道" }));

    const toasts = await screen.findAllByRole("status");
    expect(toasts.some(t => t.textContent === "你来到了城外官道。")).toBe(true);
  });
```

- [ ] **Step 2: Run test to check initial state**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx`
Expected: Passes or requires update depending on exact toast structure.

- [ ] **Step 3: Modify AdventureGameShell.tsx to integrate ToastContainer**

In `src/components/AdventureGameShell.tsx`:
1. Import `ToastContainer` and `ToastMessage` from `./ToastNotification`.
2. Add `toasts` state:
```tsx
  const [toasts, setToasts] = useState<readonly ToastMessage[]>([]);

  const addToast = useCallback((message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    setToasts((prev) => [...prev, { id, message, createdAt: Date.now() }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
```
3. In `handleMove` and `handleSceneAction`: when `outcome.kind === "success"`, call `addToast(outcome.message)` in addition to `setFeedback({ phase: "success", message: outcome.message })`.
4. Replace lines 253-257 (`{feedback.phase === "success" ? ... : null}`) with:
```tsx
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/AdventureGameShell.test.tsx`
Expected: PASS

- [ ] **Step 5: Run full test suite to ensure no regressions**

Run: `npm run test`
Expected: PASS (all tests pass)

- [ ] **Step 6: Commit Task 2**

```bash
git add src/components/AdventureGameShell.tsx src/components/AdventureGameShell.test.tsx
git commit -m "feat: integrate ToastContainer in AdventureGameShell"
```
