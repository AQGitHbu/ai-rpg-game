# 统一游戏信息提示框 (Toast Notification System) 设计文档

## 1. 概述与目标

在 RPG 游戏中，当玩家进行移动（如“你来到了铁剑山庄。”）、物品拾取、观察、对话或战斗行动时，需要向玩家展示清晰、统一的黄色提示框。

### 核心需求
1. **统一视觉样式**：暖黄色底、暗色高对比度文字、圆角框体（匹配截图风格），置于屏幕底部居中。
2. **5秒渐变消失**：提示框在显示约 5 秒后自动淡出消失（前 4.5 秒常亮，最后 0.5 秒渐变透明）。
3. **多条提示堆叠**：支持多条提示同时存在。当产生新提示时，旧提示被向上顶起；每条提示独立计算 5 秒寿命。
4. **统一应用集成**：替换现有单条 `adventure-toast` 与分散在各 Panel 的局部文本，提供全局/层级式的 Toast 消息发送机制。

---

## 2. 架构与组件设计

### 2.1 组件结构 (`src/components/ToastNotification.tsx`)

实现两个核心组件：
- `ToastContainer`：固定定位在屏幕底部居中（`position: fixed; bottom: 32px; left: 50%; translate: -50% 0`），使用 Flex Column 从下至上排列 toast 项。
- `ToastItem`：代表单条提示框。接收 `id`、`message` 和 `onDismiss(id)` 回调。监听 `onAnimationEnd`，并在组件挂载时设置 5.1s 兜底定时器。

### 2.2 Toast 状态与 Hooks / Context (`src/components/ToastContext.tsx` 或 React Hook)

- `ToastProvider` & `useToast()` Hook：
  - 提供 `addToast(message: string)` 方法。
  - 维护内部状态 `toasts: Array<{ id: string; message: string; createdAt: number }>`。
  - 导出 `ToastProvider` 供 `AdventureGameShell` 或 `CurrentGameScreen` 包裹，子组件（如各种 Panel）均可通过 `useToast()` 触发提示框。

---

## 3. CSS 样式设计 (`src/app/globals.css`)

### 样式规格
- `.game-toast-container`:
  - `position: fixed; bottom: 32px; left: 50%; translate: -50% 0; z-index: 1000;`
  - `display: flex; flex-direction: column-reverse; gap: 8px; align-items: center; pointer-events: none;`
  - (使用 `flex-direction: column-reverse` 可使最新插入列表首位的 item 显示在最下方，从而把旧 item 自动向上顶起)。
- `.game-toast-item`:
  - `background: #ebd8a3; color: #1c1912; font-size: 0.875rem; font-weight: 500;`
  - `padding: 10px 20px; border-radius: 12px; border: 1px solid #d4c088;`
  - `box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); text-align: center; max-width: 90vw; pointer-events: auto;`
  - `animation: gameToastFadeInOut 5s ease-in-out forwards;`

### Keyframes 动画 (`@keyframes gameToastFadeInOut`)
```css
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

---

## 4. 业务整合与测试 plan

### 4.1 UI 接入点
1. `AdventureGameShell.tsx`：当 `handleMove`、`handleSceneAction` 等操作返回 success 时，自动触发 `addToast(outcome.message)`。
2. 替换旧的单条 `.adventure-toast` CSS 与 HTML 渲染逻辑。

### 4.2 自动化测试
- 编写 `ToastNotification.test.tsx` 验证：
  - 单条/多条 Toast 渲染。
  - 自动 dismiss 触发。
  - 多条 Toast 的 DOM 顺序与容器样式。
- 更新 `AdventureGameShell.test.tsx` 验证行动成功后渲染 Toast 组件。
